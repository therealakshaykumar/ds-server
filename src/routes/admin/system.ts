import { and, desc, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { auditLogs, settings, users } from '../../db/schema';
import { audit } from '../../lib/audit';
import { ah, paging, parse } from '../../lib/http';
import { type Ctx, notifyUsers } from '../../lib/notify';
import { getSettings, SETTING_KEYS } from '../../lib/settings';

export function settingsRouter({ db }: Ctx): Router {
  const r = Router();

  r.get(
    '/',
    ah(async (_req, res) => {
      res.json({ settings: await getSettings(db) });
    }),
  );

  r.put(
    '/',
    ah(async (req, res) => {
      const body = parse(
        z
          .object({
            schoolName: z.string().trim().min(1),
            timezone: z.string().refine((tz) => {
              try {
                new Intl.DateTimeFormat('en', { timeZone: tz });
                return true;
              } catch {
                return false;
              }
            }, 'Unknown timezone'),
            invoicePrefix: z.string().trim().min(1).max(10),
            invoiceDueDays: z.number().int().min(0).max(120),
            attendanceOpenBeforeMin: z.number().int().min(0).max(180),
            attendanceCloseAfterMin: z.number().int().min(0).max(180),
            maxGpsAccuracyM: z.number().int().min(5).max(1000),
            sessionDaysAhead: z.number().int().min(7).max(120),
          })
          .partial()
          .strict(),
        req.body,
      );
      const before = await getSettings(db);
      for (const key of SETTING_KEYS) {
        const value = body[key];
        if (value === undefined) continue;
        await db
          .insert(settings)
          .values({ key, value: String(value) })
          .onConflictDoUpdate({ target: settings.key, set: { value: String(value) } });
      }
      const after = await getSettings(db);
      await audit(db, req, 'settings', null, 'update', before, after);
      res.json({ settings: after });
    }),
  );

  return r;
}

export function auditRouter({ db }: Ctx): Router {
  const r = Router();
  r.get(
    '/',
    ah(async (req, res) => {
      const q = parse(
        z.object({ entity: z.string().optional(), entityId: z.string().optional(), actorUserId: z.coerce.number().int().optional() }),
        req.query,
      );
      const { limit, offset } = paging(req.query, 100);
      const rows = await db
        .select({
          id: auditLogs.id,
          entity: auditLogs.entity,
          entityId: auditLogs.entityId,
          action: auditLogs.action,
          before: auditLogs.before,
          after: auditLogs.after,
          createdAt: auditLogs.createdAt,
          actorName: users.name,
        })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.actorUserId))
        .where(
          and(
            q.entity ? eq(auditLogs.entity, q.entity) : undefined,
            q.entityId ? eq(auditLogs.entityId, q.entityId) : undefined,
            q.actorUserId ? eq(auditLogs.actorUserId, q.actorUserId) : undefined,
          ),
        )
        .orderBy(desc(auditLogs.id))
        .limit(limit)
        .offset(offset);
      res.json({ auditLogs: rows });
    }),
  );
  return r;
}

/** Broadcast a message to all parents, or to specific users. */
export function announcementsRouter(ctx: Ctx): Router {
  const r = Router();
  r.post(
    '/',
    ah(async (req, res) => {
      const body = parse(
        z.object({
          title: z.string().trim().min(1),
          body: z.string().trim().min(1),
          userIds: z.array(z.number().int().positive()).optional(),
        }),
        req.body,
      );
      const ids =
        body.userIds ??
        (await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.role, 'user'), eq(users.isActive, true)))).map((u) => u.id);
      await notifyUsers(ctx, ids, body.title, body.body);
      await audit(ctx.db, req, 'announcement', null, 'create', null, { title: body.title, recipients: ids.length });
      res.status(201).json({ recipients: ids.length });
    }),
  );
  return r;
}
