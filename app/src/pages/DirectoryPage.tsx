import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Plus, Search, SlidersHorizontal, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { requireSupabase } from '../lib/supabase';
import type { SchoolClass, Student, Subject } from '../types/database';
import { EmptyState, ErrorState, LoadingState } from '../components/Feedback';

type Kind = 'students' | 'teachers' | 'classes' | 'subjects';
type DirectoryRow = Student | SchoolClass | Subject | { id: string; first_name: string; last_name: string; email: string | null; status: string };
type ClassCalendar = { id: string; name: string; division_name: string | null; is_default: boolean };
type ClassAcademicYear = { id: string; name: string; calendar_id: string; is_current: boolean };

const config: Record<Kind, { title: string; description: string; singular: string; searchHint: string }> = {
  students: { title: 'Students', description: 'Manage student records, enrollment, and class placement.', singular: 'student', searchHint: 'Search name or student ID' },
  teachers: { title: 'Teachers', description: 'Manage teacher profiles and active staff records.', singular: 'teacher', searchHint: 'Search teachers' },
  classes: { title: 'Classes', description: 'Organize learners into classes and academic groups.', singular: 'class', searchHint: 'Search classes' },
  subjects: { title: 'Subjects', description: 'Maintain the subjects offered by your school.', singular: 'subject', searchHint: 'Search subjects' },
};

