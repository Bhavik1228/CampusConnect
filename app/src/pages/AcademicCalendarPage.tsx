import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle, ArrowLeft, ArrowRight, CalendarDays, Plus, Trash2,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type CalendarTab = 'years' | 'weeks' | 'bell' | 'dates' | 'exceptions';
type DateType = 'public_holiday' | 'closure' | 'examination' | 'activity' | 'special';
type OverrideAction = 'add' | 'replace' | 'cancel';
type Relation<T> = T | T[] | null;

interface AcademicCalendar {
  id: string;
  name: string;
  division_name: string | null;
  is_default: boolean;
}
interface AcademicYear {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  is_current: boolean;
  calendar_id: string;
}
interface AcademicTerm {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  academic_year_id: string;
}
interface WeekPattern {
  id: string;
  name: string;
  calendar_id: string;
}
interface PatternDay {
  pattern_id: string;
  day_of_week: number;
  is_open: boolean;
}
interface AcademicWeek {
  id: string;
  week_number: number;
  starts_on: string;
  ends_on: string;
  pattern_id: string;
  cycle_week: number;
}
interface BellSchedule {
  id: string;
  name: string;
  week_pattern_id: string;
  cycle_weeks: number;
}
interface BellPeriod {
  id: string;
  bell_schedule_id: string;
  cycle_week: number;
  day_of_week: number;
  period_number: number;
  name: string;
  period_type: 'lesson' | 'break' | 'lunch' | 'assembly' | 'registration' | 'other';
  starts_at: string;
  ends_at: string;
  allows_double: boolean;
}
interface BellPeriodSubject {
  period_id: string;
  subject_id: string;
}
interface CalendarDate {
  id: string;
  event_date: string;
  title: string;
  description: string | null;
  date_type: DateType;
  lessons_allowed: boolean;
  academic_year_id: string | null;
}
interface Schedule {
  id: string;
  name: string;
  status: 'draft' | 'published' | 'archived';
  calendar_id: string;
  academic_year_id: string | null;
  week_pattern_id: string;
  bell_schedule_id: string | null;
  cycle_weeks: number;
}
interface TimetableEntry {
  id: string;
  schedule_id: string;
  cycle_week: number;
  entry_type: 'lesson' | 'registration' | 'break' | 'lunch' | 'other';
  class_id: string | null;
  subject_id: string | null;
  teacher_id: string | null;
  day_of_week: number;
  starts_at: string;
  ends_at: string;
  room: string | null;
  label: string | null;
  class: Relation<{ name: string }>;
  subject: Relation<{ name: string }>;
  teacher: Relation<{ first_name: string; last_name: string }>;
}
interface DateOverride {
  id: string;
  schedule_id: string;
  event_date: string;
  action: OverrideAction;
  original_entry_id: string | null;
  entry_type: TimetableEntry['entry_type'];
  class_id: string | null;
  subject_id: string | null;
  teacher_id: string | null;
  starts_at: string | null;
  ends_at: string | null;
  room: string | null;
  label: string | null;
}
interface SchoolClass { id: string; name: string }
interface Subject { id: string; name: string }
interface Teacher { id: string; first_name: string; last_name: string }

const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const calendarTabs: { id: CalendarTab; label: string }[] = [
  { id: 'years', label: 'Academic years & terms' },
  { id: 'weeks', label: 'Teaching weeks & days' },
  { id: 'bell', label: 'Periods & bell schedules' },
  { id: 'dates', label: 'Holidays & special dates' },
  { id: 'exceptions', label: 'Timetable exceptions' },
];
const dateTypeLabels: Record<DateType, string> = {
  public_holiday: 'Public holiday',
  closure: 'School closure',
  examination: 'Examination',
  activity: 'Activity day',
  special: 'Special day',
};

function relation<T>(value: Relation<T> | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function monthGrid(year: number, month: number) {
  const firstDay = new Date(year, month, 1);
  const mondayOffset = (firstDay.getDay() + 6) % 7;
  const firstGridDate = new Date(year, month, 1 - mondayOffset);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(firstGridDate);
    date.setDate(firstGridDate.getDate() + index);
    return date;
  });
}

function dayNumber(value: string) {
  return ((new Date(`${value}T12:00:00`).getDay() + 6) % 7) + 1;
}

function displayDate(value: string, options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }) {
  return new Intl.DateTimeFormat(undefined, options).format(new Date(`${value}T12:00:00`));
}

