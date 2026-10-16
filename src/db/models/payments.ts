import { date, index, integer, pgEnum, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt } from './common';
import { invoices } from './invoices';
import { users } from './users';

export const paymentMethod = pgEnum('payment_method', ['cash', 'upi', 'card', 'bank', 'other']);

export const payments = pgTable(
  'payments',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    invoiceId: integer('invoice_id')
      .notNull()
      .references(() => invoices.id),
    amountPaise: integer('amount_paise').notNull(),
    method: paymentMethod('method').notNull(),
    reference: text('reference'),
    paidOn: date('paid_on', { mode: 'string' }).notNull(),
    receiptNumber: text('receipt_number').notNull().unique(),
    recordedBy: integer('recorded_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('payments_invoice_idx').on(t.invoiceId)],
);

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type PaymentMethod = (typeof paymentMethod.enumValues)[number];
