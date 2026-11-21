import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Building2, ChevronLeft, ChevronRight, Eye, Pencil, Plus, Save, Search, UserPlus, X } from 'lucide-react';
import { ErrorState, LoadingState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';
import { normalizeTimeZone } from '../lib/timezone';
import { invokeSystemOwnerAction } from '../lib/system-owner-actions';

type SchoolAdmin = { id: string; name: string; email: string | null };
type SchoolRecord = {
  id: string;
  name: string;
  platform_status: 'active' | 'suspended';
  subscription_status: string;
  subscription_plan: string;
  subscription_ends_at: string | null;
  school_type: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  address: string | null;
  website: string | null;
  timezone: string;
  default_language: string;
  date_format: string;
  logo_path: string | null;
  favicon_path: string | null;
  created_at: string;
  user_count: number;
  student_count: number;
  administrators: SchoolAdmin[];
};
type SchoolForm = {
  name: string;
  school_type: string;
  contact_email: string;
  contact_phone: string;
  address: string;
  website: string;
  timezone: string;
  default_language: string;
  date_format: string;
  logo_path: string;
  favicon_path: string;
  subscription_status: string;
  subscription_plan: string;
  subscription_ends_at: string;
};

const pageSize = 20;
const schoolTypeLabels: Record<string, string> = {
  primary: 'Primary',
  secondary: 'Secondary',
  k12: 'K-12',
  university: 'University',
  other: 'Other',
};
const blankForm: SchoolForm = {
  name: '', school_type: '', contact_email: '', contact_phone: '', address: '', website: '',
  timezone: 'UTC', default_language: 'en', date_format: 'YYYY-MM-DD', logo_path: '', favicon_path: '',
  subscription_status: 'free', subscription_plan: 'phase_1_free', subscription_ends_at: '',
};

function makeSchoolForm(school: SchoolRecord): SchoolForm {
  return {
    name: school.name,
    school_type: school.school_type ?? '',
    contact_email: school.contact_email ?? '',
    contact_phone: school.contact_phone ?? '',
    address: school.address ?? '',
    website: school.website ?? '',
    timezone: school.timezone,
    default_language: school.default_language,
    date_format: school.date_format,
    logo_path: school.logo_path ?? '',
    favicon_path: school.favicon_path ?? '',
    subscription_status: school.subscription_status,
    subscription_plan: school.subscription_plan,
    subscription_ends_at: school.subscription_ends_at?.slice(0, 10) ?? '',
  };
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString();
}

export function SystemOwnerSchoolsPanel() {
  const [schools, setSchools] = useState<SchoolRecord[]>([]);
  const [supportedTypes, setSupportedTypes] = useState<string[]>(Object.keys(schoolTypeLabels));
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [sort, setSort] = useState('created_at');
  const [ascending, setAscending] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<SchoolRecord | null>(null);
  const [form, setForm] = useState<SchoolForm>(blankForm);
  const [formOpen, setFormOpen] = useState(false);
  const [isNew, setIsNew] = useState(false);
  const [adminEmail, setAdminEmail] = useState('');
  const [assigning, setAssigning] = useState(false);

  const loadSchools = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data, error: requestError } = await requireSupabase().functions.invoke('system-owner-admin', {
        body: {
          action: 'list-schools', search, statusFilter: status, typeFilter: type,
          sortField: sort, sortAscending: ascending, page, pageSize,
        },
      });
      if (requestError) throw requestError;
      if (!data?.result || !Array.isArray(data.result.schools) || typeof data.result.total !== 'number') {
        throw new Error('The school directory returned an invalid response.');
      }
      setSchools(data.result.schools as SchoolRecord[]);
      setTotal(data.result.total as number);
      if (Array.isArray(data.supportedSchoolTypes)) setSupportedTypes(data.supportedSchoolTypes as string[]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load schools.');
    } finally {
      setLoading(false);
    }
  }, [search, status, type, sort, ascending, page]);

  useEffect(() => { void loadSchools(); }, [loadSchools]);

  function startCreate() {
    setSelected(null);
    setForm(blankForm);
    setIsNew(true);
    setFormOpen(true);
  }

  function startEdit(school: SchoolRecord) {
    setSelected(school);
    setForm(makeSchoolForm(school));
    setIsNew(false);
    setFormOpen(true);
  }

  async function saveSchool(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const timezone = normalizeTimeZone(form.timezone);
    if (!timezone) {
      setError('Enter a valid IANA time zone or UTC offset, such as Africa/Nairobi or GMT +03:00.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: saveError } = await invokeSystemOwnerAction({
        body: {
          action: isNew ? 'register-school' : 'update-school',
          schoolId: selected?.id,
          school: {
            ...form,
            timezone,
            school_type: form.school_type || null,
            subscription_ends_at: form.subscription_ends_at
              ? new Date(`${form.subscription_ends_at}T00:00:00`).toISOString()
              : null,
          },
        },
      });
      if (saveError) throw saveError;
      setFormOpen(false);
      setNotice(isNew ? 'School registered.' : 'School information updated.');
      await loadSchools();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save school information.');
    } finally {
      setSaving(false);
    }
  }

  async function assignAdministrator(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setAssigning(true);
    setError('');
    setNotice('');
    try {
      const { error: assignError } = await invokeSystemOwnerAction({
        body: { action: 'assign-school-admin', schoolId: selected.id, adminEmail },
      });
      if (assignError) throw assignError;
      setAdminEmail('');
      setNotice('School administrator assigned.');
      await loadSchools();
      const { data, error: reloadError } = await requireSupabase().functions.invoke('system-owner-admin', {
        body: {
          action: 'list-schools', search, statusFilter: status, typeFilter: type,
          sortField: sort, sortAscending: ascending, page, pageSize,
        },
      });
      if (reloadError) throw reloadError;
      if (!data?.result || !Array.isArray(data.result.schools)) throw new Error('The refreshed school directory returned an invalid response.');
      const refreshed = (data?.result?.schools as SchoolRecord[] | undefined)?.find((school) => school.id === selected.id);
      if (refreshed) setSelected(refreshed);
    } catch (assignError) {
      setError(assignError instanceof Error ? assignError.message : 'Could not assign administrator.');
    } finally {
      setAssigning(false);
    }
  }

  async function toggleStatus(school: SchoolRecord) {
    setSaving(true);
    setError('');
    setNotice('');
    const statusValue = school.platform_status === 'active' ? 'suspended' : 'active';
    try {
      const { error: statusError } = await invokeSystemOwnerAction({
        body: { action: 'set-school-status', schoolId: school.id, status: statusValue },
      });
      if (statusError) throw statusError;
      setNotice(statusValue === 'active' ? 'School reactivated.' : 'School suspended.');
      await loadSchools();
      if (selected?.id === school.id) setSelected({ ...school, platform_status: statusValue });
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : 'Could not change school status.');
    } finally {
      setSaving(false);
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <section className="content-card system-owner-panel">
      <div className="system-owner-panel-heading">
        <div><span className="eyebrow">Platform administration</span><h2>All registered schools</h2><p>Manage school profiles, administrators, status and subscription access.</p></div>
        <button className="button button-primary" onClick={startCreate}><Plus size={15} /> Register school</button>
      </div>
      {error && <ErrorState message={error} />}
      {notice && <p className="inline-success" role="status">{notice}</p>}
      <div className="system-owner-school-filters">
        <label className="system-owner-search"><Search size={15} /><input value={search} onChange={(event) => { setPage(1); setSearch(event.target.value); }} placeholder="Search school name" aria-label="Search schools" /></label>
        <label className="field"><span>Status</span><select value={status} onChange={(event) => { setPage(1); setStatus(event.target.value); }}><option value="">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option></select></label>
        <label className="field"><span>School type</span><select value={type} onChange={(event) => { setPage(1); setType(event.target.value); }}><option value="">All types</option>{supportedTypes.map((schoolType) => <option key={schoolType} value={schoolType}>{schoolTypeLabels[schoolType] ?? schoolType}</option>)}</select></label>
        <label className="field"><span>Sort by</span><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="created_at">Registration date</option><option value="name">School name</option><option value="status">Status</option><option value="subscription">Subscription</option></select></label>
        <button className="button button-quiet" onClick={() => setAscending(!ascending)} aria-label={`Sort ${ascending ? 'descending' : 'ascending'}`}>{ascending ? 'Ascending' : 'Descending'}</button>
      </div>
      {loading ? <LoadingState label="Loading school directory…" /> : !schools.length ? <p className="system-owner-muted">No schools match these filters.</p> : (
        <div className="system-owner-school-directory">
          {schools.map((school) => <article className={`system-owner-school-record${selected?.id === school.id ? ' selected' : ''}`} key={school.id}>
            <div className="system-owner-school-record-main">
              <span className="system-owner-school-mark">{school.logo_path ? <img src={school.logo_path} alt="" /> : <Building2 size={17} />}</span>
              <div><strong>{school.name}</strong><small>{school.school_type ? school.school_type.replace(/_/g, ' ') : 'School type not set'} · Registered {formatDate(school.created_at)}</small></div>
              <span className={`status-pill ${school.platform_status === 'active' ? 'status-active' : 'status-muted'}`}>{school.platform_status}</span>
              <span className="system-owner-school-counts">{school.user_count} users · {school.student_count} students</span>
              <button className="button button-quiet" onClick={() => setSelected(selected?.id === school.id ? null : school)} aria-expanded={selected?.id === school.id}><Eye size={14} /> Profile</button>
              <button className="button button-quiet" onClick={() => startEdit(school)}><Pencil size={14} /> Edit</button>
            </div>
            {selected?.id === school.id && <div className="system-owner-school-profile">
              <div className="system-owner-school-profile-grid">
                <div><small>Contact</small><strong>{school.contact_email || 'No email'}{school.contact_phone ? ` · ${school.contact_phone}` : ''}</strong></div>
                <div><small>Website</small><strong>{school.website || 'Not set'}</strong></div>
                <div><small>Subscription</small><strong>{school.subscription_status} · {school.subscription_plan}{school.subscription_ends_at ? ` · Ends ${formatDate(school.subscription_ends_at)}` : ''}</strong></div>
                <div><small>Regional settings</small><strong>{school.timezone} · {school.default_language} · {school.date_format}</strong></div>
                <div><small>School administrators</small><strong>{school.administrators.length ? school.administrators.map((admin) => admin.name || admin.email).join(', ') : 'No administrator assigned'}</strong></div>
                <div><small>Address</small><strong>{school.address || 'Not set'}</strong></div>
              </div>
              <form className="system-owner-assign-admin" onSubmit={(event) => void assignAdministrator(event)}>
                <label className="field"><span>Assign school administrator</span><input type="email" required value={adminEmail} onChange={(event) => setAdminEmail(event.target.value)} placeholder="Existing user email" /></label>
                <button className="button button-primary" disabled={assigning || !adminEmail.trim()}><UserPlus size={14} /> {assigning ? 'Assigning…' : 'Assign admin'}</button>
              </form>
              <p className="system-owner-muted">The administrator must already have a Campus Connect account.</p>
              <div className="system-owner-school-profile-actions"><button className={`button ${school.platform_status === 'active' ? 'button-quiet' : 'button-primary'}`} disabled={saving} onClick={() => void toggleStatus(school)}>{school.platform_status === 'active' ? 'Suspend school' : 'Reactivate school'}</button></div>
            </div>}
          </article>)}
        </div>
      )}
      <div className="system-owner-pagination"><span>{total.toLocaleString()} school{total === 1 ? '' : 's'} · Page {page} of {pageCount}</span><div><button className="button button-quiet" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft size={15} /></button><button className="button button-quiet" disabled={page >= pageCount || loading} onClick={() => setPage(page + 1)} aria-label="Next page"><ChevronRight size={15} /></button></div></div>
      {formOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setFormOpen(false); }}>
        <section className="modal-card system-owner-school-modal" role="dialog" aria-modal="true" aria-labelledby="system-owner-school-modal-title">
          <div className="modal-heading"><div><span className="eyebrow">{isNew ? 'New platform school' : 'School profile'}</span><h2 id="system-owner-school-modal-title">{isNew ? 'Register a school' : `Edit ${selected?.name ?? 'school'}`}</h2></div><button className="icon-button" onClick={() => setFormOpen(false)} aria-label="Close"><X size={18} /></button></div>
          <form className="modal-form" onSubmit={(event) => void saveSchool(event)}>
            <div className="settings-fields">
              <label className="field"><span>School name</span><input required minLength={2} maxLength={120} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
              <label className="field"><span>School type</span><select value={form.school_type} onChange={(event) => setForm({ ...form, school_type: event.target.value })}><option value="">Not specified</option>{supportedTypes.map((schoolType) => <option key={schoolType} value={schoolType}>{schoolTypeLabels[schoolType] ?? schoolType}</option>)}{form.school_type && !supportedTypes.includes(form.school_type) && <option value={form.school_type}>{schoolTypeLabels[form.school_type] ?? form.school_type} (unsupported)</option>}</select></label>
              <label className="field"><span>Contact email</span><input type="email" maxLength={320} value={form.contact_email} onChange={(event) => setForm({ ...form, contact_email: event.target.value })} /></label>
              <label className="field"><span>Contact phone</span><input maxLength={40} value={form.contact_phone} onChange={(event) => setForm({ ...form, contact_phone: event.target.value })} /></label>
              <label className="field"><span>Website URL</span><input type="url" maxLength={2000} value={form.website} onChange={(event) => setForm({ ...form, website: event.target.value })} /></label>
              <label className="field"><span>Address</span><input maxLength={500} value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} /></label>
              <label className="field"><span>Time zone</span><input maxLength={100} value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })} /></label>
              <label className="field"><span>Default language</span><input maxLength={20} value={form.default_language} onChange={(event) => setForm({ ...form, default_language: event.target.value })} /></label>
              <label className="field"><span>Date format</span><select value={form.date_format} onChange={(event) => setForm({ ...form, date_format: event.target.value })}><option value="YYYY-MM-DD">YYYY-MM-DD</option><option value="DD/MM/YYYY">DD/MM/YYYY</option><option value="MM/DD/YYYY">MM/DD/YYYY</option><option value="DD.MM.YYYY">DD.MM.YYYY</option></select></label>
              <label className="field"><span>School logo URL</span><input type="url" maxLength={2000} value={form.logo_path} onChange={(event) => setForm({ ...form, logo_path: event.target.value })} /></label>
              <label className="field"><span>School favicon URL</span><input type="url" maxLength={2000} value={form.favicon_path} onChange={(event) => setForm({ ...form, favicon_path: event.target.value })} /></label>
              <label className="field"><span>Subscription status</span><select value={form.subscription_status} onChange={(event) => setForm({ ...form, subscription_status: event.target.value })}><option value="free">Free</option><option value="trial">Trial</option><option value="active">Active</option><option value="past_due">Past due</option><option value="cancelled">Cancelled</option></select></label>
              <label className="field"><span>Subscription plan</span><input maxLength={100} value={form.subscription_plan} onChange={(event) => setForm({ ...form, subscription_plan: event.target.value })} /></label>
              <label className="field"><span>Subscription ends</span><input type="date" value={form.subscription_ends_at} onChange={(event) => setForm({ ...form, subscription_ends_at: event.target.value })} /></label>
            </div>
            {error && <ErrorState message={error} />}
            <div className="modal-actions"><button type="button" className="button button-quiet" onClick={() => setFormOpen(false)}>Cancel</button><button className="button button-primary" disabled={saving}><Save size={14} /> {saving ? 'Saving…' : isNew ? 'Register school' : 'Save changes'}</button></div>
          </form>
        </section>
      </div>}
    </section>
  );
}
