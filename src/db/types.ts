import type { PgDatabase } from 'drizzle-orm/pg-core';
import type * as schema from './schema';

/** Works for both a node-postgres/pglite database and a transaction handle. */
export type Db = PgDatabase<any, typeof schema>;
