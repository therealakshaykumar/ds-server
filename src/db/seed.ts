import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config';
import { SETTING_DEFAULTS } from '../lib/settings';
import { createDb } from './client';
import { settings, users } from './schema';

/** Creates the first admin and default settings. Safe to run more than once. */
async function main() {
  const config = loadConfig();
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
  const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD in .env');
  if (ADMIN_PASSWORD.length < 8) throw new Error('ADMIN_PASSWORD must be at least 8 characters');

  const { db, pool } = createDb(config.databaseUrl);
  const email = ADMIN_EMAIL.trim().toLowerCase();
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) {
    console.log(`Admin ${email} already exists, leaving it unchanged.`);
  } else {
    await db.insert(users).values({
      role: 'admin',
      name: ADMIN_NAME ?? 'Admin',
      email,
      passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 10),
    });
    console.log(`Created admin ${email}`);
  }

  await db
    .insert(settings)
    .values(Object.entries(SETTING_DEFAULTS).map(([key, value]) => ({ key, value: String(value) })))
    .onConflictDoNothing();
  console.log('Default settings are in place.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
