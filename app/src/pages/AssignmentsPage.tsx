import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { BookOpen, CalendarClock, Check, ClipboardList, Download, FileText, Plus, Send, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/Feedback';
import { PrerequisiteFieldNotice } from '../components/PrerequisiteFieldNotice';
import { PrerequisiteQuickCreate } from '../components/PrerequisiteQuickCreate';
import { useAuth } from '../contexts/AuthContext';
import { getPrerequisiteRule, resolvePrerequisiteAvailability } from '../lib/prerequisite-rules';
import { type PrerequisiteEntity, type PrerequisiteRecord } from '../lib/prerequisite-records';
import { requireSupabase } from '../lib/supabase';

type AssignmentStatus = 'draft' | 'published' | 'archived';
type SubmissionStatus = 'submitted' | 'late' | 'graded' | 'returned';
type Assignment = {
  id: string;
  school_id: string;
  class_id: string;
  subject_id: string;
  teacher_id: string;
  title: string;
  description: string | null;
  due_at: string | null;
  max_marks: number | null;
  status: AssignmentStatus;
  attached_material_id: string | null;
  created_at: string;
};
type Submission = {
  id: string;
  school_id: string;
  assignment_id: string;
  student_id: string;
  submitted_at: string | null;
  storage_path: string | null;
  text_response: string | null;
  status: SubmissionStatus;
  marks: number | null;
  feedback: string | null;
};
type SchoolClass = { id: string; name: string };
type Subject = { id: string; name: string };
type Student = { id: string; first_name: string; last_name: string; student_number: string; class_id: string | null };
type Material = {
  id: string;
  title: string;
  class_id: string;
  storage_path: string;
  storage_provider: 'r2' | 'supabase';
  mime_type: string | null;
  file_name: string | null;
  is_uploaded: boolean;
  is_published: boolean;
};
type Teacher = { id: string; profile_id?: string | null; first_name: string; last_name: string; status: string };
type TeacherClassAssignment = { teacher_id: string; class_id: string };
type ClassSubject = { class_id: string; subject_id: string };
type AssignmentForm = {
  title: string;
  class_id: string;
  subject_id: string;
  description: string;
  due_at: string;
  max_marks: string;
  attached_material_id: string;
  teacher_id: string;
};

const emptyForm: AssignmentForm = {
  title: '',
  class_id: '',
  subject_id: '',
  description: '',
  due_at: '',
  max_marks: '',
  attached_material_id: '',
  teacher_id: '',
};
const MAX_SUBMISSION_SIZE = 50 * 1024 * 1024;
const submissionTypes = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function dateTimeLocal(value: string | null) {
  if (!value) return 'No deadline';
  return new Date(value).toLocaleString();
}

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'submission';
}

