import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  BookOpenCheck, Check, ClipboardCheck, Copy, ExternalLink, FilePlus2, FileText, Filter,
  History, Library, Pencil, Plus, Printer, Save, Search, Trash2, X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { ErrorState, LoadingState } from '../components/Feedback';
import { DraftRecoveryControls } from '../components/DraftRecoveryControls';
import { requireSupabase } from '../lib/supabase';
import { useRecoverableDraft } from '../lib/recoverable-drafts';

type Difficulty = 'Foundation' | 'Standard' | 'Challenging' | 'Mixed';
type AssessmentStatus = 'draft' | 'ready';
type LearningView = 'assessments' | 'library' | 'papers' | 'results';
type Question = {
  id: string;
  department_id: string | null;
  question_text: string;
  topic: string;
  subtopic: string;
  marks: number;
  difficulty: string;
  source_name: string;
  source_url: string;
  mark_scheme: string;
};
type PastPaper = {
  id: string;
  subject_name: string;
  subject_code: string;
  year: number;
  session: 'm' | 's' | 'w';
  paper_number: string;
  document_type: 'qp' | 'ms' | 'er' | 'specimen';
  file_name: string;
  file_size: number;
  created_at: string;
};
type Assessment = {
  id: string;
  created_by: string;
  title: string;
  curriculum: string;
  qualification: string;
  subject: string;
  syllabus_code: string;
  topic: string;
  subtopic: string;
  duration_minutes: number;
  total_marks: number;
  difficulty: Difficulty;
  instructions: string;
  question_order: string;
  permitted_resources: string;
  mark_scheme: string;
  question_ids: string[];
  status: AssessmentStatus;
  department_id: string | null;
  updated_at: string;
};
type Department = { id: string; name: string };
type StudentChoice = {
  id: string;
  student_number: string;
  first_name: string;
  last_name: string;
  status: string;
};
type AssessmentResult = {
  id: string;
  student_id: string;
  assessment_id: string;
  marks_obtained: number;
  maximum_marks: number;
  percentage: number;
  assessment_date: string;
  notes: string;
  status: 'draft' | 'approved' | 'published';
  created_at: string;
  updated_at: string;
};
type ResultForm = {
  student_id: string;
  assessment_id: string;
  marks_obtained: string;
  assessment_date: string;
  notes: string;
};
type AssessmentForm = Omit<Assessment, 'id' | 'created_by' | 'updated_at'>;
type QuestionForm = Omit<Question, 'id'>;
type PrintMode = 'paper' | 'answer-sheet';

const QUALIFICATIONS = [
  'Cambridge Primary',
  'Cambridge Lower Secondary',
  'Cambridge IGCSE',
  'Cambridge International AS Level',
  'Cambridge International A Level',
  'Custom qualification',
];
const EMPTY_QUESTION: QuestionForm = {
  department_id: null, question_text: '', topic: '', subtopic: '', marks: 1, difficulty: 'Standard',
  source_name: 'Teacher-created', source_url: '', mark_scheme: '',
};
const EMPTY_ASSESSMENT: AssessmentForm = {
  title: '', curriculum: 'Cambridge', qualification: 'Cambridge IGCSE', subject: '',
  syllabus_code: '', topic: '', subtopic: '', duration_minutes: 60, total_marks: 0,
  difficulty: 'Mixed', instructions: 'Answer all questions. Show your working where appropriate.',
  question_order: 'As selected', permitted_resources: 'No calculators', mark_scheme: '',
  question_ids: [], status: 'draft',
  department_id: null,
};
const CAMBRIDGE_PAST_PAPERS_URL = 'https://www.cambridgeinternational.org/support-and-training-for-schools/support-for-teachers/past-papers/';

function localDate() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

function toAssessmentForm(assessment: Assessment): AssessmentForm {
  const { id: _id, created_by: _createdBy, updated_at: _updatedAt, ...form } = assessment;
  return form;
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && quoted && text[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(value.trim());
      value = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(value.trim());
      if (row.some((cell) => cell)) rows.push(row);
      row = [];
      value = '';
    } else {
      value += character;
    }
  }
  row.push(value.trim());
  if (row.some((cell) => cell)) rows.push(row);
  return rows;
}

