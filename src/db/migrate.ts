import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../config';
import { createDb } from './client';

async function main() {
  const config = loadConfig();
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
  const { db, pool } = createDb(config.databaseUrl);
  await migrate(db, { migrationsFolder: path.join(__dirname, '../../drizzle') });
  await pool.end();
  console.log('Migrations applied.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
