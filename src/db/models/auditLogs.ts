import { index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt } from './common';
import { users } from './users';

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    actorUserId: integer('actor_user_id').references(() => users.id),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    action: text('action').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_logs_entity_idx').on(t.entity, t.entityId)],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
