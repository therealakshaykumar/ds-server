import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  time,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

// ---------- enums ----------
export const userRole = pgEnum('user_role', ['admin', 'user']);
export const studentStatus = pgEnum('student_status', ['active', 'inactive']);
export const sessionStatus = pgEnum('session_status', ['scheduled', 'cancelled']);
export const attendanceStatus = pgEnum('attendance_status', ['present', 'absent']);
export const attendanceSource = pgEnum('attendance_source', ['self', 'admin']);
export const discountType = pgEnum('discount_type', ['percent', 'flat']);
export const planStatus = pgEnum('plan_status', ['active', 'paused', 'ended']);
export const invoiceStatus = pgEnum('invoice_status', ['pending', 'partial', 'paid', 'void']);
export const paymentMethod = pgEnum('payment_method', ['cash', 'upi', 'card', 'bank', 'other']);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

// ---------- identity ----------
export const users = pgTable('users', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  role: userRole('role').notNull().default('user'),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  phone: text('phone'),
  passwordHash: text('password_hash').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const students = pgTable(
  'students',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    parentUserId: integer('parent_user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    dob: date('dob', { mode: 'string' }),
    joinedOn: date('joined_on', { mode: 'string' }).notNull().default(sql`current_date`),
    status: studentStatus('status').notNull().default('active'),
    notes: text('notes'),
    createdAt: createdAt(),
  },
  (t) => [index('students_parent_idx').on(t.parentUserId)],
);

// ---------- classes and schedule ----------
export const locations = pgTable('locations', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  latitude: doublePrecision('latitude').notNull(),
  longitude: doublePrecision('longitude').notNull(),
  radiusM: integer('radius_m').notNull().default(100),
  isActive: boolean('is_active').notNull().default(true),
});

export const classes = pgTable('classes', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  instructorName: text('instructor_name'),
  /** 0 = Sunday ... 6 = Saturday */
  weekday: integer('weekday').notNull(),
  startTime: time('start_time').notNull(),
  endTime: time('end_time').notNull(),
  locationId: integer('location_id').references(() => locations.id),
  capacity: integer('capacity'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
});

export const classSessions = pgTable(
  'class_sessions',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    classId: integer('class_id')
      .notNull()
      .references(() => classes.id),
    sessionDate: date('session_date', { mode: 'string' }).notNull(),
    status: sessionStatus('status').notNull().default('scheduled'),
    cancelReason: text('cancel_reason'),
  },
  (t) => [unique('class_sessions_class_date_uq').on(t.classId, t.sessionDate), index('class_sessions_date_idx').on(t.sessionDate)],
);

export const enrolments = pgTable(
  'enrolments',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    studentId: integer('student_id')
      .notNull()
      .references(() => students.id),
    classId: integer('class_id')
      .notNull()
      .references(() => classes.id),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }),
  },
  (t) => [index('enrolments_student_idx').on(t.studentId), index('enrolments_class_idx').on(t.classId)],
);

// ---------- attendance ----------
export const attendance = pgTable(
  'attendance',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    sessionId: integer('session_id')
      .notNull()
      .references(() => classSessions.id),
    studentId: integer('student_id')
      .notNull()
      .references(() => students.id),
    status: attendanceStatus('status').notNull(),
    source: attendanceSource('source').notNull(),
    markedAt: timestamp('marked_at', { withTimezone: true }).notNull().defaultNow(),
    markedBy: integer('marked_by').references(() => users.id),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    accuracyM: doublePrecision('accuracy_m'),
    distanceM: doublePrecision('distance_m'),
  },
  (t) => [unique('attendance_session_student_uq').on(t.sessionId, t.studentId), index('attendance_student_idx').on(t.studentId)],
);

// ---------- fees ----------
export const feePlans = pgTable('fee_plans', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  amountPaise: integer('amount_paise').notNull(),
  /** Billing period in months (1, 3, 6, 12, ...). Null for one-time plans. */
  intervalMonths: integer('interval_months'),
  isOneTime: boolean('is_one_time').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
});

