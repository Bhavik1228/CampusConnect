import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Building2, Plus, Pencil, Search, Send, Trash2, Truck, Wallet } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type RecordType = 'supplier' | 'requisition' | 'purchase_order';
type WorkItemStatus = 'open' | 'assigned' | 'in_progress' | 'pending_approval' | 'approved' | 'rejected' | 'resolved' | 'closed';
type Priority = 'low' | 'normal' | 'high' | 'urgent';

type WorkItem = {
  id: string;
  school_id: string;
  domain: string;
  record_type: RecordType;
  title: string;
  description: string;
  status: WorkItemStatus;
  priority: Priority;
  details: Record<string, unknown>;
  assigned_to: string | null;
  due_date: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  profiles: { full_name: string | null; email: string | null } | null;
};

const recordTypeLabels: Record<RecordType, string> = { supplier: 'Supplier', requisition: 'Requisition', purchase_order: 'Purchase order' };
const recordTypeIcons: Record<RecordType, React.ElementType> = { supplier: Building2, requisition: Wallet, purchase_order: Truck };
const statusLabels: Record<WorkItemStatus, string> = {
  open: 'Open', assigned: 'Assigned', in_progress: 'In progress', pending_approval: 'Pending approval',
  approved: 'Approved', rejected: 'Rejected', resolved: 'Resolved', closed: 'Closed',
};

