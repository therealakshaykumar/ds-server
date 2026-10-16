import { z } from 'zod';
import { DATE_RE, TIME_RE } from './dates';

export const dateStr = z.string().regex(DATE_RE, 'Use YYYY-MM-DD');
export const timeStr = z.string().regex(TIME_RE, 'Use HH:MM');
export const idNum = z.coerce.number().int().positive();
export const paise = z.number().int().min(0).max(100_000_000);
export const email = z.string().trim().toLowerCase().pipe(z.email());
export const password = z.string().min(8, 'Password must be at least 8 characters').max(128);

export const dateRange = z.object({ from: dateStr.optional(), to: dateStr.optional() });