export function DirectoryPage({ kind }: { kind: Kind }) {
  const { activeMembership, activeMembership: membership, user } = useAuth();
  const [rows, setRows] = useState<DirectoryRow[]>([]);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [classCalendars, setClassCalendars] = useState<ClassCalendar[]>([]);
  const [classAcademicYears, setClassAcademicYears] = useState<ClassAcademicYear[]>([]);
  const [subjectDepartments, setSubjectDepartments] = useState<{ id: string; name: string }[]>([]);
  const [isHod, setIsHod] = useState(false);
  const [classCalendarId, setClassCalendarId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [formSuccess, setFormSuccess] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const meta = config[kind];
  const canManage = membership?.role === 'school_admin' || membership?.role === 'system_admin';
  const canManageSubjects = canManage || membership?.role === 'academic_coordinator' || (kind === 'subjects' && isHod);

  const load = useCallback(async () => {
    if (!activeMembership) return;
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const schoolId = activeMembership.school_id;
      if (kind === 'students') {
        const [students, classRows] = await Promise.all([
          client.from('students').select('id,school_id,student_number,first_name,last_name,email,date_of_birth,status,class_id,created_at,school_classes(name)').eq('school_id', schoolId).order('last_name').range(0, 99),
          client.from('school_classes').select('id,school_id,name,grade_level,academic_year_id,created_at').eq('school_id', schoolId).order('name'),
        ]);
        if (students.error) throw students.error;
        if (classRows.error) throw classRows.error;
        setRows((students.data ?? []) as unknown as Student[]);
        setClasses(classRows.data ?? []);
      } else if (kind === 'teachers') {
        const { data, error: queryError } = await client.from('teacher_profiles').select('id,first_name,last_name,email,status').eq('school_id', schoolId).order('last_name').range(0, 99);
        if (queryError) throw queryError;
        setRows(data ?? []);
      } else if (kind === 'classes') {
        const [classResult, calendarResult, yearResult] = await Promise.all([
          client.from('school_classes').select('id,school_id,name,grade_level,academic_year_id,created_at').eq('school_id', schoolId).order('name').range(0, 99),
          client.from('academic_calendars').select('id,name,division_name,is_default').eq('school_id', schoolId).order('name'),
          client.from('academic_years').select('id,name,calendar_id,is_current').eq('school_id', schoolId).order('start_date', { ascending: false }),
        ]);
        if (classResult.error) throw classResult.error;
        if (calendarResult.error) throw calendarResult.error;
        if (yearResult.error) throw yearResult.error;
        const calendars = (calendarResult.data ?? []) as ClassCalendar[];
        setRows(classResult.data ?? []);
        setClassCalendars(calendars);
        setClassAcademicYears((yearResult.data ?? []) as ClassAcademicYear[]);
        setClassCalendarId((current) => calendars.some((calendar) => calendar.id === current)
          ? current
          : calendars.find((calendar) => calendar.is_default)?.id ?? calendars[0]?.id ?? '');
      } else {
        const { data, error: queryError } = await client.from('subjects').select('id,school_id,name,code,department_id,created_at').eq('school_id', schoolId).order('name').range(0, 99);
        if (queryError) throw queryError;
        setRows(data ?? []);
        const departmentsResult = await client.from('school_departments').select('id,name').eq('school_id', schoolId).order('name');
        if (departmentsResult.error) throw departmentsResult.error;
        setSubjectDepartments(departmentsResult.data ?? []);
        if (membership?.role === 'teacher' && user?.id) {
          const { data: teacherRows, error: teacherError } = await client.from('teacher_profiles').select('id').eq('school_id', schoolId).eq('profile_id', user.id);
          if (teacherError) throw teacherError;
          const teacherIds = (teacherRows ?? []).map((teacher) => teacher.id);
          if (teacherIds.length) {
            const { data: responsibilityRows, error: responsibilityError } = await client.from('teacher_responsibilities')
              .select('department_id').eq('school_id', schoolId).eq('responsibility_type', 'head_of_department').in('teacher_id', teacherIds);
            if (responsibilityError) throw responsibilityError;
            const hodDepartmentIds = new Set((responsibilityRows ?? []).flatMap((item) => item.department_id ? [item.department_id] : []));
            setIsHod(hodDepartmentIds.size > 0);
            setSubjectDepartments((departmentsResult.data ?? []).filter((department) => hodDepartmentIds.has(department.id)));
          } else {
            setIsHod(false);
            setSubjectDepartments([]);
          }
        } else {
          setIsHod(false);
          if (!canManageSubjects) setSubjectDepartments([]);
        }
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : `Could not load ${meta.title.toLowerCase()}.`);
    } finally {
      setLoading(false);
    }
  }, [activeMembership, kind, meta.title, membership?.role, user?.id, canManage, canManageSubjects]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const filteredRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const scopedRows = kind === 'subjects' && isHod
      ? rows.filter((row) => subjectDepartments.some((department) => department.id === (row as Subject).department_id))
      : rows;
    if (!needle) return scopedRows;
    return scopedRows.filter((row) => {
      if (kind === 'students') {
        const student = row as Student;
        return `${student.first_name} ${student.last_name} ${student.student_number} ${student.email ?? ''}`.toLowerCase().includes(needle);
      }
      if (kind === 'teachers') {
        const teacher = row as Extract<DirectoryRow, { first_name: string }>;
        return `${teacher.first_name} ${teacher.last_name} ${teacher.email ?? ''}`.toLowerCase().includes(needle);
      }
      if (kind === 'classes') return (row as SchoolClass).name.toLowerCase().includes(needle);
      const subject = row as Subject;
      return `${subject.name} ${subject.code ?? ''} ${subjectDepartments.find((item) => item.id === subject.department_id)?.name ?? ''}`.toLowerCase().includes(needle);
    });
  }, [rows, query, kind, subjectDepartments, isHod]);

  async function addRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeMembership) return;
    const formData = new FormData(event.currentTarget);
    setSaving(true);
    setFormError('');
    setFormSuccess('');
    try {
      const client = requireSupabase();
      const schoolId = activeMembership.school_id;
      let result;
      if (kind === 'students') {
        result = await client.from('students').insert({
          school_id: schoolId,
          student_number: String(formData.get('student_number')).trim(),
          first_name: String(formData.get('first_name')).trim(),
          last_name: String(formData.get('last_name')).trim(),
          email: String(formData.get('email')).trim() || null,
          date_of_birth: String(formData.get('date_of_birth')) || null,
          class_id: String(formData.get('class_id')) || null,
        });
      } else if (kind === 'teachers') {
        result = await client.from('teacher_profiles').insert({
          school_id: schoolId,
          first_name: String(formData.get('first_name')).trim(),
          last_name: String(formData.get('last_name')).trim(),
          email: String(formData.get('email')).trim() || null,
        });
      } else if (kind === 'classes') {
        const calendarId = String(formData.get('calendar_id')) || null;
        result = await client.from('school_classes').insert({
          school_id: schoolId,
          name: String(formData.get('name')).trim(),
          grade_level: String(formData.get('grade_level')).trim() || null,
          calendar_id: calendarId,
          academic_year_id: String(formData.get('academic_year_id')) || null,
        });
      } else {
        result = await client.from('subjects').insert({
          school_id: schoolId,
          name: String(formData.get('name')).trim(),
          code: String(formData.get('code')).trim() || null,
          department_id: String(formData.get('department_id')) || null,
        });
      }
      if (result.error) throw result.error;
      setFormSuccess(`${meta.singular[0].toUpperCase()}${meta.singular.slice(1)} added.`);
      setShowForm(false);
      setRefreshKey((key) => key + 1);
    } catch (saveError) {
      setFormError(saveError instanceof Error ? saveError.message : `Could not save ${meta.singular}.`);
    } finally {
      setSaving(false);
    }
  }

  async function saveSubjectDepartment(subjectId: string, departmentId: string) {
    if (!activeMembership || kind !== 'subjects') return;
    const { error: updateError } = await requireSupabase().from('subjects')
      .update({ department_id: departmentId || null, updated_at: new Date().toISOString() })
      .eq('school_id', activeMembership.school_id).eq('id', subjectId);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setRows((current) => current.map((row) => row.id === subjectId
      ? { ...row, department_id: departmentId || null } as DirectoryRow
      : row));
    setFormSuccess('Subject department assignment updated.');
  }

  const personRow = (row: DirectoryRow) => {
    const person = row as Student;
    return <tr key={row.id}><td><span className="table-person"><span className="avatar avatar-small">{person.first_name.slice(0, 1)}{person.last_name.slice(0, 1)}</span><span><strong>{person.first_name} {person.last_name}</strong><small>{person.email || 'No email added'}</small></span></span></td>{kind === 'students' && <><td className="mono-cell">{person.student_number}</td><td>{person.school_classes?.name ?? 'Not assigned'}</td></>}<td><span className={`status-pill ${(person.status ?? 'active') === 'active' ? 'status-active' : 'status-muted'}`}>{person.status ?? 'active'}</span></td></tr>;
  };

  return (
    <div className="page-stack">
      <div className="page-heading"><div><span className="eyebrow">{activeMembership?.school.name}</span><h1>{meta.title}</h1><p>{meta.description}</p></div>{(kind === 'subjects' ? canManageSubjects : canManage) && <button className="button button-primary" onClick={() => { setShowForm(true); setFormError(''); setFormSuccess(''); }}><Plus size={17} /> Add {meta.singular}</button>}</div>
      {formSuccess && <p className="inline-success" role="status">{formSuccess}</p>}
      {error && <ErrorState message={error} />}
      {kind === 'subjects' && isHod && <p className="inline-success">Head of Department access: you can manage subjects assigned to your department.</p>}
      <section className="content-card table-card">
        <div className="table-toolbar"><label className="table-search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={meta.searchHint} aria-label={meta.searchHint} /></label><span className="table-count"><SlidersHorizontal size={15} />{filteredRows.length} records</span></div>
        {loading ? <LoadingState label={`Loading ${meta.title.toLowerCase()}…`} /> : filteredRows.length === 0 ? <EmptyState title={query ? 'No matching records' : `No ${meta.title.toLowerCase()} yet`} detail={query ? 'Try a different search term.' : (kind === 'subjects' ? canManageSubjects : canManage) ? `Add your first ${meta.singular} to begin building your school records.` : `Records will appear here when your school adds ${meta.title.toLowerCase()}.`} /> : kind === 'students' || kind === 'teachers' ? <div className="table-scroll"><table><thead><tr><th>Name</th>{kind === 'students' && <><th>Student ID</th><th>Class</th></>}<th>Status</th></tr></thead><tbody>{filteredRows.map(personRow)}</tbody></table></div> : <div className="table-scroll"><table><thead><tr><th>{kind === 'classes' ? 'Class name' : 'Subject'}</th><th>{kind === 'classes' ? 'Grade level' : 'Code'}</th>{kind === 'subjects' && <th>Department</th>}<th>Created</th></tr></thead><tbody>{filteredRows.map((row) => { const createdAt = kind === 'classes' ? (row as SchoolClass).created_at : (row as Subject).created_at; return kind === 'classes' ? <tr key={row.id}><td><strong>{(row as SchoolClass).name}</strong></td><td>{(row as SchoolClass).grade_level ?? '—'}</td><td>{new Date(createdAt).toLocaleDateString()}</td></tr> : <tr key={row.id}><td><strong>{(row as Subject).name}</strong></td><td className="mono-cell">{(row as Subject).code ?? '—'}</td><td>{canManageSubjects ? <select aria-label={`${(row as Subject).name} department`} value={(row as Subject).department_id ?? ''} onChange={(event) => void saveSubjectDepartment(row.id, event.target.value)}><option value="">Not assigned</option>{subjectDepartments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select> : subjectDepartments.find((department) => department.id === (row as Subject).department_id)?.name ?? '—'}</td><td>{new Date(createdAt).toLocaleDateString()}</td></tr>; })}</tbody></table></div>}
      </section>
      {showForm && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowForm(false); }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="record-modal-title"><div className="modal-heading"><div><span className="eyebrow">School records</span><h2 id="record-modal-title">Add {meta.singular}</h2></div><button className="icon-button" onClick={() => setShowForm(false)} aria-label="Close dialog"><X size={19} /></button></div><form className="modal-form" onSubmit={addRecord}>
        {kind === 'students' || kind === 'teachers' ? <><div className="form-row"><label className="field"><span>First name</span><input required name="first_name" maxLength={80} /></label><label className="field"><span>Last name</span><input required name="last_name" maxLength={80} /></label></div><label className="field"><span>Email <small>(optional)</small></span><input name="email" type="email" maxLength={254} /></label>{kind === 'students' && <><label className="field"><span>Student ID</span><input required name="student_number" maxLength={40} /></label><div className="form-row"><label className="field"><span>Date of birth <small>(optional)</small></span><input name="date_of_birth" type="date" /></label><label className="field"><span>Class <small>(optional)</small></span><select name="class_id" defaultValue=""><option value="">Not assigned</option>{classes.map((schoolClass) => <option key={schoolClass.id} value={schoolClass.id}>{schoolClass.name}</option>)}</select></label></div></>}</> : kind === 'classes' ? <><label className="field"><span>Class name</span><input required name="name" maxLength={100} placeholder="e.g. Grade 7 Blue" /></label><label className="field"><span>Grade level <small>(optional)</small></span><input name="grade_level" maxLength={50} placeholder="e.g. Grade 7" /></label><label className="field"><span>Academic calendar / division</span><select required name="calendar_id" value={classCalendarId} onChange={(event) => setClassCalendarId(event.target.value)}>{classCalendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}{calendar.division_name ? ` · ${calendar.division_name}` : calendar.is_default ? ' · Default' : ''}</option>)}</select></label><label className="field"><span>Academic year <small>(optional)</small></span><select name="academic_year_id" defaultValue=""><option value="">Not assigned</option>{classAcademicYears.filter((year) => year.calendar_id === classCalendarId).map((academicYear) => <option key={academicYear.id} value={academicYear.id}>{academicYear.name}{academicYear.is_current ? ' · Current' : ''}</option>)}</select></label></> : <><label className="field"><span>Subject name</span><input required name="name" maxLength={100} placeholder="e.g. Mathematics" /></label><label className="field"><span>Subject code <small>(optional)</small></span><input name="code" maxLength={20} /></label><label className="field"><span>Department</span><select required={isHod} name="department_id" defaultValue=""><option value="">{isHod ? 'Choose your department' : 'No department'}</option>{subjectDepartments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label></>}
        {formError && <ErrorState message={formError} />}<div className="modal-actions"><button className="button button-quiet" type="button" onClick={() => setShowForm(false)}>Cancel</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : `Save ${meta.singular}`}</button></div>
      </form></section></div>}
    </div>
  );
}
