import { date, index, integer, pgTable } from 'drizzle-orm/pg-core';
import { classes } from './classes';
import { students } from './students';

export const enrolments = pgTable(
  'enrolments',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    studentId: integer('student_id')
      .notNull()
      .references(() => students.id),
    classId: integer('class_id')
      .notNull()
      .references(() => classes.id),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }),
  },
  (t) => [index('enrolments_student_idx').on(t.studentId), index('enrolments_class_idx').on(t.classId)],
);

export type Enrolment = typeof enrolments.$inferSelect;
export type NewEnrolment = typeof enrolments.$inferInsert;
