import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { invoices } from './invoices';

export const invoiceItems = pgTable('invoice_items', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  invoiceId: integer('invoice_id')
    .notNull()
    .references(() => invoices.id, { onDelete: 'cascade' }),
  description: text('description').notNull(),
  quantity: integer('quantity').notNull().default(1),
  unitAmountPaise: integer('unit_amount_paise').notNull(),
  amountPaise: integer('amount_paise').notNull(),
});

export type InvoiceItem = typeof invoiceItems.$inferSelect;
export type NewInvoiceItem = typeof invoiceItems.$inferInsert;
