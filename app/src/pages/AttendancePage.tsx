import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Check, ClipboardCheck, Download, FileClock,
  Printer, Save, Send, Settings2, UserRoundCheck,
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';
import { AttendanceAutomationPanel } from './AttendanceAutomationPanel';
import type { SchoolClass } from '../types/database';

type Status = 'present' | 'absent' | 'late' | 'excused';
type SessionType = 'daily' | 'morning' | 'afternoon' | 'lesson';
type SessionState = 'open' | 'submitted' | 'closed';
type AbsenceCategory = 'unexplained' | 'medical' | 'authorized' | 'other';
type Tab = 'register' | 'history' | 'reports' | 'explanations' | 'settings' | 'my-attendance' | 'advanced';

interface RosterStudent {
  id: string;
  first_name: string;
  last_name: string;
  student_number: string;
  status: Status | '';
  note: string;
  arrival_time: string;
  departure_time: string;
  absence_reason: string;
  absence_category: AbsenceCategory;
}

interface ClassChoice extends SchoolClass {
  calendar_id: string;
}

interface AttendanceSession {
  id: string;
  school_id: string;
  class_id: string;
  attendance_date: string;
  academic_year_id: string | null;
  term_id: string | null;
  session_type: SessionType;
  lesson_entry_id: string | null;
  status: SessionState;
  non_school_day_override: boolean;
  override_reason: string | null;
  submitted_at: string | null;
  recorded_by: string;
}

interface AttendanceQueueRecord {
  student_id: string;
  status: Status;
  note: string | null;
  arrival_time: string | null;
  departure_time: string | null;
  absence_reason: string | null;
  absence_category: AbsenceCategory;
}

interface AttendanceQueueItem {
  key: string;
  user_id: string;
  school_id: string;
  class_id: string;
  attendance_date: string;
  academic_year_id: string | null;
  term_id: string | null;
  session_type: SessionType;
  lesson_entry_id: string | null;
  non_school_day_override: boolean;
  override_reason: string | null;
  records: AttendanceQueueRecord[];
  queued_at: string;
}

interface AcademicYearChoice { id: string; name: string; calendar_id: string; start_date: string; end_date: string }
interface TermChoice { id: string; name: string; academic_year_id: string; start_date: string; end_date: string }
interface StatusSetting { status: Status; label: string; enabled: boolean; counts_as_present: boolean; sort_order: number }
interface LessonChoice { id: string; starts_at: string; ends_at: string; subject: { name: string } | { name: string }[] | null }
interface HistorySession extends AttendanceSession { school_class?: { name: string } | { name: string }[] | null }
interface ReportRecord {
  session_id: string;
  student_id: string;
  status: Status;
  absence_category: AbsenceCategory;
  absence_reason: string | null;
  arrival_time: string | null;
}
interface AuditEntry { id: number; session_id: string | null; record_id: string | null; actor_id: string | null; action: string; created_at: string }
interface NotificationEntry { id: number; session_id: string; notification_type: 'absent' | 'late'; recipient_profile_id: string; created_at: string }
interface ParentExplanationHistory { id: string; attendance_date: string; category: string; explanation: string; status: 'pending' | 'approved' | 'rejected'; review_note: string | null; created_at: string }
interface PersonalNotice { id: number; session_id: string; notification_type: 'absent' | 'late'; created_at: string; session: { attendance_date: string } | { attendance_date: string }[] | null }
interface StudentChoice { id: string; first_name: string; last_name: string; student_number: string; class_id: string | null }
interface Explanation {
  id: string;
  student_id: string;
  attendance_date: string;
  category: Exclude<AbsenceCategory, 'unexplained'>;
  explanation: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  students: { first_name: string; last_name: string; student_number: string } | { first_name: string; last_name: string; student_number: string }[] | null;
}

const defaultStatuses: StatusSetting[] = [
  { status: 'present', label: 'Present', enabled: true, counts_as_present: true, sort_order: 1 },
  { status: 'absent', label: 'Absent', enabled: true, counts_as_present: false, sort_order: 2 },
  { status: 'late', label: 'Late', enabled: true, counts_as_present: true, sort_order: 3 },
  { status: 'excused', label: 'Excused', enabled: true, counts_as_present: false, sort_order: 4 },
];
const sessionTypes: { value: SessionType; label: string }[] = [
  { value: 'daily', label: 'Daily register' },
  { value: 'morning', label: 'Morning registration' },
  { value: 'afternoon', label: 'Afternoon registration' },
  { value: 'lesson', label: 'Lesson attendance' },
];
const absenceCategories: { value: AbsenceCategory; label: string }[] = [
  { value: 'unexplained', label: 'Unexplained' },
  { value: 'medical', label: 'Medical' },
  { value: 'authorized', label: 'Authorized' },
  { value: 'other', label: 'Other' },
];

function localDate() {
  const date = new Date();
  const timezoneOffset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - timezoneOffset).toISOString().slice(0, 10);
}

function relation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function csvCell(value: string | number | null | undefined) {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]) {
  const content = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function explainError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function readAttendanceQueue(raw: string | null): AttendanceQueueItem[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((item) => !item
    || typeof item.key !== 'string'
    || typeof item.user_id !== 'string'
    || typeof item.school_id !== 'string'
    || typeof item.class_id !== 'string'
    || typeof item.attendance_date !== 'string'
    || !Array.isArray(item.records)
    || item.records.some((record: unknown) => !record
      || typeof record !== 'object'
      || !('student_id' in record)
      || typeof record.student_id !== 'string'
      || !('status' in record)
      || !['present', 'absent', 'late', 'excused'].includes(String(record.status))))) {
    throw new Error('The saved attendance sync queue is invalid. It was kept on this device; contact support before clearing browser data.');
  }
  return parsed as AttendanceQueueItem[];
}

