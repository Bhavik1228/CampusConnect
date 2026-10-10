import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle, ArrowUpRight, BookOpen, CalendarClock, CalendarDays, Check,
  Clock3, Download, DoorOpen, Edit3, Plus, Printer, RefreshCw, Users,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type ScheduleStatus = 'draft' | 'published' | 'archived';
type EntryType = 'lesson' | 'registration' | 'break' | 'lunch' | 'other';
type Relation<T> = T | T[] | null;

interface TimetableSchedule {
  id: string;
  name: string;
  status: ScheduleStatus;
  updated_at: string;
}

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
  title: string;
  detail: string;
  updatedAt: string;
}

const dayLabels = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const timetableSelect = [
  'id', 'schedule_id', 'class_id', 'subject_id', 'teacher_id', 'day_of_week',
  'starts_at', 'ends_at', 'room', 'entry_type', 'label', 'updated_at',
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
      if (first.day_of_week !== second.day_of_week || first.schedule_id !== second.schedule_id) continue;
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
    const key = `${entry.schedule_id ?? 'legacy'}:${entry.day_of_week}:${resource}`;
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
  const [entries, setEntries] = useState<TimetableEntry[]>([]);
  const [selectedScheduleId, setSelectedScheduleId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [scheduleDialog, setScheduleDialog] = useState<'create' | 'edit' | null>(null);
  const [scheduleName, setScheduleName] = useState('');

  const refresh = useCallback(async () => {
    if (!schoolId) return;
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [scheduleResult, timetableEntries] = await Promise.all([
        client.from('timetable_schedules')
          .select('id,name,status,updated_at')
          .eq('school_id', schoolId)
          .order('updated_at', { ascending: false }),
        loadEntries(schoolId),
      ]);
      if (scheduleResult.error) throw scheduleResult.error;
      const nextSchedules = (scheduleResult.data ?? []) as TimetableSchedule[];
      setSchedules(nextSchedules);
      setEntries(timetableEntries);
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
  const lessons = useMemo(() => activeEntries.filter((entry) => entry.entry_type === 'lesson'), [activeEntries]);
  const conflicts = useMemo(() => findConflicts(activeEntries), [activeEntries]);
  const { dayOfWeek: today, time: currentTime } = getSchoolClock(timeZone);
  const todayEntries = useMemo(
    () => activeEntries.filter((entry) => entry.day_of_week === today)
      .sort((left, right) => left.starts_at.localeCompare(right.starts_at)),
    [activeEntries, today],
  );
  const upcoming = useMemo(() => lessons
    .map((entry) => {
      let daysAway = (entry.day_of_week - today + 7) % 7;
      if (daysAway === 0 && entry.starts_at.slice(0, 5) <= currentTime) daysAway = 7;
      return { entry, sortKey: daysAway * 1440 + minutes(entry.starts_at) };
    })
    .sort((left, right) => left.sortKey - right.sortKey)
    .slice(0, 5)
    .map(({ entry, sortKey }) => ({ entry, daysAway: Math.floor(sortKey / 1440) })),
  [lessons, today, currentTime]);
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
  const recentChanges = useMemo<Activity[]>(() => {
    const scheduleActivities = schedules.map((schedule) => ({
      id: `schedule-${schedule.id}`,
      title: schedule.name,
      detail: `${schedule.status === 'published' ? 'Published' : schedule.status === 'archived' ? 'Archived' : 'Draft'} timetable`,
      updatedAt: schedule.updated_at,
    }));
    const entryActivities = activeEntries.map((entry) => ({
      id: entry.id,
      title: subjectName(entry),
      detail: `${className(entry)} · ${dayLabels[entry.day_of_week - 1] ?? 'Day'}${entry.entry_type === 'lesson' ? ' lesson' : ''}`,
      updatedAt: entry.updated_at,
    }));
    return [...scheduleActivities, ...entryActivities]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 5);
  }, [activeEntries, schedules]);

  const classCount = new Set(lessons.map((entry) => entry.class_id).filter(Boolean)).size;
  const unassignedCount = lessons.filter((entry) => !entry.teacher_id || !entry.room?.trim()).length;
  const freeWindows = countOpenWindows(activeEntries, (entry) => entry.class_id);
  const publishBlocked = conflicts.length > 0 || unassignedCount > 0 || lessons.length === 0;

  function openCreateDialog() {
    setScheduleName('');
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
    if (!schoolId || !scheduleName.trim()) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const client = requireSupabase();
      if (scheduleDialog === 'create') {
        if (!user) throw new Error('Your signed-in account could not be identified.');
        const { data, error: insertError } = await client
          .from('timetable_schedules')
          .insert({ school_id: schoolId, name: scheduleName.trim(), created_by: user.id })
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
        <section className="print-timetable" aria-label="Printable weekly timetable">
          <div className="print-timetable-heading">
            <span>{activeMembership?.school.name}</span>
            <h1>{activeSchedule?.name ?? 'School timetable'}</h1>
          </div>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Day</th><th>Time</th><th>Lesson / activity</th><th>Class</th><th>Teacher</th><th>Room</th></tr></thead>
              <tbody>{dayLabels.map((day, index) => {
                const dayEntries = activeEntries.filter((entry) => entry.day_of_week === index + 1)
                  .sort((left, right) => left.starts_at.localeCompare(right.starts_at));
                return dayEntries.map((entry) => <tr key={entry.id}>
                  <td>{day}</td>
                  <td>{formatTime(entry.starts_at)}–{formatTime(entry.ends_at)}</td>
                  <td>{subjectName(entry)}</td>
                  <td>{className(entry)}</td>
                  <td>{entry.entry_type === 'lesson' ? teacherName(entry) : '—'}</td>
                  <td>{entry.room ?? '—'}</td>
                </tr>);
              })}</tbody>
            </table>
          </div>
          {!activeEntries.length && <p>No timetable entries have been scheduled yet.</p>}
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
                <button type="button" disabled title="Automatic generation is part of a later timetable setup phase."><RefreshCw size={16} /><span>Generate timetable</span><ArrowUpRight size={15} /></button>
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
          {scheduleDialog === 'create' && <p className="timetable-dialog-note"><BookOpen size={15} />New timetables start as drafts. Lesson scheduling and automatic generation setup will be available in the next phase.</p>}
          <div className="modal-actions"><button className="button button-quiet" type="button" onClick={() => setScheduleDialog(null)}>Cancel</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : scheduleDialog === 'create' ? 'Create draft' : 'Save details'}</button></div>
        </form>
      </div>}
    </div>
  );
}
