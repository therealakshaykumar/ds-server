import { and, eq, gte, isNull, lte, or } from 'drizzle-orm';
import type { Db } from '../db/types';
import { attendance, classes, classSessions, enrolments, locations, students } from '../db/schema';
import { toMinutes, zonedNow } from '../lib/dates';
import { haversineMeters } from '../lib/geo';
import { HttpError } from '../lib/http';
import type { Settings } from '../lib/settings';

export interface MarkInput {
  userId: number;
  studentId: number;
  sessionId: number;
  latitude: number;
  longitude: number;
  accuracyM: number;
}

export type MarkWindow = 'too_early' | 'open' | 'closed';

/** Where "now" sits relative to a session's attendance window. */
export function windowState(
  session: { sessionDate: string },
  cls: { startTime: string; endTime: string },
  s: Settings,
  now = new Date(),
): MarkWindow {
  const local = zonedNow(s.timezone, now);
  if (local.date < session.sessionDate) return 'too_early';
  if (local.date > session.sessionDate) return 'closed';
  const opens = toMinutes(cls.startTime) - s.attendanceOpenBeforeMin;
  const closes = toMinutes(cls.endTime) + s.attendanceCloseAfterMin;
  if (local.minutes < opens) return 'too_early';
  if (local.minutes > closes) return 'closed';
  return 'open';
}

/** Self-marked attendance: enforces ownership, enrolment, time window, GPS accuracy and geofence. */
export async function markSelfAttendance(db: Db, s: Settings, input: MarkInput, now = new Date()) {
  const [student] = await db
    .select()
    .from(students)
    .where(and(eq(students.id, input.studentId), eq(students.parentUserId, input.userId)));
  if (!student) throw new HttpError(404, 'Student not found', 'NOT_FOUND');
  if (student.status !== 'active') throw new HttpError(409, 'Student is not active', 'STUDENT_INACTIVE');

  const [row] = await db
    .select({ session: classSessions, cls: classes, location: locations })
    .from(classSessions)
    .innerJoin(classes, eq(classes.id, classSessions.classId))
    .leftJoin(locations, eq(locations.id, classes.locationId))
    .where(eq(classSessions.id, input.sessionId));
  if (!row) throw new HttpError(404, 'Class session not found', 'NOT_FOUND');
  const { session, cls, location } = row;
  if (session.status === 'cancelled') throw new HttpError(409, 'This class was cancelled', 'SESSION_CANCELLED');

  const [enrolled] = await db
    .select({ id: enrolments.id })
    .from(enrolments)
    .where(
      and(
        eq(enrolments.studentId, student.id),
        eq(enrolments.classId, cls.id),
        lte(enrolments.startDate, session.sessionDate),
        or(isNull(enrolments.endDate), gte(enrolments.endDate, session.sessionDate)),
      ),
    );
  if (!enrolled) throw new HttpError(403, 'Student is not enrolled in this class', 'NOT_ENROLLED');

  const state = windowState(session, cls, s, now);
  if (state === 'too_early') {
    throw new HttpError(422, `Attendance opens ${s.attendanceOpenBeforeMin} minutes before the class starts`, 'TOO_EARLY');
  }
  if (state === 'closed') throw new HttpError(422, 'Attendance for this class is closed', 'WINDOW_CLOSED');

  let distance: number | null = null;
  if (location) {
    if (input.accuracyM > s.maxGpsAccuracyM) {
      throw new HttpError(
        422,
        `Location accuracy is too low (${Math.round(input.accuracyM)} m). Move to an open area and try again.`,
        'LOW_ACCURACY',
      );
    }
    distance = haversineMeters(input.latitude, input.longitude, location.latitude, location.longitude);
    if (distance > location.radiusM) {
      throw new HttpError(
        422,
        `You are ${Math.round(distance)} m from ${location.name}. Attendance can only be marked within ${location.radiusM} m.`,
        'OUTSIDE_GEOFENCE',
        { distanceM: Math.round(distance), radiusM: location.radiusM },
      );
    }
  }

  const [created] = await db
    .insert(attendance)
    .values({
      sessionId: session.id,
      studentId: student.id,
      status: 'present',
      source: 'self',
      markedAt: now,
      markedBy: input.userId,
      latitude: input.latitude,
      longitude: input.longitude,
      accuracyM: input.accuracyM,
      distanceM: distance,
    })
    .onConflictDoNothing()
    .returning();
  if (!created) throw new HttpError(409, 'Attendance already marked for this class', 'ALREADY_MARKED');
  return created;
}
