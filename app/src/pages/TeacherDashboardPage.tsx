import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRight, BookOpen, CalendarClock, CalendarDays, CheckCircle2, Clock3,
  DoorOpen, GraduationCap, RefreshCw, UsersRound,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type Relation<T> = T | T[] | null;
type TimetableLesson = {
  id: string;
  schedule_id: string | null;
  class_id: string;
  subject_id: string;
  day_of_week: number;
  starts_at: string;
  ends_at: string;
  room: string | null;
  cycle_week: number;
  class: Relation<{ name: string }>;
  subject: Relation<{ name: string }>;
  schedule: Relation<{ calendar_id: string; academic_year_id: string | null; cycle_weeks: number }>;
};
type SchoolClass = { id: string; name: string };
type Subject = { id: string; name: string };
type AssignmentTask = { id: string; title: string; due_at: string; class_id: string };
type UpcomingEvent = { id: string; title: string; starts_at: string; location: string | null };
type PendingSubmission = {
  id: string;
  status: string;
  submitted_at: string | null;
  assignment: Relation<{ title: string; class_id: string }>;
  student: Relation<{ first_name: string; last_name: string }>;
};
type TimetableChange = { id: string; summary: string; created_at: string };
type AcademicWeek = {
  calendar_id: string;
  academic_year_id: string;
  starts_on: string;
  ends_on: string;
  cycle_week: number;
};
type TeacherDashboardData = {
  teacherName: string;
  classes: SchoolClass[];
  classTeacherClasses: SchoolClass[];
  hodDepartments: string[];
  subjects: Subject[];
  lessons: TimetableLesson[];
  academicWeeks: AcademicWeek[];
  assignments: AssignmentTask[];
  events: UpcomingEvent[];
  submissions: PendingSubmission[];
  timetableChanges: TimetableChange[];
};

function one<T>(value: Relation<T> | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function schoolDate(timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

function schoolWeekday(timeZone: string) {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date());
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekday) + 1;
}

