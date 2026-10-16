import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema';
import { ah, HttpError } from '../lib/http';
import type { Ctx } from '../lib/notify';

export const COOKIE_NAME = 'ds_token';

export interface AuthUser {
  id: number;
  role: 'admin' | 'user';
  name: string;
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signToken(ctx: Ctx, userId: number): string {
  return jwt.sign({ sub: String(userId) }, ctx.config.jwtSecret, {
    expiresIn: ctx.config.jwtExpiresDays * 86_400,
  });
}

function extractToken(req: Request): string | null {
  const cookie = req.cookies?.[COOKIE_NAME];
  if (cookie) return cookie;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

/** Verifies the token and loads the current user from the database on every request. */
export function authenticate(ctx: Ctx): RequestHandler {
  return ah(async (req, _res, next) => {
    const token = extractToken(req);
    if (!token) throw new HttpError(401, 'Not authenticated', 'UNAUTHENTICATED');
    let sub: string;
    try {
      sub = (jwt.verify(token, ctx.config.jwtSecret) as { sub: string }).sub;
    } catch {
      throw new HttpError(401, 'Session expired, please log in again', 'UNAUTHENTICATED');
    }
    const [u] = await ctx.db.select().from(users).where(eq(users.id, Number(sub)));
    if (!u || !u.isActive) throw new HttpError(401, 'Account is not active', 'UNAUTHENTICATED');
    req.user = { id: u.id, role: u.role, name: u.name, email: u.email };
    next();
  });
}

export const requireRole =
  (role: 'admin' | 'user') => (req: Request, _res: Response, next: NextFunction) => {
    if (req.user?.role !== role) return next(new HttpError(403, 'Forbidden', 'FORBIDDEN'));
    next();
  };
