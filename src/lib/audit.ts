import type { Request } from 'express';
import type { Db } from '../db/types';
import { auditLogs } from '../db/schema';

export async function audit(
  db: Db,
  req: Request | null,
  entity: string,
  entityId: number | string | null,
  action: string,
  before?: unknown,
  after?: unknown,
) {
  await db.insert(auditLogs).values({
    actorUserId: req?.user?.id ?? null,
    entity,
    entityId: entityId === null ? null : String(entityId),
    action,
    before: before ?? null,
    after: after ?? null,
  });
}
