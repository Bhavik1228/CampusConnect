import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ClipboardCheck, Plus, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';
import type { AppRole } from '../types/database';

type WorkDomain = 'transport' | 'facilities' | 'it_support' | 'safeguarding' | 'procurement' | 'compliance';
type WorkStatus = 'open' | 'assigned' | 'in_progress' | 'pending_approval' | 'approved' | 'rejected' | 'resolved' | 'closed';
type WorkPriority = 'low' | 'normal' | 'high' | 'urgent';
type WorkType =
  | 'vehicle' | 'route' | 'student_assignment' | 'incident'
  | 'asset' | 'maintenance_request'
  | 'support_ticket' | 'equipment'
  | 'concern' | 'referral'
  | 'supplier' | 'requisition' | 'purchase_order'
  | 'check' | 'evidence' | 'corrective_action';

interface WorkItem {
  id: string;
  domain: WorkDomain;
  record_type: WorkType;
  title: string;
  description: string;
  status: WorkStatus;
  priority: WorkPriority;
  details: Record<string, unknown>;
  assigned_to: string | null;
  due_date: string | null;
  updated_at: string;
}

interface WorkEvent {
  id: number;
  actor_id: string | null;
  action: 'created' | 'updated';
  from_status: WorkStatus | null;
  to_status: WorkStatus;
  note: string;
  created_at: string;
}

interface Member {
  profile_id: string;
  role: AppRole;
  profile: { full_name: string | null; email: string | null } | null;
}

const domainDetails: Record<WorkDomain, { title: string; role: AppRole | null; types: { value: WorkType; label: string }[] }> = {
  transport: {
    title: 'Transport',
    role: 'transport_manager',
    types: [
      { value: 'vehicle', label: 'Vehicle' },
      { value: 'route', label: 'Route' },
      { value: 'student_assignment', label: 'Student assignment' },
      { value: 'incident', label: 'Incident' },
    ],
  },
  facilities: {
    title: 'Facilities',
    role: 'facilities_manager',
    types: [
      { value: 'asset', label: 'Facility asset' },
      { value: 'maintenance_request', label: 'Maintenance request' },
    ],
  },
  it_support: {
    title: 'IT support',
    role: 'it_support_technician',
    types: [
      { value: 'support_ticket', label: 'Support ticket' },
      { value: 'equipment', label: 'IT equipment' },
    ],
  },
  safeguarding: {
    title: 'Safeguarding',
    role: 'safeguarding_officer',
    types: [
      { value: 'concern', label: 'Safeguarding concern' },
      { value: 'referral', label: 'Referral' },
    ],
  },
  procurement: {
    title: 'Procurement',
    role: 'procurement_officer',
    types: [
      { value: 'supplier', label: 'Supplier' },
      { value: 'requisition', label: 'Requisition' },
      { value: 'purchase_order', label: 'Purchase order' },
    ],
  },
  compliance: {
    title: 'Compliance',
    role: 'compliance_audit_officer',
    types: [
      { value: 'check', label: 'Compliance check' },
      { value: 'evidence', label: 'Evidence record' },
      { value: 'corrective_action', label: 'Corrective action' },
    ],
  },
};

const roleDomains: Partial<Record<AppRole, WorkDomain>> = {
  transport_manager: 'transport',
  facilities_manager: 'facilities',
  it_support_technician: 'it_support',
  safeguarding_officer: 'safeguarding',
  procurement_officer: 'procurement',
  compliance_audit_officer: 'compliance',
};

const statusLabels: Record<WorkStatus, string> = {
  open: 'Open',
  assigned: 'Assigned',
  in_progress: 'In progress',
  pending_approval: 'Pending approval',
  approved: 'Approved',
  rejected: 'Rejected',
  resolved: 'Resolved',
  closed: 'Closed',
};

const statuses: WorkStatus[] = ['open', 'assigned', 'in_progress', 'pending_approval', 'approved', 'rejected', 'resolved', 'closed'];
const priorities: WorkPriority[] = ['low', 'normal', 'high', 'urgent'];

