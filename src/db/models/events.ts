import { boolean, date, integer, pgTable, text, time } from 'drizzle-orm/pg-core';
import { createdAt } from './common';

export const events = pgTable('events', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  title: text('title').notNull(),
  description: text('description'),
  eventDate: date('event_date', { mode: 'string' }).notNull(),
  startTime: time('start_time'),
  venue: text('venue'),
  isPublished: boolean('is_published').notNull().default(true),
  createdAt: createdAt(),
});

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
