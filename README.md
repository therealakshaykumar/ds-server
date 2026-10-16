# DC API

Express + TypeScript + Drizzle ORM + PostgreSQL (Neon). Two roles: `admin` and `user` (a parent, who can have several children).

## Setup

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL, JWT_SECRET, JOB_SECRET, ADMIN_*
npm run db:migrate          # applies drizzle/*.sql to the database
npm run db:seed             # creates the first admin + default settings
npm run dev                 # http://localhost:4100
```

Other commands: `npm run typecheck`, `npm run smoke` (end-to-end test on an in-memory Postgres, no database needed), `npm run build`, `npm start`.

Schema changes: edit `src/db/schema.ts`, run `npm run db:generate`, review the new SQL file in `drizzle/`, then `npm run db:migrate`.

Production (after `npm run build`): `npm run migrate:prod`, `npm run seed:prod`, `npm start`.

## Conventions

- Money is integer **paise**. Dates are `YYYY-MM-DD`, times `HH:MM`, interpreted in the school timezone (setting `timezone`, default `Asia/Kolkata`).
- Errors are `{ "error": { "code", "message", "details?" } }`.
- Auth: httpOnly cookie `ds_token`, or `Authorization: Bearer <token>`. `POST /auth/login` returns both.
- Cross-site deployment (web and API on different domains): set `COOKIE_SAMESITE=none`, serve over HTTPS and list the web origin in `CORS_ORIGINS`. The web app must send requests with `credentials: 'include'`.
- Every admin change to fees, attendance, students, classes and settings is written to `audit_logs`.

## Endpoints

### Public
| Method | Path | |
|---|---|---|
| GET | `/health` | liveness |
| POST | `/auth/login` | `{ email, password }` (rate limited) |
| POST | `/auth/logout` | |
| GET | `/auth/me` | current user |
| POST | `/auth/change-password` | `{ currentPassword, newPassword }` |

### Admin (`/admin/*`, role `admin`)
| Path | Notes |
|---|---|
| `/users` | list, create, `PATCH /:id`, `POST /:id/reset-password`. Returns a temporary password once. |
| `/students` | list/search, create (with `parent` details or `parentUserId`), detail, update |
| `/locations` | geofence: latitude, longitude, `radiusM` |
| `/classes` | weekly class (weekday, start/end, capacity, location). Creating one generates its sessions. |
| `/sessions` | list by date range, `GET /:id/sheet`, `POST /:id/cancel`, `POST /:id/restore` |
| `/enrolments` | enrol a student (capacity and duplicate checks), `PATCH /:id` to end |
| `/attendance` | list, `PUT` to mark or override |
| `/fee-plans` | name, amount, `intervalMonths` (1, 3, 6, 12, ...) or `isOneTime` |
| `/student-fee-plans` | assign a plan to a student with optional amount override and discount (percent or flat). Bills immediately if due. |
| `/invoices` | list/filter, manual create, detail, `/:id/pdf`, `/:id/void` |
| `/payments` | list, record (cash/upi/card/bank/other, partial allowed), `DELETE /:id`, `/:id/receipt` (PDF) |
| `/events`, `/awards` | CRUD. Creating an event with `notify: true` notifies all parents. |
| `/reports` | `dashboard`, `dues`, `collections?from&to`, `attendance?from&to[&classId]` |
| `/settings` | school name, timezone, invoice prefix and due days, attendance window, GPS accuracy, session horizon |
| `/audit-logs`, `/announcements` | |

### Parent (`/my/*`, role `user`)
`GET /children`, `GET /schedule`, `GET /attendance?studentId`, `POST /attendance`, `GET /invoices`, `GET /invoices/:id[/pdf]`, `GET /payments/:id/receipt`, `GET /events`, `GET /awards`, `GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all`.

A parent only ever sees their own children's data; other families' records return 404.

### Attendance rules (`POST /my/attendance`)
Body: `{ sessionId, studentId, latitude, longitude, accuracyM }`. Rejected unless the child is enrolled, the session is not cancelled, "now" is within `attendanceOpenBeforeMin` before the start and `attendanceCloseAfterMin` after the end, the GPS accuracy is within `maxGpsAccuracyM`, and the position is inside the class location's radius. One record per student per session.

### Scheduled jobs (`POST /jobs/...`)
`generate-sessions`, `generate-invoices`, `send-reminders`, `run-all`. Authenticate with the `x-job-secret` header (value of `JOB_SECRET`) or as an admin. All are idempotent, so they are safe to call more than once a day.

Free hosts sleep, so call them from an external scheduler, for example once a day:

```bash
curl -X POST https://<api-host>/jobs/run-all -H "x-job-secret: $JOB_SECRET"
```

## Notifications

Every notification is stored in-app. If `RESEND_API_KEY` is set, it is also emailed. The sender is in `src/lib/notify.ts`, which is the one place to add WhatsApp later.
