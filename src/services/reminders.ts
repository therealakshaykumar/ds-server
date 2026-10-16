import { and, eq, inArray, or, isNull, lt } from 'drizzle-orm';
import { invoices, students } from '../db/schema';
import { daysBetween, zonedNow } from '../lib/dates';
import { formatInr } from '../lib/money';
import { type Ctx, notifyUsers } from '../lib/notify';
import { getSettings } from '../lib/settings';

/**
 * Reminder schedule for unpaid invoices: 3 days before the due date, on the due date,
 * the day after, then weekly. Each invoice is reminded at most once per day.
 */
export function shouldRemind(today: string, dueDate: string, lastReminderOn: string | null): boolean {
  if (lastReminderOn === today) return false;
  const overdueBy = daysBetween(dueDate, today);
  if (overdueBy === -3 || overdueBy === 0 || overdueBy === 1) return true;
  return overdueBy > 1 && (overdueBy - 1) % 7 === 0;
}

export async function sendInvoiceReminders(ctx: Ctx, opts: { today?: string } = {}) {
  const { db } = ctx;
  const s = await getSettings(db);
  const today = opts.today ?? zonedNow(s.timezone).date;

  const open = await db
    .select({ invoice: invoices, student: students })
    .from(invoices)
    .innerJoin(students, eq(students.id, invoices.studentId))
    .where(
      and(
        inArray(invoices.status, ['pending', 'partial']),
        or(isNull(invoices.lastReminderOn), lt(invoices.lastReminderOn, today)),
      ),
    );

  let sent = 0;
  for (const { invoice, student } of open) {
    if (!shouldRemind(today, invoice.dueDate, invoice.lastReminderOn)) continue;
    const balance = invoice.totalPaise - invoice.amountPaidPaise;
    const overdueBy = daysBetween(invoice.dueDate, today);
    const when =
      overdueBy < 0 ? `is due on ${invoice.dueDate}` : overdueBy === 0 ? 'is due today' : `was due on ${invoice.dueDate}`;
    await notifyUsers(
      ctx,
      [student.parentUserId],
      overdueBy > 0 ? 'Fee payment overdue' : 'Fee payment reminder',
      `Invoice ${invoice.invoiceNumber} for ${student.name} ${when}. Balance: ${formatInr(balance)}.`,
    );
    await db.update(invoices).set({ lastReminderOn: today }).where(eq(invoices.id, invoice.id));
    sent++;
  }
  return { sent };
}
