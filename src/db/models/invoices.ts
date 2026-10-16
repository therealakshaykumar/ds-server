import { date, index, integer, pgEnum, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt } from './common';
import { studentFeePlans } from './studentFeePlans';
import { students } from './students';

export const invoiceStatus = pgEnum('invoice_status', ['pending', 'partial', 'paid', 'void']);

export const invoices = pgTable(
  'invoices',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    invoiceNumber: text('invoice_number').notNull().unique(),
    studentId: integer('student_id')
      .notNull()
      .references(() => students.id),
    studentFeePlanId: integer('student_fee_plan_id').references(() => studentFeePlans.id),
    issueDate: date('issue_date', { mode: 'string' }).notNull(),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    periodStart: date('period_start', { mode: 'string' }),
    periodEnd: date('period_end', { mode: 'string' }),
    subtotalPaise: integer('subtotal_paise').notNull(),
    discountPaise: integer('discount_paise').notNull().default(0),
    totalPaise: integer('total_paise').notNull(),
    amountPaidPaise: integer('amount_paid_paise').notNull().default(0),
    status: invoiceStatus('status').notNull().default('pending'),
    notes: text('notes'),
    lastReminderOn: date('last_reminder_on', { mode: 'string' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('invoices_student_idx').on(t.studentId),
    index('invoices_status_due_idx').on(t.status, t.dueDate),
    // Makes automatic invoice generation idempotent per plan and period.
    unique('invoices_plan_period_uq').on(t.studentFeePlanId, t.periodStart),
  ],
);

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
export type InvoiceStatus = (typeof invoiceStatus.enumValues)[number];