export const studentFeePlans = pgTable(
  'student_fee_plans',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    studentId: integer('student_id')
      .notNull()
      .references(() => students.id),
    feePlanId: integer('fee_plan_id')
      .notNull()
      .references(() => feePlans.id),
    amountOverridePaise: integer('amount_override_paise'),
    /** percent: whole percent (0-100). flat: paise. */
    discountType: discountType('discount_type'),
    discountValue: integer('discount_value'),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }),
    nextInvoiceDate: date('next_invoice_date', { mode: 'string' }).notNull(),
    status: planStatus('status').notNull().default('active'),
    createdAt: createdAt(),
  },
  (t) => [index('student_fee_plans_student_idx').on(t.studentId), index('student_fee_plans_next_idx').on(t.status, t.nextInvoiceDate)],
);

export const invoices = pgTable(
  'invoices',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    invoiceNumber: text('invoice_number').notNull().unique(),
    studentId: integer('student_id')
      .notNull()
      .references(() => students.id),
    studentFeePlanId: integer('student_fee_plan_id').references(() => studentFeePlans.id),
    issueDate: date('issue_date', { mode: 'string' }).notNull(),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    periodStart: date('period_start', { mode: 'string' }),
    periodEnd: date('period_end', { mode: 'string' }),
    subtotalPaise: integer('subtotal_paise').notNull(),
    discountPaise: integer('discount_paise').notNull().default(0),
    totalPaise: integer('total_paise').notNull(),
    amountPaidPaise: integer('amount_paid_paise').notNull().default(0),
    status: invoiceStatus('status').notNull().default('pending'),
    notes: text('notes'),
    lastReminderOn: date('last_reminder_on', { mode: 'string' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('invoices_student_idx').on(t.studentId),
    index('invoices_status_due_idx').on(t.status, t.dueDate),
    // Makes automatic invoice generation idempotent per plan and period.
    unique('invoices_plan_period_uq').on(t.studentFeePlanId, t.periodStart),
  ],
);

export const invoiceItems = pgTable('invoice_items', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  invoiceId: integer('invoice_id')
    .notNull()
    .references(() => invoices.id, { onDelete: 'cascade' }),
  description: text('description').notNull(),
  quantity: integer('quantity').notNull().default(1),
  unitAmountPaise: integer('unit_amount_paise').notNull(),
  amountPaise: integer('amount_paise').notNull(),
});

export const payments = pgTable(
  'payments',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    invoiceId: integer('invoice_id')
      .notNull()
      .references(() => invoices.id),
    amountPaise: integer('amount_paise').notNull(),
    method: paymentMethod('method').notNull(),
    reference: text('reference'),
    paidOn: date('paid_on', { mode: 'string' }).notNull(),
    receiptNumber: text('receipt_number').notNull().unique(),
    recordedBy: integer('recorded_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('payments_invoice_idx').on(t.invoiceId)],
);

// ---------- content and system ----------
export const events = pgTable('events', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  title: text('title').notNull(),
  description: text('description'),
  eventDate: date('event_date', { mode: 'string' }).notNull(),
  startTime: time('start_time'),
  venue: text('venue'),
  isPublished: boolean('is_published').notNull().default(true),
  createdAt: createdAt(),
});

export const awards = pgTable(
  'awards',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    studentId: integer('student_id')
      .notNull()
      .references(() => students.id),
    eventId: integer('event_id').references(() => events.id),
    title: text('title').notNull(),
    description: text('description'),
    awardedOn: date('awarded_on', { mode: 'string' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('awards_student_idx').on(t.studentId)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    body: text('body').notNull(),
    channel: text('channel').notNull().default('in_app'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.readAt)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    actorUserId: integer('actor_user_id').references(() => users.id),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    action: text('action').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_logs_entity_idx').on(t.entity, t.entityId)],
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
