/**
 * End-to-end smoke test: boots the real Express app against an in-memory Postgres (PGlite),
 * applies the generated migrations and exercises the main flows over HTTP.
 * Run with: npm run smoke
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import bcrypt from 'bcryptjs';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createApp } from '../src/app';
import type { Config } from '../src/config';
import * as schema from '../src/db/schema';
import { addDays, addMonths, weekdayOf, zonedNow } from '../src/lib/dates';
import { haversineMeters } from '../src/lib/geo';
import { computeDiscount } from '../src/lib/money';
import { SETTING_DEFAULTS } from '../src/lib/settings';
import { shouldRemind } from '../src/services/reminders';

let passed = 0;
function step(name: string) {
  passed++;
  console.log(`  ok  ${name}`);
}

async function main() {
  // ---- pure helpers ----
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addMonths('2026-11-15', 3), '2027-02-15');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(weekdayOf('2026-10-15'), 4); // Thursday
  assert.equal(computeDiscount(100000, 'percent', 10), 10000);
  assert.equal(computeDiscount(100000, 'flat', 999999), 100000);
  assert.ok(Math.abs(haversineMeters(12.9716, 77.5946, 12.9716, 77.5946)) < 0.001);
  assert.ok(Math.abs(haversineMeters(0, 0, 0, 0.001) - 111.2) < 1);
  assert.equal(shouldRemind('2026-10-10', '2026-10-13', null), true); // 3 days before
  assert.equal(shouldRemind('2026-10-11', '2026-10-13', null), false);
  assert.equal(shouldRemind('2026-10-13', '2026-10-13', '2026-10-13'), false); // already reminded today
  assert.equal(shouldRemind('2026-10-14', '2026-10-13', null), true); // day after due
  assert.equal(shouldRemind('2026-10-20', '2026-10-13', null), false); // quiet between reminders
  assert.equal(shouldRemind('2026-10-21', '2026-10-13', null), true); // then weekly
  step('pure helpers');

  // ---- boot app on in-memory Postgres ----
  const pg = new PGlite();
  const db = drizzle(pg, { schema });
  await migrate(db, { migrationsFolder: path.join(__dirname, '../drizzle') });
  const config: Config = {
    env: 'test',
    port: 0,
    jwtSecret: 'test-secret-test-secret-test-secret',
    jwtExpiresDays: 1,
    corsOrigins: ['http://localhost:3000'],
    cookieSameSite: 'lax',
    jobSecret: 'job-secret-123',
    emailFrom: 'test@example.com',
  };
  await db.insert(schema.users).values({
    role: 'admin',
    name: 'Admin',
    email: 'admin@test.com',
    passwordHash: await bcrypt.hash('AdminPass123', 4),
  });
  const server = createApp({ db: db as never, config }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function api(method: string, url: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const type = res.headers.get('content-type') ?? '';
    const json = type.includes('json') ? await res.json() : null;
    const bytes = type.includes('pdf') ? Buffer.from(await res.arrayBuffer()) : null;
    return { status: res.status, json: json as any, type, bytes, headers: res.headers };
  }
  const expect = (r: { status: number; json: any }, status: number, label: string) =>
    assert.equal(r.status, status, `${label}: expected ${status}, got ${r.status} ${JSON.stringify(r.json)}`);

  try {
    // ---- auth ----
    let r = await api('GET', '/health');
    expect(r, 200, 'health');
    r = await api('GET', '/admin/students');
    expect(r, 401, 'admin without token');
    r = await api('POST', '/auth/login', { body: { email: 'admin@test.com', password: 'wrong-password' } });
    expect(r, 401, 'bad login');
    r = await api('POST', '/auth/login', { body: { email: 'ADMIN@test.com', password: 'AdminPass123' } });
    expect(r, 200, 'admin login');
    assert.match(r.headers.get('set-cookie') ?? '', /ds_token=.*HttpOnly/i);
    const admin: string = r.json.token;
    step('auth: login, cookie, bad password, unauthenticated');

    // settings seeded lazily with defaults
    r = await api('GET', '/admin/settings', { token: admin });
    expect(r, 200, 'settings');
    assert.equal(r.json.settings.timezone, SETTING_DEFAULTS.timezone);
    step('settings default');

    // ---- class that is open for attendance right now ----
    const tz = SETTING_DEFAULTS.timezone;
    const now = zonedNow(tz);
    // Keep the open window clear of midnight so the test is stable at any hour.
    assert.ok(now.minutes >= 30 && now.minutes <= 1380, 'run this test between 00:30 and 23:00 school time');
    const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

    r = await api('POST', '/admin/locations', {
      token: admin,
      body: { name: 'Main Studio', latitude: 12.9716, longitude: 77.5946, radiusM: 100 },
    });
    expect(r, 201, 'location');
    const locationId: number = r.json.location.id;

    r = await api('POST', '/admin/classes', {
      token: admin,
      body: {
        name: 'Kathak Beginners',
        instructorName: 'Meera',
        weekday: weekdayOf(now.date),
        startTime: hhmm(now.minutes - 5),
        endTime: hhmm(now.minutes + 55),
        locationId,
        capacity: 2,
      },
    });
    expect(r, 201, 'class');
    const classId: number = r.json.class.id;

    r = await api('GET', `/admin/sessions?from=${now.date}&to=${now.date}`, { token: admin });
    expect(r, 200, 'sessions');
    assert.equal(r.json.sessions.length, 1, 'session for today generated on class creation');
    const sessionId: number = r.json.sessions[0].id;
    step('location, class and session generation');

    // ---- students, parents, enrolment, capacity ----
    r = await api('POST', '/admin/students', {
      token: admin,
      body: { name: 'Anaya', parent: { name: 'Priya Sharma', email: 'Priya@test.com', phone: '9999900001' } },
    });
    expect(r, 201, 'student 1');
    const anaya = r.json.student;
    const priyaPass: string = r.json.parentTempPassword;
    assert.ok(priyaPass, 'temp password returned for a new parent');

    // second child under the same parent reuses the account
    r = await api('POST', '/admin/students', { token: admin, body: { name: 'Kabir', parent: { name: 'Priya Sharma', email: 'priya@test.com' } } });
    expect(r, 201, 'student 2');
    assert.equal(r.json.parentTempPassword, undefined);
    const kabir = r.json.student;
    assert.equal(kabir.parentUserId, anaya.parentUserId);

    r = await api('POST', '/admin/students', { token: admin, body: { name: 'Rohan', parent: { name: 'Amit Verma', email: 'amit@test.com' } } });
    expect(r, 201, 'student 3');
    const rohan = r.json.student;
    const amitPass: string = r.json.parentTempPassword;

    for (const s of [anaya, kabir]) {
      r = await api('POST', '/admin/enrolments', { token: admin, body: { studentId: s.id, classId } });
      expect(r, 201, `enrol ${s.name}`);
    }
    r = await api('POST', '/admin/enrolments', { token: admin, body: { studentId: rohan.id, classId } });
    expect(r, 409, 'class is full');
    assert.equal(r.json.error.code, 'CLASS_FULL');
    r = await api('POST', '/admin/enrolments', { token: admin, body: { studentId: anaya.id, classId } });
    expect(r, 409, 'duplicate enrolment');
    step('students, parent reuse, enrolment, capacity, duplicate guard');

    // ---- parent: schedule + geofenced attendance ----
    r = await api('POST', '/auth/login', { body: { email: 'priya@test.com', password: priyaPass } });
    expect(r, 200, 'parent login');
    assert.equal(r.json.user.mustChangePassword, true);
    const priya: string = r.json.token;
    r = await api('GET', '/admin/students', { token: priya });
    expect(r, 403, 'parent blocked from admin');

    r = await api('GET', '/my/children', { token: priya });
    assert.equal(r.json.children.length, 2);
    r = await api('GET', `/my/schedule?from=${now.date}&to=${now.date}`, { token: priya });
    expect(r, 200, 'schedule');
    assert.equal(r.json.schedule.length, 2, 'one row per child');
    assert.ok(r.json.schedule.every((x: any) => x.canMark === true));

    const farAway = { sessionId, studentId: anaya.id, latitude: 12.98, longitude: 77.6, accuracyM: 10 };
    r = await api('POST', '/my/attendance', { token: priya, body: farAway });
    expect(r, 422, 'outside geofence');
    assert.equal(r.json.error.code, 'OUTSIDE_GEOFENCE');
    r = await api('POST', '/my/attendance', { token: priya, body: { ...farAway, latitude: 12.9717, longitude: 77.5947, accuracyM: 500 } });
    expect(r, 422, 'low accuracy');
    assert.equal(r.json.error.code, 'LOW_ACCURACY');
    const atStudio = { sessionId, studentId: anaya.id, latitude: 12.9717, longitude: 77.5947, accuracyM: 12 };
    r = await api('POST', '/my/attendance', { token: priya, body: atStudio });
    expect(r, 201, 'mark attendance');
    assert.equal(r.json.attendance.source, 'self');
    r = await api('POST', '/my/attendance', { token: priya, body: atStudio });
    expect(r, 409, 'already marked');
    r = await api('GET', `/my/schedule?from=${now.date}&to=${now.date}`, { token: priya });
    const anayaRow = r.json.schedule.find((x: any) => x.studentId === anaya.id);
    assert.equal(anayaRow.attendanceStatus, 'present');
    assert.equal(anayaRow.canMark, false);

    // another family's child cannot be marked by this parent
    r = await api('POST', '/my/attendance', { token: priya, body: { ...atStudio, studentId: rohan.id } });
    expect(r, 404, "other parent's child");
    step('parent schedule, geofence, accuracy, duplicate, ownership');

    // admin override + attendance views
    r = await api('PUT', '/admin/attendance', { token: admin, body: { sessionId, studentId: kabir.id, status: 'absent' } });
    expect(r, 200, 'admin override');
    r = await api('GET', `/admin/sessions/${sessionId}/sheet`, { token: admin });
    assert.equal(r.json.students.length, 2);
    r = await api('GET', `/my/attendance?studentId=${anaya.id}`, { token: priya });
    expect(r, 200, 'my attendance');
    assert.equal(r.json.summary.present, 1);
    assert.equal(r.json.summary.percent, 100);
    r = await api('GET', `/my/attendance?studentId=${rohan.id}`, { token: priya });
    expect(r, 404, 'attendance of other family');
    step('admin override, attendance sheet and history');

    // ---- fees ----
    r = await api('POST', '/admin/fee-plans', { token: admin, body: { name: 'Monthly', amountPaise: 150000, intervalMonths: 1 } });
    expect(r, 201, 'monthly plan');
    const monthly = r.json.feePlan;
    r = await api('POST', '/admin/fee-plans', { token: admin, body: { name: 'Quarterly', amountPaise: 400000, intervalMonths: 3 } });
    expect(r, 201, 'quarterly plan');
    r = await api('POST', '/admin/fee-plans', { token: admin, body: { name: 'Admission', amountPaise: 50000, isOneTime: true } });
    expect(r, 201, 'one-time plan');
    const admission = r.json.feePlan;
    r = await api('POST', '/admin/fee-plans', { token: admin, body: { name: 'Broken', amountPaise: 100 } });
    expect(r, 400, 'recurring plan needs interval');

    r = await api('POST', '/admin/student-fee-plans', {
      token: admin,
      body: { studentId: anaya.id, feePlanId: monthly.id, discountType: 'percent', discountValue: 10 },
    });
    expect(r, 201, 'assign monthly with 10% discount');
    assert.equal(r.json.invoicesCreated.length, 1, 'first invoice created immediately');
    const invoiceId: number = r.json.invoicesCreated[0];

    r = await api('GET', `/admin/invoices/${invoiceId}`, { token: admin });
    expect(r, 200, 'invoice detail');
    assert.equal(r.json.invoice.subtotalPaise, 150000);
    assert.equal(r.json.invoice.discountPaise, 15000);
    assert.equal(r.json.invoice.totalPaise, 135000);
    assert.match(r.json.invoice.invoiceNumber, /^INV-\d{4}-\d{5}$/);
    assert.equal(r.json.items.length, 1);

    // idempotent: running the job again must not duplicate
    r = await api('POST', '/jobs/generate-invoices', { headers: { 'x-job-secret': 'job-secret-123' } });
    expect(r, 200, 'job via secret');
    assert.equal(r.json.created, 0);
    r = await api('POST', '/jobs/generate-invoices', { headers: { 'x-job-secret': 'wrong-secret-1' } });
    expect(r, 401, 'job with wrong secret');

    // one-time plan bills once and ends
    r = await api('POST', '/admin/student-fee-plans', { token: admin, body: { studentId: kabir.id, feePlanId: admission.id } });
    expect(r, 201, 'assign one-time');
    assert.equal(r.json.invoicesCreated.length, 1);
    assert.equal(r.json.studentFeePlan.status, 'active'); // returned before the job updated it
    r = await api('GET', `/admin/student-fee-plans?studentId=${kabir.id}`, { token: admin });
    assert.equal(r.json.studentFeePlans[0].assignment.status, 'ended');
    step('fee plans, discount, immediate invoice, idempotent job, one-time plan');

    // catch-up: a plan that started 3 months ago creates 4 invoices (3 past periods + today's period start)
    const past = addMonths(now.date, -3);
    r = await api('POST', '/admin/student-fee-plans', { token: admin, body: { studentId: rohan.id, feePlanId: monthly.id, startDate: past } });
    expect(r, 201, 'backdated plan');
    assert.equal(r.json.invoicesCreated.length, 4, 'catches up every missed month');
    step('invoice catch-up for backdated plan');

    // ---- payments ----
    r = await api('POST', '/admin/payments', { token: admin, body: { invoiceId, amountPaise: 200000, method: 'cash' } });
    expect(r, 409, 'overpayment');
    assert.equal(r.json.error.code, 'OVERPAYMENT');
    r = await api('POST', '/admin/payments', { token: admin, body: { invoiceId, amountPaise: 50000, method: 'upi', reference: 'UPI123' } });
    expect(r, 201, 'partial payment');
    assert.equal(r.json.invoice.status, 'partial');
    assert.match(r.json.payment.receiptNumber, /^RCT-\d{4}-\d{5}$/);
    const firstPayment = r.json.payment;
    r = await api('POST', '/admin/payments', { token: admin, body: { invoiceId, amountPaise: 85000, method: 'cash' } });
    expect(r, 201, 'final payment');
    assert.equal(r.json.invoice.status, 'paid');
    r = await api('POST', '/admin/payments', { token: admin, body: { invoiceId, amountPaise: 1, method: 'cash' } });
    expect(r, 409, 'pay a settled invoice');

    // void is blocked once paid; removing a payment reopens the invoice
    r = await api('POST', `/admin/invoices/${invoiceId}/void`, { token: admin });
    expect(r, 409, 'cannot void a paid invoice');
    r = await api('DELETE', `/admin/payments/${firstPayment.id}`, { token: admin });
    expect(r, 200, 'delete payment');
    assert.equal(r.json.invoice.status, 'partial');
    assert.equal(r.json.invoice.amountPaidPaise, 85000);
    step('payments: partial, paid, overpayment, delete recalculates');

    // ---- PDFs and ownership of invoices ----
    r = await api('GET', `/admin/invoices/${invoiceId}/pdf`, { token: admin });
    expect(r, 200, 'invoice pdf');
    assert.equal(r.type, 'application/pdf');
    assert.equal(r.bytes!.subarray(0, 4).toString(), '%PDF');
    r = await api('GET', '/admin/payments?invoiceId=' + invoiceId, { token: admin });
    const paymentId: number = r.json.payments[0].id;
    r = await api('GET', `/admin/payments/${paymentId}/receipt`, { token: admin });
    expect(r, 200, 'receipt pdf');
    assert.equal(r.bytes!.subarray(0, 4).toString(), '%PDF');

    r = await api('GET', '/my/invoices', { token: priya });
    expect(r, 200, 'parent invoices');
    assert.ok(r.json.invoices.length >= 2, 'both children have invoices');
    assert.ok(r.json.invoices.every((x: any) => x.studentId === anaya.id || x.studentId === kabir.id));
    r = await api('GET', `/my/invoices/${invoiceId}/pdf`, { token: priya });
    expect(r, 200, 'parent pdf');

    r = await api('POST', '/auth/login', { body: { email: 'amit@test.com', password: amitPass } });
    const amit: string = r.json.token;
    r = await api('GET', `/my/invoices/${invoiceId}`, { token: amit });
    expect(r, 404, "another family's invoice");
    r = await api('GET', `/my/invoices/${invoiceId}/pdf`, { token: amit });
    expect(r, 404, "another family's invoice pdf");
    r = await api('GET', `/my/payments/${paymentId}/receipt`, { token: amit });
    expect(r, 404, "another family's receipt");
    step('pdfs and per-family invoice isolation');

    // ---- manual invoice, dues, reminders, notifications ----
    r = await api('POST', '/admin/invoices', {
      token: admin,
      body: {
        studentId: anaya.id,
        dueDate: addDays(now.date, 3),
        items: [{ description: 'Costume', quantity: 2, unitAmountPaise: 25000 }],
      },
    });
    expect(r, 201, 'manual invoice');
    assert.equal(r.json.invoice.totalPaise, 50000);

    r = await api('GET', '/admin/reports/dues', { token: admin });
    expect(r, 200, 'dues');
    assert.ok(r.json.dues.length >= 2);
    r = await api('GET', '/admin/reports/dashboard', { token: admin });
    expect(r, 200, 'dashboard');
    assert.equal(r.json.activeStudents, 3);
    assert.equal(r.json.sessionsToday, 1);
    assert.equal(r.json.presentToday, 1);
    assert.ok(r.json.outstandingPaise > 0);
    r = await api('GET', `/admin/reports/collections?from=${addDays(now.date, -30)}&to=${now.date}`, { token: admin });
    expect(r, 200, 'collections');
    assert.equal(r.json.byMethod.length, 1);
    r = await api('GET', `/admin/reports/attendance?from=${addDays(now.date, -30)}&to=${now.date}`, { token: admin });
    expect(r, 200, 'attendance report');
    const anayaReport = r.json.attendance.find((x: any) => x.studentId === anaya.id);
    assert.equal(anayaReport.present, 1);

    // reminders: Rohan's older invoices are overdue; run on a day that matches the schedule
    r = await api('POST', '/jobs/send-reminders', { headers: { 'x-job-secret': 'job-secret-123' } });
    expect(r, 200, 'reminders');
    assert.ok(r.json.sent >= 1, 'at least one reminder sent');
    r = await api('POST', '/jobs/send-reminders', { headers: { 'x-job-secret': 'job-secret-123' } });
    assert.equal(r.json.sent, 0, 'no duplicate reminders on the same day');

    r = await api('GET', '/my/notifications', { token: priya });
    expect(r, 200, 'notifications');
    assert.ok(r.json.unread >= 2);
    const first = r.json.notifications[0];
    r = await api('POST', `/my/notifications/${first.id}/read`, { token: priya });
    expect(r, 200, 'read notification');
    r = await api('POST', `/my/notifications/${first.id}/read`, { token: amit });
    expect(r, 404, "cannot read another user's notification");
    step('manual invoice, reports, reminders (no dupes), notifications');

    // ---- cancel a session, events, awards, audit ----
    r = await api('POST', `/admin/sessions/${sessionId}/cancel`, { token: admin, body: { reason: 'Instructor unwell' } });
    expect(r, 200, 'cancel session');
    r = await api('GET', `/my/schedule?from=${now.date}&to=${now.date}`, { token: priya });
    assert.ok(r.json.schedule.every((x: any) => x.sessionStatus === 'cancelled' && x.canMark === false));
    r = await api('GET', '/my/notifications', { token: priya });
    assert.ok(r.json.notifications.some((n: any) => n.title === 'Class cancelled'));

    r = await api('POST', '/admin/events', {
      token: admin,
      body: { title: 'Annual Day', eventDate: addDays(now.date, 30), venue: 'Town Hall', notify: true },
    });
    expect(r, 201, 'event');
    const eventId: number = r.json.event.id;
    r = await api('POST', '/admin/awards', { token: admin, body: { studentId: anaya.id, eventId, title: 'Best Performer' } });
    expect(r, 201, 'award');
    r = await api('GET', '/my/events', { token: priya });
    assert.equal(r.json.upcoming.length, 1);
    r = await api('GET', '/my/awards', { token: priya });
    assert.equal(r.json.awards.length, 1);
    r = await api('GET', '/my/awards', { token: amit });
    assert.equal(r.json.awards.length, 0);

    r = await api('GET', '/admin/audit-logs?entity=payment', { token: admin });
    expect(r, 200, 'audit');
    assert.ok(r.json.auditLogs.length >= 3, 'payments are audited');
    step('cancel session, events, awards, audit log');

    // ---- settings, validation, errors ----
    r = await api('PUT', '/admin/settings', { token: admin, body: { schoolName: 'Nritya Academy', invoiceDueDays: 7 } });
    expect(r, 200, 'update settings');
    assert.equal(r.json.settings.schoolName, 'Nritya Academy');
    r = await api('PUT', '/admin/settings', { token: admin, body: { timezone: 'Mars/Phobos' } });
    expect(r, 400, 'invalid timezone');
    r = await api('POST', '/admin/students', { token: admin, body: { name: '' } });
    expect(r, 400, 'validation');
    r = await api('POST', '/admin/payments', { token: admin, body: { invoiceId: 999999, amountPaise: 100, method: 'cash' } });
    expect(r, 404, 'unknown invoice');
    r = await api('GET', '/nope', { token: admin });
    expect(r, 404, 'unknown route');
    r = await api('POST', '/auth/change-password', { token: priya, body: { currentPassword: priyaPass, newPassword: 'NewSecret99' } });
    expect(r, 200, 'change password');
    r = await api('POST', '/auth/login', { body: { email: 'priya@test.com', password: 'NewSecret99' } });
    expect(r, 200, 'login with new password');
    assert.equal(r.json.user.mustChangePassword, false);

    // deactivated users are locked out immediately
    r = await api('PATCH', `/admin/users/${anaya.parentUserId}`, { token: admin, body: { isActive: false } });
    expect(r, 200, 'deactivate parent');
    r = await api('GET', '/my/children', { token: priya });
    expect(r, 401, 'deactivated user blocked');
    step('settings, validation, errors, password change, deactivation');

    console.log(`\nAll ${passed} smoke checks passed.`);
  } finally {
    server.close();
    await pg.close();
  }
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED\n', err);
  process.exit(1);
});
