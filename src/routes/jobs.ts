import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { ah, HttpError } from '../lib/http';
import type { Ctx } from '../lib/notify';
import { authenticate, requireRole } from '../middleware/auth';
import { generateInvoices } from '../services/invoices';
import { sendInvoiceReminders } from '../services/reminders';
import { generateSessions } from '../services/sessions';

function secretMatches(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Scheduled jobs. Free hosts sleep, so trigger these from an external cron
 * (GitHub Actions, cron-job.org) with the `x-job-secret` header. Admins can also run them from the UI.
 */
export function jobsRouter(ctx: Ctx): Router {
  const r = Router();
  const asAdmin = [authenticate(ctx), requireRole('admin')];

  r.use((req, res, next) => {
    if (secretMatches(req.header('x-job-secret'), ctx.config.jobSecret)) return next();
    let idx = 0;
    const step = (err?: unknown) => {
      if (err) return next(err);
      const mw = asAdmin[idx++];
      if (!mw) return next();
      mw(req, res, step);
    };
    step();
  });

  r.post(
    '/generate-sessions',
    ah(async (_req, res) => {
      res.json(await generateSessions(ctx.db));
    }),
  );
  r.post(
    '/generate-invoices',
    ah(async (_req, res) => {
      res.json(await generateInvoices(ctx));
    }),
  );
  r.post(
    '/send-reminders',
    ah(async (_req, res) => {
      res.json(await sendInvoiceReminders(ctx));
    }),
  );
  r.post(
    '/run-all',
    ah(async (_req, res) => {
      const sessions = await generateSessions(ctx.db);
      const invoicesResult = await generateInvoices(ctx);
      const reminders = await sendInvoiceReminders(ctx);
      res.json({ sessions, invoices: invoicesResult, reminders });
    }),
  );
  r.use((_req, _res, next) => next(new HttpError(404, 'Unknown job', 'NOT_FOUND')));
  return r;
}
