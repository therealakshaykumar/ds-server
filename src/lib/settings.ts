import { inArray } from 'drizzle-orm';
import type { Db } from '../db/types';
import { settings } from '../db/schema';

export interface Settings {
  schoolName: string;
  timezone: string;
  invoicePrefix: string;
  invoiceDueDays: number;
  attendanceOpenBeforeMin: number;
  attendanceCloseAfterMin: number;
  maxGpsAccuracyM: number;
  sessionDaysAhead: number;
}

export const SETTING_DEFAULTS: Settings = {
  schoolName: 'Dance School',
  timezone: 'Asia/Kolkata',
  invoicePrefix: 'INV',
  invoiceDueDays: 10,
  attendanceOpenBeforeMin: 10,
  attendanceCloseAfterMin: 15,
  maxGpsAccuracyM: 100,
  sessionDaysAhead: 30,
};

export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS) as (keyof Settings)[];

export async function getSettings(db: Db): Promise<Settings> {
  const rows = await db.select().from(settings).where(inArray(settings.key, SETTING_KEYS));
  const out: Record<string, string | number> = { ...SETTING_DEFAULTS };
  for (const row of rows) {
    const def = SETTING_DEFAULTS[row.key as keyof Settings];
    out[row.key] = typeof def === 'number' ? Number(row.value) : row.value;
  }
  return out as unknown as Settings;
}
