import bcrypt from 'bcryptjs';
import { and, asc, eq, ilike, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { attendance, classes, classSessions, enrolments, feePlans, invoices, studentFeePlans, students, users } from '../../db/schema';
import { audit } from '../../lib/audit';
import { ah, HttpError, idParam, notFound, paging, parse } from '../../lib/http';
import type { Ctx } from '../../lib/notify';
import { zonedNow } from '../../lib/dates';
import { getSettings } from '../../lib/settings';
import { dateStr, email } from '../../lib/schemas';
import { tempPassword } from './users';

export function studentsRouter({ db }: Ctx): Router {
  const r = Router();

  r.get(
    '/',
    ah(async (req, res) => {
      const q = parse(
        z.object({
          q: z.string().trim().optional(),
          status: z.enum(['active', 'inactive']).optional(),
          parentId: z.coerce.number().int().positive().optional(),
        }),
        req.query,
      );
      const { limit, offset } = paging(req.query);
      const rows = await db
        .select({
          id: students.id,
          name: students.name,
          dob: students.dob,
          joinedOn: students.joinedOn,
          status: students.status,
          parentUserId: students.parentUserId,
          parentName: users.name,
          parentEmail: users.email,
          parentPhone: users.phone,
        })
        .from(students)
        .innerJoin(users, eq(users.id, students.parentUserId))
        .where(
          and(
            q.q ? ilike(students.name, `%${q.q}%`) : undefined,
            q.status ? eq(students.status, q.status) : undefined,
            q.parentId ? eq(students.parentUserId, q.parentId) : undefined,
          ),
        )
        .orderBy(asc(students.name))
        .limit(limit)
        .offset(offset);
      res.json({ students: rows });
    }),
  );

  r.post(
    '/',
    ah(async (req, res) => {
      const body = parse(
        z
          .object({
            name: z.string().trim().min(1),
            dob: dateStr.optional(),
            joinedOn: dateStr.optional(),
            notes: z.string().optional(),
            parentUserId: z.number().int().positive().optional(),
            parent: z
              .object({ name: z.string().trim().min(1), email, phone: z.string().trim().optional() })
              .optional(),
          })
          .refine((b) => b.parentUserId || b.parent, { message: 'Provide parentUserId or parent details' }),
        req.body,
      );

      const result = await db.transaction(async (tx) => {
        let parentId = body.parentUserId;
        let parentTempPassword: string | undefined;
        if (!parentId) {
          const p = body.parent!;
          const [existing] = await tx.select().from(users).where(eq(users.email, p.email));
          if (existing) {
            if (existing.role !== 'user') throw new HttpError(409, 'That email belongs to an admin account', 'CONFLICT');
            parentId = existing.id;
          } else {
            parentTempPassword = tempPassword();
            const [created] = await tx
              .insert(users)
              .values({
                name: p.name,
                email: p.email,
                phone: p.phone,
                role: 'user',
                passwordHash: await bcrypt.hash(parentTempPassword, 10),
                mustChangePassword: true,
              })
              .returning({ id: users.id });
            parentId = created.id;
          }
        } else {
          const [parent] = await tx.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, parentId));
          if (!parent || parent.role !== 'user') throw new HttpError(400, 'parentUserId is not a user account', 'INVALID');
        }
        const [student] = await tx
          .insert(students)
          .values({ name: body.name, dob: body.dob, joinedOn: body.joinedOn, notes: body.notes, parentUserId: parentId })
          .returning();
        await audit(tx, req, 'student', student.id, 'create', null, student);
        return { student, parentTempPassword };
      });
      res.status(201).json(result);
    }),
  );

  r.get(
    '/:id',
    ah(async (req, res) => {
      const id = idParam(req);
      const [student] = await db.select().from(students).where(eq(students.id, id));
      if (!student) notFound('Student');
      const s = await getSettings(db);
      const today = zonedNow(s.timezone).date;

      const [parent] = await db
        .select({ id: users.id, name: users.name, email: users.email, phone: users.phone })
        .from(users)
        .where(eq(users.id, student.parentUserId));
      const classRows = await db
        .select({
          enrolmentId: enrolments.id,
          classId: classes.id,
          className: classes.name,
          weekday: classes.weekday,
          startTime: classes.startTime,
          endTime: classes.endTime,
          startDate: enrolments.startDate,
          endDate: enrolments.endDate,
        })
        .from(enrolments)
        .innerJoin(classes, eq(classes.id, enrolments.classId))
        .where(eq(enrolments.studentId, id));
      const plans = await db
        .select({
          id: studentFeePlans.id,
          planName: feePlans.name,
          amountPaise: sql<number>`coalesce(${studentFeePlans.amountOverridePaise}, ${feePlans.amountPaise})`,
          discountType: studentFeePlans.discountType,
          discountValue: studentFeePlans.discountValue,
          nextInvoiceDate: studentFeePlans.nextInvoiceDate,
          status: studentFeePlans.status,
        })
        .from(studentFeePlans)
        .innerJoin(feePlans, eq(feePlans.id, studentFeePlans.feePlanId))
        .where(eq(studentFeePlans.studentId, id));
      const [due] = await db
        .select({ outstandingPaise: sql<number>`coalesce(sum(${invoices.totalPaise} - ${invoices.amountPaidPaise}), 0)::int` })
        .from(invoices)
        .where(and(eq(invoices.studentId, id), sql`${invoices.status} in ('pending', 'partial')`));
      const [att] = await db
        .select({
          expected: sql<number>`count(${classSessions.id})::int`,
          present: sql<number>`count(${attendance.id}) filter (where ${attendance.status} = 'present')::int`,
        })
        .from(enrolments)
        .innerJoin(
          classSessions,
          and(
            eq(classSessions.classId, enrolments.classId),
            sql`${classSessions.sessionDate} >= ${enrolments.startDate}`,
            sql`${classSessions.sessionDate} <= coalesce(${enrolments.endDate}, '9999-12-31')`,
            sql`${classSessions.sessionDate} <= ${today}`,
            eq(classSessions.status, 'scheduled'),
          ),
        )
        .leftJoin(attendance, and(eq(attendance.sessionId, classSessions.id), eq(attendance.studentId, id)))
        .where(eq(enrolments.studentId, id));

      res.json({
        student,
        parent,
        classes: classRows,
        feePlans: plans,
        outstandingPaise: Number(due.outstandingPaise),
        attendance: {
          expected: Number(att.expected),
          present: Number(att.present),
          percent: att.expected ? Math.round((Number(att.present) / Number(att.expected)) * 100) : null,
        },
      });
    }),
  );

  r.patch(
    '/:id',
    ah(async (req, res) => {
      const id = idParam(req);
      const body = parse(
        z.object({
          name: z.string().trim().min(1).optional(),
          dob: dateStr.nullable().optional(),
          joinedOn: dateStr.optional(),
          status: z.enum(['active', 'inactive']).optional(),
          notes: z.string().nullable().optional(),
          parentUserId: z.number().int().positive().optional(),
        }),
        req.body,
      );
      const [before] = await db.select().from(students).where(eq(students.id, id));
      if (!before) notFound('Student');
      const [updated] = await db.update(students).set(body).where(eq(students.id, id)).returning();
      await audit(db, req, 'student', id, 'update', before, updated);
      res.json({ student: updated });
    }),
  );

  return r;
}