export function ProcurementPage() {
  const { activeMembership, user } = useAuth();
  const schoolId = activeMembership?.school_id;
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<WorkItem | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [recordTypeFilter, setRecordTypeFilter] = useState<RecordType | ''>('');

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [recordType, setRecordType] = useState<RecordType>('supplier');
  const [status, setStatus] = useState<WorkItemStatus>('open');
  const [priority, setPriority] = useState<Priority>('normal');
  const [assignedTo, setAssignedTo] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState<string | null>(null);

  const loadWorkItems = useCallback(async () => {
    if (!schoolId) return;
    setLoading(true); setError('');
    try {
      const client = requireSupabase();
      let query = client.from('school_administrative_work_items').select('id, school_id, domain, record_type, title, description, status, priority, details, assigned_to, due_date, created_by, created_at, updated_at, profiles(full_name, email)').eq('school_id', schoolId).eq('domain', 'procurement').order('created_at', { ascending: false });
      if (recordTypeFilter) query = query.eq('record_type', recordTypeFilter);
      const { data, error: queryError } = await query;
      if (queryError) throw queryError;
      setWorkItems((data ?? []) as unknown as WorkItem[]);
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Procurement records could not be loaded.'); }
    finally { setLoading(false); }
  }, [schoolId, recordTypeFilter]);
  useEffect(() => { void loadWorkItems(); }, [loadWorkItems]);

  const filtered = useMemo(() => workItems.filter((item) => item.title.toLowerCase().includes(search.toLowerCase()) || item.description.toLowerCase().includes(search.toLowerCase())), [workItems, search]);

  async function saveWorkItem(event: FormEvent) {
    event.preventDefault();
    if (!schoolId || !user) return;
    setFormError('');
    if (!title.trim()) { setFormError('Please enter a title.'); return; }
    setSaving(true);
    try {
      const client = requireSupabase();
      const payload = { school_id: schoolId, domain: 'procurement', record_type: recordType, title: title.trim(), description: description.trim(), status, priority, details: {}, assigned_to: assignedTo || null, due_date: dueDate || null };
      if (editing) {
        const { error: updateError } = await client.from('school_administrative_work_items').update({ title: payload.title, description: payload.description, record_type: payload.record_type, status: payload.status, priority: payload.priority, assigned_to: payload.assigned_to, due_date: payload.due_date }).eq('id', editing.id).eq('school_id', schoolId);
        if (updateError) throw updateError;
        setNotice('Procurement record updated.');
      } else {
        const { error: insertError } = await client.from('school_administrative_work_items').insert(payload);
        if (insertError) throw insertError;
        setNotice('Procurement record created.');
      }
      resetForm(); setFormOpen(false); setEditing(null); void loadWorkItems();
    } catch (saveError) { setFormError(saveError instanceof Error ? saveError.message : 'The record could not be saved.'); }
    finally { setSaving(false); }
  }

  async function deleteWorkItem(id: string) {
    if (!schoolId || !window.confirm('Delete this procurement record?')) return;
    setError('');
    try {
      const client = requireSupabase();
      const { error: deleteError } = await client.from('school_administrative_work_items').delete().eq('id', id).eq('school_id', schoolId);
      if (deleteError) throw deleteError;
      setNotice('Procurement record deleted.');
      setWorkItems((current) => current.filter((i) => i.id !== id));
    } catch (deleteError) { setError(deleteError instanceof Error ? deleteError.message : 'The record could not be deleted.'); }
  }

  function resetForm() { setTitle(''); setDescription(''); setRecordType('supplier'); setStatus('open'); setPriority('normal'); setAssignedTo(null); setDueDate(null); setFormError(''); }
  function formatDate(value: string | null) { if (!value) return '—'; return new Intl.DateTimeFormat(undefined, { dateStyle: 'short' }).format(new Date(value)); }
  const recordTypes = Object.keys(recordTypeLabels) as RecordType[];

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Procurement & purchasing</span>
          <h1>Procurement</h1>
          <p>Manage suppliers, requisitions and purchase orders.</p>
        </div>
        <button className="button button-primary" type="button" onClick={() => { resetForm(); setEditing(null); setFormOpen(true); }}><Plus size={15} /> New record</button>
      </div>

      {error && <ErrorState message={error} />}
      {notice && <SuccessMessage message={notice} />}

      {loading ? <LoadingState label="Loading procurement records…" /> : (
        <section className="content-card" aria-label="Procurement records">
          <div className="section-heading"><div><span className="eyebrow">Procurement records</span><h2>{filtered.length} record{filtered.length === 1 ? '' : 's'}</h2></div></div>

          <div className="table-toolbar" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Search size={14} style={{ color: 'var(--muted)' }} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search records…" style={{ padding: '6px 10px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--surface)', color: 'var(--ink)', fontSize: '0.875rem' }} />
            </label>
            <select value={recordTypeFilter} onChange={(event) => setRecordTypeFilter((event.target.value as RecordType) || '')} style={{ padding: '6px 10px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--surface)', color: 'var(--ink)', fontSize: '0.875rem' }}>
              <option value="">All record types</option>
              {recordTypes.map((rt) => <option key={rt} value={rt}>{recordTypeLabels[rt]}</option>)}
            </select>
          </div>

          {filtered.length === 0 ? (
            <EmptyState title="No procurement records" detail="Create your first supplier, requisition or purchase order record." />
          ) : (
            <div className="table-scroll"><table><thead><tr><th>Title</th><th>Type</th><th>Status</th><th>Priority</th><th>Assigned to</th><th>Due</th><th /></tr></thead><tbody>
              {filtered.map((item) => {
                const RecordIcon = recordTypeIcons[item.record_type];
                return (
                <tr key={item.id}>
                  <td><strong>{item.title}</strong><p style={{ margin: '4px 0 0', fontSize: '0.8125rem', color: 'var(--muted)' }}>{item.description.slice(0, 100)}{item.description.length > 100 ? '…' : ''}</p></td>
                  <td><span className="record-chip"><RecordIcon size={13} className="chip-icon" /> {recordTypeLabels[item.record_type]}</span></td>
                  <td><span className={`status-chip status-${item.status}`}>{statusLabels[item.status]}</span></td>
                  <td><span className={`priority-chip priority-${item.priority}`}>{item.priority}</span></td>
                  <td>{item.profiles?.full_name ?? 'Unassigned'}</td>
                  <td>{formatDate(item.due_date)}</td>
                  <td>
                    <div className="action-row">
                      <button type="button" className="icon-button" title="Edit" onClick={() => { setEditing(item); setTitle(item.title); setDescription(item.description); setRecordType(item.record_type); setStatus(item.status); setPriority(item.priority); setAssignedTo(item.assigned_to); setDueDate(item.due_date); setFormOpen(true); }}><Pencil size={13} /></button>
                      <button type="button" className="icon-button" title="Delete" onClick={() => void deleteWorkItem(item.id)}><Trash2 size={13} /></button>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody></table></div>
          )}
        </section>
      )}

      <section className="content-card" hidden={!formOpen} aria-label="Create or edit procurement record">
        <div className="section-heading"><div><span className="eyebrow">{editing ? 'Edit procurement record' : 'New procurement record'}</span><h2>{editing ? 'Edit procurement record' : 'New procurement record'}</h2></div></div>
        <form onSubmit={saveWorkItem}>
          <div className="settings-fields settings-fields-spaced">
            <label className="field"><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={160} placeholder="e.g. Stationery supplier" /></label>
            <label className="field"><span>Description</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={5000} rows={3} placeholder="Record details…" /></label>
            <label className="field"><span>Record type</span><select value={recordType} onChange={(event) => setRecordType(event.target.value as RecordType)}>
              {recordTypes.map((rt) => <option key={rt} value={rt}>{recordTypeLabels[rt]}</option>)}
            </select></label>
            <label className="field"><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value as WorkItemStatus)}>
              {Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key as WorkItemStatus}>{label}</option>)}
            </select></label>
            <label className="field"><span>Priority</span><select value={priority} onChange={(event) => setPriority(event.target.value as Priority)}>
              {['low', 'normal', 'high', 'urgent'].map((p) => <option key={p} value={p}>{p}</option>)}
            </select></label>
            <label className="field"><span>Due date</span><input type="date" value={dueDate ?? ''} onChange={(event) => setDueDate(event.target.value || null)} /></label>
          </div>
          {formError && <ErrorState message={formError} />}
          <div className="settings-actions">
            <button type="button" className="button button-quiet" onClick={() => { resetForm(); setEditing(null); setFormOpen(false); }}>Cancel</button>
            <button type="submit" className="button button-primary" disabled={saving}><Send size={15} />{saving ? 'Saving…' : editing ? 'Update record' : 'Create record'}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
