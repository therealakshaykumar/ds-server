import { doublePrecision, index, integer, pgEnum, pgTable, timestamp, unique } from 'drizzle-orm/pg-core';
import { classSessions } from './classSessions';
import { students } from './students';
import { users } from './users';

export const attendanceStatus = pgEnum('attendance_status', ['present', 'absent']);
export const attendanceSource = pgEnum('attendance_source', ['self', 'admin']);

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

export type Attendance = typeof attendance.$inferSelect;
export type NewAttendance = typeof attendance.$inferInsert;
export type AttendanceStatus = (typeof attendanceStatus.enumValues)[number];
export type AttendanceSource = (typeof attendanceSource.enumValues)[number];
