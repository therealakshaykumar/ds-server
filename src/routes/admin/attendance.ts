import { and, desc, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { attendance, classes, classSessions, enrolments, students } from '../../db/schema';
import { audit } from '../../lib/audit';
import { ah, HttpError, paging, parse } from '../../lib/http';
import type { Ctx } from '../../lib/notify';
import { dateStr } from '../../lib/schemas';

export function attendanceRouter({ db }: Ctx): Router {
  const r = Router();

  r.get(
    '/',
    ah(async (req, res) => {
      const q = parse(
        z.object({
          sessionId: z.coerce.number().int().positive().optional(),
          studentId: z.coerce.number().int().positive().optional(),
          from: dateStr.optional(),
          to: dateStr.optional(),
        }),
        req.query,
      );
      const { limit, offset } = paging(req.query, 100);
      const rows = await db
        .select({
          id: attendance.id,
          sessionId: attendance.sessionId,
          sessionDate: classSessions.sessionDate,
          className: classes.name,
          studentId: students.id,
          studentName: students.name,
          status: attendance.status,
          source: attendance.source,
          markedAt: attendance.markedAt,
          distanceM: attendance.distanceM,
        })
        .from(attendance)
        .innerJoin(classSessions, eq(classSessions.id, attendance.sessionId))
        .innerJoin(classes, eq(classes.id, classSessions.classId))
        .innerJoin(students, eq(students.id, attendance.studentId))
        .where(
          and(
            q.sessionId ? eq(attendance.sessionId, q.sessionId) : undefined,
            q.studentId ? eq(attendance.studentId, q.studentId) : undefined,
            q.from ? gte(classSessions.sessionDate, q.from) : undefined,
            q.to ? lte(classSessions.sessionDate, q.to) : undefined,
          ),
        )
        .orderBy(desc(classSessions.sessionDate), desc(attendance.markedAt))
        .limit(limit)
        .offset(offset);
      res.json({ attendance: rows });
    }),
  );

  /** Admin override: mark or correct a student's attendance for a session. */
  r.put(
    '/',
    ah(async (req, res) => {
      const body = parse(
        z.object({
          sessionId: z.number().int().positive(),
          studentId: z.number().int().positive(),
          status: z.enum(['present', 'absent']),
        }),
        req.body,
      );
      const [session] = await db.select().from(classSessions).where(eq(classSessions.id, body.sessionId));
      if (!session) throw new HttpError(404, 'Session not found', 'NOT_FOUND');
      const [enrolled] = await db
        .select({ id: enrolments.id })
        .from(enrolments)
        .where(
          and(
            eq(enrolments.studentId, body.studentId),
            eq(enrolments.classId, session.classId),
            lte(enrolments.startDate, session.sessionDate),
            or(isNull(enrolments.endDate), gte(enrolments.endDate, session.sessionDate)),
          ),
        );
      if (!enrolled) throw new HttpError(409, 'Student is not enrolled in this class on that date', 'NOT_ENROLLED');

      const [before] = await db
        .select()
        .from(attendance)
        .where(and(eq(attendance.sessionId, body.sessionId), eq(attendance.studentId, body.studentId)));
      const [saved] = await db
        .insert(attendance)
        .values({ ...body, source: 'admin', markedBy: req.user!.id })
        .onConflictDoUpdate({
          target: [attendance.sessionId, attendance.studentId],
          set: { status: body.status, source: 'admin', markedBy: req.user!.id, markedAt: new Date() },
        })
        .returning();
      await audit(db, req, 'attendance', saved.id, before ? 'override' : 'create', before ?? null, saved);
      res.json({ attendance: saved });
    }),
  );

  return r;
}
