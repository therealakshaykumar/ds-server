import { date, index, integer, pgEnum, pgTable } from 'drizzle-orm/pg-core';
import { createdAt } from './common';
import { feePlans } from './feePlans';
import { students } from './students';

export const discountType = pgEnum('discount_type', ['percent', 'flat']);
export const planStatus = pgEnum('plan_status', ['active', 'paused', 'ended']);

export const studentFeePlans = pgTable(
  'student_fee_plans',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    studentId: integer('student_id')
      .notNull()
      .references(() => students.id),
    feePlanId: integer('fee_plan_id')
      .notNull()
      .references(() => feePlans.id),
    amountOverridePaise: integer('amount_override_paise'),
    /** percent: whole percent (0-100). flat: paise. */
    discountType: discountType('discount_type'),
    discountValue: integer('discount_value'),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }),
    nextInvoiceDate: date('next_invoice_date', { mode: 'string' }).notNull(),
    status: planStatus('status').notNull().default('active'),
    createdAt: createdAt(),
  },
  (t) => [index('student_fee_plans_student_idx').on(t.studentId), index('student_fee_plans_next_idx').on(t.status, t.nextInvoiceDate)],
);

export type StudentFeePlan = typeof studentFeePlans.$inferSelect;
export type NewStudentFeePlan = typeof studentFeePlans.$inferInsert;
export type DiscountType = (typeof discountType.enumValues)[number];
export type PlanStatus = (typeof planStatus.enumValues)[number];
