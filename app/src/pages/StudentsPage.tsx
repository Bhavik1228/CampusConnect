import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowDownToLine, CalendarDays, FileText, GitMerge, Plus, Search, ShieldCheck, UserRound, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';
import type { SchoolClass } from '../types/database';

type StudentStatus = 'active' | 'inactive' | 'graduated' | 'transferred' | 'withdrawn';
type StudentRow = {
  id: string; school_id: string; student_number: string; first_name: string; last_name: string;
  email: string | null; date_of_birth: string | null; status: StudentStatus; class_id: string | null;
  merged_into_student_id: string | null; school_classes: { name: string } | null;
};
type PrivateProfile = {
  phone: string | null; address: string | null; city: string | null; region: string | null;
  postal_code: string | null; country: string | null; gender: string | null; nationality: string | null;
  admission_date: string | null;
};
type EmergencyContact = {
  contact_name: string; relationship: string | null; phone: string; email: string | null;
};
type LifecycleRecord = {
  id: string; event_type: string; event_date: string; previous_status: StudentStatus | null;
  new_status: StudentStatus | null; previous_class_id: string | null; new_class_id: string | null;
  destination_school: string | null; reason: string | null;
};
type StudentDocument = {
  id: string; file_name: string; storage_path: string; content_type: string;
  file_size: number; created_at: string;
};
type AcademicYearRecord = {
  id: string; academic_year_id: string; class_id: string; enrolled_at: string; ended_at: string | null;
};
type StudentAuditEvent = {
  id: number; event_type: 'correction' | 'merge'; related_student_id: string | null;
  reason: string; created_at: string;
};

const documentTypes = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const statusLabels: Record<StudentStatus, string> = {
  active: 'Active', inactive: 'Inactive', graduated: 'Graduated',
  transferred: 'Transferred', withdrawn: 'Withdrawn',
};

function profileValue(profile: PrivateProfile | null, key: keyof PrivateProfile) {
  return profile?.[key] ?? '';
}