export function TestMakerPage() {
  const { activeMembership, user } = useAuth();
  const schoolId = activeMembership?.school_id;
  const isAcademicLead = activeMembership?.role === 'school_admin' || activeMembership?.role === 'academic_coordinator';
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [hodDepartmentIds, setHodDepartmentIds] = useState<string[]>([]);
  const [students, setStudents] = useState<StudentChoice[]>([]);
  const [results, setResults] = useState<AssessmentResult[]>([]);
  const [activeAssessmentId, setActiveAssessmentId] = useState('');
  const [editingResultId, setEditingResultId] = useState('');
  const [resultForm, setResultForm] = useState<ResultForm>({
    student_id: '',
    assessment_id: '',
    marks_obtained: '',
    assessment_date: localDate(),
    notes: '',
  });
  const [form, setForm] = useState<AssessmentForm>(EMPTY_ASSESSMENT);
  const [questionForm, setQuestionForm] = useState<QuestionForm>(EMPTY_QUESTION);
  const [editingQuestionId, setEditingQuestionId] = useState('');
  const [query, setQuery] = useState('');
  const [resultQuery, setResultQuery] = useState('');
  const [topicFilter, setTopicFilter] = useState('');
  const [papers, setPapers] = useState<PastPaper[]>([]);
  const [view, setView] = useState<LearningView>('assessments');
  const [includeMarkScheme, setIncludeMarkScheme] = useState(false);
  const [printMode, setPrintMode] = useState<PrintMode>('paper');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const isHod = hodDepartmentIds.length > 0;
  const availableDepartments = isAcademicLead
    ? departments
    : departments.filter((department) => hodDepartmentIds.includes(department.id));
  const assessmentDraft = useRecoverableDraft({
    schoolId,
    userId: user?.id,
    entity: 'assessment',
    entityId: activeAssessmentId || 'new-assessment',
    payload: { activeAssessmentId, form },
    enabled: !loading && Boolean(schoolId && user && ['school_admin', 'academic_coordinator', 'teacher'].includes(activeMembership?.role ?? '')),
  });

  function restoreAssessmentDraft(value: { activeAssessmentId: string; form: AssessmentForm }) {
    setActiveAssessmentId(value.activeAssessmentId);
    setForm(value.form);
    setView('assessments');
    setNotice('Saved test draft restored. Review the fields before saving to the school record.');
  }

  useEffect(() => {
    if (!schoolId) return;
    setAssessments([]);
    setQuestions([]);
    setDepartments([]);
    setHodDepartmentIds([]);
    setQuestionForm({ ...EMPTY_QUESTION });
    setStudents([]);
    setResults([]);
    setPapers([]);
    setActiveAssessmentId('');
    setEditingResultId('');
    setResultForm({ student_id: '', assessment_id: '', marks_obtained: '', assessment_date: localDate(), notes: '' });
    setForm({ ...EMPTY_ASSESSMENT });
    setQuery('');
    setResultQuery('');
    setTopicFilter('');
    let alive = true;
    async function load() {
      setLoading(true);
      setError('');
      try {
        const client = requireSupabase();
        const [assessmentResult, questionResult, papersResult, studentResult, resultResult, departmentResult] = await Promise.all([
          client.from('learning_assessments').select('*').eq('school_id', schoolId).order('updated_at', { ascending: false }),
          client.from('learning_questions').select('*').eq('school_id', schoolId).order('created_at', { ascending: false }),
          client.from('past_papers').select('id, subject_name, subject_code, year, session, paper_number, document_type, file_name, file_size, created_at').eq('school_id', schoolId).order('year', { ascending: false }),
          client.from('students').select('id, student_number, first_name, last_name, status').eq('school_id', schoolId).order('last_name').order('first_name'),
          client.from('learning_assessment_results').select('id, student_id, assessment_id, marks_obtained, maximum_marks, percentage, assessment_date, notes, status, created_at, updated_at').eq('school_id', schoolId).order('assessment_date', { ascending: false }).order('created_at', { ascending: false }),
          client.from('school_departments').select('id,name').eq('school_id', schoolId).order('name'),
        ]);
        if (assessmentResult.error) throw assessmentResult.error;
        if (questionResult.error) throw questionResult.error;
        if (papersResult.error) throw papersResult.error;
        if (studentResult.error) throw studentResult.error;
        if (resultResult.error) throw resultResult.error;
        if (departmentResult.error) throw departmentResult.error;
        let currentHodDepartmentIds: string[] = [];
        if (activeMembership?.role === 'teacher' && user?.id) {
          const { data: teacherRows, error: teacherError } = await client.from('teacher_profiles')
            .select('id').eq('school_id', schoolId).eq('profile_id', user.id);
          if (teacherError) throw teacherError;
          const teacherIds = (teacherRows ?? []).map((teacher) => teacher.id);
          if (teacherIds.length) {
            const { data: responsibilityRows, error: responsibilityError } = await client.from('teacher_responsibilities')
              .select('department_id').eq('school_id', schoolId)
              .eq('responsibility_type', 'head_of_department').in('teacher_id', teacherIds);
            if (responsibilityError) throw responsibilityError;
            currentHodDepartmentIds = (responsibilityRows ?? []).flatMap((item) => item.department_id ? [item.department_id] : []);
          }
        }
        if (alive) {
          setAssessments((assessmentResult.data ?? []) as Assessment[]);
          setQuestions((questionResult.data ?? []) as Question[]);
          setPapers((papersResult.data ?? []) as PastPaper[]);
          setStudents((studentResult.data ?? []) as StudentChoice[]);
          setResults((resultResult.data ?? []) as AssessmentResult[]);
          setDepartments((departmentResult.data ?? []) as Department[]);
          setHodDepartmentIds(currentHodDepartmentIds);
          if (currentHodDepartmentIds.length) {
            setForm((current) => current.department_id
              ? current
              : { ...current, department_id: currentHodDepartmentIds[0] });
            setQuestionForm((current) => current.department_id
              ? current
              : { ...current, department_id: currentHodDepartmentIds[0] });
          }
        }
      } catch (loadError) {
        if (alive) setError(getErrorMessage(loadError, 'Could not load the Test Maker.'));
      } finally {
        if (alive) setLoading(false);
      }
    }
    void load();
    return () => { alive = false; };
  }, [schoolId, activeMembership?.role, user?.id]);

  const selectedQuestions = useMemo(() => {
    const byId = new Map(questions.map((question) => [question.id, question]));
    return form.question_ids.map((id) => byId.get(id)).filter((question): question is Question => Boolean(question));
  }, [form.question_ids, questions]);
  const printQuestions = useMemo(() => {
    if (form.question_order === 'By topic') {
      return [...selectedQuestions].sort((left, right) => left.topic.localeCompare(right.topic));
    }
    if (form.question_order === 'Randomized') {
      const stableKey = (id: string) => [...id].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 7);
      return [...selectedQuestions].sort((left, right) => stableKey(left.id) - stableKey(right.id));
    }
    return selectedQuestions;
  }, [form.question_order, selectedQuestions]);
  const calculatedMarks = selectedQuestions.reduce((sum, question) => sum + Number(question.marks || 0), 0);
  const visibleQuestions = questions.filter((question) => {
    const text = `${question.question_text} ${question.topic} ${question.subtopic} ${question.source_name}`.toLowerCase();
    return text.includes(query.toLowerCase()) && (!topicFilter || question.topic === topicFilter);
  });
  const topics = [...new Set(questions.map((question) => question.topic).filter(Boolean))].sort();
  const resultAverage = results.length
    ? results.reduce((sum, result) => sum + Number(result.percentage), 0) / results.length
    : 0;
  const visibleResults = results.filter((result) => {
    const student = students.find((item) => item.id === result.student_id);
    const assessment = assessments.find((item) => item.id === result.assessment_id);
    const text = `${student?.first_name ?? ''} ${student?.last_name ?? ''} ${student?.student_number ?? ''} ${assessment?.title ?? ''} ${assessment?.subject ?? ''}`.toLowerCase();
    return text.includes(resultQuery.trim().toLowerCase());
  });
  const selectedResultAssessment = assessments.find((assessment) => assessment.id === resultForm.assessment_id);
  const editingResult = results.find((result) => result.id === editingResultId);
  const resultMaximumMarks = editingResult
    ? Number(editingResult.maximum_marks)
    : Number(selectedResultAssessment?.total_marks ?? 0);
  const recordableAssessments = assessments.filter((assessment) => Number(assessment.total_marks) > 0);

  function beginNewAssessment() {
    setActiveAssessmentId('');
    setForm({ ...EMPTY_ASSESSMENT, department_id: isHod ? hodDepartmentIds[0] ?? null : null });
    setView('assessments');
    setNotice('');
  }

  function editAssessment(assessment: Assessment) {
    setActiveAssessmentId(assessment.id);
    setForm(toAssessmentForm(assessment));
    setView('assessments');
    setNotice('');
  }

  function updateForm<K extends keyof AssessmentForm>(key: K, value: AssessmentForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function printDocument(mode: PrintMode) {
    setPrintMode(mode);
    window.setTimeout(() => window.print(), 0);
  }

  async function saveAssessment(event?: FormEvent) {
    event?.preventDefault();
    if (!schoolId || !user) return;
    if (!form.title.trim()) {
      setError('Add a test title before saving.');
      return;
    }
    if (isHod && (!form.department_id || !hodDepartmentIds.includes(form.department_id))) {
      setError('Choose one of your assigned departments for this assessment.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const client = requireSupabase();
      const payload = {
        ...form,
        title: form.title.trim(),
        total_marks: form.total_marks || calculatedMarks,
        school_id: schoolId,
        updated_at: new Date().toISOString(),
      };
      const result = activeAssessmentId
        ? await client.from('learning_assessments').update(payload).eq('id', activeAssessmentId).eq('school_id', schoolId).select().single()
        : await client.from('learning_assessments').insert({ ...payload, created_by: user.id }).select().single();
      if (result.error) throw result.error;
      const saved = result.data as Assessment;
      setAssessments((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setActiveAssessmentId(saved.id);
      setForm(toAssessmentForm(saved));
      await assessmentDraft.clearDraft();
      setNotice('Test saved.');
    } catch (saveError) {
      setError(getErrorMessage(saveError, 'Could not save the test.'));
    } finally {
      setSaving(false);
    }
  }

  async function duplicateAssessment(assessment: Assessment) {
    if (!schoolId || !user) return;
    setError('');
    setNotice('');
    try {
      const client = requireSupabase();
      const result = await client.from('learning_assessments').insert({
        ...toAssessmentForm(assessment),
        title: `${assessment.title} (copy)`,
        school_id: schoolId,
        created_by: user.id,
        status: 'draft',
      }).select().single();
      if (result.error) throw result.error;
      const copy = result.data as Assessment;
      setAssessments((current) => [copy, ...current]);
      editAssessment(copy);
      setNotice('A draft copy is ready to edit.');
    } catch (duplicateError) {
      setError(getErrorMessage(duplicateError, 'Could not duplicate the test.'));
    }
  }

  async function deleteAssessment(assessment: Assessment) {
    if (results.some((result) => result.assessment_id === assessment.id)) {
      setError('This test has recorded student results and cannot be deleted without losing assessment history.');
      return;
    }
    if (!schoolId || !window.confirm(`Delete “${assessment.title}”? This cannot be undone.`)) return;
    setError('');
    setNotice('');
    try {
      const { error: deleteError } = await requireSupabase().from('learning_assessments').delete().eq('id', assessment.id).eq('school_id', schoolId);
      if (deleteError) throw deleteError;
      setAssessments((current) => current.filter((item) => item.id !== assessment.id));
      if (activeAssessmentId === assessment.id) beginNewAssessment();
      setNotice('Test deleted.');
    } catch (deleteError) {
      setError(getErrorMessage(deleteError, 'Could not delete the test.'));
    }
  }

  async function saveResult(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !user) return;
    const marksObtained = Number(resultForm.marks_obtained);
    if (!resultForm.student_id || !resultForm.assessment_id || !resultForm.assessment_date) {
      setError('Select a student, test, and assessment date.');
      return;
    }
    if (!Number.isFinite(marksObtained) || marksObtained < 0 || marksObtained > resultMaximumMarks) {
      setError(`Marks must be between 0 and ${resultMaximumMarks}.`);
      return;
    }
    if (resultMaximumMarks <= 0) {
      setError('Set a total greater than zero on the test before recording results.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const client = requireSupabase();
      const commonPayload = {
        marks_obtained: marksObtained,
        assessment_date: resultForm.assessment_date,
        notes: resultForm.notes.trim(),
        updated_at: new Date().toISOString(),
      };
      const result = editingResultId
        ? await client.from('learning_assessment_results').update(commonPayload).eq('id', editingResultId).eq('school_id', schoolId).select().single()
        : await client.from('learning_assessment_results').insert({
          ...commonPayload,
          school_id: schoolId,
          created_by: user.id,
          student_id: resultForm.student_id,
          assessment_id: resultForm.assessment_id,
          maximum_marks: resultMaximumMarks,
        }).select().single();
      if (result.error) throw result.error;
      const saved = result.data as AssessmentResult;
      setResults((current) => [
        saved,
        ...current.filter((item) => item.id !== saved.id),
      ].sort((left, right) => right.assessment_date.localeCompare(left.assessment_date) || right.created_at.localeCompare(left.created_at)));
      setEditingResultId('');
      setResultForm((current) => ({ ...current, marks_obtained: '', assessment_date: localDate(), notes: '' }));
      setNotice(editingResultId ? 'Assessment result updated.' : 'Assessment result recorded.');
    } catch (saveError) {
      setError(getErrorMessage(saveError, 'Could not save the assessment result.'));
    } finally {
      setSaving(false);
    }
  }

  function editResult(result: AssessmentResult) {
    setEditingResultId(result.id);
    setResultForm({
      student_id: result.student_id,
      assessment_id: result.assessment_id,
      marks_obtained: String(result.marks_obtained),
      assessment_date: result.assessment_date,
      notes: result.notes,
    });
    setError('');
    setNotice('');
  }

  function cancelResultEdit() {
    setEditingResultId('');
    setResultForm((current) => ({ ...current, marks_obtained: '', assessment_date: localDate(), notes: '' }));
  }

  async function deleteResult(result: AssessmentResult) {
    if (!schoolId || !window.confirm('Delete this recorded result? This cannot be undone.')) return;
    setError('');
    setNotice('');
    try {
      const { error: deleteError } = await requireSupabase().from('learning_assessment_results').delete().eq('id', result.id).eq('school_id', schoolId);
      if (deleteError) throw deleteError;
      setResults((current) => current.filter((item) => item.id !== result.id));
      if (editingResultId === result.id) cancelResultEdit();
      setNotice('Assessment result deleted.');
    } catch (deleteError) {
      setError(getErrorMessage(deleteError, 'Could not delete the assessment result.'));
    }
  }

  function toggleQuestion(questionId: string) {
    setForm((current) => ({
      ...current,
      question_ids: current.question_ids.includes(questionId)
        ? current.question_ids.filter((id) => id !== questionId)
        : [...current.question_ids, questionId],
    }));
  }

  async function saveQuestion(event: FormEvent) {
    event.preventDefault();
    if (!schoolId || !user) return;
    if (!questionForm.question_text.trim() || !questionForm.topic.trim()) {
      setError('Enter the question text and topic.');
      return;
    }
    if (isHod && (!questionForm.department_id || !hodDepartmentIds.includes(questionForm.department_id))) {
      setError('Choose one of your assigned departments for this question.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const client = requireSupabase();
      const payload = {
        ...questionForm,
        question_text: questionForm.question_text.trim(),
        topic: questionForm.topic.trim(),
        subtopic: questionForm.subtopic.trim(),
        source_name: questionForm.source_name.trim() || 'Teacher-created',
        school_id: schoolId,
        updated_at: new Date().toISOString(),
      };
      const result = editingQuestionId
        ? await client.from('learning_questions').update(payload).eq('id', editingQuestionId).eq('school_id', schoolId).select().single()
        : await client.from('learning_questions').insert({ ...payload, created_by: user.id }).select().single();
      if (result.error) throw result.error;
      const saved = result.data as Question;
      setQuestions((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setQuestionForm({ ...EMPTY_QUESTION, department_id: isHod ? hodDepartmentIds[0] ?? null : null });
      setEditingQuestionId('');
      setNotice('Question saved to the library.');
    } catch (saveError) {
      setError(getErrorMessage(saveError, 'Could not save the question.'));
    } finally {
      setSaving(false);
    }
  }

  function editQuestion(question: Question) {
    const { id, ...details } = question;
    setEditingQuestionId(id);
    setQuestionForm(details);
  }

  async function deleteQuestion(question: Question) {
    if (!schoolId) return;
    if (assessments.some((assessment) => assessment.question_ids.includes(question.id))) {
      setError('Remove this question from saved tests before deleting it from the library.');
      return;
    }
    if (!window.confirm('Remove this question from the library?')) return;
    setError('');
    setNotice('');
    try {
      const { error: deleteError } = await requireSupabase().from('learning_questions').delete().eq('id', question.id).eq('school_id', schoolId);
      if (deleteError) throw deleteError;
      setQuestions((current) => current.filter((item) => item.id !== question.id));
      setForm((current) => ({ ...current, question_ids: current.question_ids.filter((id) => id !== question.id) }));
      setNotice('Question removed.');
    } catch (deleteError) {
      setError(getErrorMessage(deleteError, 'Could not remove the question.'));
    }
  }

  async function importQuestionFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!schoolId || !user) return;
    setError('');
    setNotice('');
    try {
      const raw = await file.text();
      let imported: Partial<QuestionForm>[];
      if (file.name.toLowerCase().endsWith('.json')) {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('JSON imports must be an array of question objects.');
        imported = parsed as Partial<QuestionForm>[];
      } else {
        const [headerRow, ...dataRows] = parseCsvRows(raw);
        const headers = (headerRow ?? []).map((header) => header.toLowerCase());
        imported = dataRows.map((values) => {
          return Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ''])) as Partial<QuestionForm>;
        });
      }
      const rows = imported.map((item) => ({
        department_id: isHod ? (form.department_id ?? hodDepartmentIds[0] ?? null) : null,
        question_text: String(item.question_text ?? '').trim(),
        topic: String(item.topic ?? '').trim(),
        subtopic: String(item.subtopic ?? '').trim(),
        marks: Math.max(1, Number(item.marks) || 1),
        difficulty: String(item.difficulty ?? EMPTY_QUESTION.difficulty),
        source_name: String(item.source_name ?? file.name).trim() || file.name,
        source_url: String(item.source_url ?? '').trim(),
        mark_scheme: String(item.mark_scheme ?? '').trim(),
        school_id: schoolId,
        created_by: user.id,
      })).filter((item) => item.question_text && item.topic);
      if (!rows.length) throw new Error('No valid rows found. Include question_text and topic columns.');
      const { data, error: importError } = await requireSupabase().from('learning_questions').insert(rows).select();
      if (importError) throw importError;
      setQuestions((current) => [...((data ?? []) as Question[]), ...current]);
      setNotice(`Imported ${rows.length} question${rows.length === 1 ? '' : 's'} from ${file.name}.`);
    } catch (importError) {
      setError(getErrorMessage(importError, 'Could not import this question file.'));
    } finally {
      event.target.value = '';
    }
  }

  const qualificationOptions = form.curriculum === 'Cambridge' ? QUALIFICATIONS.slice(0, -1) : ['Custom qualification'];

  return (
    <div className="page-stack test-maker-page">
      <div className="page-heading">
        <div><span className="eyebrow">{activeMembership?.school.name}</span><h1>Learning</h1><p>Create tests, record marks, and review student assessment histories.</p></div>
        <button className="button button-primary" onClick={beginNewAssessment}><Plus size={15} /> New test</button>
      </div>

      <section className="test-maker-banner">
        <div className="test-maker-banner-icon"><BookOpenCheck size={20} /></div>
        <div><strong>Test Maker &amp; Results</strong><p>Create assessments, record student marks, and review each learner’s assessment history.</p></div>
        <a className="button button-quiet test-maker-external" href={CAMBRIDGE_PAST_PAPERS_URL} target="_blank" rel="noreferrer">
          Official Cambridge papers <ExternalLink size={14} />
        </a>
      </section>

      {error && <ErrorState message={error} />}
      {notice && <div className="feedback feedback-success" role="status"><Check size={15} />{notice}</div>}

      <div className="test-maker-tabs" role="tablist" aria-label="Test Maker">
        <button className={view === 'assessments' ? 'active' : ''} onClick={() => setView('assessments')} role="tab" aria-selected={view === 'assessments'}><FileText size={15} /> Tests <span>{assessments.length}</span></button>
        <button className={view === 'results' ? 'active' : ''} onClick={() => setView('results')} role="tab" aria-selected={view === 'results'}><ClipboardCheck size={15} /> Results <span>{results.length}</span></button>
        <button className={view === 'library' ? 'active' : ''} onClick={() => setView('library')} role="tab" aria-selected={view === 'library'}><Library size={15} /> Question library <span>{questions.length}</span></button>
        <button className={view === 'papers' ? 'active' : ''} onClick={() => setView('papers')} role="tab" aria-selected={view === 'papers'}><BookOpenCheck size={15} /> Past papers <span>{papers.length}</span></button>
      </div>

      {loading ? <LoadingState label="Loading tests, students, results, questions, and past papers…" /> : view === 'assessments' ? (
        <div className="test-maker-layout">
          <section className="content-card test-list-card">
            <div className="section-heading"><div><span className="eyebrow">Your workspace</span><h2>Saved tests</h2></div><span className="test-count">{assessments.length}</span></div>
            {assessments.length ? <div className="test-list">
              {assessments.map((assessment) => <article className={`test-list-item${activeAssessmentId === assessment.id ? ' selected' : ''}`} key={assessment.id}>
                <button className="test-list-select" onClick={() => editAssessment(assessment)}><strong>{assessment.title}</strong><span>{assessment.subject || 'No subject'} · {assessment.qualification}</span><small>{assessment.question_ids.length} questions · {assessment.total_marks} marks · {assessment.status}</small></button>
                <div className="test-list-actions">
                  <button className="icon-button" title="Edit test" aria-label={`Edit ${assessment.title}`} onClick={() => editAssessment(assessment)}><Pencil size={14} /></button>
                  <button className="icon-button" title="Duplicate test" aria-label={`Duplicate ${assessment.title}`} onClick={() => void duplicateAssessment(assessment)}><Copy size={14} /></button>
                  <button className="icon-button danger-icon" title="Delete test" aria-label={`Delete ${assessment.title}`} onClick={() => void deleteAssessment(assessment)}><Trash2 size={14} /></button>
                </div>
              </article>)}
            </div> : <div className="test-empty"><span><FilePlus2 size={20} /></span><strong>No tests yet</strong><p>Create a test to start assembling a paper. Your drafts are saved to this school.</p><button className="button button-quiet" onClick={beginNewAssessment}><Plus size={14} /> Create your first test</button></div>}
            <div className="source-note"><strong>Authorized resources only</strong><p>Add questions you have permission to use, including teacher-written items or licensed school resources. Official Cambridge papers open in a new tab.</p></div>
          </section>

          <section className="content-card test-editor-card">
            <form onSubmit={(event) => void saveAssessment(event)}>
                <DraftRecoveryControls entity="assessment" draft={assessmentDraft} onRestore={restoreAssessmentDraft} />
              <div className="section-heading"><div><span className="eyebrow">{activeAssessmentId ? 'Edit assessment' : 'New assessment'}</span><h2>{form.title || 'Untitled test'}</h2></div>
                <div className="editor-heading-actions"><button type="button" className="button button-quiet" disabled={!form.title.trim()} onClick={() => printDocument('paper')}><Printer size={14} /> Paper / PDF</button><button type="button" className="button button-quiet" disabled={!form.title.trim()} onClick={() => printDocument('answer-sheet')}><FileText size={14} /> Answer sheet</button><button className="button button-primary" disabled={saving}><Save size={14} />{saving ? 'Saving…' : 'Save test'}</button></div>
              </div>

              <div className="test-form-section">
                <h3>Test details</h3>
                <div className="test-form-grid">
                  <label className="span-2">Test title<input required value={form.title} onChange={(event) => updateForm('title', event.target.value)} placeholder="e.g. Biology: Cell structure" /></label>
                  <label>Curriculum<select value={form.curriculum} onChange={(event) => {
                    const curriculum = event.target.value;
                    updateForm('curriculum', curriculum);
                    updateForm('qualification', curriculum === 'Cambridge' ? 'Cambridge IGCSE' : 'Custom qualification');
                  }}><option>Cambridge</option><option>Custom curriculum</option></select></label>
                  <label>Qualification<select value={form.qualification} onChange={(event) => updateForm('qualification', event.target.value)}>{qualificationOptions.map((qualification) => <option key={qualification}>{qualification}</option>)}</select></label>
                  {(isAcademicLead || isHod) && <label>Department<select value={form.department_id ?? ''} onChange={(event) => updateForm('department_id', event.target.value || null)}><option value="">Not department-assigned</option>{availableDepartments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label>}
                  <label>Subject<input value={form.subject} onChange={(event) => updateForm('subject', event.target.value)} placeholder="e.g. Biology" /></label>
                  <label>Syllabus code<input value={form.syllabus_code} onChange={(event) => updateForm('syllabus_code', event.target.value)} placeholder="Optional" /></label>
                  <label>Topic<input value={form.topic} onChange={(event) => updateForm('topic', event.target.value)} placeholder="e.g. Cells" /></label>
                  <label>Subtopic<input value={form.subtopic} onChange={(event) => updateForm('subtopic', event.target.value)} placeholder="Optional" /></label>
                </div>
              </div>

              <div className="test-form-section">
                <h3>Test configuration</h3>
                <div className="test-form-grid">
                  <label>Duration (minutes)<input type="number" min="1" value={form.duration_minutes} onChange={(event) => updateForm('duration_minutes', Number(event.target.value))} /></label>
                  <label>Total marks<input type="number" min="0" value={form.total_marks} onChange={(event) => updateForm('total_marks', Number(event.target.value))} /></label>
                  <label>Difficulty<select value={form.difficulty} onChange={(event) => updateForm('difficulty', event.target.value as Difficulty)}>{['Foundation', 'Standard', 'Challenging', 'Mixed'].map((level) => <option key={level}>{level}</option>)}</select></label>
                  <label>Question order<select value={form.question_order} onChange={(event) => updateForm('question_order', event.target.value)}><option>As selected</option><option>By topic</option><option>Randomized</option></select></label>
                  <label className="span-2">Instructions<textarea value={form.instructions} onChange={(event) => updateForm('instructions', event.target.value)} rows={2} /></label>
                  <label className="span-2">Permitted resources<input value={form.permitted_resources} onChange={(event) => updateForm('permitted_resources', event.target.value)} placeholder="e.g. Scientific calculator, ruler" /></label>
                  <label className="span-2">Overall marking guidance<textarea value={form.mark_scheme} onChange={(event) => updateForm('mark_scheme', event.target.value)} rows={2} placeholder="Optional teacher-defined marking criteria" /></label>
                  <label>Status<select value={form.status} onChange={(event) => updateForm('status', event.target.value as AssessmentStatus)}><option value="draft">Draft</option><option value="ready">Ready</option></select></label>
                </div>
              </div>

              <div className="test-form-section test-question-section">
                <div className="section-heading"><div><h3>Assemble questions</h3><p>{selectedQuestions.length} selected · {calculatedMarks} marks from questions</p></div><button type="button" className="text-action" onClick={() => setView('library')}><Library size={14} /> Manage library</button></div>
                {selectedQuestions.length ? <div className="selected-question-list">{selectedQuestions.map((question, index) => <article key={question.id}><div><span className="question-number">{index + 1}</span><p>{question.question_text}</p><small>{question.topic}{question.subtopic ? ` · ${question.subtopic}` : ''}</small></div><strong>{question.marks} marks</strong><button type="button" className="icon-button" onClick={() => toggleQuestion(question.id)} aria-label="Remove question"><X size={15} /></button></article>)}</div> : <p className="test-inline-empty">No questions selected. Add questions from your school library.</p>}
                {questions.length > 0 && <div className="quick-question-picker"><label><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a question to add…" /></label><div>{visibleQuestions.slice(0, 5).map((question) => <button type="button" key={question.id} disabled={form.question_ids.includes(question.id)} onClick={() => toggleQuestion(question.id)}><Plus size={13} />{question.question_text.slice(0, 76)}{question.question_text.length > 76 ? '…' : ''}<span>{question.marks}m</span></button>)}</div></div>}
              </div>
              <div className="test-editor-footer"><span>Questions currently add up to <strong>{calculatedMarks}</strong> marks.</span><button type="button" className="text-action" onClick={() => setIncludeMarkScheme((current) => !current)}><Check size={14} />{includeMarkScheme ? 'Mark scheme included in print' : 'Add mark scheme to print'}</button></div>
            </form>
          </section>
        </div>
      ) : view === 'results' ? (
        <div className="assessment-results-layout">
          <section className="content-card result-entry-card">
            <div className="section-heading"><div><span className="eyebrow">{editingResultId ? 'Correct a recorded mark' : 'Record an assessment'}</span><h2>{editingResultId ? 'Edit result' : 'Enter student marks'}</h2></div></div>
            <form className="result-entry-form" onSubmit={(event) => void saveResult(event)}>
              <label>Student<select required value={resultForm.student_id} disabled={Boolean(editingResultId)} onChange={(event) => setResultForm((current) => ({ ...current, student_id: event.target.value }))}><option value="">Choose a student</option>{students.filter((student) => student.status === 'active' || student.id === resultForm.student_id).map((student) => <option key={student.id} value={student.id}>{student.last_name}, {student.first_name} · {student.student_number}</option>)}</select></label>
              <label>Test<select required value={resultForm.assessment_id} disabled={Boolean(editingResultId)} onChange={(event) => setResultForm((current) => ({ ...current, assessment_id: event.target.value, marks_obtained: '' }))}><option value="">Choose a test</option>{recordableAssessments.map((assessment) => <option key={assessment.id} value={assessment.id}>{assessment.title} · {assessment.total_marks} marks</option>)}{editingResult && !recordableAssessments.some((assessment) => assessment.id === editingResult.assessment_id) && <option value={editingResult.assessment_id}>{assessments.find((assessment) => assessment.id === editingResult.assessment_id)?.title ?? 'Saved test'} · {editingResult.maximum_marks} marks</option>}</select></label>
              <div className="result-entry-fields">
                <label>Marks earned<input required type="number" min="0" max={resultMaximumMarks || undefined} step="0.01" value={resultForm.marks_obtained} onChange={(event) => setResultForm((current) => ({ ...current, marks_obtained: event.target.value }))} placeholder="0" /></label>
                <label>Out of<input readOnly value={resultMaximumMarks || ''} aria-label="Maximum marks for selected test" placeholder="Select a test" /></label>
              </div>
              <label>Assessment date<input required type="date" value={resultForm.assessment_date} onChange={(event) => setResultForm((current) => ({ ...current, assessment_date: event.target.value }))} /></label>
              <label>Notes (optional)<textarea rows={3} value={resultForm.notes} onChange={(event) => setResultForm((current) => ({ ...current, notes: event.target.value }))} placeholder="Feedback or marking notes" /></label>
              {!recordableAssessments.length && !editingResult && <p className="result-form-hint">Save a test with a total greater than zero to start recording results.</p>}
              <div className="test-form-actions"><button className="button button-primary" disabled={saving || (!editingResultId && !recordableAssessments.length)}><Save size={14} />{saving ? 'Saving…' : editingResultId ? 'Update result' : 'Record result'}</button>{editingResultId && <button type="button" className="button button-quiet" onClick={cancelResultEdit}>Cancel</button>}</div>
            </form>
          </section>

          <section className="content-card result-history-card">
            <div className="section-heading"><div><span className="eyebrow">Student assessment histories</span><h2>Recorded results</h2></div><span className="test-count">{results.length}</span></div>
            <div className="result-summary"><span><strong>{results.length}</strong> attempts recorded</span><span><strong>{new Set(results.map((result) => result.student_id)).size}</strong> students</span><span><strong>{results.length ? `${resultAverage.toFixed(1)}%` : '—'}</strong> average</span></div>
            <label className="library-search result-history-search"><Search size={15} /><input value={resultQuery} onChange={(event) => setResultQuery(event.target.value)} placeholder="Find a student or test" /></label>
            {visibleResults.length ? <div className="result-history-list">
              {visibleResults.map((result) => {
                const student = students.find((item) => item.id === result.student_id);
                const assessment = assessments.find((item) => item.id === result.assessment_id);
                return <article className={`result-history-item${editingResultId === result.id ? ' selected' : ''}`} key={result.id}>
                  <div className="result-history-main"><span className="result-history-date">{new Date(`${result.assessment_date}T00:00:00`).toLocaleDateString()} · {result.status}</span><strong>{student ? `${student.first_name} ${student.last_name}` : 'Student record unavailable'}</strong><span>{assessment?.title ?? 'Saved test'}{assessment?.subject ? ` · ${assessment.subject}` : ''}</span>{result.notes && <small>{result.notes}</small>}</div>
                  <div className="result-history-score"><strong>{result.marks_obtained} <span>/ {result.maximum_marks}</span></strong><small>{Number(result.percentage).toFixed(1)}%</small></div>
                  {result.status === 'draft' && <div className="result-history-actions"><button className="icon-button" title="Edit draft result" aria-label="Edit draft result" onClick={() => editResult(result)}><Pencil size={14} /></button><button className="icon-button danger-icon" title="Delete draft result" aria-label="Delete draft result" onClick={() => void deleteResult(result)}><Trash2 size={14} /></button></div>}
                </article>;
              })}
            </div> : <div className="test-empty"><span><History size={20} /></span><strong>{results.length ? 'No matching results' : 'No results recorded yet'}</strong><p>{results.length ? 'Try another student name, number, or test title.' : 'Record a student’s marks above to start building their assessment history.'}</p></div>}
          </section>
        </div>
      ) : view === 'library' ? (
        <div className="question-library-layout">
          <section className="content-card library-card">
            <div className="section-heading"><div><span className="eyebrow">School resources</span><h2>Question library</h2></div><span className="test-count">{questions.length}</span></div>
            <div className="library-toolbar">
              <label className="library-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search question, topic, or source" /></label>
              <label className="library-topic-filter"><Filter size={14} /><select value={topicFilter} onChange={(event) => setTopicFilter(event.target.value)}><option value="">All topics</option>{topics.map((topic) => <option key={topic}>{topic}</option>)}</select></label>
              <label className="button button-quiet upload-question-button"><FilePlus2 size={14} /> Import CSV / JSON<input type="file" accept=".csv,.json,text/csv,application/json" onChange={(event) => void importQuestionFile(event)} /></label>
            </div>
            <p className="import-hint">CSV headers: <code>question_text,topic,subtopic,marks,difficulty,source_name,source_url,mark_scheme</code>. JSON imports use the same field names as an array of objects.</p>
            <div className="question-library-list">
              {visibleQuestions.map((question) => <article className="library-question" key={question.id}>
                <div className="library-question-main">                <div className="library-question-meta"><span>{question.topic}{question.subtopic ? ` · ${question.subtopic}` : ''}</span>{question.department_id && <span>{departments.find((department) => department.id === question.department_id)?.name ?? 'Department'}</span>}<span>{question.marks} marks</span><span>{question.difficulty}</span></div><p>{question.question_text}</p><small>{question.source_name}{question.source_url && <> · <a href={question.source_url} target="_blank" rel="noreferrer">Source <ExternalLink size={10} /></a></>}</small></div>
                <div className="library-question-actions"><button className="icon-button" title="Edit question" aria-label="Edit question" onClick={() => editQuestion(question)}><Pencil size={14} /></button><button className="icon-button danger-icon" title="Delete question" aria-label="Delete question" onClick={() => void deleteQuestion(question)}><Trash2 size={14} /></button><button className="button button-quiet" onClick={() => { toggleQuestion(question.id); setView('assessments'); }}><Plus size={13} /> Add to test</button></div>
              </article>)}
              {!visibleQuestions.length && <div className="test-empty"><span><Library size={20} /></span><strong>{questions.length ? 'No matching questions' : 'Your library is empty'}</strong><p>Add teacher-created items or import questions your school is authorized to use.</p></div>}
            </div>
          </section>
          <section className="content-card question-form-card">
            <div className="section-heading"><div><span className="eyebrow">{editingQuestionId ? 'Update library item' : 'Create library item'}</span><h2>{editingQuestionId ? 'Edit question' : 'Add a question'}</h2></div></div>
            <form className="test-question-form" onSubmit={(event) => void saveQuestion(event)}>
              <label>Question text<textarea required rows={5} value={questionForm.question_text} onChange={(event) => setQuestionForm((current) => ({ ...current, question_text: event.target.value }))} placeholder="Enter the question exactly as it should appear on the test." /></label>
              <div className="test-form-grid">
                {(isAcademicLead || isHod) && <label>Department<select value={questionForm.department_id ?? ''} onChange={(event) => setQuestionForm((current) => ({ ...current, department_id: event.target.value || null }))}><option value="">Not department-assigned</option>{availableDepartments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label>}
                <label>Topic<input required value={questionForm.topic} onChange={(event) => setQuestionForm((current) => ({ ...current, topic: event.target.value }))} /></label>
                <label>Subtopic<input value={questionForm.subtopic} onChange={(event) => setQuestionForm((current) => ({ ...current, subtopic: event.target.value }))} /></label>
                <label>Marks<input type="number" min="1" value={questionForm.marks} onChange={(event) => setQuestionForm((current) => ({ ...current, marks: Number(event.target.value) }))} /></label>
                <label>Difficulty<select value={questionForm.difficulty} onChange={(event) => setQuestionForm((current) => ({ ...current, difficulty: event.target.value }))}>{['Foundation', 'Standard', 'Challenging'].map((level) => <option key={level}>{level}</option>)}</select></label>
                <label className="span-2">Source / authorization reference<input value={questionForm.source_name} onChange={(event) => setQuestionForm((current) => ({ ...current, source_name: event.target.value }))} placeholder="Teacher-created, licensed collection, paper reference…" /></label>
                <label className="span-2">Source link (optional)<input type="url" value={questionForm.source_url} onChange={(event) => setQuestionForm((current) => ({ ...current, source_url: event.target.value }))} placeholder="https://" /></label>
                <label className="span-2">Answer / mark scheme<textarea rows={3} value={questionForm.mark_scheme} onChange={(event) => setQuestionForm((current) => ({ ...current, mark_scheme: event.target.value }))} placeholder="Teacher-defined answer or authorized mark scheme notes" /></label>
              </div>
              <div className="test-form-actions"><button className="button button-primary" disabled={saving}><Save size={14} />{saving ? 'Saving…' : editingQuestionId ? 'Update question' : 'Save question'}</button>{editingQuestionId && <button type="button" className="button button-quiet" onClick={() => { setEditingQuestionId(''); setQuestionForm({ ...EMPTY_QUESTION }); }}>Cancel edit</button>}</div>
            </form>
          </section>
        </div>
      ) : (
        <section className="content-card authorized-papers-card">
          <div className="section-heading"><div><span className="eyebrow">School resources</span><h2>Authorized past papers</h2></div><span className="test-count">{papers.length}</span></div>
          <div className="authorized-papers-notice"><strong>Privately stored in Firebase</strong><p>These records are visible to this school only. Paper files are not publicly exposed; authenticated PDF viewing will be available when a signed-link endpoint is configured.</p></div>
          <label className="library-search authorized-paper-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search subject, code, year, or paper type" /></label>
          <div className="authorized-paper-list">
            {papers.filter((paper) => `${paper.subject_name} ${paper.subject_code} ${paper.year} ${paper.paper_number} ${paper.document_type}`.toLowerCase().includes(query.toLowerCase())).map((paper) => (
              <article className="authorized-paper-item" key={paper.id}>
                <div><strong>{paper.subject_name} <span>{paper.subject_code}</span></strong><p>{paper.year} · {paper.session === 'm' ? 'March' : paper.session === 's' ? 'June' : 'November'} · Paper {paper.paper_number}</p><small>{paper.document_type === 'qp' ? 'Question paper' : paper.document_type === 'ms' ? 'Mark scheme' : paper.document_type === 'er' ? 'Examiner report' : 'Specimen'} · {(paper.file_size / (1024 * 1024)).toFixed(1)} MB</small></div>
                <time dateTime={paper.created_at}>{new Date(paper.created_at).toLocaleDateString()}</time>
              </article>
            ))}
            {!papers.length && <div className="test-empty"><span><BookOpenCheck size={20} /></span><strong>No past papers imported</strong><p>Authorized imports can be run from GitHub Actions using the documented workflow.</p></div>}
            {papers.length > 0 && !papers.some((paper) => `${paper.subject_name} ${paper.subject_code} ${paper.year} ${paper.paper_number} ${paper.document_type}`.toLowerCase().includes(query.toLowerCase())) && <p className="test-inline-empty">No past papers match this search.</p>}
          </div>
        </section>
      )}

      <section className={`print-assessment${printMode === 'answer-sheet' ? ' answer-sheet-only' : ''}`}>
        <header><span>{form.curriculum} · {form.qualification}</span><h1>{form.title || 'Untitled test'}</h1><p>{form.subject}{form.syllabus_code ? ` · Syllabus ${form.syllabus_code}` : ''}{form.topic ? ` · ${form.topic}` : ''}</p></header>
        <div className="print-test-meta"><span>Time allowed: {form.duration_minutes} minutes</span><span>Total marks: {form.total_marks || calculatedMarks}</span></div>
        {form.instructions && <p className="print-instructions"><strong>Instructions</strong><br />{form.instructions}</p>}
        {form.permitted_resources && <p><strong>Permitted resources:</strong> {form.permitted_resources}</p>}
        {printQuestions.map((question, index) => <article className="print-question" key={question.id}><div className="print-question-title"><strong>{index + 1}.</strong><span>{question.question_text}</span><strong>[{question.marks}]</strong></div>{printMode === 'paper' && includeMarkScheme && question.mark_scheme && <p className="print-mark-scheme"><strong>Mark scheme:</strong> {question.mark_scheme}</p>}<div className="print-answer-lines" /></article>)}
        {printMode === 'paper' && includeMarkScheme && form.mark_scheme && <p className="print-mark-scheme"><strong>Overall marking guidance:</strong> {form.mark_scheme}</p>}
      </section>
    </div>
  );
}
