import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { users } from '../db/schema';
import { audit } from '../lib/audit';
import { ah, HttpError, parse } from '../lib/http';
import type { Ctx } from '../lib/notify';
import { email, password } from '../lib/schemas';
import { authenticate, COOKIE_NAME, signToken } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';

export function authRouter(ctx: Ctx): Router {
  const { db, config } = ctx;
  const r = Router();

  const cookieOptions = {
    httpOnly: true,
    secure: config.env === 'production' || config.cookieSameSite === 'none',
    sameSite: config.cookieSameSite,
    maxAge: config.jwtExpiresDays * 86_400_000,
    path: '/',
  } as const;

  const loginLimiter = rateLimit({
    windowMs: 15 * 60_000,
    max: 10,
    key: (req) => `${req.ip}:${String(req.body?.email ?? '').toLowerCase()}`,
  });

  r.post(
    '/login',
    loginLimiter,
    ah(async (req, res) => {
      const body = parse(z.object({ email, password: z.string().min(1) }), req.body);
      const [u] = await db.select().from(users).where(eq(users.email, body.email));
      // Same message for unknown email / wrong password / inactive to avoid account probing.
      const ok = u && u.isActive && (await bcrypt.compare(body.password, u.passwordHash));
      if (!ok) throw new HttpError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
      const token = signToken(ctx, u.id);
      res.cookie(COOKIE_NAME, token, cookieOptions);
      res.json({
        user: { id: u.id, role: u.role, name: u.name, email: u.email, mustChangePassword: u.mustChangePassword },
        token,
      });
    }),
  );

  r.post('/logout', (_req, res) => {
    res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: undefined });
    res.json({ ok: true });
  });

  r.get(
    '/me',
    authenticate(ctx),
    ah(async (req, res) => {
      const [u] = await db.select().from(users).where(eq(users.id, req.user!.id));
      res.json({
        user: {
          id: u.id,
          role: u.role,
          name: u.name,
          email: u.email,
          phone: u.phone,
          mustChangePassword: u.mustChangePassword,
        },
      });
    }),
  );

  r.post(
    '/change-password',
    authenticate(ctx),
    ah(async (req, res) => {
      const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: password }), req.body);
      const [u] = await db.select().from(users).where(eq(users.id, req.user!.id));
      if (!(await bcrypt.compare(body.currentPassword, u.passwordHash))) {
        throw new HttpError(400, 'Current password is incorrect', 'INVALID_CREDENTIALS');
      }
      await db
        .update(users)
        .set({ passwordHash: await bcrypt.hash(body.newPassword, 10), mustChangePassword: false, updatedAt: new Date() })
        .where(eq(users.id, u.id));
      await audit(db, req, 'user', u.id, 'change_password');
      res.json({ ok: true });
    }),
  );

  return r;
}
