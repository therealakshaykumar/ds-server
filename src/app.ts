import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { authenticate, requireRole } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error';
import type { Ctx } from './lib/notify';
import { announcementsRouter, auditRouter, settingsRouter } from './routes/admin/system';
import { attendanceRouter } from './routes/admin/attendance';
import { classesRouter } from './routes/admin/classes';
import { awardsRouter, eventsRouter } from './routes/admin/content';
import { enrolmentsRouter } from './routes/admin/enrolments';
import { feePlansRouter, studentFeePlansRouter } from './routes/admin/feePlans';
import { invoicesRouter } from './routes/admin/invoices';
import { locationsRouter } from './routes/admin/locations';
import { paymentsRouter } from './routes/admin/payments';
import { reportsRouter } from './routes/admin/reports';
import { sessionsRouter } from './routes/admin/sessions';
import { studentsRouter } from './routes/admin/students';
import { usersRouter } from './routes/admin/users';
import { authRouter } from './routes/auth';
import { jobsRouter } from './routes/jobs';
import { myRouter } from './routes/my';

/** Builds the Express app. The database is injected so tests can use an in-memory Postgres. */
export function createApp(ctx: Ctx): Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind Render/Railway/Vercel proxies; needed for correct client IPs in rate limiting.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || ctx.config.corsOrigins.includes(origin)),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/auth', authRouter(ctx));
  app.use('/jobs', jobsRouter(ctx));

  const admin = express.Router();
  admin.use(authenticate(ctx), requireRole('admin'));
  admin.use('/users', usersRouter(ctx));
  admin.use('/students', studentsRouter(ctx));
  admin.use('/locations', locationsRouter(ctx));
  admin.use('/classes', classesRouter(ctx));
  admin.use('/sessions', sessionsRouter(ctx));
  admin.use('/enrolments', enrolmentsRouter(ctx));
  admin.use('/attendance', attendanceRouter(ctx));
  admin.use('/fee-plans', feePlansRouter(ctx));
  admin.use('/student-fee-plans', studentFeePlansRouter(ctx));
  admin.use('/invoices', invoicesRouter(ctx));
  admin.use('/payments', paymentsRouter(ctx));
  admin.use('/events', eventsRouter(ctx));
  admin.use('/awards', awardsRouter(ctx));
  admin.use('/reports', reportsRouter(ctx));
  admin.use('/settings', settingsRouter(ctx));
  admin.use('/audit-logs', auditRouter(ctx));
  admin.use('/announcements', announcementsRouter(ctx));
  app.use('/admin', admin);

  app.use('/my', authenticate(ctx), requireRole('user'), myRouter(ctx));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
