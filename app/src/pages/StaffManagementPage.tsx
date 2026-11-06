import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { BriefcaseBusiness, Building2, CalendarCheck, CalendarDays, Clock3, Download, FileBadge2, FilePlus2, FileText, GraduationCap, MailPlus, Plus, Save, Search, Trash2, UserRound, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';
import type { AppRole } from '../types/database';
import { StaffOperationsPanel } from './StaffOperationsPanel';

type EmploymentStatus = 'active' | 'on_leave' | 'inactive' | 'terminated';
type InvitableRole = Exclude<AppRole, 'system_admin' | 'school_admin' | 'academic_coordinator' | 'student' | 'parent'>;
const invitableRoles: { value: InvitableRole; label: string }[] = [
  { value: 'teacher', label: 'Teacher' },
  { value: 'finance_manager', label: 'Finance manager' },
  { value: 'accountant', label: 'Accountant' },
  { value: 'bursar', label: 'Bursar / fees officer' },
  { value: 'cashier', label: 'Cashier' },
  { value: 'accounts_payable_officer', label: 'Accounts payable officer' },
  { value: 'auditor', label: 'Auditor / read-only reviewer' },
  { value: 'librarian', label: 'Librarian' },
  { value: 'website_editor', label: 'Website editor' },
  { value: 'website_publisher', label: 'Website publisher' },
  { value: 'admissions_officer', label: 'Admissions officer' },
  { value: 'hr_staff_administrator', label: 'HR / staff administrator' },
  { value: 'transport_manager', label: 'Transport manager' },
  { value: 'facilities_manager', label: 'Facilities manager' },
  { value: 'it_support_technician', label: 'IT support technician' },
  { value: 'safeguarding_officer', label: 'Safeguarding officer' },
  { value: 'procurement_officer', label: 'Procurement officer' },
  { value: 'compliance_audit_officer', label: 'Compliance / audit officer' },
  { value: 'nurse', label: 'School nurse' },
  { value: 'doctor', label: 'School doctor' },
  { value: 'secretary', label: 'Secretary' },
];
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
  profile_id: string | null;
  staff_profile_id: string | null;
  qualifications: string;
  employment_status: EmploymentStatus;
};
type Department = { id: string; name: string };
type StaffAccount = { profile_id: string; role: string };
type TeacherResponsibility = {
  teacher_id: string;
  responsibility_type: 'class_teacher' | 'head_of_department';
  class_id: string | null;
  department_id: string | null;
};
type Choice = { id: string; name: string; department_id?: string | null };
type Assignment = { teacher_id: string; class_id?: string; subject_id?: string };
type StaffDocument = {
  id: string;
  staff_id: string;
  file_name: string;
  storage_path: string;
  content_type: string;
  file_size: number;
  created_at: string;
  document_type: 'employment' | 'identity' | 'qualification' | 'safeguarding' | 'medical' | 'other';
  expires_on: string | null;
};
type WorkloadEntry = { day_of_week: number; starts_at: string; ends_at: string; subject: { name: string } | { name: string }[] | null; class: { name: string } | { name: string }[] | null; schedule: { status: string } | { status: string }[] | null };
type StaffForm = Omit<StaffProfile, 'id' | 'profile_id'> & {
  qualifications: string;
  is_teacher: boolean;
  class_ids: string[];
  subject_ids: string[];
  class_teacher_ids: string[];
  hod_department_ids: string[];
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
  class_teacher_ids: [],
  hod_department_ids: [],
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
  return { ...EMPTY_FORM, class_ids: [], subject_ids: [], class_teacher_ids: [], hod_department_ids: [] };
}

