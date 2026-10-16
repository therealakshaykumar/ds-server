import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'ERROR',
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Express 4 does not catch rejected promises, so wrap async handlers. */
export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new HttpError(
      400,
      'Validation failed',
      'VALIDATION',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export function idParam(req: Request, name = 'id'): number {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${name}`, 'VALIDATION');
  return n;
}

export function paging(query: Record<string, unknown>, defaultLimit = 50) {
  const limit = Math.min(Math.max(Number(query.limit) || defaultLimit, 1), 200);
  const offset = Math.max(Number(query.offset) || 0, 0);
  return { limit, offset };
}

export function notFound(what: string): never {
  throw new HttpError(404, `${what} not found`, 'NOT_FOUND');
}
