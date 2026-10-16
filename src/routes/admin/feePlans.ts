import { and, asc, desc, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { feePlans, studentFeePlans, students } from '../../db/schema';
import { audit } from '../../lib/audit';
import { zonedNow } from '../../lib/dates';
import { ah, HttpError, idParam, notFound, parse } from '../../lib/http';
import type { Ctx } from '../../lib/notify';
import { dateStr, paise } from '../../lib/schemas';
import { getSettings } from '../../lib/settings';
import { generateInvoices } from '../../services/invoices';

const planBody = z
  .object({
    name: z.string().trim().min(1),
    amountPaise: paise,
    intervalMonths: z.number().int().min(1).max(60).nullable().optional(),
    isOneTime: z.boolean().default(false),
    isActive: z.boolean().optional(),
  })
  .refine((b) => b.isOneTime || b.intervalMonths, { message: 'intervalMonths is required unless the plan is one-time', path: ['intervalMonths'] });

const assignmentBody = z.object({
  amountOverridePaise: paise.nullable().optional(),
  discountType: z.enum(['percent', 'flat']).nullable().optional(),
  discountValue: z.number().int().min(0).nullable().optional(),
  endDate: dateStr.nullable().optional(),
});

function checkDiscount(type: string | null | undefined, value: number | null | undefined) {
  if (type === 'percent' && value !== null && value !== undefined && value > 100) {
    throw new HttpError(400, 'Percent discount cannot exceed 100', 'VALIDATION');
  }
}

export function feePlansRouter({ db }: Ctx): Router {
  const r = Router();

  r.get(
    '/',
    ah(async (req, res) => {
      const all = req.query.includeInactive === 'true';
      const rows = await db
        .select()
        .from(feePlans)
        .where(all ? undefined : eq(feePlans.isActive, true))
        .orderBy(asc(feePlans.name));
      res.json({ feePlans: rows });
    }),
  );

  r.post(
    '/',
    ah(async (req, res) => {
      const body = parse(planBody, req.body);
      const [created] = await db
        .insert(feePlans)
        .values({ ...body, intervalMonths: body.isOneTime ? null : body.intervalMonths })
        .returning();
      await audit(db, req, 'fee_plan', created.id, 'create', null, created);
      res.status(201).json({ feePlan: created });
    }),
  );

  /** Changing a plan's amount affects future invoices only; invoices already issued keep their amounts. */
  r.patch(
    '/:id',
    ah(async (req, res) => {
      const id = idParam(req);
      const body = parse(
        z.object({
          name: z.string().trim().min(1).optional(),
          amountPaise: paise.optional(),
          isActive: z.boolean().optional(),
        }),
        req.body,
      );
      const [before] = await db.select().from(feePlans).where(eq(feePlans.id, id));
      if (!before) notFound('Fee plan');
      const [updated] = await db.update(feePlans).set(body).where(eq(feePlans.id, id)).returning();
      await audit(db, req, 'fee_plan', id, 'update', before, updated);
      res.json({ feePlan: updated });
    }),
  );

  return r;
}

export function studentFeePlansRouter(ctx: Ctx): Router {
  const { db } = ctx;
  const r = Router();

  r.get(
    '/',
    ah(async (req, res) => {
      const { studentId } = parse(z.object({ studentId: z.coerce.number().int().positive().optional() }), req.query);
      const rows = await db
        .select({ assignment: studentFeePlans, planName: feePlans.name, studentName: students.name })
        .from(studentFeePlans)
        .innerJoin(feePlans, eq(feePlans.id, studentFeePlans.feePlanId))
        .innerJoin(students, eq(students.id, studentFeePlans.studentId))
        .where(and(studentId ? eq(studentFeePlans.studentId, studentId) : undefined))
        .orderBy(desc(studentFeePlans.id));
      res.json({ studentFeePlans: rows });
    }),
  );

  r.post(
    '/',
    ah(async (req, res) => {
      const body = parse(
        assignmentBody.extend({
          studentId: z.number().int().positive(),
          feePlanId: z.number().int().positive(),
          startDate: dateStr.optional(),
        }),
        req.body,
      );
      checkDiscount(body.discountType, body.discountValue);
      const s = await getSettings(db);
      const startDate = body.startDate ?? zonedNow(s.timezone).date;

      const [plan] = await db.select().from(feePlans).where(eq(feePlans.id, body.feePlanId));
      if (!plan || !plan.isActive) throw new HttpError(400, 'Fee plan not found or inactive', 'INVALID');
      const [student] = await db.select({ id: students.id }).from(students).where(eq(students.id, body.studentId));
      if (!student) notFound('Student');

      const [created] = await db
        .insert(studentFeePlans)
        .values({
          studentId: body.studentId,
          feePlanId: body.feePlanId,
          amountOverridePaise: body.amountOverridePaise ?? null,
          discountType: body.discountType ?? null,
          discountValue: body.discountValue ?? null,
          startDate,
          endDate: body.endDate ?? null,
          nextInvoiceDate: startDate,
        })
        .returning();
      await audit(db, req, 'student_fee_plan', created.id, 'create', null, created);
      // Bill immediately when the plan starts today or earlier.
      const generated = await generateInvoices(ctx, { studentFeePlanId: created.id });
      res.status(201).json({ studentFeePlan: created, invoicesCreated: generated.invoiceIds });
    }),
  );

  r.patch(
    '/:id',
    ah(async (req, res) => {
      const id = idParam(req);
      const body = parse(assignmentBody.extend({ status: z.enum(['active', 'paused', 'ended']).optional() }), req.body);
      checkDiscount(body.discountType, body.discountValue);
      const [before] = await db.select().from(studentFeePlans).where(eq(studentFeePlans.id, id));
      if (!before) notFound('Student fee plan');
      const [updated] = await db.update(studentFeePlans).set(body).where(eq(studentFeePlans.id, id)).returning();
      await audit(db, req, 'student_fee_plan', id, 'update', before, updated);
      res.json({ studentFeePlan: updated });
    }),
  );

  return r;
}
