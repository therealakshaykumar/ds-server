import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/types';
import { classes, classSessions } from '../db/schema';
import { addDays, weekdayOf, zonedNow } from '../lib/dates';
import { getSettings } from '../lib/settings';

/**
 * Creates the dated session rows for active classes from today up to `sessionDaysAhead`.
 * Safe to run repeatedly: existing (class, date) pairs are skipped.
 */
export async function generateSessions(db: Db, opts: { classId?: number; today?: string } = {}) {
  const s = await getSettings(db);
  const today = opts.today ?? zonedNow(s.timezone).date;
  const last = addDays(today, s.sessionDaysAhead);

  const activeClasses = await db
    .select()
    .from(classes)
    .where(opts.classId ? and(eq(classes.isActive, true), eq(classes.id, opts.classId)) : eq(classes.isActive, true));

  const rows: { classId: number; sessionDate: string }[] = [];
  for (const c of activeClasses) {
    for (let d = today; d <= last; d = addDays(d, 1)) {
      if (weekdayOf(d) === c.weekday) rows.push({ classId: c.id, sessionDate: d });
    }
  }

  let created = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const inserted = await db
      .insert(classSessions)
      .values(rows.slice(i, i + 500))
      .onConflictDoNothing()
      .returning({ id: classSessions.id });
    created += inserted.length;
  }
  return { created };
}
