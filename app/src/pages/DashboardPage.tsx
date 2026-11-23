import { useEffect, useState } from 'react';
import { ArrowUpRight, BookMarked, CalendarDays, CalendarRange, ClipboardCheck, GraduationCap, Globe, Users, UsersRound, CircleDollarSign, UserRoundPlus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { requireSupabase } from '../lib/supabase';
import { resolveTimeZone } from '../lib/timezone';
import type { DashboardSummary } from '../types/database';
import { ErrorState, LoadingState } from '../components/Feedback';
import { TeacherDashboardPage } from './TeacherDashboardPage';

interface AttendanceRegister {
  class_id: string;
  session_type: 'daily' | 'morning' | 'afternoon';
  status: 'open' | 'submitted' | 'closed';
  attendance_records: { status: string }[] | null;
}

interface DashboardClass {
  id: string;
  name: string;
  calendar_id: string;
  academic_year_id: string | null;
}

interface DashboardAcademicContext {
  academicYear: string | null;
  term: string | null;
  dayStatus: 'school' | 'holiday' | 'non-school' | 'unknown';
  eventTitle: string | null;
}

const emptyAcademicContext: DashboardAcademicContext = {
  academicYear: null,
  term: null,
  dayStatus: 'unknown',
  eventTitle: null,
};

interface AcademicYear {
  id: string;
  calendar_id: string;
}

interface TimetableSchedule {
  id: string;
  calendar_id: string;
  academic_year_id: string | null;
  week_pattern_id: string;
  cycle_weeks: number;
}

interface CalendarWeek {
  calendar_id: string;
  academic_year_id: string;
  pattern_id: string;
  week_number: number;
}

interface PatternDay {
  pattern_id: string;
  day_of_week: number;
  is_open: boolean;
}

interface CalendarDate {
  calendar_id: string;
  lessons_allowed: boolean;
}

interface TimetableEntry {
  id: string;
  schedule_id: string;
  class_id: string | null;
  entry_type: 'lesson' | 'registration' | 'break' | 'lunch' | 'other';
  day_of_week: number;
  cycle_week: number;
}

interface TimetableDateOverride {
  schedule_id: string;
  action: 'add' | 'replace' | 'cancel';
  original_entry_id: string | null;
  entry_type: TimetableEntry['entry_type'];
  class_id: string | null;
}

interface TodayAttendanceSummary {
  expectedClasses: number;
  submitted: number;
  outstanding: number;
  present: number;
  absent: number;
  late: number;
  outstandingClasses: DashboardClass[];
  firstExpectedClassId: string | null;
  sessionType: 'daily' | 'morning' | 'afternoon';
}

const emptyTodayAttendance: TodayAttendanceSummary = {
  expectedClasses: 0,
  submitted: 0,
  outstanding: 0,
  present: 0,
  absent: 0,
  late: 0,
  outstandingClasses: [],
  firstExpectedClassId: null,
  sessionType: 'daily',
};

function getSchoolDayNumber(date: string) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

async function loadDashboardAcademicContext(schoolId: string, schoolDate: string): Promise<DashboardAcademicContext> {
  const client = requireSupabase();
  const calendarResult = await client.from('academic_calendars')
    .select('id,is_default').eq('school_id', schoolId).order('name');
  if (calendarResult.error) throw calendarResult.error;
  const calendars = calendarResult.data ?? [];
  const calendar = calendars.find((item) => item.is_default) ?? calendars[0];
  if (!calendar) return emptyAcademicContext;

  const yearResult = await client.from('academic_years')
    .select('id,name,start_date,end_date,is_current')
    .eq('school_id', schoolId).eq('calendar_id', calendar.id).order('start_date', { ascending: false });
  if (yearResult.error) throw yearResult.error;
  const years = yearResult.data ?? [];
  const activeYear = years.find((year) => year.start_date <= schoolDate && year.end_date >= schoolDate)
    ?? years.find((year) => year.is_current);

  const [termResult, dateResult, weekResult, patternResult] = await Promise.all([
    activeYear
      ? client.from('terms').select('name,start_date,end_date')
        .eq('school_id', schoolId).eq('calendar_id', calendar.id).eq('academic_year_id', activeYear.id)
        .lte('start_date', schoolDate).gte('end_date', schoolDate).limit(1)
      : Promise.resolve({ data: [], error: null }),
    client.from('academic_calendar_dates')
      .select('title,date_type,lessons_allowed,academic_year_id')
      .eq('school_id', schoolId).eq('calendar_id', calendar.id).eq('event_date', schoolDate),
    client.from('academic_calendar_weeks')
      .select('academic_year_id,pattern_id')
      .eq('school_id', schoolId).eq('calendar_id', calendar.id)
      .lte('starts_on', schoolDate).gte('ends_on', schoolDate),
    client.from('academic_calendar_week_patterns').select('id,name')
      .eq('school_id', schoolId).eq('calendar_id', calendar.id).order('name'),
  ]);
  const queryError = [termResult.error, dateResult.error, weekResult.error, patternResult.error].find(Boolean);
  if (queryError) throw queryError;

  const week = (weekResult.data ?? []).find((item) => !activeYear || item.academic_year_id === activeYear.id);
  const patterns = patternResult.data ?? [];
  const pattern = patterns.find((item) => item.id === week?.pattern_id)
    ?? patterns.find((item) => item.name.toLowerCase() === 'standard')
    ?? patterns[0];
  const patternDayResult = pattern
    ? await client.from('academic_calendar_pattern_days').select('is_open')
      .eq('school_id', schoolId).eq('calendar_id', calendar.id)
      .eq('pattern_id', pattern.id).eq('day_of_week', getSchoolDayNumber(schoolDate)).maybeSingle()
    : null;
  if (patternDayResult?.error) throw patternDayResult.error;

  const events = (dateResult.data ?? []).filter((event) => !event.academic_year_id
    || !activeYear || event.academic_year_id === activeYear.id);
  const closure = events.find((event) => !event.lessons_allowed);
  const term = termResult.data?.[0];
  if (closure) {
    return {
      academicYear: activeYear?.name ?? null,
      term: term?.name ?? null,
      dayStatus: closure.date_type === 'public_holiday' ? 'holiday' : 'non-school',
      eventTitle: closure.title,
    };
  }

  const isOpen = events.length ? true : patternDayResult?.data?.is_open;
  return {
    academicYear: activeYear?.name ?? null,
    term: term?.name ?? null,
    dayStatus: isOpen === true ? 'school' : isOpen === false ? 'non-school' : 'unknown',
    eventTitle: events[0]?.title ?? null,
  };
}

function resolveExpectedClasses(
  date: string,
  classes: DashboardClass[],
  activeYears: AcademicYear[],
  schedules: TimetableSchedule[],
  weeks: CalendarWeek[],
  patternDays: PatternDay[],
  calendarDates: CalendarDate[],
  entries: TimetableEntry[],
  overrides: TimetableDateOverride[],
  rosteredClassIds: Set<string>,
) {
  const weekday = getSchoolDayNumber(date);
  const activeYearIds = new Set(activeYears.map((year) => year.id));
  const expectedClassIds = new Set<string>();

  for (const schedule of schedules) {
    if (schedule.academic_year_id && !activeYearIds.has(schedule.academic_year_id)) continue;
    const applicableClasses = classes.filter((schoolClass) => schoolClass.calendar_id === schedule.calendar_id
      && rosteredClassIds.has(schoolClass.id)
      && (!schoolClass.academic_year_id || activeYearIds.has(schoolClass.academic_year_id))
      && (!schoolClass.academic_year_id || !schedule.academic_year_id || schoolClass.academic_year_id === schedule.academic_year_id));
    if (!applicableClasses.length) continue;

    const applicableClassIds = new Set(applicableClasses.map((schoolClass) => schoolClass.id));
    const currentWeek = schedule.academic_year_id
      ? weeks.find((week) => week.calendar_id === schedule.calendar_id && week.academic_year_id === schedule.academic_year_id)
      : undefined;
    const patternId = currentWeek?.pattern_id ?? schedule.week_pattern_id;
    const isOpenDay = patternDays.some((day) => day.pattern_id === patternId && day.day_of_week === weekday && day.is_open)
      && !calendarDates.some((calendarDate) => calendarDate.calendar_id === schedule.calendar_id && !calendarDate.lessons_allowed);
    const cycleWeek = currentWeek
      ? ((currentWeek.week_number - 1) % schedule.cycle_weeks) + 1
      : 1;
    const scheduleEntries = entries.filter((entry) => entry.schedule_id === schedule.id);
    const scheduleOverrides = overrides.filter((override) => override.schedule_id === schedule.id);
    const replacedOrCancelledEntryIds = new Set(scheduleOverrides
      .filter((override) => override.action === 'cancel' || override.action === 'replace')
      .map((override) => override.original_entry_id)
      .filter((entryId): entryId is string => entryId !== null));

    if (isOpenDay) {
      for (const entry of scheduleEntries) {
        if (entry.day_of_week !== weekday || entry.cycle_week !== cycleWeek || replacedOrCancelledEntryIds.has(entry.id)) continue;
        if (entry.entry_type === 'lesson' && entry.class_id && applicableClassIds.has(entry.class_id)) {
          expectedClassIds.add(entry.class_id);
        } else if (entry.entry_type === 'registration') {
          if (entry.class_id && applicableClassIds.has(entry.class_id)) expectedClassIds.add(entry.class_id);
          else if (!entry.class_id) applicableClassIds.forEach((classId) => expectedClassIds.add(classId));
        }
      }
    }

    for (const override of scheduleOverrides) {
      if (override.action === 'cancel' || !['lesson', 'registration'].includes(override.entry_type)) continue;
      if (override.class_id && applicableClassIds.has(override.class_id)) expectedClassIds.add(override.class_id);
      else if (!override.class_id && override.entry_type === 'registration') {
        applicableClassIds.forEach((classId) => expectedClassIds.add(classId));
      }
    }
  }

  return classes.filter((schoolClass) => expectedClassIds.has(schoolClass.id))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function loadTodayAttendance(schoolId: string, attendanceDate: string): Promise<TodayAttendanceSummary> {
  const client = requireSupabase();
  const [classResult, yearResult, scheduleResult, weekResult, calendarDateResult, settingsResult, sessionResult] = await Promise.all([
    client.from('school_classes').select('id,name,calendar_id,academic_year_id').eq('school_id', schoolId).order('name'),
    client.from('academic_years').select('id,calendar_id').eq('school_id', schoolId)
      .lte('start_date', attendanceDate).gte('end_date', attendanceDate),
    client.from('timetable_schedules').select('id,calendar_id,academic_year_id,week_pattern_id,cycle_weeks')
      .eq('school_id', schoolId).eq('status', 'published'),
    client.from('academic_calendar_weeks')
      .select('calendar_id,academic_year_id,pattern_id,week_number')
      .eq('school_id', schoolId).lte('starts_on', attendanceDate).gte('ends_on', attendanceDate),
    client.from('academic_calendar_dates').select('calendar_id,lessons_allowed')
      .eq('school_id', schoolId).eq('event_date', attendanceDate),
    client.from('attendance_settings').select('default_session_type').eq('school_id', schoolId).maybeSingle(),
    client.from('attendance_sessions')
      .select('class_id,session_type,status,attendance_records(status)')
      .eq('school_id', schoolId).eq('attendance_date', attendanceDate)
      .in('session_type', ['daily', 'morning', 'afternoon']),
  ]);
  const firstError = [classResult.error, yearResult.error, scheduleResult.error, weekResult.error, calendarDateResult.error, settingsResult.error, sessionResult.error].find(Boolean);
  if (firstError) throw firstError;

  const [rosterResult, patternDayResult, entryResult, overrideResult] = await Promise.all([
    client.from('class_students').select('class_id').eq('school_id', schoolId),
    client.from('academic_calendar_pattern_days').select('pattern_id,day_of_week,is_open').eq('school_id', schoolId),
    client.from('timetable').select('id,schedule_id,class_id,entry_type,day_of_week,cycle_week').eq('school_id', schoolId),
    client.from('timetable_date_overrides')
      .select('schedule_id,action,original_entry_id,entry_type,class_id')
      .eq('school_id', schoolId).eq('event_date', attendanceDate),
  ]);
  const secondError = [rosterResult.error, patternDayResult.error, entryResult.error, overrideResult.error].find(Boolean);
  if (secondError) throw secondError;

  const expectedClasses = resolveExpectedClasses(
    attendanceDate,
    (classResult.data ?? []) as DashboardClass[],
    (yearResult.data ?? []) as AcademicYear[],
    (scheduleResult.data ?? []) as TimetableSchedule[],
    (weekResult.data ?? []) as CalendarWeek[],
    (patternDayResult.data ?? []) as PatternDay[],
    (calendarDateResult.data ?? []) as CalendarDate[],
    (entryResult.data ?? []) as TimetableEntry[],
    (overrideResult.data ?? []) as TimetableDateOverride[],
    new Set((rosterResult.data ?? []).map((row) => row.class_id)),
  );
  const selectedSessionType = settingsResult.data?.default_session_type;
  const sessionType = (['daily', 'morning', 'afternoon'].includes(selectedSessionType ?? '')
    ? selectedSessionType
    : 'daily') as TodayAttendanceSummary['sessionType'];
  const sessions = (sessionResult.data ?? []) as unknown as AttendanceRegister[];
  const sessionByClass = new Map(sessions.filter((session) => session.session_type === sessionType)
    .map((session) => [session.class_id, session]));
  const outstandingClasses = expectedClasses.filter((schoolClass) => {
    const session = sessionByClass.get(schoolClass.id);
    return !session || session.status === 'open';
  });
  const records = expectedClasses.flatMap((schoolClass) => sessionByClass.get(schoolClass.id)?.attendance_records ?? []);

  return {
    expectedClasses: expectedClasses.length,
    submitted: expectedClasses.length - outstandingClasses.length,
    outstanding: outstandingClasses.length,
    present: records.filter((record) => record.status === 'present').length,
    absent: records.filter((record) => record.status === 'absent').length,
    late: records.filter((record) => record.status === 'late').length,
    outstandingClasses,
    firstExpectedClassId: expectedClasses[0]?.id ?? null,
    sessionType,
  };
}

function attendanceRoute(date: string, sessionType: string, classId?: string | null, missingClassIds?: string[]) {
  const params = new URLSearchParams({ command: 'register', date, session_type: sessionType });
  if (classId) params.set('class', classId);
  if (missingClassIds?.length) params.set('missing_classes', missingClassIds.join(','));
  return `/attendance?${params.toString()}`;
}

export function DashboardPage() {
  const { activeMembership } = useAuth();
  return activeMembership?.role === 'teacher' ? <TeacherDashboardPage /> : <SchoolDashboardPage />;
}

function SchoolDashboardPage() {
  const { activeMembership, user } = useAuth();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [todayAttendance, setTodayAttendance] = useState<TodayAttendanceSummary>(emptyTodayAttendance);
  const [academicContext, setAcademicContext] = useState<DashboardAcademicContext>(emptyAcademicContext);
  const [academicContextError, setAcademicContextError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pendingCount, setPendingCount] = useState(0);
  const [upcomingEventCount, setUpcomingEventCount] = useState(0);
  const schoolId = activeMembership?.school_id;
  const schoolTimeZone = resolveTimeZone(activeMembership?.school.timezone);
  const schoolToday = new Intl.DateTimeFormat('en-CA', { timeZone: schoolTimeZone }).format(new Date());
  const restrictedDashboardRole = [
    'accounts_payable_officer', 'auditor', 'librarian', 'website_editor', 'website_publisher',
    'admissions_officer', 'hr_staff_administrator', 'transport_manager', 'facilities_manager',
    'it_support_technician', 'safeguarding_officer', 'procurement_officer', 'compliance_audit_officer',
  ].includes(activeMembership?.role ?? '');
  useEffect(() => {
    let active = true;
    setAcademicContext(emptyAcademicContext);
    setAcademicContextError(false);
    if (!schoolId) return () => { active = false; };
    const activeSchoolId = schoolId;
    async function load() {
      try {
        const context = await loadDashboardAcademicContext(activeSchoolId, schoolToday);
        if (active) setAcademicContext(context);
      } catch {
        if (active) {
          setAcademicContext(emptyAcademicContext);
          setAcademicContextError(true);
        }
      }
    }
    void load();
    return () => { active = false; };
  }, [schoolId, schoolToday]);
  useEffect(() => {
    if (!schoolId || restrictedDashboardRole) {
      setSummary(null);
      setTodayAttendance(emptyTodayAttendance);
      setPendingCount(0);
      setUpcomingEventCount(0);
      setLoading(false);
      return;
    }
    let active = true;
    async function load(activeSchoolId: string) {
      setLoading(true);
      setError('');
      try {
        const client = requireSupabase();
        const [students, teachers, classes, attendance, attendanceTotal, attendanceResult, pendingAdmissions, pendingSubmissions, overdueInvoices, upcomingEvents] = await Promise.all([
          client.from('students').select('id', { count: 'exact', head: true }).eq('school_id', activeSchoolId).eq('status', 'active'),
          client.from('teacher_profiles').select('id', { count: 'exact', head: true }).eq('school_id', activeSchoolId).eq('status', 'active'),
          client.from('school_classes').select('id', { count: 'exact', head: true }).eq('school_id', activeSchoolId),
          client.from('attendance_records').select('id, attendance_sessions!inner(attendance_date)', { count: 'exact', head: true }).eq('school_id', activeSchoolId).eq('attendance_sessions.attendance_date', schoolToday).eq('status', 'present'),
                    client.from('attendance_records').select('id, attendance_sessions!inner(attendance_date)', { count: 'exact', head: true }).eq('school_id', activeSchoolId).eq('attendance_sessions.attendance_date', schoolToday),
          loadTodayAttendance(activeSchoolId, schoolToday),
          client.from('admission_applications').select('id', { count: 'exact', head: true }).eq('school_id', activeSchoolId).in('status', ['submitted', 'under_review']),
          client.from('assignment_submissions').select('id', { count: 'exact', head: true }).eq('school_id', activeSchoolId).eq('status', 'submitted'),
          client.from('student_fee_invoices').select('id', { count: 'exact', head: true }).eq('school_id', activeSchoolId).eq('status', 'issued').lt('due_on', schoolToday),
          client.from('events').select('id', { count: 'exact', head: true }).eq('school_id', activeSchoolId).gte('starts_at', `${schoolToday}T00:00:00`).lte('starts_at', new Date(new Date(`${schoolToday}T00:00:00`).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()),
        ]);
        const result = [students.error, teachers.error, classes.error, attendance.error, attendanceTotal.error].find(Boolean);
        if (result) throw result;
        if (active) {
          setSummary({ students: students.count ?? 0, teachers: teachers.count ?? 0, classes: classes.count ?? 0, attendanceToday: attendanceTotal.count ? { present: attendance.count ?? 0, total: attendanceTotal.count } : null });
          setTodayAttendance(attendanceResult);
          setPendingCount(
            (pendingAdmissions.error ? 0 : pendingAdmissions.count ?? 0)
            + (pendingSubmissions.error ? 0 : pendingSubmissions.count ?? 0)
            + (overdueInvoices.error ? 0 : overdueInvoices.count ?? 0),
          );
          setUpcomingEventCount(upcomingEvents.error ? 0 : upcomingEvents.count ?? 0);
        }
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Dashboard data could not be loaded.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void load(schoolId);
    return () => { active = false; };
  }, [restrictedDashboardRole, schoolId, schoolTimeZone, schoolToday]);

  const attendancePresent = summary?.attendanceToday?.present ?? 0;
  const attendanceTotal = summary?.attendanceToday?.total ?? 0;
  const attendancePercentage = attendanceTotal ? Math.round((attendancePresent / attendanceTotal) * 100) : null;
  const academicPeriodLabel = academicContextError
    ? 'Academic calendar unavailable'
    : `${academicContext.academicYear ?? 'Academic year not configured'}${academicContext.term ? ` · ${academicContext.term}` : academicContext.academicYear ? ' · No current term' : ''}`;
  const todaySchoolStatus = academicContext.dayStatus === 'holiday'
    ? `Holiday · ${academicContext.eventTitle ?? 'School holiday'}`
    : academicContext.dayStatus === 'non-school'
      ? `Non-school day${academicContext.eventTitle ? ` · ${academicContext.eventTitle}` : ''}`
      : academicContext.dayStatus === 'school'
        ? `School day${academicContext.eventTitle ? ` · ${academicContext.eventTitle}` : ''}`
        : academicContextError ? 'Calendar status unavailable' : 'School day status unavailable';
    const now = new Date();
    const lastRefreshed = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(now);
    const hasStudentData = summary && summary.students > 0;
    const hasTeacherData = summary && summary.teachers > 0;
    const hasClassData = summary && summary.classes > 0;
    const hasAttendanceData = attendanceTotal > 0;

  const hasPendingItems = pendingCount > 0;
    const hasUpcomingEvents = upcomingEventCount > 0;

    const cards = [
      {
        label: 'Active students',
        value: hasStudentData ? summary!.students.toLocaleString() : '—',
        caption: 'Students with active status',
        to: '/students',
        icon: GraduationCap,
        color: 'purple',
        empty: !hasStudentData,
        helper: 'No active students yet'
      },
      {
        label: 'Active teachers',
        value: hasTeacherData ? summary!.teachers.toLocaleString() : '—',
        caption: 'Teachers with active status',
        to: '/teachers',
        icon: Users,
        color: 'teal',
        empty: !hasTeacherData,
        helper: 'No active teachers yet'
      },
      {
        label: 'Classes',
        value: hasClassData ? summary!.classes.toLocaleString() : '—',
        caption: 'All class groups in this school',
        to: '/classes',
        icon: UsersRound,
        color: 'blue',
        empty: !hasClassData,
        helper: 'No classes configured yet'
      },
      {
        label: 'Attendance today',
        value: hasAttendanceData ? `${attendancePresent}/${attendanceTotal}` : '—',
        caption: hasAttendanceData
          ? `${attendancePercentage}% present · ${attendancePresent} of ${attendanceTotal} marked`
          : 'No attendance sessions started',
        to: '/attendance',
        icon: ClipboardCheck,
        color: 'green',
        empty: !hasAttendanceData,
        helper: 'Start a register to see attendance'
      },
      {
        label: 'Pending items',
        value: hasPendingItems ? pendingCount.toLocaleString() : '—',
        caption: 'Admissions, work submissions & overdue fees',
        to: '/admin-workflows',
        icon: CircleDollarSign,
        color: 'amber',
        empty: !hasPendingItems,
        helper: 'No pending items at this time'
      },
      {
        label: 'Upcoming events',
        value: hasUpcomingEvents ? upcomingEventCount.toLocaleString() : '—',
        caption: 'Events in the next 30 days',
        to: '/calendar',
        icon: CalendarDays,
        color: 'purple',
        empty: !hasUpcomingEvents,
        helper: 'No events scheduled'
      },
  ];

  const standardQuickLinks = [
    { to: '/students', label: 'Manage students', icon: GraduationCap },
    { to: '/teachers', label: 'Manage teachers', icon: Users },
    { to: '/classes', label: 'Set up classes', icon: UsersRound },
    { to: '/subjects', label: 'Manage subjects', icon: BookMarked },
    ...(activeMembership?.role === 'school_admin' ? [{ to: '/settings', label: 'School settings', icon: BookMarked }] : []),
    ...(['school_admin', 'finance_manager', 'accountant', 'bursar', 'cashier'].includes(activeMembership?.role ?? '') ? [{ to: '/finance', label: 'Student fees', icon: CircleDollarSign }] : []),
    ...(activeMembership?.role === 'school_admin' ? [{ to: '/accounting-staff', label: 'Add accounting staff', icon: UserRoundPlus }] : []),
  ];
  const quickLinks = activeMembership?.role === 'librarian'
    ? [{ to: '/library', label: 'Manage the library', icon: BookMarked }]
    : activeMembership?.role === 'auditor'
      ? [
        { to: '/finance', label: 'Review student fee records', icon: CircleDollarSign },
        { to: '/audit-log', label: 'Review audit history', icon: ClipboardCheck },
      ]
      : activeMembership?.role === 'accounts_payable_officer'
        ? []
        : activeMembership?.role === 'website_editor' || activeMembership?.role === 'website_publisher'
          ? [{ to: '/website-management', label: 'Manage website content', icon: Globe }]
          : activeMembership?.role === 'admissions_officer'
            ? [{ to: '/admissions', label: 'Review admission applications', icon: GraduationCap }]
            : activeMembership?.role === 'hr_staff_administrator'
              ? [{ to: '/staff', label: 'Manage staff records', icon: Users }]
              : ['transport_manager', 'facilities_manager', 'it_support_technician', 'safeguarding_officer', 'procurement_officer', 'compliance_audit_officer'].includes(activeMembership?.role ?? '')
                ? [
                  { to: '/admin-workflows', label: 'Open operational workflows', icon: ClipboardCheck },
                  ...(activeMembership?.role === 'compliance_audit_officer' ? [{ to: '/audit-log', label: 'Review audit history', icon: ClipboardCheck }] : []),
                ]
        : standardQuickLinks;

  return (
    <div className="page-stack">
      <div className="page-heading dashboard-page-heading"><div><span className="eyebrow">School workspace</span><h1>Good day{user?.user_metadata.full_name ? `, ${(user.user_metadata.full_name as string).split(' ')[0]}` : ''}</h1><p>Here is an overview of {activeMembership?.school.name}.</p></div><div className="dashboard-heading-context"><span className="date-chip"><CalendarDays size={16} />{new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: schoolTimeZone }).format(new Date())}</span><div className="dashboard-academic-meta"><span className="dashboard-academic-period">{academicPeriodLabel}</span><Link className="dashboard-calendar-link" to="/academic-calendar"><CalendarRange size={15} />Academic calendar<ArrowUpRight size={13} /></Link></div><span className={`dashboard-day-status is-${academicContext.dayStatus}`} role="status">{todaySchoolStatus}</span></div></div>
      {error && <ErrorState message={error} />}
      {loading ? <LoadingState label="Loading live school data…" /> : <>
        {!restrictedDashboardRole && <section className="stat-grid" aria-label="Action-focused school overview">{cards.map(({ label, value, caption, to, icon: Icon, color, empty, helper }) => <Link className={`stat-card stat-card-link${empty ? ' stat-card-empty' : ''}`} key={label} to={to}><div className="stat-card-top"><span>{label}</span><span className={`stat-icon ${color}`}><Icon size={19} /></span></div><strong>{value}</strong><span className="stat-caption">{caption}</span>{empty && <span className="stat-empty-helper">{helper}</span>}<span className="stat-card-action">View details <ArrowUpRight size={14} /></span></Link>)}</section>}
      <p className="dashboard-refreshed">Last refreshed {lastRefreshed}</p>
        <section className="dashboard-grid">
          {!restrictedDashboardRole && <>
          <article className="content-card overview-card today-attendance-card">
            <div className="section-heading"><div><span className="eyebrow">School operations · today</span><h2>Today’s attendance</h2></div><ClipboardCheck size={19} className="muted-icon" /></div>
            {todayAttendance.expectedClasses ? <>
              <div className="today-attendance-stats" aria-label="Today’s attendance summary">
                <div><strong>{todayAttendance.expectedClasses}</strong><span>Classes expected</span></div>
                <div><strong>{todayAttendance.submitted}</strong><span>Registers submitted</span></div>
                <div><strong>{todayAttendance.outstanding}</strong><span>Registers outstanding</span></div>
                <div><strong>{todayAttendance.present}</strong><span>Students present</span></div>
                <div><strong>{todayAttendance.absent}</strong><span>Students absent</span></div>
                <div><strong>{todayAttendance.late}</strong><span>Students late</span></div>
              </div>
            </> : <div className="today-attendance-empty">No registers expected today</div>}
            <div className="today-attendance-actions">
              <Link className="button button-primary" to={attendanceRoute(schoolToday, todayAttendance.sessionType, todayAttendance.firstExpectedClassId)}>View attendance<ArrowUpRight size={15} /></Link>
              {todayAttendance.outstanding > 0 && <Link className="button button-quiet" to={attendanceRoute(schoolToday, todayAttendance.sessionType, todayAttendance.outstandingClasses[0]?.id, todayAttendance.outstandingClasses.map((schoolClass) => schoolClass.id))}>View missing registers<ArrowUpRight size={15} /></Link>}
            </div>
          </article>
          </>}
          <article className="content-card quick-links-card"><div className="section-heading"><div><span className="eyebrow">Quick actions</span><h2>School management</h2></div></div><div className="quick-links">{quickLinks.map(({ to, label, icon: Icon }) => <Link key={to} to={to}><Icon size={18} /><span>{label}</span><ArrowUpRight size={16} /></Link>)}</div></article>
        </section>
        {restrictedDashboardRole && <section className="content-card dashboard-note"><div className="note-icon"><BookMarked size={18} /></div><div><h2>{activeMembership?.role === 'accounts_payable_officer' ? 'Accounts payable access' : activeMembership?.role === 'auditor' ? 'Read-only review access' : activeMembership?.role === 'librarian' ? 'Library workspace' : activeMembership?.role === 'website_editor' || activeMembership?.role === 'website_publisher' ? 'Website content access' : activeMembership?.role === 'admissions_officer' ? 'Admissions workspace' : activeMembership?.role === 'hr_staff_administrator' ? 'HR workspace' : ['transport_manager', 'facilities_manager', 'it_support_technician', 'safeguarding_officer', 'procurement_officer', 'compliance_audit_officer'].includes(activeMembership?.role ?? '') ? 'Operational workflow access' : 'One connected workspace'}</h2><p>{activeMembership?.role === 'accounts_payable_officer' ? 'Supplier invoice and payment workflows are not available yet. Your account is restricted to this workspace until those features are released.' : activeMembership?.role === 'auditor' ? 'You can review this school’s finance records and audit history. Your role cannot change or approve records.' : activeMembership?.role === 'librarian' ? 'Use the Library section to manage the catalogue, requests, checkouts, and returns.' : activeMembership?.role === 'website_editor' ? 'Create and submit website content drafts. Only a website publisher or school administrator can publish changes.' : activeMembership?.role === 'website_publisher' ? 'Review submitted school website drafts and publish approved content.' : activeMembership?.role === 'admissions_officer' ? 'Review, assign, and register admissions applications for your school.' : activeMembership?.role === 'hr_staff_administrator' ? 'Manage staff directory records and private staff documents. School membership and platform roles remain controlled by school administrators.' : activeMembership?.role === 'safeguarding_officer' ? 'Manage confidential safeguarding concerns and referrals. Access is limited to your school’s safeguarding workspace.' : ['transport_manager', 'facilities_manager', 'it_support_technician', 'procurement_officer', 'compliance_audit_officer'].includes(activeMembership?.role ?? '') ? 'Manage only your assigned operational domain and review its status history.' : 'School records, classes, and academic tools are scoped to your active school.'}</p></div></section>}
      </>}
    </div>
  );
}