export function AcademicCalendarPage() {
  const { activeMembership, user } = useAuth();
  const schoolId = activeMembership?.school_id;
  const canManage = activeMembership?.role === 'school_admin'
    || activeMembership?.role === 'academic_coordinator'
    || activeMembership?.role === 'system_admin';
  const today = localDateKey(new Date());
  const [calendars, setCalendars] = useState<AcademicCalendar[]>([]);
  const [calendarId, setCalendarId] = useState('');
  const [years, setYears] = useState<AcademicYear[]>([]);
  const [terms, setTerms] = useState<AcademicTerm[]>([]);
  const [patterns, setPatterns] = useState<WeekPattern[]>([]);
  const [patternDays, setPatternDays] = useState<PatternDay[]>([]);
  const [weeks, setWeeks] = useState<AcademicWeek[]>([]);
  const [bellSchedules, setBellSchedules] = useState<BellSchedule[]>([]);
  const [bellPeriods, setBellPeriods] = useState<BellPeriod[]>([]);
  const [bellPeriodSubjects, setBellPeriodSubjects] = useState<BellPeriodSubject[]>([]);
  const [bellScheduleId, setBellScheduleId] = useState('');
  const [calendarDates, setCalendarDates] = useState<CalendarDate[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [entries, setEntries] = useState<TimetableEntry[]>([]);
  const [overrides, setOverrides] = useState<DateOverride[]>([]);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [selectedDate, setSelectedDate] = useState(today);
  const [month, setMonth] = useState(() => new Date().getMonth());
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [tab, setTab] = useState<CalendarTab>('years');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showCalendarForm, setShowCalendarForm] = useState(false);
  const [showOverrideForm, setShowOverrideForm] = useState(false);

  const [calendarName, setCalendarName] = useState('');
  const [divisionName, setDivisionName] = useState('');
  const [yearName, setYearName] = useState('');
  const [yearStart, setYearStart] = useState('');
  const [yearEnd, setYearEnd] = useState('');
  const [termName, setTermName] = useState('');
  const [termYearId, setTermYearId] = useState('');
  const [termStart, setTermStart] = useState('');
  const [termEnd, setTermEnd] = useState('');
  const [patternName, setPatternName] = useState('');
  const [patternOperatingDays, setPatternOperatingDays] = useState([1, 2, 3, 4, 5]);
  const [weekNumber, setWeekNumber] = useState(1);
  const [weekPatternId, setWeekPatternId] = useState('');
  const [weekStart, setWeekStart] = useState('');
  const [weekEnd, setWeekEnd] = useState('');
  const [weekCycle, setWeekCycle] = useState(1);
  const [bellName, setBellName] = useState('');
  const [bellPatternId, setBellPatternId] = useState('');
  const [bellCycleWeeks, setBellCycleWeeks] = useState(1);
  const [periodEditingId, setPeriodEditingId] = useState('');
  const [periodCycle, setPeriodCycle] = useState(1);
  const [periodDay, setPeriodDay] = useState(1);
  const [periodNumber, setPeriodNumber] = useState(1);
  const [periodName, setPeriodName] = useState('');
  const [periodType, setPeriodType] = useState<BellPeriod['period_type']>('lesson');
  const [periodStart, setPeriodStart] = useState('08:00');
  const [periodEnd, setPeriodEnd] = useState('09:00');
  const [periodAllowsDouble, setPeriodAllowsDouble] = useState(false);
  const [periodAllowedSubjects, setPeriodAllowedSubjects] = useState<string[]>([]);
  const [dateTitle, setDateTitle] = useState('');
  const [dateType, setDateType] = useState<DateType>('public_holiday');
  const [dateDescription, setDateDescription] = useState('');
  const [dateLessonsAllowed, setDateLessonsAllowed] = useState(false);
  const [dateYearId, setDateYearId] = useState('');
  const [overrideScheduleId, setOverrideScheduleId] = useState('');
  const [overrideAction, setOverrideAction] = useState<OverrideAction>('cancel');
  const [overrideEntryId, setOverrideEntryId] = useState('');
  const [overrideClassId, setOverrideClassId] = useState('');
  const [overrideSubjectId, setOverrideSubjectId] = useState('');
  const [overrideTeacherId, setOverrideTeacherId] = useState('');
  const [overrideType, setOverrideType] = useState<TimetableEntry['entry_type']>('lesson');
  const [overrideStart, setOverrideStart] = useState('09:00');
  const [overrideEnd, setOverrideEnd] = useState('10:00');
  const [overrideRoom, setOverrideRoom] = useState('');
  const [overrideLabel, setOverrideLabel] = useState('');

  const refresh = useCallback(async () => {
    if (!schoolId) return;
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const calendarResult = await client.from('academic_calendars')
        .select('id,name,division_name,is_default')
        .eq('school_id', schoolId)
        .order('name');
      if (calendarResult.error) throw calendarResult.error;
      const calendarList = (calendarResult.data ?? []) as AcademicCalendar[];
      setCalendars(calendarList);
      const targetCalendarId = calendarId || calendarList.find((item) => item.is_default)?.id || calendarList[0]?.id || '';
      if (!targetCalendarId) {
        setYears([]);
        setTerms([]);
        setPatterns([]);
        setPatternDays([]);
        setWeeks([]);
        setBellSchedules([]);
        setBellPeriods([]);
        setBellPeriodSubjects([]);
        setCalendarDates([]);
        setSchedules([]);
        setEntries([]);
        setOverrides([]);
        return;
      }
      if (targetCalendarId !== calendarId) setCalendarId(targetCalendarId);
      const firstDay = `${year}-01-01`;
      const lastDay = `${year}-12-31`;
      const [yearResult, termResult, patternResult, weekResult, bellScheduleResult, dateResult, scheduleResult, classResult, subjectResult, teacherResult] = await Promise.all([
        client.from('academic_years').select('id,name,start_date,end_date,is_current,calendar_id').eq('school_id', schoolId).eq('calendar_id', targetCalendarId).order('start_date', { ascending: false }),
        client.from('terms').select('id,name,start_date,end_date,academic_year_id').eq('school_id', schoolId).eq('calendar_id', targetCalendarId).order('start_date'),
        client.from('academic_calendar_week_patterns').select('id,name,calendar_id').eq('school_id', schoolId).eq('calendar_id', targetCalendarId).order('name'),
        client.from('academic_calendar_weeks').select('id,week_number,starts_on,ends_on,pattern_id,cycle_week').eq('school_id', schoolId).eq('calendar_id', targetCalendarId).order('week_number'),
        client.from('academic_bell_schedules').select('id,name,week_pattern_id,cycle_weeks').eq('school_id', schoolId).eq('calendar_id', targetCalendarId).order('name'),
        client.from('academic_calendar_dates').select('id,event_date,title,description,date_type,lessons_allowed,academic_year_id').eq('school_id', schoolId).eq('calendar_id', targetCalendarId).gte('event_date', firstDay).lte('event_date', lastDay).order('event_date'),
        client.from('timetable_schedules').select('id,name,status,calendar_id,academic_year_id,week_pattern_id,bell_schedule_id,cycle_weeks').eq('school_id', schoolId).eq('calendar_id', targetCalendarId).order('updated_at', { ascending: false }),
        client.from('school_classes').select('id,name').eq('school_id', schoolId).eq('calendar_id', targetCalendarId).order('name'),
        client.from('subjects').select('id,name').eq('school_id', schoolId).order('name'),
        client.from('teacher_profiles').select('id,first_name,last_name').eq('school_id', schoolId).eq('status', 'active').order('last_name'),
      ]);
      const failed = [yearResult.error, termResult.error, patternResult.error, weekResult.error, bellScheduleResult.error, dateResult.error, scheduleResult.error, classResult.error, subjectResult.error, teacherResult.error].find(Boolean);
      if (failed) throw failed;
      const yearList = (yearResult.data ?? []) as AcademicYear[];
      const patternList = (patternResult.data ?? []) as WeekPattern[];
      const bellScheduleList = (bellScheduleResult.data ?? []) as BellSchedule[];
      const bellScheduleIds = bellScheduleList.map((item) => item.id);
      const bellPeriodResult = bellScheduleIds.length
        ? await client.from('academic_bell_periods')
          .select('id,bell_schedule_id,cycle_week,day_of_week,period_number,name,period_type,starts_at,ends_at,allows_double')
          .eq('school_id', schoolId)
          .in('bell_schedule_id', bellScheduleIds)
          .order('cycle_week')
          .order('day_of_week')
          .order('period_number')
        : { data: [], error: null };
      if (bellPeriodResult.error) throw bellPeriodResult.error;
      const bellPeriodList = (bellPeriodResult.data ?? []) as BellPeriod[];
      const bellPeriodIds = bellPeriodList.map((item) => item.id);
      const bellSubjectResult = bellPeriodIds.length
        ? await client.from('academic_bell_period_subjects')
          .select('period_id,subject_id')
          .eq('school_id', schoolId)
          .in('period_id', bellPeriodIds)
        : { data: [], error: null };
      if (bellSubjectResult.error) throw bellSubjectResult.error;
      const scheduleList = (scheduleResult.data ?? []) as Schedule[];
      setYears(yearList);
      setTerms((termResult.data ?? []) as AcademicTerm[]);
      setPatterns(patternList);
      setWeeks(((weekResult.data ?? []) as AcademicWeek[]).filter((item) => item.starts_on <= lastDay && item.ends_on >= firstDay));
      setBellSchedules(bellScheduleList);
      setBellPeriods(bellPeriodList);
      setBellPeriodSubjects((bellSubjectResult.data ?? []) as BellPeriodSubject[]);
      setCalendarDates((dateResult.data ?? []) as CalendarDate[]);
      setSchedules(scheduleList);
      setClasses((classResult.data ?? []) as SchoolClass[]);
      setSubjects((subjectResult.data ?? []) as Subject[]);
      setTeachers((teacherResult.data ?? []) as Teacher[]);
      const yearId = yearList.find((item) => item.is_current)?.id ?? yearList[0]?.id ?? '';
      if (!termYearId && yearId) setTermYearId(yearId);
      if (!dateYearId && yearId) setDateYearId(yearId);
      if (!weekPatternId && patternList[0]) setWeekPatternId(patternList[0].id);
      setBellScheduleId((current) => bellScheduleList.some((item) => item.id === current)
        ? current
        : bellScheduleList[0]?.id ?? '');
      if (!bellPatternId && patternList[0]) setBellPatternId(patternList[0].id);

      if (patternList.length) {
        const patternDayResult = await client.from('academic_calendar_pattern_days')
          .select('pattern_id,day_of_week,is_open')
          .eq('school_id', schoolId)
          .eq('calendar_id', targetCalendarId);
        if (patternDayResult.error) throw patternDayResult.error;
        setPatternDays((patternDayResult.data ?? []) as PatternDay[]);
      } else {
        setPatternDays([]);
      }

      const scheduleIds = scheduleList.filter((item) => canManage || item.status === 'published').map((item) => item.id);
      if (scheduleIds.length) {
        const [entryResult, overrideResult] = await Promise.all([
          client.from('timetable').select('id,schedule_id,cycle_week,entry_type,class_id,subject_id,teacher_id,day_of_week,starts_at,ends_at,room,label,class:school_classes(name),subject:subjects(name),teacher:teacher_profiles(first_name,last_name)').eq('school_id', schoolId).in('schedule_id', scheduleIds).order('starts_at'),
          client.from('timetable_date_overrides').select('id,schedule_id,event_date,action,original_entry_id,entry_type,class_id,subject_id,teacher_id,starts_at,ends_at,room,label').eq('school_id', schoolId).eq('calendar_id', targetCalendarId).gte('event_date', firstDay).lte('event_date', lastDay),
        ]);
        if (entryResult.error) throw entryResult.error;
        if (overrideResult.error) throw overrideResult.error;
        setEntries((entryResult.data ?? []) as unknown as TimetableEntry[]);
        setOverrides((overrideResult.data ?? []) as DateOverride[]);
      } else {
        setEntries([]);
        setOverrides([]);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load the academic calendar.');
    } finally {
      setLoading(false);
    }
  }, [schoolId, calendarId, year, canManage, termYearId, dateYearId, weekPatternId, bellPatternId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const activeCalendar = calendars.find((calendar) => calendar.id === calendarId) ?? null;
  const activeYear = years.find((item) => selectedDate >= item.start_date && selectedDate <= item.end_date)
    ?? years.find((item) => item.is_current)
    ?? years[0]
    ?? null;
  const selectedWeek = weeks.find((item) => selectedDate >= item.starts_on && selectedDate <= item.ends_on);
  const selectedBellSchedule = bellSchedules.find((item) => item.id === bellScheduleId) ?? null;
  const selectedBellPeriods = bellPeriods.filter((item) => item.bell_schedule_id === bellScheduleId);
  const activePattern = patterns.find((pattern) => pattern.id === selectedWeek?.pattern_id)
    ?? patterns.find((pattern) => pattern.id === schedules.find((schedule) => schedule.academic_year_id === activeYear?.id)?.week_pattern_id)
    ?? patterns.find((pattern) => pattern.name === 'Standard')
    ?? patterns[0]
    ?? null;
  const operatingDays = new Set(patternDays.filter((item) => item.pattern_id === activePattern?.id && item.is_open).map((item) => item.day_of_week));
  const isOpenDay = operatingDays.size ? operatingDays.has(dayNumber(selectedDate)) : dayNumber(selectedDate) <= 5;
  const selectedDateFlags = calendarDates.filter((item) => item.event_date === selectedDate);
  const dayClosed = selectedDateFlags.some((item) => !item.lessons_allowed);
  const selectedSchedule = schedules
    .filter((schedule) => schedule.status === 'published' || canManage)
    .find((schedule) => schedule.academic_year_id === activeYear?.id && schedule.week_pattern_id === activePattern?.id)
    ?? schedules.find((schedule) => (schedule.status === 'published' || canManage) && schedule.week_pattern_id === activePattern?.id)
    ?? null;
  const activeCycleWeek = selectedSchedule?.cycle_weeks === 2 ? selectedWeek?.cycle_week ?? 1 : 1;
  const baseDayEntries = selectedSchedule && isOpenDay && !dayClosed
    ? entries.filter((entry) => entry.schedule_id === selectedSchedule.id
      && entry.day_of_week === dayNumber(selectedDate)
      && entry.cycle_week === activeCycleWeek)
    : [];
  const dayOverrides = overrides.filter((item) => item.event_date === selectedDate && item.schedule_id === selectedSchedule?.id);
  const shownEntries = useMemo(() => {
    const removedIds = new Set(dayOverrides.filter((item) => ['cancel', 'replace'].includes(item.action)).map((item) => item.original_entry_id));
    const base = baseDayEntries.filter((entry) => !removedIds.has(entry.id));
    const applied = dayOverrides.filter((item) => item.action === 'add' || item.action === 'replace').map((item) => {
      const original = item.original_entry_id ? entries.find((entry) => entry.id === item.original_entry_id) : undefined;
      const schoolClass = classes.find((record) => record.id === (item.class_id ?? original?.class_id));
      const subject = subjects.find((record) => record.id === (item.subject_id ?? original?.subject_id));
      const teacher = teachers.find((record) => record.id === (item.teacher_id ?? original?.teacher_id));
      return {
        id: item.id,
        schedule_id: item.schedule_id,
        cycle_week: activeCycleWeek,
        entry_type: item.entry_type,
        class_id: item.class_id ?? original?.class_id ?? null,
        subject_id: item.subject_id ?? original?.subject_id ?? null,
        teacher_id: item.teacher_id ?? original?.teacher_id ?? null,
        day_of_week: dayNumber(selectedDate),
        starts_at: item.starts_at ?? original?.starts_at ?? '00:00:00',
        ends_at: item.ends_at ?? original?.ends_at ?? '00:00:00',
        room: item.room ?? original?.room ?? null,
        label: item.label ?? original?.label ?? null,
        class: schoolClass ? { name: schoolClass.name } : null,
        subject: subject ? { name: subject.name } : null,
        teacher: teacher ? { first_name: teacher.first_name, last_name: teacher.last_name } : null,
      } satisfies TimetableEntry;
    });
    return [...base, ...applied].sort((left, right) => left.starts_at.localeCompare(right.starts_at));
  }, [baseDayEntries, dayOverrides, entries, selectedDate, classes, subjects, teachers]);
  const datesInMonth = monthGrid(year, month);
  const monthTitle = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(year, month, 1));
  const datesByValue = new Map<string, CalendarDate[]>();
  for (const item of calendarDates) datesByValue.set(item.event_date, [...(datesByValue.get(item.event_date) ?? []), item]);

  async function finishMutation(message: string) {
    setSuccess(message);
    await refresh();
  }

  function reportMutationError(mutationError: unknown, fallback: string) {
    setError(mutationError instanceof Error ? mutationError.message : fallback);
  }

  async function createCalendar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !calendarName.trim()) return;
    setSaving(true);
    setError('');
    try {
      const { data, error: insertError } = await requireSupabase().from('academic_calendars')
        .insert({ school_id: schoolId, name: calendarName.trim(), division_name: divisionName.trim() || null, is_default: calendars.length === 0 })
        .select('id')
        .single();
      if (insertError) throw insertError;
      setCalendarId(data.id);
      setCalendarName('');
      setDivisionName('');
      setShowCalendarForm(false);
      await finishMutation('Academic calendar created.');
    } catch (mutationError) { reportMutationError(mutationError, 'Could not create the academic calendar.'); }
    finally { setSaving(false); }
  }

  async function createAcademicYear(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !calendarId) return;
    if (yearEnd <= yearStart) { setError('The academic year end must be after its start.'); return; }
    setSaving(true);
    setError('');
    try {
      const { error: insertError } = await requireSupabase().from('academic_years')
        .insert({ school_id: schoolId, calendar_id: calendarId, name: yearName.trim(), start_date: yearStart, end_date: yearEnd });
      if (insertError) throw insertError;
      setYearName('');
      setYearStart('');
      setYearEnd('');
      await finishMutation('Academic year created.');
    } catch (mutationError) { reportMutationError(mutationError, 'Could not create the academic year.'); }
    finally { setSaving(false); }
  }

  async function setCurrentYear(yearId: string) {
    setSaving(true);
    setError('');
    try {
      const { error: updateError } = await requireSupabase().rpc('set_current_academic_year', { target_year: yearId });
      if (updateError) throw updateError;
      await finishMutation('Current academic year updated.');
    } catch (mutationError) { reportMutationError(mutationError, 'Could not update the current academic year.'); }
    finally { setSaving(false); }
  }

  async function createTerm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !calendarId || !termYearId) return;
    if (termEnd <= termStart) { setError('The term end must be after its start.'); return; }
    setSaving(true);
    setError('');
    try {
      const { error: insertError } = await requireSupabase().from('terms')
        .insert({ school_id: schoolId, calendar_id: calendarId, academic_year_id: termYearId, name: termName.trim(), start_date: termStart, end_date: termEnd });
      if (insertError) throw insertError;
      setTermName('');
      setTermStart('');
      setTermEnd('');
      await finishMutation('Academic term created.');
    } catch (mutationError) { reportMutationError(mutationError, 'Could not create the academic term.'); }
    finally { setSaving(false); }
  }

  async function deleteTerm(termId: string) {
    if (!window.confirm('Delete this academic term?')) return;
    setSaving(true);
    setError('');
    try {
      const { error: deleteError } = await requireSupabase().from('terms').delete().eq('id', termId).eq('school_id', schoolId);
      if (deleteError) throw deleteError;
      await finishMutation('Academic term deleted.');
    } catch (mutationError) { reportMutationError(mutationError, 'Could not delete the academic term.'); }
    finally { setSaving(false); }
  }

  async function savePattern(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!calendarId) return;
    setSaving(true);
    setError('');
    try {
      const { data, error: saveError } = await requireSupabase().rpc('save_academic_week_pattern', {
        target_calendar: calendarId,
        pattern_name: patternName.trim(),
        operating_days: patternOperatingDays,
      });
      if (saveError) throw saveError;
      setWeekPatternId(data);
      setPatternName('');
      await finishMutation('Teaching-week pattern saved.');
    } catch (mutationError) { reportMutationError(mutationError, 'Could not save the teaching-week pattern.'); }
    finally { setSaving(false); }
  }

  async function createWeek(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !calendarId || !activeYear || !weekPatternId) return;
    if (weekEnd < weekStart) { setError('The teaching week end must be on or after its start.'); return; }
    setSaving(true);
    setError('');
    try {
      const { error: insertError } = await requireSupabase().from('academic_calendar_weeks')
        .insert({ school_id: schoolId, calendar_id: calendarId, academic_year_id: activeYear.id, pattern_id: weekPatternId, week_number: weekNumber, cycle_week: weekCycle, starts_on: weekStart, ends_on: weekEnd });
      if (insertError) throw insertError;
      setWeekNumber((value) => value + 1);
      setWeekStart('');
      setWeekEnd('');
      await finishMutation('Teaching week configured.');
    } catch (mutationError) { reportMutationError(mutationError, 'Could not configure the teaching week.'); }
    finally { setSaving(false); }
  }

  async function deleteWeek(weekId: string) {
    if (!window.confirm('Remove this teaching-week configuration?')) return;
    setSaving(true);
    setError('');
    try {
      const { error: deleteError } = await requireSupabase().from('academic_calendar_weeks').delete().eq('id', weekId).eq('school_id', schoolId);
      if (deleteError) throw deleteError;
      await finishMutation('Teaching week removed.');
    } catch (mutationError) { reportMutationError(mutationError, 'Could not remove the teaching week.'); }
    finally { setSaving(false); }
  }

  async function createBellSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !calendarId || !bellPatternId) return;
    setSaving(true);
    setError('');
    try {
      const { data, error: insertError } = await requireSupabase().from('academic_bell_schedules')
        .insert({
          school_id: schoolId,
          calendar_id: calendarId,
          week_pattern_id: bellPatternId,
          name: bellName.trim(),
          cycle_weeks: bellCycleWeeks,
        })
        .select('id')
        .single();
      if (insertError) throw insertError;
      setBellScheduleId(data.id);
      setBellName('');
      await finishMutation('Bell schedule created.');
    } catch (mutationError) { reportMutationError(mutationError, 'Could not create this bell schedule.'); }
    finally { setSaving(false); }
  }

  async function updateBellSchedule(updates: Partial<Pick<BellSchedule, 'name' | 'cycle_weeks'>>) {
    if (!schoolId || !selectedBellSchedule) return;
    setSaving(true);
    setError('');
    try {
      const { error: updateError } = await requireSupabase().from('academic_bell_schedules')
        .update(updates)
        .eq('id', selectedBellSchedule.id)
        .eq('school_id', schoolId);
      if (updateError) throw updateError;
      await finishMutation('Bell schedule settings updated.');
    } catch (mutationError) { reportMutationError(mutationError, 'Could not update the bell schedule.'); }
    finally { setSaving(false); }
  }

  async function deleteBellSchedule(targetId: string) {
    if (!window.confirm('Delete this bell schedule and all of its period definitions? Timetables using it must be detached first.')) return;
    setSaving(true);
    setError('');
    try {
      const { error: deleteError } = await requireSupabase().from('academic_bell_schedules')
        .delete()
        .eq('id', targetId)
        .eq('school_id', schoolId);
      if (deleteError) throw deleteError;
      if (targetId === bellScheduleId) setBellScheduleId('');
      await finishMutation('Bell schedule deleted.');
    } catch (mutationError) { reportMutationError(mutationError, 'Could not delete this bell schedule.'); }
    finally { setSaving(false); }
  }

  function editBellPeriod(period: BellPeriod) {
    setPeriodEditingId(period.id);
    setPeriodCycle(period.cycle_week);
    setPeriodDay(period.day_of_week);
    setPeriodNumber(period.period_number);
    setPeriodName(period.name);
    setPeriodType(period.period_type);
    setPeriodStart(period.starts_at.slice(0, 5));
    setPeriodEnd(period.ends_at.slice(0, 5));
    setPeriodAllowsDouble(period.allows_double);
    setPeriodAllowedSubjects(bellPeriodSubjects
      .filter((item) => item.period_id === period.id)
      .map((item) => item.subject_id));
    setError('');
  }

  function resetBellPeriodForm() {
    setPeriodEditingId('');
    setPeriodName('');
    setPeriodType('lesson');
    setPeriodStart('08:00');
    setPeriodEnd('09:00');
    setPeriodAllowsDouble(false);
    setPeriodAllowedSubjects([]);
  }

  async function saveBellPeriod(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !selectedBellSchedule) return;
    if (periodEnd <= periodStart) { setError('Period end time must be later than its start.'); return; }
    setSaving(true);
    setError('');
    try {
      const client = requireSupabase();
      const values = {
        school_id: schoolId,
        bell_schedule_id: selectedBellSchedule.id,
        cycle_week: periodCycle,
        day_of_week: periodDay,
        period_number: periodNumber,
        name: periodName.trim(),
        period_type: periodType,
        starts_at: `${periodStart}:00`,
        ends_at: `${periodEnd}:00`,
        allows_double: periodType === 'lesson' && periodAllowsDouble,
      };
      const periodResult = periodEditingId
        ? await client.from('academic_bell_periods').update(values).eq('id', periodEditingId).eq('school_id', schoolId).select('id').single()
        : await client.from('academic_bell_periods').insert(values).select('id').single();
      if (periodResult.error) throw periodResult.error;
      const savedPeriodId = periodResult.data.id;
      const previousSubjects = bellPeriodSubjects
        .filter((item) => item.period_id === savedPeriodId)
        .map((item) => item.subject_id)
        .sort();
      const nextSubjects = (periodType === 'lesson' ? periodAllowedSubjects : []).slice().sort();
      if (previousSubjects.join(',') !== nextSubjects.join(',')) {
        const { error: deleteRulesError } = await client.from('academic_bell_period_subjects')
          .delete()
          .eq('school_id', schoolId)
          .eq('period_id', savedPeriodId);
        if (deleteRulesError) throw new Error(`Period saved, but its previous subject availability could not be cleared: ${deleteRulesError.message}`);
        if (nextSubjects.length) {
          const { error: ruleError } = await client.from('academic_bell_period_subjects').insert(
            nextSubjects.map((subjectId) => ({ school_id: schoolId, period_id: savedPeriodId, subject_id: subjectId })),
          );
          if (ruleError) throw new Error(`Period saved, but subject availability could not be saved: ${ruleError.message}`);
        }
      }
      resetBellPeriodForm();
      await finishMutation(periodEditingId ? 'Bell period updated.' : 'Bell period added.');
    } catch (mutationError) { reportMutationError(mutationError, 'Could not save this bell period.'); }
    finally { setSaving(false); }
  }

  async function deleteBellPeriod(periodId: string) {
    if (!window.confirm('Delete this bell period? Timetable entries using it will need to be updated.')) return;
    setSaving(true);
    setError('');
    try {
      const { error: deleteError } = await requireSupabase().from('academic_bell_periods')
        .delete()
        .eq('id', periodId)
        .eq('school_id', schoolId);
      if (deleteError) throw deleteError;
      if (periodEditingId === periodId) resetBellPeriodForm();
      await finishMutation('Bell period deleted.');
    } catch (mutationError) { reportMutationError(mutationError, 'Could not delete this bell period.'); }
    finally { setSaving(false); }
  }

  async function createCalendarDate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !calendarId || !selectedDate) return;
    setSaving(true);
    setError('');
    try {
      const { error: insertError } = await requireSupabase().from('academic_calendar_dates')
        .insert({
          school_id: schoolId,
          calendar_id: calendarId,
          academic_year_id: dateYearId || null,
          event_date: selectedDate,
          title: dateTitle.trim(),
          description: dateDescription.trim() || null,
          date_type: dateType,
          lessons_allowed: dateLessonsAllowed,
          created_by: user?.id ?? null,
        });
      if (insertError) throw insertError;
      setDateTitle('');
      setDateDescription('');
      await finishMutation('Calendar date added.');
    } catch (mutationError) { reportMutationError(mutationError, 'Could not add the calendar date.'); }
    finally { setSaving(false); }
  }

  async function deleteCalendarDate(dateId: string) {
    if (!window.confirm('Delete this calendar date?')) return;
    setSaving(true);
    setError('');
    try {
      const { error: deleteError } = await requireSupabase().from('academic_calendar_dates').delete().eq('id', dateId).eq('school_id', schoolId);
      if (deleteError) throw deleteError;
      await finishMutation('Calendar date deleted.');
    } catch (mutationError) { reportMutationError(mutationError, 'Could not delete the calendar date.'); }
    finally { setSaving(false); }
  }

  async function saveOverride(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !calendarId || !overrideScheduleId) return;
    if (overrideAction !== 'add' && !overrideEntryId) { setError('Choose the scheduled lesson this exception applies to.'); return; }
    if (overrideAction !== 'cancel' && overrideEnd <= overrideStart) { setError('The period end time must be later than its start.'); return; }
    if (overrideAction !== 'cancel' && overrideType === 'lesson' && (!overrideClassId || !overrideSubjectId)) {
      setError('Lesson exceptions need a class and subject.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const blockedDate = selectedDateFlags.some((item) => !item.lessons_allowed);
      if (blockedDate && overrideAction !== 'cancel' && overrideType === 'lesson') {
        throw new Error('Lessons cannot be added on this calendar date. Enable lessons for the calendar date first.');
      }
      const { error: insertError } = await requireSupabase().from('timetable_date_overrides')
        .insert({
          school_id: schoolId,
          calendar_id: calendarId,
          schedule_id: overrideScheduleId,
          event_date: selectedDate,
          action: overrideAction,
          original_entry_id: overrideAction === 'add' ? null : overrideEntryId,
          entry_type: overrideType,
          class_id: overrideType === 'lesson' ? overrideClassId : null,
          subject_id: overrideType === 'lesson' ? overrideSubjectId : null,
          teacher_id: overrideType === 'lesson' ? overrideTeacherId || null : null,
          starts_at: overrideAction === 'cancel' ? null : `${overrideStart}:00`,
          ends_at: overrideAction === 'cancel' ? null : `${overrideEnd}:00`,
          room: overrideRoom.trim() || null,
          label: overrideType === 'lesson' ? null : overrideLabel.trim(),
          created_by: user?.id ?? null,
        });
      if (insertError) throw insertError;
      setShowOverrideForm(false);
      await finishMutation('Timetable exception saved.');
    } catch (mutationError) { reportMutationError(mutationError, 'Could not save the timetable exception.'); }
    finally { setSaving(false); }
  }

  async function deleteOverride(overrideId: string) {
    if (!window.confirm('Remove this timetable exception?')) return;
    setSaving(true);
    setError('');
    try {
      const { error: deleteError } = await requireSupabase().from('timetable_date_overrides').delete().eq('id', overrideId).eq('school_id', schoolId);
      if (deleteError) throw deleteError;
      await finishMutation('Timetable exception removed.');
    } catch (mutationError) { reportMutationError(mutationError, 'Could not remove the timetable exception.'); }
    finally { setSaving(false); }
  }

  const applicableOverrides = overrides.filter((item) => item.event_date === selectedDate);
  const exceptionEntries = entries.filter((entry) => entry.schedule_id === overrideScheduleId
    && entry.day_of_week === dayNumber(selectedDate)
    && entry.cycle_week === activeCycleWeek
    && entry.entry_type === 'lesson');

  return <div className="page-stack academic-calendar-page">
    <div className="page-heading academic-calendar-heading">
      <div><span className="eyebrow">{activeMembership?.school.name} · Academics</span><h1>Academic calendar</h1><p>Manage school calendars, terms, teaching patterns, holidays, and schedule exceptions.</p></div>
      <div className="timetable-heading-actions">
        <label className="schedule-select"><span className="sr-only">Select academic calendar</span><select aria-label="Select academic calendar" value={calendarId} onChange={(event) => { setCalendarId(event.target.value); setSuccess(''); setError(''); }} disabled={!calendars.length}>{calendars.map((item) => <option key={item.id} value={item.id}>{item.name}{item.division_name ? ` · ${item.division_name}` : item.is_default ? ' · Default' : ''}</option>)}</select></label>
        {canManage && <button className="button button-quiet" type="button" onClick={() => setShowCalendarForm(!showCalendarForm)}><Plus size={15} />Add calendar</button>}
      </div>
    </div>
    {error && <ErrorState message={error} />}
    {success && <SuccessMessage message={success} />}
    {showCalendarForm && <form className="content-card calendar-inline-form" onSubmit={(event) => void createCalendar(event)}>
      <label className="field"><span>Calendar name</span><input required minLength={2} maxLength={120} value={calendarName} onChange={(event) => setCalendarName(event.target.value)} placeholder="e.g. Secondary division" /></label>
      <label className="field"><span>School division (optional)</span><input maxLength={120} value={divisionName} onChange={(event) => setDivisionName(event.target.value)} placeholder="e.g. Secondary" /></label>
      <button className="button button-primary" type="submit" disabled={saving}>Create calendar</button>
    </form>}
    {loading ? <LoadingState label="Loading academic calendar…" /> : !activeCalendar ? <section className="content-card"><EmptyState title="No academic calendar yet" detail={canManage ? 'Create a calendar to get started.' : 'Your school has not configured an academic calendar yet.'} /></section> : <>
      <section className="academic-calendar-layout">
        <article className="content-card month-calendar">
          <div className="calendar-toolbar"><button className="icon-button" type="button" onClick={() => { const next = new Date(year, month - 1, 1); setMonth(next.getMonth()); setYear(next.getFullYear()); }} aria-label="Previous month"><ArrowLeft size={17} /></button><h2>{monthTitle}</h2><button className="icon-button" type="button" onClick={() => { const next = new Date(year, month + 1, 1); setMonth(next.getMonth()); setYear(next.getFullYear()); }} aria-label="Next month"><ArrowRight size={17} /></button></div>
          <div className="calendar-weekday-row">{weekdays.map((day) => <span key={day}>{day.slice(0, 3)}</span>)}</div>
          <div className="calendar-month-grid">{datesInMonth.map((date) => {
            const dateKey = localDateKey(date);
            const markers = datesByValue.get(dateKey) ?? [];
            const week = weeks.find((item) => dateKey >= item.starts_on && dateKey <= item.ends_on);
            const dayNumber = ((date.getDay() + 6) % 7) + 1;
            const weekdayOpen = patternDays.some((item) => item.pattern_id === (week?.pattern_id ?? activePattern?.id) && item.day_of_week === dayNumber && item.is_open);
            const closed = markers.some((item) => !item.lessons_allowed);
            return <button key={dateKey} type="button" className={`calendar-cell${date.getMonth() !== month ? ' outside-month' : ''}${selectedDate === dateKey ? ' selected' : ''}${dateKey === today ? ' today' : ''}${!weekdayOpen || closed ? ' non-teaching-day' : ''}`} onClick={() => { setSelectedDate(dateKey); if (date.getMonth() !== month) { setMonth(date.getMonth()); setYear(date.getFullYear()); } }}>
              <span>{date.getDate()}</span>{week && <small className="calendar-week-tag">W{week.week_number}</small>}
              <span className="calendar-markers">{markers.slice(0, 3).map((marker) => <i key={marker.id} className={`date-marker marker-${marker.date_type}`} title={`${marker.title} · ${dateTypeLabels[marker.date_type]}`} />)}</span>
            </button>;
          })}</div>
          <div className="calendar-legend"><span><i className="date-marker marker-public_holiday" />Holiday</span><span><i className="date-marker marker-closure" />Closure</span><span><i className="date-marker marker-examination" />Exam</span><span><i className="date-marker marker-activity" />Activity</span></div>
        </article>
        <article className="content-card selected-date-panel">
          <span className="eyebrow">{activeCalendar.name}{activeCalendar.division_name ? ` · ${activeCalendar.division_name}` : ''}</span>
          <h2>{displayDate(selectedDate, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</h2>
          {activeYear && <p className="calendar-context">{activeYear.name}{selectedWeek ? ` · Teaching week ${selectedWeek.week_number} · Cycle ${selectedWeek.cycle_week === 1 ? 'A' : 'B'}` : ''}{activePattern ? ` · ${activePattern.name}` : ''}</p>}
          {!isOpenDay && <div className="calendar-status-note"><CalendarDays size={15} />This is not an operating day for the selected week pattern.</div>}
          {dayClosed && <div className="calendar-closure-note"><AlertTriangle size={15} />Normal lessons are not scheduled on this date.</div>}
          <div className="selected-date-events">
            {selectedDateFlags.map((item) => <div className={`date-event date-event-${item.date_type}`} key={item.id}>
              <span className="date-event-tag">{dateTypeLabels[item.date_type]}{item.lessons_allowed ? ' · Lessons allowed' : ''}</span><strong>{item.title}</strong>{item.description && <small>{item.description}</small>}
              {canManage && <button type="button" className="icon-button" onClick={() => void deleteCalendarDate(item.id)} disabled={saving} aria-label={`Delete ${item.title}`}><Trash2 size={14} /></button>}
            </div>)}
            {selectedDateFlags.length === 0 && <p className="calendar-muted-copy">No academic calendar events on this date.</p>}
          </div>
          <div className="selected-date-lessons"><h3>Timetable</h3>
            {selectedSchedule && <p className="calendar-muted-copy">{selectedSchedule.name} · {activePattern?.name ?? 'Weekly pattern'}</p>}
            {shownEntries.length ? shownEntries.map((entry) => {
              const schoolClass = relation(entry.class);
              const subject = relation(entry.subject);
              const teacher = relation(entry.teacher);
              return <div className="calendar-lesson" key={entry.id}><time>{entry.starts_at.slice(0, 5)}–{entry.ends_at.slice(0, 5)}</time><div><strong>{subject?.name ?? entry.label ?? entry.entry_type}</strong><small>{schoolClass?.name ?? 'All classes'}{teacher ? ` · ${teacher.first_name} ${teacher.last_name}` : ''}</small></div><span>{entry.room ?? ''}</span></div>;
            }) : <p className="calendar-muted-copy">{dayClosed ? 'School is closed; weekly lessons are suppressed.' : !isOpenDay ? 'There is no regular timetable on this day.' : 'No published timetable periods for this day.'}</p>}
          </div>
          {canManage && <button className="button button-quiet full-width calendar-exception-trigger" type="button" onClick={() => { const published = selectedSchedule?.status === 'published' ? selectedSchedule : schedules.find((item) => item.status === 'published' && item.academic_year_id === activeYear?.id && item.week_pattern_id === activePattern?.id); setOverrideScheduleId(published?.id ?? ''); setOverrideAction('cancel'); setOverrideEntryId(''); setShowOverrideForm(true); setTab('exceptions'); }} disabled={!schedules.some((item) => item.status === 'published' && item.academic_year_id === activeYear?.id && item.week_pattern_id === activePattern?.id)}>Add date exception</button>}
        </article>
      </section>

      {canManage && <section className="content-card calendar-management">
        <div className="section-heading"><div><span className="eyebrow">Configuration</span><h2>Calendar management</h2></div></div>
        <div className="calendar-tabs" role="tablist" aria-label="Academic calendar settings">
          {calendarTabs.map((item) => <button type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} key={item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}
        </div>
        {tab === 'years' && <div className="calendar-management-grid">
          <form className="calendar-config-form" onSubmit={(event) => void createAcademicYear(event)}>
            <h3>Add academic year</h3>
            <label className="field"><span>Year name</span><input required maxLength={80} value={yearName} onChange={(event) => setYearName(event.target.value)} placeholder="e.g. 2026–2027" /></label>
            <div className="form-row"><label className="field"><span>Starts</span><input required type="date" value={yearStart} onChange={(event) => setYearStart(event.target.value)} /></label><label className="field"><span>Ends</span><input required type="date" value={yearEnd} onChange={(event) => setYearEnd(event.target.value)} /></label></div>
            <button className="button button-primary" type="submit" disabled={saving}>Add academic year</button>
          </form>
          <form className="calendar-config-form" onSubmit={(event) => void createTerm(event)}>
            <h3>Add term / semester</h3>
            <label className="field"><span>Academic year</span><select required value={termYearId} onChange={(event) => setTermYearId(event.target.value)}><option value="">Choose a year</option>{years.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label className="field"><span>Term name</span><input required maxLength={80} value={termName} onChange={(event) => setTermName(event.target.value)} placeholder="e.g. Term 1 / Semester 1" /></label>
            <div className="form-row"><label className="field"><span>Starts</span><input required type="date" value={termStart} onChange={(event) => setTermStart(event.target.value)} /></label><label className="field"><span>Ends</span><input required type="date" value={termEnd} onChange={(event) => setTermEnd(event.target.value)} /></label></div>
            <button className="button button-primary" type="submit" disabled={saving || !years.length}>Add term</button>
          </form>
          <div className="calendar-record-list"><h3>Academic years</h3>{years.map((item) => <div className="calendar-record-row" key={item.id}><div><strong>{item.name}</strong><small>{displayDate(item.start_date)} – {displayDate(item.end_date)}</small></div>{item.is_current ? <span className="status-pill status-active">Current</span> : <button className="button button-quiet" type="button" onClick={() => void setCurrentYear(item.id)} disabled={saving}>Make current</button>}</div>)}{!years.length && <p className="calendar-muted-copy">No academic years configured.</p>}</div>
          <div className="calendar-record-list"><h3>Terms & semesters</h3>{terms.map((item) => <div className="calendar-record-row" key={item.id}><div><strong>{item.name}</strong><small>{years.find((year) => year.id === item.academic_year_id)?.name} · {displayDate(item.start_date)} – {displayDate(item.end_date)}</small></div><button className="icon-button" type="button" onClick={() => void deleteTerm(item.id)} disabled={saving} aria-label={`Delete ${item.name}`}><Trash2 size={14} /></button></div>)}{!terms.length && <p className="calendar-muted-copy">No terms configured.</p>}</div>
        </div>}
        {tab === 'weeks' && <div className="calendar-management-grid">
          <form className="calendar-config-form" onSubmit={(event) => void savePattern(event)}>
            <h3>Configure school days / week pattern</h3>
            <label className="field"><span>Pattern name</span><input required maxLength={40} value={patternName} onChange={(event) => setPatternName(event.target.value)} placeholder="e.g. Pattern A" /></label>
            <div className="operating-day-options">{weekdays.map((day, index) => <label key={day}><input type="checkbox" checked={patternOperatingDays.includes(index + 1)} onChange={() => setPatternOperatingDays((current) => current.includes(index + 1) ? current.filter((item) => item !== index + 1) : [...current, index + 1].sort())} />{day}</label>)}</div>
            <button className="button button-primary" type="submit" disabled={saving || !patternOperatingDays.length}>Save day pattern</button>
            <div className="pattern-existing-list">{patterns.map((pattern) => <div key={pattern.id}><strong>{pattern.name}</strong><small>{patternDays.filter((item) => item.pattern_id === pattern.id && item.is_open).map((item) => weekdays[item.day_of_week - 1].slice(0, 3)).join(', ') || 'No teaching days'}</small></div>)}</div>
          </form>
          <form className="calendar-config-form" onSubmit={(event) => void createWeek(event)}>
            <h3>Add teaching week</h3><p className="calendar-muted-copy">{activeYear ? `For ${activeYear.name}. Weeks must fit within the academic-year dates.` : 'Add an academic year first.'}</p>
            <div className="form-row"><label className="field"><span>Week number</span><input required type="number" min={1} max={80} value={weekNumber} onChange={(event) => setWeekNumber(Number(event.target.value))} /></label><label className="field"><span>Cycle week</span><select value={weekCycle} onChange={(event) => setWeekCycle(Number(event.target.value))}><option value={1}>Week A / cycle 1</option><option value={2}>Week B / cycle 2</option></select></label></div>
            <label className="field"><span>Pattern</span><select required value={weekPatternId} onChange={(event) => setWeekPatternId(event.target.value)}>{patterns.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <div className="form-row"><label className="field"><span>Week starts</span><input required type="date" value={weekStart} onChange={(event) => setWeekStart(event.target.value)} /></label><label className="field"><span>Week ends</span><input required type="date" value={weekEnd} onChange={(event) => setWeekEnd(event.target.value)} /></label></div>
            <button className="button button-primary" type="submit" disabled={saving || !activeYear || !patterns.length}>Add teaching week</button>
            <div className="calendar-record-list">{weeks.map((item) => <div className="calendar-record-row" key={item.id}><div><strong>Week {item.week_number} · Cycle {item.cycle_week === 1 ? 'A' : 'B'} · {patterns.find((pattern) => pattern.id === item.pattern_id)?.name}</strong><small>{displayDate(item.starts_on)} – {displayDate(item.ends_on)}</small></div><button className="icon-button" type="button" onClick={() => void deleteWeek(item.id)} disabled={saving} aria-label={`Delete week ${item.week_number}`}><Trash2 size={14} /></button></div>)}{!weeks.length && <p className="calendar-muted-copy">No teaching weeks configured in this calendar year view.</p>}</div>
          </form>
        </div>}
        {tab === 'bell' && <div className="bell-management">
          <form className="calendar-inline-form bell-create-form" onSubmit={(event) => void createBellSchedule(event)}>
            <label className="field"><span>Bell schedule name</span><input required minLength={2} maxLength={100} value={bellName} onChange={(event) => setBellName(event.target.value)} placeholder="e.g. Standard day" /></label>
            <label className="field"><span>Week pattern</span><select required value={bellPatternId} onChange={(event) => setBellPatternId(event.target.value)}>{patterns.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label className="field"><span>Rotation cycle</span><select value={bellCycleWeeks} onChange={(event) => setBellCycleWeeks(Number(event.target.value))}><option value={1}>Weekly schedule</option><option value={2}>Two-week rotation (A/B)</option></select></label>
            <button className="button button-primary" type="submit" disabled={saving || !patterns.length}>Create bell schedule</button>
          </form>
          {bellSchedules.length > 0 && <div className="bell-schedule-toolbar">
            <label className="field"><span>Bell schedule</span><select value={bellScheduleId} onChange={(event) => { setBellScheduleId(event.target.value); resetBellPeriodForm(); }}>{bellSchedules.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            {selectedBellSchedule && <><button className="button button-quiet" type="button" disabled={saving} onClick={() => void updateBellSchedule({ cycle_weeks: selectedBellSchedule.cycle_weeks === 1 ? 2 : 1 })}>{selectedBellSchedule.cycle_weeks === 1 ? 'Enable A/B rotation' : 'Use weekly schedule'}</button><button className="icon-button" type="button" disabled={saving} aria-label="Delete bell schedule" onClick={() => void deleteBellSchedule(selectedBellSchedule.id)}><Trash2 size={15} /></button></>}
          </div>}
          {!bellSchedules.length && <EmptyState title="No bell schedules" detail="Create a bell schedule to configure day-specific periods, breaks, assemblies, registration, and lesson availability." />}
          {selectedBellSchedule && <div className="bell-management-grid">
            <form className="calendar-config-form bell-period-form" onSubmit={(event) => void saveBellPeriod(event)}>
              <h3>{periodEditingId ? 'Edit period' : 'Add period'}</h3>
              {selectedBellSchedule.cycle_weeks === 2 && <label className="field"><span>Rotation week</span><select value={periodCycle} onChange={(event) => setPeriodCycle(Number(event.target.value))}><option value={1}>Week A</option><option value={2}>Week B</option></select></label>}
              <label className="field"><span>Day</span><select value={periodDay} onChange={(event) => setPeriodDay(Number(event.target.value))}>{weekdays.map((day, index) => <option value={index + 1} key={day} disabled={!patternDays.some((item) => item.pattern_id === selectedBellSchedule.week_pattern_id && item.day_of_week === index + 1 && item.is_open)}>{day}</option>)}</select></label>
              <div className="form-row"><label className="field"><span>Period number</span><input required type="number" min={1} max={24} value={periodNumber} onChange={(event) => setPeriodNumber(Number(event.target.value))} /></label><label className="field"><span>Period type</span><select value={periodType} onChange={(event) => { setPeriodType(event.target.value as BellPeriod['period_type']); if (event.target.value !== 'lesson') setPeriodAllowsDouble(false); }}><option value="lesson">Lesson</option><option value="break">Break</option><option value="lunch">Lunch</option><option value="assembly">Assembly</option><option value="registration">Registration</option><option value="other">Other</option></select></label></div>
              <label className="field"><span>Period name</span><input required maxLength={80} value={periodName} onChange={(event) => setPeriodName(event.target.value)} placeholder={periodType === 'lesson' ? 'e.g. Period 1' : `e.g. ${periodType}`} /></label>
              <div className="form-row"><label className="field"><span>Starts</span><input required type="time" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} /></label><label className="field"><span>Ends</span><input required type="time" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} /></label></div>
              {periodType === 'lesson' && <>
                <label className="calendar-checkbox"><input type="checkbox" checked={periodAllowsDouble} onChange={(event) => setPeriodAllowsDouble(event.target.checked)} /><span>Allow this period to begin a double lesson</span></label>
                <fieldset className="bell-subject-rules"><legend>Subject availability</legend><p className="calendar-muted-copy">Leave all unchecked to allow any subject.</p>{subjects.map((subject) => <label key={subject.id}><input type="checkbox" checked={periodAllowedSubjects.includes(subject.id)} onChange={() => setPeriodAllowedSubjects((current) => current.includes(subject.id) ? current.filter((id) => id !== subject.id) : [...current, subject.id])} />{subject.name}</label>)}</fieldset>
              </>}
              <div className="calendar-form-actions"><button className="button button-primary" type="submit" disabled={saving}>{periodEditingId ? 'Save period' : 'Add period'}</button>{periodEditingId && <button className="button button-quiet" type="button" onClick={resetBellPeriodForm}>Cancel edit</button>}</div>
            </form>
            <div className="bell-preview">
              <div className="calendar-record-list"><h3>{selectedBellSchedule.name} · preview</h3>
                {selectedBellSchedule.cycle_weeks === 2 && <div className="calendar-tabs bell-cycle-tabs">{[1, 2].map((cycle) => <button type="button" key={cycle} className={periodCycle === cycle ? 'active' : ''} onClick={() => setPeriodCycle(cycle)}>{cycle === 1 ? 'Week A' : 'Week B'}</button>)}</div>}
                {weekdays.map((day, dayIndex) => {
                  const isOpen = patternDays.some((item) => item.pattern_id === selectedBellSchedule.week_pattern_id && item.day_of_week === dayIndex + 1 && item.is_open);
                  const dayPeriods = selectedBellPeriods.filter((item) => item.cycle_week === periodCycle && item.day_of_week === dayIndex + 1);
                  if (!isOpen && !dayPeriods.length) return null;
                  return <section className="bell-preview-day" key={day}><h4>{day}</h4>{dayPeriods.length ? dayPeriods.map((period) => {
                    const ruleIds = bellPeriodSubjects.filter((item) => item.period_id === period.id).map((item) => item.subject_id);
                    const isEditing = periodEditingId === period.id;
                    return <div className={`bell-period-row${isEditing ? ' editing' : ''}`} key={period.id}><time>{period.starts_at.slice(0, 5)}–{period.ends_at.slice(0, 5)}</time><span className={`bell-period-type bell-${period.period_type}`}>{period.name}</span><small>{period.period_type}{period.allows_double ? ' · double allowed' : ''}{ruleIds.length ? ` · ${ruleIds.map((id) => subjects.find((subject) => subject.id === id)?.name ?? 'Subject').join(', ')}` : ''}</small><span className="bell-period-actions"><button className="icon-button" type="button" aria-label={`Edit ${period.name}`} onClick={() => editBellPeriod(period)}><span aria-hidden="true">✎</span></button><button className="icon-button" type="button" aria-label={`Delete ${period.name}`} disabled={saving} onClick={() => void deleteBellPeriod(period.id)}><Trash2 size={14} /></button></span></div>;
                  }) : <p className="calendar-muted-copy">No periods configured yet.</p>}</section>;
                })}
              </div>
            </div>
          </div>}
        </div>}
        {tab === 'dates' && <div className="calendar-management-grid">
          <form className="calendar-config-form" onSubmit={(event) => void createCalendarDate(event)}>
            <h3>Add date to {displayDate(selectedDate, { month: 'short', day: 'numeric', year: 'numeric' })}</h3>
            <label className="field"><span>Title</span><input required minLength={2} maxLength={120} value={dateTitle} onChange={(event) => setDateTitle(event.target.value)} placeholder="e.g. National holiday" /></label>
            <label className="field"><span>Date type</span><select value={dateType} onChange={(event) => { setDateType(event.target.value as DateType); setDateLessonsAllowed(false); }}>{Object.entries(dateTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
            <label className="field"><span>Academic year (optional)</span><select value={dateYearId} onChange={(event) => setDateYearId(event.target.value)}><option value="">Calendar-wide</option>{years.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label className="field"><span>Description</span><input maxLength={500} value={dateDescription} onChange={(event) => setDateDescription(event.target.value)} /></label>
            <label className="calendar-checkbox"><input type="checkbox" checked={dateLessonsAllowed} onChange={(event) => setDateLessonsAllowed(event.target.checked)} /><span>Allow normal lessons on this date</span></label>
            <button className="button button-primary" type="submit" disabled={saving}>Add calendar date</button>
          </form>
          <div className="calendar-record-list"><h3>Dates in {monthTitle}</h3>{calendarDates.filter((item) => item.event_date.slice(0, 7) === `${year}-${String(month + 1).padStart(2, '0')}`).map((item) => <div className="calendar-record-row" key={item.id}><div><strong>{displayDate(item.event_date)} · {item.title}</strong><small>{dateTypeLabels[item.date_type]}{item.lessons_allowed ? ' · Lessons allowed' : ' · No normal lessons'}</small></div><button className="icon-button" type="button" onClick={() => void deleteCalendarDate(item.id)} disabled={saving} aria-label={`Delete ${item.title}`}><Trash2 size={14} /></button></div>)}{!calendarDates.length && <p className="calendar-muted-copy">No holidays or special dates configured.</p>}</div>
        </div>}
        {tab === 'exceptions' && <div className="calendar-management-grid">
          <div className="calendar-config-form"><h3>One-day timetable exceptions</h3><p className="calendar-muted-copy">Cancel or replace a regular period, or add a one-off class or activity. Published schedules remain unchanged.</p><button className="button button-primary" type="button" onClick={() => { const published = selectedSchedule?.status === 'published' ? selectedSchedule : schedules.find((item) => item.status === 'published' && item.academic_year_id === activeYear?.id && item.week_pattern_id === activePattern?.id); setOverrideScheduleId(published?.id ?? ''); setOverrideAction('cancel'); setOverrideEntryId(''); setShowOverrideForm(true); }} disabled={!schedules.some((item) => item.status === 'published' && item.academic_year_id === activeYear?.id && item.week_pattern_id === activePattern?.id)}>Add exception for {displayDate(selectedDate)}</button></div>
          <div className="calendar-record-list"><h3>Exceptions for selected date</h3>{applicableOverrides.map((item) => <div className="calendar-record-row" key={item.id}><div><strong>{item.action === 'cancel' ? 'Cancelled' : item.action === 'replace' ? 'Replaced' : 'Added'} · {item.label ?? subjects.find((subject) => subject.id === item.subject_id)?.name ?? item.entry_type}</strong><small>{schedules.find((schedule) => schedule.id === item.schedule_id)?.name} · {item.starts_at?.slice(0, 5) ?? '—'}{item.ends_at ? `–${item.ends_at.slice(0, 5)}` : ''}</small></div><button className="icon-button" type="button" onClick={() => void deleteOverride(item.id)} disabled={saving} aria-label="Delete exception"><Trash2 size={14} /></button></div>)}{!applicableOverrides.length && <p className="calendar-muted-copy">No timetable exceptions on this date.</p>}</div>
        </div>}
      </section>}
    </>}

    {showOverrideForm && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setShowOverrideForm(false); }}>
      <form className="modal-card modal-form calendar-override-modal" onSubmit={(event) => void saveOverride(event)}>
        <div className="modal-heading"><div><span className="eyebrow">Calendar exception</span><h2>Timetable for {displayDate(selectedDate)}</h2></div><button className="icon-button" type="button" onClick={() => setShowOverrideForm(false)} aria-label="Close">×</button></div>
        <label className="field"><span>Published timetable</span><select required value={overrideScheduleId} onChange={(event) => setOverrideScheduleId(event.target.value)}>{schedules.filter((item) => item.status === 'published' || canManage).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}</select></label>
        <div className="form-row"><label className="field"><span>Exception</span><select value={overrideAction} onChange={(event) => { const value = event.target.value as OverrideAction; setOverrideAction(value); setOverrideEntryId(''); }}><option value="cancel">Cancel a regular lesson</option><option value="replace">Replace a regular lesson</option><option value="add">Add one-off period</option></select></label>{overrideAction !== 'add' && <label className="field"><span>Regular lesson</span><select required value={overrideEntryId} onChange={(event) => setOverrideEntryId(event.target.value)}><option value="">Choose a lesson</option>{exceptionEntries.map((entry) => <option key={entry.id} value={entry.id}>{entry.starts_at.slice(0, 5)} · {relation(entry.subject)?.name ?? 'Lesson'} · {relation(entry.class)?.name ?? 'Class'}</option>)}</select></label>}</div>
        {overrideAction !== 'cancel' && <>
          <label className="field"><span>Period type</span><select value={overrideType} onChange={(event) => setOverrideType(event.target.value as TimetableEntry['entry_type'])}><option value="lesson">Lesson</option><option value="registration">Registration</option><option value="break">Break</option><option value="lunch">Lunch</option><option value="other">Other activity</option></select></label>
          {overrideType === 'lesson' ? <><div className="form-row"><label className="field"><span>Class</span><select required value={overrideClassId} onChange={(event) => setOverrideClassId(event.target.value)}><option value="">Choose class</option>{classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="field"><span>Subject</span><select required value={overrideSubjectId} onChange={(event) => setOverrideSubjectId(event.target.value)}><option value="">Choose subject</option>{subjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div><label className="field"><span>Teacher (optional)</span><select value={overrideTeacherId} onChange={(event) => setOverrideTeacherId(event.target.value)}><option value="">Unassigned</option>{teachers.map((item) => <option key={item.id} value={item.id}>{item.first_name} {item.last_name}</option>)}</select></label></> : <label className="field"><span>Activity name</span><input required value={overrideLabel} onChange={(event) => setOverrideLabel(event.target.value)} maxLength={120} /></label>}
          <div className="form-row"><label className="field"><span>Starts</span><input required type="time" value={overrideStart} onChange={(event) => setOverrideStart(event.target.value)} /></label><label className="field"><span>Ends</span><input required type="time" value={overrideEnd} onChange={(event) => setOverrideEnd(event.target.value)} /></label></div>
          <label className="field"><span>Room</span><input maxLength={80} value={overrideRoom} onChange={(event) => setOverrideRoom(event.target.value)} /></label>
        </>}
        {error && <ErrorState message={error} />}
        <div className="modal-actions"><button className="button button-quiet" type="button" onClick={() => setShowOverrideForm(false)}>Cancel</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save exception'}</button></div>
      </form>
    </div>}
  </div>;
}
