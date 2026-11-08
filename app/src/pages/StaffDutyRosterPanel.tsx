import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { CalendarClock, Check, ClipboardList, Save, Shield, Trash2 } from 'lucide-react';
import { ErrorState, EmptyState, LoadingState } from '../components/Feedback';
import { useAuth } from '../contexts/AuthContext';
import { requireSupabase } from '../lib/supabase';

type DutyType = 'arrival_gate' | 'playground' | 'lunch' | 'corridor' | 'dismissal' | 'event' | 'other';
type DutyStatus = 'planned' | 'covered' | 'complete' | 'cancelled';
type StaffChoice = { id: string; first_name: string; last_name: string; employee_number: string; job_title: string };
type DutyAssignment = {
  id: string;
  duty_date: string;
  starts_at: string;
  ends_at: string;
  duty_type: DutyType;
  location: string;
  primary_staff_id: string;
  cover_staff_id: string | null;
  status: DutyStatus;
  notes: string;
};
type DutyDraft = Omit<DutyAssignment, 'id'>;

const dutyTypes: { value: DutyType; label: string }[] = [
  { value: 'arrival_gate', label: 'Arrival gate' },
  { value: 'playground', label: 'Playground' },
  { value: 'lunch', label: 'Lunch supervision' },
  { value: 'corridor', label: 'Corridor' },
  { value: 'dismissal', label: 'Dismissal' },
  { value: 'event', label: 'School event' },
  { value: 'other', label: 'Other' },
];
const dutyStatuses: { value: DutyStatus; label: string }[] = [
  { value: 'planned', label: 'Planned' },
  { value: 'covered', label: 'Covered' },
  { value: 'complete', label: 'Complete' },
  { value: 'cancelled', label: 'Cancelled' },
];