export function StaffManagementPage() {
  const { activeMembership, user } = useAuth();
  const schoolId = activeMembership?.school_id;
  const isAdmin = activeMembership?.role === 'school_admin';
  const isHrStaffAdmin = activeMembership?.role === 'hr_staff_administrator';
  const canManageDirectory = isAdmin || isHrStaffAdmin;
  const [responsibilities, setResponsibilities] = useState<TeacherResponsibility[]>([]);
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [teachers, setTeachers] = useState<TeacherProfile[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [staffAccounts, setStaffAccounts] = useState<StaffAccount[]>([]);
  const [classes, setClasses] = useState<Choice[]>([]);
  const [subjects, setSubjects] = useState<Choice[]>([]);
  const [classAssignments, setClassAssignments] = useState<Assignment[]>([]);
  const [subjectAssignments, setSubjectAssignments] = useState<Assignment[]>([]);
  const [documents, setDocuments] = useState<StaffDocument[]>([]);
  const [workloadEntries, setWorkloadEntries] = useState<WorkloadEntry[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState<StaffForm>(emptyForm);
  const [editingId, setEditingId] = useState('');
  const [query, setQuery] = useState('');
  const [departmentName, setDepartmentName] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showTeacherInvite, setShowTeacherInvite] = useState(false);
  const [inviteRole, setInviteRole] = useState<InvitableRole>('teacher');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [invitingTeacher, setInvitingTeacher] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [success, setSuccess] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [staffSection, setStaffSection] = useState<'directory' | 'credentials' | 'attendance' | 'leave' | 'payroll'>('directory');

  const load = useCallback(async () => {
    if (!schoolId) return;
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [staffResult, teacherResult, departmentResult, classResult, subjectResult, classAssignmentsResult, subjectAssignmentsResult, responsibilityResult, accountResult] = await Promise.all([
        client.from('staff_profiles').select('id,profile_id,department_id,employee_number,first_name,last_name,email,phone,job_title,employment_status,hire_date').eq('school_id', schoolId).order('last_name').order('first_name'),
        client.from('teacher_profiles').select('id,profile_id,staff_profile_id,qualifications,employment_status').eq('school_id', schoolId),
        client.from('school_departments').select('id,name').eq('school_id', schoolId).order('name'),
        client.from('school_classes').select('id,name').eq('school_id', schoolId).order('name'),
        client.from('subjects').select('id,name,department_id').eq('school_id', schoolId).order('name'),
        client.from('teacher_class_assignments').select('teacher_id,class_id').eq('school_id', schoolId),
        client.from('teacher_subjects').select('teacher_id,subject_id').eq('school_id', schoolId),
        isHrStaffAdmin
          ? Promise.resolve({ data: [], error: null })
          : client.from('teacher_responsibilities').select('teacher_id,responsibility_type,class_id,department_id').eq('school_id', schoolId),
        isHrStaffAdmin
          ? Promise.resolve({ data: [], error: null })
          : client.from('school_memberships').select('profile_id,role').eq('school_id', schoolId),
      ]);
      for (const response of [staffResult, teacherResult, departmentResult, classResult, subjectResult, classAssignmentsResult, subjectAssignmentsResult, responsibilityResult, accountResult]) {
        if (response.error) throw response.error;
      }
      const records = (staffResult.data ?? []) as StaffProfile[];
      setStaff(records);
      setTeachers((teacherResult.data ?? []) as TeacherProfile[]);
      setDepartments((departmentResult.data ?? []) as Department[]);
      setStaffAccounts((accountResult.data ?? []) as StaffAccount[]);
      setClasses((classResult.data ?? []) as Choice[]);
      setSubjects((subjectResult.data ?? []) as Choice[]);
      setClassAssignments((classAssignmentsResult.data ?? []) as Assignment[]);
      setSubjectAssignments((subjectAssignmentsResult.data ?? []) as Assignment[]);
      setResponsibilities((responsibilityResult.data ?? []) as TeacherResponsibility[]);
    } catch (loadError) {
      setError(errorMessage(loadError, 'Could not load the staff directory.'));
    } finally {
      setLoading(false);
    }
  }, [isHrStaffAdmin, schoolId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const teacherByStaffId = useMemo(
    () => new Map(teachers.filter((teacher) => teacher.staff_profile_id).map((teacher) => [teacher.staff_profile_id as string, teacher])),
    [teachers],
  );
  const hodDepartmentIds = useMemo(() => {
    const currentTeacherIds = new Set(teachers.filter((teacher) => teacher.profile_id === user?.id).map((teacher) => teacher.id));
    return new Set(responsibilities
      .filter((item) => item.responsibility_type === 'head_of_department' && currentTeacherIds.has(item.teacher_id) && item.department_id)
      .map((item) => item.department_id as string));
  }, [teachers, responsibilities, user?.id]);
  const isHod = hodDepartmentIds.size > 0;
  const visibleSubjects = isAdmin ? subjects : subjects.filter((subject) => subject.department_id && hodDepartmentIds.has(subject.department_id));
  const visibleDepartments = canManageDirectory ? departments : departments.filter((department) => hodDepartmentIds.has(department.id));
  const visibleStaff = staff.filter((person) => {
    const department = departments.find((item) => item.id === person.department_id)?.name ?? '';
    const needle = query.trim().toLowerCase();
    const withinDepartment = canManageDirectory || (person.department_id !== null && hodDepartmentIds.has(person.department_id));
    return withinDepartment && (!needle || `${person.first_name} ${person.last_name} ${person.employee_number} ${person.email ?? ''} ${person.job_title} ${department}`.toLowerCase().includes(needle));
  });
  const selectedStaff = staff.find((person) => person.id === selectedId) ?? null;
  const selectedTeacher = selectedStaff ? teacherByStaffId.get(selectedStaff.id) ?? null : null;
  const canEditSelectedStaff = canManageDirectory || Boolean(selectedStaff?.department_id && hodDepartmentIds.has(selectedStaff.department_id));
  const selectedResponsibilities = selectedTeacher
    ? responsibilities.filter((item) => item.teacher_id === selectedTeacher.id)
    : [];

  useEffect(() => {
    if (!schoolId || !selectedId || (!isAdmin && !isHrStaffAdmin)) {
      setDocuments([]);
      return;
    }
    let alive = true;
    async function loadDocuments() {
      try {
        const { data, error: queryError } = await requireSupabase().from('staff_documents')
          .select('id,staff_id,file_name,storage_path,content_type,file_size,created_at,document_type,expires_on')
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
  }, [schoolId, selectedId, isAdmin, isHrStaffAdmin, refreshKey]);

  useEffect(() => {
    if (!schoolId || !selectedTeacher) {
      setWorkloadEntries([]);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const { data, error: workloadError } = await requireSupabase().from('timetable')
          .select('day_of_week,starts_at,ends_at,subject:subjects(name),class:school_classes(name),schedule:timetable_schedules(status)')
          .eq('school_id', schoolId).eq('teacher_id', selectedTeacher.id).eq('entry_type', 'lesson');
        if (workloadError) throw workloadError;
        if (alive) setWorkloadEntries((data ?? []) as unknown as WorkloadEntry[]);
      } catch (workloadError) {
        if (alive) setError(errorMessage(workloadError, 'Could not load teacher workload.'));
      }
    })();
    return () => { alive = false; };
  }, [schoolId, selectedTeacher]);

  function startCreate() {
    setEditingId('');
    setSelectedId('');
    setForm(emptyForm());
    setShowTeacherInvite(false);
    setShowCreateForm(true);
    setError('');
    setSuccess('');
  }

  async function inviteTeacher(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !isAdmin) return;
    const formElement = event.currentTarget;
    setInvitingTeacher(true);
    setInviteError('');
    setSuccess('');
    try {
      const formData = new FormData(formElement);
      const { data, error: inviteFunctionError } = await requireSupabase().functions.invoke('staff-invite', {
        body: {
          schoolId,
          fullName: String(formData.get('full_name') ?? '').trim(),
          email: String(formData.get('email') ?? '').trim(),
          employeeNumber: String(formData.get('employee_number') ?? '').trim(),
          role: inviteRole,
        },
      });
      if (inviteFunctionError) {
        const response = inviteFunctionError.context instanceof Response
          ? await inviteFunctionError.context.json() as { error?: string }
          : null;
        throw new Error(response?.error ?? inviteFunctionError.message);
      }
      if (data?.error) throw new Error(data.error);
      formElement.reset();
      setShowTeacherInvite(false);
      setSuccess(inviteRole === 'teacher'
        ? 'Teacher invitation sent. After accepting, they can sign in to their teaching dashboard. Assign classes and subjects from the staff profile.'
        : `${invitableRoles.find((role) => role.value === inviteRole)?.label ?? 'Staff'} invitation sent. The role has access only to its authorized school workspace.`);
      setRefreshKey((key) => key + 1);
    } catch (inviteError) {
      setInviteError(errorMessage(inviteError, 'The teacher invitation could not be sent.'));
    } finally {
      setInvitingTeacher(false);
    }
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
      is_teacher: isAdmin && Boolean(teacher),
      class_ids: teacher ? classAssignments.filter((item) => item.teacher_id === teacher.id).map((item) => item.class_id as string) : [],
      subject_ids: teacher ? subjectAssignments
        .filter((item) => item.teacher_id === teacher.id && (isAdmin || visibleSubjects.some((subject) => subject.id === item.subject_id)))
        .map((item) => item.subject_id as string) : [],
      class_teacher_ids: teacher ? responsibilities
        .filter((item) => item.teacher_id === teacher.id && item.responsibility_type === 'class_teacher' && item.class_id)
        .map((item) => item.class_id as string) : [],
      hod_department_ids: teacher ? responsibilities
        .filter((item) => item.teacher_id === teacher.id && item.responsibility_type === 'head_of_department' && item.department_id)
        .map((item) => item.department_id as string) : [],
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
      let teacherId = isAdmin ? existingTeacher?.id ?? '' : '';
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
      } else if (existingTeacher && isAdmin) {
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
        if (isAdmin) {
          const { error: responsibilityDeleteError } = await client.from('teacher_responsibilities')
            .delete().eq('school_id', schoolId).eq('teacher_id', teacherId);
          if (responsibilityDeleteError) throw responsibilityDeleteError;
          const classResponsibilities = form.class_teacher_ids.map((classId) => ({
            school_id: schoolId,
            teacher_id: teacherId,
            responsibility_type: 'class_teacher' as const,
            class_id: classId,
            assigned_by: user.id,
          }));
          const hodResponsibilities = form.hod_department_ids.map((departmentId) => ({
            school_id: schoolId,
            teacher_id: teacherId,
            responsibility_type: 'head_of_department' as const,
            department_id: departmentId,
            assigned_by: user.id,
          }));
          const responsibilityRows = [...classResponsibilities, ...hodResponsibilities];
          if (responsibilityRows.length) {
            if (form.class_teacher_ids.length) {
              const { error: clearClassLeadsError } = await client.from('teacher_responsibilities')
                .delete().eq('school_id', schoolId).eq('responsibility_type', 'class_teacher').in('class_id', form.class_teacher_ids);
              if (clearClassLeadsError) throw clearClassLeadsError;
            }
            if (form.hod_department_ids.length) {
              const { error: clearDepartmentHeadsError } = await client.from('teacher_responsibilities')
                .delete().eq('school_id', schoolId).eq('responsibility_type', 'head_of_department').in('department_id', form.hod_department_ids);
              if (clearDepartmentHeadsError) throw clearDepartmentHeadsError;
            }
            const { error: responsibilityInsertError } = await client.from('teacher_responsibilities')
              .insert(responsibilityRows);
            if (responsibilityInsertError) throw responsibilityInsertError;
          }
        }
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
      const uploadForm = new FormData(formElement);
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
        document_type: String(uploadForm.get('document_type') ?? 'other'),
        expires_on: String(uploadForm.get('expires_on') ?? '') || null,
      }).select('id,staff_id,file_name,storage_path,content_type,file_size,created_at,document_type,expires_on').single();
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

  function exportStaffDirectory() {
    const records = visibleStaff.map((person) => {
      const teacher = teacherByStaffId.get(person.id);
      const department = departments.find((item) => item.id === person.department_id)?.name ?? '';
      const accountProfile = person.profile_id ?? teacher?.profile_id ?? '';
      const linkedRole = staffAccounts.find((membership) => membership.profile_id === accountProfile)?.role ?? '';
      const classesForTeacher = teacher ? classAssignments.filter((assignment) => assignment.teacher_id === teacher.id)
        .map((assignment) => classes.find((item) => item.id === assignment.class_id)?.name).filter(Boolean).join('; ') : '';
      const subjectsForTeacher = teacher ? subjectAssignments.filter((assignment) => assignment.teacher_id === teacher.id)
        .map((assignment) => subjects.find((item) => item.id === assignment.subject_id)?.name).filter(Boolean).join('; ') : '';
      return {
        employee_number: person.employee_number,
        first_name: person.first_name,
        last_name: person.last_name,
        email: person.email ?? '',
        phone: person.phone ?? '',
        job_title: person.job_title,
        department,
        employment_status: person.employment_status,
        hire_date: person.hire_date ?? '',
        linked_school_role: linkedRole,
        teacher_classes: classesForTeacher,
        teacher_subjects: subjectsForTeacher,
      };
    });
    if (!records.length) {
      setError('There are no staff profiles in the current directory view to export.');
      return;
    }
    const columns = Object.keys(records[0]) as (keyof typeof records[number])[];
    const csvValue = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const csv = [columns.join(','), ...records.map((record) => columns.map((column) => csvValue(record[column])).join(','))].join('\r\n');
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `staff-directory-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSuccess(`Exported ${records.length} authorized staff directory record(s).`);
  }

  return (
    <div className="page-stack staff-management-page">
      <header className="page-heading">
        <div><span className="eyebrow">People &amp; organization</span><h1>Staff &amp; teachers</h1><p>Manage employee profiles, teacher qualifications, department assignments, and teaching allocations.</p></div>
        {canManageDirectory && staffSection === 'directory' && <div className="staff-header-actions">
          <button className="button button-quiet" onClick={exportStaffDirectory}><Download size={15} />Export directory</button>
          {isAdmin && <button className="button button-quiet" onClick={() => { setShowCreateForm(false); setShowTeacherInvite((visible) => !visible); setInviteError(''); }}><MailPlus size={16} />Invite staff</button>}
          <button className="button button-primary" onClick={startCreate}><Plus size={16} />Add staff profile</button>
        </div>}
      </header>
      {error && <ErrorState message={error} />}
      {success && <SuccessMessage message={success} />}

      {canManageDirectory && <nav className="staff-section-tabs" aria-label="Staff management workspace">
        <button type="button" className={staffSection === 'directory' ? 'active' : ''} onClick={() => setStaffSection('directory')}><BriefcaseBusiness size={15} />Directory</button>
        <button type="button" className={staffSection === 'credentials' ? 'active' : ''} onClick={() => setStaffSection('credentials')}><FileBadge2 size={15} />Credentials &amp; expiry</button>
        <button type="button" className={staffSection === 'attendance' ? 'active' : ''} onClick={() => setStaffSection('attendance')}><CalendarCheck size={15} />Attendance</button>
        <button type="button" className={staffSection === 'leave' ? 'active' : ''} onClick={() => setStaffSection('leave')}><CalendarDays size={15} />Leave &amp; coverage</button>
        <button type="button" className={staffSection === 'payroll' ? 'active' : ''} onClick={() => setStaffSection('payroll')}><Clock3 size={15} />Payroll export</button>
      </nav>}

      {staffSection !== 'directory' && canManageDirectory ? <StaffOperationsPanel
        schoolId={schoolId ?? ''}
        section={staffSection}
        canManage={canManageDirectory}
      /> : <>
      {showTeacherInvite && isAdmin && <section className="content-card staff-profile-card teacher-invite-card">
        <div className="section-heading"><div><span className="eyebrow">School account</span><h2>Invite a staff member</h2></div><button className="icon-button" aria-label="Close staff invitation form" onClick={() => setShowTeacherInvite(false)}><X size={17} /></button></div>
        <p className="accounting-help">We’ll send a secure account setup link, assign the selected school role, and create a staff directory profile.</p>
        {inviteError && <ErrorState message={inviteError} />}
        <form onSubmit={(event) => void inviteTeacher(event)}>
          <div className="staff-form-grid">
            <label className="field"><span>Full name</span><input name="full_name" required minLength={2} maxLength={120} autoComplete="name" disabled={invitingTeacher} /></label>
            <label className="field"><span>Work email</span><input name="email" type="email" required maxLength={320} autoComplete="email" disabled={invitingTeacher} /></label>
            <label className="field"><span>School role</span><select value={inviteRole} disabled={invitingTeacher} onChange={(event) => setInviteRole(event.target.value as InvitableRole)}>{invitableRoles.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}</select></label>
            <label className="field"><span>Employee number{inviteRole !== 'teacher' ? ' (optional)' : ''}</span><input name="employee_number" required={inviteRole === 'teacher'} maxLength={40} disabled={invitingTeacher} /></label>
          </div>
          <div className="staff-form-actions">
            <button className="button button-primary" type="submit" disabled={invitingTeacher}><MailPlus size={14} />{invitingTeacher ? 'Sending invitation…' : 'Send staff invitation'}</button>
            <button className="button button-quiet" type="button" onClick={() => setShowTeacherInvite(false)}>Cancel</button>
          </div>
        </form>
      </section>}

      <div className="staff-management-layout">
        <section className="content-card staff-directory-card">
          <div className="section-heading"><div><span className="eyebrow">School directory</span><h2>Staff directory</h2></div><span className="table-count">{visibleStaff.length} staff</span></div>
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
          </div> : <div className="staff-empty"><UserRound size={22} /><strong>{query ? 'No matching staff' : 'No staff profiles yet'}</strong><span>{canManageDirectory ? 'Add staff profiles to create your school directory.' : isHod ? 'No staff profiles are assigned to your departments.' : 'Your school staff will appear here.'}</span></div>}
          {isAdmin && <div className="staff-department-manager">
            <div><Building2 size={15} /><strong>Departments</strong></div>
            <form onSubmit={(event) => void addDepartment(event)}><input required maxLength={80} value={departmentName} onChange={(event) => setDepartmentName(event.target.value)} placeholder="New department name" /><button className="button button-quiet" disabled={saving}><Plus size={13} />Add</button></form>
            <div className="staff-department-tags">{departments.map((department) => <span key={department.id}>{department.name}</span>)}</div>
          </div>}
        </section>

        {showCreateForm && (canManageDirectory || (editingId && canEditSelectedStaff)) ? <section className="content-card staff-profile-card">
          <div className="section-heading"><div><span className="eyebrow">{editingId ? 'Update staff record' : 'New staff record'}</span><h2>{editingId ? 'Edit staff profile' : 'Add staff profile'}</h2></div><button className="icon-button" aria-label="Close staff form" onClick={() => setShowCreateForm(false)}><X size={17} /></button></div>
          <form onSubmit={(event) => void saveStaff(event)}>
            <div className="staff-form-grid">
              <label className="field"><span>Employee number</span><input required maxLength={40} value={form.employee_number} onChange={(event) => setForm((current) => ({ ...current, employee_number: event.target.value }))} /></label>
              <label className="field"><span>Job title</span><input maxLength={100} value={form.job_title} onChange={(event) => setForm((current) => ({ ...current, job_title: event.target.value }))} placeholder="e.g. Science teacher" /></label>
              <label className="field"><span>First name</span><input required maxLength={80} value={form.first_name} onChange={(event) => setForm((current) => ({ ...current, first_name: event.target.value }))} /></label>
              <label className="field"><span>Last name</span><input required maxLength={80} value={form.last_name} onChange={(event) => setForm((current) => ({ ...current, last_name: event.target.value }))} /></label>
              <label className="field"><span>Email</span><input type="email" maxLength={254} value={form.email ?? ''} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value || null }))} /></label>
              <label className="field"><span>Phone</span><input type="tel" maxLength={40} value={form.phone ?? ''} onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value || null }))} /></label>
              <label className="field"><span>Department</span><select value={form.department_id ?? ''} disabled={!canManageDirectory} onChange={(event) => setForm((current) => ({ ...current, department_id: event.target.value || null }))}>{canManageDirectory && <option value="">No department</option>}{visibleDepartments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label>
              <label className="field"><span>Employment status</span><select value={form.employment_status} onChange={(event) => setForm((current) => ({ ...current, employment_status: event.target.value as EmploymentStatus }))}>{Object.entries(STATUS_LABELS).map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select></label>
              <label className="field"><span>Hire date</span><input type="date" value={form.hire_date ?? ''} onChange={(event) => setForm((current) => ({ ...current, hire_date: event.target.value || null }))} /></label>
            </div>
            <label className="staff-checkbox"><input type="checkbox" checked={form.is_teacher} disabled={!isAdmin} onChange={(event) => setForm((current) => ({ ...current, is_teacher: event.target.checked }))} /><span><strong>Teacher profile</strong><small>Include teaching qualifications, subject expertise, and class/subject allocations.</small></span><GraduationCap size={19} /></label>
            {form.is_teacher && <>
              <label className="field"><span>Qualifications &amp; certifications</span><textarea rows={3} maxLength={2000} value={form.qualifications} onChange={(event) => setForm((current) => ({ ...current, qualifications: event.target.value }))} placeholder="Degrees, teaching certificates, and relevant experience" /></label>
              <div className="staff-assignment-grid">
                <fieldset><legend>Class allocations</legend>{classes.length ? classes.map((schoolClass) => <label key={schoolClass.id}><input type="checkbox" checked={form.class_ids.includes(schoolClass.id)} onChange={(event) => setForm((current) => ({ ...current, class_ids: event.target.checked ? [...current.class_ids, schoolClass.id] : current.class_ids.filter((id) => id !== schoolClass.id) }))} />{schoolClass.name}</label>) : <small>Add classes before assigning teachers.</small>}</fieldset>
                <fieldset><legend>Subject allocations</legend>{visibleSubjects.length ? visibleSubjects.map((subject) => <label key={subject.id}><input type="checkbox" checked={form.subject_ids.includes(subject.id)} onChange={(event) => setForm((current) => ({ ...current, subject_ids: event.target.checked ? [...current.subject_ids, subject.id] : current.subject_ids.filter((id) => id !== subject.id) }))} />{subject.name}</label>) : <small>{isHod ? 'Your department has no assigned subjects.' : 'Add subjects before assigning teachers.'}</small>}</fieldset>
              </div>
              {isAdmin && <div className="staff-assignment-grid staff-responsibility-grid">
                <fieldset><legend>Class Teacher / Form Tutor</legend><small>Designate this teacher to manage class-level records and progress.</small>{classes.length ? classes.map((schoolClass) => <label key={schoolClass.id}><input type="checkbox" checked={form.class_teacher_ids.includes(schoolClass.id)} onChange={(event) => setForm((current) => ({ ...current, class_teacher_ids: event.target.checked ? [...current.class_teacher_ids, schoolClass.id] : current.class_teacher_ids.filter((id) => id !== schoolClass.id) }))} />{schoolClass.name}</label>) : <small>Add classes before assigning a class teacher.</small>}</fieldset>
                <fieldset><legend>Head of Department</legend><small>Assign a department for HOD oversight.</small>{departments.length ? departments.map((department) => <label key={department.id}><input type="checkbox" checked={form.hod_department_ids.includes(department.id)} onChange={(event) => setForm((current) => ({ ...current, hod_department_ids: event.target.checked ? [...current.hod_department_ids, department.id] : current.hod_department_ids.filter((id) => id !== department.id) }))} />{department.name}</label>) : <small>Add departments before assigning an HOD.</small>}</fieldset>
              </div>}
            </>}
            <div className="staff-form-actions"><button className="button button-primary" disabled={saving}><Save size={14} />{saving ? 'Saving...' : editingId ? 'Save profile' : 'Create staff profile'}</button><button className="button button-quiet" type="button" onClick={() => setShowCreateForm(false)}>Cancel</button></div>
          </form>
        </section> : selectedStaff ? <section className="content-card staff-profile-card">
          <div className="section-heading"><div><span className="eyebrow">{selectedStaff.employee_number}</span><h2>{selectedStaff.first_name} {selectedStaff.last_name}</h2></div>{canEditSelectedStaff && <button className="button button-quiet" onClick={() => startEdit(selectedStaff)}><Save size={14} />Edit profile</button>}</div>
          <div className="staff-profile-facts">
            <div><span>Job title</span><strong>{selectedStaff.job_title || (selectedTeacher ? 'Teacher' : 'Staff member')}</strong></div>
            <div><span>Department</span>{canManageDirectory ? <select value={selectedStaff.department_id ?? ''} aria-label="Staff department assignment" onChange={(event) => void saveDepartmentAssignment(selectedStaff.id, event.target.value)}><option value="">No department</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select> : <strong>{departments.find((item) => item.id === selectedStaff.department_id)?.name ?? 'Not assigned'}</strong>}</div>
            <div><span>Employment</span><strong className={`staff-status staff-status-${selectedStaff.employment_status}`}>{STATUS_LABELS[selectedStaff.employment_status]}</strong></div>
            <div><span>Hire date</span><strong>{selectedStaff.hire_date ? new Date(`${selectedStaff.hire_date}T00:00:00`).toLocaleDateString() : 'Not recorded'}</strong></div>
            <div><span>Email</span><strong>{selectedStaff.email || 'Not recorded'}</strong></div>
            <div><span>Phone</span><strong>{selectedStaff.phone || 'Not recorded'}</strong></div>
            <div><span>School account</span><strong>{(selectedStaff.profile_id ?? selectedTeacher?.profile_id) ? staffAccounts.find((account) => account.profile_id === (selectedStaff.profile_id ?? selectedTeacher?.profile_id))?.role.replace(/_/g, ' ') ?? 'Linked' : 'Not linked'}</strong></div>
          </div>
          {selectedTeacher && <div className="staff-teacher-detail"><h3><GraduationCap size={16} />Teacher details</h3><p>{selectedTeacher.qualifications || 'No qualifications recorded.'}</p><div><span><strong>Classes</strong>{classAssignments.filter((assignment) => assignment.teacher_id === selectedTeacher.id).map((assignment) => classes.find((item) => item.id === assignment.class_id)?.name).filter(Boolean).join(', ') || 'Not allocated'}</span><span><strong>Subjects</strong>{subjectAssignments.filter((assignment) => assignment.teacher_id === selectedTeacher.id).map((assignment) => subjects.find((item) => item.id === assignment.subject_id)?.name).filter(Boolean).join(', ') || 'Not allocated'}</span></div>{isAdmin && selectedResponsibilities.length > 0 && <p><strong>Additional responsibilities:</strong> {selectedResponsibilities.map((item) => item.responsibility_type === 'class_teacher' ? `Class Teacher — ${classes.find((schoolClass) => schoolClass.id === item.class_id)?.name ?? 'class'}` : `HOD — ${departments.find((department) => department.id === item.department_id)?.name ?? 'department'}`).join('; ')}</p>}</div>}
          {canManageDirectory && <div className="staff-document-section">
            <div className="staff-document-heading"><div><FileText size={16} /><strong>Private staff documents</strong></div><span>{documents.length} files · visible to authorized HR administrators</span></div>
            <form className="staff-document-upload" onSubmit={(event) => void uploadStaffDocument(event)}><input required type="file" name="staff_document" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,application/pdf,image/jpeg,image/png,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" /><select name="document_type" aria-label="Staff document type"><option value="other">Other</option><option value="employment">Employment</option><option value="identity">Identity</option><option value="qualification">Qualification</option><option value="safeguarding">Safeguarding</option><option value="medical">Medical</option></select><label className="staff-document-expiry">Expires<input name="expires_on" type="date" /></label><button className="button button-quiet" disabled={uploading}><FilePlus2 size={14} />{uploading ? 'Uploading...' : 'Upload document'}</button></form>
            {documents.length > 0 && <div className="staff-document-list">{documents.map((document) => <article key={document.id}><span><FileText size={15} /><strong>{document.file_name}</strong><small>{(document.file_size / 1024 / 1024).toFixed(2)} MB · {document.document_type.replace(/_/g, ' ')} · {document.expires_on ? `Expires ${new Date(`${document.expires_on}T00:00:00`).toLocaleDateString()}` : 'No expiry date'}</small></span><button className="icon-button" title="Download securely" aria-label={`Download ${document.file_name}`} onClick={() => void downloadStaffDocument(document)}><Download size={14} /></button><button className="icon-button staff-delete-document" title="Delete document" aria-label={`Delete ${document.file_name}`} onClick={() => void deleteStaffDocument(document)}><Trash2 size={14} /></button></article>)}</div>}
          </div>}
          {selectedTeacher && (() => {
            const publishedLessons = workloadEntries.filter((entry) => {
              const schedule = Array.isArray(entry.schedule) ? entry.schedule[0] : entry.schedule;
              return schedule?.status === 'published';
            });
            const minutes = publishedLessons.reduce((total, entry) => {
              const start = entry.starts_at.split(':').map(Number);
              const end = entry.ends_at.split(':').map(Number);
              return total + (end[0] * 60 + end[1]) - (start[0] * 60 + start[1]);
            }, 0);
            return <section className="staff-workload-summary"><h3><Clock3 size={15} />Published timetable workload</h3><strong>{(minutes / 60).toFixed(1)} scheduled hours / week</strong><div>{publishedLessons.length ? publishedLessons.map((entry, index) => {
              const subject = Array.isArray(entry.subject) ? entry.subject[0] : entry.subject;
              const schoolClass = Array.isArray(entry.class) ? entry.class[0] : entry.class;
              return <span key={`${entry.day_of_week}-${entry.starts_at}-${index}`}>{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][entry.day_of_week - 1] ?? 'Day'} · {subject?.name ?? 'Subject'} · {schoolClass?.name ?? 'Class'}</span>;
            }) : <small>No lessons in a published timetable.</small>}</div></section>;
          })()}
        </section> : <section className="content-card staff-profile-empty"><BriefcaseBusiness size={25} /><strong>Select a staff member</strong><span>View their department, employment details, teacher allocations, and documents.</span></section>}
      </div>
      </>}
    </div>
  );
}