export function AdministrativeWorkflowsPage() {
  const { activeMembership, user } = useAuth();
  const schoolId = activeMembership?.school_id;
  const role = activeMembership?.role;
  const isAdmin = role === 'school_admin';
  const allowedDomains = useMemo(
    () => isAdmin ? Object.keys(domainDetails) as WorkDomain[] : role && roleDomains[role] ? [roleDomains[role] as WorkDomain] : [],
    [isAdmin, role],
  );
  const [domain, setDomain] = useState<WorkDomain>(allowedDomains[0] ?? 'transport');
  const [items, setItems] = useState<WorkItem[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [events, setEvents] = useState<WorkEvent[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [recordType, setRecordType] = useState<WorkType>(domainDetails[domain].types[0].value);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [reference, setReference] = useState('');
  const [location, setLocation] = useState('');
  const [amount, setAmount] = useState('');
  const [priority, setPriority] = useState<WorkPriority>('normal');
  const [status, setStatus] = useState<WorkStatus>('open');
  const [assignee, setAssignee] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [note, setNote] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const selected = items.find((item) => item.id === selectedId) ?? null;
  const availableStatuses = !isAdmin && domain === 'procurement'
    ? statuses.filter((value) => value !== 'approved' && value !== 'rejected')
    : statuses;
  const selectedStatuses = selected && !availableStatuses.includes(status)
    ? [...availableStatuses, status]
    : availableStatuses;
  const load = useCallback(async () => {
    if (!schoolId || !allowedDomains.includes(domain)) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [itemResult, memberResult] = await Promise.all([
        client.from('school_administrative_work_items')
          .select('id,domain,record_type,title,description,status,priority,details,assigned_to,due_date,updated_at')
          .eq('school_id', schoolId).eq('domain', domain).order('updated_at', { ascending: false }),
        client.from('school_memberships')
          .select('profile_id,role,profile:profiles(full_name,email)')
          .eq('school_id', schoolId).order('created_at'),
      ]);
      if (itemResult.error) throw itemResult.error;
      if (memberResult.error) throw memberResult.error;
      const rows = (itemResult.data ?? []) as unknown as WorkItem[];
      setItems(rows);
      setMembers((memberResult.data ?? []) as unknown as Member[]);
      setSelectedId((current) => current && rows.some((item) => item.id === current) ? current : rows[0]?.id ?? '');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load administrative work items.');
    } finally {
      setLoading(false);
    }
  }, [allowedDomains, domain, schoolId]);

  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => {
    setRecordType(domainDetails[domain].types[0].value);
    setSelectedId('');
    setEvents([]);
  }, [domain]);
  useEffect(() => {
    if (selected) setStatus(selected.status);
  }, [selected?.id, selected?.status]);
  useEffect(() => {
    if (!schoolId || !selectedId || !allowedDomains.includes(domain)) {
      setEvents([]);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const { data, error: eventError } = await requireSupabase()
          .from('school_administrative_work_item_events')
          .select('id,actor_id,action,from_status,to_status,note,created_at')
          .eq('school_id', schoolId).eq('domain', domain).eq('work_item_id', selectedId)
          .order('created_at', { ascending: false });
        if (eventError) throw eventError;
        if (alive) setEvents((data ?? []) as WorkEvent[]);
      } catch (loadError) {
        if (alive) setError(loadError instanceof Error ? loadError.message : 'Could not load work-item history.');
      }
    })();
    return () => { alive = false; };
  }, [allowedDomains, domain, schoolId, selectedId, refreshKey]);

  function resetForm() {
    setTitle('');
    setDescription('');
    setReference('');
    setLocation('');
    setAmount('');
    setPriority('normal');
    setStatus('open');
    setAssignee(user?.id ?? '');
    setDueDate('');
    setNote('');
  }

  function startCreate() {
    resetForm();
    setShowForm(true);
    setError('');
    setSuccess('');
  }

  async function saveItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !user || !allowedDomains.includes(domain)) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const details = {
        reference: reference.trim(),
        location: location.trim(),
        amount: amount.trim() ? Number(amount) : null,
        latest_note: note.trim(),
      };
      if (amount.trim() && (!Number.isFinite(Number(amount)) || Number(amount) < 0)) {
        throw new Error('Enter a valid non-negative amount.');
      }
      const { error: insertError } = await requireSupabase().from('school_administrative_work_items').insert({
        school_id: schoolId,
        domain,
        record_type: recordType,
        title: title.trim(),
        description: description.trim(),
        status,
        priority,
        details,
        assigned_to: assignee || null,
        due_date: dueDate || null,
        created_by: user.id,
        updated_by: user.id,
      });
      if (insertError) throw insertError;
      setShowForm(false);
      setSuccess('Administrative work item created.');
      setRefreshKey((key) => key + 1);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not create this work item.');
    } finally {
      setSaving(false);
    }
  }

  async function updateStatus(nextStatus: WorkStatus) {
    if (!schoolId || !user || !selected) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const details = { ...selected.details, latest_note: note.trim() };
      const { error: updateError } = await requireSupabase().from('school_administrative_work_items')
        .update({
          title: selected.title.trim(),
          description: selected.description.trim(),
          priority: selected.priority,
          status: nextStatus,
          details,
          assigned_to: selected.assigned_to,
          due_date: selected.due_date,
          updated_by: user.id,
          updated_at: new Date().toISOString(),
        })
        .eq('school_id', schoolId).eq('id', selected.id);
      if (updateError) throw updateError;
      setSuccess(`Work item status changed to ${statusLabels[nextStatus]}.`);
      setNote('');
      setRefreshKey((key) => key + 1);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Could not update this work item.');
    } finally {
      setSaving(false);
    }
  }

  if (!allowedDomains.length) {
    return <div className="page-stack"><ErrorState message="Your school role cannot access administrative workflows." /></div>;
  }

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div><span className="eyebrow">School administration</span><h1>{isAdmin ? 'Administrative workflows' : domainDetails[domain].title}</h1><p>Track operational records, assignments, approvals, due dates, and an auditable status history.</p></div>
        <button className="button button-primary" type="button" onClick={startCreate}><Plus size={15} />New record</button>
      </div>
      {error && <ErrorState message={error} />}
      {success && <SuccessMessage message={success} />}
      {isAdmin && <section className="content-card">
        <label className="field"><span>Administrative area</span><select value={domain} onChange={(event) => setDomain(event.target.value as WorkDomain)}>{allowedDomains.map((item) => <option key={item} value={item}>{domainDetails[item].title}</option>)}</select></label>
      </section>}
      {showForm && <section className="content-card staff-profile-card">
        <div className="section-heading"><div><span className="eyebrow">{domainDetails[domain].title}</span><h2>Create a work item</h2></div><button className="button button-quiet" type="button" onClick={() => setShowForm(false)}>Cancel</button></div>
        <form className="accounting-form" onSubmit={(event) => void saveItem(event)}>
          <label className="field"><span>Record type</span><select value={recordType} onChange={(event) => setRecordType(event.target.value as WorkType)}>{domainDetails[domain].types.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
          <label className="field"><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} minLength={2} maxLength={160} required /></label>
          <label className="field"><span>Reference / tag / student ID</span><input value={reference} onChange={(event) => setReference(event.target.value)} maxLength={120} /></label>
          <label className="field"><span>Location</span><input value={location} onChange={(event) => setLocation(event.target.value)} maxLength={200} /></label>
          {domain === 'procurement' && <label className="field"><span>Estimated / approved amount</span><input type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>}
          <label className="field"><span>Priority</span><select value={priority} onChange={(event) => setPriority(event.target.value as WorkPriority)}>{priorities.map((value) => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></label>
          <label className="field"><span>Assign to</span><select value={assignee} onChange={(event) => setAssignee(event.target.value)}><option value="">Unassigned</option>{members.map((member) => <option key={member.profile_id} value={member.profile_id}>{member.profile?.full_name || member.profile?.email || member.profile_id} · {member.role.replace(/_/g, ' ')}</option>)}</select></label>
          <label className="field"><span>Due date</span><input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label>
          <label className="field"><span>Initial status</span><select value={status} onChange={(event) => setStatus(event.target.value as WorkStatus)}>{availableStatuses.map((value) => <option key={value} value={value}>{statusLabels[value]}</option>)}</select></label>
          <label className="field accounting-field-wide"><span>Description / notes</span><textarea rows={4} maxLength={5000} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <button className="button button-primary accounting-field-wide" type="submit" disabled={saving}><Save size={15} />{saving ? 'Saving…' : 'Create record'}</button>
        </form>
      </section>}
      <div className="accounting-staff-grid">
        <section className="content-card">
          <div className="section-heading"><div><span className="eyebrow">Records</span><h2>{domainDetails[domain].title}</h2></div><button className="button button-quiet" type="button" onClick={() => setRefreshKey((key) => key + 1)} disabled={loading}><RefreshCw size={14} />Refresh</button></div>
          {loading ? <LoadingState label="Loading workflow records…" /> : items.length ? <div className="staff-directory-list">
            {items.map((item) => <button className={`staff-directory-item${selectedId === item.id ? ' selected' : ''}`} key={item.id} onClick={() => { setSelectedId(item.id); setNote(''); }}>
              <span className="staff-avatar"><ClipboardCheck size={17} /></span>
              <span className="staff-directory-copy"><strong>{item.title}</strong><small>{domainDetails[domain].types.find((type) => type.value === item.record_type)?.label} · {item.priority} priority</small><small>{statusLabels[item.status]}{item.due_date ? ` · due ${item.due_date}` : ''}</small></span>
            </button>)}
          </div> : <EmptyState title="No records yet" detail="Create a record to start tracking this workflow." />}
        </section>
        <section className="content-card">
          {!selected ? <EmptyState title="Select a record" detail="Choose a workflow record to review its details and update its status." /> : <>
            <div className="section-heading"><div><span className="eyebrow">{domainDetails[domain].types.find((type) => type.value === selected.record_type)?.label}</span><h2>{selected.title}</h2></div></div>
            <label className="field"><span>Title</span><input value={selected.title} maxLength={160} onChange={(event) => setItems((current) => current.map((item) => item.id === selected.id ? { ...item, title: event.target.value } : item))} /></label>
            <label className="field"><span>Description / notes</span><textarea rows={4} maxLength={5000} value={selected.description} onChange={(event) => setItems((current) => current.map((item) => item.id === selected.id ? { ...item, description: event.target.value } : item))} /></label>
            <dl className="staff-profile-facts">
              <div><span>Status</span><strong>{statusLabels[selected.status]}</strong></div>
              <div><span>Priority</span><select value={selected.priority} onChange={(event) => setItems((current) => current.map((item) => item.id === selected.id ? { ...item, priority: event.target.value as WorkPriority } : item))}>{priorities.map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
              <div><span>Reference</span><strong>{String(selected.details.reference ?? '—')}</strong></div>
              <div><span>Location</span><strong>{String(selected.details.location ?? '—')}</strong></div>
              {domain === 'procurement' && <div><span>Amount</span><strong>{selected.details.amount == null ? '—' : String(selected.details.amount)}</strong></div>}
              <div><span>Assigned to</span><select value={selected.assigned_to ?? ''} onChange={(event) => setItems((current) => current.map((item) => item.id === selected.id ? { ...item, assigned_to: event.target.value || null } : item))}><option value="">Unassigned</option>{members.map((member) => <option key={member.profile_id} value={member.profile_id}>{member.profile?.full_name || member.profile?.email || member.profile_id} · {member.role.replace(/_/g, ' ')}</option>)}</select></div>
              <div><span>Due date</span><input type="date" value={selected.due_date ?? ''} onChange={(event) => setItems((current) => current.map((item) => item.id === selected.id ? { ...item, due_date: event.target.value || null } : item))} /></div>
            </dl>
            <label className="field"><span>Update status</span><select value={status} onChange={(event) => setStatus(event.target.value as WorkStatus)}>{selectedStatuses.map((value) => <option key={value} value={value} disabled={!isAdmin && domain === 'procurement' && (value === 'approved' || value === 'rejected')}>{statusLabels[value]}</option>)}</select></label>
            <label className="field"><span>Update note</span><textarea rows={2} maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add a brief note to the record history" /></label>
            <div className="staff-form-actions">
              <button className="button button-primary" type="button" onClick={() => void updateStatus(status)} disabled={saving}><Save size={14} />Save update</button>
              {domain === 'procurement' && selected.status === 'pending_approval' && !isAdmin && <span className="settings-readonly">A school administrator must approve or reject this purchase.</span>}
            </div>
            <div className="section-heading"><div><span className="eyebrow">Audit trail</span><h3><ShieldCheck size={16} />Record history</h3></div></div>
            {events.length ? <div className="settings-audit-list">{events.map((event) => <p key={event.id}><strong>{event.action === 'created' ? 'Created' : `${statusLabels[event.from_status ?? 'open']} → ${statusLabels[event.to_status]}`}</strong><span>{event.note || 'No note'} · {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(event.created_at))}</span></p>)}</div> : <p className="settings-readonly">No history recorded.</p>}
          </>}
        </section>
      </div>
    </div>
  );
}
