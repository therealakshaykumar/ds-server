import { createApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db/client';

const config = loadConfig();
if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');

const { db, pool } = createDb(config.databaseUrl);
const app = createApp({ db, config });

const server = app.listen(config.port, () => {
  console.log(`DC API listening on :${config.port} (${config.env})`);
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
