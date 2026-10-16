import { and, asc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { attendance, classes, classSessions, enrolments, students } from '../../db/schema';
import { audit } from '../../lib/audit';
import { ah, idParam, notFound, parse } from '../../lib/http';
import { type Ctx, notifyUsers } from '../../lib/notify';
import { dateStr } from '../../lib/schemas';

export function sessionsRouter(ctx: Ctx): Router {
  const { db } = ctx;
  const r = Router();

  r.get(
    '/',
    ah(async (req, res) => {
      const q = parse(
        z.object({ from: dateStr.optional(), to: dateStr.optional(), classId: z.coerce.number().int().positive().optional() }),
        req.query,
      );
      const rows = await db
        .select({
          id: classSessions.id,
          classId: classes.id,
          className: classes.name,
          instructorName: classes.instructorName,
          sessionDate: classSessions.sessionDate,
          startTime: classes.startTime,
          endTime: classes.endTime,
          status: classSessions.status,
          cancelReason: classSessions.cancelReason,
          present: sql<number>`(select count(*)::int from ${attendance} where ${attendance.sessionId} = ${classSessions.id} and ${attendance.status} = 'present')`,
        })
        .from(classSessions)
        .innerJoin(classes, eq(classes.id, classSessions.classId))
        .where(
          and(
            q.from ? gte(classSessions.sessionDate, q.from) : undefined,
            q.to ? lte(classSessions.sessionDate, q.to) : undefined,
            q.classId ? eq(classSessions.classId, q.classId) : undefined,
          ),
        )
        .orderBy(asc(classSessions.sessionDate), asc(classes.startTime));
      res.json({ sessions: rows });
    }),
  );

  /** Attendance sheet: every student enrolled for that date, with their mark if any. */
  r.get(
    '/:id/sheet',
    ah(async (req, res) => {
      const id = idParam(req);
      const [session] = await db
        .select({ id: classSessions.id, classId: classSessions.classId, sessionDate: classSessions.sessionDate, status: classSessions.status })
        .from(classSessions)
        .where(eq(classSessions.id, id));
      if (!session) notFound('Session');
      const rows = await db
        .select({
          studentId: students.id,
          name: students.name,
          status: attendance.status,
          source: attendance.source,
          markedAt: attendance.markedAt,
          distanceM: attendance.distanceM,
        })
        .from(enrolments)
        .innerJoin(students, eq(students.id, enrolments.studentId))
        .leftJoin(attendance, and(eq(attendance.sessionId, id), eq(attendance.studentId, students.id)))
        .where(
          and(
            eq(enrolments.classId, session.classId),
            lte(enrolments.startDate, session.sessionDate),
            or(isNull(enrolments.endDate), gte(enrolments.endDate, session.sessionDate)),
          ),
        )
        .orderBy(asc(students.name));
      res.json({ session, students: rows });
    }),
  );

  r.post(
    '/:id/cancel',
    ah(async (req, res) => {
      const id = idParam(req);
      const { reason } = parse(z.object({ reason: z.string().trim().optional() }), req.body);
      const [session] = await db.select().from(classSessions).where(eq(classSessions.id, id));
      if (!session) notFound('Session');
      const [updated] = await db
        .update(classSessions)
        .set({ status: 'cancelled', cancelReason: reason ?? null })
        .where(eq(classSessions.id, id))
        .returning();
      await audit(db, req, 'class_session', id, 'cancel', session, updated);

      const [cls] = await db.select().from(classes).where(eq(classes.id, session.classId));
      const parents = await db
        .selectDistinct({ userId: students.parentUserId })
        .from(enrolments)
        .innerJoin(students, eq(students.id, enrolments.studentId))
        .where(
          and(
            eq(enrolments.classId, session.classId),
            lte(enrolments.startDate, session.sessionDate),
            or(isNull(enrolments.endDate), gte(enrolments.endDate, session.sessionDate)),
          ),
        );
      await notifyUsers(
        ctx,
        parents.map((p) => p.userId),
        'Class cancelled',
        `${cls.name} on ${session.sessionDate} has been cancelled.${reason ? ` Reason: ${reason}` : ''}`,
      );
      res.json({ session: updated });
    }),
  );

  r.post(
    '/:id/restore',
    ah(async (req, res) => {
      const id = idParam(req);
      const [session] = await db.select().from(classSessions).where(eq(classSessions.id, id));
      if (!session) notFound('Session');
      const [updated] = await db
        .update(classSessions)
        .set({ status: 'scheduled', cancelReason: null })
        .where(eq(classSessions.id, id))
        .returning();
      await audit(db, req, 'class_session', id, 'restore', session, updated);
      res.json({ session: updated });
    }),
  );

  return r;
}
