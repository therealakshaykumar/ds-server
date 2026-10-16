import type { Request, RequestHandler } from 'express';
import { HttpError } from '../lib/http';

/** Small in-memory limiter. Fine for a single instance; swap for Redis if the API is ever scaled out. */
export function rateLimit(opts: {
  windowMs: number;
  max: number;
  key: (req: Request) => string;
}): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, _res, next) => {
    const now = Date.now();
    const key = opts.key(req);
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + opts.windowMs });
    } else if (++entry.count > opts.max) {
      return next(new HttpError(429, 'Too many attempts, please try again later', 'RATE_LIMITED'));
    }
    if (hits.size > 5000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    next();
  };
}
