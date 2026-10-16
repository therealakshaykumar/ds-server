import type { ErrorRequestHandler, RequestHandler } from 'express';
import { HttpError } from '../lib/http';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new HttpError(404, `Route not found: ${req.method} ${req.path}`, 'NOT_FOUND'));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  // Postgres unique violation
  if (err?.code === '23505' || err?.cause?.code === '23505') {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'A record with these details already exists' } });
    return;
  }
  // Postgres foreign key violation
  if (err?.code === '23503' || err?.cause?.code === '23503') {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'Referenced or dependent record conflict' } });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON' } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
};