function formatTime(value: string) {
  const [hour, minute] = value.slice(0, 5).split(':').map(Number);
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
    .format(new Date(2000, 0, 1, hour, minute));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${value.slice(0, 10)}T12:00:00Z`));
}

function relationName(value: Relation<{ name: string }>, fallback: string) {
  return one(value)?.name ?? fallback;
}

function minutes(value: string) {
  const [hour, minute] = value.slice(0, 5).split(':').map(Number);
  return hour * 60 + minute;
}

function schoolClockMinutes(timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

function freePeriods(lessons: TimetableLesson[]) {
  const ordered = [...lessons].sort((left, right) => left.starts_at.localeCompare(right.starts_at));
  const periods: { starts_at: string; ends_at: string }[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const next = ordered[index];
    if (minutes(next.starts_at) - minutes(previous.ends_at) >= 35) {
      periods.push({ starts_at: previous.ends_at, ends_at: next.starts_at });
    }
  }
  return periods;
}

async function loadTeacherDashboard(schoolId: string, profileId: string): Promise<TeacherDashboardData> {
  const client = requireSupabase();
  const { data: teacherRows, error: teacherError } = await client.from('teacher_profiles')
    .select('id,first_name,last_name')
    .eq('school_id', schoolId)
    .eq('profile_id', profileId)
    .eq('employment_status', 'active');
  if (teacherError) throw teacherError;
  const teachers = teacherRows ?? [];
  if (teachers.length === 0) {
    throw new Error('Your account is not linked to an active teacher profile. Ask your school administrator to link it.');
  }
  const teacherIds = teachers.map((teacher) => teacher.id);
  const teacherName = `${teachers[0].first_name} ${teachers[0].last_name}`;
  const { data: responsibilityRows, error: responsibilityError } = await client.from('teacher_responsibilities')
    .select('responsibility_type,class_id,department_id,class:school_classes(id,name),department:school_departments(id,name)')
    .eq('school_id', schoolId)
    .in('teacher_id', teacherIds);
  if (responsibilityError) throw responsibilityError;
  const responsibilities = (responsibilityRows ?? []) as unknown as {
    responsibility_type: 'class_teacher' | 'head_of_department';
    class_id: string | null;
    department_id: string | null;
    class: Relation<SchoolClass>;
    department: Relation<{ name: string }>;
  }[];
  const classTeacherClasses = responsibilities.flatMap((item) => {
    const schoolClass = one(item.class);
    return item.responsibility_type === 'class_teacher' && schoolClass ? [schoolClass] : [];
  });
  const classTeacherClassIds = classTeacherClasses.map((item) => item.id);
  const hodDepartmentIds = [...new Set(responsibilities.flatMap((item) => (
    item.responsibility_type === 'head_of_department' && item.department_id ? [item.department_id] : []
  )))];
  const hodDepartments = responsibilities.flatMap((item) => {
    const department = one(item.department);
    return item.responsibility_type === 'head_of_department' && department ? [department.name] : [];
  });
  const [classAssignmentResult, subjectAssignmentResult, hodSubjectResult, timetableResult, classTeacherTimetableResult, assignmentResult, eventResult, submissionResult, weekResult] = await Promise.all([
    client.from('teacher_class_assignments')
      .select('class_id,school_classes!inner(id,name)')
      .eq('school_id', schoolId)
      .in('teacher_id', teacherIds),
    client.from('teacher_subjects')
      .select('subject_id,subjects!inner(id,name)')
      .eq('school_id', schoolId)
      .in('teacher_id', teacherIds),
    hodDepartmentIds.length
      ? client.from('subjects').select('id,name').eq('school_id', schoolId).in('department_id', hodDepartmentIds)
      : Promise.resolve({ data: [], error: null }),
    client.from('timetable')
      .select('id,schedule_id,class_id,subject_id,day_of_week,starts_at,ends_at,room,cycle_week,class:school_classes!inner(name),subject:subjects!inner(name),schedule:timetable_schedules(calendar_id,academic_year_id,cycle_weeks)')
      .eq('school_id', schoolId)
      .in('teacher_id', teacherIds)
      .order('day_of_week')
      .order('starts_at'),
    classTeacherClassIds.length
      ? client.from('timetable')
        .select('id,schedule_id,class_id,subject_id,day_of_week,starts_at,ends_at,room,cycle_week,class:school_classes!inner(name),subject:subjects!inner(name),schedule:timetable_schedules(calendar_id,academic_year_id,cycle_weeks)')
        .eq('school_id', schoolId)
        .in('class_id', classTeacherClassIds)
        .order('day_of_week')
        .order('starts_at')
      : Promise.resolve({ data: [], error: null }),
    client.from('assignments')
      .select('id,title,due_at,class_id')
      .eq('school_id', schoolId)
      .in('teacher_id', teacherIds)
      .eq('status', 'published')
      .gte('due_at', new Date().toISOString())
      .order('due_at')
      .limit(8),
    client.from('events')
      .select('id,title,starts_at,location')
      .eq('school_id', schoolId)
      .gte('starts_at', new Date().toISOString())
      .order('starts_at')
      .limit(30),
    client.from('assignment_submissions')
      .select('id,status,submitted_at,assignment:assignments!inner(title,class_id,teacher_id),student:students!inner(first_name,last_name)')
      .eq('school_id', schoolId)
      .in('assignment.teacher_id', teacherIds)
      .order('submitted_at', { ascending: false })
      .limit(8),
    client.from('academic_calendar_weeks')
      .select('calendar_id,academic_year_id,starts_on,ends_on,cycle_week')
      .eq('school_id', schoolId),
  ]);
  const failed = [
    classAssignmentResult.error, subjectAssignmentResult.error, hodSubjectResult.error, timetableResult.error, classTeacherTimetableResult.error,
    assignmentResult.error, eventResult.error, submissionResult.error, weekResult.error,
  ].find(Boolean);
  if (failed) throw failed;

  const lessons = [...new Map([
    ...(timetableResult.data ?? []),
    ...(classTeacherTimetableResult.data ?? []),
  ].map((lesson) => [lesson.id, lesson])).values()] as unknown as TimetableLesson[];
  const scheduleIds = [...new Set(lessons.map((lesson) => lesson.schedule_id).filter((id): id is string => Boolean(id)))];
  let timetableChanges: TimetableChange[] = [];
  if (scheduleIds.length) {
    const { data, error } = await client.from('timetable_schedule_changes')
      .select('id,summary,created_at')
      .eq('school_id', schoolId)
      .in('schedule_id', scheduleIds)
      .order('created_at', { ascending: false })
      .limit(5);
    if (error) throw error;
    timetableChanges = (data ?? []) as TimetableChange[];
  }

  const classes = (classAssignmentResult.data ?? []).flatMap((assignment) => {
    const schoolClass = one(assignment.school_classes as Relation<SchoolClass>);
    return schoolClass ? [schoolClass] : [];
  });
  classes.push(...classTeacherClasses);
  const subjects = (subjectAssignmentResult.data ?? []).flatMap((assignment) => {
    const subject = one(assignment.subjects as Relation<Subject>);
    return subject ? [subject] : [];
  });
  subjects.push(...((hodSubjectResult.data ?? []) as Subject[]));
  return {
    teacherName,
    classes: [...new Map(classes.map((item) => [item.id, item])).values()]
      .sort((left, right) => left.name.localeCompare(right.name)),
    classTeacherClasses: [...new Map(classTeacherClasses.map((item) => [item.id, item])).values()],
    hodDepartments: [...new Set(hodDepartments)],
    subjects: [...new Map(subjects.map((item) => [item.id, item])).values()]
      .sort((left, right) => left.name.localeCompare(right.name)),
    lessons,
    academicWeeks: (weekResult.data ?? []) as AcademicWeek[],
    assignments: (assignmentResult.data ?? []) as AssignmentTask[],
    events: (eventResult.data ?? []) as UpcomingEvent[],
    submissions: (submissionResult.data ?? []) as unknown as PendingSubmission[],
    timetableChanges,
  };
}

export function TeacherDashboardPage() {
  const { activeMembership, user } = useAuth();
  const schoolId = activeMembership?.school_id;
  const profileId = user?.id;
  const timeZone = activeMembership?.school.timezone ?? 'UTC';
  const [data, setData] = useState<TeacherDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const refresh = useCallback(async () => {
    if (!schoolId || !profileId) return;
    setError('');
    try {
      const result = await loadTeacherDashboard(schoolId, profileId);
      setData(result);
      setRefreshedAt(new Date());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load your teaching dashboard.');
    } finally {
      setLoading(false);
    }
  }, [schoolId, profileId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const today = schoolDate(timeZone);
  const todayWeekday = schoolWeekday(timeZone);
  const currentTime = schoolClockMinutes(timeZone);
  const weeklyLessons = useMemo(() => {
    if (!data) return [];
    return data.lessons.filter((lesson) => {
      const schedule = one(lesson.schedule);
      if (!schedule || schedule.cycle_weeks !== 2 || !schedule.academic_year_id) return lesson.cycle_week === 1;
      const week = data.academicWeeks.find((item) => item.calendar_id === schedule.calendar_id
        && item.academic_year_id === schedule.academic_year_id
        && today >= item.starts_on && today <= item.ends_on);
      return lesson.cycle_week === (week?.cycle_week ?? 1);
    }).sort((left, right) => left.day_of_week - right.day_of_week || left.starts_at.localeCompare(right.starts_at));
  }, [data, today]);
  const todayLessons = useMemo(() => {
    return weeklyLessons.filter((lesson) => lesson.day_of_week === todayWeekday);
  }, [weeklyLessons, todayWeekday]);

  const upcomingLessons = useMemo(() => {
    if (!data) return [];
    const occurrences: { lesson: TimetableLesson; dayOffset: number }[] = [];
    const date = new Date(`${today}T12:00:00`);
    const weekday = todayWeekday;
    for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
      const day = ((weekday - 1 + dayOffset) % 7) + 1;
      const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);
      for (const lesson of data.lessons) {
        const schedule = one(lesson.schedule);
        if (lesson.day_of_week !== day) continue;
        if (schedule?.cycle_weeks === 2 && schedule.academic_year_id) {
          const week = data.academicWeeks.find((item) => item.calendar_id === schedule.calendar_id
            && item.academic_year_id === schedule.academic_year_id
            && dateKey >= item.starts_on && dateKey <= item.ends_on);
          if (lesson.cycle_week !== (week?.cycle_week ?? 1)) continue;
        } else if (lesson.cycle_week !== 1) continue;
        if (dayOffset === 0 && minutes(lesson.starts_at) <= currentTime) continue;
        occurrences.push({ lesson, dayOffset });
      }
      date.setDate(date.getDate() + 1);
    }
    return occurrences.sort((left, right) => left.dayOffset - right.dayOffset
      || left.lesson.starts_at.localeCompare(right.lesson.starts_at)).slice(0, 6);
  }, [data, today, todayWeekday, timeZone, currentTime]);

  const exams = data?.events.filter((event) => /\b(exam|examination|assessment|test)\b/i.test(event.title)).slice(0, 4) ?? [];
  const free = freePeriods(todayLessons);
  const classNameById = new Map(data?.classes.map((item) => [item.id, item.name]) ?? []);
  const tasks = data?.assignments.slice(0, 5) ?? [];

  if (loading) return <LoadingState label="Preparing your teaching dashboard…" />;
  return (
    <div className="page-stack teacher-dashboard">
      <div className="page-heading">
        <div><span className="eyebrow">Teaching workspace</span><h1>Welcome, {data?.teacherName.split(' ')[0] ?? 'teacher'}</h1><p>{activeMembership?.school.name} · your classes, lessons, and next steps.</p></div>
        <div className="teacher-dashboard-actions">
          {refreshedAt && <span className="teacher-refresh-time">Updated {refreshedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
          <button className="button button-quiet" onClick={() => void refresh()}><RefreshCw size={15} /> Refresh</button>
        </div>
      </div>
      {error && <ErrorState message={error} />}
      {data && <>
        {(data.classTeacherClasses.length > 0 || data.hodDepartments.length > 0) && <section className="teacher-responsibility-banner">
          {data.classTeacherClasses.length > 0 && <span><UsersRound size={15} /><strong>Class Teacher / Form Tutor:</strong> {data.classTeacherClasses.map((schoolClass) => schoolClass.name).join(', ')}</span>}
          {data.hodDepartments.length > 0 && <span><BookOpen size={15} /><strong>Head of Department:</strong> {data.hodDepartments.join(', ')}</span>}
        </section>}
        <section className="teacher-stat-grid" aria-label="Teaching overview">
          <article><span><UsersRound size={18} /></span><strong>{data.classes.length}</strong><small>Assigned classes</small></article>
          <article><span><BookOpen size={18} /></span><strong>{data.subjects.length}</strong><small>Assigned subjects</small></article>
          <article><span><CalendarClock size={18} /></span><strong>{todayLessons.length}</strong><small>Lessons today</small></article>
          <article><span><CheckCircle2 size={18} /></span><strong>{tasks.length + data.submissions.filter((submission) => submission.status === 'submitted' || submission.status === 'late').length}</strong><small>Pending tasks</small></article>
        </section>

        <section className="teacher-dashboard-grid">
          <article className="content-card teacher-dashboard-panel teacher-schedule-panel">
            <div className="section-heading"><div><span className="eyebrow">Today</span><h2>Daily timetable</h2></div><Link to="/timetable" className="teacher-panel-link">Full timetable <ArrowUpRight size={15} /></Link></div>
            {todayLessons.length
              ? <div className="teacher-lesson-list">{todayLessons.map((lesson) => {
                const current = minutes(lesson.starts_at) <= currentTime && minutes(lesson.ends_at) > currentTime;
                return <div className={`teacher-lesson-row${current ? ' current' : ''}`} key={lesson.id}>
                  <span className="teacher-lesson-time">{formatTime(lesson.starts_at)}<small>{formatTime(lesson.ends_at)}</small></span>
                  <span className="teacher-lesson-copy"><strong>{relationName(lesson.subject, 'Lesson')}</strong><small>{relationName(lesson.class, 'Class')}</small></span>
                  <span className="teacher-room">{lesson.room ? <><DoorOpen size={13} />{lesson.room}</> : 'Room not set'}</span>
                </div>;
              })}</div>
              : <EmptyState title="No lessons scheduled today" detail="Your weekly lessons will appear here when they are assigned to your teacher profile." />}
            {free.length > 0 && <div className="teacher-free-periods"><strong><Clock3 size={15} /> Free-period availability</strong><span>{free.map((slot) => `${formatTime(slot.starts_at)}–${formatTime(slot.ends_at)}`).join(' · ')}</span></div>}
          </article>

          <article className="content-card teacher-dashboard-panel">
            <div className="section-heading"><div><span className="eyebrow">Next up</span><h2>Upcoming lessons</h2></div><CalendarDays size={18} className="muted-icon" /></div>
            {upcomingLessons.length
              ? <div className="teacher-upcoming-list">{upcomingLessons.map(({ lesson, dayOffset }) => <div className="teacher-upcoming-row" key={`${lesson.id}-${dayOffset}`}>
                <span className="teacher-date-pill">{dayOffset === 0 ? 'Today' : dayOffset === 1 ? 'Tomorrow' : formatDate(new Date(new Date(`${today}T12:00:00`).getTime() + dayOffset * 86400000).toISOString())}</span>
                <span><strong>{relationName(lesson.subject, 'Lesson')}</strong><small>{relationName(lesson.class, 'Class')} · {formatTime(lesson.starts_at)}{lesson.room ? ` · ${lesson.room}` : ''}</small></span>
              </div>)}</div>
              : <EmptyState title="No upcoming lessons" detail="Published timetable lessons assigned to you will show here." />}
          </article>

          <article className="content-card teacher-dashboard-panel teacher-weekly-panel">
            <div className="section-heading"><div><span className="eyebrow">This week</span><h2>Weekly timetable</h2></div><Link to="/timetable" className="teacher-panel-link">View full timetable <ArrowUpRight size={15} /></Link></div>
            {weeklyLessons.length
              ? <div className="teacher-week-grid">{['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day, index) => {
                const dayLessons = weeklyLessons.filter((lesson) => lesson.day_of_week === index + 1);
                if (!dayLessons.length) return null;
                return <section key={day}><h3>{day}</h3>{dayLessons.map((lesson) => <div className="teacher-week-lesson" key={lesson.id}>
                  <span>{formatTime(lesson.starts_at)}–{formatTime(lesson.ends_at)}</span>
                  <strong>{relationName(lesson.subject, 'Lesson')}</strong>
                  <small>{relationName(lesson.class, 'Class')}{lesson.room ? ` · ${lesson.room}` : ''}</small>
                </div>)}</section>;
              })}</div>
              : <EmptyState title="No weekly timetable published" detail="Your assigned lessons will appear when a timetable is published." />}
          </article>

          <article className="content-card teacher-dashboard-panel">
            <div className="section-heading"><div><span className="eyebrow">My teaching</span><h2>Classes & subjects</h2></div><GraduationCap size={18} className="muted-icon" /></div>
            {data.classes.length
              ? <div className="teacher-class-list">{data.classes.map((schoolClass) => <div className="teacher-class-row" key={schoolClass.id}>
                <span><strong>{schoolClass.name}</strong><small>{data.lessons.filter((lesson) => lesson.class_id === schoolClass.id).length} timetable lessons</small></span>
                <Link to={`/attendance?class=${encodeURIComponent(schoolClass.id)}`} aria-label={`Open attendance for ${schoolClass.name}`}><ArrowUpRight size={16} /></Link>
              </div>)}</div>
              : <EmptyState title="No classes assigned" detail="Ask your school administrator to allocate your classes." />}
            <div className="teacher-subject-chips">{data.subjects.length
              ? data.subjects.map((subject) => <span key={subject.id}>{subject.name}</span>)
              : <small>No subjects assigned yet.</small>}</div>
          </article>

          <article className="content-card teacher-dashboard-panel">
            <div className="section-heading"><div><span className="eyebrow">To do</span><h2>Pending work</h2></div><Link to="/assignments" className="teacher-panel-link">Assignments <ArrowUpRight size={15} /></Link></div>
            {tasks.length || data.submissions.some((submission) => submission.status === 'submitted' || submission.status === 'late')
              ? <div className="teacher-task-list">
                {data.submissions.filter((submission) => submission.status === 'submitted' || submission.status === 'late').slice(0, 4).map((submission) => {
                  const assignment = one(submission.assignment);
                  const student = one(submission.student);
                  return <div className="teacher-task-row" key={submission.id}><span className="teacher-task-dot submitted" /><span><strong>Review submission: {assignment?.title ?? 'Assignment'}</strong><small>{student ? `${student.first_name} ${student.last_name}` : 'Student'} · {classNameById.get(assignment?.class_id ?? '') ?? 'Class'} · {submission.status}</small></span></div>;
                })}
                {tasks.slice(0, 4).map((task) => <div className="teacher-task-row" key={task.id}><span className="teacher-task-dot" /><span><strong>{task.title}</strong><small>{classNameById.get(task.class_id) ?? 'Class'} · Due {formatDate(task.due_at)}</small></span></div>)}
              </div>
              : <EmptyState title="Nothing waiting on you" detail="Upcoming published assignments and student submissions will appear here." />}
          </article>

          <article className="content-card teacher-dashboard-panel">
            <div className="section-heading"><div><span className="eyebrow">Assessment calendar</span><h2>Upcoming examinations</h2></div><CalendarDays size={18} className="muted-icon" /></div>
            {exams.length
              ? <div className="teacher-task-list">{exams.map((event) => <div className="teacher-task-row" key={event.id}><span className="teacher-task-dot exam" /><span><strong>{event.title}</strong><small>{new Date(event.starts_at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone })}{event.location ? ` · ${event.location}` : ''}</small></span></div>)}</div>
              : <EmptyState title="No examinations announced" detail="School events labelled as exams, assessments, or tests will appear here." />}
          </article>

          <article className="content-card teacher-dashboard-panel">
            <div className="section-heading"><div><span className="eyebrow">Recent changes</span><h2>Timetable updates</h2></div><Clock3 size={18} className="muted-icon" /></div>
            {data.timetableChanges.length
              ? <div className="teacher-task-list">{data.timetableChanges.map((change) => <div className="teacher-task-row" key={change.id}><span className="teacher-task-dot change" /><span><strong>{change.summary}</strong><small>{new Date(change.created_at).toLocaleString()}</small></span></div>)}</div>
              : <EmptyState title="No recent timetable changes" detail="Published timetable updates will be shown here." />}
          </article>

          <article className="content-card teacher-dashboard-panel">
            <div className="section-heading"><div><span className="eyebrow">Student activity</span><h2>Recent submissions</h2></div><BookOpen size={18} className="muted-icon" /></div>
            {data.submissions.length
              ? <div className="teacher-task-list">{data.submissions.slice(0, 5).map((submission) => {
                const assignment = one(submission.assignment);
                const student = one(submission.student);
                return <div className="teacher-task-row" key={submission.id}>
                  <span className={`teacher-task-dot${submission.status === 'graded' || submission.status === 'returned' ? ' change' : ' submitted'}`} />
                  <span><strong>{student ? `${student.first_name} ${student.last_name}` : 'Student'} · {assignment?.title ?? 'Assignment'}</strong><small>{submission.status} · {submission.submitted_at ? new Date(submission.submitted_at).toLocaleString() : 'No submission time'}</small></span>
                </div>;
              })}</div>
              : <EmptyState title="No recent student activity" detail="Submissions to your assignments will appear here." />}
          </article>
        </section>
      </>}
    </div>
  );
}