export function AttendancePage() {
  const { activeMembership, user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [classes, setClasses] = useState<ClassChoice[]>([]);
  const [classId, setClassId] = useState('');
  const [date, setDate] = useState(localDate);
  const [sessionType, setSessionType] = useState<SessionType>('daily');
  const [lessonId, setLessonId] = useState('');
  const [lessons, setLessons] = useState<LessonChoice[]>([]);
  const [students, setStudents] = useState<RosterStudent[]>([]);
  const [session, setSession] = useState<AttendanceSession | null>(null);
  const [years, setYears] = useState<AcademicYearChoice[]>([]);
  const [terms, setTerms] = useState<TermChoice[]>([]);
  const [yearId, setYearId] = useState('');
  const [termId, setTermId] = useState('');
  const [statusSettings, setStatusSettings] = useState<StatusSetting[]>(defaultStatuses);
  const [defaultSessionType, setDefaultSessionType] = useState<SessionType>('daily');
  const [lateAfter, setLateAfter] = useState('');
  const [requireComplete, setRequireComplete] = useState(true);
  const [parentExplanationsEnabled, setParentExplanationsEnabled] = useState(true);
  const [notifyAbsence, setNotifyAbsence] = useState(false);
  const [notifyLate, setNotifyLate] = useState(false);
  const [attendanceTarget, setAttendanceTarget] = useState('95');
  const [attendanceWarning, setAttendanceWarning] = useState('90');
  const [repeatedAbsenceThreshold, setRepeatedAbsenceThreshold] = useState('3');
  const [consecutiveAbsenceThreshold, setConsecutiveAbsenceThreshold] = useState('3');
  const [autoLockAfterDays, setAutoLockAfterDays] = useState('');
  const [lateToAbsenceMinutes, setLateToAbsenceMinutes] = useState('');
  const [calculationBasis, setCalculationBasis] = useState<'daily' | 'lesson'>('daily');
  const [excusedCountsAsPresent, setExcusedCountsAsPresent] = useState(false);
  const [overrideDay, setOverrideDay] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [historySessions, setHistorySessions] = useState<HistorySession[]>([]);
  const [reportRecords, setReportRecords] = useState<ReportRecord[]>([]);
  const [reportStudents, setReportStudents] = useState<StudentChoice[]>([]);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [notificationEntries, setNotificationEntries] = useState<NotificationEntry[]>([]);
  const [reportClassId, setReportClassId] = useState('');
  const [rangeStart, setRangeStart] = useState(() => `${localDate().slice(0, 4)}-01-01`);
  const [rangeEnd, setRangeEnd] = useState(localDate);
  const [searchText, setSearchText] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('');
  const [tab, setTab] = useState<Tab>('register');
  const [children, setChildren] = useState<StudentChoice[]>([]);
  const [selectedChildId, setSelectedChildId] = useState('');
  const [myRecords, setMyRecords] = useState<Record<string, unknown>[]>([]);
  const [myExplanations, setMyExplanations] = useState<ParentExplanationHistory[]>([]);
  const [myNotifications, setMyNotifications] = useState<PersonalNotice[]>([]);
  const [explanations, setExplanations] = useState<Explanation[]>([]);
  const [explanationChild, setExplanationChild] = useState('');
  const [explanationDate, setExplanationDate] = useState(localDate);
  const [explanationCategory, setExplanationCategory] = useState<Exclude<AbsenceCategory, 'unexplained'>>('medical');
  const [explanationText, setExplanationText] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingRoster, setLoadingRoster] = useState(false);
  const [saving, setSaving] = useState(false);
  const [offlineQueue, setOfflineQueue] = useState<AttendanceQueueItem[]>([]);
  const [queueReadyKey, setQueueReadyKey] = useState('');
  const [isOnline, setIsOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const [syncingQueue, setSyncingQueue] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const queueSyncInFlight = useRef(false);

  const role = activeMembership?.role;
  const schoolId = activeMembership?.school_id;
  const queueStorageKey = schoolId && user
    ? `campus-connect:attendance-queue:v1:${schoolId}:${user.id}`
    : '';
  const canManage = role === 'school_admin' || role === 'academic_coordinator';
  const canRecord = canManage || role === 'teacher';
  const canSeePersonal = role === 'student' || role === 'parent';
  const enabledStatuses = statusSettings.filter((item) => item.enabled).sort((a, b) => a.sort_order - b.sort_order);
  const selectedClass = classes.find((schoolClass) => schoolClass.id === classId);
  const relevantYears = years.filter((year) => year.calendar_id === selectedClass?.calendar_id
    && (selectedClass.academic_year_id ? year.id === selectedClass.academic_year_id : date >= year.start_date && date <= year.end_date));
  const relevantTerms = terms.filter((term) => term.academic_year_id === yearId && date >= term.start_date && date <= term.end_date);
  const unmarkedCount = students.filter((student) => !student.status).length;
  const counts = useMemo(() => ({
    present: students.filter((student) => student.status === 'present').length,
    absent: students.filter((student) => student.status === 'absent').length,
    late: students.filter((student) => student.status === 'late').length,
    excused: students.filter((student) => student.status === 'excused').length,
  }), [students]);
  const readOnlyRegister = session?.status === 'closed' || (session?.status === 'submitted' && !canManage);
  const pendingAttendanceQueue = useMemo(
    () => offlineQueue.filter((item) => item.school_id === schoolId && item.user_id === user?.id),
    [offlineQueue, schoolId, user?.id],
  );

  useEffect(() => {
    if (!queueStorageKey) {
      setOfflineQueue([]);
      setQueueReadyKey('');
      return;
    }
    try {
      setOfflineQueue(readAttendanceQueue(localStorage.getItem(queueStorageKey)));
      setQueueReadyKey(queueStorageKey);
    } catch (queueError) {
      setQueueReadyKey('');
      setError(explainError(queueError, 'Could not load the saved attendance sync queue.'));
    }
  }, [queueStorageKey]);

  useEffect(() => {
    if (!queueStorageKey || queueReadyKey !== queueStorageKey) return;
    try {
      if (offlineQueue.length) localStorage.setItem(queueStorageKey, JSON.stringify(offlineQueue));
      else localStorage.removeItem(queueStorageKey);
    } catch (queueError) {
      setError(explainError(queueError, 'Could not persist the attendance sync queue on this device.'));
    }
  }, [offlineQueue, queueReadyKey, queueStorageKey]);

  useEffect(() => {
    const updateOnlineState = () => setIsOnline(navigator.onLine);
    window.addEventListener('online', updateOnlineState);
    window.addEventListener('offline', updateOnlineState);
    return () => {
      window.removeEventListener('online', updateOnlineState);
      window.removeEventListener('offline', updateOnlineState);
    };
  }, []);

  useEffect(() => {
    if (role !== 'teacher') return;
    const requestedClass = new URLSearchParams(window.location.search).get('class');
    if (requestedClass && classes.some((schoolClass) => schoolClass.id === requestedClass)) {
      setClassId(requestedClass);
    }
  }, [classes, role]);

  useEffect(() => {
    setTab(canRecord ? 'register' : 'my-attendance');
  }, [activeMembership?.school_id, role, canRecord]);

  useEffect(() => {
    if (searchParams.get('command') !== 'register') return;
    if (canRecord) setTab('register');
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('command');
      return next;
    }, { replace: true });
  }, [searchParams, setSearchParams, canRecord]);

  const loadBase = useCallback(async () => {
    if (!schoolId || !user) return;
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [classResult, yearResult, termResult, statusResult, settingsResult] = await Promise.all([
        client.from('school_classes')
          .select('id,school_id,name,grade_level,academic_year_id,calendar_id,created_at')
          .eq('school_id', schoolId).order('name'),
        client.from('academic_years')
          .select('id,name,calendar_id,start_date,end_date')
          .eq('school_id', schoolId).order('start_date', { ascending: false }),
        client.from('terms')
          .select('id,name,academic_year_id,start_date,end_date')
          .eq('school_id', schoolId).order('start_date'),
        client.from('attendance_status_settings')
          .select('status,label,enabled,counts_as_present,sort_order')
          .eq('school_id', schoolId).order('sort_order'),
        client.from('attendance_settings')
          .select('default_session_type,late_after,require_complete_register,allow_parent_explanations,notify_on_absence,notify_on_late,attendance_target_percent,attendance_warning_percent,repeated_absence_threshold,consecutive_absence_threshold,auto_lock_after_days,late_to_absence_after_minutes,attendance_calculation_basis,excused_counts_as_present')
          .eq('school_id', schoolId).maybeSingle(),
      ]);
      const failed = [classResult.error, yearResult.error, termResult.error, statusResult.error, settingsResult.error].find(Boolean);
      if (failed) throw failed;

      let allowedClasses = (classResult.data ?? []) as ClassChoice[];
      if (role === 'teacher') {
        const { data: teacherRows, error: teacherError } = await client.from('teacher_profiles')
          .select('id').eq('school_id', schoolId).eq('profile_id', user.id);
        if (teacherError) throw teacherError;
        const teacherIds = (teacherRows ?? []).map((row) => row.id);
        const { data: assignmentRows, error: assignmentError } = teacherIds.length
          ? await client.from('teacher_class_assignments').select('class_id').eq('school_id', schoolId).in('teacher_id', teacherIds)
          : { data: [], error: null };
        if (assignmentError) throw assignmentError;
        const { data: substituteRows, error: substituteError } = teacherIds.length
          ? await client.from('attendance_substitute_assignments')
            .select('session:attendance_sessions!inner(class_id)')
            .eq('school_id', schoolId).in('substitute_teacher_id', teacherIds)
          : { data: [], error: null };
        if (substituteError) throw substituteError;
        const assignedIds = new Set((assignmentRows ?? []).map((row) => row.class_id));
        for (const item of substituteRows ?? []) {
          const session = item.session as { class_id: string } | { class_id: string }[] | null;
          const classId = Array.isArray(session) ? session[0]?.class_id : session?.class_id;
          if (classId) assignedIds.add(classId);
        }
        allowedClasses = allowedClasses.filter((schoolClass) => assignedIds.has(schoolClass.id));
      }

      setClasses(allowedClasses);
      setClassId((current) => allowedClasses.some((schoolClass) => schoolClass.id === current)
        ? current : allowedClasses[0]?.id ?? '');
      setYears((yearResult.data ?? []) as AcademicYearChoice[]);
      setTerms((termResult.data ?? []) as TermChoice[]);
      setStatusSettings((statusResult.data?.length ? statusResult.data : defaultStatuses) as StatusSetting[]);
      if (settingsResult.data) {
        const selectedDefaultType = settingsResult.data.default_session_type as SessionType;
        setDefaultSessionType(selectedDefaultType);
        setLateAfter(settingsResult.data.late_after?.slice(0, 5) ?? '');
        setRequireComplete(settingsResult.data.require_complete_register);
        setParentExplanationsEnabled(settingsResult.data.allow_parent_explanations);
        setNotifyAbsence(settingsResult.data.notify_on_absence);
        setNotifyLate(settingsResult.data.notify_on_late);
        setAttendanceTarget(String(settingsResult.data.attendance_target_percent));
        setAttendanceWarning(String(settingsResult.data.attendance_warning_percent));
        setRepeatedAbsenceThreshold(String(settingsResult.data.repeated_absence_threshold));
        setConsecutiveAbsenceThreshold(String(settingsResult.data.consecutive_absence_threshold));
        setAutoLockAfterDays(settingsResult.data.auto_lock_after_days === null ? '' : String(settingsResult.data.auto_lock_after_days));
        setLateToAbsenceMinutes(settingsResult.data.late_to_absence_after_minutes === null ? '' : String(settingsResult.data.late_to_absence_after_minutes));
        setCalculationBasis(settingsResult.data.attendance_calculation_basis);
        setExcusedCountsAsPresent(settingsResult.data.excused_counts_as_present);
        setSessionType((current) => current === 'daily' ? selectedDefaultType : current);
      }

      if (role === 'parent') {
        const { data: parentRows, error: parentError } = await client.from('parent_profiles')
          .select('id').eq('school_id', schoolId).eq('profile_id', user.id);
        if (parentError) throw parentError;
        const parentIds = (parentRows ?? []).map((row) => row.id);
        const { data: childRows, error: childError } = parentIds.length
          ? await client.from('parent_students')
            .select('student_id,students(id,first_name,last_name,student_number,class_id)')
            .eq('school_id', schoolId).in('parent_id', parentIds)
          : { data: [], error: null };
        if (childError) throw childError;
        const linked = (childRows ?? []).flatMap((row) => {
          const child = relation(row.students as StudentChoice | StudentChoice[] | null);
          return child ? [child] : [];
        });
        setChildren(linked);
        setSelectedChildId((current) => linked.some((child) => child.id === current) ? current : linked[0]?.id ?? '');
        setExplanationChild((current) => linked.some((child) => child.id === current) ? current : linked[0]?.id ?? '');
      } else if (role === 'student') {
        const { data: studentRows, error: studentError } = await client.from('students')
          .select('id,first_name,last_name,student_number,class_id')
          .eq('school_id', schoolId).eq('profile_id', user.id);
        if (studentError) throw studentError;
        setChildren((studentRows ?? []) as StudentChoice[]);
        setSelectedChildId(studentRows?.[0]?.id ?? '');
      }
    } catch (loadError) {
      setError(explainError(loadError, 'Could not load attendance setup.'));
    } finally {
      setLoading(false);
    }
  }, [schoolId, role, user]);

  useEffect(() => { void loadBase(); }, [loadBase]);

  const loadRegister = useCallback(async () => {
    if (!canRecord || !schoolId || !classId || !date) {
      setStudents([]);
      setSession(null);
      return;
    }
    setLoadingRoster(true);
    setError('');
    try {
      const client = requireSupabase();
      const selectedYear = years.find((year) => year.id === yearId
        && year.calendar_id === selectedClass?.calendar_id
        && date >= year.start_date && date <= year.end_date)
        ?? years.find((year) => year.calendar_id === selectedClass?.calendar_id && date >= year.start_date && date <= year.end_date);
      const [rosterResult, lessonsResult] = await Promise.all([
        client.from('class_students')
          .select('student_id,students(id,first_name,last_name,student_number)')
          .eq('school_id', schoolId).eq('class_id', classId).order('student_id'),
        client.from('timetable').select('id,starts_at,ends_at,subject:subjects(name)')
          .eq('school_id', schoolId).eq('class_id', classId)
          .eq('day_of_week', new Date(`${date}T12:00:00`).getDay() === 0 ? 7 : new Date(`${date}T12:00:00`).getDay())
          .eq('entry_type', 'lesson').order('starts_at'),
      ]);
      if (rosterResult.error) throw rosterResult.error;
      if (lessonsResult.error) throw lessonsResult.error;
      const nextLessons = (lessonsResult.data ?? []) as unknown as LessonChoice[];
      setLessons(nextLessons);
      const activeLessonId = sessionType === 'lesson'
        ? (nextLessons.some((lesson) => lesson.id === lessonId) ? lessonId : nextLessons[0]?.id ?? '')
        : '';
      if (sessionType === 'lesson') setLessonId(activeLessonId);
      if (sessionType === 'lesson' && !activeLessonId) {
        setSession(null);
        setStudents([]);
        return;
      }
      const sessionQuery = client.from('attendance_sessions')
        .select('id,school_id,class_id,attendance_date,academic_year_id,term_id,session_type,lesson_entry_id,status,non_school_day_override,override_reason,submitted_at,recorded_by')
        .eq('school_id', schoolId).eq('class_id', classId).eq('attendance_date', date).eq('session_type', sessionType);
      const { data: sessionData, error: sessionError } = sessionType === 'lesson'
        ? await sessionQuery.eq('lesson_entry_id', activeLessonId).maybeSingle()
        : await sessionQuery.is('lesson_entry_id', null).maybeSingle();
      if (sessionError) throw sessionError;
      const loadedSession = sessionData as AttendanceSession | null;
      setSession(loadedSession);
      setYearId(loadedSession?.academic_year_id ?? selectedYear?.id ?? '');
      setTermId(loadedSession?.term_id ?? terms.find((term) =>
        term.academic_year_id === (loadedSession?.academic_year_id ?? selectedYear?.id)
        && date >= term.start_date && date <= term.end_date)?.id ?? '');
      setOverrideDay(Boolean(loadedSession?.non_school_day_override));
      setOverrideReason(loadedSession?.override_reason ?? '');

      const roster: RosterStudent[] = (rosterResult.data ?? []).flatMap((entry) => {
        const student = relation<Omit<RosterStudent, 'status' | 'note' | 'arrival_time' | 'departure_time' | 'absence_reason' | 'absence_category'>>(
          entry.students as Omit<RosterStudent, 'status' | 'note' | 'arrival_time' | 'departure_time' | 'absence_reason' | 'absence_category'> | Omit<RosterStudent, 'status' | 'note' | 'arrival_time' | 'departure_time' | 'absence_reason' | 'absence_category'>[] | null,
        );
        return student ? [{
          ...student,
          status: '' as Status | '',
          note: '',
          arrival_time: '',
          departure_time: '',
          absence_reason: '',
          absence_category: 'unexplained' as AbsenceCategory,
        }] : [];
      });
      if (loadedSession) {
        const { data: attendanceRows, error: attendanceError } = await client.from('attendance_records')
          .select('student_id,status,note,arrival_time,departure_time,absence_reason,absence_category')
          .eq('school_id', schoolId).eq('session_id', loadedSession.id);
        if (attendanceError) throw attendanceError;
        const saved = new Map((attendanceRows ?? []).map((record) => [record.student_id, record]));
        roster.forEach((student) => {
          const record = saved.get(student.id);
          if (!record) return;
          student.status = record.status as Status;
          student.note = record.note ?? '';
          student.arrival_time = record.arrival_time?.slice(0, 5) ?? '';
          student.departure_time = record.departure_time?.slice(0, 5) ?? '';
          student.absence_reason = record.absence_reason ?? '';
          student.absence_category = record.absence_category as AbsenceCategory;
        });
      }
      setStudents(roster);
    } catch (loadError) {
      setError(explainError(loadError, 'Could not load this class register.'));
      setStudents([]);
    } finally {
      setLoadingRoster(false);
    }
  }, [canRecord, schoolId, classId, date, sessionType, lessonId, years, yearId, selectedClass?.calendar_id, terms]);

  useEffect(() => { void loadRegister(); }, [loadRegister]);

  const loadHistory = useCallback(async () => {
    if (!schoolId || !canRecord) {
      setHistorySessions([]);
      setReportRecords([]);
      setReportStudents([]);
      return;
    }
    try {
      const client = requireSupabase();
      let historyQuery = client.from('attendance_sessions')
        .select('id,school_id,class_id,attendance_date,academic_year_id,term_id,session_type,lesson_entry_id,status,non_school_day_override,override_reason,submitted_at,recorded_by,school_class:school_classes(name)')
        .eq('school_id', schoolId)
        .gte('attendance_date', rangeStart).lte('attendance_date', rangeEnd);
      if (reportClassId) historyQuery = historyQuery.eq('class_id', reportClassId);
      const { data: sessionRows, error: historyError } = await historyQuery.order('attendance_date', { ascending: false }).limit(1000);
      if (historyError) throw historyError;
      const listed = (sessionRows ?? []) as unknown as HistorySession[];
      setHistorySessions(listed);
      const sessionIds = listed.map((item) => item.id);
      if (!sessionIds.length) {
        setReportRecords([]);
        setReportStudents([]);
        setAuditEntries([]);
        setNotificationEntries([]);
        return;
      }
      const [recordsResult, auditResult, notificationResult] = await Promise.all([
        client.from('attendance_records')
          .select('session_id,student_id,status,absence_category,absence_reason,arrival_time')
          .eq('school_id', schoolId).in('session_id', sessionIds),
        client.from('attendance_audit_log')
          .select('id,session_id,record_id,actor_id,action,created_at')
          .eq('school_id', schoolId).in('session_id', sessionIds).order('created_at', { ascending: false }).limit(500),
        client.from('attendance_notification_history')
          .select('id,session_id,notification_type,recipient_profile_id,created_at')
          .eq('school_id', schoolId).in('session_id', sessionIds).order('created_at', { ascending: false }).limit(500),
      ]);
      if (recordsResult.error) throw recordsResult.error;
      if (auditResult.error) throw auditResult.error;
      if (notificationResult.error) throw notificationResult.error;
      const recordRows = recordsResult.data;
      const records = (recordRows ?? []) as ReportRecord[];
      const studentIds = [...new Set(records.map((item) => item.student_id))];
      const { data: studentRows, error: studentError } = studentIds.length
        ? await client.from('students').select('id,first_name,last_name,student_number,class_id')
          .eq('school_id', schoolId).in('id', studentIds)
        : { data: [], error: null };
      if (studentError) throw studentError;
      setReportRecords(records);
      setReportStudents((studentRows ?? []) as StudentChoice[]);
      setAuditEntries((auditResult.data ?? []) as AuditEntry[]);
      setNotificationEntries((notificationResult.data ?? []) as NotificationEntry[]);
    } catch (historyError) {
      setError(explainError(historyError, 'Could not load attendance history.'));
    }
  }, [schoolId, reportClassId, canRecord, rangeStart, rangeEnd]);

  useEffect(() => { void loadHistory(); }, [loadHistory]);

  const loadPersonalHistory = useCallback(async () => {
    if (!schoolId || !canSeePersonal || !selectedChildId) {
      setMyRecords([]);
      return;
    }
    try {
      const client = requireSupabase();
      const [recordsResult, noticeResult, explanationResult] = await Promise.all([
        client.from('attendance_records')
          .select('id,status,note,arrival_time,departure_time,absence_reason,absence_category,session:attendance_sessions(attendance_date,session_type,status,term:terms(name),school_class:school_classes(name))')
          .eq('school_id', schoolId).eq('student_id', selectedChildId).order('created_at', { ascending: false }).limit(500),
        canSeePersonal
          ? client.from('attendance_notification_history').select('id,session_id,notification_type,created_at,session:attendance_sessions(attendance_date)')
            .eq('school_id', schoolId).eq('student_id', selectedChildId).order('created_at', { ascending: false }).limit(100)
          : Promise.resolve({ data: [], error: null }),
        role === 'parent'
          ? client.from('attendance_parent_explanations').select('id,attendance_date,category,explanation,status,review_note,created_at')
            .eq('school_id', schoolId).eq('student_id', selectedChildId).order('created_at', { ascending: false }).limit(100)
          : Promise.resolve({ data: [], error: null }),
      ]);
      const failed = [recordsResult.error, noticeResult.error, explanationResult.error].find(Boolean);
      if (failed) throw failed;
      setMyRecords((recordsResult.data ?? []) as Record<string, unknown>[]);
      setMyNotifications((noticeResult.data ?? []) as PersonalNotice[]);
      setMyExplanations((explanationResult.data ?? []) as ParentExplanationHistory[]);
    } catch (recordsError) {
      setError(explainError(recordsError, 'Could not load attendance history.'));
    }
  }, [schoolId, canSeePersonal, selectedChildId, role]);

  useEffect(() => { void loadPersonalHistory(); }, [loadPersonalHistory]);

  const loadExplanations = useCallback(async () => {
    if (!schoolId || !canRecord) {
      setExplanations([]);
      return;
    }
    const { data, error: queryError } = await requireSupabase().from('attendance_parent_explanations')
      .select('id,student_id,attendance_date,category,explanation,status,created_at,students(first_name,last_name,student_number)')
      .eq('school_id', schoolId).eq('status', 'pending').order('attendance_date', { ascending: false }).limit(200);
    if (queryError) {
      setError(queryError.message);
      return;
    }
    setExplanations((data ?? []) as unknown as Explanation[]);
  }, [schoolId, canRecord]);

  useEffect(() => { void loadExplanations(); }, [loadExplanations]);

  function updateStudent(studentId: string, patch: Partial<RosterStudent>) {
    setStudents((current) => current.map((student) => student.id === studentId ? { ...student, ...patch } : student));
  }

  async function saveRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !classId || !user || !students.length || readOnlyRegister) return;
    const recordChanges: AttendanceQueueRecord[] = students.flatMap((student) => student.status ? [{
      student_id: student.id,
      status: student.status,
      note: student.note.trim() || null,
      arrival_time: student.arrival_time || null,
      departure_time: student.departure_time || null,
      absence_reason: student.absence_reason.trim() || null,
      absence_category: student.absence_category,
    }] : []);
    if (!recordChanges.length) {
      setError('Mark at least one student before saving the register.');
      return;
    }
    if (students.some((student) => student.status === 'late' && !student.arrival_time)) {
      setError('Enter an arrival time for every student marked late.');
      return;
    }
    if (overrideDay && !overrideReason.trim()) {
      setError('Enter a reason for the non-school-day exception before saving.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    const queueKey = [schoolId, classId, date, sessionType, sessionType === 'lesson' ? lessonId : ''].join(':');
    const queuedItem: AttendanceQueueItem = {
      key: queueKey,
      user_id: user.id,
      school_id: schoolId,
      class_id: classId,
      attendance_date: date,
      academic_year_id: yearId || null,
      term_id: termId || null,
      session_type: sessionType,
      lesson_entry_id: sessionType === 'lesson' ? lessonId : null,
      non_school_day_override: overrideDay,
      override_reason: overrideDay ? overrideReason.trim() : null,
      records: recordChanges,
      queued_at: new Date().toISOString(),
    };
    const saveToOfflineQueue = () => {
      if (!queueStorageKey || queueReadyKey !== queueStorageKey) {
        throw new Error('The attendance sync queue is not ready on this device. Reconnect and try again.');
      }
      const nextQueue = [...offlineQueue.filter((item) => item.key !== queueKey), queuedItem];
      try {
        localStorage.setItem(queueStorageKey, JSON.stringify(nextQueue));
      } catch (storageError) {
        throw new Error(`Could not store these attendance details on this device: ${explainError(storageError, 'browser storage is unavailable or full')}`);
      }
      setOfflineQueue(nextQueue);
      setNotice(`${recordChanges.length} attendance record${recordChanges.length === 1 ? '' : 's'} saved on this device and waiting to sync.`);
    };
    try {
      if (!navigator.onLine) {
        saveToOfflineQueue();
        return;
      }
      const client = requireSupabase();
      let activeSession = session;
      if (!activeSession) {
        const { data, error: createError } = await client.from('attendance_sessions').insert({
          school_id: schoolId,
          class_id: classId,
          attendance_date: date,
          academic_year_id: yearId || null,
          term_id: termId || null,
          session_type: sessionType,
          lesson_entry_id: sessionType === 'lesson' ? lessonId : null,
          recorded_by: user.id,
          non_school_day_override: overrideDay,
          override_reason: overrideDay ? overrideReason.trim() : null,
        }).select('id,school_id,class_id,attendance_date,academic_year_id,term_id,session_type,lesson_entry_id,status,non_school_day_override,override_reason,submitted_at,recorded_by').single();
        if (createError) throw createError;
        activeSession = data as AttendanceSession;
        setSession(activeSession);
      } else if (activeSession.status !== 'open') {
        throw new Error('This register is not open for editing.');
      } else if (canManage) {
        const { error: updateError } = await client.from('attendance_sessions').update({
          academic_year_id: yearId || null,
          term_id: termId || null,
          non_school_day_override: overrideDay,
          override_reason: overrideDay ? overrideReason.trim() : null,
        }).eq('school_id', schoolId).eq('id', activeSession.id);
        if (updateError) throw updateError;
      }
      const updates = recordChanges.map((record) => ({
        school_id: schoolId,
        session_id: activeSession?.id,
        ...record,
      }));
      const { error: recordsError } = await client.from('attendance_records').upsert(updates, { onConflict: 'session_id,student_id' });
      if (recordsError) throw recordsError;
      setNotice(`${updates.length} attendance record${updates.length === 1 ? '' : 's'} saved${students.length - updates.length ? `; ${students.length - updates.length} student(s) remain unmarked` : ''}.`);
      await Promise.all([loadRegister(), loadHistory()]);
    } catch (saveError) {
      const networkFailure = saveError instanceof TypeError && /fetch|network|connection|offline/i.test(saveError.message);
      if (!navigator.onLine || networkFailure) {
        try {
          saveToOfflineQueue();
        } catch (queueError) {
          setError(explainError(queueError, 'Could not save the attendance changes locally.'));
        }
      } else {
        setError(explainError(saveError, 'Could not save this attendance register.'));
      }
    } finally {
      setSaving(false);
    }
  }

  const syncAttendanceQueue = useCallback(async () => {
    if (!isOnline || !schoolId || !user || queueSyncInFlight.current || !pendingAttendanceQueue.length) return;
    queueSyncInFlight.current = true;
    setSyncingQueue(true);
    setError('');
    const syncedItems = new Map<string, string>();
    let syncFailure = '';
    try {
      const client = requireSupabase();
      for (const queued of pendingAttendanceQueue) {
        try {
          const loadQueuedSession = () => {
            const query = client.from('attendance_sessions').select('id,status')
              .eq('school_id', queued.school_id).eq('class_id', queued.class_id)
              .eq('attendance_date', queued.attendance_date).eq('session_type', queued.session_type);
            return queued.session_type === 'lesson'
              ? query.eq('lesson_entry_id', queued.lesson_entry_id).maybeSingle()
              : query.is('lesson_entry_id', null).maybeSingle();
          };
          let sessionResult = await loadQueuedSession();
          if (sessionResult.error) throw sessionResult.error;
          let activeSession = sessionResult.data;
          if (!activeSession) {
            const { data: createdSession, error: createError } = await client.from('attendance_sessions').insert({
              school_id: queued.school_id,
              class_id: queued.class_id,
              attendance_date: queued.attendance_date,
              academic_year_id: queued.academic_year_id,
              term_id: queued.term_id,
              session_type: queued.session_type,
              lesson_entry_id: queued.lesson_entry_id,
              recorded_by: user.id,
              non_school_day_override: queued.non_school_day_override,
              override_reason: queued.override_reason,
            }).select('id,status').single();
            if (createError?.code === '23505') {
              sessionResult = await loadQueuedSession();
              if (sessionResult.error) throw sessionResult.error;
              activeSession = sessionResult.data;
            } else if (createError) {
              throw createError;
            } else {
              activeSession = createdSession;
            }
          }
          if (!activeSession) throw new Error('The attendance session could not be created or loaded.');
          if (activeSession.status !== 'open') {
            throw new Error(`The ${queued.attendance_date} register is ${activeSession.status} and cannot accept queued marks.`);
          }
          if (canManage) {
            const { error: updateError } = await client.from('attendance_sessions').update({
              academic_year_id: queued.academic_year_id,
              term_id: queued.term_id,
              non_school_day_override: queued.non_school_day_override,
              override_reason: queued.override_reason,
            }).eq('school_id', queued.school_id).eq('id', activeSession.id);
            if (updateError) throw updateError;
          }
          const updates = queued.records.map((record) => ({
            school_id: queued.school_id,
            session_id: activeSession.id,
            ...record,
          }));
          const { error: recordsError } = await client.from('attendance_records')
            .upsert(updates, { onConflict: 'session_id,student_id' });
          if (recordsError) throw recordsError;
          syncedItems.set(queued.key, queued.queued_at);
        } catch (itemError) {
          syncFailure = explainError(itemError, 'Could not sync an attendance register.');
          break;
        }
      }
      if (syncedItems.size) {
        setOfflineQueue((current) => current.filter((item) => syncedItems.get(item.key) !== item.queued_at));
        if (syncFailure) {
          setError(`${syncedItems.size} queued register(s) synced. The remaining queue was kept on this device: ${syncFailure}`);
        } else {
          setNotice(`${syncedItems.size} queued attendance register${syncedItems.size === 1 ? '' : 's'} synced.`);
          await Promise.all([loadRegister(), loadHistory()]);
        }
      } else if (syncFailure) {
        setError(`Attendance sync is still pending; the queue was kept on this device. ${syncFailure}`);
      }
    } catch (queueError) {
      setError(explainError(queueError, 'Could not sync the saved attendance queue.'));
    } finally {
      queueSyncInFlight.current = false;
      setSyncingQueue(false);
    }
  }, [isOnline, schoolId, user, pendingAttendanceQueue, canManage, loadRegister, loadHistory]);

  useEffect(() => {
    if (isOnline) void syncAttendanceQueue();
  }, [isOnline, syncAttendanceQueue]);

  async function transitionSession(nextStatus: 'submitted' | 'closed' | 'open') {
    if (!session) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: transitionError } = await requireSupabase().rpc('transition_attendance_session', {
        target_session: session.id,
        target_status: nextStatus,
      });
      if (transitionError) throw transitionError;
      setNotice(nextStatus === 'submitted' ? 'Register submitted for review.' : nextStatus === 'closed' ? 'Register closed and locked.' : 'Register reopened for correction.');
      await Promise.all([loadRegister(), loadHistory()]);
    } catch (transitionError) {
      setError(explainError(transitionError, 'Could not update register status.'));
    } finally {
      setSaving(false);
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !canManage) return;
    if (Number(attendanceWarning) > Number(attendanceTarget)) {
      setError('The warning threshold cannot be higher than the attendance target.');
      return;
    }
    if (!statusSettings.some((item) => item.enabled)) {
      setError('Enable at least one attendance status.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const client = requireSupabase();
      const { error: settingsError } = await client.from('attendance_settings').upsert({
        school_id: schoolId,
        default_session_type: defaultSessionType === 'lesson' ? 'daily' : defaultSessionType,
        late_after: lateAfter || null,
        require_complete_register: requireComplete,
        allow_parent_explanations: parentExplanationsEnabled,
        notify_on_absence: notifyAbsence,
        notify_on_late: notifyLate,
        attendance_target_percent: Number(attendanceTarget),
        attendance_warning_percent: Number(attendanceWarning),
        repeated_absence_threshold: Number(repeatedAbsenceThreshold),
        consecutive_absence_threshold: Number(consecutiveAbsenceThreshold),
        auto_lock_after_days: autoLockAfterDays ? Number(autoLockAfterDays) : null,
        late_to_absence_after_minutes: lateToAbsenceMinutes ? Number(lateToAbsenceMinutes) : null,
        attendance_calculation_basis: calculationBasis,
        excused_counts_as_present: excusedCountsAsPresent,
        updated_by: user?.id,
      }, { onConflict: 'school_id' });
      if (settingsError) throw settingsError;
      const { error: statusError } = await client.from('attendance_status_settings').upsert(
        statusSettings.map((item) => ({ school_id: schoolId, ...item })),
        { onConflict: 'school_id,status' },
      );
      if (statusError) throw statusError;
      setNotice('Attendance defaults and status options saved.');
    } catch (saveError) {
      setError(explainError(saveError, 'Could not save attendance settings.'));
    } finally {
      setSaving(false);
    }
  }

  async function submitExplanation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !user || !explanationChild || !explanationText.trim()) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const childClassId = children.find((child) => child.id === explanationChild)?.class_id;
      const { data: linkedSession, error: sessionLookupError } = childClassId
        ? await requireSupabase().from('attendance_sessions').select('id')
          .eq('school_id', schoolId).eq('class_id', childClassId).eq('attendance_date', explanationDate)
          .in('session_type', ['daily', 'morning', 'afternoon']).order('session_type').limit(1).maybeSingle()
        : { data: null, error: null };
      if (sessionLookupError) throw sessionLookupError;
      const { error: insertError } = await requireSupabase().from('attendance_parent_explanations').insert({
        school_id: schoolId,
        student_id: explanationChild,
        attendance_date: explanationDate,
        session_id: linkedSession?.id ?? null,
        category: explanationCategory,
        explanation: explanationText.trim(),
        created_by: user.id,
      });
      if (insertError) throw insertError;
      setExplanationText('');
      setNotice('Absence explanation sent to the school for review.');
      await loadPersonalHistory();
    } catch (submitError) {
      setError(explainError(submitError, 'Could not submit the absence explanation.'));
    } finally {
      setSaving(false);
    }
  }

  async function reviewExplanation(id: string, decision: 'approved' | 'rejected') {
    setSaving(true);
    setError('');
    try {
      const { error: reviewError } = await requireSupabase().rpc('review_attendance_explanation', {
        target_explanation: id,
        decision,
        note: null,
      });
      if (reviewError) throw reviewError;
      setNotice(`Absence explanation ${decision}.`);
      await loadExplanations();
    } catch (reviewError) {
      setError(explainError(reviewError, 'Could not review this explanation.'));
    } finally {
      setSaving(false);
    }
  }

  const filteredReportRecords = useMemo(() => {
    const studentById = new Map(reportStudents.map((student) => [student.id, student]));
    return reportRecords.filter((record) => {
      if (selectedStatus && record.status !== selectedStatus) return false;
      const student = studentById.get(record.student_id);
      const name = `${student?.first_name ?? ''} ${student?.last_name ?? ''} ${student?.student_number ?? ''}`.toLowerCase();
      return name.includes(searchText.trim().toLowerCase());
    });
  }, [reportRecords, reportStudents, selectedStatus, searchText]);
  const calculationRecords = reportRecords.filter((record) => {
    const recordSession = historySessions.find((item) => item.id === record.session_id);
    return calculationBasis === 'lesson'
      ? recordSession?.session_type === 'lesson'
      : recordSession?.session_type !== 'lesson';
  });
  const attendancePercent = calculationRecords.length
    ? Math.round(calculationRecords.filter((record) => statusSettings.find((item) => item.status === record.status)?.counts_as_present
      || (record.status === 'excused' && excusedCountsAsPresent)).length / calculationRecords.length * 100)
    : 0;
  const calendarMonthDate = new Date(`${date.slice(0, 7)}-01T12:00:00`);
  const calendarDaysCount = new Date(calendarMonthDate.getFullYear(), calendarMonthDate.getMonth() + 1, 0).getDate();
  const calendarLeadingDays = (calendarMonthDate.getDay() + 6) % 7;
  const calendarCells: (number | null)[] = [
    ...Array.from({ length: calendarLeadingDays }, () => null),
    ...Array.from({ length: calendarDaysCount }, (_, index) => index + 1),
  ];

  function exportReport() {
    const studentById = new Map(reportStudents.map((student) => [student.id, student]));
    const sessionById = new Map(historySessions.map((item) => [item.id, item]));
    downloadCsv('attendance-report.csv', [
      ['Date', 'Class', 'Session', 'Term', 'Student ID', 'Student', 'Status', 'Absence category', 'Reason', 'Arrival time'],
      ...filteredReportRecords.map((record) => {
        const student = studentById.get(record.student_id);
        const recordSession = sessionById.get(record.session_id);
        return [
          recordSession?.attendance_date,
          relation(recordSession?.school_class)?.name,
          sessionTypes.find((item) => item.value === recordSession?.session_type)?.label ?? recordSession?.session_type,
          terms.find((term) => term.id === recordSession?.term_id)?.name,
          student?.student_number,
          `${student?.first_name ?? ''} ${student?.last_name ?? ''}`.trim(),
          statusSettings.find((item) => item.status === record.status)?.label ?? record.status,
          record.absence_category,
          record.absence_reason,
          record.arrival_time,
        ];
      }),
    ]);
  }

  const pageTabs: { id: Tab; label: string }[] = canRecord
    ? [
      { id: 'register', label: 'Take attendance' },
      { id: 'history', label: 'History' },
      { id: 'reports', label: 'Reports' },
      { id: 'advanced', label: 'Automation & workflows' },
      { id: 'explanations', label: 'Absence explanations' },
      ...(canManage ? [{ id: 'settings' as const, label: 'Attendance setup' }] : []),
    ]
    : [
    { id: 'my-attendance', label: role === 'parent' ? "Children's attendance" : 'My attendance' },
    ...(role === 'parent' || role === 'student' ? [{ id: 'advanced' as const, label: 'Leave & corrections' }] : []),
    ];

  if (loading) return <LoadingState label="Loading attendance workspace…" />;

  return (
    <div className="page-stack attendance-page">
      <div className="page-heading">
        <div><span className="eyebrow">{activeMembership?.school.name}</span><h1>Attendance</h1><p>Record, review, and report attendance for your school community.</p></div>
        {canRecord && <span className="date-chip"><ClipboardCheck size={16} />{counts.present} present · {unmarkedCount} unmarked</span>}
      </div>
      <div className="attendance-tabs" role="tablist" aria-label="Attendance sections">
        {pageTabs.map((item) => <button type="button" key={item.id} role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}</button>)}
      </div>
      {error && <ErrorState message={error} />}
      {notice && <SuccessMessage message={notice} />}
      {canRecord && (pendingAttendanceQueue.length > 0 || !isOnline) && <section className="content-card attendance-sync-queue" aria-live="polite">
        <div className="attendance-sync-queue-heading">
          <div><span className={`attendance-connection-indicator${isOnline ? ' is-online' : ''}`} />
            <div><strong>{isOnline ? `${pendingAttendanceQueue.length} register${pendingAttendanceQueue.length === 1 ? '' : 's'} waiting to sync` : 'You are offline'}</strong>
              <p>{isOnline ? 'Queued attendance details are kept in this browser until saved to the school register.' : 'Mark a register already loaded on this device; queued details sync when the connection returns. Avoid shared devices.'}</p>
            </div>
          </div>
          <button type="button" className="button button-quiet" onClick={() => void syncAttendanceQueue()} disabled={!isOnline || syncingQueue || !pendingAttendanceQueue.length}>
            <Save size={14} />{syncingQueue ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
        {!!pendingAttendanceQueue.length && <ul>{pendingAttendanceQueue.map((item) => <li key={item.key}>
          <span><strong>{classes.find((schoolClass) => schoolClass.id === item.class_id)?.name ?? 'Class'}</strong> · {item.attendance_date} · {sessionTypes.find((type) => type.value === item.session_type)?.label ?? item.session_type}</span>
          <small>{item.records.length} marked student{item.records.length === 1 ? '' : 's'}</small>
        </li>)}</ul>}
      </section>}

      {canRecord && tab === 'register' && <>
        <section className="content-card attendance-controls attendance-setup-controls">
          <label className="attendance-control-field"><span>Class</span><select value={classId} onChange={(event) => {
            const nextClass = classes.find((item) => item.id === event.target.value);
            setClassId(event.target.value);
            setYearId(nextClass?.academic_year_id ?? '');
            setTermId('');
          }}><option value="">Choose a class</option>{classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label className="attendance-control-field"><span>Attendance date</span><input className="date-input-wrap" type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
          <label className="attendance-control-field"><span>Session type</span><select value={sessionType} onChange={(event) => { setSessionType(event.target.value as SessionType); setSession(null); }}>{
            sessionTypes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)
          }</select></label>
          {sessionType === 'lesson' && <label className="attendance-control-field"><span>Lesson</span><select value={lessonId} onChange={(event) => { setLessonId(event.target.value); setSession(null); }}><option value="">Choose lesson</option>{lessons.map((lesson) => <option key={lesson.id} value={lesson.id}>{lesson.starts_at.slice(0, 5)} · {relation(lesson.subject)?.name ?? 'Lesson'}</option>)}</select></label>}
          <label className="attendance-control-field"><span>Academic year</span><select value={yearId} onChange={(event) => { setYearId(event.target.value); setTermId(''); }}><option value="">Class default / none</option>{relevantYears.map((year) => <option key={year.id} value={year.id}>{year.name}</option>)}</select></label>
          <label className="attendance-control-field"><span>Term</span><select value={termId} onChange={(event) => setTermId(event.target.value)}><option value="">Auto / no term</option>{relevantTerms.map((term) => <option key={term.id} value={term.id}>{term.name}</option>)}</select></label>
        </section>
        {canManage && <section className="attendance-override">
          <label><input type="checkbox" checked={overrideDay} onChange={(event) => setOverrideDay(event.target.checked)} /><span>Authorized exception: allow attendance on a non-school day</span></label>
          {overrideDay && <input value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} maxLength={300} required placeholder="Reason for the exception (required)" />}
        </section>}
        <section className="attendance-summary-strip" aria-label="Register totals">
          <div><strong>{students.length}</strong><span>Enrolled</span></div>
          {enabledStatuses.map((item) => <div key={item.status}><strong>{counts[item.status]}</strong><span>{item.label}</span></div>)}
          <div className={unmarkedCount ? 'attendance-unmarked' : ''}><strong>{unmarkedCount}</strong><span>Unmarked</span></div>
        </section>
        {session && <section className={`attendance-session-banner attendance-session-${session.status}`}>
          <div><strong>{sessionTypes.find((item) => item.value === session.session_type)?.label} · {session.status}</strong><span>{session.submitted_at ? `Submitted ${new Date(session.submitted_at).toLocaleString()}` : 'Draft register; edits are saved as they are recorded.'}</span></div>
          <div className="attendance-session-actions">
            {session.status === 'open' && <button type="button" className="button button-primary" onClick={() => void transitionSession('submitted')} disabled={!isOnline || saving || (requireComplete && unmarkedCount > 0)}><Send size={15} />Submit register</button>}
            {session.status === 'submitted' && canManage && <><button type="button" className="button button-quiet" onClick={() => void transitionSession('open')} disabled={!isOnline || saving}>Reopen for correction</button><button type="button" className="button button-primary" onClick={() => void transitionSession('closed')} disabled={!isOnline || saving}><Check size={15} />Close and lock</button></>}
            {session.status === 'closed' && <span className="attendance-lock-label"><Check size={14} />Locked</span>}
          </div>
        </section>}
        {!classes.length ? <section className="content-card"><EmptyState title="No assigned classes" detail={canManage ? 'Create a class and enroll students to start taking attendance.' : 'Ask an administrator to assign you to a class.'} /></section>
          : !classId ? <section className="content-card"><EmptyState title="Choose a class" detail="Select a class and date to open its register." /></section>
            : loadingRoster ? <LoadingState label="Loading enrolled students and saved records…" />
              : !students.length ? <section className="content-card"><EmptyState title="No enrolled students" detail="Students are loaded from the class roster. Add enrollments before taking attendance." /></section>
                : <form className="content-card attendance-table-card" onSubmit={(event) => void saveRegister(event)}>
                  <div className="attendance-table-heading"><div><span className="eyebrow">{selectedClass?.name}</span><h2>Class register</h2></div><div className="attendance-heading-actions"><span className="attendance-date-label">{new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</span><button type="button" className="button button-quiet" onClick={() => window.print()}><Printer size={15} />Print</button></div></div>
                  {!readOnlyRegister && <div className="attendance-bulk-actions"><span>Mark all students:</span>{enabledStatuses.map((item) => <button type="button" key={item.status} className={`status-option status-${item.status}`} onClick={() => setStudents((current) => current.map((student) => ({ ...student, status: item.status })))}>{item.label}</button>)}</div>}
                  <div className="table-scroll"><table><thead><tr><th>Student</th><th>Student ID</th><th>Attendance status</th><th>Arrival / departure</th><th>Absence reason</th><th>Staff note</th></tr></thead><tbody>{students.map((student) => <tr key={student.id}>
                    <td><strong>{student.first_name} {student.last_name}</strong></td><td className="mono-cell">{student.student_number}</td>
                    <td><div className="status-selector"><button type="button" className={`status-option status-unmarked${!student.status ? ' selected' : ''}`} aria-label={`Clear attendance status for ${student.first_name} ${student.last_name}`} onClick={() => updateStudent(student.id, { status: '' })} disabled={readOnlyRegister}>Clear</button>{enabledStatuses.map((item) => <button type="button" key={item.status} className={`status-option status-${item.status}${student.status === item.status ? ' selected' : ''}`} aria-pressed={student.status === item.status} onClick={() => updateStudent(student.id, { status: item.status })} disabled={readOnlyRegister}>{item.label}</button>)}</div></td>
                    <td><div className="attendance-time-fields"><label><span>In</span><input type="time" value={student.arrival_time} onChange={(event) => updateStudent(student.id, { arrival_time: event.target.value, ...(lateAfter && event.target.value > lateAfter ? { status: 'late' as const } : {}) })} disabled={readOnlyRegister} aria-label={`${student.first_name} arrival time`} /></label><label><span>Out</span><input type="time" value={student.departure_time} onChange={(event) => updateStudent(student.id, { departure_time: event.target.value })} disabled={readOnlyRegister} aria-label={`${student.first_name} departure time`} /></label></div></td>
                    <td><div className="attendance-reason-fields"><select value={student.absence_category} onChange={(event) => updateStudent(student.id, { absence_category: event.target.value as AbsenceCategory })} disabled={readOnlyRegister || !['absent', 'excused'].includes(student.status)} aria-label={`${student.first_name} absence category`}>{absenceCategories.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select><input value={student.absence_reason} onChange={(event) => updateStudent(student.id, { absence_reason: event.target.value })} maxLength={500} placeholder="Reason" disabled={readOnlyRegister || !['absent', 'excused'].includes(student.status)} aria-label={`${student.first_name} absence reason`} /></div></td>
                    <td><input className="attendance-note-input" value={student.note} onChange={(event) => updateStudent(student.id, { note: event.target.value })} maxLength={500} placeholder="Optional staff note" disabled={readOnlyRegister} aria-label={`${student.first_name} staff note`} /></td>
                  </tr>)}</tbody></table></div>
                  <div className="attendance-form-footer"><span>{students.length} enrolled · {unmarkedCount} unmarked{requireComplete ? ' · all students required to submit' : ''}</span><div className="attendance-session-actions"><button type="submit" className="button button-primary" disabled={saving || readOnlyRegister || !students.some((student) => student.status)}><Save size={15} />{saving ? 'Saving…' : !isOnline ? 'Queue offline marks' : session ? 'Save changes' : 'Open and save register'}</button></div></div>
                </form>}
      </>}

      {canRecord && tab === 'history' && <section className="content-card attendance-history-card">
        <div className="attendance-report-filters"><label>Class<select value={reportClassId} onChange={(event) => setReportClassId(event.target.value)}>{canManage && <option value="">All classes</option>}{classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>From<input type="date" value={rangeStart} onChange={(event) => setRangeStart(event.target.value)} /></label><label>To<input type="date" value={rangeEnd} onChange={(event) => setRangeEnd(event.target.value)} /></label></div>
        <div className="attendance-calendar-panel">
          <div className="attendance-calendar-heading"><strong>{calendarMonthDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</strong><span>Attendance session dates</span></div>
          <div className="attendance-calendar-grid">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((weekday) => <span className="attendance-calendar-weekday" key={weekday}>{weekday}</span>)}{calendarCells.map((day, cellIndex) => {
            const calendarDate = day ? `${date.slice(0, 7)}-${String(day).padStart(2, '0')}` : '';
            const daySessions = historySessions.filter((item) => item.attendance_date === calendarDate);
            const daySessionIds = new Set(daySessions.map((item) => item.id));
            const dayRecords = reportRecords.filter((record) => daySessionIds.has(record.session_id));
            const statusSummary = [
              `P${dayRecords.filter((record) => record.status === 'present').length}`,
              `A${dayRecords.filter((record) => record.status === 'absent').length}`,
              `L${dayRecords.filter((record) => record.status === 'late').length}`,
              `E${dayRecords.filter((record) => record.status === 'excused').length}`,
            ].join(' · ');
            return <div key={`day-${cellIndex}`} className={`attendance-calendar-day${calendarDate === date ? ' selected' : ''}`}>
              {day ? <button type="button" onClick={() => { setDate(calendarDate); if (daySessions[0]) setClassId(daySessions[0].class_id); }} aria-label={`${calendarDate}, ${daySessions.length} sessions${dayRecords.length ? `, ${statusSummary}` : ''}`} title={statusSummary}>{day}<small>{daySessions.length ? statusSummary : ''}</small></button> : <span />}
            </div>;
          })}</div>
        </div>
        <div className="table-scroll"><table><thead><tr><th>Date</th><th>Session</th><th>Academic term</th><th>State</th><th>Marked</th><th>Actions</th><th>Class</th></tr></thead><tbody>{historySessions.map((item) => {
          const marked = reportRecords.filter((record) => record.session_id === item.id).length;
          const classRelation = relation(item.school_class);
          return <tr key={item.id}><td>{item.attendance_date}</td><td>{sessionTypes.find((type) => type.value === item.session_type)?.label ?? item.session_type}{item.lesson_entry_id ? ' · lesson' : ''}</td><td>{terms.find((term) => term.id === item.term_id)?.name ?? '—'}</td><td><span className={`attendance-state-chip state-${item.status}`}>{item.status}</span></td><td>{marked}</td><td><button type="button" className="button button-quiet" onClick={() => { setClassId(item.class_id); setDate(item.attendance_date); setSessionType(item.session_type); if (item.lesson_entry_id) setLessonId(item.lesson_entry_id); setTab('register'); }}><FileClock size={14} />Open register</button></td><td className="attendance-history-class">{classRelation?.name ?? ''}</td></tr>;
        })}</tbody></table></div>
        {!historySessions.length && <EmptyState title="No attendance sessions in this range" detail="Choose a different date range or record a register to build attendance history." />}
        {!!historySessions.length && <div className="attendance-audit-section">
          <div><span className="eyebrow">Accountability</span><h3>Recent attendance changes</h3></div>
          {auditEntries.length ? <div className="table-scroll"><table><thead><tr><th>When</th><th>Action</th><th>Class</th><th>Date</th></tr></thead><tbody>{auditEntries.map((item) => {
            const auditSession = historySessions.find((row) => row.id === item.session_id);
            return <tr key={item.id}><td>{new Date(item.created_at).toLocaleString()}</td><td>{item.action.replaceAll('_', ' ')}</td><td>{relation(auditSession?.school_class)?.name ?? '—'}</td><td>{auditSession?.attendance_date ?? '—'}</td></tr>;
          })}</tbody></table></div> : <p>No audited changes in this range.</p>}
          <div className="attendance-notification-history"><h3>Parent and student notifications</h3>{notificationEntries.length ? <p>{notificationEntries.length} in-app attendance notice(s) recorded for this range. Recipients can view notifications from their account.</p> : <p>No attendance notices were sent in this range.</p>}</div>
        </div>}
      </section>}

      {canRecord && tab === 'reports' && <section className="content-card attendance-report-card">
        <div className="attendance-report-filters"><label>Class<select value={reportClassId} onChange={(event) => setReportClassId(event.target.value)}>{canManage && <option value="">All classes</option>}{classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>From<input type="date" value={rangeStart} onChange={(event) => setRangeStart(event.target.value)} /></label><label>To<input type="date" value={rangeEnd} onChange={(event) => setRangeEnd(event.target.value)} /></label><label>Status<select value={selectedStatus} onChange={(event) => setSelectedStatus(event.target.value)}><option value="">All statuses</option>{enabledStatuses.map((item) => <option key={item.status} value={item.status}>{item.label}</option>)}</select></label><label>Search student<input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Name or student ID" /></label></div>
        <div className="attendance-report-summary"><div><strong>{attendancePercent}%</strong><span>Attendance rate</span></div><div><strong>{reportRecords.length}</strong><span>Records in range</span></div><div><strong>{reportRecords.filter((record) => record.status === 'absent' && record.absence_category === 'unexplained').length}</strong><span>Unexplained absences</span></div><div><strong>{reportRecords.filter((record) => record.status === 'late').length}</strong><span>Late arrivals</span></div></div>
        <div className="attendance-report-toolbar"><span>{filteredReportRecords.length} matching records</span><div><button type="button" className="button button-quiet" onClick={exportReport}><Download size={15} />Export CSV</button><button type="button" className="button button-quiet" onClick={() => window.print()}><Printer size={15} />Print / PDF</button></div></div>
        <div className="table-scroll"><table><thead><tr><th>Student</th><th>Student ID</th><th>Class</th><th>Date</th><th>Session</th><th>Status</th><th>Category / reason</th><th>Arrival</th></tr></thead><tbody>{filteredReportRecords.map((record, index) => {
          const student = reportStudents.find((item) => item.id === record.student_id);
          const itemSession = historySessions.find((item) => item.id === record.session_id);
          return <tr key={`${record.session_id}:${record.student_id}:${index}`}><td>{student ? `${student.first_name} ${student.last_name}` : 'Student'}</td><td>{student?.student_number}</td><td>{relation(itemSession?.school_class)?.name ?? '—'}</td><td>{itemSession?.attendance_date}</td><td>{itemSession?.session_type}</td><td>{statusSettings.find((item) => item.status === record.status)?.label ?? record.status}</td><td>{record.status === 'absent' || record.status === 'excused' ? `${record.absence_category}${record.absence_reason ? ` · ${record.absence_reason}` : ''}` : '—'}</td><td>{record.arrival_time?.slice(0, 5) ?? '—'}</td></tr>;
        })}</tbody></table></div>
      </section>}

      {canRecord && tab === 'explanations' && <section className="content-card attendance-explanations-card">
        <div className="attendance-table-heading"><div><span className="eyebrow">Parent and guardian submissions</span><h2>Absence explanations awaiting review</h2></div></div>
        {explanations.length ? <div className="table-scroll"><table><thead><tr><th>Student</th><th>Date</th><th>Category</th><th>Explanation</th><th>Submitted</th><th>Review</th></tr></thead><tbody>{explanations.map((item) => {
          const student = relation(item.students);
          return <tr key={item.id}><td>{student ? `${student.first_name} ${student.last_name} · ${student.student_number}` : 'Student'}</td><td>{item.attendance_date}</td><td>{item.category}</td><td>{item.explanation}</td><td>{new Date(item.created_at).toLocaleDateString()}</td><td><div className="attendance-session-actions"><button type="button" className="button button-primary" onClick={() => void reviewExplanation(item.id, 'approved')} disabled={saving}>Approve</button><button type="button" className="button button-quiet" onClick={() => void reviewExplanation(item.id, 'rejected')} disabled={saving}>Reject</button></div></td></tr>;
        })}</tbody></table></div> : <EmptyState title="No explanations awaiting review" detail="Parent-submitted absence explanations will appear here." />}
      </section>}

      {tab === 'advanced' && schoolId && user && role && role !== 'system_admin' && <AttendanceAutomationPanel
        schoolId={schoolId}
        userId={user.id}
        role={role}
        active
        classes={classes.map((item) => ({ id: item.id, name: item.name }))}
      />}

      {canManage && tab === 'settings' && <form className="content-card attendance-settings-card" onSubmit={(event) => void saveSettings(event)}>
        <div className="attendance-table-heading"><div><span className="eyebrow"><Settings2 size={14} /> School policy</span><h2>Attendance defaults</h2></div></div>
        <div className="attendance-settings-grid"><label>Default session type<select value={defaultSessionType} onChange={(event) => setDefaultSessionType(event.target.value as SessionType)}>{sessionTypes.filter((item) => item.value !== 'lesson').map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><label>Late threshold (optional)<input type="time" value={lateAfter} onChange={(event) => setLateAfter(event.target.value)} /></label></div>
        <label className="attendance-setting-check"><input type="checkbox" checked={requireComplete} onChange={(event) => setRequireComplete(event.target.checked)} />Require every enrolled student to be marked before submission</label>
        <label className="attendance-setting-check"><input type="checkbox" checked={parentExplanationsEnabled} onChange={(event) => setParentExplanationsEnabled(event.target.checked)} />Accept parent and guardian absence explanations</label>
        <label className="attendance-setting-check"><input type="checkbox" checked={notifyAbsence} onChange={(event) => setNotifyAbsence(event.target.checked)} />Send in-app notifications to linked students and guardians when marked absent</label>
        <label className="attendance-setting-check"><input type="checkbox" checked={notifyLate} onChange={(event) => setNotifyLate(event.target.checked)} />Send in-app notifications to linked students and guardians when marked late</label>
        <h3>Attendance automation and calculations</h3>
        <div className="attendance-settings-grid">
          <label>Attendance target (%)<input type="number" min="0" max="100" step="0.1" value={attendanceTarget} onChange={(event) => setAttendanceTarget(event.target.value)} required /></label>
          <label>Warning threshold (%)<input type="number" min="0" max="100" step="0.1" value={attendanceWarning} onChange={(event) => setAttendanceWarning(event.target.value)} required /></label>
          <label>Repeated absences (last 30 days)<input type="number" min="2" max="30" value={repeatedAbsenceThreshold} onChange={(event) => setRepeatedAbsenceThreshold(event.target.value)} required /></label>
          <label>Consecutive school-day absences<input type="number" min="2" max="30" value={consecutiveAbsenceThreshold} onChange={(event) => setConsecutiveAbsenceThreshold(event.target.value)} required /></label>
          <label>Automatic lock after submission (days)<input type="number" min="1" max="90" value={autoLockAfterDays} onChange={(event) => setAutoLockAfterDays(event.target.value)} placeholder="Disabled" /></label>
          <label>Convert very late arrivals to absent after (minutes)<input type="number" min="30" max="360" value={lateToAbsenceMinutes} onChange={(event) => setLateToAbsenceMinutes(event.target.value)} placeholder="Disabled" /></label>
          <label>Attendance calculation basis<select value={calculationBasis} onChange={(event) => setCalculationBasis(event.target.value as 'daily' | 'lesson')}><option value="daily">Daily / registration</option><option value="lesson">Lesson level</option></select></label>
        </div>
        <label className="attendance-setting-check"><input type="checkbox" checked={excusedCountsAsPresent} onChange={(event) => setExcusedCountsAsPresent(event.target.checked)} />Count excused attendance toward the attendance percentage</label>
        <h3>Permitted attendance statuses</h3><div className="attendance-status-settings">{statusSettings.map((item) => <div key={item.status}><label><input type="checkbox" checked={item.enabled} onChange={(event) => setStatusSettings((current) => current.map((status) => status.status === item.status ? { ...status, enabled: event.target.checked } : status))} /><strong>{item.status}</strong></label><input aria-label={`${item.status} label`} value={item.label} maxLength={30} onChange={(event) => setStatusSettings((current) => current.map((status) => status.status === item.status ? { ...status, label: event.target.value } : status))} /><label><input type="checkbox" checked={item.counts_as_present} onChange={(event) => setStatusSettings((current) => current.map((status) => status.status === item.status ? { ...status, counts_as_present: event.target.checked } : status))} />Counts toward attendance</label><input aria-label={`${item.label} display order`} type="number" min="0" max="99" value={item.sort_order} onChange={(event) => setStatusSettings((current) => current.map((status) => status.status === item.status ? { ...status, sort_order: Number(event.target.value) } : status))} /></div>)}</div>
        <div className="attendance-form-footer"><span>Threshold scans and automatic locking run when staff use Run follow-up scan in the advanced attendance workspace.</span><button className="button button-primary" type="submit" disabled={saving}><Save size={15} />{saving ? 'Saving…' : 'Save attendance setup'}</button></div>
      </form>}

      {canSeePersonal && tab === 'my-attendance' && <>
        {role === 'parent' && <div className="content-card attendance-report-filters"><label>Child<select value={selectedChildId} onChange={(event) => setSelectedChildId(event.target.value)}>{children.map((child) => <option key={child.id} value={child.id}>{child.first_name} {child.last_name} · {child.student_number}</option>)}</select></label></div>}
        <section className="content-card attendance-personal-card">
          {myRecords.length ? <div className="table-scroll"><table><thead><tr><th>Date</th><th>Class</th><th>Session</th><th>Term</th><th>Status</th><th>Reason / note</th><th>Arrival</th><th>Departure</th></tr></thead><tbody>{myRecords.map((raw) => {
            const record = raw as { id: string; status: Status; absence_reason: string | null; note: string | null; arrival_time: string | null; departure_time: string | null; session: { attendance_date: string; session_type: string; term: { name: string } | { name: string }[] | null; school_class: { name: string } | { name: string }[] | null } | null };
            return <tr key={record.id}><td>{record.session?.attendance_date}</td><td>{relation(record.session?.school_class)?.name ?? '—'}</td><td>{sessionTypes.find((item) => item.value === record.session?.session_type)?.label ?? record.session?.session_type}</td><td>{relation(record.session?.term)?.name ?? '—'}</td><td>{statusSettings.find((item) => item.status === record.status)?.label ?? record.status}</td><td>{record.absence_reason ?? record.note ?? '—'}</td><td>{record.arrival_time?.slice(0, 5) ?? '—'}</td><td>{record.departure_time?.slice(0, 5) ?? '—'}</td></tr>;
          })}</tbody></table></div> : <EmptyState title="No attendance history yet" detail="Attendance records will appear here when your school has recorded them." />}
        </section>
        {role === 'parent' && parentExplanationsEnabled && <form className="content-card attendance-explanation-form" onSubmit={(event) => void submitExplanation(event)}>
          <div><span className="eyebrow"><UserRoundCheck size={14} /> Parent / guardian</span><h2>Report an absence</h2><p>Send an explanation to the school office for review.</p></div>
          <div className="attendance-settings-grid"><label>Child<select required value={explanationChild} onChange={(event) => setExplanationChild(event.target.value)}>{children.map((child) => <option key={child.id} value={child.id}>{child.first_name} {child.last_name}</option>)}</select></label><label>Date<input required type="date" value={explanationDate} onChange={(event) => setExplanationDate(event.target.value)} /></label><label>Category<select value={explanationCategory} onChange={(event) => setExplanationCategory(event.target.value as Exclude<AbsenceCategory, 'unexplained'>)}><option value="medical">Medical</option><option value="authorized">Authorized</option><option value="other">Other</option></select></label></div>
          <label>Explanation<textarea required minLength={3} maxLength={1000} rows={4} value={explanationText} onChange={(event) => setExplanationText(event.target.value)} placeholder="Tell the school why your child was absent." /></label><button className="button button-primary" type="submit" disabled={saving || !children.length}><Send size={15} />Submit explanation</button>
        </form>}
        {role === 'parent' && <section className="content-card attendance-parent-history">
          <div><span className="eyebrow">Parent / guardian</span><h2>Explanation and notification history</h2></div>
          <div className="table-scroll"><table><thead><tr><th>Date</th><th>Type</th><th>Details</th><th>State</th></tr></thead><tbody>
            {myExplanations.map((item) => <tr key={`explanation-${item.id}`}><td>{item.attendance_date}</td><td>Absence explanation</td><td>{item.category}: {item.explanation}{item.review_note ? ` · ${item.review_note}` : ''}</td><td><span className={`attendance-state-chip state-${item.status}`}>{item.status}</span></td></tr>)}
            {myNotifications.map((item) => <tr key={`notice-${item.id}`}><td>{relation(item.session)?.attendance_date ?? new Date(item.created_at).toLocaleDateString()}</td><td>Attendance notice</td><td>{item.notification_type === 'absent' ? 'Absence' : 'Late arrival'} notice sent to this account</td><td>Sent in app</td></tr>)}
          </tbody></table></div>
          {!myExplanations.length && !myNotifications.length && <p>No explanations or attendance notifications yet.</p>}
        </section>}
        {role === 'student' && !!myNotifications.length && <section className="content-card attendance-parent-history">
          <div><span className="eyebrow">Notifications</span><h2>Attendance notification history</h2></div>
          <div className="table-scroll"><table><thead><tr><th>Date</th><th>Notification</th><th>Delivered</th></tr></thead><tbody>{myNotifications.map((item) => <tr key={item.id}><td>{relation(item.session)?.attendance_date ?? new Date(item.created_at).toLocaleDateString()}</td><td>{item.notification_type === 'absent' ? 'Absence' : 'Late arrival'}</td><td>In app</td></tr>)}</tbody></table></div>
        </section>}
      </>}
    </div>
  );
}
