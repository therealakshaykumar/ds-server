import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { attendance, awards, classes, classSessions, enrolments, events, invoices, locations, notifications, students } from '../db/schema';
import { addDays, zonedNow } from '../lib/dates';
import { ah, HttpError, idParam, notFound, paging, parse } from '../lib/http';
import type { Ctx } from '../lib/notify';
import { dateStr } from '../lib/schemas';
import { getSettings } from '../lib/settings';
import { markSelfAttendance, windowState } from '../services/attendance';
import { loadInvoice, sendInvoicePdfFor } from './admin/invoices';
import { sendReceiptPdfFor } from './admin/payments';

/** Everything a parent can see is scoped to their own children, enforced here, not in the UI. */
export function myRouter(ctx: Ctx): Router {
  const { db } = ctx;
  const r = Router();

  const childIds = async (userId: number) =>
    (await db.select({ id: students.id }).from(students).where(eq(students.parentUserId, userId))).map((s) => s.id);

  r.get(
    '/children',
    ah(async (req, res) => {
      const rows = await db
        .select({ id: students.id, name: students.name, dob: students.dob, status: students.status, joinedOn: students.joinedOn })
        .from(students)
        .where(eq(students.parentUserId, req.user!.id))
        .orderBy(asc(students.name));
      res.json({ children: rows });
    }),
  );

  /** Upcoming sessions for the parent's children, with whether attendance can be marked right now. */
  r.get(
    '/schedule',
    ah(async (req, res) => {
      const s = await getSettings(db);
      const today = zonedNow(s.timezone).date;
      const q = parse(
        z.object({ from: dateStr.default(today), to: dateStr.optional(), studentId: z.coerce.number().int().positive().optional() }),
        req.query,
      );
      const to = q.to ?? addDays(q.from, 14);
      const now = new Date();

      const rows = await db
        .select({
          sessionId: classSessions.id,
          sessionDate: classSessions.sessionDate,
          sessionStatus: classSessions.status,
          cancelReason: classSessions.cancelReason,
          studentId: students.id,
          studentName: students.name,
          className: classes.name,
          instructorName: classes.instructorName,
          startTime: classes.startTime,
          endTime: classes.endTime,
          locationName: locations.name,
          attendanceStatus: attendance.status,
        })
        .from(classSessions)
        .innerJoin(classes, eq(classes.id, classSessions.classId))
        .innerJoin(
          enrolments,
          and(
            eq(enrolments.classId, classes.id),
            sql`${enrolments.startDate} <= ${classSessions.sessionDate}`,
            or(isNull(enrolments.endDate), sql`${enrolments.endDate} >= ${classSessions.sessionDate}`),
          ),
        )
        .innerJoin(students, eq(students.id, enrolments.studentId))
        .leftJoin(locations, eq(locations.id, classes.locationId))
        .leftJoin(attendance, and(eq(attendance.sessionId, classSessions.id), eq(attendance.studentId, students.id)))
        .where(
          and(
            eq(students.parentUserId, req.user!.id),
            eq(students.status, 'active'),
            gte(classSessions.sessionDate, q.from),
            lte(classSessions.sessionDate, to),
            q.studentId ? eq(students.id, q.studentId) : undefined,
          ),
        )
        .orderBy(asc(classSessions.sessionDate), asc(classes.startTime), asc(students.name));

      res.json({
        schedule: rows.map((x) => ({
          ...x,
          canMark:
            x.sessionStatus === 'scheduled' &&
            !x.attendanceStatus &&
            windowState({ sessionDate: x.sessionDate }, { startTime: x.startTime, endTime: x.endTime }, s, now) === 'open',
        })),
      });
    }),
  );

  r.get(
    '/attendance',
    ah(async (req, res) => {
      const s = await getSettings(db);
      const today = zonedNow(s.timezone).date;
      const q = parse(
        z.object({ studentId: z.coerce.number().int().positive(), from: dateStr.optional(), to: dateStr.optional() }),
        req.query,
      );
      const [student] = await db
        .select()
        .from(students)
        .where(and(eq(students.id, q.studentId), eq(students.parentUserId, req.user!.id)));
      if (!student) notFound('Student');
      const from = q.from ?? addDays(today, -90);
      const to = q.to && q.to < today ? q.to : today;

      // Every session the child was enrolled for in the range, with their mark (null = no record yet).
      const rows = await db
        .select({
          sessionId: classSessions.id,
          sessionDate: classSessions.sessionDate,
          className: classes.name,
          startTime: classes.startTime,
          sessionStatus: classSessions.status,
          status: attendance.status,
          source: attendance.source,
        })
        .from(enrolments)
        .innerJoin(
          classSessions,
          and(
            eq(classSessions.classId, enrolments.classId),
            sql`${classSessions.sessionDate} >= ${enrolments.startDate}`,
            sql`${classSessions.sessionDate} <= coalesce(${enrolments.endDate}, '9999-12-31')`,
            gte(classSessions.sessionDate, from),
            lte(classSessions.sessionDate, to),
          ),
        )
        .innerJoin(classes, eq(classes.id, classSessions.classId))
        .leftJoin(attendance, and(eq(attendance.sessionId, classSessions.id), eq(attendance.studentId, student.id)))
        .where(eq(enrolments.studentId, student.id))
        .orderBy(desc(classSessions.sessionDate), desc(classes.startTime));

      const counted = rows.filter((x) => x.sessionStatus === 'scheduled');
      const present = counted.filter((x) => x.status === 'present').length;
      res.json({
        student: { id: student.id, name: student.name },
        from,
        to,
        summary: {
          sessions: counted.length,
          present,
          percent: counted.length ? Math.round((present / counted.length) * 100) : null,
        },
        records: rows,
      });
    }),
  );

  r.post(
    '/attendance',
    ah(async (req, res) => {
      const body = parse(
        z.object({
          sessionId: z.number().int().positive(),
          studentId: z.number().int().positive(),
          latitude: z.number().min(-90).max(90),
          longitude: z.number().min(-180).max(180),
          accuracyM: z.number().min(0),
        }),
        req.body,
      );
      const s = await getSettings(db);
      const record = await markSelfAttendance(db, s, { ...body, userId: req.user!.id });
      res.status(201).json({ attendance: record });
    }),
  );

  r.get(
    '/invoices',
    ah(async (req, res) => {
      const ids = await childIds(req.user!.id);
      if (!ids.length) return res.json({ invoices: [] });
      const s = await getSettings(db);
      const today = zonedNow(s.timezone).date;
      const rows = await db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          studentId: students.id,
          studentName: students.name,
          issueDate: invoices.issueDate,
          dueDate: invoices.dueDate,
          totalPaise: invoices.totalPaise,
          amountPaidPaise: invoices.amountPaidPaise,
          status: invoices.status,
        })
        .from(invoices)
        .innerJoin(students, eq(students.id, invoices.studentId))
        .where(and(inArray(invoices.studentId, ids), sql`${invoices.status} <> 'void'`))
        .orderBy(desc(invoices.issueDate), desc(invoices.id));
      const list = rows.map((x) => ({
        ...x,
        balancePaise: x.totalPaise - x.amountPaidPaise,
        isOverdue: ['pending', 'partial'].includes(x.status) && x.dueDate < today,
      }));
      res.json({
        invoices: list,
        outstandingPaise: list.filter((x) => x.status !== 'paid').reduce((sum, x) => sum + x.balancePaise, 0),
      });
    }),
  );

  r.get(
    '/invoices/:id',
    ah(async (req, res) => {
      const data = await loadInvoice(ctx, idParam(req), { parentUserId: req.user!.id });
      if (!data || data.invoice.status === 'void') notFound('Invoice');
      res.json(data);
    }),
  );

  r.get(
    '/invoices/:id/pdf',
    ah(async (req, res) => {
      await sendInvoicePdfFor(ctx, res, idParam(req), { parentUserId: req.user!.id });
    }),
  );

  r.get(
    '/payments/:id/receipt',
    ah(async (req, res) => {
      await sendReceiptPdfFor(ctx, res, idParam(req), { parentUserId: req.user!.id });
    }),
  );

  r.get(
    '/events',
    ah(async (_req, res) => {
      const s = await getSettings(db);
      const today = zonedNow(s.timezone).date;
      const rows = await db.select().from(events).where(eq(events.isPublished, true)).orderBy(desc(events.eventDate));
      res.json({
        upcoming: rows.filter((e) => e.eventDate >= today).reverse(),
        past: rows.filter((e) => e.eventDate < today),
      });
    }),
  );

  r.get(
    '/awards',
    ah(async (req, res) => {
      const rows = await db
        .select({
          id: awards.id,
          title: awards.title,
          description: awards.description,
          awardedOn: awards.awardedOn,
          studentId: students.id,
          studentName: students.name,
          eventTitle: events.title,
        })
        .from(awards)
        .innerJoin(students, eq(students.id, awards.studentId))
        .leftJoin(events, eq(events.id, awards.eventId))
        .where(eq(students.parentUserId, req.user!.id))
        .orderBy(desc(awards.awardedOn));
      res.json({ awards: rows });
    }),
  );

  r.get(
    '/notifications',
    ah(async (req, res) => {
      const { limit, offset } = paging(req.query, 30);
      const rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, req.user!.id))
        .orderBy(desc(notifications.id))
        .limit(limit)
        .offset(offset);
      const [{ unread }] = await db
        .select({ unread: sql<number>`count(*)::int` })
        .from(notifications)
        .where(and(eq(notifications.userId, req.user!.id), isNull(notifications.readAt)));
      res.json({ notifications: rows, unread });
    }),
  );

  r.post(
    '/notifications/read-all',
    ah(async (req, res) => {
      await db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(eq(notifications.userId, req.user!.id), isNull(notifications.readAt)));
      res.json({ ok: true });
    }),
  );

  r.post(
    '/notifications/:id/read',
    ah(async (req, res) => {
      const id = idParam(req);
      const [row] = await db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(eq(notifications.id, id), eq(notifications.userId, req.user!.id)))
        .returning({ id: notifications.id });
      if (!row) throw new HttpError(404, 'Notification not found', 'NOT_FOUND');
      res.json({ ok: true });
    }),
  );

  return r;
}
