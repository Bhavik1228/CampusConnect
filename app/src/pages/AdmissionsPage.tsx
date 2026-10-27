import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { CalendarClock, Check, ChevronLeft, ChevronRight, ExternalLink, FileCheck2, GraduationCap, Inbox, Plus, RefreshCw, Search, Settings2, UserRoundCheck } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';
import { AdmissionsOperationsPanel } from './AdmissionsOperationsPanel';

type AdmissionStatus = 'submitted' | 'under_review' | 'accepted' | 'rejected' | 'waitlisted' | 'withdrawn' | 'registered';
interface Application {
  id: string;
  application_reference: string;
  source: 'public_website' | 'school_admin';
  status: AdmissionStatus;
  student_first_name: string;
  student_last_name: string;
  date_of_birth: string | null;
  gender: string | null;
  applying_for: string;
  academic_year: string | null;
  previous_school: string | null;
  student_email: string | null;
  student_phone: string | null;
  address: string | null;
  guardian_name: string;
  guardian_relationship: string;
  guardian_email: string;
  guardian_phone: string;
  notes: string | null;
  decision_note: string | null;
  submitted_at: string;
  reviewed_by: string | null;
  decided_at: string | null;
  registered_student_id: string | null;
  registered_class_id: string | null;
  assigned_to: string | null;
  workflow_stage_id: string | null;
  custom_fields: Record<string, string> | null;
  updated_at: string;
}
interface ApplicationDocument {
  id: string;
  file_name: string;
  storage_path: string;
  content_type: string;
  file_size: number;
  uploaded_at: string;
}
interface DocumentChecklistItem {
  id: string;
  document_key: string;
  label: string;
  status: 'pending' | 'received' | 'waived';
  note: string;
}
interface WorkflowStage {
  id: string;
  label: string;
  status: AdmissionStatus;
  active: boolean;
}
interface ApplicationHistory {
  id: string;
  actor_id: string | null;
  actor_name?: string | null;
  action: string;
  from_status: AdmissionStatus | null;
  to_status: AdmissionStatus | null;
  note: string | null;
  created_at: string;
}
interface SchoolClass {
  id: string;
  name: string;
  grade_level: string | null;
  academic_year_id: string | null;
}
interface AdmissionsMember {
  profile_id: string;
  role: string;
  profile: { full_name: string | null; email: string | null } | null;
}
interface Counters {
  submitted: number;
  under_review: number;
  accepted: number;
  rejected: number;
  waitlisted: number;
  withdrawn: number;
  registered: number;
}

const pageSize = 30;
const statusLabels: Record<AdmissionStatus, string> = {
  submitted: 'Submitted',
  under_review: 'Under review',
  accepted: 'Accepted',
  rejected: 'Rejected',
  waitlisted: 'Waitlisted',
  withdrawn: 'Withdrawn',
  registered: 'Registered',
};
const statuses: AdmissionStatus[] = ['submitted', 'under_review', 'accepted', 'rejected', 'waitlisted', 'withdrawn', 'registered'];

function displayDate(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(`${value.slice(0, 10)}T12:00:00`));
}

function displayTimestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function safeSearch(value: string) {
  return value.trim().replace(/[,%()_*\\]/g, ' ').replace(/\s+/g, ' ');
}

