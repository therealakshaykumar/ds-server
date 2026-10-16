import { randomUUID } from 'node:crypto';
import { and, eq, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/types';
import { feePlans, invoiceItems, invoices, studentFeePlans, students } from '../db/schema';
import { addDays, addMonths, zonedNow } from '../lib/dates';
import { computeDiscount } from '../lib/money';
import { type Ctx, notifyUsers } from '../lib/notify';
import { getSettings } from '../lib/settings';

export async function invoiceNumberFor(db: Db, invoiceId: number, issueDate: string): Promise<string> {
  const s = await getSettings(db);
  return `${s.invoicePrefix}-${issueDate.slice(0, 4)}-${String(invoiceId).padStart(5, '0')}`;
}

/**
 * Creates invoices for every active student fee plan whose next_invoice_date has arrived.
 * Catches up on missed periods (up to 24 per plan per run) and is idempotent per plan and period.
 */
export async function generateInvoices(ctx: Ctx, opts: { today?: string; studentFeePlanId?: number } = {}) {
  const { db } = ctx;
  const s = await getSettings(db);
  const today = opts.today ?? zonedNow(s.timezone).date;

  const due = await db
    .select({ sfp: studentFeePlans, plan: feePlans, student: students })
    .from(studentFeePlans)
    .innerJoin(feePlans, eq(feePlans.id, studentFeePlans.feePlanId))
    .innerJoin(students, eq(students.id, studentFeePlans.studentId))
    .where(
      and(
        eq(studentFeePlans.status, 'active'),
        lte(studentFeePlans.nextInvoiceDate, today),
        eq(students.status, 'active'),
        opts.studentFeePlanId ? eq(studentFeePlans.id, opts.studentFeePlanId) : undefined,
      ),
    );

  const createdIds: number[] = [];

  for (const { sfp, plan, student } of due) {
    let next = sfp.nextInvoiceDate;
    for (let guard = 0; guard < 24 && next <= today && (!sfp.endDate || next <= sfp.endDate); guard++) {
      const oneTime = plan.isOneTime || !plan.intervalMonths;
      const periodStart = next;
      const periodEnd = oneTime ? next : addDays(addMonths(next, plan.intervalMonths!), -1);
      const afterNext = oneTime ? next : addMonths(next, plan.intervalMonths!);

      const subtotal = sfp.amountOverridePaise ?? plan.amountPaise;
      const discount = computeDiscount(subtotal, sfp.discountType, sfp.discountValue);

      const invoiceId = await db.transaction(async (tx) => {
        const [inv] = await tx
          .insert(invoices)
          .values({
            invoiceNumber: `tmp-${randomUUID()}`,
            studentId: sfp.studentId,
            studentFeePlanId: sfp.id,
            issueDate: today,
            dueDate: addDays(today, s.invoiceDueDays),
            periodStart,
            periodEnd,
            subtotalPaise: subtotal,
            discountPaise: discount,
            totalPaise: subtotal - discount,
          })
          .onConflictDoNothing()
          .returning({ id: invoices.id });

        let id: number | null = null;
        if (inv) {
          id = inv.id;
          await tx
            .update(invoices)
            .set({ invoiceNumber: await invoiceNumberFor(tx, inv.id, today) })
            .where(eq(invoices.id, inv.id));
          await tx.insert(invoiceItems).values({
            invoiceId: inv.id,
            description: oneTime ? plan.name : `${plan.name} (${periodStart} to ${periodEnd})`,
            quantity: 1,
            unitAmountPaise: subtotal,
            amountPaise: subtotal,
          });
        }

        const finished = oneTime || (sfp.endDate !== null && afterNext > sfp.endDate);
        await tx
          .update(studentFeePlans)
          .set({ nextInvoiceDate: finished && oneTime ? next : afterNext, status: finished ? 'ended' : 'active' })
          .where(eq(studentFeePlans.id, sfp.id));
        return id;
      });

      if (invoiceId) {
        createdIds.push(invoiceId);
        await notifyUsers(
          ctx,
          [student.parentUserId],
          'New invoice',
          `A new invoice for ${student.name} (${plan.name}) has been generated. Please check the Fees section.`,
        );
      }
      next = afterNext;
      if (oneTime) break;
    }
  }
  return { created: createdIds.length, invoiceIds: createdIds };
}

export const balanceSql = sql<number>`(${invoices.totalPaise} - ${invoices.amountPaidPaise})`;
