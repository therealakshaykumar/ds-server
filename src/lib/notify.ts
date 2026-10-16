import { inArray } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/types';
import { notifications, users } from '../db/schema';

export interface Ctx {
  db: Db;
  config: Config;
}

async function sendEmail(config: Config, to: string, subject: string, text: string) {
  if (!config.resendApiKey) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.emailFrom, to, subject, text }),
    });
    if (!res.ok) console.warn(`Email to ${to} failed: ${res.status} ${await res.text()}`);
  } catch (err) {
    console.warn(`Email to ${to} failed:`, err);
  }
}

/** Creates an in-app notification per user and, when configured, emails them. Never throws. */
export async function notifyUsers(ctx: Ctx, userIds: number[], title: string, body: string) {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  try {
    await ctx.db.insert(notifications).values(ids.map((userId) => ({ userId, title, body })));
    if (ctx.config.resendApiKey) {
      const recipients = await ctx.db.select({ email: users.email }).from(users).where(inArray(users.id, ids));
      for (const r of recipients) await sendEmail(ctx.config, r.email, title, body);
    }
  } catch (err) {
    console.warn('notifyUsers failed:', err);
  }
}
