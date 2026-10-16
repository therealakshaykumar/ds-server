import { and, asc, desc, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { awards, events, students, users } from '../../db/schema';
import { audit } from '../../lib/audit';
import { zonedNow } from '../../lib/dates';
import { ah, idParam, notFound, parse } from '../../lib/http';
import { type Ctx, notifyUsers } from '../../lib/notify';
import { dateStr, timeStr } from '../../lib/schemas';
import { getSettings } from '../../lib/settings';

const eventBody = z.object({
  title: z.string().trim().min(1),
  description: z.string().optional(),
  eventDate: dateStr,
  startTime: timeStr.nullable().optional(),
  venue: z.string().trim().optional(),
  isPublished: z.boolean().default(true),
});

export function eventsRouter(ctx: Ctx): Router {
  const { db } = ctx;
  const r = Router();

  r.get(
    '/',
    ah(async (_req, res) => {
      res.json({ events: await db.select().from(events).orderBy(desc(events.eventDate)) });
    }),
  );

  r.post(
    '/',
    ah(async (req, res) => {
      const body = parse(eventBody.extend({ notify: z.boolean().default(false) }), req.body);
      const { notify, ...values } = body;
      const [created] = await db.insert(events).values(values).returning();
      await audit(db, req, 'event', created.id, 'create', null, created);
      if (notify && created.isPublished) {
        const recipients = await db.select({ id: users.id }).from(users).where(and(eq(users.role, 'user'), eq(users.isActive, true)));
        await notifyUsers(ctx, recipients.map((u) => u.id), `New event: ${created.title}`, `${created.title} on ${created.eventDate}${created.venue ? ` at ${created.venue}` : ''}.`);
      }
      res.status(201).json({ event: created });
    }),
  );

  r.patch(
    '/:id',
    ah(async (req, res) => {
      const id = idParam(req);
      const body = parse(eventBody.partial(), req.body);
      const [before] = await db.select().from(events).where(eq(events.id, id));
      if (!before) notFound('Event');
      const [updated] = await db.update(events).set(body).where(eq(events.id, id)).returning();
      await audit(db, req, 'event', id, 'update', before, updated);
      res.json({ event: updated });
    }),
  );

  r.delete(
    '/:id',
    ah(async (req, res) => {
      const id = idParam(req);
      const [used] = await db.select({ id: awards.id }).from(awards).where(eq(awards.eventId, id)).limit(1);
      if (used) {
        // Awards reference this event; unpublish instead of deleting.
        await db.update(events).set({ isPublished: false }).where(eq(events.id, id));
        res.json({ ok: true, unpublished: true });
        return;
      }
      const [deleted] = await db.delete(events).where(eq(events.id, id)).returning();
      if (!deleted) notFound('Event');
      await audit(db, req, 'event', id, 'delete', deleted, null);
      res.json({ ok: true });
    }),
  );

  return r;
}

export function awardsRouter(ctx: Ctx): Router {
  const { db } = ctx;
  const r = Router();

  r.get(
    '/',
    ah(async (req, res) => {
      const { studentId } = parse(z.object({ studentId: z.coerce.number().int().positive().optional() }), req.query);
      const rows = await db
        .select({
          id: awards.id,
          title: awards.title,
          description: awards.description,
          awardedOn: awards.awardedOn,
          studentId: students.id,
          studentName: students.name,
          eventId: awards.eventId,
          eventTitle: events.title,
        })
        .from(awards)
        .innerJoin(students, eq(students.id, awards.studentId))
        .leftJoin(events, eq(events.id, awards.eventId))
        .where(studentId ? eq(awards.studentId, studentId) : undefined)
        .orderBy(desc(awards.awardedOn), asc(students.name));
      res.json({ awards: rows });
    }),
  );

  r.post(
    '/',
    ah(async (req, res) => {
      const body = parse(
        z.object({
          studentId: z.number().int().positive(),
          eventId: z.number().int().positive().nullable().optional(),
          title: z.string().trim().min(1),
          description: z.string().optional(),
          awardedOn: dateStr.optional(),
        }),
        req.body,
      );
      const [student] = await db.select().from(students).where(eq(students.id, body.studentId));
      if (!student) notFound('Student');
      const s = await getSettings(db);
      const [created] = await db
        .insert(awards)
        .values({ ...body, awardedOn: body.awardedOn ?? zonedNow(s.timezone).date })
        .returning();
      await audit(db, req, 'award', created.id, 'create', null, created);
      await notifyUsers(ctx, [student.parentUserId], 'New award', `${student.name} received an award: ${created.title}.`);
      res.status(201).json({ award: created });
    }),
  );

  r.delete(
    '/:id',
    ah(async (req, res) => {
      const id = idParam(req);
      const [deleted] = await db.delete(awards).where(eq(awards.id, id)).returning();
      if (!deleted) notFound('Award');
      await audit(db, req, 'award', id, 'delete', deleted, null);
      res.json({ ok: true });
    }),
  );

  return r;
}
