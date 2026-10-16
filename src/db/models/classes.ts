import { boolean, integer, pgTable, text, time } from 'drizzle-orm/pg-core';
import { createdAt } from './common';
import { locations } from './locations';

export const classes = pgTable('classes', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  instructorName: text('instructor_name'),
  /** 0 = Sunday ... 6 = Saturday */
  weekday: integer('weekday').notNull(),
  startTime: time('start_time').notNull(),
  endTime: time('end_time').notNull(),
  locationId: integer('location_id').references(() => locations.id),
  capacity: integer('capacity'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
});

export type Class = typeof classes.$inferSelect;
export type NewClass = typeof classes.$inferInsert;
