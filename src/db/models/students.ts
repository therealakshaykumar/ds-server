import { sql } from 'drizzle-orm';
import { date, index, integer, pgEnum, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt } from './common';
import { users } from './users';

export const studentStatus = pgEnum('student_status', ['active', 'inactive']);

export const students = pgTable(
  'students',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    parentUserId: integer('parent_user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    dob: date('dob', { mode: 'string' }),
    joinedOn: date('joined_on', { mode: 'string' }).notNull().default(sql`current_date`),
    status: studentStatus('status').notNull().default('active'),
    notes: text('notes'),
    createdAt: createdAt(),
  },
  (t) => [index('students_parent_idx').on(t.parentUserId)],
);

export type Student = typeof students.$inferSelect;
export type NewStudent = typeof students.$inferInsert;
export type StudentStatus = (typeof studentStatus.enumValues)[number];
