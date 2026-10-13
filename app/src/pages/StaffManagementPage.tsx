import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { BriefcaseBusiness, Building2, Download, FilePlus2, FileText, GraduationCap, Plus, Save, Search, Trash2, UserRound, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type EmploymentStatus = 'active' | 'on_leave' | 'inactive' | 'terminated';
type StaffProfile = {
  id: string;
  profile_id: string | null;
  department_id: string | null;
  employee_number: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  job_title: string;
  employment_status: EmploymentStatus;
  hire_date: string | null;
};
type TeacherProfile = {
  id: string;
  staff_profile_id: string | null;
  qualifications: string;
  employment_status: EmploymentStatus;
};
type Department = { id: string; name: string };
type Choice = { id: string; name: string };
type Assignment = { teacher_id: string; class_id?: string; subject_id?: string };
type StaffDocument = {
  id: string;
  staff_id: string;
  file_name: string;
  storage_path: string;
  content_type: string;
  file_size: number;
  created_at: string;
};
type StaffForm = Omit<StaffProfile, 'id' | 'profile_id'> & {
  qualifications: string;
  is_teacher: boolean;
  class_ids: string[];
  subject_ids: string[];
};

const EMPTY_FORM: StaffForm = {
  department_id: null,
  employee_number: '',
  first_name: '',
  last_name: '',
  email: null,
  phone: null,
  job_title: '',
  employment_status: 'active',
  hire_date: null,
  qualifications: '',
  is_teacher: false,
  class_ids: [],
  subject_ids: [],
};
const ALLOWED_DOCUMENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const STATUS_LABELS: Record<EmploymentStatus, string> = {
  active: 'Active',
  on_leave: 'On leave',
  inactive: 'Inactive',
  terminated: 'Terminated',
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function emptyForm(): StaffForm {
  return { ...EMPTY_FORM, class_ids: [], subject_ids: [] };
}

export function StaffManagementPage() {
  const { activeMembership, user } = useAuth();
  const schoolId = activeMembership?.school_id;
  const isAdmin = activeMembership?.role === 'school_admin';
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [teachers, setTeachers] = useState<TeacherProfile[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [classes, setClasses] = useState<Choice[]>([]);
  const [subjects, setSubjects] = useState<Choice[]>([]);
  const [classAssignments, setClassAssignments] = useState<Assignment[]>([]);
  const [subjectAssignments, setSubjectAssignments] = useState<Assignment[]>([]);
  const [documents, setDocuments] = useState<StaffDocument[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState<StaffForm>(emptyForm);
  const [editingId, setEditingId] = useState('');
  const [query, setQuery] = useState('');
  const [departmentName, setDepartmentName] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    if (!schoolId) return;
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [staffResult, teacherResult, departmentResult, classResult, subjectResult, classAssignmentsResult, subjectAssignmentsResult] = await Promise.all([
        client.from('staff_profiles').select('id,profile_id,department_id,employee_number,first_name,last_name,email,phone,job_title,employment_status,hire_date').eq('school_id', schoolId).order('last_name').order('first_name'),
        client.from('teacher_profiles').select('id,staff_profile_id,qualifications,employment_status').eq('school_id', schoolId),
        client.from('school_departments').select('id,name').eq('school_id', schoolId).order('name'),
        client.from('school_classes').select('id,name').eq('school_id', schoolId).order('name'),
        client.from('subjects').select('id,name').eq('school_id', schoolId).order('name'),
        client.from('teacher_class_assignments').select('teacher_id,class_id').eq('school_id', schoolId),
        client.from('teacher_subjects').select('teacher_id,subject_id').eq('school_id', schoolId),
      ]);
      for (const response of [staffResult, teacherResult, departmentResult, classResult, subjectResult, classAssignmentsResult, subjectAssignmentsResult]) {
        if (response.error) throw response.error;
      }
      const records = (staffResult.data ?? []) as StaffProfile[];
      setStaff(records);
      setTeachers((teacherResult.data ?? []) as TeacherProfile[]);
      setDepartments((departmentResult.data ?? []) as Department[]);
      setClasses((classResult.data ?? []) as Choice[]);
      setSubjects((subjectResult.data ?? []) as Choice[]);
      setClassAssignments((classAssignmentsResult.data ?? []) as Assignment[]);
      setSubjectAssignments((subjectAssignmentsResult.data ?? []) as Assignment[]);
    } catch (loadError) {
      setError(errorMessage(loadError, 'Could not load the staff directory.'));
    } finally {
      setLoading(false);
    }
  }, [schoolId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const teacherByStaffId = useMemo(
    () => new Map(teachers.filter((teacher) => teacher.staff_profile_id).map((teacher) => [teacher.staff_profile_id as string, teacher])),
    [teachers],
  );
  const visibleStaff = staff.filter((person) => {
    const department = departments.find((item) => item.id === person.department_id)?.name ?? '';
    const needle = query.trim().toLowerCase();
    return !needle || `${person.first_name} ${person.last_name} ${person.employee_number} ${person.email ?? ''} ${person.job_title} ${department}`.toLowerCase().includes(needle);
  });
  const selectedStaff = staff.find((person) => person.id === selectedId) ?? null;
  const selectedTeacher = selectedStaff ? teacherByStaffId.get(selectedStaff.id) ?? null : null;

  useEffect(() => {
    if (!schoolId || !selectedId || !isAdmin) {
      setDocuments([]);
      return;
    }
    let alive = true;
    async function loadDocuments() {
      try {
        const { data, error: queryError } = await requireSupabase().from('staff_documents')
          .select('id,staff_id,file_name,storage_path,content_type,file_size,created_at')
          .eq('school_id', schoolId)
          .eq('staff_id', selectedId)
          .order('created_at', { ascending: false });
        if (queryError) throw queryError;
        if (alive) setDocuments((data ?? []) as StaffDocument[]);
      } catch (documentError) {
        if (alive) setError(errorMessage(documentError, 'Could not load staff documents.'));
      }
    }
    void loadDocuments();
    return () => { alive = false; };
  }, [schoolId, selectedId, isAdmin, refreshKey]);

  function startCreate() {
    setEditingId('');
    setSelectedId('');
    setForm(emptyForm());
    setShowCreateForm(true);
    setError('');
    setSuccess('');
  }

  function startEdit(person: StaffProfile) {
    const teacher = teacherByStaffId.get(person.id);
    setSelectedId(person.id);
    setEditingId(person.id);
    setForm({
      department_id: person.department_id,
      employee_number: person.employee_number,
      first_name: person.first_name,
      last_name: person.last_name,
      email: person.email,
      phone: person.phone,
      job_title: person.job_title,
      employment_status: person.employment_status,
      hire_date: person.hire_date,
      qualifications: teacher?.qualifications ?? '',
      is_teacher: Boolean(teacher),
      class_ids: teacher ? classAssignments.filter((item) => item.teacher_id === teacher.id).map((item) => item.class_id as string) : [],
      subject_ids: teacher ? subjectAssignments.filter((item) => item.teacher_id === teacher.id).map((item) => item.subject_id as string) : [],
    });
    setShowCreateForm(true);
    setError('');
    setSuccess('');
  }

  async function saveStaff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !user) return;
    if (!form.employee_number.trim() || !form.first_name.trim() || !form.last_name.trim()) {
      setError('Employee number, first name, and last name are required.');
      return;
    }
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const client = requireSupabase();
      const staffPayload = {
        school_id: schoolId,
        department_id: form.department_id || null,
        employee_number: form.employee_number.trim(),
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        email: form.email?.trim() || null,
        phone: form.phone?.trim() || null,
        job_title: form.job_title.trim(),
        employment_status: form.employment_status,
        hire_date: form.hire_date || null,
        updated_at: new Date().toISOString(),
      };
      const staffResponse = editingId
        ? await client.from('staff_profiles').update(staffPayload).eq('id', editingId).eq('school_id', schoolId).select().single()
        : await client.from('staff_profiles').insert(staffPayload).select().single();
      if (staffResponse.error) throw staffResponse.error;
      const savedStaff = staffResponse.data as StaffProfile;
      const existingTeacher = teacherByStaffId.get(savedStaff.id);
      let teacherId = existingTeacher?.id ?? '';
      if (form.is_teacher) {
        const teacherPayload = {
          school_id: schoolId,
          staff_profile_id: savedStaff.id,
          first_name: savedStaff.first_name,
          last_name: savedStaff.last_name,
          email: savedStaff.email,
          employee_number: savedStaff.employee_number,
          status: savedStaff.employment_status === 'active' ? 'active' : 'inactive',
          employment_status: savedStaff.employment_status,
          qualifications: form.qualifications.trim(),
        };
        const teacherResponse = existingTeacher
          ? await client.from('teacher_profiles').update(teacherPayload).eq('id', existingTeacher.id).eq('school_id', schoolId).select('id').single()
          : await client.from('teacher_profiles').insert(teacherPayload).select('id').single();
        if (teacherResponse.error) throw teacherResponse.error;
        teacherId = teacherResponse.data.id;
      } else if (existingTeacher) {
        const { error: teacherDeleteError } = await client.from('teacher_profiles').delete()
          .eq('id', existingTeacher.id).eq('school_id', schoolId);
        if (teacherDeleteError) throw teacherDeleteError;
      }

      if (teacherId) {
        const [classDelete, subjectDelete] = await Promise.all([
          client.from('teacher_class_assignments').delete().eq('school_id', schoolId).eq('teacher_id', teacherId),
          client.from('teacher_subjects').delete().eq('school_id', schoolId).eq('teacher_id', teacherId),
        ]);
        if (classDelete.error) throw classDelete.error;
        if (subjectDelete.error) throw subjectDelete.error;
        const [classInsert, subjectInsert] = await Promise.all([
          form.class_ids.length ? client.from('teacher_class_assignments').insert(form.class_ids.map((classId) => ({ school_id: schoolId, teacher_id: teacherId, class_id: classId }))) : Promise.resolve({ error: null }),
          form.subject_ids.length ? client.from('teacher_subjects').insert(form.subject_ids.map((subjectId) => ({ school_id: schoolId, teacher_id: teacherId, subject_id: subjectId }))) : Promise.resolve({ error: null }),
        ]);
        if (classInsert.error) throw classInsert.error;
        if (subjectInsert.error) throw subjectInsert.error;
      }
      setSelectedId(savedStaff.id);
      setShowCreateForm(false);
      setSuccess(editingId ? 'Staff profile updated.' : 'Staff profile added.');
      setRefreshKey((key) => key + 1);
    } catch (saveError) {
      setError(errorMessage(saveError, 'Could not save the staff profile.'));
    } finally {
      setSaving(false);
    }
  }

  async function addDepartment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !departmentName.trim()) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { data, error: insertError } = await requireSupabase().from('school_departments')
        .insert({ school_id: schoolId, name: departmentName.trim() })
        .select('id,name')
        .single();
      if (insertError) throw insertError;
      const department = data as Department;
      setDepartments((current) => [...current, department].sort((left, right) => left.name.localeCompare(right.name)));
      setDepartmentName('');
      setSuccess('Department created.');
    } catch (departmentError) {
      setError(errorMessage(departmentError, 'Could not create the department.'));
    } finally {
      setSaving(false);
    }
  }

  async function uploadStaffDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !selectedStaff || !user) return;
    const formElement = event.currentTarget;
    const file = (new FormData(formElement).get('staff_document')) as File | null;
    if (!file || file.size === 0) {
      setError('Choose a staff document to upload.');
      return;
    }
    if (!ALLOWED_DOCUMENT_TYPES.has(file.type)) {
      setError('Upload a PDF, JPEG, PNG, DOC, or DOCX document.');
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setError('Staff documents must be 50 MB or smaller.');
      return;
    }
    setUploading(true);
    setError('');
    setSuccess('');
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-160);
    const storagePath = `${schoolId}/${selectedStaff.id}/${crypto.randomUUID()}-${safeName}`;
    try {
      const client = requireSupabase();
      const { error: uploadError } = await client.storage.from('staff-documents')
        .upload(storagePath, file, { contentType: file.type, upsert: false });
      if (uploadError) throw uploadError;
      const { data, error: metadataError } = await client.from('staff_documents').insert({
        school_id: schoolId,
        staff_id: selectedStaff.id,
        uploaded_by: user.id,
        file_name: file.name.slice(0, 200),
        storage_path: storagePath,
        content_type: file.type,
        file_size: file.size,
      }).select('id,staff_id,file_name,storage_path,content_type,file_size,created_at').single();
      if (metadataError) {
        const { error: cleanupError } = await client.storage.from('staff-documents').remove([storagePath]);
        if (cleanupError) throw new Error(`Document details could not be saved, and the uploaded file could not be removed: ${metadataError.message}; ${cleanupError.message}`);
        throw metadataError;
      }
      setDocuments((current) => [data as StaffDocument, ...current]);
      formElement.reset();
      setSuccess('Staff document uploaded securely.');
    } catch (uploadError) {
      setError(errorMessage(uploadError, 'Could not upload the staff document.'));
    } finally {
      setUploading(false);
    }
  }

  async function downloadStaffDocument(document: StaffDocument) {
    try {
      const { data, error: linkError } = await requireSupabase().storage.from('staff-documents')
        .createSignedUrl(document.storage_path, 60);
      if (linkError) throw linkError;
      window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    } catch (downloadError) {
      setError(errorMessage(downloadError, 'Could not create a secure document link.'));
    }
  }

  async function deleteStaffDocument(document: StaffDocument) {
    if (!schoolId || !window.confirm(`Delete “${document.file_name}”? This cannot be undone.`)) return;
    setError('');
    setSuccess('');
    try {
      const client = requireSupabase();
      const { error: deleteMetadataError } = await client.from('staff_documents').delete()
        .eq('id', document.id).eq('school_id', schoolId);
      if (deleteMetadataError) throw deleteMetadataError;
      const { error: deleteFileError } = await client.storage.from('staff-documents').remove([document.storage_path]);
      if (deleteFileError) throw new Error(`Document record was deleted, but its stored file could not be removed: ${deleteFileError.message}`);
      setDocuments((current) => current.filter((item) => item.id !== document.id));
      setSuccess('Staff document deleted.');
    } catch (deleteError) {
      setError(errorMessage(deleteError, 'Could not delete the staff document.'));
    }
  }

  async function saveDepartmentAssignment(staffId: string, departmentId: string) {
    if (!schoolId) return;
    const { error: updateError } = await requireSupabase().from('staff_profiles')
      .update({ department_id: departmentId || null, updated_at: new Date().toISOString() })
      .eq('id', staffId).eq('school_id', schoolId);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setStaff((current) => current.map((person) => person.id === staffId ? { ...person, department_id: departmentId || null } : person));
    setSuccess('Department assignment updated.');
  }

  return (
    <div className="page-stack staff-management-page">
      <header className="page-heading">
        <div><span className="eyebrow">People &amp; organization</span><h1>Staff &amp; teachers</h1><p>Manage employee profiles, teacher qualifications, department assignments, and teaching allocations.</p></div>
        {isAdmin && <button className="button button-primary" onClick={startCreate}><Plus size={16} />Add staff profile</button>}
      </header>
      {error && <ErrorState message={error} />}
      {success && <SuccessMessage message={success} />}

      <div className="staff-management-layout">
        <section className="content-card staff-directory-card">
          <div className="section-heading"><div><span className="eyebrow">School directory</span><h2>Staff directory</h2></div><span className="table-count">{staff.length} staff</span></div>
          <label className="table-search staff-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, department, or employee ID" /></label>
          {loading ? <LoadingState label="Loading staff directory..." /> : visibleStaff.length ? <div className="staff-directory-list">
            {visibleStaff.map((person) => {
              const teacher = teacherByStaffId.get(person.id);
              const department = departments.find((item) => item.id === person.department_id);
              return <button key={person.id} className={`staff-directory-item${selectedId === person.id ? ' selected' : ''}`} onClick={() => { setSelectedId(person.id); setShowCreateForm(false); setError(''); setSuccess(''); }}>
                <span className="staff-avatar">{person.first_name.slice(0, 1)}{person.last_name.slice(0, 1)}</span>
                <span className="staff-directory-copy"><strong>{person.first_name} {person.last_name}</strong><small>{person.job_title || (teacher ? 'Teacher' : 'Staff member')}{department ? ` · ${department.name}` : ''}</small><small>{person.employee_number}</small></span>
                <span className={`staff-status staff-status-${person.employment_status}`}>{STATUS_LABELS[person.employment_status]}</span>
              </button>;
            })}
          </div> : <div className="staff-empty"><UserRound size={22} /><strong>{query ? 'No matching staff' : 'No staff profiles yet'}</strong><span>{isAdmin ? 'Add staff profiles to create your school directory.' : 'Your school staff will appear here.'}</span></div>}
          {isAdmin && <div className="staff-department-manager">
            <div><Building2 size={15} /><strong>Departments</strong></div>
            <form onSubmit={(event) => void addDepartment(event)}><input required maxLength={80} value={departmentName} onChange={(event) => setDepartmentName(event.target.value)} placeholder="New department name" /><button className="button button-quiet" disabled={saving}><Plus size={13} />Add</button></form>
            <div className="staff-department-tags">{departments.map((department) => <span key={department.id}>{department.name}</span>)}</div>
          </div>}
        </section>

        {showCreateForm && isAdmin ? <section className="content-card staff-profile-card">
          <div className="section-heading"><div><span className="eyebrow">{editingId ? 'Update staff record' : 'New staff record'}</span><h2>{editingId ? 'Edit staff profile' : 'Add staff profile'}</h2></div><button className="icon-button" aria-label="Close staff form" onClick={() => setShowCreateForm(false)}><X size={17} /></button></div>
          <form onSubmit={(event) => void saveStaff(event)}>
            <div className="staff-form-grid">
              <label className="field"><span>Employee number</span><input required maxLength={40} value={form.employee_number} onChange={(event) => setForm((current) => ({ ...current, employee_number: event.target.value }))} /></label>
              <label className="field"><span>Job title</span><input maxLength={100} value={form.job_title} onChange={(event) => setForm((current) => ({ ...current, job_title: event.target.value }))} placeholder="e.g. Science teacher" /></label>
              <label className="field"><span>First name</span><input required maxLength={80} value={form.first_name} onChange={(event) => setForm((current) => ({ ...current, first_name: event.target.value }))} /></label>
              <label className="field"><span>Last name</span><input required maxLength={80} value={form.last_name} onChange={(event) => setForm((current) => ({ ...current, last_name: event.target.value }))} /></label>
              <label className="field"><span>Email</span><input type="email" maxLength={254} value={form.email ?? ''} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value || null }))} /></label>
              <label className="field"><span>Phone</span><input type="tel" maxLength={40} value={form.phone ?? ''} onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value || null }))} /></label>
              <label className="field"><span>Department</span><select value={form.department_id ?? ''} onChange={(event) => setForm((current) => ({ ...current, department_id: event.target.value || null }))}><option value="">No department</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label>
              <label className="field"><span>Employment status</span><select value={form.employment_status} onChange={(event) => setForm((current) => ({ ...current, employment_status: event.target.value as EmploymentStatus }))}>{Object.entries(STATUS_LABELS).map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select></label>
              <label className="field"><span>Hire date</span><input type="date" value={form.hire_date ?? ''} onChange={(event) => setForm((current) => ({ ...current, hire_date: event.target.value || null }))} /></label>
            </div>
            <label className="staff-checkbox"><input type="checkbox" checked={form.is_teacher} onChange={(event) => setForm((current) => ({ ...current, is_teacher: event.target.checked }))} /><span><strong>Teacher profile</strong><small>Include teaching qualifications, subject expertise, and class/subject allocations.</small></span><GraduationCap size={19} /></label>
            {form.is_teacher && <>
              <label className="field"><span>Qualifications &amp; certifications</span><textarea rows={3} maxLength={2000} value={form.qualifications} onChange={(event) => setForm((current) => ({ ...current, qualifications: event.target.value }))} placeholder="Degrees, teaching certificates, and relevant experience" /></label>
              <div className="staff-assignment-grid">
                <fieldset><legend>Class allocations</legend>{classes.length ? classes.map((schoolClass) => <label key={schoolClass.id}><input type="checkbox" checked={form.class_ids.includes(schoolClass.id)} onChange={(event) => setForm((current) => ({ ...current, class_ids: event.target.checked ? [...current.class_ids, schoolClass.id] : current.class_ids.filter((id) => id !== schoolClass.id) }))} />{schoolClass.name}</label>) : <small>Add classes before assigning teachers.</small>}</fieldset>
                <fieldset><legend>Subject allocations</legend>{subjects.length ? subjects.map((subject) => <label key={subject.id}><input type="checkbox" checked={form.subject_ids.includes(subject.id)} onChange={(event) => setForm((current) => ({ ...current, subject_ids: event.target.checked ? [...current.subject_ids, subject.id] : current.subject_ids.filter((id) => id !== subject.id) }))} />{subject.name}</label>) : <small>Add subjects before assigning teachers.</small>}</fieldset>
              </div>
            </>}
            <div className="staff-form-actions"><button className="button button-primary" disabled={saving}><Save size={14} />{saving ? 'Saving...' : editingId ? 'Save profile' : 'Create staff profile'}</button><button className="button button-quiet" type="button" onClick={() => setShowCreateForm(false)}>Cancel</button></div>
          </form>
        </section> : selectedStaff ? <section className="content-card staff-profile-card">
          <div className="section-heading"><div><span className="eyebrow">{selectedStaff.employee_number}</span><h2>{selectedStaff.first_name} {selectedStaff.last_name}</h2></div>{isAdmin && <button className="button button-quiet" onClick={() => startEdit(selectedStaff)}><Save size={14} />Edit profile</button>}</div>
          <div className="staff-profile-facts">
            <div><span>Job title</span><strong>{selectedStaff.job_title || (selectedTeacher ? 'Teacher' : 'Staff member')}</strong></div>
            <div><span>Department</span>{isAdmin ? <select value={selectedStaff.department_id ?? ''} aria-label="Staff department assignment" onChange={(event) => void saveDepartmentAssignment(selectedStaff.id, event.target.value)}><option value="">No department</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select> : <strong>{departments.find((item) => item.id === selectedStaff.department_id)?.name ?? 'Not assigned'}</strong>}</div>
            <div><span>Employment</span><strong className={`staff-status staff-status-${selectedStaff.employment_status}`}>{STATUS_LABELS[selectedStaff.employment_status]}</strong></div>
            <div><span>Hire date</span><strong>{selectedStaff.hire_date ? new Date(`${selectedStaff.hire_date}T00:00:00`).toLocaleDateString() : 'Not recorded'}</strong></div>
            <div><span>Email</span><strong>{selectedStaff.email || 'Not recorded'}</strong></div>
            <div><span>Phone</span><strong>{selectedStaff.phone || 'Not recorded'}</strong></div>
          </div>
          {selectedTeacher && <div className="staff-teacher-detail"><h3><GraduationCap size={16} />Teacher details</h3><p>{selectedTeacher.qualifications || 'No qualifications recorded.'}</p><div><span><strong>Classes</strong>{classAssignments.filter((assignment) => assignment.teacher_id === selectedTeacher.id).map((assignment) => classes.find((item) => item.id === assignment.class_id)?.name).filter(Boolean).join(', ') || 'Not allocated'}</span><span><strong>Subjects</strong>{subjectAssignments.filter((assignment) => assignment.teacher_id === selectedTeacher.id).map((assignment) => subjects.find((item) => item.id === assignment.subject_id)?.name).filter(Boolean).join(', ') || 'Not allocated'}</span></div></div>}
          {isAdmin && <div className="staff-document-section">
            <div className="staff-document-heading"><div><FileText size={16} /><strong>Private staff documents</strong></div><span>{documents.length} files · visible to school administrators</span></div>
            <form className="staff-document-upload" onSubmit={(event) => void uploadStaffDocument(event)}><input required type="file" name="staff_document" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,application/pdf,image/jpeg,image/png,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" /><button className="button button-quiet" disabled={uploading}><FilePlus2 size={14} />{uploading ? 'Uploading...' : 'Upload document'}</button></form>
            {documents.length > 0 && <div className="staff-document-list">{documents.map((document) => <article key={document.id}><span><FileText size={15} /><strong>{document.file_name}</strong><small>{(document.file_size / 1024 / 1024).toFixed(2)} MB · {new Date(document.created_at).toLocaleDateString()}</small></span><button className="icon-button" title="Download securely" aria-label={`Download ${document.file_name}`} onClick={() => void downloadStaffDocument(document)}><Download size={14} /></button><button className="icon-button staff-delete-document" title="Delete document" aria-label={`Delete ${document.file_name}`} onClick={() => void deleteStaffDocument(document)}><Trash2 size={14} /></button></article>)}</div>}
          </div>}
        </section> : <section className="content-card staff-profile-empty"><BriefcaseBusiness size={25} /><strong>Select a staff member</strong><span>View their department, employment details, teacher allocations, and documents.</span></section>}
      </div>
    </div>
  );
}