export function AssignmentsPage() {
  const { activeMembership, user } = useAuth();
  const schoolId = activeMembership?.school_id;
  const role = activeMembership?.role;
  const isStudent = role === 'student';
  const canManage = role === 'school_admin' || role === 'academic_coordinator' || role === 'teacher';
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [student, setStudent] = useState<Student | null>(null);
  const [teacherId, setTeacherId] = useState('');
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [classTeacherIds, setClassTeacherIds] = useState<Map<string, Set<string>>>(new Map());
  const [classSubjects, setClassSubjects] = useState<ClassSubject[]>([]);
  const [teacherClasses, setTeacherClasses] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [quickCreateEntity, setQuickCreateEntity] = useState<PrerequisiteEntity | null>(null);
  const [form, setForm] = useState<AssignmentForm>(emptyForm);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    if (!schoolId || !user) return;
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [assignmentResult, submissionResult, classResult, subjectResult, studentResult, materialResult, teacherResult, teacherClassResult, classSubjectResult] = await Promise.all([
        client.from('assignments')
          .select('id,school_id,class_id,subject_id,teacher_id,title,description,due_at,max_marks,status,attached_material_id,created_at')
          .eq('school_id', schoolId).order('due_at', { ascending: true, nullsFirst: false }),
        client.from('assignment_submissions')
          .select('id,school_id,assignment_id,student_id,submitted_at,storage_path,text_response,status,marks,feedback')
          .eq('school_id', schoolId).order('submitted_at', { ascending: false }),
        client.from('school_classes').select('id,name').eq('school_id', schoolId).order('name'),
        client.from('subjects').select('id,name').eq('school_id', schoolId).order('name'),
        isStudent
          ? client.from('students').select('id,first_name,last_name,student_number,class_id').eq('school_id', schoolId).eq('profile_id', user.id)
          : client.from('students').select('id,first_name,last_name,student_number,class_id').eq('school_id', schoolId),
        client.from('learning_materials').select('id,title,class_id,storage_path,storage_provider,mime_type,file_name,is_uploaded,is_published')
          .eq('school_id', schoolId).eq('is_uploaded', true).eq('is_published', true).order('title'),
        canManage
          ? client.from('teacher_profiles').select('id,profile_id,first_name,last_name,status').eq('school_id', schoolId).order('last_name')
          : Promise.resolve({ data: [] as Teacher[], error: null }),
        canManage
          ? client.from('teacher_class_assignments').select('teacher_id,class_id').eq('school_id', schoolId)
          : Promise.resolve({ data: [] as TeacherClassAssignment[], error: null }),
        client.from('class_subjects').select('class_id,subject_id').eq('school_id', schoolId),
      ]);
      const failed = [assignmentResult, submissionResult, classResult, subjectResult, studentResult, materialResult, teacherResult, teacherClassResult, classSubjectResult].find((result) => result.error)?.error;
      if (failed) throw failed;

      const teacherRecords = (teacherResult.data ?? []) as Teacher[];
      const teachingAssignments = (teacherClassResult.data ?? []) as TeacherClassAssignment[];
      const assignedTeachersByClass = new Map<string, Set<string>>();
      for (const assignment of teachingAssignments) {
        const ids = assignedTeachersByClass.get(assignment.class_id) ?? new Set<string>();
        ids.add(assignment.teacher_id);
        assignedTeachersByClass.set(assignment.class_id, ids);
      }
      let currentTeacherId = '';
      let assignedClassIds = new Set<string>();
      if (role === 'teacher') {
        const teacherIds = teacherRecords.filter((record) => record.profile_id === user.id).map((record) => record.id);
        currentTeacherId = teacherIds[0] ?? '';
        if (teacherIds.length) {
          const { data: classAssignments, error: classAssignmentError } = await client.from('teacher_class_assignments')
            .select('class_id').eq('school_id', schoolId).in('teacher_id', teacherIds);
          if (classAssignmentError) throw classAssignmentError;
          assignedClassIds = new Set((classAssignments ?? []).map((assignment) => assignment.class_id));
        }
      }

      const studentRecords = (studentResult.data ?? []) as Student[];
      const currentStudent = isStudent ? studentRecords[0] ?? null : null;
      if (isStudent && !currentStudent) {
        throw new Error('Your student profile is not linked to this account. Ask the school administrator to link it before submitting assignments.');
      }
      const visibleClasses = (classResult.data ?? []) as SchoolClass[];
      setAssignments((assignmentResult.data ?? []) as unknown as Assignment[]);
      setSubmissions((submissionResult.data ?? []) as Submission[]);
      setClasses(role === 'teacher' ? visibleClasses.filter((item) => assignedClassIds.has(item.id)) : visibleClasses);
      setSubjects((subjectResult.data ?? []) as Subject[]);
      setStudents(studentRecords);
      setStudent(currentStudent);
      setTeacherId(currentTeacherId);
      setTeachers(teacherRecords);
      setClassTeacherIds(assignedTeachersByClass);
      setClassSubjects((classSubjectResult.data ?? []) as ClassSubject[]);
      setTeacherClasses(assignedClassIds);
      setMaterials((materialResult.data ?? []) as Material[]);
    } catch (loadError) {
      setError(errorMessage(loadError, 'Could not load assignments.'));
    } finally {
      setLoading(false);
    }
  }, [schoolId, user, role, isStudent, refreshKey]);

  useEffect(() => { void load(); }, [load]);

  const classNames = useMemo(() => new Map(classes.map((item) => [item.id, item.name])), [classes]);
  const subjectNames = useMemo(() => new Map(subjects.map((item) => [item.id, item.name])), [subjects]);
  const studentNames = useMemo(() => new Map(students.map((item) => [item.id, `${item.first_name} ${item.last_name}`])), [students]);
  const visibleAssignments = isStudent
    ? assignments.filter((assignment) => assignment.status === 'published' && assignment.class_id === student?.class_id)
    : assignments.filter((assignment) => role !== 'teacher' || teacherClasses.has(assignment.class_id) || assignment.teacher_id === teacherId);
  const activeTeachers = teachers.filter((item) => item.status === 'active');
  const subjectsForFormClass = (() => {
    const assignedSubjects = classSubjects.filter((item) => item.class_id === form.class_id);
    return assignedSubjects.length
      ? subjects.filter((subject) => assignedSubjects.some((item) => item.subject_id === subject.id))
      : subjects;
  })();
  const teachersForFormClass = activeTeachers.filter((item) => classTeacherIds.get(form.class_id)?.has(item.id));
  const classAvailability = resolvePrerequisiteAvailability({
    loading,
    error,
    totalRecords: classes.length,
    selectableRecords: classes.length,
  });
  const subjectAvailability = resolvePrerequisiteAvailability({
    loading,
    error,
    totalRecords: subjects.length,
    selectableRecords: subjectsForFormClass.length,
    filteredRecords: Math.max(0, subjects.length - subjectsForFormClass.length),
  });
  const teacherAvailability = resolvePrerequisiteAvailability({
    loading,
    error,
    totalRecords: teachers.length,
    selectableRecords: teachersForFormClass.length,
    inactiveRecords: teachers.length > 0 && activeTeachers.length === 0 ? teachers.length : 0,
    filteredRecords: activeTeachers.length > 0 && teachersForFormClass.length === 0 ? activeTeachers.length : 0,
  });

  function handlePrerequisiteCreated(entity: PrerequisiteEntity, record: PrerequisiteRecord, selectedExisting: boolean) {
    if (entity === 'class') {
      setClasses((current) => current.some((item) => item.id === record.id)
        ? current : [...current, { id: record.id, name: record.name }]);
      setForm((current) => ({ ...current, class_id: record.id, teacher_id: '' }));
    } else if (entity === 'subject') {
      setSubjects((current) => current.some((item) => item.id === record.id)
        ? current : [...current, { id: record.id, name: record.name }]);
      if (form.class_id) {
        setClassSubjects((current) => current.some((item) => item.class_id === form.class_id && item.subject_id === record.id)
          ? current : [...current, { class_id: form.class_id, subject_id: record.id }]);
      }
      setForm((current) => ({ ...current, subject_id: record.id }));
    } else {
      const teacher = record as Teacher;
      setTeachers((current) => current.some((item) => item.id === teacher.id) ? current : [...current, teacher]);
      if (form.class_id) {
        setClassTeacherIds((current) => {
          const next = new Map(current);
          const teacherIds = new Set(next.get(form.class_id) ?? []);
          teacherIds.add(teacher.id);
          next.set(form.class_id, teacherIds);
          return next;
        });
      }
      setForm((current) => ({ ...current, teacher_id: teacher.id }));
    }
    setNotice(selectedExisting ? `Existing ${entity} selected.` : `${entity[0].toUpperCase()}${entity.slice(1)} created and selected.`);
  }

  async function createAssignment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const assignedTeacherId = form.teacher_id || teacherId;
    if (!schoolId || !assignedTeacherId || !user) {
      setError('A teacher profile must be linked to create an assignment.');
      return;
    }
    if (!classes.some((item) => item.id === form.class_id) || !subjectsForFormClass.some((item) => item.id === form.subject_id)) {
      setError('Choose a class and subject that are currently available in this school.');
      return;
    }
    if (role === 'teacher' ? !teacherClasses.has(form.class_id) || assignedTeacherId !== teacherId
      : !teachersForFormClass.some((item) => item.id === assignedTeacherId)) {
      setError('Choose an active teacher assigned to the selected class.');
      return;
    }
    const maxMarks = form.max_marks.trim() ? Number(form.max_marks) : null;
    if (maxMarks !== null && (!Number.isFinite(maxMarks) || maxMarks <= 0)) {
      setError('Maximum marks must be a positive number.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: insertError } = await requireSupabase().from('assignments').insert({
        school_id: schoolId,
        class_id: form.class_id,
        subject_id: form.subject_id,
        teacher_id: assignedTeacherId,
        title: form.title.trim(),
        description: form.description.trim() || null,
        due_at: form.due_at ? new Date(form.due_at).toISOString() : null,
        max_marks: maxMarks,
        attached_material_id: form.attached_material_id || null,
        status: 'draft',
      });
      if (insertError) throw insertError;
      setShowCreate(false);
      setForm(emptyForm);
      setNotice('Assignment saved as a draft. Publish it when it is ready for students.');
      setRefreshKey((current) => current + 1);
    } catch (saveError) {
      setError(errorMessage(saveError, 'Could not create this assignment.'));
    } finally {
      setSaving(false);
    }
  }

  async function setAssignmentStatus(assignment: Assignment, status: AssignmentStatus) {
    setError('');
    setNotice('');
    try {
      const { error: updateError } = await requireSupabase().from('assignments')
        .update({ status }).eq('school_id', assignment.school_id).eq('id', assignment.id);
      if (updateError) throw updateError;
      setNotice(status === 'published' ? 'Assignment published to its class.' : 'Assignment archived.');
      setRefreshKey((current) => current + 1);
    } catch (updateError) {
      setError(errorMessage(updateError, 'Could not update the assignment.'));
    }
  }

  async function openMaterial(materialId: string) {
    const material = materials.find((item) => item.id === materialId);
    if (!material) return;
    const previewWindow = window.open('about:blank', '_blank');
    if (!previewWindow) {
      setError('Allow pop-ups for this site to open the attached learning resource.');
      return;
    }
    previewWindow.opener = null;
    setError('');
    try {
      let url: string;
      if (material.storage_provider === 'supabase') {
        const { data, error: signError } = await requireSupabase().storage
          .from('learning-materials').createSignedUrl(material.storage_path, 300);
        if (signError) throw signError;
        url = data.signedUrl;
      } else {
        const { data, error: signError } = await requireSupabase().functions.invoke('learning-material-storage', {
          body: { action: 'create-download-url', materialId, disposition: 'inline' },
        });
        if (signError) throw signError;
        if (typeof data?.url !== 'string') throw new Error('The resource storage service did not return a preview link.');
        url = data.url;
      }
      previewWindow.location.replace(url);
    } catch (openError) {
      previewWindow.close();
      setError(errorMessage(openError, 'Could not open the attached learning resource.'));
    }
  }

  async function openSubmissionFile(submission: Submission) {
    if (!submission.storage_path) return;
    const downloadWindow = window.open('about:blank', '_blank');
    if (!downloadWindow) {
      setError('Allow pop-ups for this site to download the student attachment.');
      return;
    }
    downloadWindow.opener = null;
    try {
      const { data, error: signError } = await requireSupabase().storage
        .from('assignment-submissions').createSignedUrl(submission.storage_path, 300, { download: true });
      if (signError) throw signError;
      downloadWindow.location.replace(data.signedUrl);
    } catch (openError) {
      downloadWindow.close();
      setError(errorMessage(openError, 'Could not open the submitted attachment.'));
    }
  }

  async function submitWork(event: FormEvent<HTMLFormElement>, assignment: Assignment) {
    event.preventDefault();
    if (!student || !schoolId) return;
    const formElement = event.currentTarget;
    const textResponse = String(new FormData(formElement).get('text_response') ?? '').trim();
    const chosenFile = new FormData(formElement).get('submission_file');
    const file = chosenFile instanceof File && chosenFile.size > 0 ? chosenFile : null;
    if (!textResponse && !file) {
      setError('Write a response or attach a file before submitting.');
      return;
    }
    if (file && (file.size > MAX_SUBMISSION_SIZE || !submissionTypes.has(file.type))) {
      setError('Attach a PDF, Office document, text file, or image no larger than 50 MB.');
      return;
    }

    const existing = submissions.find((item) => item.assignment_id === assignment.id && item.student_id === student.id);
    let uploadedPath: string | null = null;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const client = requireSupabase();
      let nextPath = existing?.storage_path ?? null;
      if (file) {
        uploadedPath = `${schoolId}/${student.id}/${assignment.id}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
        const { error: fileError } = await client.storage.from('assignment-submissions').upload(uploadedPath, file, {
          contentType: file.type,
          upsert: false,
        });
        if (fileError) throw fileError;
        nextPath = uploadedPath;
      }
      const submissionValues = {
        storage_path: nextPath,
        text_response: textResponse || null,
      };
      const { error: submissionError } = existing
        ? await client.from('assignment_submissions').update(submissionValues).eq('id', existing.id).eq('school_id', schoolId)
        : await client.from('assignment_submissions').insert({
          ...submissionValues,
          school_id: schoolId,
          assignment_id: assignment.id,
          student_id: student.id,
        });
      if (submissionError) throw submissionError;
      if (file && existing?.storage_path && existing.storage_path !== nextPath) {
        const { error: oldFileError } = await client.storage.from('assignment-submissions').remove([existing.storage_path]);
        if (oldFileError) {
          setError(`Your new submission was saved, but the previous attachment could not be removed: ${oldFileError.message}`);
        }
      }
      setNotice('Your work was submitted. The submission status reflects the assignment deadline.');
      setRefreshKey((current) => current + 1);
    } catch (submitError) {
      let failure = errorMessage(submitError, 'Could not submit your work.');
      if (uploadedPath) {
        const { error: cleanupError } = await requireSupabase().storage.from('assignment-submissions').remove([uploadedPath]);
        if (cleanupError) failure = `Submission failed, and its uploaded attachment could not be removed: ${cleanupError.message}`;
      }
      setError(failure);
    } finally {
      setSaving(false);
    }
  }

  async function saveFeedback(event: FormEvent<HTMLFormElement>, submission: Submission) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const rawMarks = String(data.get('marks') ?? '').trim();
    const marks = rawMarks ? Number(rawMarks) : null;
    const feedback = String(data.get('feedback') ?? '').trim();
    const assignment = assignments.find((item) => item.id === submission.assignment_id);
    if (marks !== null && (!Number.isFinite(marks) || marks < 0 || assignment?.max_marks === null || marks > (assignment?.max_marks ?? 0))) {
      setError(`Enter marks between 0 and ${assignment?.max_marks ?? 'the assignment maximum'}.`);
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: updateError } = await requireSupabase().from('assignment_submissions').update({
        marks,
        feedback: feedback || null,
        status: marks === null ? 'returned' : 'graded',
      }).eq('id', submission.id).eq('school_id', submission.school_id);
      if (updateError) throw updateError;
      setNotice('Teacher feedback saved.');
      setRefreshKey((current) => current + 1);
    } catch (gradeError) {
      setError(errorMessage(gradeError, 'Could not save teacher feedback.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-stack assignments-page">
      <div className="page-heading"><div><span className="eyebrow">{activeMembership?.school.name}</span><h1>Assignments & homework</h1><p>Create class assignments, share learning resources, collect student work, and return feedback.</p></div>
        <Link className="button button-quiet" to="/prerequisite-demo">Preview quick-create demo</Link>
        {canManage && <button className="button button-primary" onClick={() => { const firstClass = classes[0]?.id ?? ''; const assignedTeacher = teacherId || teachers.find((item) => item.status === 'active' && classTeacherIds.get(firstClass)?.has(item.id))?.id || ''; setError(''); setForm({ ...emptyForm, class_id: firstClass, subject_id: subjects[0]?.id ?? '', teacher_id: assignedTeacher }); setShowCreate(true); }} disabled={role === 'teacher' && !teacherId}><Plus size={16} /> Create assignment</button>}
      </div>
      {notice && <p className="inline-success" role="status">{notice}</p>}
      {error && <ErrorState message={error} />}
      {loading ? <LoadingState label="Loading assignments…" /> : visibleAssignments.length === 0
        ? <section className="content-card assignments-empty"><span className="module-icon"><ClipboardList size={22} /></span><h2>No assignments yet</h2><p>{canManage ? 'Create a class assignment, add its instructions and deadline, and publish it when ready.' : 'Published assignments for your class will appear here.'}</p></section>
        : <div className="assignments-list">{visibleAssignments.map((assignment) => {
          const attachedMaterial = materials.find((item) => item.id === assignment.attached_material_id);
          const assignmentSubmissions = submissions.filter((item) => item.assignment_id === assignment.id);
          const ownSubmission = assignmentSubmissions.find((item) => item.student_id === student?.id);
          return <article className="content-card assignment-card" key={assignment.id}>
            <div className="assignment-card-heading"><div><span className={`status-pill ${assignment.status === 'published' ? 'status-active' : 'status-muted'}`}>{assignment.status}</span><h2>{assignment.title}</h2><p>{subjectNames.get(assignment.subject_id) ?? 'Subject'} · {classNames.get(assignment.class_id) ?? 'Class'}</p></div>
              {canManage && <div className="assignment-actions">{assignment.status === 'draft' && <button className="button button-primary" onClick={() => void setAssignmentStatus(assignment, 'published')}><Send size={14} /> Publish</button>}{assignment.status === 'published' && <button className="button button-quiet" onClick={() => void setAssignmentStatus(assignment, 'archived')}>Archive</button>}</div>}
            </div>
            <p className="assignment-description">{assignment.description || 'No additional instructions provided.'}</p>
            <div className="assignment-facts"><span><CalendarClock size={14} /> Due {dateTimeLocal(assignment.due_at)}</span>{assignment.max_marks !== null && <span><Check size={14} /> {assignment.max_marks} marks</span>}<span><ClipboardList size={14} /> {assignmentSubmissions.length} submission{assignmentSubmissions.length === 1 ? '' : 's'}</span></div>
            {attachedMaterial && <button className="assignment-resource" onClick={() => void openMaterial(attachedMaterial.id)}><BookOpen size={15} /><span><strong>{attachedMaterial.title}</strong><small>Attached learning resource · preview or download</small></span><Download size={15} /></button>}
            {isStudent && assignment.status === 'published' && student && <form className="assignment-submit-form" onSubmit={(event) => void submitWork(event, assignment)}>
              <div className="settings-subheading"><h3>{ownSubmission ? 'Update your submission' : 'Submit your work'}</h3><p>{ownSubmission ? `Current status: ${ownSubmission.status}${ownSubmission.marks !== null ? ` · ${ownSubmission.marks}${assignment.max_marks ? ` / ${assignment.max_marks}` : ''} marks` : ''}` : 'You can write a response, attach a file, or do both.'}</p></div>
              {ownSubmission?.feedback && <p className="assignment-feedback"><strong>Teacher feedback</strong>{ownSubmission.feedback}</p>}
              {ownSubmission?.storage_path && <button className="assignment-existing-file" type="button" onClick={() => void openSubmissionFile(ownSubmission)}><FileText size={14} /> View your attached submission</button>}
              <label className="field"><span>Your response</span><textarea name="text_response" rows={4} maxLength={10000} defaultValue={ownSubmission?.text_response ?? ''} placeholder="Type your answer or explain your work." /></label>
              <label className="field"><span>Attach a file <small>PDF, Office document, text, or image · max 50 MB</small></span><input type="file" name="submission_file" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp" /></label>
              <button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Submitting…' : ownSubmission ? 'Update submission' : 'Submit assignment'}</button>
            </form>}
            {canManage && assignment.status !== 'draft' && <section className="assignment-submissions"><div className="settings-subheading"><h3>Student submissions</h3><p>Review student work and return marks and feedback.</p></div>
              {assignmentSubmissions.length === 0 ? <p className="assignment-empty-submissions">No student submissions yet.</p> : <div className="assignment-submission-list">{assignmentSubmissions.map((submission) => <form className="assignment-submission" key={submission.id} onSubmit={(event) => void saveFeedback(event, submission)}>
                <div className="assignment-submission-title"><div><strong>{studentNames.get(submission.student_id) ?? `Student ${submission.student_id.slice(0, 8)}`}</strong><small>{submission.submitted_at ? new Date(submission.submitted_at).toLocaleString() : 'Not submitted'} · {submission.status}</small></div>{submission.storage_path && <button className="icon-button" type="button" aria-label="Download student attachment" onClick={() => void openSubmissionFile(submission)}><Download size={15} /></button>}</div>
                {submission.text_response && <p className="assignment-student-response">{submission.text_response}</p>}
                <div className="assignment-feedback-fields"><label className="field"><span>Marks {assignment.max_marks !== null ? `(out of ${assignment.max_marks})` : '(set a maximum to grade)'}</span><input name="marks" type="number" min="0" max={assignment.max_marks ?? undefined} step="0.01" defaultValue={submission.marks ?? ''} disabled={assignment.max_marks === null} /></label><label className="field"><span>Feedback</span><textarea name="feedback" rows={2} maxLength={3000} defaultValue={submission.feedback ?? ''} /></label><button className="button button-quiet" type="submit" disabled={saving}>Save feedback</button></div>
              </form>)}</div>}
            </section>}
          </article>;
        })}</div>}

      {showCreate && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setShowCreate(false); }}>
        <section className="modal-card assignment-create-modal" role="dialog" aria-modal="true" aria-labelledby="assignment-create-title">
          <div className="modal-heading"><div><span className="eyebrow">Class work</span><h2 id="assignment-create-title">Create assignment</h2></div><button className="icon-button" onClick={() => setShowCreate(false)} aria-label="Close create assignment"><X size={18} /></button></div>
          <form className="modal-form" onSubmit={(event) => void createAssignment(event)}>
            <label className="field"><span>Assignment title</span><input required minLength={2} maxLength={160} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="e.g. Fractions practice" /></label>
            <div className="form-row"><div><label className="field"><span>Class</span><select required value={form.class_id} onChange={(event) => { const classId = event.target.value; const linkedSubjects = classSubjects.filter((item) => item.class_id === classId); const availableSubjects = linkedSubjects.length ? subjects.filter((subject) => linkedSubjects.some((item) => item.subject_id === subject.id)) : subjects; const assigned = teachers.find((item) => item.status === 'active' && classTeacherIds.get(classId)?.has(item.id))?.id ?? ''; setForm((current) => ({ ...current, class_id: classId, subject_id: availableSubjects.some((item) => item.id === current.subject_id) ? current.subject_id : availableSubjects[0]?.id ?? '', teacher_id: role === 'teacher' ? teacherId : assigned, attached_material_id: '' })); }}><option value="">Choose class</option>{classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{!classes.length && <PrerequisiteFieldNotice rule={getPrerequisiteRule('assignments', 'class')} availability={classAvailability} role={role} onCreate={() => setQuickCreateEntity('class')} />}</div><div><label className="field"><span>Subject</span><select required value={form.subject_id} onChange={(event) => setForm({ ...form, subject_id: event.target.value })}><option value="">Choose subject</option>{subjectsForFormClass.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{!subjectsForFormClass.length && <PrerequisiteFieldNotice rule={getPrerequisiteRule('assignments', 'subject')} availability={subjectAvailability} role={role} onCreate={() => setQuickCreateEntity('subject')} />}</div></div>
            {role !== 'teacher' && <><label className="field"><span>Assigned teacher</span><select required value={form.teacher_id} onChange={(event) => setForm({ ...form, teacher_id: event.target.value })}><option value="">Choose teacher</option>{teachersForFormClass.map((item) => <option key={item.id} value={item.id}>{item.first_name} {item.last_name}</option>)}</select></label>{form.class_id && !teachersForFormClass.length && <PrerequisiteFieldNotice rule={getPrerequisiteRule('assignments', 'teacher')} availability={teacherAvailability} role={role} onCreate={() => setQuickCreateEntity('teacher')} />}</>}
            <label className="field"><span>Instructions</span><textarea required maxLength={8000} rows={5} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="Explain what students should do and how to submit their work." /></label>
            <div className="form-row"><label className="field"><span>Deadline</span><input type="datetime-local" value={form.due_at} onChange={(event) => setForm({ ...form, due_at: event.target.value })} /></label><label className="field"><span>Maximum marks <small>(optional)</small></span><input type="number" min="0.01" step="0.01" value={form.max_marks} onChange={(event) => setForm({ ...form, max_marks: event.target.value })} /></label></div>
            <label className="field"><span>Attach a learning resource <small>(optional)</small></span><select value={form.attached_material_id} onChange={(event) => setForm({ ...form, attached_material_id: event.target.value })}><option value="">No resource</option>{materials.filter((material) => material.class_id === form.class_id).map((material) => <option key={material.id} value={material.id}>{material.title}</option>)}</select></label>
            <div className="modal-actions"><button className="button button-quiet" type="button" onClick={() => setShowCreate(false)} disabled={saving}>Cancel</button><button className="button button-primary" type="submit" disabled={saving || !classes.length || !subjects.length || (role !== 'teacher' && !teachersForFormClass.length)}>{saving ? 'Saving…' : 'Save draft'}</button></div>
          </form>
        </section>
      </div>}
      {quickCreateEntity && schoolId && role && <PrerequisiteQuickCreate
        entity={quickCreateEntity}
        open
        schoolId={schoolId}
        role={role}
        contextClassId={form.class_id}
        contextSubjectId={form.subject_id}
        onClose={() => setQuickCreateEntity(null)}
        onCreated={(record, selectedExisting) => handlePrerequisiteCreated(quickCreateEntity, record, selectedExisting)}
      />}
    </div>
  );
}
