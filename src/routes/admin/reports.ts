import { sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { zonedNow } from '../../lib/dates';
import { ah, parse } from '../../lib/http';
import type { Ctx } from '../../lib/notify';
import { dateStr } from '../../lib/schemas';
import { getSettings } from '../../lib/settings';

type Row = Record<string, unknown>;

/** node-postgres and pglite both return `{ rows }` from execute(). */
const rowsOf = (res: unknown): Row[] => (res as { rows: Row[] }).rows;
const num = (v: unknown) => Number(v ?? 0);

export function reportsRouter({ db }: Ctx): Router {
  const r = Router();

  r.get(
    '/dashboard',
    ah(async (_req, res) => {
      const s = await getSettings(db);
      const today = zonedNow(s.timezone).date;
      const monthStart = `${today.slice(0, 7)}-01`;

      const [row] = rowsOf(
        await db.execute(sql`
          select
            (select count(*) from students where status = 'active') as active_students,
            (select count(*) from class_sessions where session_date = ${today} and status = 'scheduled') as sessions_today,
            (select count(*) from attendance a join class_sessions cs on cs.id = a.session_id
               where cs.session_date = ${today} and a.status = 'present') as present_today,
            (select coalesce(sum(total_paise - amount_paid_paise), 0) from invoices where status in ('pending', 'partial')) as outstanding_paise,
            (select count(*) from invoices where status in ('pending', 'partial') and due_date < ${today}) as overdue_invoices,
            (select coalesce(sum(amount_paise), 0) from payments where paid_on >= ${monthStart} and paid_on <= ${today}) as collected_this_month_paise
        `),
      );
      res.json({
        today,
        activeStudents: num(row.active_students),
        sessionsToday: num(row.sessions_today),
        presentToday: num(row.present_today),
        outstandingPaise: num(row.outstanding_paise),
        overdueInvoices: num(row.overdue_invoices),
        collectedThisMonthPaise: num(row.collected_this_month_paise),
      });
    }),
  );

  /** Outstanding balance per student, oldest due date first. */
  r.get(
    '/dues',
    ah(async (_req, res) => {
      const rows = rowsOf(
        await db.execute(sql`
          select s.id as student_id, s.name as student_name, u.name as parent_name, u.phone as parent_phone,
                 count(i.id) as open_invoices,
                 sum(i.total_paise - i.amount_paid_paise) as balance_paise,
                 min(i.due_date) as oldest_due_date
          from invoices i
          join students s on s.id = i.student_id
          join users u on u.id = s.parent_user_id
          where i.status in ('pending', 'partial')
          group by s.id, s.name, u.name, u.phone
          order by min(i.due_date) asc, s.name asc
        `),
      );
      res.json({
        dues: rows.map((x) => ({
          studentId: num(x.student_id),
          studentName: x.student_name,
          parentName: x.parent_name,
          parentPhone: x.parent_phone,
          openInvoices: num(x.open_invoices),
          balancePaise: num(x.balance_paise),
          oldestDueDate: x.oldest_due_date,
        })),
      });
    }),
  );

  r.get(
    '/collections',
    ah(async (req, res) => {
      const q = parse(z.object({ from: dateStr, to: dateStr }), req.query);
      const byMonth = rowsOf(
        await db.execute(sql`
          select to_char(paid_on, 'YYYY-MM') as month, sum(amount_paise) as total_paise, count(*) as payments
          from payments where paid_on >= ${q.from} and paid_on <= ${q.to}
          group by 1 order by 1
        `),
      );
      const byMethod = rowsOf(
        await db.execute(sql`
          select method, sum(amount_paise) as total_paise, count(*) as payments
          from payments where paid_on >= ${q.from} and paid_on <= ${q.to}
          group by 1 order by 2 desc
        `),
      );
      res.json({
        byMonth: byMonth.map((x) => ({ month: x.month, totalPaise: num(x.total_paise), payments: num(x.payments) })),
        byMethod: byMethod.map((x) => ({ method: x.method, totalPaise: num(x.total_paise), payments: num(x.payments) })),
      });
    }),
  );

  /** Attendance rate per student over a date range (cancelled sessions and future dates excluded). */
  r.get(
    '/attendance',
    ah(async (req, res) => {
      const s = await getSettings(db);
      const today = zonedNow(s.timezone).date;
      const q = parse(z.object({ from: dateStr, to: dateStr, classId: z.coerce.number().int().positive().optional() }), req.query);
      const to = q.to < today ? q.to : today;
      const rows = rowsOf(
        await db.execute(sql`
          select st.id as student_id, st.name as student_name,
                 count(cs.id) as sessions,
                 count(a.id) filter (where a.status = 'present') as present
          from students st
          join enrolments e on e.student_id = st.id
          join class_sessions cs on cs.class_id = e.class_id
               and cs.session_date >= e.start_date
               and cs.session_date <= coalesce(e.end_date, '9999-12-31')
               and cs.session_date >= ${q.from} and cs.session_date <= ${to}
               and cs.status = 'scheduled'
          left join attendance a on a.session_id = cs.id and a.student_id = st.id
          where st.status = 'active' ${q.classId ? sql`and e.class_id = ${q.classId}` : sql``}
          group by st.id, st.name
          order by st.name
        `),
      );
      res.json({
        attendance: rows.map((x) => {
          const sessions = num(x.sessions);
          const present = num(x.present);
          return {
            studentId: num(x.student_id),
            studentName: x.student_name,
            sessions,
            present,
            percent: sessions ? Math.round((present / sessions) * 100) : null,
          };
        }),
      });
    }),
  );

  return r;
}
