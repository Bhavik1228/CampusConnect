import { useEffect, useState, type FormEvent } from 'react';
import { CalendarClock, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { ErrorState } from '../components/Feedback';
import { PrerequisiteFieldNotice } from '../components/PrerequisiteFieldNotice';
import { PrerequisiteQuickCreate } from '../components/PrerequisiteQuickCreate';
import { requireSupabase } from '../lib/supabase';
import { getPrerequisiteRule, resolvePrerequisiteAvailability } from '../lib/prerequisite-rules';
import { type PrerequisiteEntity, type PrerequisiteRecord } from '../lib/prerequisite-records';

type EntryKind = 'lesson' | 'registration' | 'break' | 'lunch' | 'other';
type TimetableEntry = {
  id: string;
  class_id: string | null;
  subject_id: string | null;
  teacher_id: string | null;
  day_of_week: number;
  starts_at: string;
  ends_at: string;
  room: string | null;
  entry_type: EntryKind;
  label: string | null;
  cycle_week: number;
  bell_period_id: string | null;
};
type BellPeriod = {
  id: string;
  cycle_week: number;
  day_of_week: number;
  period_number: number;
  name: string;
  period_type: 'lesson' | 'break' | 'lunch' | 'assembly' | 'registration' | 'other';
  starts_at: string;
  ends_at: string;
  allows_double: boolean;
};
type BellPeriodSubject = { period_id: string; subject_id: string };
type SchoolClass = { id: string; name: string; room: string | null; academic_year_id: string | null };
type Subject = { id: string; name: string };
type Teacher = { id: string; first_name: string; last_name: string; status: string };
type SubjectTeacher = { subject_id: string; teacher_id: string };
type ClassTeacher = { class_id: string; teacher_id: string };
type ClassSubject = { class_id: string; subject_id: string };
type EntryDraft = {
  entry_type: EntryKind;
  class_id: string;
  subject_id: string;
  teacher_id: string;
  day_of_week: string;
  starts_at: string;
  duration: string;
  room: string;
  label: string;
};
type SubjectPlan = { subject_id: string; teacher_id: string; periods: number };
type GeneratedEntry = {
  entry_type: EntryKind;
  class_id: string | null;
  subject_id: string | null;
  teacher_id: string | null;
  day_of_week: number;
  starts_at: string;
  ends_at: string;
  room: string | null;
  label: string | null;
  cycle_week?: number;
  bell_period_id?: string | null;
};

const weekdayOptions = [
  { day: 1, label: 'Mon' }, { day: 2, label: 'Tue' }, { day: 3, label: 'Wed' },
  { day: 4, label: 'Thu' }, { day: 5, label: 'Fri' }, { day: 6, label: 'Sat' },
  { day: 7, label: 'Sun' },
];

function parseMinutes(value: string) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function timeString(value: number) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}:00`;
}

function initialDraft(entry?: TimetableEntry): EntryDraft {
  const duration = entry
    ? parseMinutes(entry.ends_at.slice(0, 5)) - parseMinutes(entry.starts_at.slice(0, 5))
    : 60;
  return {
    entry_type: entry?.entry_type ?? 'lesson',
    class_id: entry?.class_id ?? '',
    subject_id: entry?.subject_id ?? '',
    teacher_id: entry?.teacher_id ?? '',
    day_of_week: String(entry?.day_of_week ?? 1),
    starts_at: entry?.starts_at.slice(0, 5) ?? '08:00',
    duration: String(duration),
    room: entry?.room ?? '',
    label: entry?.label ?? '',
  };
}

function buildGeneratedEntries({
  classes,
  subjects,
  subjectTeachers,
  classTeachers,
  classSubjects,
  plans,
  weekdays,
  startAt,
  finishAt,
  lessonMinutes,
  breakEnabled,
  breakAt,
  breakMinutes,
  lunchEnabled,
  lunchAt,
  lunchMinutes,
  bellPeriods,
  bellPeriodSubjects,
  cycleWeeks,
}: {
  classes: SchoolClass[];
  subjects: Subject[];
  subjectTeachers: SubjectTeacher[];
  classTeachers: ClassTeacher[];
  classSubjects: ClassSubject[];
  plans: SubjectPlan[];
  weekdays: number[];
  startAt: string;
  finishAt: string;
  lessonMinutes: number;
  breakEnabled: boolean;
  breakAt: string;
  breakMinutes: number;
  lunchEnabled: boolean;
  lunchAt: string;
  lunchMinutes: number;
  bellPeriods: BellPeriod[];
  bellPeriodSubjects: BellPeriodSubject[];
  cycleWeeks: number;
}): GeneratedEntry[] {
  if (!classes.length) throw new Error('Choose at least one class to generate.');
  if (!weekdays.length) throw new Error('Choose at least one teaching day.');
  if (!plans.some((plan) => plan.periods > 0)) throw new Error('Set a weekly lesson count for at least one subject.');
  const opening = parseMinutes(startAt);
  const closing = parseMinutes(finishAt);
  if (opening >= closing) throw new Error('The school day end must be later than its start.');
  if (lessonMinutes < 15 || lessonMinutes > 180) throw new Error('Lesson duration must be between 15 and 180 minutes.');
  const constants = [
    ...(breakEnabled ? [{ label: 'Break', type: 'break' as const, start: parseMinutes(breakAt), duration: breakMinutes }] : []),
    ...(lunchEnabled ? [{ label: 'Lunch', type: 'lunch' as const, start: parseMinutes(lunchAt), duration: lunchMinutes }] : []),
  ].sort((left, right) => left.start - right.start);
  for (const constant of constants) {
    if (constant.duration < 5 || constant.start < opening || constant.start + constant.duration > closing) {
      throw new Error(`${constant.label} must fit inside the configured school day.`);
    }
  }
  if (constants.some((item, index) => index > 0 && item.start < constants[index - 1].start + constants[index - 1].duration)) {
    throw new Error('Break and lunch periods cannot overlap.');
  }

  const subjectById = new Map(subjects.map((subject) => [subject.id, subject]));
  const teacherLoad = new Map<string, number>();
  if (bellPeriods.length) {
    const generated: GeneratedEntry[] = [];
    for (let cycleWeek = 1; cycleWeek <= cycleWeeks; cycleWeek += 1) {
      const cyclePeriods = bellPeriods.filter((period) => period.cycle_week === cycleWeek);
      for (const period of cyclePeriods.filter((item) => item.period_type !== 'lesson')) {
        generated.push({
          entry_type: period.period_type === 'registration' ? 'registration'
            : period.period_type === 'break' ? 'break'
              : period.period_type === 'lunch' ? 'lunch' : 'other',
          class_id: null,
          subject_id: null,
          teacher_id: null,
          day_of_week: period.day_of_week,
          starts_at: period.starts_at,
          ends_at: period.ends_at,
          room: null,
          label: period.name,
          cycle_week: cycleWeek,
          bell_period_id: period.id,
        });
      }
      for (const schoolClass of classes) {
        const configuredSubjects = classSubjects.filter((assignment) => assignment.class_id === schoolClass.id);
        const tasks = plans.flatMap((plan) => {
          if (plan.periods === 0) return [];
          if (!subjectById.has(plan.subject_id)) throw new Error('A selected subject is no longer available.');
          if (configuredSubjects.length && !configuredSubjects.some((assignment) => assignment.subject_id === plan.subject_id)) return [];
          return Array.from({ length: plan.periods }, () => plan);
        });
        for (const task of tasks) {
          const classAssignment = classTeachers.filter((assignment) => assignment.class_id === schoolClass.id);
          const eligibleTeachers = subjectTeachers
            .filter((assignment) => assignment.subject_id === task.subject_id)
            .filter((assignment) => !classAssignment.length || classAssignment.some((item) => item.teacher_id === assignment.teacher_id))
            .map((assignment) => assignment.teacher_id);
          if (!eligibleTeachers.length) {
            throw new Error(`No teacher assigned to ${subjectById.get(task.subject_id)?.name ?? 'this subject'} can teach ${schoolClass.name}.`);
          }
          const candidates = cyclePeriods.filter((period) => period.period_type === 'lesson'
            && (!bellPeriodSubjects.some((rule) => rule.period_id === period.id)
              || bellPeriodSubjects.some((rule) => rule.period_id === period.id && rule.subject_id === task.subject_id)))
            .sort((left, right) => left.day_of_week - right.day_of_week || left.starts_at.localeCompare(right.starts_at));
          const placed = candidates.find((period) => {
            const clashes = generated.filter((entry) => entry.cycle_week === cycleWeek
              && entry.day_of_week === period.day_of_week
              && parseMinutes(entry.starts_at.slice(0, 5)) < parseMinutes(period.ends_at.slice(0, 5))
              && parseMinutes(period.starts_at.slice(0, 5)) < parseMinutes(entry.ends_at.slice(0, 5)));
            const classConflict = clashes.some((entry) => entry.class_id === schoolClass.id);
            const roomConflict = Boolean(schoolClass.room?.trim() && clashes.some((entry) =>
              entry.room?.trim().toLowerCase() === schoolClass.room?.trim().toLowerCase()));
            const availableTeacher = eligibleTeachers.some((teacherId) => !clashes.some((entry) => entry.teacher_id === teacherId));
            return !classConflict && !roomConflict && availableTeacher;
          });
          if (!placed) {
            throw new Error(`Could not fit the requested ${schoolClass.name} lessons into the configured bell periods for cycle week ${cycleWeek}. Add lesson periods or reduce weekly lesson counts.`);
          }
          const assignedTeacher = eligibleTeachers
            .filter((teacherId) => !generated.some((entry) => entry.cycle_week === cycleWeek
              && entry.day_of_week === placed.day_of_week
              && entry.teacher_id === teacherId
              && parseMinutes(entry.starts_at.slice(0, 5)) < parseMinutes(placed.ends_at.slice(0, 5))
              && parseMinutes(placed.starts_at.slice(0, 5)) < parseMinutes(entry.ends_at.slice(0, 5))))
            .sort((left, right) => (teacherLoad.get(left) ?? 0) - (teacherLoad.get(right) ?? 0))[0];
          generated.push({
            entry_type: 'lesson',
            class_id: schoolClass.id,
            subject_id: task.subject_id,
            teacher_id: assignedTeacher,
            day_of_week: placed.day_of_week,
            starts_at: placed.starts_at,
            ends_at: placed.ends_at,
            room: schoolClass.room?.trim() || null,
            label: null,
            cycle_week: cycleWeek,
            bell_period_id: placed.id,
          });
          teacherLoad.set(assignedTeacher, (teacherLoad.get(assignedTeacher) ?? 0) + parseMinutes(placed.ends_at.slice(0, 5)) - parseMinutes(placed.starts_at.slice(0, 5)));
        }
      }
    }
    return generated.sort((left, right) =>
      (left.cycle_week ?? 1) - (right.cycle_week ?? 1)
      || left.day_of_week - right.day_of_week
      || left.starts_at.localeCompare(right.starts_at));
  }
  const entries: GeneratedEntry[] = [];
  const classDayLoad = new Map<string, number>();
  for (const day of weekdays) {
    for (const constant of constants) {
      entries.push({
        entry_type: constant.type,
        class_id: null,
        subject_id: null,
        teacher_id: null,
        day_of_week: day,
        starts_at: timeString(constant.start),
        ends_at: timeString(constant.start + constant.duration),
        room: null,
        label: constant.label,
      });
    }
  }

  for (const schoolClass of classes) {
    const configuredSubjects = classSubjects.filter((assignment) => assignment.class_id === schoolClass.id);
    const tasks = plans.flatMap((plan) => {
      if (plan.periods === 0) return [];
      const subject = subjectById.get(plan.subject_id);
      if (!subject) throw new Error('A selected subject is no longer available.');
      if (configuredSubjects.length && !configuredSubjects.some((assignment) => assignment.subject_id === plan.subject_id)) return [];
      return Array.from({ length: plan.periods }, () => plan);
    });
    for (const task of tasks) {
      const classAssignment = classTeachers.filter((assignment) => assignment.class_id === schoolClass.id);
      const eligibleTeachers = subjectTeachers
        .filter((assignment) => assignment.subject_id === task.subject_id)
        .filter((assignment) => !classAssignment.length || classAssignment.some((item) => item.teacher_id === assignment.teacher_id))
        .map((assignment) => assignment.teacher_id);
      if (!eligibleTeachers.length) {
        throw new Error(`No teacher assigned to ${subjectById.get(task.subject_id)?.name ?? 'this subject'} can teach ${schoolClass.name}.`);
      }
      let placed: GeneratedEntry | null = null;
      const dayOrder = [...weekdays].sort((left, right) =>
        (classDayLoad.get(`${schoolClass.id}:${left}`) ?? 0)
        - (classDayLoad.get(`${schoolClass.id}:${right}`) ?? 0));
      for (const day of dayOrder) {
        for (let start = opening; start + lessonMinutes <= closing; start += 5) {
          const end = start + lessonMinutes;
          if (constants.some((period) => start < period.start + period.duration && period.start < end)) continue;
          const overlaps = (entry: GeneratedEntry) => entry.day_of_week === day
            && parseMinutes(entry.starts_at.slice(0, 5)) < end
            && start < parseMinutes(entry.ends_at.slice(0, 5));
          const availableTeacher = eligibleTeachers
            .filter((teacherId) => !entries.some((entry) => entry.entry_type === 'lesson'
              && entry.teacher_id === teacherId && overlaps(entry)))
            .sort((left, right) => {
              if (task.teacher_id === left) return -1;
              if (task.teacher_id === right) return 1;
              return (teacherLoad.get(left) ?? 0) - (teacherLoad.get(right) ?? 0);
            })[0];
          const classConflict = entries.some((entry) => entry.entry_type === 'lesson'
            && entry.class_id === schoolClass.id && overlaps(entry));
          const roomConflict = schoolClass.room?.trim() && entries.some((entry) => entry.entry_type === 'lesson'
            && entry.room?.trim().toLowerCase() === schoolClass.room?.trim().toLowerCase() && overlaps(entry));
          if (!availableTeacher || classConflict || roomConflict) continue;
          placed = {
            entry_type: 'lesson',
            class_id: schoolClass.id,
            subject_id: task.subject_id,
            teacher_id: availableTeacher,
            day_of_week: day,
            starts_at: timeString(start),
            ends_at: timeString(end),
            room: schoolClass.room?.trim() || null,
            label: null,
          };
          break;
        }
        if (placed) break;
      }
      if (!placed) {
        throw new Error(`Could not fit all ${schoolClass.name} lessons into the selected days. Add a teaching day, extend school hours, or reduce weekly lesson counts.`);
      }
      entries.push(placed);
      if (placed.teacher_id) teacherLoad.set(placed.teacher_id, (teacherLoad.get(placed.teacher_id) ?? 0) + lessonMinutes);
      classDayLoad.set(`${schoolClass.id}:${placed.day_of_week}`, (classDayLoad.get(`${schoolClass.id}:${placed.day_of_week}`) ?? 0) + 1);
    }
  }
  return entries.sort((left, right) =>
    left.day_of_week - right.day_of_week || left.starts_at.localeCompare(right.starts_at));
}

export function TimetableManager({
  schoolId,
  scheduleId,
  scheduleStatus,
  calendarId,
  academicYearId,
  userRole,
  bellScheduleId,
  cycleWeeks,
  weekPatternId,
  canManage,
  entries,
  onSaved,
}: {
  schoolId: string;
  scheduleId: string;
  scheduleStatus: string;
  calendarId: string;
  academicYearId: string | null;
  userRole: string;
  bellScheduleId: string | null;
  cycleWeeks: number;
  weekPatternId: string;
  canManage: boolean;
  entries: TimetableEntry[];
  onSaved: (message: string) => Promise<void>;
}) {
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [classRecordCount, setClassRecordCount] = useState(0);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [subjectTeachers, setSubjectTeachers] = useState<SubjectTeacher[]>([]);
  const [classTeachers, setClassTeachers] = useState<ClassTeacher[]>([]);
  const [classSubjects, setClassSubjects] = useState<ClassSubject[]>([]);
  const [bellPeriods, setBellPeriods] = useState<BellPeriod[]>([]);
  const [bellPeriodSubjects, setBellPeriodSubjects] = useState<BellPeriodSubject[]>([]);
  const [operatingDays, setOperatingDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [referencesLoading, setReferencesLoading] = useState(false);
  const [referencesReady, setReferencesReady] = useState(false);
  const [referencesError, setReferencesError] = useState('');
  const [referencesRetryKey, setReferencesRetryKey] = useState(0);
  const [dialog, setDialog] = useState<'entry' | 'generate' | null>(null);
  const [quickCreateEntity, setQuickCreateEntity] = useState<PrerequisiteEntity | null>(null);
  const [editing, setEditing] = useState<TimetableEntry | null>(null);
  const [draft, setDraft] = useState<EntryDraft>(initialDraft());
  const [draftCycle, setDraftCycle] = useState(1);
  const [draftBellPeriodId, setDraftBellPeriodId] = useState('');
  const [doublePeriod, setDoublePeriod] = useState(false);
  const [targetClassId, setTargetClassId] = useState('*');
  const [assignmentTeacherId, setAssignmentTeacherId] = useState('');
  const [assignmentSubjectId, setAssignmentSubjectId] = useState('');
  const [plans, setPlans] = useState<SubjectPlan[]>([]);
  const [weekdays, setWeekdays] = useState([1, 2, 3, 4, 5]);
  const [startAt, setStartAt] = useState('08:00');
  const [finishAt, setFinishAt] = useState('15:00');
  const [lessonDuration, setLessonDuration] = useState(60);
  const [breakEnabled, setBreakEnabled] = useState(true);
  const [breakAt, setBreakAt] = useState('10:30');
  const [breakDuration, setBreakDuration] = useState(15);
  const [lunchEnabled, setLunchEnabled] = useState(true);
  const [lunchAt, setLunchAt] = useState('12:30');
  const [lunchDuration, setLunchDuration] = useState(45);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!canManage || referencesReady) return;
    let alive = true;
    async function loadReferences() {
      setReferencesLoading(true);
      setReferencesError('');
      setError('');
      try {
        const client = requireSupabase();
        const [classResult, subjectResult, teacherResult, subjectTeacherResult, classTeacherResult, classSubjectResult, patternDayResult] = await Promise.all([
          client.from('school_classes').select('id,name,room,academic_year_id').eq('school_id', schoolId).eq('calendar_id', calendarId).order('name'),
          client.from('subjects').select('id,name').eq('school_id', schoolId).order('name'),
          client.from('teacher_profiles').select('id,first_name,last_name,status').eq('school_id', schoolId).order('last_name'),
          client.from('teacher_subjects').select('subject_id,teacher_id').eq('school_id', schoolId),
          client.from('teacher_class_assignments').select('class_id,teacher_id').eq('school_id', schoolId),
          client.from('class_subjects').select('class_id,subject_id').eq('school_id', schoolId),
          client.from('academic_calendar_pattern_days').select('day_of_week,is_open').eq('school_id', schoolId).eq('calendar_id', calendarId).eq('pattern_id', weekPatternId),
        ]);
        const failed = [classResult.error, subjectResult.error, teacherResult.error, subjectTeacherResult.error, classTeacherResult.error, classSubjectResult.error, patternDayResult.error].find(Boolean);
        if (failed) throw failed;
        if (!alive) return;
        setClassRecordCount((classResult.data ?? []).length);
        setClasses((classResult.data ?? []).filter((schoolClass) =>
          !academicYearId || !schoolClass.academic_year_id || schoolClass.academic_year_id === academicYearId));
        setSubjects(subjectResult.data ?? []);
        setTeachers(teacherResult.data ?? []);
        setSubjectTeachers(subjectTeacherResult.data ?? []);
        setClassTeachers(classTeacherResult.data ?? []);
        setClassSubjects(classSubjectResult.data ?? []);
        if (bellScheduleId) {
          const { data: bellPeriodRows, error: bellPeriodError } = await client.from('academic_bell_periods')
            .select('id,cycle_week,day_of_week,period_number,name,period_type,starts_at,ends_at,allows_double')
            .eq('school_id', schoolId)
            .eq('bell_schedule_id', bellScheduleId)
            .order('cycle_week')
            .order('day_of_week')
            .order('period_number');
          if (bellPeriodError) throw bellPeriodError;
          setBellPeriods((bellPeriodRows ?? []) as BellPeriod[]);
          const periodIds = (bellPeriodRows ?? []).map((period) => period.id);
          if (periodIds.length) {
            const { data: bellRuleRows, error: bellRuleError } = await client.from('academic_bell_period_subjects')
              .select('period_id,subject_id')
              .eq('school_id', schoolId)
              .in('period_id', periodIds);
            if (bellRuleError) throw bellRuleError;
            setBellPeriodSubjects((bellRuleRows ?? []) as BellPeriodSubject[]);
          } else {
            setBellPeriodSubjects([]);
          }
        } else {
          setBellPeriods([]);
          setBellPeriodSubjects([]);
        }
        const openDays = (patternDayResult.data ?? []).filter((day) => day.is_open).map((day) => day.day_of_week);
        setOperatingDays(openDays);
        setWeekdays(openDays);
        setPlans((subjectResult.data ?? []).map((subject) => ({
          subject_id: subject.id,
          teacher_id: '',
          periods: 3,
        })));
        setReferencesReady(true);
        setReferencesError('');
      } catch (loadError) {
        if (alive) {
          const message = loadError instanceof Error ? loadError.message : 'Could not load classes, subjects, and teacher assignments.';
          setReferencesError(message);
          setError(message);
        }
      } finally {
        if (alive) setReferencesLoading(false);
      }
    }
    void loadReferences();
    return () => { alive = false; };
  }, [canManage, referencesReady, referencesRetryKey, schoolId, calendarId, academicYearId, weekPatternId, bellScheduleId]);

  if (!canManage || !scheduleId) return null;
  const readOnly = scheduleStatus !== 'draft';

  function openNewEntry() {
    setEditing(null);
    setDraft(initialDraft());
    setDraftCycle(1);
    setDraftBellPeriodId('');
    setDoublePeriod(false);
    setError('');
    setDialog('entry');
  }

  function openEditEntry(entry: TimetableEntry) {
    setEditing(entry);
    setDraft(initialDraft(entry));
    setDraftCycle(entry.cycle_week);
    setDraftBellPeriodId(entry.bell_period_id ?? '');
    const period = bellPeriods.find((item) => item.id === entry.bell_period_id);
    setDoublePeriod(Boolean(period && parseMinutes(entry.ends_at.slice(0, 5))
      > parseMinutes(period.ends_at.slice(0, 5))));
    setError('');
    setDialog('entry');
  }

  function updatePlan(subjectId: string, field: 'teacher_id' | 'periods', value: string) {
    setPlans((current) => current.map((plan) => plan.subject_id === subjectId
      ? { ...plan, [field]: field === 'periods' ? Number(value) : value }
      : plan));
  }

  function selectableTeachers(subjectId: string, classId: string) {
    const candidates = subjectTeachers
      .filter((assignment) => assignment.subject_id === subjectId)
      .map((assignment) => assignment.teacher_id);
    const classAssignments = classTeachers.filter((assignment) => assignment.class_id === classId);
    const classTeacherIds = classAssignments.map((assignment) => assignment.teacher_id);
    return teachers.filter((teacher) => teacher.status === 'active' && candidates.includes(teacher.id)
      && (!classTeacherIds.length || classTeacherIds.includes(teacher.id)));
  }

  const draftEligibleSubjects = (() => {
    const assignedSubjects = classSubjects.filter((item) => item.class_id === draft.class_id);
    return assignedSubjects.length
      ? subjects.filter((subject) => assignedSubjects.some((item) => item.subject_id === subject.id))
      : subjects;
  })();
  const draftEligibleTeachers = selectableTeachers(draft.subject_id, draft.class_id);
  const classAvailability = resolvePrerequisiteAvailability({
    loading: referencesLoading,
    error: referencesError,
    totalRecords: classRecordCount,
    selectableRecords: classes.length,
    filteredRecords: Math.max(0, classRecordCount - classes.length),
  });
  const subjectAvailability = resolvePrerequisiteAvailability({
    loading: referencesLoading,
    error: referencesError,
    totalRecords: subjects.length,
    selectableRecords: draftEligibleSubjects.length,
    filteredRecords: Math.max(0, subjects.length - draftEligibleSubjects.length),
  });
  const activeTeacherCount = teachers.filter((teacher) => teacher.status === 'active').length;
  const teacherAvailability = resolvePrerequisiteAvailability({
    loading: referencesLoading,
    error: referencesError,
    totalRecords: teachers.length,
    selectableRecords: draftEligibleTeachers.length,
    inactiveRecords: teachers.length > 0 && activeTeacherCount === 0 ? teachers.length : 0,
    filteredRecords: activeTeacherCount > 0 && draftEligibleTeachers.length === 0 ? activeTeacherCount : 0,
  });

  function handlePrerequisiteCreated(entity: PrerequisiteEntity, record: PrerequisiteRecord, selectedExisting: boolean) {
    if (entity === 'class') {
      setClasses((current) => current.some((item) => item.id === record.id) ? current : [...current, {
        id: record.id,
        name: record.name,
        room: null,
        academic_year_id: record.academic_year_id ?? null,
      }]);
      if (!classes.some((item) => item.id === record.id)) setClassRecordCount((current) => current + 1);
      setDraft((current) => ({ ...current, class_id: record.id, teacher_id: '' }));
    } else if (entity === 'subject') {
      setSubjects((current) => current.some((item) => item.id === record.id) ? current : [...current, { id: record.id, name: record.name }]);
      if (draft.class_id) {
        setClassSubjects((current) => current.some((item) => item.class_id === draft.class_id && item.subject_id === record.id)
          ? current : [...current, { class_id: draft.class_id, subject_id: record.id }]);
      }
      setDraft((current) => ({ ...current, subject_id: record.id, teacher_id: '' }));
    } else {
      const teacher = record as Teacher;
      setTeachers((current) => current.some((item) => item.id === teacher.id) ? current : [...current, teacher]);
      if (draft.class_id) {
        setClassTeachers((current) => current.some((item) => item.class_id === draft.class_id && item.teacher_id === teacher.id)
          ? current : [...current, { class_id: draft.class_id, teacher_id: teacher.id }]);
      }
      if (draft.subject_id) {
        setSubjectTeachers((current) => current.some((item) => item.subject_id === draft.subject_id && item.teacher_id === teacher.id)
          ? current : [...current, { subject_id: draft.subject_id, teacher_id: teacher.id }]);
      }
      setDraft((current) => ({ ...current, teacher_id: teacher.id }));
    }
    setError(selectedExisting ? `Existing ${entity} selected.` : `${entity[0].toUpperCase()}${entity.slice(1)} created and selected.`);
  }

  async function saveEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const start = parseMinutes(draft.starts_at);
    const length = Number(draft.duration);
    if (!Number.isInteger(length) || length < 5 || start + length > 24 * 60) {
      setError('Enter a valid period duration that ends before midnight.');
      return;
    }
    if (draft.entry_type === 'lesson' && (!draft.class_id || !draft.subject_id)) {
      setError('Lessons need a class and subject.');
      return;
    }
    if (draft.entry_type === 'lesson' && (!classes.some((item) => item.id === draft.class_id)
        || !draftEligibleSubjects.some((item) => item.id === draft.subject_id))) {
      setError('The selected class or subject is no longer eligible for this timetable.');
      return;
    }
    if (draft.entry_type === 'lesson' && draft.teacher_id && !draftEligibleTeachers.some((item) => item.id === draft.teacher_id)) {
      setError('The selected teacher is inactive or is not assigned to teach this subject in this class.');
      return;
    }
    if (draft.entry_type !== 'lesson' && !draft.label.trim()) {
      setError('Give this school-day activity a name.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const values = {
        school_id: schoolId,
        schedule_id: scheduleId,
        class_id: draft.entry_type === 'lesson' ? draft.class_id : null,
        subject_id: draft.entry_type === 'lesson' ? draft.subject_id : null,
        teacher_id: draft.entry_type === 'lesson' ? draft.teacher_id || null : null,
        day_of_week: Number(draft.day_of_week),
        starts_at: `${draft.starts_at}:00`,
        ends_at: timeString(start + length),
        room: draft.entry_type === 'lesson' ? draft.room.trim() || null : null,
        entry_type: draft.entry_type,
        label: draft.entry_type === 'lesson' ? null : draft.label.trim(),
        cycle_week: draftCycle,
        bell_period_id: bellScheduleId ? draftBellPeriodId : null,
      };
      if (bellScheduleId && !draftBellPeriodId) throw new Error('Select a configured bell period.');
      if (bellScheduleId && draft.entry_type === 'lesson') {
        const period = bellPeriods.find((item) => item.id === draftBellPeriodId);
        if (period?.allows_double && doublePeriod) {
          const nextPeriod = bellPeriods.find((item) => item.cycle_week === period.cycle_week
            && item.day_of_week === period.day_of_week
            && item.period_number === period.period_number + 1);
          if (!nextPeriod || nextPeriod.starts_at !== period.ends_at || nextPeriod.period_type !== 'lesson') {
            throw new Error('A double lesson requires an immediately consecutive lesson period.');
          }
          values.ends_at = nextPeriod.ends_at;
        }
      }
      const client = requireSupabase();
      const result = editing
        ? await client.from('timetable').update(values).eq('id', editing.id).eq('school_id', schoolId).eq('schedule_id', scheduleId)
        : await client.from('timetable').insert(values);
      if (result.error) throw result.error;
      setDialog(null);
      await onSaved(editing ? 'Timetable period updated.' : 'Timetable period added.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save the timetable period.');
    } finally {
      setSaving(false);
    }
  }

  async function removeEntry(entry: TimetableEntry) {
    if (!window.confirm('Remove this timetable period?')) return;
    setSaving(true);
    setError('');
    try {
      const { error: deleteError } = await requireSupabase().from('timetable')
        .delete()
        .eq('id', entry.id)
        .eq('school_id', schoolId)
        .eq('schedule_id', scheduleId);
      if (deleteError) throw deleteError;
      await onSaved('Timetable period removed.');
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Could not remove this timetable period.');
    } finally {
      setSaving(false);
    }
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selectedClasses = targetClassId === '*'
      ? classes
      : classes.filter((schoolClass) => schoolClass.id === targetClassId);
    if (!window.confirm('Generating replaces all existing periods in this draft timetable. Continue?')) return;
    setSaving(true);
    setError('');
    try {
      const generatedEntries = buildGeneratedEntries({
        classes: selectedClasses,
        subjects,
        subjectTeachers,
        classTeachers,
        classSubjects,
        plans: plans.filter((plan) => plan.periods > 0),
        weekdays,
        startAt,
        finishAt,
        lessonMinutes: lessonDuration,
        breakEnabled,
        breakAt,
        breakMinutes: breakDuration,
        lunchEnabled,
        lunchAt,
        lunchMinutes: lunchDuration,
        bellPeriods,
        bellPeriodSubjects,
        cycleWeeks,
      });
      const { data, error: generateError } = await requireSupabase()
        .rpc('generate_timetable_schedule', { target_schedule: scheduleId, generated_entries: generatedEntries });
      if (generateError) throw generateError;
      setDialog(null);
      await onSaved(`Generated ${Number(data).toLocaleString()} timetable periods without class, teacher, or room clashes.`);
    } catch (generateError) {
      setError(generateError instanceof Error ? generateError.message : 'Could not generate the timetable.');
    } finally {
      setSaving(false);
    }
  }

  async function assignTeacherSubject(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!assignmentTeacherId || !assignmentSubjectId) return;
      setSaving(true);
      setError('');
      try {
        const { error: assignmentError } = await requireSupabase().from('teacher_subjects').insert({
          school_id: schoolId,
          teacher_id: assignmentTeacherId,
          subject_id: assignmentSubjectId,
        });
        if (assignmentError) throw assignmentError;
        setSubjectTeachers((current) => [...current, {
          teacher_id: assignmentTeacherId,
          subject_id: assignmentSubjectId,
        }]);
        setAssignmentTeacherId('');
        setAssignmentSubjectId('');
      } catch (assignmentError) {
        setError(assignmentError instanceof Error ? assignmentError.message : 'Could not assign this subject to the teacher.');
      } finally {
        setSaving(false);
      }
  }

  async function removeTeacherSubject(assignment: SubjectTeacher) {
      setSaving(true);
      setError('');
      try {
        const { error: assignmentError } = await requireSupabase().from('teacher_subjects').delete()
          .eq('school_id', schoolId)
          .eq('teacher_id', assignment.teacher_id)
          .eq('subject_id', assignment.subject_id);
        if (assignmentError) throw assignmentError;
        setSubjectTeachers((current) => current.filter((item) =>
          item.teacher_id !== assignment.teacher_id || item.subject_id !== assignment.subject_id));
      } catch (assignmentError) {
        setError(assignmentError instanceof Error ? assignmentError.message : 'Could not remove this teacher subject assignment.');
      } finally {
        setSaving(false);
    }
  }

  const availableBellPeriods = bellPeriods.filter((period) =>
    period.cycle_week === draftCycle
    && period.day_of_week === Number(draft.day_of_week)
    && (period.period_type === (draft.entry_type === 'lesson' ? 'lesson'
      : draft.entry_type === 'other' ? 'other' : draft.entry_type)
      || (draft.entry_type === 'other' && period.period_type === 'assembly')));
  const selectedBellPeriod = bellPeriods.find((period) => period.id === draftBellPeriodId);
  const nextDoublePeriod = selectedBellPeriod?.allows_double
    ? bellPeriods.find((period) => period.cycle_week === selectedBellPeriod.cycle_week
      && period.day_of_week === selectedBellPeriod.day_of_week
      && period.period_number === selectedBellPeriod.period_number + 1
      && period.period_type === 'lesson'
      && period.starts_at === selectedBellPeriod.ends_at)
    : undefined;

  return <>
    {error && !dialog && <ErrorState message={error} />}
    <div className="timetable-editor-toolbar">
      <div><span className="eyebrow">Schedule builder</span><strong>{readOnly ? 'Published schedule' : 'Edit draft periods'}</strong></div>
      {referencesLoading && <span className="timetable-editor-loading"><RefreshCw size={14} />Loading class and teacher data…</span>}
      {!referencesLoading && <div className="timetable-editor-actions">
        <button type="button" className="button button-quiet" onClick={openNewEntry} disabled={readOnly || saving}><Plus size={15} />Add period</button>
        <button type="button" className="button button-primary" onClick={() => { setError(''); setDialog('generate'); }} disabled={readOnly || saving || referencesLoading}><CalendarClock size={15} />Generate timetable</button>
      </div>}
    </div>
    {!readOnly && <section className="content-card timetable-assignment-card">
      <div><span className="eyebrow">Timetable eligibility</span><h2>Teacher subject assignments</h2>
        <p>Assign each teacher to the subjects they are qualified to teach. The generator uses these assignments to choose eligible teachers.</p></div>
      <form className="timetable-assignment-form" onSubmit={(event) => void assignTeacherSubject(event)}>
        <label className="field"><span>Teacher</span><select required value={assignmentTeacherId} onChange={(event) => setAssignmentTeacherId(event.target.value)}><option value="">Choose a teacher</option>{teachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.first_name} {teacher.last_name}</option>)}</select></label>
        <label className="field"><span>Subject</span><select required value={assignmentSubjectId} onChange={(event) => setAssignmentSubjectId(event.target.value)}><option value="">Choose a subject</option>{subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}</select></label>
        <button type="submit" className="button button-primary" disabled={saving || !assignmentTeacherId || !assignmentSubjectId}><Plus size={15} />Assign subject</button>
      </form>
      {subjectTeachers.length ? <div className="timetable-assignment-list">{subjectTeachers.map((assignment) => {
        const teacher = teachers.find((item) => item.id === assignment.teacher_id);
        const subject = subjects.find((item) => item.id === assignment.subject_id);
        if (!teacher || !subject) return null;
        return <span key={`${assignment.teacher_id}:${assignment.subject_id}`}>
          {teacher.first_name} {teacher.last_name} · {subject.name}
          <button type="button" className="icon-button" aria-label={`Remove ${subject.name} from ${teacher.first_name} ${teacher.last_name}`} onClick={() => void removeTeacherSubject(assignment)} disabled={saving}><Trash2 size={13} /></button>
        </span>;
      })}</div> : <p className="timetable-assignment-empty">No teacher subject assignments yet. Add assignments before generating the timetable.</p>}
    </section>}
    {entries.length > 0 ? <div className="table-scroll timetable-entry-table"><table>
      <thead><tr><th>Cycle</th><th>Day</th><th>Time</th><th>Class</th><th>Subject / activity</th><th>Teacher</th><th>Room</th>{!readOnly && <th>Actions</th>}</tr></thead>
      <tbody>{[...entries].sort((left, right) => left.day_of_week - right.day_of_week || left.starts_at.localeCompare(right.starts_at)).map((entry) => {
        const subject = subjects.find((item) => item.id === entry.subject_id);
        const schoolClass = classes.find((item) => item.id === entry.class_id);
        const teacher = teachers.find((item) => item.id === entry.teacher_id);
        return <tr key={entry.id}>
          <td>{cycleWeeks === 2 ? `Week ${entry.cycle_week === 1 ? 'A' : 'B'}` : '—'}</td>
          <td>{weekdayOptions.find((item) => item.day === entry.day_of_week)?.label}</td>
          <td>{entry.starts_at.slice(0, 5)} to {entry.ends_at.slice(0, 5)}</td>
          <td>{schoolClass?.name ?? 'All classes'}</td>
          <td>{subject?.name ?? entry.label ?? entry.entry_type}</td>
          <td>{teacher ? `${teacher.first_name} ${teacher.last_name}` : entry.entry_type === 'lesson' ? 'Unassigned' : '—'}</td>
          <td>{entry.room ?? '—'}</td>
          {!readOnly && <td><span className="timetable-row-actions"><button type="button" className="icon-button" aria-label="Edit period" onClick={() => openEditEntry(entry)}><span aria-hidden="true">✎</span></button><button type="button" className="icon-button" aria-label="Remove period" onClick={() => void removeEntry(entry)} disabled={saving}><Trash2 size={14} /></button></span></td>}
        </tr>;
      })}</tbody>
    </table></div> : <p className="timetable-builder-empty">No periods have been added to this draft yet. Add a period manually or generate a weekly timetable.</p>}

    {dialog && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setDialog(null); }}>
      {dialog === 'entry' ? <form className="modal-card modal-form timetable-editor-modal" onSubmit={(event) => void saveEntry(event)}>
        <div className="modal-heading"><div><span className="eyebrow">Schedule builder</span><h2>{editing ? 'Edit period' : 'Add period'}</h2></div><button className="icon-button" type="button" onClick={() => setDialog(null)} aria-label="Close dialog">×</button></div>
        <div className="form-row"><label className="field"><span>Period type</span><select value={draft.entry_type} onChange={(event) => { setDraft((current) => ({ ...current, entry_type: event.target.value as EntryKind })); setDraftBellPeriodId(''); }}><option value="lesson">Lesson</option><option value="registration">Registration</option><option value="break">Break</option><option value="lunch">Lunch</option><option value="other">Other / assembly</option></select></label><label className="field"><span>Day</span><select value={draft.day_of_week} onChange={(event) => { setDraft((current) => ({ ...current, day_of_week: event.target.value })); setDraftBellPeriodId(''); }}>{weekdayOptions.map((item) => <option key={item.day} value={item.day}>{item.label}</option>)}</select></label></div>
        {draft.entry_type === 'lesson' ? <>
          <div><label className="field"><span>Class</span><select required value={draft.class_id} onChange={(event) => setDraft((current) => ({ ...current, class_id: event.target.value, teacher_id: '' }))}><option value="">Choose a class</option>{classes.map((schoolClass) => <option key={schoolClass.id} value={schoolClass.id}>{schoolClass.name}</option>)}</select></label>{!classes.length && <PrerequisiteFieldNotice rule={getPrerequisiteRule('timetable', 'class')} availability={classAvailability} role={userRole} error={referencesError} onCreate={() => setQuickCreateEntity('class')} onRetry={() => setReferencesRetryKey((current) => current + 1)} />}</div>
          <div className="form-row"><div><label className="field"><span>Subject</span><select required value={draft.subject_id} onChange={(event) => setDraft((current) => ({ ...current, subject_id: event.target.value, teacher_id: '' }))}><option value="">Choose a subject</option>{draftEligibleSubjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}</select></label>{!draftEligibleSubjects.length && <PrerequisiteFieldNotice rule={getPrerequisiteRule('timetable', 'subject')} availability={subjectAvailability} role={userRole} error={referencesError} onCreate={() => setQuickCreateEntity('subject')} onRetry={() => setReferencesRetryKey((current) => current + 1)} />}</div><div><label className="field"><span>Teacher</span><select value={draft.teacher_id} onChange={(event) => setDraft((current) => ({ ...current, teacher_id: event.target.value }))}><option value="">Unassigned</option>{draftEligibleTeachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.first_name} {teacher.last_name}</option>)}</select></label>{draft.class_id && draft.subject_id && !draftEligibleTeachers.length && <PrerequisiteFieldNotice rule={getPrerequisiteRule('timetable', 'teacher')} availability={teacherAvailability} role={userRole} error={referencesError} onCreate={() => setQuickCreateEntity('teacher')} onRetry={() => setReferencesRetryKey((current) => current + 1)} />}</div></div>
          <label className="field"><span>Room</span><input value={draft.room} onChange={(event) => setDraft((current) => ({ ...current, room: event.target.value }))} maxLength={80} placeholder={classes.find((item) => item.id === draft.class_id)?.room ?? 'Room or classroom'} /></label>
        </> : <label className="field"><span>Activity name</span><input required maxLength={120} value={draft.label} onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))} placeholder="e.g. Morning registration" /></label>}
        {bellScheduleId && <>
          {cycleWeeks === 2 && <label className="field"><span>Rotation week</span><select value={draftCycle} onChange={(event) => { setDraftCycle(Number(event.target.value)); setDraftBellPeriodId(''); setDoublePeriod(false); }}><option value={1}>Week A</option><option value={2}>Week B</option></select></label>}
          <label className="field"><span>Bell period</span><select required value={draftBellPeriodId} onChange={(event) => {
            const selected = bellPeriods.find((period) => period.id === event.target.value);
            setDraftBellPeriodId(event.target.value);
            setDoublePeriod(false);
            if (selected) setDraft((current) => ({ ...current, starts_at: selected.starts_at.slice(0, 5), duration: String(parseMinutes(selected.ends_at.slice(0, 5)) - parseMinutes(selected.starts_at.slice(0, 5))) }));
          }}><option value="">Choose a configured period</option>{availableBellPeriods.map((period) => <option key={period.id} value={period.id}>Period {period.period_number}, {period.name}, {period.starts_at.slice(0, 5)} to {period.ends_at.slice(0, 5)}</option>)}</select></label>
          {draft.entry_type === 'lesson' && nextDoublePeriod && <label className="calendar-checkbox"><input type="checkbox" checked={doublePeriod} onChange={(event) => {
            setDoublePeriod(event.target.checked);
            if (event.target.checked && selectedBellPeriod && nextDoublePeriod) setDraft((current) => ({ ...current, duration: String(parseMinutes(nextDoublePeriod.ends_at.slice(0, 5)) - parseMinutes(selectedBellPeriod.starts_at.slice(0, 5))) }));
            if (!event.target.checked && selectedBellPeriod) setDraft((current) => ({ ...current, duration: String(parseMinutes(selectedBellPeriod.ends_at.slice(0, 5)) - parseMinutes(selectedBellPeriod.starts_at.slice(0, 5))) }));
          }} /><span>Use consecutive double period</span></label>}
        </>}
        {!bellScheduleId && <div className="form-row"><label className="field"><span>Start time</span><input required type="time" value={draft.starts_at} onChange={(event) => setDraft((current) => ({ ...current, starts_at: event.target.value }))} /></label><label className="field"><span>Duration (minutes)</span><input required type="number" min={5} max={720} value={draft.duration} onChange={(event) => setDraft((current) => ({ ...current, duration: event.target.value }))} /></label></div>}
        {error && <ErrorState message={error} />}
        <div className="modal-actions"><button className="button button-quiet" type="button" onClick={() => setDialog(null)}>Cancel</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : editing ? 'Save period' : 'Add period'}</button></div>
      </form> : <form className="modal-card modal-form timetable-generator-modal" onSubmit={(event) => void generate(event)}>
        <div className="modal-heading"><div><span className="eyebrow">Automatic schedule builder</span><h2>Generate timetable</h2></div><button className="icon-button" type="button" onClick={() => setDialog(null)} aria-label="Close dialog">×</button></div>
        <p className="timetable-generator-note">Creates a weekly draft schedule using teacher-subject assignments and avoids class, teacher, and room overlaps. Existing periods in this draft will be replaced.</p>
        <label className="field"><span>Classes</span><select value={targetClassId} onChange={(event) => setTargetClassId(event.target.value)}><option value="*">All classes ({classes.length})</option>{classes.map((schoolClass) => <option key={schoolClass.id} value={schoolClass.id}>{schoolClass.name}</option>)}</select></label>
        <div className="timetable-generator-subjects"><span className="generator-subject-heading">Weekly lesson requirements</span>{subjects.map((subject) => {
          const plan = plans.find((item) => item.subject_id === subject.id);
          const possibleTeachers = selectableTeachers(subject.id, targetClassId === '*' ? '' : targetClassId);
          return <div className="generator-subject-row" key={subject.id}><strong>{subject.name}</strong><select aria-label={`Teacher for ${subject.name}`} value={plan?.teacher_id ?? ''} onChange={(event) => updatePlan(subject.id, 'teacher_id', event.target.value)}><option value="">{possibleTeachers.length ? 'Select teacher' : 'No eligible teacher'}</option>{possibleTeachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.first_name} {teacher.last_name}</option>)}</select><input aria-label={`Weekly ${subject.name} lessons`} type="number" min={0} max={35} value={plan?.periods ?? 0} onChange={(event) => updatePlan(subject.id, 'periods', event.target.value)} /></div>;
        })}</div>
        {!bellScheduleId ? <>
          <div className="generator-days"><span className="generator-subject-heading">Teaching days</span><div>{weekdayOptions.map(({ day, label }) => <label key={day}><input type="checkbox" checked={weekdays.includes(day)} disabled={!operatingDays.includes(day)} onChange={() => setWeekdays((current) => current.includes(day) ? current.filter((value) => value !== day) : [...current, day].sort())} />{label}</label>)}</div></div>
          <div className="form-row"><label className="field"><span>School day starts</span><input type="time" required value={startAt} onChange={(event) => setStartAt(event.target.value)} /></label><label className="field"><span>School day ends</span><input type="time" required value={finishAt} onChange={(event) => setFinishAt(event.target.value)} /></label></div>
          <label className="field"><span>Lesson duration (minutes)</span><input type="number" min={15} max={180} required value={lessonDuration} onChange={(event) => setLessonDuration(Number(event.target.value))} /></label>
          <div className="generator-constant"><label><input type="checkbox" checked={breakEnabled} onChange={(event) => setBreakEnabled(event.target.checked)} /><strong>Daily break</strong></label><div><input type="time" aria-label="Break starts" value={breakAt} onChange={(event) => setBreakAt(event.target.value)} disabled={!breakEnabled} /><input type="number" min={5} max={120} aria-label="Break duration" value={breakDuration} onChange={(event) => setBreakDuration(Number(event.target.value))} disabled={!breakEnabled} /><span>min</span></div></div>
          <div className="generator-constant"><label><input type="checkbox" checked={lunchEnabled} onChange={(event) => setLunchEnabled(event.target.checked)} /><strong>Daily lunch</strong></label><div><input type="time" aria-label="Lunch starts" value={lunchAt} onChange={(event) => setLunchAt(event.target.value)} disabled={!lunchEnabled} /><input type="number" min={5} max={180} aria-label="Lunch duration" value={lunchDuration} onChange={(event) => setLunchDuration(Number(event.target.value))} disabled={!lunchEnabled} /><span>min</span></div></div>
        </> : <p className="calendar-muted-copy">Generation will place lessons into configured bell periods and include registration, breaks, lunch, and assembly periods for each cycle week.</p>}
        {error && <ErrorState message={error} />}
        <div className="modal-actions"><button className="button button-quiet" type="button" onClick={() => setDialog(null)}>Cancel</button><button className="button button-primary" type="submit" disabled={saving || referencesLoading || !classes.length || !subjects.length}>{saving ? 'Generating…' : 'Generate draft'}</button></div>
      </form>}
    </div>}
    {quickCreateEntity && <PrerequisiteQuickCreate
      entity={quickCreateEntity}
      open
      schoolId={schoolId}
      role={userRole}
      contextClassId={draft.class_id}
      contextSubjectId={draft.subject_id}
      calendarId={calendarId}
      academicYearId={academicYearId}
      onClose={() => setQuickCreateEntity(null)}
      onCreated={(record, selectedExisting) => handlePrerequisiteCreated(quickCreateEntity, record, selectedExisting)}
    />}
  </>;
}