export function StudentsPage() {
  const { activeMembership, user } = useAuth();
  const schoolId = activeMembership?.school_id;
  const canManage = activeMembership?.role === 'school_admin';
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [profile, setProfile] = useState<PrivateProfile | null>(null);
  const [contacts, setContacts] = useState<EmergencyContact[]>([]);
  const [history, setHistory] = useState<LifecycleRecord[]>([]);
  const [documents, setDocuments] = useState<StudentDocument[]>([]);
  const [academicHistory, setAcademicHistory] = useState<AcademicYearRecord[]>([]);
  const [auditEvents, setAuditEvents] = useState<StudentAuditEvent[]>([]);
  const [academicYears, setAcademicYears] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [formError, setFormError] = useState('');
  const [success, setSuccess] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [mergeCandidateId, setMergeCandidateId] = useState('');
  const [mergeReason, setMergeReason] = useState('');
  const [merging, setMerging] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  const loadStudents = useCallback(async () => {
    if (!schoolId) return;
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [studentResult, classResult] = await Promise.all([
        (async () => {
          const allStudents: StudentRow[] = [];
          for (let offset = 0; ; offset += 500) {
            const { data, error: pageError } = await client.from('students')
              .select('id,school_id,student_number,first_name,last_name,email,date_of_birth,status,class_id,merged_into_student_id,school_classes(name)')
              .eq('school_id', schoolId).is('merged_into_student_id', null).order('last_name').order('first_name')
              .range(offset, offset + 499);
            if (pageError) throw pageError;
            const page = (data ?? []) as unknown as StudentRow[];
            allStudents.push(...page);
            if (page.length < 500) break;
          }
          return allStudents;
        })(),
        client.from('school_classes').select('id,school_id,name,grade_level,academic_year_id,created_at')
          .eq('school_id', schoolId).order('name'),
      ]);
      if (classResult.error) throw classResult.error;
      const records = studentResult;
      setStudents(records);
      setClasses(classResult.data ?? []);
      setSelectedId((current) => records.some((student) => student.id === current) ? current : records[0]?.id ?? '');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load student records.');
    } finally {
      setLoading(false);
    }
  }, [schoolId]);

  useEffect(() => { void loadStudents(); }, [loadStudents, refreshKey]);

  const selectedStudent = students.find((student) => student.id === selectedId) ?? null;

  useEffect(() => {
    const command = searchParams.get('command');
    const recordId = searchParams.get('commandRecord');
    if ((!command || command !== 'create') && !recordId) return;
    if (command === 'create' && canManage) {
      setSelectedId('');
      openForm();
    }
    if (recordId && !loading) {
      if (students.some((student) => student.id === recordId)) setSelectedId(recordId);
      else setError('That student record is unavailable or your access has changed.');
    }
    if ((command !== 'create' || canManage) && (!recordId || !loading)) {
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.delete('command');
        next.delete('commandRecord');
        return next;
      }, { replace: true });
    }
  }, [searchParams, setSearchParams, canManage, students, loading]);

  const loadDetails = useCallback(async () => {
    if (!schoolId || !selectedStudent || !canManage) {
      setProfile(null);
      setContacts([]);
      setHistory([]);
      setDocuments([]);
      setAcademicHistory([]);
      setAuditEvents([]);
      return;
    }
    setDetailLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [profileResult, contactResult, historyResult, documentResult, academicResult, auditResult, yearResult] = await Promise.all([
        client.from('student_private_profiles')
          .select('phone,address,city,region,postal_code,country,gender,nationality,admission_date')
          .eq('school_id', schoolId).eq('student_id', selectedStudent.id).maybeSingle(),
        client.from('student_emergency_contacts')
          .select('id,is_primary,created_at,contact_name,relationship,phone,email').eq('school_id', schoolId)
          .eq('student_id', selectedStudent.id).order('is_primary', { ascending: false })
          .order('created_at').order('id'),
        client.from('student_lifecycle_records')
          .select('id,event_type,event_date,previous_status,new_status,previous_class_id,new_class_id,destination_school,reason')
          .eq('school_id', schoolId).eq('student_id', selectedStudent.id)
          .order('event_date', { ascending: false }).order('created_at', { ascending: false }),
        client.from('student_documents')
          .select('id,file_name,storage_path,content_type,file_size,created_at')
          .eq('school_id', schoolId).eq('student_id', selectedStudent.id)
          .order('created_at', { ascending: false }),
        client.from('student_academic_year_history')
          .select('id,academic_year_id,class_id,enrolled_at,ended_at')
          .eq('school_id', schoolId).eq('student_id', selectedStudent.id)
          .order('enrolled_at', { ascending: false }),
        client.from('student_record_audit_events')
          .select('id,event_type,related_student_id,reason,created_at')
          .eq('school_id', schoolId).eq('student_id', selectedStudent.id)
          .order('created_at', { ascending: false }).limit(50),
        client.from('academic_years').select('id,name').eq('school_id', schoolId),
      ]);
      if (profileResult.error) throw profileResult.error;
      if (contactResult.error) throw contactResult.error;
      if (historyResult.error) throw historyResult.error;
      if (documentResult.error) throw documentResult.error;
      if (academicResult.error) throw academicResult.error;
      if (auditResult.error) throw auditResult.error;
      if (yearResult.error) throw yearResult.error;
      setProfile(profileResult.data as PrivateProfile | null);
      setContacts((contactResult.data ?? []) as EmergencyContact[]);
      setHistory((historyResult.data ?? []) as LifecycleRecord[]);
      setDocuments((documentResult.data ?? []) as StudentDocument[]);
      setAcademicHistory((academicResult.data ?? []) as AcademicYearRecord[]);
      setAuditEvents((auditResult.data ?? []) as StudentAuditEvent[]);
      setAcademicYears((yearResult.data ?? []) as { id: string; name: string }[]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load the student profile.');
    } finally {
      setDetailLoading(false);
    }
  }, [schoolId, selectedStudent, canManage]);

  useEffect(() => { void loadDetails(); }, [loadDetails]);

  const filteredStudents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return students;
    return students.filter((student) =>
      `${student.first_name} ${student.last_name} ${student.student_number} ${student.email ?? ''} ${student.school_classes?.name ?? ''}`
        .toLowerCase().includes(needle));
  }, [students, query]);

  const completenessChecks = useMemo(() => selectedStudent ? [
    { label: 'Student identifier', complete: Boolean(selectedStudent.student_number) },
    { label: 'First and last name', complete: Boolean(selectedStudent.first_name && selectedStudent.last_name) },
    { label: 'Date of birth', complete: Boolean(selectedStudent.date_of_birth) },
    { label: 'Class enrolment', complete: Boolean(selectedStudent.class_id) },
    { label: 'Email address', complete: Boolean(selectedStudent.email) },
    { label: 'Phone number', complete: Boolean(profile?.phone) },
    { label: 'Home address', complete: Boolean(profile?.address && profile?.city && profile?.country) },
    { label: 'Admission date', complete: Boolean(profile?.admission_date) },
    { label: 'Gender', complete: Boolean(profile?.gender) },
    { label: 'Nationality', complete: Boolean(profile?.nationality) },
    { label: 'Emergency contact', complete: contacts.length > 0 },
    { label: 'Supporting document', complete: documents.length > 0 },
  ] : [], [contacts.length, documents.length, profile, selectedStudent]);
  const completenessPercent = completenessChecks.length
    ? Math.round(completenessChecks.filter((item) => item.complete).length / completenessChecks.length * 100)
    : 0;
  const timelineEvents = useMemo(() => [
    ...history.map((record) => ({
      id: `lifecycle-${record.id}`,
      date: record.event_date,
      title: record.event_type.replace(/_/g, ' '),
      detail: [record.previous_status || record.new_status
        ? `${record.previous_status ? statusLabels[record.previous_status] : '—'} → ${record.new_status ? statusLabels[record.new_status] : '—'}`
        : '', record.previous_class_id || record.new_class_id
        ? `Class: ${classes.find((schoolClass) => schoolClass.id === record.previous_class_id)?.name ?? '—'} → ${classes.find((schoolClass) => schoolClass.id === record.new_class_id)?.name ?? '—'}`
        : '', record.reason, record.destination_school ? `Destination: ${record.destination_school}` : '']
        .filter(Boolean).join(' · '),
    })),
    ...academicHistory.map((record) => ({
      id: `year-${record.id}`,
      date: record.enrolled_at,
      title: `Academic year: ${academicYears.find((year) => year.id === record.academic_year_id)?.name ?? 'Unknown year'}`,
      detail: `${classes.find((schoolClass) => schoolClass.id === record.class_id)?.name ?? 'Class unavailable'}${record.ended_at ? ` · ended ${record.ended_at}` : ' · current enrolment'}`,
    })),
    ...documents.map((document) => ({
      id: `document-${document.id}`,
      date: document.created_at,
      title: 'Document uploaded',
      detail: document.file_name,
    })),
    ...auditEvents.map((event) => ({
      id: `audit-${event.id}`,
      date: event.created_at,
      title: event.event_type === 'merge' ? 'Student records merged' : 'Record correction',
      detail: event.reason,
    })),
  ].sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime()), [
    academicHistory, academicYears, auditEvents, classes, documents, history,
  ]);

  async function saveStudent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId) return;
    const data = new FormData(event.currentTarget);
    setSaving(true);
    setFormError('');
    setSuccess('');
    try {
      const result = await requireSupabase().rpc('save_student_record_controlled', {
        target_school: schoolId,
        target_student: selectedStudent?.id ?? null,
        student_data: {
          first_name: data.get('first_name'),
          last_name: data.get('last_name'),
          email: data.get('email'),
          date_of_birth: data.get('date_of_birth'),
          class_id: data.get('class_id'),
          status: data.get('status'),
          movement_reason: data.get('movement_reason'),
          destination_school: data.get('destination_school'),
          phone: data.get('phone'),
          address: data.get('address'),
          city: data.get('city'),
          region: data.get('region'),
          postal_code: data.get('postal_code'),
          country: data.get('country'),
          gender: data.get('gender'),
          nationality: data.get('nationality'),
          admission_date: data.get('admission_date'),
          emergency_contact_1_name: data.get('emergency_contact_name'),
          emergency_contact_1_relationship: data.get('emergency_contact_relationship'),
          emergency_contact_1_phone: data.get('emergency_contact_phone'),
          emergency_contact_1_email: data.get('emergency_contact_email'),
          emergency_contact_2_name: data.get('emergency_contact_2_name'),
          emergency_contact_2_relationship: data.get('emergency_contact_2_relationship'),
          emergency_contact_2_phone: data.get('emergency_contact_2_phone'),
          emergency_contact_2_email: data.get('emergency_contact_2_email'),
          correction_reason: data.get('correction_reason'),
        },
      });
      if (result.error) throw result.error;
      const saved = (result.data as { student_id: string; student_number: string }[] | null)?.[0];
      if (!saved) throw new Error('The student record was not returned after saving.');
      setShowForm(false);
      setSuccess(selectedStudent ? 'Student record updated.' : `Student added with ID ${saved.student_number}.`);
      setSelectedId(saved.student_id);
      setRefreshKey((key) => key + 1);
    } catch (saveError) {
      setFormError(saveError instanceof Error ? saveError.message : 'Could not save the student record.');
    } finally {
      setSaving(false);
    }
  }

  async function uploadDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !selectedStudent || !user) return;
    const formElement = event.currentTarget;
    const file = new FormData(formElement).get('student_document');
    if (!(file instanceof File) || file.size === 0) {
      setError('Choose a student document to upload.');
      return;
    }
    if (!documentTypes.has(file.type)) {
      setError('Upload a PDF, JPEG, PNG, DOC, or DOCX document.');
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setError('Student documents must be 50 MB or smaller.');
      return;
    }
    setUploading(true);
    setError('');
    setSuccess('');
    const path = `${schoolId}/${selectedStudent.id}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-160)}`;
    try {
      const client = requireSupabase();
      const { error: uploadError } = await client.storage.from('student-documents')
        .upload(path, file, { contentType: file.type, upsert: false });
      if (uploadError) throw uploadError;
      const { data, error: metadataError } = await client.from('student_documents').insert({
        school_id: schoolId,
        student_id: selectedStudent.id,
        uploaded_by: user.id,
        file_name: file.name.slice(0, 200),
        storage_path: path,
        content_type: file.type,
        file_size: file.size,
      }).select('id,file_name,storage_path,content_type,file_size,created_at').single();
      if (metadataError) {
        const { error: cleanupError } = await client.storage.from('student-documents').remove([path]);
        if (cleanupError) throw new Error(`Document details were not saved, and the uploaded file could not be removed: ${metadataError.message}; ${cleanupError.message}`);
        throw metadataError;
      }
      setDocuments((current) => [data as StudentDocument, ...current]);
      formElement.reset();
      setSuccess('Student document uploaded securely.');
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Could not upload the student document.');
    } finally {
      setUploading(false);
    }
  }

  async function downloadDocument(document: StudentDocument) {
    try {
      const { data, error: linkError } = await requireSupabase().storage.from('student-documents')
        .createSignedUrl(document.storage_path, 60);
      if (linkError) throw linkError;
      window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : 'Could not open the student document.');
    }
  }

  async function deleteDocument(document: StudentDocument) {
    if (!schoolId || !window.confirm(`Delete “${document.file_name}”? This cannot be undone.`)) return;
    setError('');
    try {
      const client = requireSupabase();
      const { error: metadataError } = await client.from('student_documents').delete()
        .eq('id', document.id).eq('school_id', schoolId);
      if (metadataError) throw metadataError;
      const { error: fileError } = await client.storage.from('student-documents').remove([document.storage_path]);
      if (fileError) throw new Error(`The document record was deleted, but its stored file could not be removed: ${fileError.message}`);
      setDocuments((current) => current.filter((item) => item.id !== document.id));
      setSuccess('Student document deleted.');
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Could not delete the student document.');
    }
  }

  async function mergeStudentRecords() {
    if (!schoolId || !selectedStudent || !mergeCandidateId || !mergeReason.trim()) return;
    const duplicate = students.find((student) => student.id === mergeCandidateId);
    if (!duplicate) {
      setError('Choose an active student record to merge.');
      return;
    }
    if (!window.confirm(`Merge ${duplicate.first_name} ${duplicate.last_name} (${duplicate.student_number}) into ${selectedStudent.first_name} ${selectedStudent.last_name} (${selectedStudent.student_number})? This will move linked records and archive the duplicate; it cannot be undone.`)) return;
    setMerging(true);
    setError('');
    setSuccess('');
    try {
      const { error: mergeError } = await requireSupabase().rpc('merge_student_records', {
        target_school: schoolId,
        survivor_student: selectedStudent.id,
        duplicate_student: duplicate.id,
        merge_reason: mergeReason.trim(),
      });
      if (mergeError) throw mergeError;
      setMergeCandidateId('');
      setMergeReason('');
      setSelectedId(selectedStudent.id);
      setSuccess(`Merged ${duplicate.student_number} into ${selectedStudent.student_number}. The archived record remains in the audit history.`);
      setRefreshKey((current) => current + 1);
    } catch (mergeError) {
      setError(mergeError instanceof Error ? mergeError.message : 'Could not merge these student records.');
    } finally {
      setMerging(false);
    }
  }

  function openForm() {
    setFormError('');
    setShowForm(true);
  }

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div><span className="eyebrow">{activeMembership?.school.name}</span><h1>Students</h1><p>Student profiles, class enrolment, documents, and student history.</p></div>
        {canManage && <button className="button button-primary" onClick={() => { setSelectedId(''); openForm(); }}><Plus size={17} /> Add student</button>}
      </div>
      {success && <p className="inline-success" role="status">{success}</p>}
      {error && <ErrorState message={error} />}
      <div className="student-manager-layout">
        <section className="content-card student-list-card">
          <label className="table-search student-search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, student ID, or class" aria-label="Search students" /></label>
          {loading ? <LoadingState label="Loading students…" /> : filteredStudents.length === 0
            ? <EmptyState title={query ? 'No matching students' : 'No students yet'} detail={canManage ? 'Add a student to begin building your school records.' : 'Student records will appear here when available.'} />
            : <div className="student-record-list">{filteredStudents.map((student) => (
              <button key={student.id} className={`student-record-item${student.id === selectedId ? ' selected' : ''}`} onClick={() => setSelectedId(student.id)}>
                <span className="avatar avatar-small">{student.first_name.slice(0, 1)}{student.last_name.slice(0, 1)}</span>
                <span className="student-record-copy"><strong>{student.first_name} {student.last_name}</strong><small>{student.student_number} · {student.school_classes?.name ?? 'No class assigned'}</small></span>
                <span className={`student-status status-${student.status}`}>{statusLabels[student.status]}</span>
              </button>
            ))}</div>}
          <small className="student-list-count">{filteredStudents.length} of {students.length} students</small>
        </section>
        <section className="content-card student-detail-card">
          {!selectedStudent ? <EmptyState title="Select a student" detail="Choose a student from the list to view their profile and history." />
            : <div className="student-detail">
              <div className="student-detail-heading">
                <span className="avatar">{selectedStudent.first_name.slice(0, 1)}{selectedStudent.last_name.slice(0, 1)}</span>
                <div><span className="eyebrow">Student profile</span><h2>{selectedStudent.first_name} {selectedStudent.last_name}</h2><p>{selectedStudent.student_number} · {selectedStudent.school_classes?.name ?? 'No class assigned'}</p></div>
                {canManage && <button className="button button-secondary" onClick={openForm}>Edit profile</button>}
              </div>
              {detailLoading ? <LoadingState label="Loading student details…" /> : canManage ? <>
                <section className="student-info-section">
                  <h3>Profile completeness <span className="student-section-count">{completenessPercent}%</span></h3>
                  <div className="student-completeness-track" role="progressbar" aria-label="Student profile completeness" aria-valuenow={completenessPercent} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${completenessPercent}%` }} /></div>
                  <ul className="student-completeness-list">{completenessChecks.map((item) => <li key={item.label} className={item.complete ? 'complete' : ''}>{item.complete ? 'Complete' : 'Missing'} · {item.label}</li>)}</ul>
                </section>
                <section className="student-info-section">
                  <h3><UserRound size={16} /> Personal and contact information</h3>
                  <dl className="student-profile-grid">
                    <dt>Email</dt><dd>{selectedStudent.email || '—'}</dd>
                    <dt>Phone</dt><dd>{profile?.phone || '—'}</dd>
                    <dt>Date of birth</dt><dd>{selectedStudent.date_of_birth || '—'}</dd>
                    <dt>Gender</dt><dd>{profile?.gender || '—'}</dd>
                    <dt>Nationality</dt><dd>{profile?.nationality || '—'}</dd>
                    <dt>Address</dt><dd>{[profile?.address, profile?.city, profile?.region, profile?.postal_code, profile?.country].filter(Boolean).join(', ') || '—'}</dd>
                    <dt>Admission date</dt><dd>{profile?.admission_date || '—'}</dd>
                    <dt>Emergency contacts</dt><dd>{contacts.length ? contacts.map((item) => `${item.contact_name} · ${item.relationship || 'Contact'} · ${item.phone}${item.email ? ` · ${item.email}` : ''}`).join(' | ') : '—'}</dd>
                  </dl>
                </section>
                <section className="student-info-section">
                  <h3><FileText size={16} /> Student documents <span className="student-section-count">{documents.length}</span></h3>
                  <form className="student-upload-form" onSubmit={(event) => void uploadDocument(event)}>
                    <input name="student_document" type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" disabled={uploading} aria-label="Choose a student document" />
                    <button className="button button-secondary" type="submit" disabled={uploading}>{uploading ? 'Uploading…' : 'Upload document'}</button>
                    <small>PDF, JPG, PNG, DOC, or DOCX · 50 MB maximum</small>
                  </form>
                  {documents.length ? <div className="student-document-list">{documents.map((document) => <div key={document.id}>
                    <span><FileText size={16} /><span><strong>{document.file_name}</strong><small>{(document.file_size / 1024 / 1024).toFixed(2)} MB · {new Date(document.created_at).toLocaleDateString()}</small></span></span>
                    <button className="icon-button" onClick={() => void downloadDocument(document)} aria-label={`Open ${document.file_name}`}><ArrowDownToLine size={17} /></button>
                    <button className="icon-button" onClick={() => void deleteDocument(document)} aria-label={`Delete ${document.file_name}`}><X size={17} /></button>
                  </div>)}</div> : <p className="student-empty-inline">No documents uploaded.</p>}
                </section>
                <section className="student-info-section">
                  <h3><CalendarDays size={16} /> Academic-year history</h3>
                  {academicHistory.length ? <ol className="student-history">{academicHistory.map((record) => <li key={record.id}>
                    <span><strong>{academicYears.find((year) => year.id === record.academic_year_id)?.name ?? 'Unknown academic year'}</strong>
                      <small>{classes.find((item) => item.id === record.class_id)?.name ?? 'Class unavailable'} · enrolled {new Date(`${record.enrolled_at}T00:00:00`).toLocaleDateString()}{record.ended_at ? ` · ended ${new Date(`${record.ended_at}T00:00:00`).toLocaleDateString()}` : ' · current'}</small>
                    </span>
                  </li>)}</ol> : <p className="student-empty-inline">No academic-year enrolments have been recorded yet.</p>}
                </section>
                <section className="student-info-section">
                  <h3><ShieldCheck size={16} /> Student timeline</h3>
                  {timelineEvents.length ? <ol className="student-history">{timelineEvents.map((item) => <li key={item.id}>
                    <span><strong>{item.title}</strong><small>{new Date(`${item.date.slice(0, 10)}T00:00:00`).toLocaleDateString()}</small>{item.detail && <small>{item.detail}</small>}</span>
                  </li>)}</ol> : <p className="student-empty-inline">No student events have been recorded.</p>}
                </section>
                <section className="student-info-section student-merge-section">
                  <h3><GitMerge size={16} /> Merge duplicate student record</h3>
                  <p className="student-privacy-note">The selected student remains the surviving record. Linked records move to it; the duplicate is retained as an archived reference. Conflicting unique attendance or assessment records must be resolved first.</p>
                  <label className="field"><span>Duplicate to merge into this student</span><select value={mergeCandidateId} onChange={(event) => setMergeCandidateId(event.target.value)} disabled={merging}>
                    <option value="">Choose a student record</option>
                    {students.filter((student) => student.id !== selectedStudent.id).map((student) => <option key={student.id} value={student.id}>{student.first_name} {student.last_name} · {student.student_number}</option>)}
                  </select></label>
                  <label className="field"><span>Merge reason</span><textarea value={mergeReason} onChange={(event) => setMergeReason(event.target.value)} rows={2} maxLength={1000} required disabled={merging} /></label>
                  <button className="button button-secondary" type="button" onClick={() => void mergeStudentRecords()} disabled={merging || !mergeCandidateId || mergeReason.trim().length < 3}>{merging ? 'Merging…' : 'Review and merge records'}</button>
                </section>
              </> : <section className="student-info-section">
                <h3>Student information</h3>
                <dl className="student-profile-grid"><dt>Email</dt><dd>{selectedStudent.email || '—'}</dd><dt>Date of birth</dt><dd>{selectedStudent.date_of_birth || '—'}</dd><dt>Status</dt><dd>{statusLabels[selectedStudent.status]}</dd></dl>
                <p className="student-privacy-note">Private contact details, emergency contacts, and documents are available to the school administrator.</p>
              </section>}
            </div>}
        </section>
      </div>
      {showForm && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowForm(false); }}>
        <section className="modal-card student-form-modal" role="dialog" aria-modal="true" aria-labelledby="student-form-title">
          <div className="modal-heading"><div><span className="eyebrow">Student records</span><h2 id="student-form-title">{selectedStudent ? 'Edit student profile' : 'Add student'}</h2></div><button className="icon-button" onClick={() => setShowForm(false)} aria-label="Close dialog"><X size={19} /></button></div>
          {formError && <ErrorState message={formError} />}
          <form className="modal-form" onSubmit={(event) => void saveStudent(event)}>
            <div className="form-row"><label className="field"><span>First name</span><input required name="first_name" maxLength={80} defaultValue={selectedStudent?.first_name ?? ''} /></label><label className="field"><span>Last name</span><input required name="last_name" maxLength={80} defaultValue={selectedStudent?.last_name ?? ''} /></label></div>
            <div className="form-row"><label className="field"><span>Email</span><input name="email" type="email" maxLength={254} defaultValue={selectedStudent?.email ?? ''} /></label><label className="field"><span>Phone</span><input name="phone" type="tel" maxLength={40} defaultValue={profileValue(profile, 'phone')} /></label></div>
            <div className="form-row"><label className="field"><span>Date of birth</span><input name="date_of_birth" type="date" defaultValue={selectedStudent?.date_of_birth ?? ''} /></label><label className="field"><span>Admission date</span><input name="admission_date" type="date" defaultValue={profileValue(profile, 'admission_date')} /></label></div>
            <div className="form-row"><label className="field"><span>Class enrolment</span><select name="class_id" defaultValue={selectedStudent?.class_id ?? ''}><option value="">Not assigned</option>{classes.map((schoolClass) => <option key={schoolClass.id} value={schoolClass.id}>{schoolClass.name}</option>)}</select></label><label className="field"><span>Status</span><select name="status" defaultValue={selectedStudent?.status ?? 'active'}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
            <div className="form-row"><label className="field"><span>Gender</span><input name="gender" maxLength={60} defaultValue={profileValue(profile, 'gender')} /></label><label className="field"><span>Nationality</span><input name="nationality" maxLength={80} defaultValue={profileValue(profile, 'nationality')} /></label></div>
            <label className="field"><span>Street address</span><input name="address" maxLength={240} defaultValue={profileValue(profile, 'address')} /></label>
            <div className="form-row"><label className="field"><span>City / town</span><input name="city" maxLength={100} defaultValue={profileValue(profile, 'city')} /></label><label className="field"><span>Region / state</span><input name="region" maxLength={100} defaultValue={profileValue(profile, 'region')} /></label></div>
            <div className="form-row"><label className="field"><span>Postal code</span><input name="postal_code" maxLength={24} defaultValue={profileValue(profile, 'postal_code')} /></label><label className="field"><span>Country</span><input name="country" maxLength={80} defaultValue={profileValue(profile, 'country')} /></label></div>
            <h3 className="student-form-subheading">Primary emergency contact</h3>
            <div className="form-row"><label className="field"><span>Contact 1 name</span><input name="emergency_contact_name" maxLength={120} defaultValue={contacts[0]?.contact_name ?? ''} /></label><label className="field"><span>Relationship</span><input name="emergency_contact_relationship" maxLength={60} defaultValue={contacts[0]?.relationship ?? ''} /></label></div>
            <div className="form-row"><label className="field"><span>Contact 1 phone</span><input name="emergency_contact_phone" type="tel" maxLength={40} defaultValue={contacts[0]?.phone ?? ''} /></label><label className="field"><span>Contact 1 email</span><input name="emergency_contact_email" type="email" maxLength={254} defaultValue={contacts[0]?.email ?? ''} /></label></div>
            <div className="form-row"><label className="field"><span>Contact 2 name</span><input name="emergency_contact_2_name" maxLength={120} defaultValue={contacts[1]?.contact_name ?? ''} /></label><label className="field"><span>Relationship</span><input name="emergency_contact_2_relationship" maxLength={60} defaultValue={contacts[1]?.relationship ?? ''} /></label></div>
            <div className="form-row"><label className="field"><span>Contact 2 phone</span><input name="emergency_contact_2_phone" type="tel" maxLength={40} defaultValue={contacts[1]?.phone ?? ''} /></label><label className="field"><span>Contact 2 email</span><input name="emergency_contact_2_email" type="email" maxLength={254} defaultValue={contacts[1]?.email ?? ''} /></label></div>
            {selectedStudent && <><h3 className="student-form-subheading">Transfer or withdrawal details</h3><label className="field"><span>Reason <small>(required for transfer or withdrawal)</small></span><textarea name="movement_reason" rows={2} maxLength={1000} /></label><label className="field"><span>Destination school <small>(required for transfer)</small></span><input name="destination_school" maxLength={200} /></label></>}
            {selectedStudent && <label className="field student-correction-reason"><span>Correction reason <small>(required and recorded in the student audit trail)</small></span><textarea name="correction_reason" rows={2} minLength={3} maxLength={1000} required /></label>}
            <div className="settings-actions"><button className="button button-secondary" type="button" onClick={() => setShowForm(false)}>Cancel</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : selectedStudent ? 'Save changes' : 'Add student'}</button></div>
          </form>
        </section>
      </div>}
    </div>
  );
}
