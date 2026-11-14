import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Activity, Check, LoaderCircle, Plus, RefreshCw } from 'lucide-react';
import { EmptyState, ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { useAuth } from '../contexts/AuthContext';
import { requireSupabase } from '../lib/supabase';

type DocumentRow = { id: string; title: string; subject_id: string; academic_year_id: string; status: string };
type AssignmentRow = { id: string; document_id: string; academic_year_id: string; year_group: string; class_id: string | null };
type AssignmentChoice = AssignmentRow & { document: DocumentRow; subjectName: string; className: string; yearName: string };
type Objective = { id: string; section_number: string; objective_type: string; original_text: string; corrected_text: string };
type CoverageRecord = { id: string; syllabus_objective_id: string; lesson_id: string | null; coverage_status: string; lesson_date: string };
type TeachingPlan = { id: string };
type PlannedEntry = { syllabus_objective_id: string | null; lesson_objective_id: string | null };
type AssessmentAlignment = { assessment_id: string; syllabus_objective_id: string };
type AssessmentMark = { assessment_id: string; marks_obtained: number; maximum_marks: number; assessment_date: string };
type CourseLesson = { id: string; title: string; course_id: string };
type LessonCourse = { id: string; class_id: string; subject_id: string };
type AcademicYear = { id: string; name: string };
type CoverageView = {
  records: CoverageRecord[];
  planned: PlannedEntry[];
  alignments: AssessmentAlignment[];
  marks: AssessmentMark[];
};

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function CurriculumCoveragePanel({ schoolId }: { schoolId: string }) {
  const { user } = useAuth();
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [assignments, setAssignments] = useState<AssignmentRow[]>([]);
  const [subjects, setSubjects] = useState<Array<{ id: string; name: string }>>([]);
  const [classes, setClasses] = useState<Array<{ id: string; name: string }>>([]);
  const [years, setYears] = useState<AcademicYear[]>([]);
  const [lessons, setLessons] = useState<CourseLesson[]>([]);
  const [courses, setCourses] = useState<LessonCourse[]>([]);
  const [objectives, setObjectives] = useState<Objective[]>([]);
  const [assignmentId, setAssignmentId] = useState('');
  const [objectiveId, setObjectiveId] = useState('');
  const [lessonId, setLessonId] = useState('');
  const [coverageStatus, setCoverageStatus] = useState<'fully_covered' | 'partially_covered' | 'not_covered'>('fully_covered');
  const [lessonDate, setLessonDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [view, setView] = useState<CoverageView>({ records: [], planned: [], alignments: [], marks: [] });
  const [loading, setLoading] = useState(true);
  const [loadingReport, setLoadingReport] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const assignmentChoices = useMemo<AssignmentChoice[]>(() => assignments.flatMap((assignment) => {
    const document = documents.find((item) => item.id === assignment.document_id);
    if (!document) return [];
    return [{
      ...assignment,
      document,
      subjectName: subjects.find((subject) => subject.id === document.subject_id)?.name ?? 'Subject',
      className: assignment.class_id ? classes.find((item) => item.id === assignment.class_id)?.name ?? 'Class' : assignment.year_group,
      yearName: years.find((year) => year.id === assignment.academic_year_id)?.name ?? 'Academic year',
    }];
  }), [assignments, classes, documents, subjects, years]);
  const selectedAssignment = assignmentChoices.find((item) => item.id === assignmentId) ?? null;
  const linkedCourseLessons = selectedAssignment?.class_id
    ? lessons.filter((lesson) => courses.some((course) => course.id === lesson.course_id
      && course.class_id === selectedAssignment.class_id
      && course.subject_id === selectedAssignment.document.subject_id))
    : [];
  const lessonNameById = useMemo(() => new Map(lessons.map((lesson) => [lesson.id, lesson.title])), [lessons]);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [documentResult, assignmentResult, subjectResult, classResult, yearResult, lessonResult, courseResult] = await Promise.all([
        client.from('curriculum_documents').select('id,title,subject_id,academic_year_id,status')
          .eq('school_id', schoolId).in('status', ['approved', 'source_deleted']).order('title'),
        client.from('curriculum_document_assignments').select('id,document_id,academic_year_id,year_group,class_id')
          .eq('school_id', schoolId),
        client.from('subjects').select('id,name').eq('school_id', schoolId).order('name'),
        client.from('school_classes').select('id,name').eq('school_id', schoolId).order('name'),
        client.from('academic_years').select('id,name').eq('school_id', schoolId).order('start_date', { ascending: false }),
        client.from('course_lessons').select('id,title,course_id').eq('school_id', schoolId).order('title'),
        client.from('lesson_courses').select('id,class_id,subject_id').eq('school_id', schoolId),
      ]);
      for (const result of [documentResult, assignmentResult, subjectResult, classResult, yearResult, lessonResult, courseResult]) {
        if (result.error) throw result.error;
      }
      setDocuments((documentResult.data ?? []) as DocumentRow[]);
      setAssignments((assignmentResult.data ?? []) as AssignmentRow[]);
      setSubjects((subjectResult.data ?? []) as Array<{ id: string; name: string }>);
      setClasses((classResult.data ?? []) as Array<{ id: string; name: string }>);
      setYears((yearResult.data ?? []) as AcademicYear[]);
      setLessons((lessonResult.data ?? []) as CourseLesson[]);
      setCourses((courseResult.data ?? []) as LessonCourse[]);
    } catch (loadError) {
      setError(messageOf(loadError, 'Could not load curriculum coverage data.'));
    } finally {
      setLoading(false);
    }
  }, [schoolId]);

  useEffect(() => { void load(); }, [load]);

  const loadObjectivesAndReport = useCallback(async (assignment: AssignmentChoice) => {
    if (!assignment.class_id) {
      setObjectives([]);
      setView({ records: [], planned: [], alignments: [], marks: [] });
      return;
    }
    setLoadingReport(true);
    setError('');
    try {
      const client = requireSupabase();
      const { data: objectiveData, error: objectiveError } = await client.from('curriculum_objectives')
        .select('id,section_number,objective_type,original_text,corrected_text')
        .eq('school_id', schoolId).eq('document_id', assignment.document_id)
        .eq('review_status', 'approved').order('sort_order');
      if (objectiveError) throw objectiveError;
      const objectiveRows = (objectiveData ?? []) as Objective[];
      setObjectives(objectiveRows);
      if (!objectiveRows.length) {
        setView({ records: [], planned: [], alignments: [], marks: [] });
        return;
      }
      const objectiveIds = objectiveRows.map((objective) => objective.id);
      const [coverageResult, plansResult, lessonPlansResult, alignmentResult, studentResult] = await Promise.all([
        client.from('curriculum_coverage_records').select('id,syllabus_objective_id,lesson_id,coverage_status,lesson_date')
          .eq('school_id', schoolId).eq('assignment_id', assignment.id).eq('class_id', assignment.class_id)
          .in('syllabus_objective_id', objectiveIds),
        client.from('curriculum_teaching_plans').select('id,status')
          .eq('school_id', schoolId).eq('assignment_id', assignment.id),
        client.from('curriculum_lesson_plans').select('id')
          .eq('school_id', schoolId).eq('assignment_id', assignment.id),
        client.from('curriculum_assessment_objectives').select('assessment_id,syllabus_objective_id,question_id')
          .eq('school_id', schoolId).in('syllabus_objective_id', objectiveIds).is('question_id', null),
        client.from('students').select('id').eq('school_id', schoolId).eq('class_id', assignment.class_id),
      ]);
      for (const result of [coverageResult, plansResult, lessonPlansResult, alignmentResult, studentResult]) {
        if (result.error) throw result.error;
      }
      const plans = (plansResult.data ?? []) as TeachingPlan[];
      const lessonPlanIds = (lessonPlansResult.data ?? []).map((plan) => plan.id);
      const [plannedResult, plannedLessonResult, assessmentsResult] = await Promise.all([
        plans.length
          ? client.from('curriculum_teaching_plan_entries').select('syllabus_objective_id,lesson_objective_id')
            .eq('school_id', schoolId).in('plan_id', plans.map((plan) => plan.id))
          : Promise.resolve({ data: [], error: null }),
        lessonPlanIds.length
          ? client.from('curriculum_lesson_plan_objectives').select('syllabus_objective_id,lesson_objective_id')
            .eq('school_id', schoolId).in('lesson_plan_id', lessonPlanIds)
          : Promise.resolve({ data: [], error: null }),
        (alignmentResult.data ?? []).length
          ? client.from('learning_assessments').select('id').eq('school_id', schoolId)
            .in('id', (alignmentResult.data ?? []).map((alignment) => alignment.assessment_id))
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (plannedResult.error) throw plannedResult.error;
      if (plannedLessonResult.error) throw plannedLessonResult.error;
      if (assessmentsResult.error) throw assessmentsResult.error;
      const assessmentIds = (assessmentsResult.data ?? []).map((assessment) => assessment.id);
      const studentIds = (studentResult.data ?? []).map((student) => student.id);
      const resultRows = assessmentIds.length && studentIds.length
        ? await client.from('learning_assessment_results')
          .select('assessment_id,marks_obtained,maximum_marks,assessment_date')
          .eq('school_id', schoolId).in('assessment_id', assessmentIds).in('student_id', studentIds)
          .in('status', ['approved', 'published'])
        : { data: [], error: null };
      if (resultRows.error) throw resultRows.error;
      setView({
        records: (coverageResult.data ?? []) as CoverageRecord[],
        planned: [...(plannedResult.data ?? []), ...(plannedLessonResult.data ?? [])] as PlannedEntry[],
        alignments: (alignmentResult.data ?? []).map((item) => ({
          assessment_id: item.assessment_id,
          syllabus_objective_id: item.syllabus_objective_id,
        })) as AssessmentAlignment[],
        marks: (resultRows.data ?? []) as AssessmentMark[],
      });
    } catch (reportError) {
      setError(messageOf(reportError, 'Could not load the objective coverage report.'));
    } finally {
      setLoadingReport(false);
    }
  }, [schoolId]);

  useEffect(() => {
    const assignment = assignmentChoices.find((item) => item.id === assignmentId);
    if (!assignment) {
      setObjectives([]);
      setView({ records: [], planned: [], alignments: [], marks: [] });
      return;
    }
    setObjectiveId('');
    setLessonId('');
    void loadObjectivesAndReport(assignment);
  }, [assignmentChoices, assignmentId, loadObjectivesAndReport]);

  async function recordCoverage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedAssignment?.class_id || !user || !objectiveId || !lessonId) {
      setError('Choose a class assignment, approved objective, and actual course lesson.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: insertError } = await requireSupabase().from('curriculum_coverage_records').insert({
        school_id: schoolId,
        assignment_id: selectedAssignment.id,
        class_id: selectedAssignment.class_id,
        syllabus_objective_id: objectiveId,
        lesson_id: lessonId,
        coverage_status: coverageStatus,
        lesson_date: lessonDate,
        notes: notes.trim(),
        recorded_by: user.id,
      });
      if (insertError) throw insertError;
      setNotes('');
      setNotice('Lesson coverage recorded. Planned and assessed items are not counted as taught.');
      await loadObjectivesAndReport(selectedAssignment);
    } catch (insertError) {
      setError(messageOf(insertError, 'Could not record lesson coverage.'));
    } finally {
      setSaving(false);
    }
  }

  const objectiveRows = objectives.map((objective) => {
    const planned = view.planned.some((entry) => entry.syllabus_objective_id === objective.id);
    const records = view.records.filter((record) => record.syllabus_objective_id === objective.id);
    const taught = records.filter((record) => Boolean(record.lesson_id) && record.coverage_status !== 'not_covered');
    const linkedAssessmentIds = new Set(view.alignments.filter((link) => link.syllabus_objective_id === objective.id).map((link) => link.assessment_id));
    const marks = view.marks.filter((mark) => linkedAssessmentIds.has(mark.assessment_id));
    const marksEarned = marks.reduce((sum, mark) => sum + Number(mark.marks_obtained), 0);
    const maximumMarks = marks.reduce((sum, mark) => sum + Number(mark.maximum_marks), 0);
    return {
      objective,
      planned,
      taught,
      assessed: marks.length,
      marksEarned,
      maximumMarks,
      markPercentage: maximumMarks > 0 ? (marksEarned / maximumMarks) * 100 : null,
    };
  });

  const reportAssignment = selectedAssignment;

  return (
    <div className="curriculum-coverage-workspace">
      {(error || notice) && <div className="curriculum-feedback">{error && <ErrorState message={error} />}{notice && <SuccessMessage message={notice} />}</div>}
      {loading ? <LoadingState /> : <>
        <section className="content-card curriculum-coverage-card">
          <div className="section-heading"><div><span className="eyebrow">Actual lesson records</span><h2>Record curriculum coverage</h2></div><Check size={19} /></div>
          <p className="curriculum-section-intro">Only a linked course lesson counts as taught. Planned and assessed objectives are reported separately.</p>
          <form className="curriculum-coverage-form" onSubmit={(event) => void recordCoverage(event)}>
            <label className="field"><span>Class curriculum assignment</span>
              <select value={assignmentId} onChange={(event) => setAssignmentId(event.target.value)} required>
                <option value="">Choose an assignment</option>
                {assignmentChoices.map((choice) => <option key={choice.id} value={choice.id} disabled={!choice.class_id}>
                  {choice.document.title} · {choice.subjectName} · {choice.className} · {choice.yearName}
                </option>)}
              </select>
            </label>
            {reportAssignment?.class_id && <>
              <label className="field"><span>Approved objective</span>
                <select value={objectiveId} onChange={(event) => setObjectiveId(event.target.value)} required>
                  <option value="">Choose an objective</option>
                  {objectives.map((objective) => <option key={objective.id} value={objective.id}>
                    {objective.section_number ? `${objective.section_number} · ` : ''}{objective.corrected_text || objective.original_text}
                  </option>)}
                </select>
              </label>
              <label className="field"><span>Course lesson</span>
                <select value={lessonId} onChange={(event) => setLessonId(event.target.value)} required>
                  <option value="">Choose the lesson taught</option>
                  {linkedCourseLessons.map((lesson) => <option key={lesson.id} value={lesson.id}>{lesson.title}</option>)}
                </select>
              </label>
              <label className="field"><span>Coverage recorded</span>
                <select value={coverageStatus} onChange={(event) => setCoverageStatus(event.target.value as typeof coverageStatus)}>
                  <option value="fully_covered">Fully covered</option>
                  <option value="partially_covered">Partially covered</option>
                  <option value="not_covered">Not covered in this lesson</option>
                </select>
              </label>
              <label className="field"><span>Lesson date</span><input type="date" value={lessonDate} onChange={(event) => setLessonDate(event.target.value)} required /></label>
              <label className="field curriculum-coverage-notes"><span>Notes</span><textarea rows={2} maxLength={5000} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
              <button type="submit" className="button button-primary" disabled={saving || !linkedCourseLessons.length}>
                {saving ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />} Save actual lesson record
              </button>
              {!linkedCourseLessons.length && <p className="curriculum-plan-warning">No course lessons match this class and subject. Create a course lesson before recording coverage.</p>}
            </>}
          </form>
        </section>

        <section className="content-card curriculum-coverage-card">
          <div className="section-heading"><div><span className="eyebrow">Separate evidence states</span><h2>Objective progress</h2></div><Activity size={19} /></div>
          <p className="curriculum-section-intro">Assessment marks include only approved or published results from the selected class. The mark aggregate is descriptive and does not assign mastery labels.</p>
          {loadingReport ? <LoadingState label="Recalculating objective evidence…" /> : objectiveRows.length
            ? <div className="curriculum-objective-progress-list">{objectiveRows.map((row) => (
              <article className="curriculum-objective-progress" key={row.objective.id}>
                <div className="curriculum-objective-progress-title"><span>{row.objective.section_number || 'Objective'} · {row.objective.objective_type.replaceAll('_', ' ')}</span><strong>{row.objective.corrected_text || row.objective.original_text}</strong></div>
                <div className="curriculum-objective-progress-states">
                  <span className={row.planned ? 'state-done' : ''}>Planned <strong>{row.planned ? 'Yes' : 'No'}</strong></span>
                  <span className={row.taught.length ? 'state-done' : ''}>Taught <strong>{row.taught.length ? `${row.taught.length} lesson record${row.taught.length === 1 ? '' : 's'}` : 'No linked lesson'}</strong></span>
                  <span className={row.assessed ? 'state-done' : ''}>Assessed <strong>{row.assessed ? `${row.assessed} recorded mark${row.assessed === 1 ? '' : 's'}` : 'No aligned result'}</strong></span>
                  <span>Recorded marks <strong>{row.markPercentage === null ? '—' : `${row.marksEarned} / ${row.maximumMarks} · ${row.markPercentage.toFixed(1)}%`}</strong></span>
                </div>
                {row.taught.length > 0 && <small>{row.taught.map((record) => `${lessonNameById.get(record.lesson_id ?? '') ?? 'Course lesson'} · ${new Date(`${record.lesson_date}T00:00:00`).toLocaleDateString()}`).join(' · ')}</small>}
              </article>
            ))}</div>
            : <EmptyState title={reportAssignment ? 'No approved objectives in this assignment' : 'Choose a class assignment'} detail="Objective progress appears after an approved class curriculum is selected." />}
          {reportAssignment && !reportAssignment.class_id && <p className="curriculum-plan-warning">Choose a class-level curriculum assignment. Year-group-only assignments do not have class-specific lesson or mark evidence.</p>}
          <button type="button" className="button button-quiet" disabled={!selectedAssignment?.class_id || loadingReport} onClick={() => selectedAssignment && void loadObjectivesAndReport(selectedAssignment)}><RefreshCw size={14} /> Refresh objective evidence</button>
        </section>
      </>}
    </div>
  );
}
