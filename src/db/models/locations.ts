import { boolean, doublePrecision, integer, pgTable, text } from 'drizzle-orm/pg-core';

export const locations = pgTable('locations', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  latitude: doublePrecision('latitude').notNull(),
  longitude: doublePrecision('longitude').notNull(),
  radiusM: integer('radius_m').notNull().default(100),
  isActive: boolean('is_active').notNull().default(true),
});

export type Location = typeof locations.$inferSelect;
export type NewLocation = typeof locations.$inferInsert;
