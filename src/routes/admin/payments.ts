import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { invoices, payments, students, users } from '../../db/schema';
import { audit } from '../../lib/audit';
import { zonedNow } from '../../lib/dates';
import { ah, HttpError, idParam, notFound, paging, parse } from '../../lib/http';
import { formatInr, invoiceStatusFor } from '../../lib/money';
import { type Ctx, notifyUsers } from '../../lib/notify';
import { sendReceiptPdf } from '../../lib/pdf';
import { dateStr, paise } from '../../lib/schemas';
import { getSettings } from '../../lib/settings';

export async function sendReceiptPdfFor(
  ctx: Ctx,
  res: import('express').Response,
  paymentId: number,
  opts: { parentUserId?: number } = {},
) {
  const { db } = ctx;
  const [row] = await db
    .select({ payment: payments, invoice: invoices, studentName: students.name, parentName: users.name })
    .from(payments)
    .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
    .innerJoin(students, eq(students.id, invoices.studentId))
    .innerJoin(users, eq(users.id, students.parentUserId))
    .where(and(eq(payments.id, paymentId), opts.parentUserId ? eq(students.parentUserId, opts.parentUserId) : undefined));
  if (!row) notFound('Payment');
  const s = await getSettings(db);
  sendReceiptPdf(res, {
    schoolName: s.schoolName,
    receiptNumber: row.payment.receiptNumber,
    paidOn: row.payment.paidOn,
    invoiceNumber: row.invoice.invoiceNumber,
    studentName: row.studentName,
    parentName: row.parentName,
    method: row.payment.method,
    reference: row.payment.reference,
    amountPaise: row.payment.amountPaise,
    invoiceTotalPaise: row.invoice.totalPaise,
    invoicePaidPaise: row.invoice.amountPaidPaise,
  });
}

export function paymentsRouter(ctx: Ctx): Router {
  const { db } = ctx;
  const r = Router();

  r.get(
    '/',
    ah(async (req, res) => {
      const q = parse(
        z.object({
          invoiceId: z.coerce.number().int().positive().optional(),
          method: z.enum(['cash', 'upi', 'card', 'bank', 'other']).optional(),
          from: dateStr.optional(),
          to: dateStr.optional(),
        }),
        req.query,
      );
      const { limit, offset } = paging(req.query, 100);
      const rows = await db
        .select({
          id: payments.id,
          receiptNumber: payments.receiptNumber,
          invoiceId: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          studentName: students.name,
          amountPaise: payments.amountPaise,
          method: payments.method,
          reference: payments.reference,
          paidOn: payments.paidOn,
        })
        .from(payments)
        .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
        .innerJoin(students, eq(students.id, invoices.studentId))
        .where(
          and(
            q.invoiceId ? eq(payments.invoiceId, q.invoiceId) : undefined,
            q.method ? eq(payments.method, q.method) : undefined,
            q.from ? gte(payments.paidOn, q.from) : undefined,
            q.to ? lte(payments.paidOn, q.to) : undefined,
          ),
        )
        .orderBy(desc(payments.paidOn), desc(payments.id))
        .limit(limit)
        .offset(offset);
      res.json({ payments: rows });
    }),
  );

  /** Record a payment against an invoice (cash, UPI, card, bank...). Partial payments are allowed. */
  r.post(
    '/',
    ah(async (req, res) => {
      const body = parse(
        z.object({
          invoiceId: z.number().int().positive(),
          amountPaise: paise.refine((v) => v > 0, 'Amount must be greater than zero'),
          method: z.enum(['cash', 'upi', 'card', 'bank', 'other']),
          reference: z.string().trim().optional(),
          paidOn: dateStr.optional(),
        }),
        req.body,
      );
      const s = await getSettings(db);
      const paidOn = body.paidOn ?? zonedNow(s.timezone).date;

      const result = await db.transaction(async (tx) => {
        // Lock the invoice so two simultaneous payments cannot overpay it.
        const [inv] = await tx.select().from(invoices).where(eq(invoices.id, body.invoiceId)).for('update');
        if (!inv) notFound('Invoice');
        if (inv.status === 'void') throw new HttpError(409, 'Invoice is void', 'CONFLICT');
        const balance = inv.totalPaise - inv.amountPaidPaise;
        if (body.amountPaise > balance) {
          throw new HttpError(409, `Amount exceeds the balance of ${formatInr(balance)}`, 'OVERPAYMENT', { balancePaise: balance });
        }
        const [pay] = await tx
          .insert(payments)
          .values({
            invoiceId: inv.id,
            amountPaise: body.amountPaise,
            method: body.method,
            reference: body.reference,
            paidOn,
            receiptNumber: `tmp-${randomUUID()}`,
            recordedBy: req.user!.id,
          })
          .returning();
        const [numbered] = await tx
          .update(payments)
          .set({ receiptNumber: `RCT-${paidOn.slice(0, 4)}-${String(pay.id).padStart(5, '0')}` })
          .where(eq(payments.id, pay.id))
          .returning();
        const newPaid = inv.amountPaidPaise + body.amountPaise;
        const [updatedInv] = await tx
          .update(invoices)
          .set({ amountPaidPaise: newPaid, status: invoiceStatusFor(inv.totalPaise, newPaid) })
          .where(eq(invoices.id, inv.id))
          .returning();
        await audit(tx, req, 'payment', pay.id, 'create', null, numbered);
        return { payment: numbered, invoice: updatedInv };
      });

      const [student] = await db
        .select({ parentUserId: students.parentUserId, name: students.name })
        .from(students)
        .where(eq(students.id, result.invoice.studentId));
      await notifyUsers(
        ctx,
        [student.parentUserId],
        'Payment received',
        `We received ${formatInr(body.amountPaise)} for ${student.name} (invoice ${result.invoice.invoiceNumber}). Receipt: ${result.payment.receiptNumber}.`,
      );
      res.status(201).json(result);
    }),
  );

  /** Remove a mistaken payment; the invoice balance and status are recalculated. */
  r.delete(
    '/:id',
    ah(async (req, res) => {
      const id = idParam(req);
      const result = await db.transaction(async (tx) => {
        const [pay] = await tx.select().from(payments).where(eq(payments.id, id));
        if (!pay) notFound('Payment');
        const [inv] = await tx.select().from(invoices).where(eq(invoices.id, pay.invoiceId)).for('update');
        await tx.delete(payments).where(eq(payments.id, id));
        const newPaid = Math.max(inv.amountPaidPaise - pay.amountPaise, 0);
        const [updatedInv] = await tx
          .update(invoices)
          .set({ amountPaidPaise: newPaid, status: inv.status === 'void' ? 'void' : invoiceStatusFor(inv.totalPaise, newPaid) })
          .where(eq(invoices.id, inv.id))
          .returning();
        await audit(tx, req, 'payment', id, 'delete', pay, null);
        return updatedInv;
      });
      res.json({ invoice: result });
    }),
  );

  r.get(
    '/:id/receipt',
    ah(async (req, res) => {
      await sendReceiptPdfFor(ctx, res, idParam(req));
    }),
  );

  return r;
}
