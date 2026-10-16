import { date, index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt } from './common';
import { events } from './events';
import { students } from './students';

export const awards = pgTable(
  'awards',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    studentId: integer('student_id')
      .notNull()
      .references(() => students.id),
    eventId: integer('event_id').references(() => events.id),
    title: text('title').notNull(),
    description: text('description'),
    awardedOn: date('awarded_on', { mode: 'string' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('awards_student_idx').on(t.studentId)],
);

export type Award = typeof awards.$inferSelect;
export type NewAward = typeof awards.$inferInsert;
