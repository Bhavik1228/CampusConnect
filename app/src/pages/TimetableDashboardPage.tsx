import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle, ArrowUpRight, BookOpen, CalendarClock, CalendarDays, Check,
  Clock3, Download, DoorOpen, Edit3, Plus, Printer, RefreshCw, Users,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';
import { TimetableManager } from './TimetableManager';

type ScheduleStatus = 'draft' | 'published' | 'archived';
type EntryType = 'lesson' | 'registration' | 'break' | 'lunch' | 'other';
type Relation<T> = T | T[] | null;

interface TimetableSchedule {
  id: string;
  name: string;
  status: ScheduleStatus;
  updated_at: string;
  calendar_id: string;
  academic_year_id: string | null;
  week_pattern_id: string;
  bell_schedule_id: string | null;
  cycle_weeks: number;
}

interface CalendarChoice { id: string; name: string; division_name: string | null; is_default: boolean }
interface YearChoice { id: string; name: string; calendar_id: string; is_current: boolean }
interface PatternChoice { id: string; name: string; calendar_id: string }
interface BellScheduleChoice { id: string; name: string; calendar_id: string; week_pattern_id: string; cycle_weeks: number }
interface AcademicWeekChoice { calendar_id: string; academic_year_id: string; starts_on: string; ends_on: string; cycle_week: number }

interface TimetableEntry {
  id: string;
  schedule_id: string | null;
  class_id: string | null;
  subject_id: string | null;
  teacher_id: string | null;
  day_of_week: number;
  starts_at: string;
  ends_at: string;
  room: string | null;
  entry_type: EntryType;
  label: string | null;
  cycle_week: number;
  bell_period_id: string | null;
  updated_at: string;
  class: Relation<{ name: string }>;
  subject: Relation<{ name: string }>;
  teacher: Relation<{ first_name: string; last_name: string }>;
  schedule: Relation<{ name: string; status: ScheduleStatus; updated_at: string }>;
}

interface Conflict {
  first: TimetableEntry;
  second: TimetableEntry;
  resources: string[];
}

interface Activity {
  id: string;
  scheduleId: string;
  title: string;
  detail: string;
  updatedAt: string;
}

const dayLabels = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const timetableSelect = [
  'id', 'schedule_id', 'class_id', 'subject_id', 'teacher_id', 'day_of_week',
  'starts_at', 'ends_at', 'room', 'entry_type', 'label', 'updated_at', 'cycle_week', 'bell_period_id',
  'class:school_classes(name)', 'subject:subjects(name)',
  'teacher:teacher_profiles(first_name,last_name)',
  'schedule:timetable_schedules(name,status,updated_at)',
].join(',');

function relation<T>(value: Relation<T> | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function minutes(time: string) {
  const [hours, mins] = time.split(':').map(Number);
  return hours * 60 + mins;
}

function formatTime(time: string) {
  const [hours, minute] = time.split(':').map(Number);
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
    .format(new Date(2000, 0, 1, hours, minute));
}

function teacherName(entry: TimetableEntry) {
  const teacher = relation(entry.teacher);
  return teacher ? `${teacher.first_name} ${teacher.last_name}` : 'Teacher unassigned';
}

function className(entry: TimetableEntry) {
  return relation(entry.class)?.name ?? 'All classes';
}

function subjectName(entry: TimetableEntry) {
  return relation(entry.subject)?.name ?? entry.label ?? 'Scheduled activity';
}

function getSchoolClock(timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const weekday = parts.find((part) => part.type === 'weekday')?.value;
  const dayOfWeek = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekday ?? '') + 1;
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
  return { dayOfWeek, time: `${hour}:${minute}` };
}

function findConflicts(entries: TimetableEntry[]): Conflict[] {
  const lessons = entries.filter((entry) => entry.entry_type === 'lesson');
  const conflicts: Conflict[] = [];
  for (let index = 0; index < lessons.length; index += 1) {
    const first = lessons[index];
    for (const second of lessons.slice(index + 1)) {
      if (first.day_of_week !== second.day_of_week
          || first.schedule_id !== second.schedule_id
          || first.cycle_week !== second.cycle_week) continue;
      if (minutes(first.starts_at) >= minutes(second.ends_at) || minutes(second.starts_at) >= minutes(first.ends_at)) continue;
      const resources: string[] = [];
      if (first.class_id && first.class_id === second.class_id) resources.push(`Class ${className(first)}`);
      if (first.teacher_id && first.teacher_id === second.teacher_id) resources.push(`Teacher ${teacherName(first)}`);
      if (first.room?.trim() && first.room.trim().toLowerCase() === second.room?.trim().toLowerCase()) {
        resources.push(`Room ${first.room.trim()}`);
      }
      if (resources.length) conflicts.push({ first, second, resources });
    }
  }
  return conflicts;
}

