import { and, asc, eq, gte, isNull, or, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { classes, enrolments, students } from '../../db/schema';
import { audit } from '../../lib/audit';
import { zonedNow } from '../../lib/dates';
import { ah, HttpError, idParam, notFound, parse } from '../../lib/http';
import type { Ctx } from '../../lib/notify';
import { dateStr } from '../../lib/schemas';
import { getSettings } from '../../lib/settings';

export function enrolmentsRouter({ db }: Ctx): Router {
  const r = Router();

  r.get(
    '/',
    ah(async (req, res) => {
      const q = parse(
        z.object({
          studentId: z.coerce.number().int().positive().optional(),
          classId: z.coerce.number().int().positive().optional(),
        }),
        req.query,
      );
      const rows = await db
        .select({
          id: enrolments.id,
          studentId: students.id,
          studentName: students.name,
          classId: classes.id,
          className: classes.name,
          startDate: enrolments.startDate,
          endDate: enrolments.endDate,
        })
        .from(enrolments)
        .innerJoin(students, eq(students.id, enrolments.studentId))
        .innerJoin(classes, eq(classes.id, enrolments.classId))
        .where(
          and(
            q.studentId ? eq(enrolments.studentId, q.studentId) : undefined,
            q.classId ? eq(enrolments.classId, q.classId) : undefined,
          ),
        )
        .orderBy(asc(students.name));
      res.json({ enrolments: rows });
    }),
  );

  r.post(
    '/',
    ah(async (req, res) => {
      const body = parse(
        z.object({
          studentId: z.number().int().positive(),
          classId: z.number().int().positive(),
          startDate: dateStr.optional(),
        }),
        req.body,
      );
      const s = await getSettings(db);
      const today = zonedNow(s.timezone).date;

      const created = await db.transaction(async (tx) => {
        const [student] = await tx.select().from(students).where(eq(students.id, body.studentId));
        if (!student) notFound('Student');
        // Lock the class row so concurrent enrolments cannot exceed capacity.
        const [cls] = await tx.select().from(classes).where(eq(classes.id, body.classId)).for('update');
        if (!cls) notFound('Class');
        if (!cls.isActive) throw new HttpError(409, 'Class is not active', 'CONFLICT');

        const activeFilter = and(
          eq(enrolments.classId, cls.id),
          or(isNull(enrolments.endDate), gte(enrolments.endDate, today)),
        );
        const [dup] = await tx
          .select({ id: enrolments.id })
          .from(enrolments)
          .where(and(activeFilter, eq(enrolments.studentId, body.studentId)));
        if (dup) throw new HttpError(409, 'Student is already enrolled in this class', 'CONFLICT');

        if (cls.capacity) {
          const [{ n }] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(enrolments)
            .where(activeFilter);
          if (n >= cls.capacity) throw new HttpError(409, 'Class is full', 'CLASS_FULL');
        }

        const [row] = await tx
          .insert(enrolments)
          .values({ studentId: body.studentId, classId: body.classId, startDate: body.startDate ?? today })
          .returning();
        await audit(tx, req, 'enrolment', row.id, 'create', null, row);
        return row;
      });
      res.status(201).json({ enrolment: created });
    }),
  );

  /** End an enrolment (history is kept). */
  r.patch(
    '/:id',
    ah(async (req, res) => {
      const id = idParam(req);
      const body = parse(z.object({ endDate: dateStr.nullable() }), req.body);
      const [before] = await db.select().from(enrolments).where(eq(enrolments.id, id));
      if (!before) notFound('Enrolment');
      if (body.endDate && body.endDate < before.startDate) {
        throw new HttpError(400, 'endDate cannot be before startDate', 'INVALID');
      }
      const [updated] = await db.update(enrolments).set({ endDate: body.endDate }).where(eq(enrolments.id, id)).returning();
      await audit(db, req, 'enrolment', id, 'update', before, updated);
      res.json({ enrolment: updated });
    }),
  );

  return r;
}
