import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, asc, eq, ilike, or } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { users } from '../../db/schema';
import { audit } from '../../lib/audit';
import { ah, HttpError, idParam, notFound, paging, parse } from '../../lib/http';
import type { Ctx } from '../../lib/notify';
import { email } from '../../lib/schemas';

export const publicUser = {
  id: users.id,
  role: users.role,
  name: users.name,
  email: users.email,
  phone: users.phone,
  isActive: users.isActive,
  mustChangePassword: users.mustChangePassword,
  createdAt: users.createdAt,
};

export function tempPassword(): string {
  return randomBytes(9).toString('base64url');
}

export function usersRouter({ db }: Ctx): Router {
  const r = Router();

  r.get(
    '/',
    ah(async (req, res) => {
      const q = parse(z.object({ role: z.enum(['admin', 'user']).optional(), q: z.string().trim().optional() }), req.query);
      const { limit, offset } = paging(req.query);
      const rows = await db
        .select(publicUser)
        .from(users)
        .where(
          and(
            q.role ? eq(users.role, q.role) : undefined,
            q.q ? or(ilike(users.name, `%${q.q}%`), ilike(users.email, `%${q.q}%`), ilike(users.phone, `%${q.q}%`)) : undefined,
          ),
        )
        .orderBy(asc(users.name))
        .limit(limit)
        .offset(offset);
      res.json({ users: rows });
    }),
  );

  r.post(
    '/',
    ah(async (req, res) => {
      const body = parse(
        z.object({
          name: z.string().trim().min(1),
          email,
          phone: z.string().trim().optional(),
          role: z.enum(['admin', 'user']).default('user'),
          password: z.string().min(8).optional(),
        }),
        req.body,
      );
      const plain = body.password ?? tempPassword();
      const [created] = await db
        .insert(users)
        .values({
          name: body.name,
          email: body.email,
          phone: body.phone,
          role: body.role,
          passwordHash: await bcrypt.hash(plain, 10),
          mustChangePassword: true,
        })
        .returning(publicUser);
      await audit(db, req, 'user', created.id, 'create', null, { ...created });
      res.status(201).json({ user: created, ...(body.password ? {} : { tempPassword: plain }) });
    }),
  );

  r.patch(
    '/:id',
    ah(async (req, res) => {
      const id = idParam(req);
      const body = parse(
        z.object({
          name: z.string().trim().min(1).optional(),
          email: email.optional(),
          phone: z.string().trim().nullable().optional(),
          isActive: z.boolean().optional(),
        }),
        req.body,
      );
      if (id === req.user!.id && body.isActive === false) {
        throw new HttpError(400, 'You cannot deactivate your own account', 'INVALID');
      }
      const [before] = await db.select(publicUser).from(users).where(eq(users.id, id));
      if (!before) notFound('User');
      const [updated] = await db
        .update(users)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(users.id, id))
        .returning(publicUser);
      await audit(db, req, 'user', id, 'update', before, updated);
      res.json({ user: updated });
    }),
  );

  r.post(
    '/:id/reset-password',
    ah(async (req, res) => {
      const id = idParam(req);
      const plain = tempPassword();
      const [updated] = await db
        .update(users)
        .set({ passwordHash: await bcrypt.hash(plain, 10), mustChangePassword: true, updatedAt: new Date() })
        .where(eq(users.id, id))
        .returning({ id: users.id });
      if (!updated) notFound('User');
      await audit(db, req, 'user', id, 'reset_password');
      res.json({ tempPassword: plain });
    }),
  );

  return r;
}
