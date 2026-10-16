import { asc, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { classes, locations } from '../../db/schema';
import { audit } from '../../lib/audit';
import { ah, HttpError, idParam, notFound, parse } from '../../lib/http';
import type { Ctx } from '../../lib/notify';

const locationBody = z.object({
  name: z.string().trim().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusM: z.number().int().min(10).max(5000).default(100),
  isActive: z.boolean().optional(),
});

export function locationsRouter({ db }: Ctx): Router {
  const r = Router();

  r.get(
    '/',
    ah(async (_req, res) => {
      res.json({ locations: await db.select().from(locations).orderBy(asc(locations.name)) });
    }),
  );

  r.post(
    '/',
    ah(async (req, res) => {
      const body = parse(locationBody, req.body);
      const [created] = await db.insert(locations).values(body).returning();
      await audit(db, req, 'location', created.id, 'create', null, created);
      res.status(201).json({ location: created });
    }),
  );

  r.patch(
    '/:id',
    ah(async (req, res) => {
      const id = idParam(req);
      const body = parse(locationBody.partial(), req.body);
      const [before] = await db.select().from(locations).where(eq(locations.id, id));
      if (!before) notFound('Location');
      const [updated] = await db.update(locations).set(body).where(eq(locations.id, id)).returning();
      await audit(db, req, 'location', id, 'update', before, updated);
      res.json({ location: updated });
    }),
  );

  r.delete(
    '/:id',
    ah(async (req, res) => {
      const id = idParam(req);
      const [used] = await db.select({ id: classes.id }).from(classes).where(eq(classes.locationId, id)).limit(1);
      if (used) throw new HttpError(409, 'Location is used by a class. Deactivate it instead.', 'CONFLICT');
      const [deleted] = await db.delete(locations).where(eq(locations.id, id)).returning();
      if (!deleted) notFound('Location');
      await audit(db, req, 'location', id, 'delete', deleted, null);
      res.json({ ok: true });
    }),
  );

  return r;
}
