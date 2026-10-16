import { boolean, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt } from './common';

export const feePlans = pgTable('fee_plans', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  amountPaise: integer('amount_paise').notNull(),
  /** Billing period in months (1, 3, 6, 12, ...). Null for one-time plans. */
  intervalMonths: integer('interval_months'),
  isOneTime: boolean('is_one_time').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
});

export type FeePlan = typeof feePlans.$inferSelect;
export type NewFeePlan = typeof feePlans.$inferInsert;