export function AdmissionsPage() {
  const { activeMembership } = useAuth();
  const schoolId = activeMembership?.school_id;
  const isAdmin = activeMembership?.role === 'school_admin' || activeMembership?.role === 'admissions_officer';
  const [applications, setApplications] = useState<Application[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [documents, setDocuments] = useState<ApplicationDocument[]>([]);
  const [checklist, setChecklist] = useState<DocumentChecklistItem[]>([]);
  const [workflowStages, setWorkflowStages] = useState<WorkflowStage[]>([]);
  const [history, setHistory] = useState<ApplicationHistory[]>([]);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [admissionsMembers, setAdmissionsMembers] = useState<AdmissionsMember[]>([]);
  const [counters, setCounters] = useState<Counters>({
    submitted: 0, under_review: 0, accepted: 0, rejected: 0, waitlisted: 0, withdrawn: 0, registered: 0,
  });
  const [filterStatus, setFilterStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [decisionStatus, setDecisionStatus] = useState<AdmissionStatus>('under_review');
  const [decisionStageId, setDecisionStageId] = useState('');
  const [decisionNote, setDecisionNote] = useState('');
  const [placementClassId, setPlacementClassId] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [total, setTotal] = useState(0);
  const [realtimeState, setRealtimeState] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const [section, setSection] = useState<'applications' | 'configuration' | 'enquiries' | 'appointments'>('applications');
  const [showCreateForm, setShowCreateForm] = useState(false);

  const selected = applications.find((application) => application.id === selectedId) ?? null;
  const classById = useMemo(() => new Map(classes.map((item) => [item.id, item.name])), [classes]);

  const loadApplications = useCallback(async () => {
    if (!schoolId || !isAdmin) {
      setApplications([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      let query = client.from('admission_applications')
        .select('*', { count: 'exact' })
        .eq('school_id', schoolId)
        .order('submitted_at', { ascending: false })
        .range(page * pageSize, (page + 1) * pageSize - 1);
      if (filterStatus) query = query.eq('status', filterStatus);
      const term = safeSearch(search);
      if (term) {
        const pattern = `%${term}%`;
        query = query.or([
          `application_reference.ilike.${pattern}`,
          `student_first_name.ilike.${pattern}`,
          `student_last_name.ilike.${pattern}`,
          `guardian_name.ilike.${pattern}`,
          `guardian_email.ilike.${pattern}`,
        ].join(','));
      }
      const { data, count, error: queryError } = await query;
      if (queryError) throw queryError;
      const rows = (data ?? []) as Application[];
      setApplications(rows);
      setTotal(count ?? 0);
      setSelectedId((current) => current && rows.some((row) => row.id === current) ? current : (rows[0]?.id ?? ''));

      const nextCounters = {} as Counters;
      const countResults = await Promise.all(statuses.map(async (status) => {
        const { count: statusCount, error: countError } = await client.from('admission_applications')
          .select('id', { count: 'exact', head: true })
          .eq('school_id', schoolId)
          .eq('status', status);
        if (countError) throw countError;
        return [status, statusCount ?? 0] as const;
      }));
      for (const [status, countValue] of countResults) nextCounters[status] = countValue;
      setCounters({
        submitted: nextCounters.submitted,
        under_review: nextCounters.under_review,
        accepted: nextCounters.accepted,
        rejected: nextCounters.rejected,
        waitlisted: nextCounters.waitlisted,
        withdrawn: nextCounters.withdrawn,
        registered: nextCounters.registered,
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load admission applications.');
    } finally {
      setLoading(false);
    }
  }, [filterStatus, isAdmin, page, schoolId, search]);

  useEffect(() => { void loadApplications(); }, [loadApplications, refreshKey]);

  useEffect(() => {
    if (!schoolId || !isAdmin) return;
    let alive = true;
    async function loadClasses() {
      try {
        const { data, error: classesError } = await requireSupabase()
          .from('school_classes')
          .select('id, name, grade_level, academic_year_id')
          .eq('school_id', schoolId)
          .order('name');
        if (classesError) throw classesError;
        if (alive) setClasses((data ?? []) as SchoolClass[]);
      } catch (loadError) {
        if (alive) setError(loadError instanceof Error ? loadError.message : 'Could not load class placement options.');
      }
    }
    void loadClasses();
    return () => { alive = false; };
  }, [isAdmin, schoolId]);

  useEffect(() => {
    if (!schoolId || !isAdmin) return;
    let alive = true;
    void (async () => {
      try {
        const { data, error: membersError } = await requireSupabase().from('school_memberships')
          .select('profile_id,role,profile:profiles(full_name,email)')
          .eq('school_id', schoolId)
          .in('role', ['school_admin', 'admissions_officer'])
          .order('created_at');
        if (membersError) throw membersError;
        if (alive) setAdmissionsMembers((data ?? []) as unknown as AdmissionsMember[]);
      } catch (loadError) {
        if (alive) setError(loadError instanceof Error ? loadError.message : 'Could not load admissions staff.');
      }
    })();
    return () => { alive = false; };
  }, [isAdmin, schoolId]);

  useEffect(() => {
    if (!schoolId || !isAdmin) return;
    setRealtimeState('connecting');
    const channel = requireSupabase().channel(`admissions-${schoolId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'admission_applications',
        filter: `school_id=eq.${schoolId}`,
      }, () => setRefreshKey((current) => current + 1))
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') setRealtimeState('live');
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setRealtimeState('offline');
          setError('Live admissions updates are unavailable. Use Refresh to load the latest data.');
        }
      });
    return () => {
      setRealtimeState('connecting');
      void requireSupabase().removeChannel(channel);
    };
  }, [isAdmin, schoolId]);

  useEffect(() => {
    if (realtimeState === 'live' || !schoolId || !isAdmin) return;
    const interval = window.setInterval(() => setRefreshKey((current) => current + 1), 30000);
    return () => window.clearInterval(interval);
  }, [isAdmin, realtimeState, schoolId]);

  useEffect(() => {
    if (!schoolId || !selectedId || !isAdmin) {
      setDocuments([]);
      setHistory([]);
      return;
    }
    let alive = true;
    setDetailLoading(true);
    async function loadApplicationDetails() {
      try {
        const client = requireSupabase();
        const [documentResult, historyResult, checklistResult, stageResult] = await Promise.all([
          client.from('admission_application_documents')
            .select('id, file_name, storage_path, content_type, file_size, uploaded_at')
            .eq('school_id', schoolId).eq('application_id', selectedId).order('uploaded_at', { ascending: false }),
          client.from('admission_application_history')
            .select('id, actor_id, action, from_status, to_status, note, created_at')
            .eq('school_id', schoolId).eq('application_id', selectedId).order('created_at', { ascending: false }),
          client.from('admission_document_checklist')
            .select('id, document_key, label, status, note')
            .eq('school_id', schoolId).eq('application_id', selectedId).order('label'),
          client.from('admission_workflow_stages')
            .select('id, label, status, active')
            .eq('school_id', schoolId).eq('active', true).order('sort_order'),
        ]);
        if (documentResult.error) throw documentResult.error;
        if (historyResult.error) throw historyResult.error;
        if (checklistResult.error) throw checklistResult.error;
        if (stageResult.error) throw stageResult.error;
        const events = (historyResult.data ?? []) as ApplicationHistory[];
        const actorIds = [...new Set(events.flatMap((event) => event.actor_id ? [event.actor_id] : []))];
        const actorNames = new Map<string, string>();
        if (actorIds.length) {
          const { data: actors, error: actorError } = await client.from('profiles').select('id, full_name').in('id', actorIds);
          if (actorError) throw actorError;
          for (const actor of actors ?? []) actorNames.set(actor.id, actor.full_name);
        }
        if (!alive) return;
        setDocuments((documentResult.data ?? []) as ApplicationDocument[]);
        setChecklist((checklistResult.data ?? []) as DocumentChecklistItem[]);
        const activeStages = (stageResult.data ?? []) as WorkflowStage[];
        setWorkflowStages(activeStages);
        setHistory(events.map((event) => ({ ...event, actor_name: event.actor_id ? actorNames.get(event.actor_id) ?? null : null })));
        const application = applications.find((row) => row.id === selectedId);
        setDecisionStatus(application?.status === 'submitted' ? 'under_review' : application?.status ?? 'under_review');
        setDecisionStageId(application?.workflow_stage_id ?? activeStages.find((stage) => stage.status === (application?.status === 'submitted' ? 'under_review' : application?.status))?.id ?? '');
        setDecisionNote(application?.decision_note ?? '');
        setPlacementClassId(application?.registered_class_id ?? '');
        setAssignedTo(application?.assigned_to ?? '');
      } catch (loadError) {
        if (alive) setError(loadError instanceof Error ? loadError.message : 'Could not load application documents or history.');
      } finally {
        if (alive) setDetailLoading(false);
      }
    }
    void loadApplicationDetails();
    return () => { alive = false; };
  }, [applications, isAdmin, schoolId, selectedId]);

  async function reviewApplication(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: reviewError } = await requireSupabase().rpc('move_admission_application_stage', {
        target_application: selected.id,
        target_stage: decisionStageId,
        stage_note: decisionNote.trim() || null,
      });
      if (reviewError) throw reviewError;
      setSuccess(`Application ${selected.application_reference} updated to ${statusLabels[decisionStatus]}.`);
      setRefreshKey((current) => current + 1);
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Could not update this application.');
    } finally {
      setSaving(false);
    }
  }

  async function createApplication(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId) return;
    const form = new FormData(event.currentTarget);
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: createError } = await requireSupabase().rpc('create_admission_application', {
        application_payload: {
          school_id: schoolId,
          student_first_name: form.get('student_first_name'),
          student_last_name: form.get('student_last_name'),
          date_of_birth: form.get('date_of_birth'),
          applying_for: form.get('applying_for'),
          guardian_name: form.get('guardian_name'),
          guardian_relationship: form.get('guardian_relationship'),
          guardian_email: form.get('guardian_email'),
          guardian_phone: form.get('guardian_phone'),
          previous_school: form.get('previous_school'),
          student_email: form.get('student_email'),
          student_phone: form.get('student_phone'),
          notes: form.get('notes'),
          assigned_to: form.get('assigned_to'),
        },
      });
      if (createError) throw createError;
      setShowCreateForm(false);
      setSuccess('Application created.');
      setRefreshKey((current) => current + 1);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not create the application.');
    } finally {
      setSaving(false);
    }
  }

  async function updateChecklist(item: DocumentChecklistItem, status: DocumentChecklistItem['status']) {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: updateError } = await requireSupabase().rpc('set_admission_document_checklist', {
        target_checklist: item.id,
        next_status: status,
        checklist_note: item.note,
      });
      if (updateError) throw updateError;
      setChecklist((current) => current.map((entry) => entry.id === item.id ? { ...entry, status } : entry));
      setSuccess(`${item.label} checklist updated.`);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Could not update the document checklist.');
    } finally {
      setSaving(false);
    }
  }

  async function assignApplication(value: string) {
    if (!selected) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: assignError } = await requireSupabase().rpc('assign_admission_application', {
        target_application: selected.id,
        target_assignee: value || null,
      });
      if (assignError) throw assignError;
      setAssignedTo(value);
      setSuccess('Application assignment updated.');
      setRefreshKey((current) => current + 1);
    } catch (assignError) {
      setError(assignError instanceof Error ? assignError.message : 'Could not assign this application.');
    } finally {
      setSaving(false);
    }
  }

  async function registerStudent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !placementClassId) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { data, error: registerError } = await requireSupabase().rpc('register_admission_student', {
        target_application: selected.id,
        target_class: placementClassId,
      });
      if (registerError) throw registerError;
      const registration = data?.[0] as { student_id: string; student_number: string } | undefined;
      if (!registration) throw new Error('Registration completed without returning the student record.');
      setSuccess(`${selected.student_first_name} ${selected.student_last_name} registered as ${registration.student_number} in ${classById.get(placementClassId) ?? 'the selected class'}.`);
      setRefreshKey((current) => current + 1);
    } catch (registerError) {
      setError(registerError instanceof Error ? registerError.message : 'Could not register this student.');
    } finally {
      setSaving(false);
    }
  }

  async function openDocument(document: ApplicationDocument) {
    setError('');
    try {
      const { data, error: linkError } = await requireSupabase().storage
        .from('admission-documents').createSignedUrl(document.storage_path, 60);
      if (linkError) throw linkError;
      window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : 'Could not open the applicant document.');
    }
  }

  if (!isAdmin) return <div className="page-stack"><div className="page-heading"><div><span className="eyebrow">School administration</span><h1>Admissions & enrolment</h1></div></div><ErrorState message="Your school role cannot review or register admissions." /></div>;

  return (
    <div className="page-stack admissions-page">
      <div className="page-heading">
        <div><span className="eyebrow">School administration</span><h1>Admissions &amp; enrolment</h1><p>Review applications, record decisions, and register accepted students into a class.</p></div>
        {section === 'applications' && <button className="button button-quiet" type="button" onClick={() => setRefreshKey((current) => current + 1)} disabled={loading}><RefreshCw size={15} />Refresh</button>}
      </div>
      {error && <ErrorState message={error} />}
      {success && <SuccessMessage message={success} />}
      <nav className="admissions-section-tabs" aria-label="Admissions workspace">
        <button type="button" className={section === 'applications' ? 'active' : ''} onClick={() => setSection('applications')}><GraduationCap size={15} />Applications</button>
        <button type="button" className={section === 'configuration' ? 'active' : ''} onClick={() => setSection('configuration')}><Settings2 size={15} />Application setup</button>
        <button type="button" className={section === 'enquiries' ? 'active' : ''} onClick={() => setSection('enquiries')}><Inbox size={15} />Enquiries</button>
        <button type="button" className={section === 'appointments' ? 'active' : ''} onClick={() => setSection('appointments')}><CalendarClock size={15} />Appointments</button>
      </nav>
      {section !== 'applications' ? <AdmissionsOperationsPanel
        schoolId={schoolId ?? ''}
        section={section}
        canConfigure={activeMembership?.role === 'school_admin'}
      /> : <>
      <section className="admissions-summary">
        {([
          ['Submitted', counters.submitted, 'submitted'],
          ['Under review', counters.under_review, 'under_review'],
          ['Accepted', counters.accepted, 'accepted'],
          ['Registered', counters.registered, 'registered'],
        ] as const).map(([label, value, key]) => <button type="button" className={`content-card admission-stat admission-stat-${key}`} key={key} onClick={() => { setFilterStatus(key); setPage(0); }}>
          <span>{label}</span><strong>{value.toLocaleString()}</strong><small>Open this queue</small>
        </button>)}
      </section>
      <div className="admissions-create-toolbar">
        <span>Create applications on behalf of families who contacted the school offline.</span>
        <button className="button button-primary" type="button" onClick={() => setShowCreateForm((current) => !current)}><Plus size={15} />{showCreateForm ? 'Cancel' : 'New application'}</button>
      </div>
      {showCreateForm && <form className="content-card admissions-create-form" onSubmit={(event) => void createApplication(event)}>
        <div className="section-heading"><div><span className="eyebrow">Staff entry</span><h2>Create application</h2></div></div>
        <div className="admissions-create-fields">
          <label className="field"><span>Student first name *</span><input name="student_first_name" required maxLength={80} /></label>
          <label className="field"><span>Student last name *</span><input name="student_last_name" required maxLength={80} /></label>
          <label className="field"><span>Date of birth</span><input name="date_of_birth" type="date" /></label>
          <label className="field"><span>Applying for *</span><input name="applying_for" required maxLength={100} /></label>
          <label className="field"><span>Guardian name *</span><input name="guardian_name" required minLength={2} maxLength={160} /></label>
          <label className="field"><span>Relationship *</span><input name="guardian_relationship" required maxLength={60} /></label>
          <label className="field"><span>Guardian email *</span><input name="guardian_email" required type="email" maxLength={254} /></label>
          <label className="field"><span>Guardian phone *</span><input name="guardian_phone" required minLength={5} maxLength={40} /></label>
          <label className="field"><span>Assign to staff</span><select name="assigned_to" defaultValue=""><option value="">Unassigned</option>{admissionsMembers.map((member) => <option key={member.profile_id} value={member.profile_id}>{member.profile?.full_name || member.profile?.email || member.profile_id}</option>)}</select></label>
          <label className="field"><span>Previous school</span><input name="previous_school" maxLength={160} /></label>
          <label className="field"><span>Student email</span><input name="student_email" type="email" maxLength={254} /></label>
          <label className="field"><span>Student phone</span><input name="student_phone" maxLength={40} /></label>
          <label className="field admissions-create-wide"><span>Notes</span><textarea name="notes" rows={3} maxLength={3000} /></label>
        </div>
        <button className="button button-primary" type="submit" disabled={saving}><Plus size={15} />{saving ? 'Creating…' : 'Create application'}</button>
      </form>}
      <div className="admissions-workspace">
        <section className="content-card admissions-inbox">
          <div className="section-heading"><div><span className="eyebrow">Live application queue</span><h2>Applications <small>{total.toLocaleString()}</small></h2></div><span className={`admissions-live admissions-live-${realtimeState}`}><i />{realtimeState === 'live' ? 'Live updates' : realtimeState === 'connecting' ? 'Connecting…' : 'Refresh mode'}</span></div>
          <div className="admissions-toolbar">
            <label className="admissions-search"><Search size={16} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} placeholder="Search name, guardian or reference" /></label>
            <select aria-label="Filter by application status" value={filterStatus} onChange={(event) => { setFilterStatus(event.target.value); setPage(0); }}>
              <option value="">All statuses</option>{statuses.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}
            </select>
          </div>
          {loading ? <LoadingState label="Loading the latest applications…" /> : applications.length === 0
            ? <EmptyState title="No applications found" detail={filterStatus || search ? 'Try changing the status filter or search terms.' : 'Applications submitted through the school website will appear here as they arrive.'} />
            : <div className="admissions-list">{applications.map((application) => <button type="button" key={application.id} onClick={() => setSelectedId(application.id)} className={`admissions-list-item${selectedId === application.id ? ' selected' : ''}`}>
              <span className="admissions-list-top"><strong>{application.student_first_name} {application.student_last_name}</strong><span className={`admission-status status-${application.status}`}>{statusLabels[application.status]}</span></span>
              <span className="admissions-list-ref">{application.application_reference} · {application.applying_for}</span>
              <span className="admissions-list-date">{displayTimestamp(application.submitted_at)} · {application.source === 'public_website' ? 'Website' : 'School entered'}</span>
            </button>)}</div>}
          <div className="admissions-pagination"><span>{total ? `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, total)} of ${total}` : '0 applications'}</span><div>
            <button className="button button-quiet" type="button" onClick={() => setPage((current) => Math.max(0, current - 1))} disabled={page === 0 || loading}><ChevronLeft size={15} />Previous</button>
            <button className="button button-quiet" type="button" onClick={() => setPage((current) => current + 1)} disabled={(page + 1) * pageSize >= total || loading}>Next<ChevronRight size={15} /></button>
          </div></div>
        </section>

        <section className="content-card admissions-detail">
          {!selected ? <EmptyState title="Select an application" detail="Choose a record from the live application queue to review its details." /> : <>
            <header className="admissions-detail-heading">
              <div><span className="eyebrow">Application {selected.application_reference}</span><h2>{selected.student_first_name} {selected.student_last_name}</h2><p>Submitted {displayTimestamp(selected.submitted_at)} · Requested: {selected.applying_for}{selected.academic_year ? ` · ${selected.academic_year}` : ''}</p></div>
              <span className={`admission-status status-${selected.status}`}>{statusLabels[selected.status]}</span>
            </header>
            {detailLoading ? <LoadingState label="Loading applicant details…" /> : <>
              <div className="admissions-detail-grid">
                <section><h3><GraduationCap size={16} />Student information</h3><dl>
                  <dt>Date of birth</dt><dd>{displayDate(selected.date_of_birth)}</dd>
                  <dt>Gender</dt><dd>{selected.gender || '—'}</dd>
                  <dt>Previous school</dt><dd>{selected.previous_school || '—'}</dd>
                  <dt>Student email</dt><dd>{selected.student_email || '—'}</dd>
                  <dt>Student phone</dt><dd>{selected.student_phone || '—'}</dd>
                  <dt>Address</dt><dd>{selected.address || '—'}</dd>
                </dl></section>
                <section><h3><UserRoundCheck size={16} />Parent / guardian</h3><dl>
                  <dt>Name</dt><dd>{selected.guardian_name}</dd>
                  <dt>Relationship</dt><dd>{selected.guardian_relationship}</dd>
                  <dt>Email</dt><dd><a href={`mailto:${selected.guardian_email}`}>{selected.guardian_email}</a></dd>
                  <dt>Phone</dt><dd><a href={`tel:${selected.guardian_phone}`}>{selected.guardian_phone}</a></dd>
                </dl></section>
              </div>
              {!!selected.custom_fields && Object.keys(selected.custom_fields).length > 0 && <section className="admissions-notes"><h3>Additional application details</h3><dl className="admissions-custom-fields">{Object.entries(selected.custom_fields).map(([key, value]) => <div key={key}><dt>{key.replace(/_/g, ' ')}</dt><dd>{value || '—'}</dd></div>)}</dl></section>}
              <label className="field"><span>Assigned admissions staff</span><select value={assignedTo} disabled={saving} onChange={(event) => void assignApplication(event.target.value)}>
                <option value="">Unassigned</option>{admissionsMembers.map((member) => <option key={member.profile_id} value={member.profile_id}>{member.profile?.full_name || member.profile?.email || member.profile_id} · {member.role.replace(/_/g, ' ')}</option>)}
              </select></label>
              {selected.notes && <section className="admissions-notes"><h3>Applicant notes</h3><p>{selected.notes}</p></section>}
              <section className="admissions-documents"><h3>Supporting documents <span>{documents.length}</span></h3>
                {documents.length ? <div className="admissions-document-list">{documents.map((document) => <button type="button" key={document.id} onClick={() => void openDocument(document)}><span><strong>{document.file_name}</strong><small>{Math.ceil(document.file_size / 1024)} KB · {displayTimestamp(document.uploaded_at)}</small></span><ExternalLink size={15} /></button>)}</div> : <p className="admissions-muted">No documents were attached to this application.</p>}
              </section>
              <section className="admissions-checklist"><h3><FileCheck2 size={15} />Required document checklist</h3>
                {checklist.length ? checklist.map((item) => <div className="admissions-checklist-row" key={item.id}>
                  <span><strong>{item.label}</strong>{item.note && <small>{item.note}</small>}</span>
                  <select value={item.status} disabled={saving} aria-label={`${item.label} status`} onChange={(event) => void updateChecklist(item, event.target.value as DocumentChecklistItem['status'])}>
                    <option value="pending">Pending</option><option value="received">Received</option><option value="waived">Waived</option>
                  </select>
                </div>) : <p className="admissions-muted">No required documents are configured. Add document requirements under Application setup.</p>}
              </section>

              {selected.status !== 'registered' && <form className="admissions-decision" onSubmit={(event) => void reviewApplication(event)}>
                <h3>Review &amp; decision</h3>
                <div className="admissions-decision-fields">
                  <label className="field"><span>Application stage</span><select value={decisionStageId} required onChange={(event) => {
                    setDecisionStageId(event.target.value);
                    const selectedStage = workflowStages.find((stage) => stage.id === event.target.value);
                    if (selectedStage) setDecisionStatus(selectedStage.status);
                  }}>
                    {workflowStages.filter((stage) => stage.status !== 'registered').map((stage) => <option key={stage.id} value={stage.id}>{stage.label}</option>)}
                  </select></label>
                  <label className="field"><span>Decision / follow-up notes</span><textarea rows={3} maxLength={3000} value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} placeholder="Record decision reasons or next steps" /></label>
                </div>
                <button className="button button-primary" type="submit" disabled={saving}><Check size={15} />{saving ? 'Saving…' : 'Save review'}</button>
              </form>}

              {selected.status === 'accepted' && <form className="admissions-registration" onSubmit={(event) => void registerStudent(event)}>
                <h3>Register student &amp; place in class</h3>
                <p>This creates the student record, generates a school student number, and enrolls the student into the selected class.</p>
                <label className="field"><span>Class placement</span><select value={placementClassId} onChange={(event) => setPlacementClassId(event.target.value)} required>
                  <option value="">Select a class</option>{classes.map((schoolClass) => <option key={schoolClass.id} value={schoolClass.id}>{schoolClass.name}{schoolClass.grade_level ? ` · ${schoolClass.grade_level}` : ''}</option>)}
                </select></label>
                <button className="button button-primary" type="submit" disabled={saving || classes.length === 0}><GraduationCap size={15} />{saving ? 'Registering…' : 'Complete registration'}</button>
                {classes.length === 0 && <p className="admissions-muted">Create a school class before registering this student.</p>}
              </form>}

              {selected.status === 'registered' && <div className="admissions-registered"><Check size={17} /><div><strong>Student registered</strong><span>Placed in {classById.get(selected.registered_class_id ?? '') ?? 'the assigned class'}.</span></div></div>}

              <section className="admissions-history"><h3>Application history</h3>
                {history.length ? <ol>{history.map((event) => <li key={event.id}>
                  <span className="admissions-history-dot" />
                  <div><strong>{event.action.replace(/_/g, ' ')}</strong><small>{displayTimestamp(event.created_at)} · {event.actor_name || (event.actor_id ? 'School administrator' : 'Applicant')}</small>
                    {event.from_status !== event.to_status && event.to_status && <span>{event.from_status ? `${statusLabels[event.from_status]} → ` : ''}{statusLabels[event.to_status]}</span>}
                    {event.note && <p>{event.note}</p>}
                  </div>
                </li>)}</ol> : <p className="admissions-muted">No review activity has been recorded.</p>}
              </section>
            </>}
          </>}
        </section>
      </div>
      </>}
    </div>
  );
}