function localDate() {
  const date = new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function emptyDraft(date: string): DutyDraft {
  return {
    duty_date: date,
    starts_at: '07:30',
    ends_at: '08:15',
    duty_type: 'arrival_gate',
    location: '',
    primary_staff_id: '',
    cover_staff_id: null,
    status: 'planned',
    notes: '',
  };
}

function staffName(staff: StaffChoice | undefined) {
  return staff ? `${staff.first_name} ${staff.last_name}` : 'Staff member unavailable';
}

export function StaffDutyRosterPanel({ schoolId }: { schoolId: string }) {
  const { user } = useAuth();
  const [staff, setStaff] = useState<StaffChoice[]>([]);
  const [duties, setDuties] = useState<DutyAssignment[]>([]);
  const [date, setDate] = useState(localDate);
  const [draft, setDraft] = useState<DutyDraft>(() => emptyDraft(localDate()));
  const [editingId, setEditingId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const staffById = useMemo(() => new Map(staff.map((person) => [person.id, person])), [staff]);

  const load = useCallback(async () => {
    if (!schoolId) return;
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [staffResult, dutyResult] = await Promise.all([
        client.from('staff_profiles').select('id,first_name,last_name,employee_number,job_title')
          .eq('school_id', schoolId).eq('employment_status', 'active').order('last_name').order('first_name'),
        client.from('staff_duty_assignments').select('id,duty_date,starts_at,ends_at,duty_type,location,primary_staff_id,cover_staff_id,status,notes')
          .eq('school_id', schoolId).eq('duty_date', date).order('starts_at').order('location'),
      ]);
      if (staffResult.error) throw staffResult.error;
      if (dutyResult.error) throw dutyResult.error;
      setStaff((staffResult.data ?? []) as StaffChoice[]);
      setDuties((dutyResult.data ?? []) as DutyAssignment[]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load the staff duty roster.');
    } finally {
      setLoading(false);
    }
  }, [schoolId, date]);

  useEffect(() => { void load(); }, [load]);

  function startEdit(duty: DutyAssignment) {
    setEditingId(duty.id);
    setDraft({ ...duty, starts_at: duty.starts_at.slice(0, 5), ends_at: duty.ends_at.slice(0, 5) });
    setError('');
  }

  function cancelEdit() {
    setEditingId('');
    setDraft(emptyDraft(date));
  }

  async function saveDuty(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !user) {
      setError('Sign in with a school staff account before editing duty assignments.');
      return;
    }
    if (draft.starts_at >= draft.ends_at) {
      setError('The duty end time must be later than its start time.');
      return;
    }
    if (draft.status === 'covered' && !draft.cover_staff_id) {
      setError('Choose a covering staff member before marking a duty covered.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const values = {
        ...draft,
        starts_at: `${draft.starts_at}:00`,
        ends_at: `${draft.ends_at}:00`,
        cover_staff_id: draft.cover_staff_id || null,
        location: draft.location.trim(),
        notes: draft.notes.trim(),
        updated_by: user.id,
      };
      const query = requireSupabase().from('staff_duty_assignments');
      const result = editingId
        ? await query.update(values).eq('school_id', schoolId).eq('id', editingId)
        : await query.insert({ ...values, school_id: schoolId, created_by: user.id });
      if (result.error) throw result.error;
      cancelEdit();
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save this duty assignment.');
    } finally {
      setSaving(false);
    }
  }

  async function updateDutyStatus(duty: DutyAssignment, status: DutyStatus) {
    if (!schoolId || !user) return;
    if (status === 'covered' && !duty.cover_staff_id) {
      startEdit(duty);
      setError('Assign a covering staff member before marking a duty covered.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const { error: updateError } = await requireSupabase().from('staff_duty_assignments')
        .update({ status, updated_by: user.id })
        .eq('school_id', schoolId).eq('id', duty.id);
      if (updateError) throw updateError;
      await load();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Could not update this duty assignment.');
    } finally {
      setSaving(false);
    }
  }

  return <div className="page-stack duty-roster-workspace">
    <section className="content-card duty-roster-intro">
      <div><span className="eyebrow"><Shield size={14} /> Supervision and cover</span><h2>Duty roster</h2>
        <p>Assign active staff to arrival, break, lunch, corridor, and dismissal duties. Staff overlaps are checked before assignments are saved.</p></div>
      <label className="duty-date-filter"><span>Roster date</span><input type="date" value={date} onChange={(event) => {
        const nextDate = event.target.value;
        setDate(nextDate);
        if (!editingId) setDraft(emptyDraft(nextDate));
      }} /></label>
    </section>

    {error && <ErrorState message={error} />}

    <form className="content-card duty-roster-form" onSubmit={(event) => void saveDuty(event)}>
      <div className="section-heading"><div><span className="eyebrow">{editingId ? 'Update assignment' : 'Add supervision'}</span><h2>{editingId ? 'Edit duty' : 'Schedule a duty'}</h2></div><CalendarClock size={18} className="muted-icon" /></div>
      {!staff.length && !loading && <p className="duty-roster-notice">Add active staff profiles before creating duty assignments.</p>}
      <div className="duty-roster-fields">
        <label>Duty date<input type="date" required value={draft.duty_date} onChange={(event) => setDraft((current) => ({ ...current, duty_date: event.target.value }))} /></label>
        <label>Duty type<select value={draft.duty_type} onChange={(event) => setDraft((current) => ({ ...current, duty_type: event.target.value as DutyType }))}>{dutyTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
        <label>Location<input required maxLength={120} value={draft.location} onChange={(event) => setDraft((current) => ({ ...current, location: event.target.value }))} placeholder="e.g. North gate" /></label>
        <label>Starts<input required type="time" value={draft.starts_at} onChange={(event) => setDraft((current) => ({ ...current, starts_at: event.target.value }))} /></label>
        <label>Ends<input required type="time" value={draft.ends_at} onChange={(event) => setDraft((current) => ({ ...current, ends_at: event.target.value }))} /></label>
        <label>Assigned staff<select required value={draft.primary_staff_id} onChange={(event) => setDraft((current) => ({ ...current, primary_staff_id: event.target.value }))}><option value="">Choose staff</option>{staff.map((person) => <option key={person.id} value={person.id}>{staffName(person)} · {person.job_title}</option>)}</select></label>
        <label>Covering staff<select value={draft.cover_staff_id ?? ''} onChange={(event) => setDraft((current) => ({ ...current, cover_staff_id: event.target.value || null, status: event.target.value ? 'covered' : current.status === 'covered' ? 'planned' : current.status }))}><option value="">No cover assigned</option>{staff.filter((person) => person.id !== draft.primary_staff_id).map((person) => <option key={person.id} value={person.id}>{staffName(person)} · {person.job_title}</option>)}</select></label>
        <label>Status<select value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as DutyStatus }))}>{dutyStatuses.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}</select></label>
        <label className="duty-notes-field">Notes<input maxLength={500} value={draft.notes} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} placeholder="Optional handover or supervision details" /></label>
      </div>
      <div className="duty-roster-actions">
        {editingId && <button className="button button-quiet" type="button" onClick={cancelEdit} disabled={saving}>Cancel edit</button>}
        <button className="button button-primary" type="submit" disabled={saving || loading || !staff.length}><Save size={14} />{saving ? 'Saving…' : editingId ? 'Save duty' : 'Add duty'}</button>
      </div>
    </form>

    <section className="content-card duty-roster-list">
      <div className="section-heading"><div><span className="eyebrow">Daily coverage</span><h2>Assignments for {date}</h2></div><span className="table-count">{duties.length} duties</span></div>
      {loading ? <LoadingState label="Loading the duty roster…" /> : duties.length ? <div className="table-scroll">
        <table><thead><tr><th>Time / location</th><th>Duty</th><th>Assigned staff</th><th>Cover</th><th>Status</th><th>Notes</th><th>Actions</th></tr></thead>
          <tbody>{duties.map((duty) => <tr key={duty.id}>
            <td><strong>{duty.starts_at.slice(0, 5)}–{duty.ends_at.slice(0, 5)}</strong><small>{duty.location}</small></td>
            <td>{dutyTypes.find((type) => type.value === duty.duty_type)?.label ?? duty.duty_type}</td>
            <td>{staffName(staffById.get(duty.primary_staff_id))}</td>
            <td>{duty.cover_staff_id ? staffName(staffById.get(duty.cover_staff_id)) : '—'}</td>
            <td><span className={`duty-status-chip duty-status-${duty.status}`}>{dutyStatuses.find((status) => status.value === duty.status)?.label ?? duty.status}</span></td>
            <td>{duty.notes || '—'}</td>
            <td><div className="duty-row-actions">
              <button type="button" className="button button-quiet" onClick={() => startEdit(duty)} disabled={saving}><ClipboardList size={13} />Edit</button>
              {duty.status !== 'complete' && duty.status !== 'cancelled' && <button type="button" className="button button-quiet" onClick={() => void updateDutyStatus(duty, 'complete')} disabled={saving}><Check size={13} />Complete</button>}
              {duty.status !== 'cancelled' && <button type="button" className="button button-quiet duty-cancel-action" onClick={() => void updateDutyStatus(duty, 'cancelled')} disabled={saving}><Trash2 size={13} />Cancel</button>}
            </div></td>
          </tr>)}</tbody>
        </table>
      </div> : <EmptyState title="No duties scheduled" detail="Add arrival, playground, lunch, corridor, or dismissal assignments for this date." />}
    </section>
  </div>;
}
