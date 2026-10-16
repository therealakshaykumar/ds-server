import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(4100),
  DATABASE_URL: z.string().optional(),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_DAYS: z.coerce.number().int().positive().default(7),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  COOKIE_SAMESITE: z.enum(['lax', 'none', 'strict']).default('lax'),
  JOB_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('Dance School <no-reply@example.com>'),
});

export interface Config {
  env: 'development' | 'production' | 'test';
  port: number;
  databaseUrl?: string;
  jwtSecret: string;
  jwtExpiresDays: number;
  corsOrigins: string[];
  cookieSameSite: 'lax' | 'none' | 'strict';
  jobSecret?: string;
  resendApiKey?: string;
  emailFrom: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${problems}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL || undefined,
    jwtSecret: e.JWT_SECRET,
    jwtExpiresDays: e.JWT_EXPIRES_DAYS,
    corsOrigins: e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    cookieSameSite: e.COOKIE_SAMESITE,
    jobSecret: e.JOB_SECRET || undefined,
    resendApiKey: e.RESEND_API_KEY || undefined,
    emailFrom: e.EMAIL_FROM,
  };
}
