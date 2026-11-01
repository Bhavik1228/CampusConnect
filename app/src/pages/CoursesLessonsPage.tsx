import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { BookOpen, Check, Circle, ClipboardList, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { ErrorState, LoadingState } from '../components/Feedback';
import { DraftRecoveryControls } from '../components/DraftRecoveryControls';
import { useRecoverableDraft } from '../lib/recoverable-drafts';
import { requireSupabase } from '../lib/supabase';

type Course = {
  id: string;
  subject_id: string;
  class_id: string;
  teacher_id: string;
  title: string;
  description: string;
  objectives: string;
  status: 'draft' | 'published' | 'archived';
  subject: { name: string } | null;
  school_class: { name: string } | null;
  teacher: { first_name: string; last_name: string; profile_id: string | null } | null;
};
type Unit = { id: string; course_id: string; title: string; description: string; position: number };
type Lesson = { id: string; course_id: string; unit_id: string; title: string; description: string; objectives: string; position: number; published: boolean };
type Subject = { id: string; name: string; department_id: string | null };
type SchoolClass = { id: string; name: string };
type Teacher = { id: string; first_name: string; last_name: string; profile_id: string | null; staff_profile_id: string | null; department_id: string | null };
type StaffDepartment = { id: string; department_id: string | null };
type Student = { id: string; student_number: string; first_name: string; last_name: string };
type Completion = { lesson_id: string; student_id: string; completed_at: string };
type Dialog = 'course' | 'unit' | 'lesson' | null;
type CourseForm = Pick<Course, 'subject_id' | 'class_id' | 'teacher_id' | 'title' | 'description' | 'objectives' | 'status'>;

const emptyCourse: CourseForm = { title: '', subject_id: '', class_id: '', teacher_id: '', description: '', objectives: '', status: 'draft' };
const emptyUnit = { title: '', description: '' };
const emptyLesson = { title: '', description: '', objectives: '', published: false };

export function CoursesLessonsPage() {
  const { activeMembership, user } = useAuth();
  const schoolId = activeMembership?.school_id;
  const role = activeMembership?.role;
  const isSchoolManager = role === 'school_admin' || role === 'academic_coordinator';
  const [courses, setCourses] = useState<Course[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [hodDepartmentIds, setHodDepartmentIds] = useState<string[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [completions, setCompletions] = useState<Completion[]>([]);
  const [courseId, setCourseId] = useState('');
  const [lessonId, setLessonId] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [editingId, setEditingId] = useState('');
  const [courseForm, setCourseForm] = useState(emptyCourse);
  const [unitForm, setUnitForm] = useState(emptyUnit);
  const [lessonForm, setLessonForm] = useState(emptyLesson);
  const [unitId, setUnitId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const activeCourse = courses.find((course) => course.id === courseId) ?? null;
  const activeLesson = lessons.find((lesson) => lesson.id === lessonId) ?? null;
  const availableCourseSubjects = isSchoolManager
    ? subjects
    : hodDepartmentIds.length
      ? subjects.filter((subject) => subject.department_id && hodDepartmentIds.includes(subject.department_id))
      : subjects;
  const availableCourseTeachers = isSchoolManager
    ? teachers
    : hodDepartmentIds.length
      ? teachers.filter((teacher) => teacher.department_id && hodDepartmentIds.includes(teacher.department_id))
      : teachers.filter((teacher) => teacher.profile_id === user?.id);
  const canManageCourse = isSchoolManager || (role === 'teacher' && Boolean(activeCourse && (
    activeCourse.teacher?.profile_id === user?.id
    || (
      hodDepartmentIds.includes(subjects.find((subject) => subject.id === activeCourse.subject_id)?.department_id ?? '')
      && hodDepartmentIds.includes(teachers.find((teacher) => teacher.id === activeCourse.teacher_id)?.department_id ?? '')
    )
  )));
  const canManageCompletion = isSchoolManager || (role === 'teacher' && activeCourse?.teacher?.profile_id === user?.id);
  const lessonDraft = useRecoverableDraft({
    schoolId,
    userId: user?.id,
    entity: 'lesson_plan',
    entityId: courseId || 'unselected-course',
    payload: { lessonForm, unitId, lessonId: editingId },
    enabled: !loading && dialog === 'lesson' && canManageCourse && Boolean(schoolId && user && courseId),
  });

  function restoreLessonDraft(value: { lessonForm: typeof emptyLesson; unitId: string; lessonId: string }) {
    setLessonForm(value.lessonForm);
    setUnitId(value.unitId);
    setEditingId(value.lessonId);
    setDialog('lesson');
    setNotice('Saved lesson draft restored. Review the content before saving to the school record.');
  }

  const load = useCallback(async () => {
    if (!schoolId) return;
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [courseResult, subjectResult, classResult, teacherResult, staffResult] = await Promise.all([
        client.from('lesson_courses').select('id,subject_id,class_id,teacher_id,title,description,objectives,status,subject:subjects(name),school_class:school_classes(name),teacher:teacher_profiles(first_name,last_name,profile_id)').eq('school_id', schoolId).order('title'),
        client.from('subjects').select('id,name,department_id').eq('school_id', schoolId).order('name'),
        client.from('school_classes').select('id,name').eq('school_id', schoolId).order('name'),
        client.from('teacher_profiles').select('id,first_name,last_name,profile_id,staff_profile_id').eq('school_id', schoolId).order('last_name'),
        client.from('staff_profiles').select('id,department_id').eq('school_id', schoolId),
      ]);
      if (courseResult.error) throw courseResult.error;
      if (subjectResult.error) throw subjectResult.error;
      if (classResult.error) throw classResult.error;
      if (teacherResult.error) throw teacherResult.error;
      if (staffResult.error) throw staffResult.error;
      const staffDepartments = new Map(((staffResult.data ?? []) as StaffDepartment[]).map((item) => [item.id, item.department_id]));
      const teacherRows = (teacherResult.data ?? []).map((teacher) => ({
        ...teacher,
        department_id: teacher.staff_profile_id ? staffDepartments.get(teacher.staff_profile_id) ?? null : null,
      })) as Teacher[];
      let currentHodDepartmentIds: string[] = [];
      if (role === 'teacher' && user?.id) {
        const currentTeacherIds = teacherRows.filter((teacher) => teacher.profile_id === user.id).map((teacher) => teacher.id);
        if (currentTeacherIds.length) {
          const { data: responsibilityRows, error: responsibilityError } = await client.from('teacher_responsibilities')
            .select('department_id').eq('school_id', schoolId)
            .eq('responsibility_type', 'head_of_department').in('teacher_id', currentTeacherIds);
          if (responsibilityError) throw responsibilityError;
          currentHodDepartmentIds = (responsibilityRows ?? []).flatMap((item) => item.department_id ? [item.department_id] : []);
        }
      }
      setCourses((courseResult.data ?? []) as unknown as Course[]);
      setSubjects((subjectResult.data ?? []) as Subject[]);
      setClasses((classResult.data ?? []) as SchoolClass[]);
      setTeachers(teacherRows);
      setHodDepartmentIds(currentHodDepartmentIds);
      const currentCourses = (courseResult.data ?? []) as unknown as Course[];
      const selectedId = currentCourses.some((course) => course.id === courseId) ? courseId : currentCourses[0]?.id ?? '';
      setCourseId(selectedId);
      if (selectedId) {
        const [unitResult, lessonResult] = await Promise.all([
          client.from('lesson_units').select('id,course_id,title,description,position').eq('school_id', schoolId).eq('course_id', selectedId).order('position').order('title'),
          client.from('course_lessons').select('id,course_id,unit_id,title,description,objectives,position,published').eq('school_id', schoolId).eq('course_id', selectedId).order('position').order('title'),
        ]);
        if (unitResult.error) throw unitResult.error;
        if (lessonResult.error) throw lessonResult.error;
        const unitRows = (unitResult.data ?? []) as Unit[];
        const lessonRows = (lessonResult.data ?? []) as Lesson[];
        setUnits(unitRows);
        setLessons(lessonRows);
        const selectedLesson = lessonRows.some((lesson) => lesson.id === lessonId) ? lessonId : '';
        setLessonId(selectedLesson);
        if (selectedLesson) {
          const selectedCourse = currentCourses.find((course) => course.id === selectedId);
          const selectedCourseTeacher = teacherRows.find((teacher) => teacher.id === selectedCourse?.teacher_id);
          const selectedCourseSubject = (subjectResult.data ?? []).find((subject) => subject.id === selectedCourse?.subject_id);
          const isCourseManager = isSchoolManager || (role === 'teacher' && Boolean(selectedCourse && (
            selectedCourse.teacher?.profile_id === user?.id
            || (
              currentHodDepartmentIds.includes(selectedCourseSubject?.department_id ?? '')
              && currentHodDepartmentIds.includes(selectedCourseTeacher?.department_id ?? '')
            )
          )));
          const completionQuery = client.from('lesson_completions').select('lesson_id,student_id,completed_at').eq('school_id', schoolId).in('lesson_id', lessonRows.map((lesson) => lesson.id));
          if (isCourseManager) {
            const [studentResult, completionResult] = await Promise.all([
              client.from('students').select('id,student_number,first_name,last_name').eq('school_id', schoolId).eq('class_id', currentCourses.find((course) => course.id === selectedId)?.class_id ?? '').eq('status', 'active').order('last_name').order('first_name'),
              completionQuery,
            ]);
            if (studentResult.error) throw studentResult.error;
            if (completionResult.error) throw completionResult.error;
            setStudents((studentResult.data ?? []) as Student[]);
            setCompletions((completionResult.data ?? []) as Completion[]);
          } else {
            const { data, error: completionError } = await completionQuery;
            if (completionError) throw completionError;
            setStudents([]);
            setCompletions((data ?? []) as Completion[]);
          }
        } else {
          setStudents([]);
          setCompletions([]);
        }
      } else {
        setUnits([]);
        setLessons([]);
        setLessonId('');
        setStudents([]);
        setCompletions([]);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load courses and lessons.');
    } finally {
      setLoading(false);
    }
  }, [schoolId, courseId, lessonId, isSchoolManager, role, user?.id, refreshKey]);

  useEffect(() => { void load(); }, [load]);

  function openCourse(course?: Course) {
    setEditingId(course?.id ?? '');
    setCourseForm(course ? {
      title: course.title,
      subject_id: course.subject_id,
      class_id: course.class_id,
      teacher_id: course.teacher_id,
      description: course.description,
      objectives: course.objectives,
      status: course.status,
    } : { ...emptyCourse, teacher_id: role === 'teacher' ? teachers.find((teacher) => teacher.profile_id === user?.id)?.id ?? '' : '' });
    setDialog('course');
    setNotice('');
  }

  function openLesson(lesson?: Lesson, unit?: Unit) {
    setEditingId(lesson?.id ?? '');
    setUnitId(lesson?.unit_id ?? unit?.id ?? '');
    setLessonForm(lesson ? {
      title: lesson.title,
      description: lesson.description,
      objectives: lesson.objectives,
      published: lesson.published,
    } : { ...emptyLesson });
    setDialog('lesson');
    setNotice('');
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !user) return;
    setSaving(true);
    setError('');
    try {
      const client = requireSupabase();
      let result;
      if (dialog === 'course') {
        const payload = { ...courseForm, school_id: schoolId, title: courseForm.title.trim() };
        result = editingId
          ? await client.from('lesson_courses').update(payload).eq('id', editingId).eq('school_id', schoolId)
          : await client.from('lesson_courses').insert({ ...payload, created_by: user.id });
      } else if (dialog === 'unit') {
        result = await client.from('lesson_units').insert({ ...unitForm, school_id: schoolId, course_id: courseId, position: units.length });
      } else if (dialog === 'lesson') {
        const payload = { ...lessonForm, title: lessonForm.title.trim(), school_id: schoolId, course_id: courseId, unit_id: unitId, position: lessons.filter((lesson) => lesson.unit_id === unitId).length };
        result = editingId
          ? await client.from('course_lessons').update(payload).eq('id', editingId).eq('school_id', schoolId)
          : await client.from('course_lessons').insert(payload);
      }
      if (result?.error) throw result.error;
      if (dialog === 'lesson') await lessonDraft.clearDraft();
      setDialog(null);
      setNotice(dialog === 'course' ? 'Course saved.' : dialog === 'unit' ? 'Unit added.' : 'Lesson saved.');
      setRefreshKey((key) => key + 1);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save this record.');
    } finally {
      setSaving(false);
    }
  }

  async function deleteRecord(table: 'lesson_courses' | 'lesson_units' | 'course_lessons', id: string, label: string) {
    if (!schoolId || !window.confirm(`Delete this ${label}? Related lessons and completion records may also be removed.`)) return;
    setError('');
    try {
      const { error: deleteError } = await requireSupabase().from(table).delete().eq('school_id', schoolId).eq('id', id);
      if (deleteError) throw deleteError;
      if (table === 'lesson_courses') setCourseId('');
      if (table === 'course_lessons') setLessonId('');
      setNotice(`${label[0].toUpperCase()}${label.slice(1)} deleted.`);
      setRefreshKey((key) => key + 1);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : `Could not delete ${label}.`);
    }
  }

  async function toggleCompletion(studentId: string, completed: boolean) {
    if (!schoolId || !user || !activeLesson || !canManageCompletion) return;
    setError('');
    try {
      const client = requireSupabase();
      const result = completed
        ? await client.from('lesson_completions').delete().eq('school_id', schoolId).eq('lesson_id', activeLesson.id).eq('student_id', studentId)
        : await client.from('lesson_completions').insert({ school_id: schoolId, lesson_id: activeLesson.id, student_id: studentId, completed_by: user.id });
      if (result.error) throw result.error;
      setRefreshKey((key) => key + 1);
    } catch (completionError) {
      setError(completionError instanceof Error ? completionError.message : 'Could not update lesson completion.');
    }
  }

  const completedIds = new Set(completions.map((completion) => completion.student_id));

  return (
    <div className="page-stack courses-page">
      <div className="page-heading">
        <div><span className="eyebrow">{activeMembership?.school.name}</span><h1>Courses &amp; lessons</h1><p>Organize subject courses into units and track lesson progress for each class.</p></div>
        {(isSchoolManager || role === 'teacher') && <button className="button button-primary" onClick={() => openCourse()}><Plus size={16} /> New course</button>}
      </div>
      {notice && <p className="inline-success" role="status">{notice}</p>}
      {error && <ErrorState message={error} />}
      {loading ? <LoadingState label="Loading courses and lessons…" /> : (
        <div className="courses-layout">
          <section className="content-card courses-list-card">
            <div className="section-heading"><div><span className="eyebrow">Course pages</span><h2>Your courses</h2></div><span className="test-count">{courses.length}</span></div>
            {courses.length === 0 ? <div className="test-empty"><span><BookOpen size={20} /></span><strong>No courses yet</strong><p>Create a course and link it to a school subject, class and teacher.</p></div> : <div className="course-list">
              {courses.map((course) => <button key={course.id} className={`course-list-item${course.id === courseId ? ' selected' : ''}`} onClick={() => { setCourseId(course.id); setLessonId(''); }}>
                <strong>{course.title}</strong><span>{course.subject?.name ?? 'Subject'} · {course.school_class?.name ?? 'Class'}</span><small>{course.teacher ? `${course.teacher.first_name} ${course.teacher.last_name}` : 'Teacher unassigned'} · {course.status}</small>
              </button>)}
            </div>}
          </section>
          {!activeCourse ? <section className="content-card course-empty"><BookOpen size={25} /><h2>Choose a course</h2><p>Course units and lessons will appear here.</p></section> : <section className="content-card course-detail-card">
            <div className="course-detail-heading">
              <div><span className="eyebrow">{activeCourse.subject?.name} · {activeCourse.school_class?.name}</span><h2>{activeCourse.title}</h2><p>{activeCourse.description || 'No course description added.'}</p></div>
              {canManageCourse && <div className="course-actions"><button className="icon-button" onClick={() => openCourse(activeCourse)} aria-label="Edit course"><Pencil size={16} /></button><button className="icon-button danger-icon" onClick={() => void deleteRecord('lesson_courses', activeCourse.id, 'course')} aria-label="Delete course"><Trash2 size={16} /></button></div>}
            </div>
            {activeCourse.objectives && <div className="course-objectives"><strong>Course objectives</strong><p>{activeCourse.objectives}</p></div>}
            <div className="course-units-heading"><div><span className="eyebrow">Learning structure</span><h3>Units &amp; lessons</h3></div>{canManageCourse && <div className="course-actions"><button className="button button-quiet" onClick={() => { setUnitForm({ ...emptyUnit }); setEditingId(''); setDialog('unit'); }}><Plus size={15} /> Add unit</button></div>}</div>
            {units.length === 0 ? <div className="course-empty"><p>No units yet. Start by organizing this course into a unit.</p></div> : units.map((unit) => <div className="lesson-unit" key={unit.id}>
              <div className="lesson-unit-heading"><div><h4>{unit.title}</h4>{unit.description && <p>{unit.description}</p>}</div>{canManageCourse && <button className="icon-button danger-icon" onClick={() => void deleteRecord('lesson_units', unit.id, 'unit')} aria-label={`Delete ${unit.title}`}><Trash2 size={15} /></button>}</div>
              {lessons.filter((lesson) => lesson.unit_id === unit.id).map((lesson) => <article className={`lesson-row${lesson.id === lessonId ? ' selected' : ''}`} key={lesson.id}>
                <button className="lesson-row-main" onClick={() => setLessonId(lesson.id)}><span className="lesson-row-icon"><ClipboardList size={16} /></span><span><strong>{lesson.title}</strong><small>{lesson.published ? 'Published' : 'Draft'} · {completions.filter((completion) => completion.lesson_id === lesson.id).length} completion{completions.filter((completion) => completion.lesson_id === lesson.id).length === 1 ? '' : 's'}</small></span></button>
                {canManageCourse && <div className="course-actions"><button className="icon-button" onClick={() => openLesson(lesson)} aria-label={`Edit ${lesson.title}`}><Pencil size={14} /></button><button className="icon-button danger-icon" onClick={() => void deleteRecord('course_lessons', lesson.id, 'lesson')} aria-label={`Delete ${lesson.title}`}><Trash2 size={14} /></button></div>}
              </article>)}
              {canManageCourse && <button className="lesson-add-link" onClick={() => openLesson(undefined, unit)}><Plus size={14} /> Add lesson to {unit.title}</button>}
            </div>)}
            {activeLesson && <section className="lesson-detail-panel">
              <div className="section-heading"><div><span className="eyebrow">Lesson details</span><h3>{activeLesson.title}</h3></div>{activeLesson.published && <span className="status-pill status-active">Published</span>}</div>
              <div className="lesson-detail-columns"><div><strong>Description</strong><p>{activeLesson.description || 'No description provided.'}</p></div><div><strong>Objectives</strong><p>{activeLesson.objectives || 'No objectives provided.'}</p></div></div>
              {!canManageCourse && <p className="lesson-own-progress" role="status">{role === 'student'
                ? completions.some((completion) => completion.lesson_id === activeLesson.id) ? 'This lesson is marked complete.' : 'This lesson is not marked complete yet.'
                : completions.some((completion) => completion.lesson_id === activeLesson.id) ? `${completions.filter((completion) => completion.lesson_id === activeLesson.id).length} linked learner(s) marked this lesson complete.` : 'No linked student completion has been recorded for this lesson yet.'}</p>}
              {canManageCourse && <div className="lesson-completion">
                <div className="section-heading"><div><span className="eyebrow">Progress tracking</span><h3>Student completion</h3></div><span className="table-count">{completedIds.size}/{students.length} complete</span></div>
                {students.length === 0 ? <p className="quiet-note">There are no active students assigned to this class yet.</p> : <div className="completion-list">{students.map((student) => {
                  const completed = completedIds.has(student.id);
                  return <div className="completion-row" key={student.id}><span className="mono-cell">{student.student_number}</span><strong>{student.first_name} {student.last_name}</strong>{canManageCompletion ? <button className={`completion-toggle${completed ? ' completed' : ''}`} onClick={() => void toggleCompletion(student.id, completed)} aria-label={`${completed ? 'Mark incomplete' : 'Mark complete'} for ${student.first_name} ${student.last_name}`}>{completed ? <Check size={15} /> : <Circle size={15} />}{completed ? 'Completed' : 'Mark complete'}</button> : <span className={`completion-toggle${completed ? ' completed' : ''}`}>{completed ? <Check size={15} /> : <Circle size={15} />}{completed ? 'Completed' : 'Not complete'}</span>}</div>;
                })}</div>}
              </div>}
            </section>}
          </section>}
        </div>
      )}
      {dialog && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDialog(null); }}>
        <section className="modal-card course-modal" role="dialog" aria-modal="true" aria-labelledby="course-modal-title">
          <div className="modal-heading"><div><span className="eyebrow">Course workspace</span><h2 id="course-modal-title">{dialog === 'course' ? `${editingId ? 'Edit' : 'Create'} course` : dialog === 'unit' ? 'Add course unit' : `${editingId ? 'Edit' : 'Add'} lesson`}</h2></div><button className="icon-button" onClick={() => setDialog(null)} aria-label="Close dialog"><X size={18} /></button></div>
          <form className="modal-form" onSubmit={(event) => void save(event)}>
            {dialog === 'lesson' && <DraftRecoveryControls entity="lesson_plan" draft={lessonDraft} onRestore={restoreLessonDraft} />}
            {dialog === 'course' ? <>
              <label className="field"><span>Course title</span><input required minLength={2} maxLength={140} value={courseForm.title} onChange={(event) => setCourseForm({ ...courseForm, title: event.target.value })} /></label>
              <div className="form-row"><label className="field"><span>Subject</span><select required value={courseForm.subject_id} onChange={(event) => setCourseForm({ ...courseForm, subject_id: event.target.value })}><option value="">Select subject</option>{availableCourseSubjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}</select></label><label className="field"><span>Class</span><select required value={courseForm.class_id} onChange={(event) => setCourseForm({ ...courseForm, class_id: event.target.value })}><option value="">Select class</option>{classes.map((schoolClass) => <option key={schoolClass.id} value={schoolClass.id}>{schoolClass.name}</option>)}</select></label></div>
              <label className="field"><span>Assigned teacher</span><select required value={courseForm.teacher_id} onChange={(event) => setCourseForm({ ...courseForm, teacher_id: event.target.value })}><option value="">Select teacher</option>{availableCourseTeachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.first_name} {teacher.last_name}</option>)}</select></label>
              <label className="field"><span>Description</span><textarea maxLength={5000} rows={3} value={courseForm.description} onChange={(event) => setCourseForm({ ...courseForm, description: event.target.value })} /></label>
              <label className="field"><span>Course objectives</span><textarea maxLength={5000} rows={3} value={courseForm.objectives} onChange={(event) => setCourseForm({ ...courseForm, objectives: event.target.value })} /></label>
              <label className="field"><span>Availability</span><select value={courseForm.status} onChange={(event) => setCourseForm({ ...courseForm, status: event.target.value as Course['status'] })}><option value="draft">Draft</option><option value="published">Published to class</option><option value="archived">Archived</option></select></label>
            </> : dialog === 'unit' ? <>
              <label className="field"><span>Unit title</span><input required maxLength={140} value={unitForm.title} onChange={(event) => setUnitForm({ ...unitForm, title: event.target.value })} /></label>
              <label className="field"><span>Unit description <small>(optional)</small></span><textarea maxLength={3000} rows={3} value={unitForm.description} onChange={(event) => setUnitForm({ ...unitForm, description: event.target.value })} /></label>
            </> : <>
              <label className="field"><span>Lesson title</span><input required minLength={2} maxLength={160} value={lessonForm.title} onChange={(event) => setLessonForm({ ...lessonForm, title: event.target.value })} /></label>
              <label className="field"><span>Unit</span><select required value={unitId} onChange={(event) => setUnitId(event.target.value)}><option value="">Select unit</option>{units.map((unit) => <option key={unit.id} value={unit.id}>{unit.title}</option>)}</select></label>
              <label className="field"><span>Description</span><textarea maxLength={5000} rows={3} value={lessonForm.description} onChange={(event) => setLessonForm({ ...lessonForm, description: event.target.value })} /></label>
              <label className="field"><span>Lesson objectives</span><textarea maxLength={5000} rows={3} value={lessonForm.objectives} onChange={(event) => setLessonForm({ ...lessonForm, objectives: event.target.value })} /></label>
              <label className="checkbox-field"><input type="checkbox" checked={lessonForm.published} onChange={(event) => setLessonForm({ ...lessonForm, published: event.target.checked })} /><span>Publish this lesson to the class</span></label>
            </>}
            <div className="modal-actions"><button className="button button-quiet" type="button" onClick={() => setDialog(null)}>Cancel</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></div>
          </form>
        </section>
      </div>}
    </div>
  );
}
