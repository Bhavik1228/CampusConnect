import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowDownToLine, CalendarDays, FileText, GitMerge, Plus, Search, ShieldCheck, UserRound, X, GraduationCap, UsersRound, ClipboardCheck } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';
import type { SchoolClass } from '../types/database';
import {
  Button, Card, CardContent, Badge, SectionHeading, StatusPill, Input, Select, Textarea, IconButton, Modal, Alert,
} from '../components/ui';

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
type StudentQualityProfile = Pick<PrivateProfile, 'phone' | 'address' | 'city' | 'country' | 'admission_date'>;
type StudentQualityData = {
  profiles: Record<string, StudentQualityProfile>;
  emergencyContacts: Record<string, number>;
  documents: Record<string, number>;
};
type StudentQualityFinding = {
  issues: string[];
  possibleDuplicate: boolean;
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
type StudentAttendanceSnapshot = {
  status: 'present' | 'absent' | 'late' | 'excused';
  session: { attendance_date: string } | { attendance_date: string }[] | null;
};
type StudentPublishedResult = {
  id: string;
  assessment_date: string;
  marks_obtained: number;
  maximum_marks: number;
  percentage: number;
  assessment: { title: string; subject: string } | { title: string; subject: string }[] | null;
};

const documentTypes = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const statusLabels: Record<StudentStatus, string> = {
  active: 'Active', inactive: 'Inactive', graduated: 'Graduated',
  transferred: 'Transferred', withdrawn: 'Withdrawn',
};

const statusVariant: Record<StudentStatus, 'success' | 'warning' | 'danger' | 'info'> = {
  active: 'success', inactive: 'info', graduated: 'info',
  transferred: 'warning', withdrawn: 'danger',
};

function profileValue(profile: PrivateProfile | null, key: keyof PrivateProfile) {
  return profile?.[key] ?? '';
}

function studentAvatar(initials: string) {
  return (
    <span className="w-8 h-8 rounded-lg bg-surface-soft cc-flex items-center justify-center text-muted font-semibold text-sm">
      {initials}
    </span>
  );
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
  const [attendanceSnapshot, setAttendanceSnapshot] = useState<StudentAttendanceSnapshot[]>([]);
  const [publishedResults, setPublishedResults] = useState<StudentPublishedResult[]>([]);
  const [qualityData, setQualityData] = useState<StudentQualityData>({ profiles: {}, emergencyContacts: {}, documents: {} });
  const [qualityLoading, setQualityLoading] = useState(false);
  const [qualityError, setQualityError] = useState('');
  const [academicYears, setAcademicYears] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [qualityFilter, setQualityFilter] = useState<'all' | 'needs_attention' | 'possible_duplicate'>('all');
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

  useEffect(() => {
    if (!schoolId || !canManage || students.length === 0) {
      setQualityData({ profiles: {}, emergencyContacts: {}, documents: {} });
      setQualityLoading(false);
      setQualityError('');
      return;
    }
    let alive = true;
    setQualityLoading(true);
    setQualityError('');
    void (async () => {
      try {
        const client = requireSupabase();
        const qualityProfiles: Record<string, StudentQualityProfile> = {};
        const emergencyContacts: Record<string, number> = {};
        const documents: Record<string, number> = {};
        for (let offset = 0; offset < students.length; offset += 200) {
          const studentIds = students.slice(offset, offset + 200).map((student) => student.id);
          const [profileResult, contactResult, documentResult] = await Promise.all([
            client.from('student_private_profiles')
              .select('student_id,phone,address,city,country,admission_date')
              .eq('school_id', schoolId).in('student_id', studentIds),
            client.from('student_emergency_contacts')
              .select('student_id')
              .eq('school_id', schoolId).in('student_id', studentIds),
            client.from('student_documents')
              .select('student_id')
              .eq('school_id', schoolId).in('student_id', studentIds),
          ]);
          if (profileResult.error) throw profileResult.error;
          if (contactResult.error) throw contactResult.error;
          if (documentResult.error) throw documentResult.error;
          for (const profile of profileResult.data ?? []) {
            qualityProfiles[profile.student_id] = profile;
          }
          for (const contact of contactResult.data ?? []) {
            emergencyContacts[contact.student_id] = (emergencyContacts[contact.student_id] ?? 0) + 1;
          }
          for (const document of documentResult.data ?? []) {
            documents[document.student_id] = (documents[document.student_id] ?? 0) + 1;
          }
        }
        if (alive) setQualityData({ profiles: qualityProfiles, emergencyContacts, documents });
      } catch (loadError) {
        if (alive) setQualityError(loadError instanceof Error ? loadError.message : 'Could not load student data-quality checks.');
      } finally {
        if (alive) setQualityLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [canManage, schoolId, students]);

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
      setAttendanceSnapshot([]);
      setPublishedResults([]);
      return;
    }
    setDetailLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const attendanceStart = new Date();
      attendanceStart.setDate(attendanceStart.getDate() - 90);
      const [profileResult, contactResult, historyResult, documentResult, academicResult, auditResult, yearResult, attendanceResult, resultsResult] = await Promise.all([
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
        client.from('attendance_records')
          .select('status,session:attendance_sessions!inner(attendance_date)')
          .eq('school_id', schoolId).eq('student_id', selectedStudent.id)
          .gte('session.attendance_date', attendanceStart.toISOString().slice(0, 10))
          .limit(1000),
        client.from('learning_assessment_results')
          .select('id,assessment_date,marks_obtained,maximum_marks,percentage,assessment:learning_assessments!inner(title,subject)')
          .eq('school_id', schoolId).eq('student_id', selectedStudent.id).eq('status', 'published')
          .order('assessment_date', { ascending: false }).limit(10),
      ]);
      if (profileResult.error) throw profileResult.error;
      if (contactResult.error) throw contactResult.error;
      if (historyResult.error) throw historyResult.error;
      if (documentResult.error) throw documentResult.error;
      if (academicResult.error) throw academicResult.error;
      if (auditResult.error) throw auditResult.error;
      if (yearResult.error) throw yearResult.error;
      if (attendanceResult.error) throw attendanceResult.error;
      if (resultsResult.error) throw resultsResult.error;
      setProfile(profileResult.data as PrivateProfile | null);
      setContacts((contactResult.data ?? []) as EmergencyContact[]);
      setHistory((historyResult.data ?? []) as LifecycleRecord[]);
      setDocuments((documentResult.data ?? []) as StudentDocument[]);
      setAcademicHistory((academicResult.data ?? []) as AcademicYearRecord[]);
      setAuditEvents((auditResult.data ?? []) as StudentAuditEvent[]);
      setAcademicYears((yearResult.data ?? []) as { id: string; name: string }[]);
      setAttendanceSnapshot((attendanceResult.data ?? []) as unknown as StudentAttendanceSnapshot[]);
      setPublishedResults((resultsResult.data ?? []) as unknown as StudentPublishedResult[]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load the student profile.');
    } finally {
      setDetailLoading(false);
    }
  }, [schoolId, selectedStudent, canManage]);

  useEffect(() => { void loadDetails(); }, [loadDetails]);

  const qualityFindings = useMemo<Map<string, StudentQualityFinding>>(() => {
    const identityCounts = new Map<string, number>();
    const nameEmailCounts = new Map<string, number>();
    for (const student of students) {
      const fullName = `${student.first_name.trim().toLowerCase()} ${student.last_name.trim().toLowerCase()}`;
      if (student.date_of_birth) {
        const key = `${fullName}|${student.date_of_birth}`;
        identityCounts.set(key, (identityCounts.get(key) ?? 0) + 1);
      }
      if (student.email) {
        const key = `${fullName}|${student.email.trim().toLowerCase()}`;
        nameEmailCounts.set(key, (nameEmailCounts.get(key) ?? 0) + 1);
      }
    }

    return new Map(students.map((student) => {
      const fullName = `${student.first_name.trim().toLowerCase()} ${student.last_name.trim().toLowerCase()}`;
      const profile = qualityData.profiles[student.id];
      const issues: string[] = [];
      if (!student.student_number.trim()) issues.push('Missing student ID');
      if (!student.first_name.trim() || !student.last_name.trim()) issues.push('Incomplete student name');
      if (!student.date_of_birth) issues.push('Missing date of birth');
      else if (student.date_of_birth > new Date().toISOString().slice(0, 10)) issues.push('Date of birth is in the future');
      if (student.status === 'active' && !student.class_id) issues.push('Active student has no class');
      if (!student.email?.trim()) issues.push('Missing student email');
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(student.email.trim())) issues.push('Invalid student email format');
      if (!profile?.phone?.trim()) issues.push('Missing contact phone');
      if (!profile?.address?.trim() || !profile.city?.trim() || !profile.country?.trim()) issues.push('Incomplete home address');
      if (!profile?.admission_date) issues.push('Missing admission date');
      else if (student.date_of_birth && profile.admission_date < student.date_of_birth) issues.push('Admission date is before date of birth');
      if (!qualityData.emergencyContacts[student.id]) issues.push('No emergency contact');
      if (!qualityData.documents[student.id]) issues.push('No supporting document');
      const identity = student.date_of_birth ? `${fullName}|${student.date_of_birth}` : '';
      const nameEmail = student.email ? `${fullName}|${student.email.trim().toLowerCase()}` : '';
      const possibleDuplicate = Boolean(identity && (identityCounts.get(identity) ?? 0) > 1)
        || Boolean(nameEmail && (nameEmailCounts.get(nameEmail) ?? 0) > 1);
      return [student.id, { issues, possibleDuplicate }] as const;
    }));
  }, [qualityData, students]);
  const studentsNeedingAttention = [...qualityFindings.values()].filter((finding) => finding.issues.length > 0).length;
  const possibleDuplicateCount = [...qualityFindings.values()].filter((finding) => finding.possibleDuplicate).length;
  const filteredStudents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return students.filter((student) => {
      const matchesSearch = !needle || `${student.first_name} ${student.last_name} ${student.student_number} ${student.email ?? ''} ${student.school_classes?.name ?? ''}`
        .toLowerCase().includes(needle);
      const finding = qualityFindings.get(student.id);
      const matchesQuality = qualityFilter === 'all'
        || (qualityFilter === 'needs_attention' && Boolean(finding?.issues.length))
        || (qualityFilter === 'possible_duplicate' && Boolean(finding?.possibleDuplicate));
      return matchesSearch && matchesQuality;
    });
  }, [students, query, qualityFilter, qualityFindings]);

  const completenessChecks = useMemo(() => selectedStudent ? [
    { label: 'Student identifier', complete: Boolean(selectedStudent.student_number) },
    { label: 'First and last name', complete: Boolean(selectedStudent.first_name && selectedStudent.last_name) },
    { label: 'Date of birth', complete: Boolean(selectedStudent.date_of_birth) },
    { label: 'Class enrolment', complete: Boolean(selectedStudent.class_id) },
    { label: 'Email address', complete: Boolean(selectedStudent.email) },
    { label: 'Phone number', complete: Boolean(profile?.phone) },
    { label: 'Home address', complete: Boolean(profile?.address && profile?.city && profile?.country) },
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

  function handleAddStudent() {
    setSelectedId('');
    openForm();
  }

  const qualityDescription = students.length + ' records monitored';

  return (
    <div className="page-stack cc-flex-col">
      <SectionHeading
        eyebrow={activeMembership?.school.name}
        title="Students"
        description="Student 360 profiles, data quality, class enrolment, learning progress, documents, and student history."
      />
      {canManage && (
        <Button variant="primary" onClick={handleAddStudent}>
          <Plus size={17} /> Add student
        </Button>
      )}

      {canManage && <Card className="cc-mb-6">
        <CardContent className="cc-p-5">
          <SectionHeading
            eyebrow="Data quality centre"
            title="Missing and inconsistent student information"
            description={qualityDescription}
          />
          {qualityLoading ? (
            <LoadingState label="Checking student records…" />
          ) : qualityError ? (
            <ErrorState message={qualityError} />
          ) : (
            <>
              <div className="cc-grid cc-grid-cols-3 gap-4 cc-mb-4">
                <Button variant="quiet" size="sm" className={qualityFilter === 'all' ? 'cc-flex cc-flex-col items-start gap-1 bg-primary-soft text-primary border-primary/20 hover:bg-surface-soft' : 'cc-flex cc-flex-col items-start gap-1 border-border hover:bg-surface-soft'} onClick={() => setQualityFilter('all')}>
                  <span className="cc-text-xs cc-font-semibold cc-text-muted">Student records</span>
                  <strong className="cc-text-sm cc-font-bold cc-text-ink">{students.length.toLocaleString()}</strong>
                  <span className="cc-text-xs cc-text-muted">Show all records</span>
                </Button>
                <Button variant="quiet" size="sm" className={qualityFilter === 'needs_attention' ? 'cc-flex cc-flex-col items-start gap-1 bg-primary-soft text-primary border-primary/20 hover:bg-surface-soft' : 'cc-flex cc-flex-col items-start gap-1 border-border hover:bg-surface-soft'} onClick={() => setQualityFilter('needs_attention')}>
                  <span className="cc-text-xs cc-font-semibold cc-text-muted">Need attention</span>
                  <strong className="cc-text-sm cc-font-bold cc-text-ink">{studentsNeedingAttention.toLocaleString()}</strong>
                  <span className="cc-text-xs cc-text-muted">Missing or inconsistent fields</span>
                </Button>
                <Button variant="quiet" size="sm" className={qualityFilter === 'possible_duplicate' ? 'cc-flex cc-flex-col items-start gap-1 bg-primary-soft text-primary border-primary/20 hover:bg-surface-soft' : 'cc-flex cc-flex-col items-start gap-1 border-border hover:bg-surface-soft'} onClick={() => setQualityFilter('possible_duplicate')}>
                  <span className="cc-text-xs cc-font-semibold cc-text-muted">Possible duplicates</span>
                  <strong className="cc-text-sm cc-font-bold cc-text-ink">{possibleDuplicateCount.toLocaleString()}</strong>
                  <span className="cc-text-xs cc-text-muted">Review matching identity details</span>
                </Button>
              </div>
              <p className="cc-text-sm cc-text-muted leading-relaxed">
                Checks include required identity and contact fields, active class placement, date consistency, emergency contacts, supporting documents, and potential duplicate identities. Flags are review prompts, not automatic corrections.
              </p>
            </>
          )}
        </CardContent>
      </Card>}

      {success && <Alert variant="success" className="cc-mb-4">{success}</Alert>}
      {error && <ErrorState message={error} />}

      <div className="student-manager-layout cc-grid cc-grid-cols-1 lg:cc-grid-cols-12 gap-6">
        <section className="lg:cc-col-span-5">
          <Card className="cc-h-full">
            <CardContent className="cc-p-5">
              <div className="cc-flex items-center justify-between gap-3 cc-mb-4">
                <label className="field cc-w-full cc-max-w-md">
                  <Search size={16} className="cc-absolute cc-left-3 cc-top-1/2 cc-transform -cc-translate-y-1/2 cc-text-muted" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search name, student ID, or class"
                    aria-label="Search students"
                    className="input-base cc-pl-9"
                  />
                </label>
                {canManage && (
                  <Select
                    label="Filter by data quality"
                    value={qualityFilter}
                    disabled={qualityLoading || Boolean(qualityError)}
                    onChange={(event) => setQualityFilter(event.target.value as typeof qualityFilter)}
                  >
                    <option value="all">All quality statuses</option>
                    <option value="needs_attention">Needs attention</option>
                    <option value="possible_duplicate">Possible duplicates</option>
                  </Select>
                )}
              </div>
              {loading ? (
                <LoadingState label="Loading students…" />
              ) : filteredStudents.length === 0 ? (
                <EmptyState title={query ? 'No matching students' : 'No students yet'} detail={canManage ? 'Add a student to begin building your school records.' : 'Student records will appear here when available.'} />
              ) : (
                <div className="student-record-list cc-divide-y cc-divide-border">
                  {filteredStudents.map((student) => (
                    <button
                      key={student.id}
                      className="cc-flex items-center gap-4 cc-p-4 rounded-lg border border-transparent hover:bg-surface-soft hover:border-border transition-colors cc-block"
                      onClick={() => setSelectedId(student.id)}
                      aria-selected={student.id === selectedId}
                    >
                      {studentAvatar(`${student.first_name.slice(0, 1)}${student.last_name.slice(0, 1)}`)}
                      <div className="cc-flex-1 cc-min-w-0">
                        <div className="cc-flex items-center gap-2">
                          <strong className="cc-text-sm cc-font-semibold cc-text-ink truncate">{student.first_name} {student.last_name}</strong>
                          <Badge variant="soft" className="cc-text-xs">{student.student_number}</Badge>
                        </div>
                        <small className="cc-text-xs cc-text-muted truncate">{student.school_classes?.name ?? 'No class assigned'}</small>
                        {canManage && (
                          <p className="cc-text-xs cc-mt-1">
                            {qualityLoading ? 'Checking data quality…' : `${qualityFindings.get(student.id)?.possibleDuplicate ? 'Possible duplicate · ' : ''}${qualityFindings.get(student.id)?.issues.length ? `${qualityFindings.get(student.id)?.issues.length} data-quality flags` : 'No data-quality flags'}`}
                          </p>
                        )}
                      </div>
                      <StatusPill variant={statusVariant[student.status]} label={statusLabels[student.status]} className="cc-text-xs" />
                    </button>
                  ))}
                </div>
              )}
              <p className="cc-text-xs cc-text-muted cc-mt-3">{filteredStudents.length} of {students.length} students</p>
            </CardContent>
          </Card>
        </section>

        <section className="lg:cc-col-span-7 cc-h-full">
          {!selectedStudent ? (
            <Card className="cc-h-full cc-flex cc-flex-col cc-items-center cc-justify-center cc-py-20">
              <CardContent className="cc-p-8 text-center">
                <EmptyState title="Select a student" detail="Choose a student from the list to view their profile and history." />
              </CardContent>
            </Card>
          ) : (
            <Card className="cc-h-full cc-overflow-hidden">
              <CardContent className="cc-p-5 cc-overflow-y-auto cc-h-full">
                <div className="cc-flex items-center gap-4 cc-mb-5">
                  {studentAvatar(`${selectedStudent.first_name.slice(0, 1)}${selectedStudent.last_name.slice(0, 1)}`)}
                  <div>
                    <span className="eyebrow cc-block cc-mb-1">Student profile</span>
                    <h2 className="cc-text-2xl cc-font-bold cc-leading-tight cc-text-ink cc-mb-1">{selectedStudent.first_name} {selectedStudent.last_name}</h2>
                    <p className="cc-text-sm cc-text-muted">{selectedStudent.student_number} · {selectedStudent.school_classes?.name ?? 'No class assigned'}</p>
                  </div>
                  {canManage && (
                    <Button variant="secondary" onClick={openForm}>Edit profile</Button>
                  )}
                </div>

                {detailLoading ? (
                  <LoadingState label="Loading student details…" />
                ) : canManage ? (
                  <>
                    <section className="cc-mb-6">
                      <div className="cc-flex items-center gap-2 cc-mb-3">
                        <GraduationCap size={16} className="cc-text-muted" />
                        <h3 className="cc-text-lg cc-font-bold cc-text-ink">Student 360 · leadership overview</h3>
                      </div>
                      <div className="cc-grid cc-grid-cols-1 sm:cc-grid-cols-3 gap-4">
                        <Card className="cc-p-4">
                          <CardContent className="cc-p-0">
                            <span className="cc-text-xs cc-font-semibold cc-text-muted cc-block cc-mb-1">Attendance · 90 days</span>
                            <strong className="cc-text-lg cc-font-bold cc-text-ink cc-block">
                              {(() => {
                                const attended = attendanceSnapshot.filter((record) => record.status === 'present' || record.status === 'late').length;
                                const counted = attendanceSnapshot.filter((record) => record.status !== 'excused').length;
                                const attendancePercent = counted ? Math.round(attended / counted * 100) : null;
                                return attendancePercent === null ? '—' : `${attendancePercent}%`;
                              })()}
                            </strong>
                            <span className="cc-text-xs cc-text-muted">{attendanceSnapshot.length} recorded sessions · excused sessions excluded</span>
                          </CardContent>
                        </Card>
                        <Card className="cc-p-4">
                          <CardContent className="cc-p-0">
                            <span className="cc-text-xs cc-font-semibold cc-text-muted cc-block cc-mb-1">Published assessments</span>
                            <strong className="cc-text-lg cc-font-bold cc-text-ink cc-block">{publishedResults.length}</strong>
                            <span className="cc-text-xs cc-text-muted">
                              {(() => {
                                const averageResult = publishedResults.length
                                  ? publishedResults.reduce((total, result) => total + Number(result.percentage), 0) / publishedResults.length
                                  : null;
                                return averageResult === null ? 'No published results' : `${averageResult.toFixed(1)}% average across recent results`;
                              })()}
                            </span>
                          </CardContent>
                        </Card>
                        <Card className="cc-p-4">
                          <CardContent className="cc-p-0">
                            <span className="cc-text-xs cc-font-semibold cc-text-muted cc-block cc-mb-1">Profile completeness</span>
                            <strong className="cc-text-lg cc-font-bold cc-text-ink cc-block">{completenessPercent}%</strong>
                            <span className="cc-text-xs cc-text-muted">{completenessChecks.filter((item) => item.complete).length} of {completenessChecks.length} checks complete</span>
                          </CardContent>
                        </Card>
                      </div>
                      {publishedResults.length > 0 && (
                        <div className="cc-mt-6">
                          <strong className="cc-text-sm cc-font-semibold cc-text-ink cc-block cc-mb-2">Recent published results</strong>
                          {publishedResults.slice(0, 5).map((result) => {
                            const assessment = Array.isArray(result.assessment) ? result.assessment[0] : result.assessment;
                            return (
                              <div key={result.id} className="cc-flex items-center justify-between gap-3 cc-px-3 cc-py-2 rounded-lg bg-surface-soft cc-mb-1">
                                <span className="cc-text-sm cc-text-muted truncate">{assessment?.title ?? 'Assessment'}{assessment?.subject ? ` · ${assessment.subject}` : ''}</span>
                                <strong className="cc-text-sm cc-font-bold cc-text-ink">{Number(result.percentage).toFixed(1)}%</strong>
                                <span className="cc-text-xs cc-text-muted">{new Date(`${result.assessment_date}T00:00:00`).toLocaleDateString()}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </section>

                    <section className="cc-mb-6">
                      <div className="cc-flex items-center gap-2 cc-mb-3">
                        <UsersRound size={16} className="cc-text-muted" />
                        <h3 className="cc-text-lg cc-font-bold cc-text-ink">Profile completeness</h3>
                        <span className="cc-text-xs cc-font-semibold cc-text-muted ml-auto">{completenessPercent}%</span>
                      </div>
                      <div className="student-completeness-track cc-w-full cc-bg-surface-soft cc-h-1.5 rounded-full cc-overflow-hidden cc-mb-3" role="progressbar" aria-label="Student profile completeness" aria-valuenow={completenessPercent} aria-valuemin={0} aria-valuemax={100}>
                        <span className="cc-h-full bg-primary cc-transition-all cc-duration-500" style={{ width: `${completenessPercent}%` }} />
                      </div>
                      <ul className="student-completeness-list cc-divide-y cc-divide-border">
                        {completenessChecks.map((item) => (
                          <li key={item.label} className="cc-flex items-center justify-between gap-3 cc-px-3 cc-py-2 rounded-lg cc-mb-1 cc-text-sm">
                            <span className={`cc-font-medium ${item.complete ? 'cc-text-success' : 'cc-text-text'}`}>
                              {item.complete ? 'Complete' : 'Missing'} · {item.label}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </section>

                    <section className="cc-mb-6">
                      <div className="cc-flex items-center gap-2 cc-mb-3">
                        <ShieldCheck size={16} className="cc-text-muted" />
                        <h3 className="cc-text-lg cc-font-bold cc-text-ink">Data-quality findings</h3>
                        <span className="cc-text-xs cc-font-semibold cc-text-muted ml-auto">{qualityFindings.get(selectedStudent.id)?.issues.length ?? 0}</span>
                      </div>
                      {qualityLoading ? (
                        <LoadingState label="Checking this record…" />
                      ) : qualityError ? (
                        <ErrorState message={qualityError} />
                      ) : (
                        <>
                          {qualityFindings.get(selectedStudent.id)?.possibleDuplicate && (
                            <Alert variant="warning" className="cc-mb-3">Possible duplicate identity match. Compare this record with others before taking action.</Alert>
                          )}
                          {qualityFindings.get(selectedStudent.id)?.issues.length
                            ? (
                              <ul className="cc-space-y-2">
                                {qualityFindings.get(selectedStudent.id)?.issues.map((issue) => (
                                  <li key={issue} className="cc-flex items-start gap-2 cc-px-3 cc-py-2 rounded-lg border border-border bg-surface">
                                    <span className="cc-text-xs cc-font-semibold cc-text-danger cc-shrink-0">!</span>
                                    <span className="cc-text-sm cc-text-text">{issue}</span>
                                  </li>
                                ))}
                              </ul>
                            )
                            : (
                              <Alert variant="success">No data-quality issues were found by the current checks.</Alert>
                            )}
                        </>
                      )}
                    </section>

                    <section className="cc-mb-6">
                      <div className="cc-flex items-center gap-2 cc-mb-3">
                        <UserRound size={16} className="cc-text-muted" />
                        <h3 className="cc-text-lg cc-font-bold cc-text-ink">Personal and contact information</h3>
                      </div>
                      <dl className="student-profile-grid cc-grid cc-grid-cols-1 sm:cc-grid-cols-2 gap-4 cc-text-sm">
                        <div className="cc-flex flex-col gap-1">
                          <dt className="cc-font-semibold cc-text-muted">Email</dt>
                          <dd className="cc-text-text">{selectedStudent.email || '—'}</dd>
                        </div>
                        <div className="cc-flex flex-col gap-1">
                          <dt className="cc-font-semibold cc-text-muted">Phone</dt>
                          <dd className="cc-text-text">{profile?.phone || '—'}</dd>
                        </div>
                        <div className="cc-flex flex-col gap-1">
                          <dt className="cc-font-semibold cc-text-muted">Date of birth</dt>
                          <dd className="cc-text-text">{selectedStudent.date_of_birth || '—'}</dd>
                        </div>
                        <div className="cc-flex flex-col gap-1">
                          <dt className="cc-font-semibold cc-text-muted">Gender</dt>
                          <dd className="cc-text-text">{profile?.gender || '—'}</dd>
                        </div>
                        <div className="cc-flex flex-col gap-1">
                          <dt className="cc-font-semibold cc-text-muted">Nationality</dt>
                          <dd className="cc-text-text">{profile?.nationality || '—'}</dd>
                        </div>
                        <div className="cc-flex flex-col gap-1 cc-col-span-2">
                          <dt className="cc-font-semibold cc-text-muted">Address</dt>
                          <dd className="cc-text-text">{[profile?.address, profile?.city, profile?.region, profile?.postal_code, profile?.country].filter(Boolean).join(', ') || '—'}</dd>
                        </div>
                        <div className="cc-flex flex-col gap-1 cc-col-span-2">
                          <dt className="cc-font-semibold cc-text-muted">Admission date</dt>
                          <dd className="cc-text-text">{profile?.admission_date || '—'}</dd>
                        </div>
                        <div className="cc-flex flex-col gap-1 cc-col-span-2">
                          <dt className="cc-font-semibold cc-text-muted">Emergency contacts</dt>
                          <dd className="cc-text-text">{contacts.length ? contacts.map((item) => `${item.contact_name} · ${item.relationship || 'Contact'} · ${item.phone}${item.email ? ` · ${item.email}` : ''}`).join(' | ') : '—'}</dd>
                        </div>
                      </dl>
                    </section>

                    <section className="cc-mb-6">
                      <div className="cc-flex items-center gap-2 cc-mb-3">
                        <FileText size={16} className="cc-text-muted" />
                        <h3 className="cc-text-lg cc-font-bold cc-text-ink">Student documents <span className="cc-text-xs cc-font-semibold cc-text-muted ml-2">{documents.length}</span></h3>
                      </div>
                      <form className="student-upload-form cc-flex flex-col gap-3 cc-mb-4" onSubmit={(event) => void uploadDocument(event)}>
                        <label className="field">
                          <span>Choose a document</span>
                          <input
                            name="student_document"
                            type="file"
                            accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                            disabled={uploading}
                            aria-label="Choose a student document"
                            className="input-base"
                          />
                          <small>PDF, JPG, PNG, DOC, or DOCX · 50 MB maximum</small>
                        </label>
                        <Button variant="secondary" type="submit" disabled={uploading} className="cc-w-auto">{uploading ? 'Uploading…' : 'Upload document'}</Button>
                      </form>
                      {documents.length ? (
                        <div className="student-document-list cc-divide-y cc-divide-border">
                          {documents.map((document) => (
                            <div key={document.id} className="cc-flex items-center justify-between gap-3 cc-px-3 cc-py-3 rounded-lg border border-border bg-surface cc-mb-1">
                              <div className="cc-flex items-center gap-3">
                                <FileText size={16} className="cc-text-muted" />
                                <div>
                                  <strong className="cc-text-sm cc-font-semibold cc-text-ink cc-block">{document.file_name}</strong>
                                  <small className="cc-text-xs cc-text-muted">{ (document.file_size / 1024 / 1024).toFixed(2) } MB · {new Date(document.created_at).toLocaleDateString()}</small>
                                </div>
                              </div>
                              <div className="cc-flex items-center gap-1">
                                <IconButton icon={<ArrowDownToLine size={17} />} onClick={() => void downloadDocument(document)} aria-label={`Open ${document.file_name}`} />
                                <IconButton icon={<X size={17} />} onClick={() => void deleteDocument(document)} aria-label={`Delete ${document.file_name}`} className="cc-text-danger hover:bg-danger-soft" />
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="cc-text-sm cc-text-muted cc-py-4 cc-text-center">No documents uploaded.</p>
                      )}
                    </section>

                    <section className="cc-mb-6">
                      <div className="cc-flex items-center gap-2 cc-mb-3">
                        <CalendarDays size={16} className="cc-text-muted" />
                        <h3 className="cc-text-lg cc-font-bold cc-text-ink">Academic-year history</h3>
                      </div>
                      {academicHistory.length ? (
                        <ol className="student-history cc-space-y-2">
                          {academicHistory.map((record) => (
                            <li key={record.id} className="cc-flex items-start gap-3 cc-px-3 cc-py-2 rounded-lg border border-border bg-surface">
                              <span>
                                <strong className="cc-text-sm cc-font-semibold cc-text-ink">{academicYears.find((year) => year.id === record.academic_year_id)?.name ?? 'Unknown academic year'}</strong>
                                <br />
                                <small className="cc-text-xs cc-text-muted">{classes.find((item) => item.id === record.class_id)?.name ?? 'Class unavailable'} · enrolled {new Date(`${record.enrolled_at}T00:00:00`).toLocaleDateString()}{record.ended_at ? ` · ended ${new Date(`${record.ended_at}T00:00:00`).toLocaleDateString()}` : ' · current'}</small>
                              </span>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p className="cc-text-sm cc-text-muted cc-py-4 cc-text-center">No academic-year enrolments have been recorded yet.</p>
                      )}
                    </section>

                    <section className="cc-mb-6">
                      <div className="cc-flex items-center gap-2 cc-mb-3">
                        <ClipboardCheck size={16} className="cc-text-muted" />
                        <h3 className="cc-text-lg cc-font-bold cc-text-ink">Student timeline</h3>
                      </div>
                      {timelineEvents.length ? (
                        <ol className="student-history cc-space-y-2">
                          {timelineEvents.map((item) => (
                            <li key={item.id} className="cc-flex items-start gap-3 cc-px-3 cc-py-2 rounded-lg border border-border bg-surface">
                              <span>
                                <strong className="cc-text-sm cc-font-semibold cc-text-ink">{item.title}</strong>
                                <br />
                                <small className="cc-text-xs cc-text-muted">{new Date(`${item.date.slice(0, 10)}T00:00:00`).toLocaleDateString()}</small>
                                {item.detail && <br />}
                                {item.detail && <small className="cc-text-xs cc-text-muted cc-block cc-mt-0.5">{item.detail}</small>}
                              </span>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p className="cc-text-sm cc-text-muted cc-py-4 cc-text-center">No student events have been recorded.</p>
                      )}
                    </section>

                    <section className="cc-mb-6">
                      <div className="cc-flex items-center gap-2 cc-mb-3">
                        <GitMerge size={16} className="cc-text-muted" />
                        <h3 className="cc-text-lg cc-font-bold cc-text-ink">Merge duplicate student record</h3>
                      </div>
                      <p className="cc-text-sm cc-text-muted cc-mb-4">The selected student remains the surviving record. Linked records move to it; the duplicate is retained as an archived reference. Conflicting unique attendance or assessment records must be resolved first.</p>
                      <Select
                        label="Duplicate to merge into this student"
                        value={mergeCandidateId}
                        onChange={(event) => setMergeCandidateId(event.target.value)}
                        disabled={merging}
                      >
                        <option value="">Choose a student record</option>
                        {students.filter((student) => student.id !== selectedStudent.id).map((student) => (
                          <option key={student.id} value={student.id}>{student.first_name} {student.last_name} · {student.student_number}</option>
                        ))}
                      </Select>
                      <Textarea
                        label="Merge reason"
                        value={mergeReason}
                        onChange={(event) => setMergeReason(event.target.value)}
                        rows={2}
                        maxLength={1000}
                        required
                        disabled={merging}
                        hint="Explain why these records are duplicates"
                      />
                      <Button
                        variant="secondary"
                        type="button"
                        onClick={() => void mergeStudentRecords()}
                        disabled={merging || !mergeCandidateId || mergeReason.trim().length < 3}
                        className="cc-w-auto"
                      >
                        {merging ? 'Merging…' : 'Review and merge records'}
                      </Button>
                    </section>
                  </>
                ) : (
                  <section className="cc-p-4">
                    <h3 className="cc-text-lg cc-font-bold cc-text-ink cc-mb-3">Student information</h3>
                    <dl className="student-profile-grid cc-grid cc-grid-cols-1 sm:cc-grid-cols-2 gap-4 cc-text-sm">
                      <div className="cc-flex flex-col gap-1">
                        <dt className="cc-font-semibold cc-text-muted">Email</dt>
                        <dd className="cc-text-text">{selectedStudent.email || '—'}</dd>
                      </div>
                      <div className="cc-flex flex-col gap-1">
                        <dt className="cc-font-semibold cc-text-muted">Date of birth</dt>
                        <dd className="cc-text-text">{selectedStudent.date_of_birth || '—'}</dd>
                      </div>
                      <div className="cc-flex flex-col gap-1 cc-col-span-2">
                        <dt className="cc-font-semibold cc-text-muted">Status</dt>
                        <dd className="cc-text-text">{statusLabels[selectedStudent.status]}</dd>
                      </div>
                    </dl>
                    <p className="cc-text-xs cc-text-muted cc-mt-4">Private contact details, emergency contacts, and documents are available to the school administrator.</p>
                  </section>
                )}
              </CardContent>
            </Card>
          )}
          </section>
        </div>

        {showForm && (
          <Modal isOpen={showForm} onClose={() => setShowForm(false)} title={selectedStudent ? 'Edit student profile' : 'Add student'}>
            {formError && <div className="cc-mb-4"><ErrorState message={formError} /></div>}
            <form onSubmit={(event) => void saveStudent(event)} className="cc-space-y-4">
              <div className="cc-grid cc-grid-cols-1 sm:cc-grid-cols-2 gap-4">
                <Input label="First name" required name="first_name" maxLength={80} defaultValue={selectedStudent?.first_name ?? ''} />
                <Input label="Last name" required name="last_name" maxLength={80} defaultValue={selectedStudent?.last_name ?? ''} />
              </div>
              <div className="cc-grid cc-grid-cols-1 sm:cc-grid-cols-2 gap-4">
                <Input label="Email" type="email" name="email" maxLength={254} defaultValue={selectedStudent?.email ?? ''} />
                <Input label="Phone" type="tel" name="phone" maxLength={40} defaultValue={profileValue(profile, 'phone')} />
              </div>
              <div className="cc-grid cc-grid-cols-1 sm:cc-grid-cols-2 gap-4">
                <Input label="Date of birth" type="date" name="date_of_birth" defaultValue={selectedStudent?.date_of_birth ?? ''} />
                <Input label="Admission date" type="date" name="admission_date" defaultValue={profileValue(profile, 'admission_date')} />
              </div>
              <div className="cc-grid cc-grid-cols-1 sm:cc-grid-cols-2 gap-4">
                <Select label="Class enrolment" name="class_id" defaultValue={selectedStudent?.class_id ?? ''}>
                  <option value="">Not assigned</option>
                  {classes.map((schoolClass) => (
                    <option key={schoolClass.id} value={schoolClass.id}>{schoolClass.name}</option>
                  ))}
                </Select>
                <Select label="Status" name="status" defaultValue={selectedStudent?.status ?? 'active'}>
                  {Object.entries(statusLabels).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </Select>
              </div>
              <div className="cc-grid cc-grid-cols-1 sm:cc-grid-cols-2 gap-4">
                <Input label="Gender" name="gender" maxLength={60} defaultValue={profileValue(profile, 'gender')} />
                <Input label="Nationality" name="nationality" maxLength={80} defaultValue={profileValue(profile, 'nationality')} />
              </div>
              <Input label="Street address" name="address" maxLength={240} defaultValue={profileValue(profile, 'address')} />
              <div className="cc-grid cc-grid-cols-1 sm:cc-grid-cols-2 gap-4">
                <Input label="City / town" name="city" maxLength={100} defaultValue={profileValue(profile, 'city')} />
                <Input label="Region / state" name="region" maxLength={100} defaultValue={profileValue(profile, 'region')} />
              </div>
              <div className="cc-grid cc-grid-cols-1 sm:cc-grid-cols-2 gap-4">
                <Input label="Postal code" name="postal_code" maxLength={24} defaultValue={profileValue(profile, 'postal_code')} />
                <Input label="Country" name="country" maxLength={80} defaultValue={profileValue(profile, 'country')} />
              </div>
              <h3 className="cc-text-lg cc-font-bold cc-text-ink cc-mt-6 cc-mb-3">Transfer or withdrawal details</h3>
              <Textarea label="Reason (required for transfer or withdrawal)" name="movement_reason" rows={2} maxLength={1000} />
              <Input label="Destination school (required for transfer)" name="destination_school" maxLength={200} />
              <Textarea label="Correction reason (required and recorded in the student audit trail)" name="correction_reason" rows={2} minLength={3} maxLength={1000} required hint="Recorded in the student audit trail" />
              <div className="cc-flex items-center justify-end gap-3 cc-mt-6 cc-pt-4 cc-border-t cc-border-border">
                <Button variant="secondary" type="button" onClick={() => setShowForm(false)}>Cancel</Button>
                <Button variant="primary" type="submit" disabled={saving}>
                  {saving ? 'Saving…' : selectedStudent ? 'Save changes' : 'Add student'}
                </Button>
              </div>
            </form>
          </Modal>
        )}
    </div>
  );
}
