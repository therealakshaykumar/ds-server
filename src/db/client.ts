import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString, max: 10 });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
