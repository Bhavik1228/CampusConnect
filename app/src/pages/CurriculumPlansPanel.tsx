import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { CalendarDays, FilePlus2, LoaderCircle, Save, Sparkles } from 'lucide-react';
import { EmptyState, ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { useAuth } from '../contexts/AuthContext';
import { requireSupabase } from '../lib/supabase';

type CurriculumDocument = { id: string; title: string; subject_id: string; academic_year_id: string; status: string };
type Assignment = { id: string; document_id: string; academic_year_id: string; year_group: string; class_id: string | null };
type AcademicYear = { id: string; name: string; start_date: string; end_date: string; calendar_id: string };
type Term = { id: string; name: string; start_date: string; end_date: string };
type CurriculumObjective = { id: string; section_number: string; objective_type: string; original_text: string; corrected_text: string };
type LessonObjective = { id: string; syllabus_objective_id: string; objective_text: string; measurable_outcomes: string[]; suggested_activities: string[]; assessment_evidence: string[] };
type Template = { id: string; template_key: string; version: number; name: string; category: string; sections: unknown[]; settings: Record<string, unknown> };
type AnnualPlan = { id: string; title: string; status: string; academic_year_id: string; assignment_id: string; capacity_report: Record<string, unknown>; created_at: string };
type PlanEntry = {
  id: string;
  term_id: string | null;
  week_number: number | null;
  planned_start: string | null;
  planned_end: string | null;
  estimated_periods: number;
  assessment_checkpoints: string[];
  syllabus_objective_id: string | null;
  lesson_objective_id: string | null;
};
type EntryDraft = { week_number: string; planned_start: string; planned_end: string; estimated_periods: string };
type LessonCourse = { id: string; title: string; course_id: string };
type LessonCourseRecord = { id: string; class_id: string; subject_id: string };
type SavedLessonPlan = {
  id: string;
  title: string;
  status: string;
  template_id: string;
  template_version: number;
  assignment_id: string;
  course_lesson_id: string | null;
  sections: Record<string, string>;
  template_snapshot: Record<string, unknown>;
  updated_at: string;
};
type AssignmentChoice = Assignment & { document: CurriculumDocument; academicYear: AcademicYear; subjectName: string; className: string };

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function inRange(date: string, start: string, end: string) {
  return date <= end && date >= start;
}

function dateForWeekDay(date: string) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

function isTemplateSection(section: unknown): section is Record<string, unknown> {
  return Boolean(section && typeof section === 'object' && !Array.isArray(section));
}

function buildEntryDraft(entry: PlanEntry): EntryDraft {
  return {
    week_number: entry.week_number === null ? '' : String(entry.week_number),
    planned_start: entry.planned_start ?? '',
    planned_end: entry.planned_end ?? '',
    estimated_periods: String(entry.estimated_periods),
  };
}

function generateLessonSection(key: string, label: string, objectives: CurriculumObjective[], lessonObjectives: LessonObjective[]) {
  const source = objectives.map((objective) => ({
    id: objective.id,
    text: `${objective.section_number ? `${objective.section_number} ` : ''}${objective.corrected_text || objective.original_text}`,
  }));
  const normalizedKey = `${key} ${label}`.toLowerCase();
  const linked = objectives.flatMap((objective) => {
    const lessonObjective = lessonObjectives.find((item) => item.syllabus_objective_id === objective.id);
    return lessonObjective ? [lessonObjective] : [];
  });
  if (/objective|outcome/.test(normalizedKey)) {
    return source.map((item) => {
      const lessonObjective = lessonObjectives.find((candidate) => candidate.syllabus_objective_id === item.id);
      return lessonObjective?.objective_text || item.text;
    }).join('\n');
  }
  if (/activity|sequence|teaching|instruction/.test(normalizedKey)) {
    const activities = linked.flatMap((item) => item.suggested_activities);
    if (activities.length) return activities.map((activity, index) => `${index + 1}. ${activity}`).join('\n');
    return source.map((item, index) => `${index + 1}. Model and practise the approved objective: ${item.text}`).join('\n');
  }
  if (/assessment|evidence|check/.test(normalizedKey)) {
    const evidence = linked.flatMap((item) => item.assessment_evidence);
    if (evidence.length) return evidence.map((item) => `- ${item}`).join('\n');
    return source.map((item) => `Check learners can demonstrate: ${item.text}`).join('\n');
  }
  return '';
}

export function CurriculumPlansPanel({ schoolId }: { schoolId: string }) {
  const { user } = useAuth();
  const [documents, setDocuments] = useState<CurriculumDocument[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [years, setYears] = useState<AcademicYear[]>([]);
  const [subjects, setSubjects] = useState<Array<{ id: string; name: string }>>([]);
  const [classes, setClasses] = useState<Array<{ id: string; name: string }>>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [lessonCourses, setLessonCourses] = useState<LessonCourse[]>([]);
  const [lessonCourseRecords, setLessonCourseRecords] = useState<LessonCourseRecord[]>([]);
  const [annualPlans, setAnnualPlans] = useState<AnnualPlan[]>([]);
  const [lessonPlans, setLessonPlans] = useState<SavedLessonPlan[]>([]);
  const [approvedObjectives, setApprovedObjectives] = useState<CurriculumObjective[]>([]);
  const [lessonObjectives, setLessonObjectives] = useState<LessonObjective[]>([]);
  const [selectedAssignmentId, setSelectedAssignmentId] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [selectedObjectiveIds, setSelectedObjectiveIds] = useState<string[]>([]);
  const [selectedCourseLessonId, setSelectedCourseLessonId] = useState('');
  const [lessonTitle, setLessonTitle] = useState('');
  const [lessonSections, setLessonSections] = useState<Record<string, string>>({});
  const [lessonPlanId, setLessonPlanId] = useState('');
  const [annualTitle, setAnnualTitle] = useState('');
  const [activePlanId, setActivePlanId] = useState('');
  const [planEntries, setPlanEntries] = useState<PlanEntry[]>([]);
  const [entryDrafts, setEntryDrafts] = useState<Record<string, EntryDraft>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [documentResult, assignmentResult, yearResult, subjectResult, classResult, templateResult, annualResult, lessonPlanResult, courseLessonResult, lessonCourseRecordResult] = await Promise.all([
        client.from('curriculum_documents').select('id,title,subject_id,academic_year_id,status').eq('school_id', schoolId).in('status', ['approved', 'source_deleted']).order('title'),
        client.from('curriculum_document_assignments').select('id,document_id,academic_year_id,year_group,class_id').eq('school_id', schoolId),
        client.from('academic_years').select('id,name,start_date,end_date,calendar_id').eq('school_id', schoolId).order('start_date', { ascending: false }),
        client.from('subjects').select('id,name').eq('school_id', schoolId).order('name'),
        client.from('school_classes').select('id,name').eq('school_id', schoolId).order('name'),
        client.from('curriculum_templates').select('id,template_key,version,name,category,sections,settings').eq('school_id', schoolId).eq('is_approved', true).order('name').order('version', { ascending: false }),
        client.from('curriculum_teaching_plans').select('id,title,status,academic_year_id,assignment_id,capacity_report,created_at').eq('school_id', schoolId).order('updated_at', { ascending: false }),
        client.from('curriculum_lesson_plans').select('id,title,status,template_id,template_version,assignment_id,course_lesson_id,sections,template_snapshot,updated_at').eq('school_id', schoolId).order('updated_at', { ascending: false }),
        client.from('course_lessons').select('id,title,course_id').eq('school_id', schoolId).order('title'),
        client.from('lesson_courses').select('id,class_id,subject_id').eq('school_id', schoolId),
      ]);
      for (const result of [documentResult, assignmentResult, yearResult, subjectResult, classResult, templateResult, annualResult, lessonPlanResult, courseLessonResult, lessonCourseRecordResult]) {
        if (result.error) throw result.error;
      }
      setDocuments((documentResult.data ?? []) as CurriculumDocument[]);
      setAssignments((assignmentResult.data ?? []) as Assignment[]);
      setYears((yearResult.data ?? []) as AcademicYear[]);
      setSubjects((subjectResult.data ?? []) as Array<{ id: string; name: string }>);
      setClasses((classResult.data ?? []) as Array<{ id: string; name: string }>);
      setTemplates((templateResult.data ?? []) as Template[]);
      setAnnualPlans((annualResult.data ?? []) as AnnualPlan[]);
      setLessonPlans((lessonPlanResult.data ?? []) as SavedLessonPlan[]);
      setLessonCourses((courseLessonResult.data ?? []) as LessonCourse[]);
      setLessonCourseRecords((lessonCourseRecordResult.data ?? []) as LessonCourseRecord[]);
    } catch (loadError) {
      setError(messageOf(loadError, 'Could not load curriculum planning data.'));
    } finally {
      setLoading(false);
    }
  }, [schoolId]);

  useEffect(() => { void load(); }, [load]);

  const assignmentChoices = useMemo<AssignmentChoice[]>(() => assignments.flatMap((assignment) => {
    const document = documents.find((item) => item.id === assignment.document_id);
    const academicYear = years.find((item) => item.id === assignment.academic_year_id);
    if (!document || !academicYear) return [];
    return [{
      ...assignment,
      document,
      academicYear,
      subjectName: subjects.find((subject) => subject.id === document.subject_id)?.name ?? 'Subject',
      className: assignment.class_id ? classes.find((item) => item.id === assignment.class_id)?.name ?? 'Class' : assignment.year_group,
    }];
  }), [assignments, classes, documents, subjects, years]);
  const selectedAssignment = assignmentChoices.find((item) => item.id === selectedAssignmentId) ?? null;
  const selectedTemplate = templates.find((item) => item.id === selectedTemplateId) ?? null;

  useEffect(() => {
    if (!selectedAssignment) {
      setApprovedObjectives([]);
      setLessonObjectives([]);
      return;
    }
    let active = true;
    void (async () => {
      try {
      const client = requireSupabase();
      const { data: objectiveData, error: objectiveError } = await client.from('curriculum_objectives')
        .select('id,section_number,objective_type,original_text,corrected_text')
        .eq('school_id', schoolId)
        .eq('document_id', selectedAssignment.document_id)
        .eq('review_status', 'approved')
        .order('sort_order');
      if (objectiveError) {
        if (active) setError(messageOf(objectiveError, 'Could not load approved objectives.'));
        return;
      }
      const objectiveRows = (objectiveData ?? []) as CurriculumObjective[];
      const { data: lessonData, error: lessonError } = objectiveRows.length
        ? await client.from('curriculum_lesson_objectives')
          .select('id,syllabus_objective_id,objective_text,measurable_outcomes,suggested_activities,assessment_evidence')
          .eq('school_id', schoolId)
          .in('syllabus_objective_id', objectiveRows.map((item) => item.id))
          .or(`assignment_id.is.null,assignment_id.eq.${selectedAssignment.id}`)
        : { data: [], error: null };
      if (lessonError) {
        if (active) setError(messageOf(lessonError, 'Could not load generated lesson objectives.'));
        return;
      }
      if (active) {
        setApprovedObjectives(objectiveRows);
        setLessonObjectives((lessonData ?? []) as LessonObjective[]);
      }
      } catch (objectiveLoadError) {
        if (active) setError(messageOf(objectiveLoadError, 'Could not load approved curriculum objectives.'));
      }
    })();
    return () => { active = false; };
  }, [schoolId, selectedAssignment]);

  const termsForAssignment = useCallback(async (assignment: AssignmentChoice) => {
    const { data, error: termsError } = await requireSupabase().from('terms')
      .select('id,name,start_date,end_date')
      .eq('school_id', schoolId)
      .eq('academic_year_id', assignment.academic_year_id)
      .order('start_date');
    if (termsError) throw termsError;
    return (data ?? []) as Term[];
  }, [schoolId]);

  async function generateAnnualPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedAssignment || !user) return;
    if (!selectedAssignment.class_id) {
      setError('Assign the curriculum to a class before planning around timetable capacity.');
      return;
    }
    if (!approvedObjectives.length) {
      setError('Approve at least one curriculum objective before generating a plan.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const client = requireSupabase();
      const [terms, weeksResult, datesResult, schedulesResult, timetableResult, lessonObjResult] = await Promise.all([
        termsForAssignment(selectedAssignment),
        client.from('academic_calendar_weeks').select('week_number,starts_on,ends_on')
          .eq('school_id', schoolId).eq('calendar_id', selectedAssignment.academicYear.calendar_id)
          .eq('academic_year_id', selectedAssignment.academic_year_id).order('week_number'),
        client.from('academic_calendar_dates').select('event_date,title,date_type,lessons_allowed')
          .eq('school_id', schoolId).eq('calendar_id', selectedAssignment.academicYear.calendar_id)
          .gte('event_date', selectedAssignment.academicYear.start_date).lte('event_date', selectedAssignment.academicYear.end_date),
        client.from('timetable_schedules').select('id').eq('school_id', schoolId).eq('status', 'published'),
        client.from('timetable').select('id,schedule_id,entry_type,day_of_week')
          .eq('school_id', schoolId).eq('class_id', selectedAssignment.class_id)
          .eq('subject_id', selectedAssignment.document.subject_id).eq('entry_type', 'lesson'),
        client.from('curriculum_lesson_objectives').select('id,syllabus_objective_id')
          .eq('school_id', schoolId).in('syllabus_objective_id', approvedObjectives.map((item) => item.id))
          .or(`assignment_id.is.null,assignment_id.eq.${selectedAssignment.id}`),
      ]);
      for (const result of [weeksResult, datesResult, schedulesResult, timetableResult, lessonObjResult]) {
        if (result.error) throw result.error;
      }
      const weeks = (weeksResult.data ?? []) as Array<{ week_number: number; starts_on: string; ends_on: string }>;
      const events = (datesResult.data ?? []) as Array<{ event_date: string; title: string; date_type: string; lessons_allowed: boolean }>;
      const publishedScheduleIds = new Set((schedulesResult.data ?? []).map((item) => item.id));
      const timetableRows = ((timetableResult.data ?? []) as Array<{ schedule_id: string | null; entry_type: string; day_of_week: number }>)
        .filter((entry) => entry.entry_type === 'lesson' && (!entry.schedule_id || publishedScheduleIds.has(entry.schedule_id)));
      const lessonsByObjective = new Map((lessonObjResult.data ?? []).map((item) => [item.syllabus_objective_id, item.id]));
      const slots: Array<{ term_id: string; week_number: number; starts_on: string; ends_on: string; conflictTitles: string[] }> = [];
      const examConflictWeeks: Array<{ week_number: number; titles: string[] }> = [];
      for (const week of weeks) {
        const matchingTerms = terms.map((term) => {
          const start = week.starts_on > term.start_date ? week.starts_on : term.start_date;
          const end = week.ends_on < term.end_date ? week.ends_on : term.end_date;
          const overlapDays = start <= end
            ? Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1
            : 0;
          return { term, overlapDays };
        }).filter((item) => item.overlapDays > 0).sort((left, right) => right.overlapDays - left.overlapDays);
        const termWindow = matchingTerms[0];
        if (!termWindow) continue;
        const startsOn = week.starts_on > selectedAssignment.academicYear.start_date
          ? week.starts_on
          : selectedAssignment.academicYear.start_date;
        const startsInTerm = startsOn > termWindow.term.start_date ? startsOn : termWindow.term.start_date;
        const endsOn = week.ends_on < selectedAssignment.academicYear.end_date
          ? week.ends_on
          : selectedAssignment.academicYear.end_date;
        const endsInTerm = endsOn < termWindow.term.end_date ? endsOn : termWindow.term.end_date;
        if (startsInTerm > endsInTerm) continue;
        const weekEvents = events.filter((item) => inRange(item.event_date, week.starts_on, week.ends_on));
        const unavailableDates = [...new Set(weekEvents.filter((item) => !item.lessons_allowed).map((item) => item.event_date))];
        const unavailablePeriods = unavailableDates.reduce((sum, date) =>
          sum + timetableRows.filter((entry) => entry.day_of_week === dateForWeekDay(date)).length, 0);
        const capacity = Math.max(0, timetableRows.length - unavailablePeriods);
        const conflictTitles = weekEvents.filter((item) => item.date_type === 'examination').map((item) => item.title);
        if (conflictTitles.length) examConflictWeeks.push({ week_number: week.week_number, titles: conflictTitles });
        for (let period = 0; period < capacity; period += 1) {
          slots.push({ term_id: termWindow.term.id, week_number: week.week_number, starts_on: startsInTerm, ends_on: endsInTerm, conflictTitles });
        }
      }
      const unallocatedObjectives = approvedObjectives.slice(slots.length);
      const entries = approvedObjectives.slice(0, slots.length).map((objective, index) => {
        const slot = slots[index];
        return {
          school_id: schoolId,
          term_id: slot.term_id,
          week_number: slot.week_number,
          planned_start: slot.starts_on,
          planned_end: slot.ends_on,
          estimated_periods: 1,
          syllabus_objective_id: objective.id,
          lesson_objective_id: lessonsByObjective.get(objective.id) ?? null,
          assessment_checkpoints: slot.conflictTitles.map((title) => `Calendar exam conflict: ${title}`),
          resources: [],
          position: index,
        };
      });
      const warnings = [
        !weeks.length ? 'No generated academic-calendar weeks are available.' : '',
        !terms.length ? 'No terms are configured for this academic year.' : '',
        !timetableRows.length ? 'No published timetable periods are available for this class and subject.' : '',
        unallocatedObjectives.length ? `${unallocatedObjectives.length} objectives exceed the available lesson capacity.` : '',
        examConflictWeeks.length ? `${examConflictWeeks.length} calendar weeks contain examination dates.` : '',
      ].filter(Boolean);
      const capacityReport = {
        calendar_weeks: weeks.length,
        published_periods_per_week: timetableRows.length,
        available_periods: slots.length,
        planned_objectives: entries.length,
        unallocated_objective_ids: unallocatedObjectives.map((objective) => objective.id),
        missing_periods: timetableRows.length === 0,
        exam_conflict_weeks: examConflictWeeks,
        warnings,
      };
      const title = (annualTitle.trim() || `${selectedAssignment.subjectName} · ${selectedAssignment.className} annual plan`).slice(0, 180);
      const { data: planId, error: planError } = await client.rpc('create_curriculum_teaching_plan', {
        target_school: schoolId,
        target_academic_year: selectedAssignment.academic_year_id,
        target_assignment: selectedAssignment.id,
        target_subject: selectedAssignment.document.subject_id,
        target_class: selectedAssignment.class_id,
        target_title: title,
        target_capacity_report: capacityReport,
        target_entries: entries,
      });
      if (planError) throw planError;
      if (typeof planId !== 'string') throw new Error('The plan service did not return a saved plan ID.');
      setActivePlanId(planId);
      setAnnualTitle('');
      setNotice(`Saved an unpublished annual plan with ${entries.length} allocated objectives.${unallocatedObjectives.length ? ` ${unallocatedObjectives.length} remain unallocated.` : ''}`);
      await Promise.all([load(), loadEntries(planId)]);
    } catch (generateError) {
      setError(messageOf(generateError, 'Could not generate the annual teaching plan.'));
    } finally {
      setSaving(false);
    }
  }

  async function loadEntries(planId: string) {
    const { data, error: entriesError } = await requireSupabase().from('curriculum_teaching_plan_entries')
      .select('id,term_id,week_number,planned_start,planned_end,estimated_periods,assessment_checkpoints,syllabus_objective_id,lesson_objective_id')
      .eq('school_id', schoolId).eq('plan_id', planId).order('position');
    if (entriesError) throw entriesError;
    const rows = (data ?? []) as PlanEntry[];
    setPlanEntries(rows);
    setEntryDrafts(Object.fromEntries(rows.map((entry) => [entry.id, buildEntryDraft(entry)])));
  }

  async function savePlanEdits() {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const client = requireSupabase();
      for (const entry of planEntries) {
        const draft = entryDrafts[entry.id];
        const weekNumber = draft.week_number ? Number(draft.week_number) : null;
        const periods = Number(draft.estimated_periods);
        if ((weekNumber !== null && (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > 80))
          || !Number.isFinite(periods) || periods <= 0) {
          throw new Error('Weeks must be between 1 and 80 and estimated periods must be greater than zero.');
        }
        const { error: updateError } = await client.from('curriculum_teaching_plan_entries').update({
          week_number: weekNumber,
          planned_start: draft.planned_start || null,
          planned_end: draft.planned_end || null,
          estimated_periods: periods,
        }).eq('school_id', schoolId).eq('id', entry.id);
        if (updateError) throw updateError;
      }
      setNotice('Annual plan edits saved. The plan remains a draft.');
      if (activePlanId) await loadEntries(activePlanId);
    } catch (saveError) {
      setError(messageOf(saveError, 'Could not save annual plan edits.'));
    } finally {
      setSaving(false);
    }
  }

  function initializeLessonDraft() {
    if (!selectedAssignment || !selectedTemplate || !approvedObjectives.length || !selectedObjectiveIds.length) {
      setError('Choose an approved template, an assigned curriculum and at least one approved objective.');
      return;
    }
    const sections = selectedTemplate.sections.filter(isTemplateSection);
    const selected = approvedObjectives.filter((objective) => selectedObjectiveIds.includes(objective.id));
    const values: Record<string, string> = {};
    for (const section of sections) {
      const key = typeof section.key === 'string' ? section.key : '';
      if (!key) continue;
      values[key] = generateLessonSection(key, typeof section.label === 'string' ? section.label : key, selected, lessonObjectives);
    }
    setLessonSections(values);
    setLessonPlanId('');
    setLessonTitle(`${selectedAssignment.document.title} lesson plan`);
    setError('');
    setNotice('Lesson plan sections are ready. Add teacher content, then save the draft.');
  }

  async function saveLessonPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedAssignment || !selectedTemplate || !user || !selectedObjectiveIds.length) return;
    const requiredSections = selectedTemplate.sections.filter(isTemplateSection).filter((section) => section.required === true);
    const missingLabels = requiredSections.filter((section) => {
      const key = typeof section.key === 'string' ? section.key : '';
      return !key || !lessonSections[key]?.trim();
    }).map((section) => typeof section.label === 'string' ? section.label : 'Required section');
    if (missingLabels.length) {
      setError(`Complete required template sections before saving: ${missingLabels.join(', ')}.`);
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const client = requireSupabase();
      const { data: planId, error: insertError } = await client.rpc('create_curriculum_lesson_plan', {
        target_school: schoolId,
        target_academic_year: selectedAssignment.academic_year_id,
        target_assignment: selectedAssignment.id,
        target_subject: selectedAssignment.document.subject_id,
        target_class: selectedAssignment.class_id,
        target_template: selectedTemplate.id,
        target_template_version: selectedTemplate.version,
        target_course_lesson: selectedCourseLessonId || null,
        target_title: lessonTitle.trim() || `${selectedAssignment.document.title} lesson plan`,
        target_sections: lessonSections,
        target_generation: 'deterministic',
        target_objective_ids: selectedObjectiveIds,
      });
      if (insertError) throw insertError;
      if (typeof planId !== 'string') throw new Error('The lesson plan service did not return a saved plan ID.');
      setLessonPlanId(planId);
      setNotice('Saved the editable lesson plan as a draft. Template version and source-objective links are preserved.');
      await load();
    } catch (saveError) {
      setError(messageOf(saveError, 'Could not save the lesson plan.'));
    } finally {
      setSaving(false);
    }
  }

  async function selectAnnualPlan(planId: string) {
    setActivePlanId(planId);
    setError('');
    try {
      await loadEntries(planId);
    } catch (loadError) {
      setError(messageOf(loadError, 'Could not load the annual plan entries.'));
    }
  }

  async function selectLessonPlan(planId: string) {
    const plan = lessonPlans.find((item) => item.id === planId);
    if (!plan) return;
    setError('');
    try {
      const { data: objectiveLinks, error: linksError } = await requireSupabase().from('curriculum_lesson_plan_objectives')
        .select('syllabus_objective_id')
        .eq('school_id', schoolId)
        .eq('lesson_plan_id', plan.id);
      if (linksError) throw linksError;
      setSelectedObjectiveIds((objectiveLinks ?? []).map((link) => link.syllabus_objective_id));
    } catch (loadError) {
      setError(messageOf(loadError, 'Could not load the saved lesson-plan objectives.'));
      return;
    }
    setLessonPlanId(plan.id);
    setLessonTitle(plan.title);
    setLessonSections(plan.sections);
    setSelectedAssignmentId(plan.assignment_id);
    setSelectedTemplateId(plan.template_id);
    setSelectedCourseLessonId(plan.course_lesson_id ?? '');
    setError('');
  }

  function regenerateLessonSection(key: string) {
    const section = selectedTemplate?.sections.find((item) => item && typeof item === 'object' && (item as Record<string, unknown>).key === key) as Record<string, unknown> | undefined;
    const label = typeof section?.label === 'string' ? section.label : key;
    const selected = approvedObjectives.filter((objective) => selectedObjectiveIds.includes(objective.id));
    setLessonSections((current) => ({ ...current, [key]: generateLessonSection(key, label, selected, lessonObjectives) }));
  }

  async function updateLessonPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!lessonPlanId) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: updateError } = await requireSupabase().from('curriculum_lesson_plans')
        .update({ title: lessonTitle.trim(), sections: lessonSections, course_lesson_id: selectedCourseLessonId || null })
        .eq('school_id', schoolId).eq('id', lessonPlanId).eq('status', 'draft');
      if (updateError) throw updateError;
      setNotice('Lesson plan edits saved. Its source links and original template snapshot are unchanged.');
      await load();
    } catch (saveError) {
      setError(messageOf(saveError, 'Could not save lesson plan edits.'));
    } finally {
      setSaving(false);
    }
  }

  const currentAnnualPlan = annualPlans.find((plan) => plan.id === activePlanId);
  const linkedCourseLessons = selectedAssignment?.class_id
    ? lessonCourses.filter((lesson) => lessonCourseRecords.some((course) =>
      course.id === lesson.course_id
      && course.class_id === selectedAssignment.class_id
      && course.subject_id === selectedAssignment.document.subject_id))
    : [];

  return (
    <div className="curriculum-plans-workspace">
      {(error || notice) && <div className="curriculum-feedback">{error && <ErrorState message={error} />}{notice && <SuccessMessage message={notice} />}</div>}
      {loading ? <LoadingState /> : <>
        <section className="content-card curriculum-plan-section">
          <div className="section-heading"><div><span className="eyebrow">Calendar and timetable aware</span><h2>Annual teaching plans</h2></div><CalendarDays size={19} /></div>
          <p className="curriculum-section-intro">Draft plans allocate approved objectives against academic-calendar weeks and published class/subject periods. Capacity gaps, examination weeks and unallocated objectives are reported; plans are never published automatically.</p>
          <form className="curriculum-plan-form" onSubmit={(event) => void generateAnnualPlan(event)}>
            <label className="field"><span>Assigned curriculum</span>
              <select value={selectedAssignmentId} onChange={(event) => { setSelectedAssignmentId(event.target.value); setSelectedObjectiveIds([]); setLessonSections({}); setLessonPlanId(''); }} required>
                <option value="">Choose a class assignment</option>
                {assignmentChoices.map((choice) => <option key={choice.id} value={choice.id}>{choice.document.title} · {choice.subjectName} · {choice.className} · {choice.academicYear.name}</option>)}
              </select>
            </label>
            <label className="field"><span>Plan title</span><input value={annualTitle} onChange={(event) => setAnnualTitle(event.target.value)} maxLength={180} placeholder="Optional" /></label>
            <button type="submit" className="button button-primary" disabled={saving || !selectedAssignment || !approvedObjectives.length}>
              {saving ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />} Generate draft annual plan
            </button>
            {selectedAssignment && !selectedAssignment.class_id && <p className="curriculum-plan-warning">This curriculum assignment is for a year group, not a class. A class assignment is required to calculate timetable capacity.</p>}
            {selectedAssignment && approvedObjectives.length === 0 && <p className="curriculum-plan-warning">No approved objectives are available in this assignment.</p>}
          </form>

          <div className="curriculum-plan-list">
            <h3>Saved annual plans</h3>
            {annualPlans.length
              ? annualPlans.map((plan) => <button type="button" className={`curriculum-plan-list-item ${activePlanId === plan.id ? 'active' : ''}`} key={plan.id} onClick={() => void selectAnnualPlan(plan.id)}>
                <span><strong>{plan.title}</strong><small>{years.find((year) => year.id === plan.academic_year_id)?.name ?? 'Academic year'} · {plan.status} · {new Date(plan.created_at).toLocaleDateString()}</small></span>
                <span>{Array.isArray(plan.capacity_report.warnings) ? plan.capacity_report.warnings.length : 0} alerts</span>
              </button>)
              : <EmptyState title="No annual plans yet" detail="Generate a draft plan from an approved curriculum assignment." />}
          </div>
          {currentAnnualPlan && <div className="curriculum-annual-plan-editor">
            <div className="curriculum-generated-heading"><strong>{currentAnnualPlan.title}</strong><span>Draft</span></div>
            {Array.isArray(currentAnnualPlan.capacity_report.warnings) && currentAnnualPlan.capacity_report.warnings.map((warning) => <p className="curriculum-plan-warning" key={String(warning)}>{String(warning)}</p>)}
            {Array.isArray(currentAnnualPlan.capacity_report.unallocated_objective_ids) && currentAnnualPlan.capacity_report.unallocated_objective_ids.length > 0 && <p className="curriculum-plan-warning">{currentAnnualPlan.capacity_report.unallocated_objective_ids.length} objectives are not scheduled. Add published periods or adjust the plan.</p>}
            {planEntries.length
              ? <div className="curriculum-plan-entry-list">{planEntries.map((entry) => {
                const objective = approvedObjectives.find((item) => item.id === entry.syllabus_objective_id);
                const draft = entryDrafts[entry.id] ?? buildEntryDraft(entry);
                return <article className="curriculum-plan-entry" key={entry.id}>
                  <p>{objective?.corrected_text || objective?.original_text || 'Approved objective'}{objective?.section_number ? ` · ${objective.section_number}` : ''}</p>
                  <div className="curriculum-plan-entry-fields">
                    <label className="field"><span>Week</span><input type="number" min="1" max="80" value={draft.week_number} onChange={(event) => setEntryDrafts((current) => ({ ...current, [entry.id]: { ...draft, week_number: event.target.value } }))} /></label>
                    <label className="field"><span>Start</span><input type="date" value={draft.planned_start} onChange={(event) => setEntryDrafts((current) => ({ ...current, [entry.id]: { ...draft, planned_start: event.target.value } }))} /></label>
                    <label className="field"><span>End</span><input type="date" value={draft.planned_end} onChange={(event) => setEntryDrafts((current) => ({ ...current, [entry.id]: { ...draft, planned_end: event.target.value } }))} /></label>
                    <label className="field"><span>Periods</span><input type="number" min="0.25" step="0.25" value={draft.estimated_periods} onChange={(event) => setEntryDrafts((current) => ({ ...current, [entry.id]: { ...draft, estimated_periods: event.target.value } }))} /></label>
                  </div>
                  {entry.assessment_checkpoints.length > 0 && <small className="curriculum-plan-warning">{entry.assessment_checkpoints.join(' · ')}</small>}
                </article>;
              })}</div>
              : <EmptyState title="No objectives were allocated" detail="Check the plan's calendar weeks and published timetable periods before retrying." />}
            {planEntries.length > 0 && <button type="button" className="button button-secondary" disabled={saving} onClick={() => void savePlanEdits()}>{saving ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />} Save plan edits</button>}
          </div>}
        </section>

        <section className="content-card curriculum-plan-section">
          <div className="section-heading"><div><span className="eyebrow">Editable lesson documents</span><h2>Template-based lesson plans</h2></div><FilePlus2 size={19} /></div>
          <p className="curriculum-section-intro">Choose an approved template and approved syllabus objectives. The template version is snapshotted, edits are saved in the draft, and optional course lessons can be linked.</p>
          <div className="curriculum-plan-form">
            <label className="field"><span>Assigned curriculum</span>
              <select value={selectedAssignmentId} disabled={Boolean(lessonPlanId)} onChange={(event) => { setSelectedAssignmentId(event.target.value); setSelectedObjectiveIds([]); setLessonSections({}); setLessonPlanId(''); }}>
                <option value="">Choose an assignment</option>
                {assignmentChoices.map((choice) => <option key={choice.id} value={choice.id}>{choice.document.title} · {choice.subjectName} · {choice.className} · {choice.academicYear.name}</option>)}
              </select>
            </label>
            <label className="field"><span>Approved template</span>
              <select value={selectedTemplateId} disabled={Boolean(lessonPlanId)} onChange={(event) => setSelectedTemplateId(event.target.value)}>
                <option value="">Choose a template</option>
                {templates.filter((template) => template.category === 'lesson_plan').map((template) => <option key={template.id} value={template.id}>{template.name} · v{template.version}</option>)}
              </select>
            </label>
            <label className="field"><span>Connect to course lesson</span>
              <select value={selectedCourseLessonId} onChange={(event) => setSelectedCourseLessonId(event.target.value)}>
                <option value="">No course lesson linked</option>
                {linkedCourseLessons.map((lesson) => <option key={lesson.id} value={lesson.id}>{lesson.title}</option>)}
              </select>
            </label>
            <button type="button" className="button button-secondary" disabled={!selectedAssignment || !selectedTemplate || !approvedObjectives.length} onClick={initializeLessonDraft}><Sparkles size={16} /> {lessonPlanId ? 'Start a new lesson plan' : 'Generate template draft'}</button>
          </div>
          {approvedObjectives.length > 0 && <div className="curriculum-plan-objective-picker">
            <strong>Approved objectives</strong>
            {approvedObjectives.map((objective) => <label key={objective.id}>
              <input type="checkbox" disabled={Boolean(lessonPlanId)} checked={selectedObjectiveIds.includes(objective.id)} onChange={(event) => setSelectedObjectiveIds((current) => event.target.checked ? [...current, objective.id] : current.filter((id) => id !== objective.id))} />
              <span>{objective.section_number ? `${objective.section_number} · ` : ''}{objective.corrected_text || objective.original_text}</span>
            </label>)}
          </div>}
          {Object.keys(lessonSections).length > 0 && <form className="curriculum-template-form" onSubmit={(event) => lessonPlanId ? void updateLessonPlan(event) : void saveLessonPlan(event)}>
            <label className="field"><span>Lesson plan title</span><input value={lessonTitle} onChange={(event) => setLessonTitle(event.target.value)} maxLength={180} placeholder={`${selectedAssignment?.document.title ?? 'Curriculum'} lesson plan`} /></label>
            {Object.entries(lessonSections).map(([key, value]) => {
              const section = selectedTemplate?.sections.find((item) => item && typeof item === 'object' && (item as Record<string, unknown>).key === key) as Record<string, unknown> | undefined;
              const label = typeof section?.label === 'string' ? section.label : key;
              const required = section?.required === true;
              return <div className="curriculum-lesson-section" key={key}>
                <label className="field"><span>{label}{required ? ' · required' : ''}</span>
                  <textarea rows={4} value={value} onChange={(event) => setLessonSections((current) => ({ ...current, [key]: event.target.value }))} maxLength={12000} required={required} />
                </label>
                <button type="button" className="button button-quiet" disabled={!selectedObjectiveIds.length} onClick={() => regenerateLessonSection(key)}>Recreate this section from approved objectives</button>
              </div>;
            })}
            <button type="submit" className="button button-primary" disabled={saving || !lessonTitle.trim()}>{saving ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />} {lessonPlanId ? 'Save lesson plan edits' : 'Save lesson plan draft'}</button>
          </form>}
          <div className="curriculum-plan-list">
            <h3>Saved lesson plans</h3>
            {lessonPlans.length
              ? lessonPlans.map((plan) => <button type="button" className={`curriculum-plan-list-item ${lessonPlanId === plan.id ? 'active' : ''}`} key={plan.id} onClick={() => void selectLessonPlan(plan.id)}>
                <span><strong>{plan.title}</strong><small>{templates.find((template) => template.id === plan.template_id)?.name ?? 'Template'} · v{plan.template_version} · {plan.status}</small></span>
                <span>{new Date(plan.updated_at).toLocaleDateString()}</span>
              </button>)
              : <EmptyState title="No saved lesson plans" detail="Generate a template draft and save it after completing the required sections." />}
          </div>
        </section>
      </>}
    </div>
  );
}