function countOpenWindows(entries: TimetableEntry[], getResource: (entry: TimetableEntry) => string | null) {
  const groups = new Map<string, TimetableEntry[]>();
  for (const entry of entries) {
    if (entry.entry_type !== 'lesson') continue;
    const resource = getResource(entry);
    if (!resource) continue;
    const key = `${entry.schedule_id ?? 'legacy'}:${entry.cycle_week}:${entry.day_of_week}:${resource}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  let gaps = 0;
  for (const lessons of groups.values()) {
    lessons.sort((left, right) => left.starts_at.localeCompare(right.starts_at));
    let occupiedUntil = minutes(lessons[0].ends_at);
    for (const lesson of lessons.slice(1)) {
      const start = minutes(lesson.starts_at);
      if (start > occupiedUntil) gaps += 1;
      occupiedUntil = Math.max(occupiedUntil, minutes(lesson.ends_at));
    }
  }
  return gaps;
}

function displayUpdatedAt(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    .format(new Date(value));
}

async function loadEntries(schoolId: string) {
  const client = requireSupabase();
  const entries: TimetableEntry[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await client
      .from('timetable')
      .select(timetableSelect)
      .eq('school_id', schoolId)
      .order('day_of_week')
      .order('starts_at')
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as TimetableEntry[];
    entries.push(...page);
    if (page.length < pageSize) return entries;
  }
}

export function TimetableDashboardPage() {
  const { activeMembership, user } = useAuth();
  const schoolId = activeMembership?.school_id;
  const timeZone = activeMembership?.school.timezone ?? 'UTC';
  const canManage = activeMembership?.role === 'school_admin'
    || activeMembership?.role === 'academic_coordinator'
    || activeMembership?.role === 'system_admin';
  const [schedules, setSchedules] = useState<TimetableSchedule[]>([]);
  const [calendars, setCalendars] = useState<CalendarChoice[]>([]);
  const [academicYears, setAcademicYears] = useState<YearChoice[]>([]);
  const [weekPatterns, setWeekPatterns] = useState<PatternChoice[]>([]);
  const [bellSchedules, setBellSchedules] = useState<BellScheduleChoice[]>([]);
  const [weeks, setWeeks] = useState<AcademicWeekChoice[]>([]);
  const [entries, setEntries] = useState<TimetableEntry[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [selectedScheduleId, setSelectedScheduleId] = useState('');
  const [selectedTimetableClassId, setSelectedTimetableClassId] = useState('');
  const [selectedTimetableCycle, setSelectedTimetableCycle] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [scheduleDialog, setScheduleDialog] = useState<'create' | 'edit' | null>(null);
  const [scheduleName, setScheduleName] = useState('');
  const [scheduleCalendarId, setScheduleCalendarId] = useState('');
  const [scheduleYearId, setScheduleYearId] = useState('');
  const [schedulePatternId, setSchedulePatternId] = useState('');
  const [scheduleBellId, setScheduleBellId] = useState('');

  const refresh = useCallback(async () => {
    if (!schoolId) return;
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [scheduleResult, timetableEntries, changesResult, calendarResult, yearResult, patternResult, bellResult, weekResult] = await Promise.all([
        client.from('timetable_schedules')
          .select('id,name,status,updated_at,calendar_id,academic_year_id,week_pattern_id,bell_schedule_id,cycle_weeks')
          .eq('school_id', schoolId)
          .order('updated_at', { ascending: false }),
        loadEntries(schoolId),
        client.from('timetable_schedule_changes')
          .select('id,schedule_id,action,summary,created_at')
          .eq('school_id', schoolId)
          .order('created_at', { ascending: false })
          .limit(50),
        client.from('academic_calendars').select('id,name,division_name,is_default').eq('school_id', schoolId).order('name'),
        client.from('academic_years').select('id,name,calendar_id,is_current').eq('school_id', schoolId).order('start_date', { ascending: false }),
        client.from('academic_calendar_week_patterns').select('id,name,calendar_id').eq('school_id', schoolId).order('name'),
        client.from('academic_bell_schedules').select('id,name,calendar_id,week_pattern_id,cycle_weeks').eq('school_id', schoolId).order('name'),
        client.from('academic_calendar_weeks').select('calendar_id,academic_year_id,starts_on,ends_on,cycle_week').eq('school_id', schoolId),
      ]);
      if (scheduleResult.error) throw scheduleResult.error;
      if (changesResult.error) throw changesResult.error;
      if (calendarResult.error) throw calendarResult.error;
      if (yearResult.error) throw yearResult.error;
      if (patternResult.error) throw patternResult.error;
      if (bellResult.error) throw bellResult.error;
      if (weekResult.error) throw weekResult.error;
      const nextSchedules = (scheduleResult.data ?? []) as TimetableSchedule[];
      setCalendars((calendarResult.data ?? []) as CalendarChoice[]);
      setAcademicYears((yearResult.data ?? []) as YearChoice[]);
      setWeekPatterns((patternResult.data ?? []) as PatternChoice[]);
      setBellSchedules((bellResult.data ?? []) as BellScheduleChoice[]);
      setWeeks((weekResult.data ?? []) as AcademicWeekChoice[]);
      setSchedules(nextSchedules);
      setEntries(timetableEntries);
      setActivity((changesResult.data ?? []).map((change) => ({
        id: change.id,
        scheduleId: change.schedule_id,
        title: change.summary,
        detail: change.action.replaceAll('_', ' '),
        updatedAt: change.created_at,
      })));
      setSelectedScheduleId((current) => nextSchedules.some((schedule) => schedule.id === current)
        ? current
        : nextSchedules[0]?.id ?? '');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load the timetable dashboard.');
    } finally {
      setLoading(false);
    }
  }, [schoolId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const activeSchedule = schedules.find((schedule) => schedule.id === selectedScheduleId) ?? null;
  const activeEntries = useMemo(
    () => selectedScheduleId
      ? entries.filter((entry) => entry.schedule_id === selectedScheduleId)
      : entries.filter((entry) => entry.schedule_id === null),
    [entries, selectedScheduleId],
  );
  const timetableClasses = useMemo(() => {
    const classesById = new Map<string, string>();
    for (const entry of activeEntries) {
      if (entry.class_id) classesById.set(entry.class_id, className(entry));
    }
    return [...classesById.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [activeEntries]);
  useEffect(() => {
    if (!timetableClasses.some((schoolClass) => schoolClass.id === selectedTimetableClassId)) {
      setSelectedTimetableClassId(timetableClasses[0]?.id ?? '');
    }
  }, [timetableClasses, selectedTimetableClassId]);
  const displayedTimetableClass = timetableClasses.find((schoolClass) => schoolClass.id === selectedTimetableClassId);
  const timetableEntriesForClass = useMemo(() => activeEntries.filter((entry) =>
    entry.cycle_week === selectedTimetableCycle
      && (entry.class_id === selectedTimetableClassId || entry.class_id === null)),
  [activeEntries, selectedTimetableClassId, selectedTimetableCycle]);
  const timetableSlots = useMemo(() => {
    const byTime = new Map<string, { startsAt: string; endsAt: string }>();
    for (const entry of timetableEntriesForClass) {
      const existing = byTime.get(entry.starts_at);
      byTime.set(entry.starts_at, {
        startsAt: entry.starts_at,
        endsAt: !existing || entry.ends_at > existing.endsAt ? entry.ends_at : existing.endsAt,
      });
    }
    return [...byTime.values()].sort((left, right) =>
      left.startsAt.localeCompare(right.startsAt) || left.endsAt.localeCompare(right.endsAt));
  }, [timetableEntriesForClass]);
  const timetableDays = useMemo(() => dayLabels
    .map((label, index) => ({ label, dayOfWeek: index + 1 }))
    .filter((day) => timetableEntriesForClass.some((entry) => entry.day_of_week === day.dayOfWeek)),
  [timetableEntriesForClass]);
  const lessons = useMemo(() => activeEntries.filter((entry) => entry.entry_type === 'lesson'), [activeEntries]);
  const todaysDate = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
  const todaysCycleWeek = activeSchedule?.cycle_weeks === 2
    ? weeks.find((week) => week.calendar_id === activeSchedule.calendar_id
      && week.academic_year_id === activeSchedule.academic_year_id
      && todaysDate >= week.starts_on
      && todaysDate <= week.ends_on)?.cycle_week ?? 1
    : 1;
  useEffect(() => {
    setSelectedTimetableCycle(todaysCycleWeek);
  }, [selectedScheduleId, todaysCycleWeek]);
  const conflicts = useMemo(() => findConflicts(activeEntries), [activeEntries]);
  const { dayOfWeek: today, time: currentTime } = getSchoolClock(timeZone);
  const todayEntries = useMemo(
    () => activeEntries.filter((entry) => entry.day_of_week === today && entry.cycle_week === todaysCycleWeek)
      .sort((left, right) => left.starts_at.localeCompare(right.starts_at)),
    [activeEntries, today, todaysCycleWeek],
  );
  const upcoming = useMemo(() => {
    const localToday = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
    const date = new Date(`${localToday}T12:00:00Z`);
    const occurrences: { entry: TimetableEntry; daysAway: number; sortKey: number }[] = [];
    for (let daysAway = 0; daysAway < 14; daysAway += 1) {
      const dateKey = date.toISOString().slice(0, 10);
      const weekday = ((today - 1 + daysAway) % 7) + 1;
      const cycleWeek = activeSchedule?.cycle_weeks === 2
        ? weeks.find((week) => week.calendar_id === activeSchedule.calendar_id
          && week.academic_year_id === activeSchedule.academic_year_id
          && dateKey >= week.starts_on
          && dateKey <= week.ends_on)?.cycle_week ?? 1
        : 1;
      for (const entry of lessons) {
        if (entry.day_of_week !== weekday || entry.cycle_week !== cycleWeek) continue;
        if (daysAway === 0 && entry.starts_at.slice(0, 5) <= currentTime) continue;
        occurrences.push({ entry, daysAway, sortKey: daysAway * 1440 + minutes(entry.starts_at) });
      }
      date.setUTCDate(date.getUTCDate() + 1);
    }
    return occurrences.sort((left, right) => left.sortKey - right.sortKey)
      .slice(0, 5)
      .map(({ entry, daysAway }) => ({ entry, daysAway }));
  }, [lessons, today, currentTime, timeZone, weeks, activeSchedule]);
  const teacherWorkload = useMemo(() => {
    const workloads = new Map<string, { name: string; minutes: number }>();
    for (const entry of lessons) {
      if (!entry.teacher_id) continue;
      const current = workloads.get(entry.teacher_id) ?? { name: teacherName(entry), minutes: 0 };
      current.minutes += minutes(entry.ends_at) - minutes(entry.starts_at);
      workloads.set(entry.teacher_id, current);
    }
    return [...workloads.entries()]
      .map(([id, workload]) => ({ id, ...workload }))
      .sort((left, right) => right.minutes - left.minutes);
  }, [lessons]);
  const roomWorkload = useMemo(() => {
    const rooms = new Map<string, number>();
    for (const entry of lessons) {
      const room = entry.room?.trim();
      if (room) rooms.set(room, (rooms.get(room) ?? 0) + 1);
    }
    return [...rooms.entries()].map(([name, periods]) => ({ name, periods }))
      .sort((left, right) => right.periods - left.periods);
  }, [lessons]);
  const roomAssignmentCoverage = lessons.length
    ? Math.round(lessons.filter((entry) => entry.room?.trim()).length / lessons.length * 100)
    : 0;
  const recentChanges = useMemo(
    () => activity.filter((change) => !selectedScheduleId || change.scheduleId === selectedScheduleId).slice(0, 5),
    [activity, selectedScheduleId],
  );

  const classCount = new Set(lessons.map((entry) => entry.class_id).filter(Boolean)).size;
  const unassignedCount = lessons.filter((entry) => !entry.teacher_id || !entry.room?.trim()).length;
  const freeWindows = countOpenWindows(activeEntries, (entry) => entry.class_id);
  const publishBlocked = conflicts.length > 0 || unassignedCount > 0 || lessons.length === 0;

  function openCreateDialog() {
    setScheduleName('');
    const defaultCalendar = calendars.find((calendar) => calendar.is_default) ?? calendars[0];
    setScheduleCalendarId(defaultCalendar?.id ?? '');
    const currentYear = academicYears.find((item) => item.calendar_id === defaultCalendar?.id && item.is_current);
    setScheduleYearId(currentYear?.id ?? '');
    setSchedulePatternId(weekPatterns.find((item) => item.calendar_id === defaultCalendar?.id && item.name === 'Standard')?.id
      ?? weekPatterns.find((item) => item.calendar_id === defaultCalendar?.id)?.id
      ?? '');
    setScheduleBellId(bellSchedules.find((item) => item.calendar_id === defaultCalendar?.id)?.id ?? '');
    setScheduleDialog('create');
    setError('');
    setSuccess('');
  }

  function openEditDialog() {
    if (!activeSchedule) return;
    setScheduleName(activeSchedule.name);
    setScheduleDialog('edit');
    setError('');
    setSuccess('');
  }

  async function saveSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !scheduleName.trim() || (scheduleDialog === 'create' && (!scheduleCalendarId || !schedulePatternId))) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const client = requireSupabase();
      if (scheduleDialog === 'create') {
        if (!user) throw new Error('Your signed-in account could not be identified.');
        const { data, error: insertError } = await client
          .from('timetable_schedules')
          .insert({
            school_id: schoolId,
            name: scheduleName.trim(),
            created_by: user.id,
            calendar_id: scheduleCalendarId,
            academic_year_id: scheduleYearId || null,
            week_pattern_id: schedulePatternId,
            bell_schedule_id: scheduleBellId || null,
            cycle_weeks: bellSchedules.find((item) => item.id === scheduleBellId)?.cycle_weeks ?? 1,
          })
          .select('id')
          .single();
        if (insertError) throw insertError;
        setSelectedScheduleId(data.id);
        setSuccess('Draft timetable created. Add schedule periods to start building it.');
      } else if (activeSchedule) {
        const { error: updateError } = await client.from('timetable_schedules')
          .update({ name: scheduleName.trim() })
          .eq('id', activeSchedule.id)
          .eq('school_id', schoolId);
        if (updateError) throw updateError;
        setSuccess('Timetable details updated.');
      }
      setScheduleDialog(null);
      await refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save timetable details.');
    } finally {
      setSaving(false);
    }
  }

  async function publishSchedule() {
    if (!schoolId || !activeSchedule || publishBlocked) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: updateError } = await requireSupabase().from('timetable_schedules')
        .update({ status: 'published' })
        .eq('id', activeSchedule.id)
        .eq('school_id', schoolId);
      if (updateError) throw updateError;
      setSuccess('Timetable published for students, families, and staff.');
      await refresh();
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : 'Could not publish this timetable.');
    } finally {
      setSaving(false);
    }
  }

  async function handleTimetableSaved(message: string) {
    setSuccess(message);
    await refresh();
  }

  function exportPdf() {
    window.print();
  }

  const stats = [
    { label: 'Classes scheduled', value: classCount, icon: Users, color: 'purple', note: 'In this timetable' },
    { label: "Today's lessons", value: todayEntries.filter((entry) => entry.entry_type === 'lesson').length, icon: CalendarDays, color: 'blue', note: dayLabels[today - 1] },
    { label: 'Unassigned lessons', value: unassignedCount, icon: AlertTriangle, color: unassignedCount ? 'red' : 'green', note: 'Need a teacher or room' },
    { label: 'Schedule conflicts', value: conflicts.length, icon: Clock3, color: conflicts.length ? 'red' : 'green', note: 'Class, teacher, or room clashes' },
  ];

  return (
    <div className="page-stack timetable-page">
      <div className="page-heading timetable-page-heading">
        <div>
          <span className="eyebrow">{activeMembership?.school.name} · Academics</span>
          <h1>Timetable dashboard</h1>
          <p>Daily schedules, workload, room usage, and timetable issues in one place.</p>
        </div>
        <div className="timetable-heading-actions">
          {schedules.length > 0 && <label className="schedule-select"><span className="sr-only">Choose a timetable</span><select value={selectedScheduleId} onChange={(event) => setSelectedScheduleId(event.target.value)} aria-label="Choose a timetable">{schedules.map((schedule) => <option key={schedule.id} value={schedule.id}>{schedule.name} · {schedule.status}</option>)}</select></label>}
          <button className="button button-quiet" type="button" onClick={() => void refresh()} disabled={loading || saving}><RefreshCw size={15} />Refresh</button>
          <span className="date-chip"><CalendarDays size={15} />{new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone }).format(new Date())}</span>
          <button className="button button-primary" type="button" onClick={exportPdf}><Download size={15} />Export PDF</button>
        </div>
      </div>
      {error && <ErrorState message={error} />}
      {success && <SuccessMessage message={success} />}
      {loading ? <LoadingState label="Loading timetable data…" /> : <>
        {activeSchedule && <TimetableManager
          key={activeSchedule.id}
          schoolId={schoolId ?? ''}
          scheduleId={activeSchedule.id}
          scheduleStatus={activeSchedule.status}
          weekPatternId={activeSchedule.week_pattern_id}
          calendarId={activeSchedule.calendar_id}
          academicYearId={activeSchedule.academic_year_id}
          bellScheduleId={activeSchedule.bell_schedule_id}
          cycleWeeks={activeSchedule.cycle_weeks}
          canManage={canManage}
          entries={activeEntries}
          onSaved={handleTimetableSaved}
        />}
        <section className="print-timetable" aria-label="Weekly class timetable">
          <div className="print-timetable-controls">
            <label>Class<select aria-label="Class timetable" value={selectedTimetableClassId}
              onChange={(event) => setSelectedTimetableClassId(event.target.value)}>
              {timetableClasses.map((schoolClass) => <option key={schoolClass.id} value={schoolClass.id}>{schoolClass.name}</option>)}
            </select></label>
            {activeSchedule?.cycle_weeks === 2 && <label>Rotation<select aria-label="Timetable rotation week"
              value={selectedTimetableCycle} onChange={(event) => setSelectedTimetableCycle(Number(event.target.value))}>
              <option value={1}>Week A</option><option value={2}>Week B</option>
            </select></label>}
          </div>
          <header className="print-timetable-heading">
            <h2>{displayedTimetableClass?.name ?? 'Class timetable'}</h2>
            <span>{activeMembership?.school.name}</span>
            {activeSchedule?.cycle_weeks === 2 && <small>Week {selectedTimetableCycle === 1 ? 'A' : 'B'}</small>}
          </header>
          {timetableSlots.length ? <div className="print-timetable-scroll">
            <table className="class-timetable-grid">
              <thead><tr><th className="class-timetable-day-heading">Day</th>{timetableSlots.map((slot, index) =>
                <th key={`${slot.startsAt}:${slot.endsAt}`}><strong>{index}</strong><span>{formatTime(slot.startsAt)}–{formatTime(slot.endsAt)}</span></th>)}</tr></thead>
              <tbody>{timetableDays.map(({ label: day, dayOfWeek }) => <tr key={day}>
                <th className="class-timetable-day">{day.slice(0, 2)}</th>
                {timetableSlots.map((slot) => {
                  const slotEntries = timetableEntriesForClass.filter((entry) =>
                    entry.day_of_week === dayOfWeek
                    && entry.starts_at === slot.startsAt)
                    .sort((left, right) => Number(right.class_id === selectedTimetableClassId)
                      - Number(left.class_id === selectedTimetableClassId));
                  const entry = slotEntries[0];
                  return <td key={`${day}:${slot.startsAt}:${slot.endsAt}`} className={entry ? `class-timetable-cell cell-${entry.entry_type}` : 'class-timetable-cell'}>
                    {entry && <><strong className="class-timetable-subject">{subjectName(entry)}</strong>
                      {entry.entry_type === 'lesson' && <span className="class-timetable-teacher">{teacherName(entry)}</span>}</>}
                  </td>;
                })}
              </tr>)}</tbody>
            </table>
          </div> : <p className="class-timetable-empty">No timetable entries have been scheduled for this class and week.</p>}
        </section>
        <section className="stat-grid timetable-stat-grid" aria-label="Timetable overview">
          {stats.map(({ label, value, icon: Icon, color, note }) => <article className="stat-card" key={label}>
            <div className="stat-card-top"><span>{label}</span><span className={`stat-icon ${color}`}><Icon size={19} /></span></div>
            <strong>{value.toLocaleString()}</strong><span className="stat-caption">{note}</span>
          </article>)}
        </section>

        <section className="dashboard-grid timetable-main-grid">
          <article className="content-card timetable-panel">
            <div className="section-heading"><div><span className="eyebrow">Today · {dayLabels[today - 1]}</span><h2>Today's schedule</h2></div><CalendarClock size={19} className="muted-icon" /></div>
            {todayEntries.length ? <div className="timetable-agenda">{todayEntries.map((entry) => <div className={`agenda-row${entry.entry_type !== 'lesson' ? ' agenda-constant' : ''}`} key={entry.id}>
              <div className="agenda-time"><strong>{formatTime(entry.starts_at)}</strong><span>{formatTime(entry.ends_at)}</span></div>
              <span className={`agenda-marker marker-${entry.entry_type}`} />
              <div className="agenda-details"><strong>{subjectName(entry)}</strong><span>{className(entry)}{entry.entry_type === 'lesson' ? ` · ${teacherName(entry)}` : ''}</span></div>
              <span className="agenda-room">{entry.room ?? entry.entry_type.replace('_', ' ')}</span>
            </div>)}</div> : <EmptyState title="No classes scheduled today" detail="This timetable has no lessons or school-day activities assigned for today." />}
          </article>
          <article className="content-card timetable-panel">
            <div className="section-heading"><div><span className="eyebrow">Next up</span><h2>Upcoming lessons</h2></div><Clock3 size={19} className="muted-icon" /></div>
            {upcoming.length ? <div className="upcoming-list">{upcoming.map(({ entry, daysAway }) => <div className="upcoming-row" key={entry.id}>
              <span className="upcoming-day">{daysAway === 0 ? 'Today' : daysAway === 1 ? 'Tomorrow' : dayLabels[entry.day_of_week - 1]?.slice(0, 3)}</span>
              <div><strong>{subjectName(entry)}</strong><small>{className(entry)} · {teacherName(entry)}</small></div>
              <time>{formatTime(entry.starts_at)}</time>
            </div>)}</div> : <EmptyState title="No upcoming lessons" detail="Lessons scheduled later this week will appear here." />}
          </article>
        </section>

        <section className="dashboard-grid timetable-insight-grid">
          <article className="content-card timetable-panel">
            <div className="section-heading"><div><span className="eyebrow">Attention needed</span><h2>Conflict alerts</h2></div><AlertTriangle size={19} className={conflicts.length ? 'alert-icon' : 'muted-icon'} /></div>
            {conflicts.length ? <div className="issue-list">{conflicts.slice(0, 5).map((conflict, index) => <div className="issue-row" key={`${conflict.first.id}-${conflict.second.id}-${index}`}>
              <span className="issue-icon"><AlertTriangle size={15} /></span>
              <div><strong>{conflict.resources.join(' · ')}</strong><small>{dayLabels[conflict.first.day_of_week - 1]} · {formatTime(conflict.first.starts_at)}–{formatTime(conflict.first.ends_at)} overlaps {subjectName(conflict.second)}</small></div>
            </div>)}</div> : <div className="panel-empty"><Check size={17} /><span>No class, teacher, or room clashes detected.</span></div>}
            {unassignedCount > 0 && <div className="issue-note"><AlertTriangle size={14} />{unassignedCount} lesson{unassignedCount === 1 ? '' : 's'} still need a teacher or room.</div>}
          </article>
          <article className="content-card timetable-panel">
            <div className="section-heading"><div><span className="eyebrow">Availability</span><h2>Free period overview</h2></div><DoorOpen size={19} className="muted-icon" /></div>
            <div className="availability-grid">
              <div><strong>{freeWindows}</strong><span>open class gaps</span></div>
              <div><strong>{countOpenWindows(activeEntries, (entry) => entry.teacher_id)}</strong><span>teacher gaps</span></div>
              <div><strong>{countOpenWindows(activeEntries, (entry) => entry.room?.trim() ?? null)}</strong><span>room gaps</span></div>
            </div>
            <p className="panel-footnote">Gaps are open windows between scheduled lessons in this timetable.</p>
          </article>
        </section>

        <section className="dashboard-grid timetable-insight-grid">
          <article className="content-card timetable-panel">
            <div className="section-heading"><div><span className="eyebrow">Distribution</span><h2>Teacher workload</h2></div><Users size={19} className="muted-icon" /></div>
            {teacherWorkload.length ? <div className="metric-list">{teacherWorkload.slice(0, 6).map((teacher) => <div className="metric-row" key={teacher.id}>
              <span className="metric-name">{teacher.name}</span><span className="metric-track"><i style={{ width: `${Math.max(8, teacher.minutes / teacherWorkload[0].minutes * 100)}%` }} /></span><strong>{(teacher.minutes / 60).toFixed(1)}h</strong>
            </div>)}</div> : <EmptyState title="No teacher assignments" detail="Assigned teaching hours will appear here." />}
            <p className="panel-footnote">Teaching hours are calculated from each teacher's scheduled lesson duration.</p>
          </article>
          <article className="content-card timetable-panel">
            <div className="section-heading"><div><span className="eyebrow">Room usage</span><h2>Room utilization</h2></div><DoorOpen size={19} className="muted-icon" /></div>
            {roomWorkload.length ? <div className="metric-list">{roomWorkload.slice(0, 6).map((room) => <div className="metric-row" key={room.name}>
              <span className="metric-name">{room.name}</span><span className="metric-track"><i style={{ width: `${Math.max(8, room.periods / Math.max(...roomWorkload.map((item) => item.periods)) * 100)}%` }} /></span><strong>{room.periods} lesson{room.periods === 1 ? '' : 's'}</strong>
            </div>)}</div> : <EmptyState title="No rooms assigned" detail="Room usage will be summarized once lessons have rooms." />}
            <p className="panel-footnote">{roomAssignmentCoverage}% of lessons have a room assigned · {roomWorkload.length} room{roomWorkload.length === 1 ? '' : 's'} in use.</p>
          </article>
        </section>

        <section className="dashboard-grid timetable-bottom-grid">
          <article className="content-card timetable-panel">
            <div className="section-heading"><div><span className="eyebrow">Audit trail</span><h2>Recent changes</h2></div><RefreshCw size={18} className="muted-icon" /></div>
            {recentChanges.length ? <div className="change-list">{recentChanges.map((activity) => <div className="change-row" key={activity.id}>
              <span className="change-dot" /><div><strong>{activity.title}</strong><small>{activity.detail}</small></div><time>{displayUpdatedAt(activity.updatedAt)}</time>
            </div>)}</div> : <EmptyState title="No timetable changes yet" detail="Created or edited timetables will appear here." />}
          </article>
          <article className="content-card timetable-panel">
            <div className="section-heading"><div><span className="eyebrow">Manage</span><h2>Quick actions</h2></div><ArrowUpRight size={18} className="muted-icon" /></div>
            <div className="timetable-actions">
              {canManage ? <>
                <button type="button" onClick={openCreateDialog}><Plus size={16} /><span>Create timetable</span><ArrowUpRight size={15} /></button>
                <button type="button" onClick={openEditDialog} disabled={!activeSchedule}><Edit3 size={16} /><span>Edit timetable details</span><ArrowUpRight size={15} /></button>
                <button type="button" onClick={() => void publishSchedule()} disabled={!activeSchedule || activeSchedule.status === 'published' || saving || publishBlocked} title={publishBlocked ? 'Resolve conflicts, assign teachers and rooms, and add lessons before publishing.' : ''}><Check size={16} /><span>Publish selected</span><ArrowUpRight size={15} /></button>
              </> : <p className="panel-footnote">Timetables are managed by your school administrator or academic coordinator.</p>}
              <button type="button" onClick={exportPdf}><Printer size={16} /><span>Print / save as PDF</span><ArrowUpRight size={15} /></button>
            </div>
            {canManage && activeSchedule && <p className="panel-footnote">Selected: {activeSchedule.name} ({activeSchedule.status}).{publishBlocked && activeSchedule.status !== 'published' ? ' Complete lesson assignments and resolve clashes before publishing.' : ''}</p>}
          </article>
        </section>
      </>}

      {scheduleDialog && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setScheduleDialog(null); }}>
        <form className="modal-card modal-form" onSubmit={(event) => void saveSchedule(event)}>
          <div className="modal-heading"><div><span className="eyebrow">{scheduleDialog === 'create' ? 'New schedule' : 'Timetable settings'}</span><h2>{scheduleDialog === 'create' ? 'Create timetable' : 'Edit timetable details'}</h2></div><button className="icon-button" type="button" onClick={() => setScheduleDialog(null)} aria-label="Close"><span aria-hidden="true">×</span></button></div>
          <label className="field"><span>Timetable name</span><input required minLength={2} maxLength={120} value={scheduleName} onChange={(event) => setScheduleName(event.target.value)} placeholder="e.g. Term 1 timetable" autoFocus /></label>
          {scheduleDialog === 'create' && <>
            <label className="field"><span>Academic calendar / division</span><select required value={scheduleCalendarId} onChange={(event) => {
              const nextCalendar = event.target.value;
              setScheduleCalendarId(nextCalendar);
              setScheduleYearId(academicYears.find((item) => item.calendar_id === nextCalendar && item.is_current)?.id ?? '');
              setSchedulePatternId(weekPatterns.find((item) => item.calendar_id === nextCalendar && item.name === 'Standard')?.id ?? weekPatterns.find((item) => item.calendar_id === nextCalendar)?.id ?? '');
              setScheduleBellId(bellSchedules.find((item) => item.calendar_id === nextCalendar)?.id ?? '');
            }}>{calendars.map((item) => <option value={item.id} key={item.id}>{item.name}{item.division_name ? ` · ${item.division_name}` : ''}</option>)}</select></label>
            <label className="field"><span>Academic year (optional)</span><select value={scheduleYearId} onChange={(event) => setScheduleYearId(event.target.value)}><option value="">No academic year</option>{academicYears.filter((item) => item.calendar_id === scheduleCalendarId).map((item) => <option value={item.id} key={item.id}>{item.name}{item.is_current ? ' · Current' : ''}</option>)}</select></label>
            <label className="field"><span>Week pattern</span><select required value={schedulePatternId} onChange={(event) => setSchedulePatternId(event.target.value)}>{weekPatterns.filter((item) => item.calendar_id === scheduleCalendarId).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
            <label className="field"><span>Bell schedule (optional)</span><select value={scheduleBellId} onChange={(event) => setScheduleBellId(event.target.value)}><option value="">No bell periods</option>{bellSchedules.filter((item) => item.calendar_id === scheduleCalendarId && item.week_pattern_id === schedulePatternId).map((item) => <option value={item.id} key={item.id}>{item.name}{item.cycle_weeks === 2 ? ' · A/B cycle' : ''}</option>)}</select></label>
          </>}
          {scheduleDialog === 'create' && <p className="timetable-dialog-note"><BookOpen size={15} />New timetables start as drafts. Add periods manually or generate a weekly schedule in the schedule builder.</p>}
          <div className="modal-actions"><button className="button button-quiet" type="button" onClick={() => setScheduleDialog(null)}>Cancel</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : scheduleDialog === 'create' ? 'Create draft' : 'Save details'}</button></div>
        </form>
      </div>}
    </div>
  );
}
