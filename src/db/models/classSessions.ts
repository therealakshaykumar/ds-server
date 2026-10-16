import { date, index, integer, pgEnum, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { classes } from './classes';

export const sessionStatus = pgEnum('session_status', ['scheduled', 'cancelled']);

export const classSessions = pgTable(
  'class_sessions',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    classId: integer('class_id')
      .notNull()
      .references(() => classes.id),
    sessionDate: date('session_date', { mode: 'string' }).notNull(),
    status: sessionStatus('status').notNull().default('scheduled'),
    cancelReason: text('cancel_reason'),
  },
  (t) => [unique('class_sessions_class_date_uq').on(t.classId, t.sessionDate), index('class_sessions_date_idx').on(t.sessionDate)],
);

export type ClassSession = typeof classSessions.$inferSelect;
export type NewClassSession = typeof classSessions.$inferInsert;
export type SessionStatus = (typeof sessionStatus.enumValues)[number];
