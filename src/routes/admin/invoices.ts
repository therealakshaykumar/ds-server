import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { invoiceItems, invoices, payments, students, users } from '../../db/schema';
import { audit } from '../../lib/audit';
import { addDays, zonedNow } from '../../lib/dates';
import { ah, HttpError, idParam, notFound, paging, parse } from '../../lib/http';
import { computeDiscount } from '../../lib/money';
import { type Ctx, notifyUsers } from '../../lib/notify';
import { sendInvoicePdf } from '../../lib/pdf';
import { dateStr, paise } from '../../lib/schemas';
import { getSettings } from '../../lib/settings';
import { invoiceNumberFor } from '../../services/invoices';

/** Loads an invoice with its student, parent, items and payments. Shared with the parent-facing routes. */
export async function loadInvoice(ctx: Ctx, id: number, opts: { parentUserId?: number } = {}) {
  const { db } = ctx;
  const [row] = await db
    .select({
      invoice: invoices,
      studentName: students.name,
      parentUserId: students.parentUserId,
      parentName: users.name,
    })
    .from(invoices)
    .innerJoin(students, eq(students.id, invoices.studentId))
    .innerJoin(users, eq(users.id, students.parentUserId))
    .where(and(eq(invoices.id, id), opts.parentUserId ? eq(students.parentUserId, opts.parentUserId) : undefined));
  if (!row) return null;
  const items = await db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, id)).orderBy(invoiceItems.id);
  const paymentRows = await db.select().from(payments).where(eq(payments.invoiceId, id)).orderBy(payments.id);
  const s = await getSettings(db);
  const today = zonedNow(s.timezone).date;
  const balance = row.invoice.totalPaise - row.invoice.amountPaidPaise;
  return {
    ...row,
    items,
    payments: paymentRows,
    balancePaise: balance,
    isOverdue: ['pending', 'partial'].includes(row.invoice.status) && row.invoice.dueDate < today,
    schoolName: s.schoolName,
  };
}

export async function sendInvoicePdfFor(
  ctx: Ctx,
  res: import('express').Response,
  id: number,
  opts: { parentUserId?: number } = {},
) {
  const data = await loadInvoice(ctx, id, opts);
  if (!data) notFound('Invoice');
  const i = data.invoice;
  sendInvoicePdf(res, {
    schoolName: data.schoolName,
    invoiceNumber: i.invoiceNumber,
    issueDate: i.issueDate,
    dueDate: i.dueDate,
    status: i.status,
    studentName: data.studentName,
    parentName: data.parentName,
    periodStart: i.periodStart,
    periodEnd: i.periodEnd,
    items: data.items,
    subtotalPaise: i.subtotalPaise,
    discountPaise: i.discountPaise,
    totalPaise: i.totalPaise,
    amountPaidPaise: i.amountPaidPaise,
    notes: i.notes,
  });
}

export function invoicesRouter(ctx: Ctx): Router {
  const { db } = ctx;
  const r = Router();

  r.get(
    '/',
    ah(async (req, res) => {
      const q = parse(
        z.object({
          status: z.enum(['pending', 'partial', 'paid', 'void']).optional(),
          studentId: z.coerce.number().int().positive().optional(),
          from: dateStr.optional(),
          to: dateStr.optional(),
          overdue: z.enum(['true', 'false']).optional(),
        }),
        req.query,
      );
      const { limit, offset } = paging(req.query);
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
          balancePaise: sql<number>`(${invoices.totalPaise} - ${invoices.amountPaidPaise})`,
          status: invoices.status,
        })
        .from(invoices)
        .innerJoin(students, eq(students.id, invoices.studentId))
        .where(
          and(
            q.status ? eq(invoices.status, q.status) : undefined,
            q.studentId ? eq(invoices.studentId, q.studentId) : undefined,
            q.from ? gte(invoices.issueDate, q.from) : undefined,
            q.to ? lte(invoices.issueDate, q.to) : undefined,
            q.overdue === 'true' ? and(inArray(invoices.status, ['pending', 'partial']), lte(invoices.dueDate, addDays(today, -1))) : undefined,
          ),
        )
        .orderBy(desc(invoices.issueDate), desc(invoices.id))
        .limit(limit)
        .offset(offset);
      res.json({ invoices: rows });
    }),
  );

  /** Manual one-off invoice (e.g. admission fee, costume). */
  r.post(
    '/',
    ah(async (req, res) => {
      const body = parse(
        z.object({
          studentId: z.number().int().positive(),
          issueDate: dateStr.optional(),
          dueDate: dateStr.optional(),
          items: z
            .array(z.object({ description: z.string().trim().min(1), quantity: z.number().int().min(1).default(1), unitAmountPaise: paise }))
            .min(1),
          discountType: z.enum(['percent', 'flat']).optional(),
          discountValue: z.number().int().min(0).optional(),
          notes: z.string().optional(),
        }),
        req.body,
      );
      const s = await getSettings(db);
      const issueDate = body.issueDate ?? zonedNow(s.timezone).date;
      const dueDate = body.dueDate ?? addDays(issueDate, s.invoiceDueDays);
      if (dueDate < issueDate) throw new HttpError(400, 'dueDate cannot be before issueDate', 'VALIDATION');

      const [student] = await db.select().from(students).where(eq(students.id, body.studentId));
      if (!student) notFound('Student');

      const items = body.items.map((i) => ({ ...i, amountPaise: i.quantity * i.unitAmountPaise }));
      const subtotal = items.reduce((sum, i) => sum + i.amountPaise, 0);
      const discount = computeDiscount(subtotal, body.discountType, body.discountValue);

      const created = await db.transaction(async (tx) => {
        const [inv] = await tx
          .insert(invoices)
          .values({
            invoiceNumber: `tmp-${randomUUID()}`,
            studentId: body.studentId,
            issueDate,
            dueDate,
            subtotalPaise: subtotal,
            discountPaise: discount,
            totalPaise: subtotal - discount,
            notes: body.notes,
          })
          .returning();
        const number = await invoiceNumberFor(tx, inv.id, issueDate);
        const [numbered] = await tx.update(invoices).set({ invoiceNumber: number }).where(eq(invoices.id, inv.id)).returning();
        await tx.insert(invoiceItems).values(items.map((i) => ({ ...i, invoiceId: inv.id })));
        await audit(tx, req, 'invoice', inv.id, 'create', null, numbered);
        return numbered;
      });
      await notifyUsers(ctx, [student.parentUserId], 'New invoice', `Invoice ${created.invoiceNumber} for ${student.name} has been generated.`);
      res.status(201).json({ invoice: created });
    }),
  );

  r.get(
    '/:id',
    ah(async (req, res) => {
      const data = await loadInvoice(ctx, idParam(req));
      if (!data) notFound('Invoice');
      res.json(data);
    }),
  );

  r.get(
    '/:id/pdf',
    ah(async (req, res) => {
      await sendInvoicePdfFor(ctx, res, idParam(req));
    }),
  );

  r.post(
    '/:id/void',
    ah(async (req, res) => {
      const id = idParam(req);
      const [before] = await db.select().from(invoices).where(eq(invoices.id, id));
      if (!before) notFound('Invoice');
      if (before.amountPaidPaise > 0) {
        throw new HttpError(409, 'Invoice has payments. Remove the payments before voiding.', 'CONFLICT');
      }
      const [updated] = await db.update(invoices).set({ status: 'void' }).where(eq(invoices.id, id)).returning();
      await audit(db, req, 'invoice', id, 'void', before, updated);
      res.json({ invoice: updated });
    }),
  );

  return r;
}
