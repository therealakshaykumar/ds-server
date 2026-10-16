import { and, asc, eq, gte, notExists, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { attendance, classes, classSessions, enrolments, locations, students } from '../../db/schema';
import { audit } from '../../lib/audit';
import { zonedNow } from '../../lib/dates';
import { ah, idParam, notFound, parse } from '../../lib/http';
import type { Ctx } from '../../lib/notify';
import { timeStr } from '../../lib/schemas';
import { getSettings } from '../../lib/settings';
import { generateSessions } from '../../services/sessions';

const classBody = z.object({
  name: z.string().trim().min(1),
  instructorName: z.string().trim().nullable().optional(),
  weekday: z.number().int().min(0).max(6),
  startTime: timeStr,
  endTime: timeStr,
  locationId: z.number().int().positive().nullable().optional(),
  capacity: z.number().int().positive().nullable().optional(),
  isActive: z.boolean().optional(),
});

export function classesRouter({ db }: Ctx): Router {
  const r = Router();

  r.get(
    '/',
    ah(async (req, res) => {
      const { includeInactive } = parse(z.object({ includeInactive: z.enum(['true', 'false']).optional() }), req.query);
      const rows = await db
        .select({
          id: classes.id,
          name: classes.name,
          instructorName: classes.instructorName,
          weekday: classes.weekday,
          startTime: classes.startTime,
          endTime: classes.endTime,
          capacity: classes.capacity,
          isActive: classes.isActive,
          locationId: classes.locationId,
          locationName: locations.name,
          enrolled: sql<number>`(select count(*)::int from ${enrolments} where ${enrolments.classId} = ${classes.id} and (${enrolments.endDate} is null or ${enrolments.endDate} >= current_date))`,
        })
        .from(classes)
        .leftJoin(locations, eq(locations.id, classes.locationId))
        .where(includeInactive === 'true' ? undefined : eq(classes.isActive, true))
        .orderBy(asc(classes.weekday), asc(classes.startTime));
      res.json({ classes: rows });
    }),
  );

  r.post(
    '/',
    ah(async (req, res) => {
      const body = parse(classBody, req.body);
      const [created] = await db.insert(classes).values(body).returning();
      await audit(db, req, 'class', created.id, 'create', null, created);
      await generateSessions(db, { classId: created.id });
      res.status(201).json({ class: created });
    }),
  );

  r.get(
    '/:id',
    ah(async (req, res) => {
      const id = idParam(req);
      const [cls] = await db.select().from(classes).where(eq(classes.id, id));
      if (!cls) notFound('Class');
      const roster = await db
        .select({ enrolmentId: enrolments.id, studentId: students.id, name: students.name, startDate: enrolments.startDate, endDate: enrolments.endDate })
        .from(enrolments)
        .innerJoin(students, eq(students.id, enrolments.studentId))
        .where(eq(enrolments.classId, id))
        .orderBy(asc(students.name));
      res.json({ class: cls, enrolments: roster });
    }),
  );

  r.patch(
    '/:id',
    ah(async (req, res) => {
      const id = idParam(req);
      const body = parse(classBody.partial(), req.body);
      const [before] = await db.select().from(classes).where(eq(classes.id, id));
      if (!before) notFound('Class');
      const [updated] = await db.update(classes).set(body).where(eq(classes.id, id)).returning();

      if (body.weekday !== undefined && body.weekday !== before.weekday) {
        // Weekday changed: drop future sessions nobody has attendance on, then regenerate on the new weekday.
        const s = await getSettings(db);
        const today = zonedNow(s.timezone).date;
        await db.delete(classSessions).where(
          and(
            eq(classSessions.classId, id),
            gte(classSessions.sessionDate, today),
            notExists(db.select({ x: sql`1` }).from(attendance).where(eq(attendance.sessionId, classSessions.id))),
          ),
        );
      }
      if (updated.isActive) await generateSessions(db, { classId: id });

      await audit(db, req, 'class', id, 'update', before, updated);
      res.json({ class: updated });
    }),
  );

  return r;
}
