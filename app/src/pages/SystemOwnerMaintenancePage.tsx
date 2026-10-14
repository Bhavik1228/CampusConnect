import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, CalendarClock, Check, Clock3, Power, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { ErrorState, LoadingState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type MaintenanceWindow = {
  id: string;
  scope: 'global' | 'school' | 'module';
  school_id: string | null;
  module_key: string | null;
  starts_at: string;
  ends_at: string | null;
  read_only: boolean;
  notice: string;
  school: { name: string } | null;
};
type SchoolOption = { id: string; name: string };
type MaintenanceData = {
  maintenance: { global_enabled: boolean; global_read_only: boolean; emergency_enabled: boolean; notice: string };
  status: { active: boolean; scope: string | null; read_only: boolean; notice: string; ends_at: string | null; emergency: boolean };
  windows: MaintenanceWindow[];
  schools: SchoolOption[];
  modules: string[];
};

function dateTimeLocal(date: Date) {
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function displayDate(value: string) {
  return new Date(value).toLocaleString();
}

function windowStatus(window: MaintenanceWindow, now: number) {
  if (Date.parse(window.starts_at) > now) return 'Scheduled';
  if (window.ends_at && Date.parse(window.ends_at) <= now) return 'Ended';
  return 'Active';
}

export function SystemOwnerMaintenancePage() {
  const [data, setData] = useState<MaintenanceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [globalNotice, setGlobalNotice] = useState('Campus Connect is undergoing maintenance. Please try again later.');
  const [scope, setScope] = useState<'global' | 'school' | 'module'>('global');
  const [schoolId, setSchoolId] = useState('');
  const [moduleKey, setModuleKey] = useState('');
  const [startsAt, setStartsAt] = useState(dateTimeLocal(new Date()));
  const [endsAt, setEndsAt] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [windowNotice, setWindowNotice] = useState('');
  const [now, setNow] = useState(Date.now());

  const loadMaintenance = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    setError('');
    try {
      const { data: result, error: requestError } = await requireSupabase().functions.invoke('system-owner-admin', {
        body: { action: 'maintenance-dashboard' },
      });
      if (requestError) throw requestError;
      if (!result?.maintenance || !result?.status || !Array.isArray(result.windows) || !Array.isArray(result.schools) || !Array.isArray(result.modules)) {
        throw new Error('The maintenance dashboard returned an invalid response.');
      }
      setData(result as MaintenanceData);
      setGlobalNotice(result.maintenance.notice || 'Campus Connect is undergoing maintenance. Please try again later.');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load maintenance settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadMaintenance(); }, [loadMaintenance]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void loadMaintenance(true);
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [loadMaintenance]);

  async function saveGlobal(enabled: boolean, emergency = false) {
    if (!data) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: actionError } = await requireSupabase().functions.invoke('system-owner-admin', {
        body: {
          action: 'set-global-maintenance',
          enabled,
          readOnly: emergency || data.maintenance.global_read_only,
          emergency,
          notice: globalNotice.trim(),
        },
      });
      if (actionError) throw actionError;
      setNotice(emergency ? 'Emergency maintenance activated in read-only mode.' : enabled ? 'Global maintenance activated.' : 'Global maintenance disabled and global schedules cancelled.');
      await loadMaintenance(true);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Could not update global maintenance.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleReadOnly(enabled: boolean) {
    if (!data) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: actionError } = await requireSupabase().functions.invoke('system-owner-admin', {
        body: {
          action: 'set-global-maintenance',
          enabled: data.maintenance.global_enabled,
          readOnly: enabled,
          emergency: data.maintenance.emergency_enabled,
          notice: globalNotice.trim(),
        },
      });
      if (actionError) throw actionError;
      setNotice(enabled ? 'Global read-only mode enabled; school data changes are blocked.' : 'Global read-only mode disabled.');
      await loadMaintenance(true);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Could not change read-only mode.');
    } finally {
      setSaving(false);
    }
  }

  async function scheduleMaintenance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: actionError } = await requireSupabase().functions.invoke('system-owner-admin', {
        body: {
          action: 'schedule-maintenance',
          scope,
          schoolId: scope === 'global' ? null : schoolId,
          moduleKey: scope === 'module' ? moduleKey : null,
          startsAt: new Date(startsAt).toISOString(),
          endsAt: endsAt ? new Date(endsAt).toISOString() : null,
          readOnly,
          notice: windowNotice.trim(),
        },
      });
      if (actionError) throw actionError;
      setNotice('Maintenance window scheduled. Activation and deactivation follow the configured times automatically.');
      setWindowNotice('');
      setEndsAt('');
      await loadMaintenance(true);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Could not schedule maintenance.');
    } finally {
      setSaving(false);
    }
  }

  async function cancelWindow(id: string) {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: actionError } = await requireSupabase().functions.invoke('system-owner-admin', {
        body: { action: 'cancel-maintenance', windowId: id },
      });
      if (actionError) throw actionError;
      setNotice('Maintenance schedule cancelled.');
      await loadMaintenance(true);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Could not cancel the maintenance window.');
    } finally {
      setSaving(false);
    }
  }

  const activeWindows = data?.windows.filter((window) =>
    window.scope !== 'global' && windowStatus(window, now) === 'Active'
  ) ?? [];
  const scheduledWindows = data?.windows.filter((window) => windowStatus(window, now) === 'Scheduled') ?? [];

  if (loading) return <main className="system-owner-page"><LoadingState label="Loading maintenance dashboard…" /></main>;

  return <main className="system-owner-page">
    <header className="system-owner-header"><div><span className="eyebrow">Platform controls</span><h1>Maintenance mode</h1><p>Schedule service work, restrict writes, or place the platform or selected school features into maintenance.</p></div><button className="button button-quiet" disabled={saving} onClick={() => void loadMaintenance(true)}><RefreshCw size={15} /> Refresh status</button></header>
    {error && <ErrorState message={error} />}
    {notice && <p className="inline-success" role="status">{notice}</p>}
    {!data && <ErrorState message="Maintenance configuration is not available." />}
    {data && <>
      <section className="system-owner-stat-grid" aria-label="Maintenance status">
        <article className="system-owner-stat"><span><Power size={17} /></span><small>Global mode</small><strong>{data.status.active && data.status.scope === 'global' ? 'Active' : 'Off'}</strong><p>{data.maintenance.emergency_enabled ? 'Emergency mode' : data.maintenance.global_read_only ? 'Read-only' : 'Standard access'}</p></article>
        <article className="system-owner-stat"><span><ShieldAlert size={17} /></span><small>Active scoped windows</small><strong>{activeWindows.length}</strong><p>School- and module-level maintenance</p></article>
        <article className="system-owner-stat"><span><CalendarClock size={17} /></span><small>Scheduled windows</small><strong>{scheduledWindows.length}</strong><p>Automatic activation at the start time</p></article>
        <article className="system-owner-stat"><span><Clock3 size={17} /></span><small>Current notice</small><strong>{data.status.active ? 'Visible' : 'None'}</strong><p>{data.status.active ? data.status.notice || 'Maintenance in progress' : 'No platform-wide notice'}</p></article>
      </section>

      <section className="content-card system-owner-panel">
        <div className="system-owner-panel-heading"><div><span className="eyebrow">Global maintenance</span><h2>{data.maintenance.global_enabled ? 'Global mode enabled' : 'Global mode disabled'}</h2><p>Applies to all school workspaces. Scheduled windows are calculated against database time.</p></div><Power size={18} /></div>
        <label className="field system-owner-maintenance-notice"><span>Notice shown during global maintenance</span><textarea rows={3} maxLength={2000} value={globalNotice} onChange={(event) => setGlobalNotice(event.target.value)} /></label>
        <div className="system-owner-maintenance-controls">
          <button className="button button-primary" disabled={saving || data.maintenance.global_enabled} onClick={() => void saveGlobal(true)}><Check size={14} /> Enable global maintenance</button>
          <button className="button button-quiet" disabled={saving || !data.maintenance.global_enabled} onClick={() => void saveGlobal(false)}><X size={14} /> Disable global maintenance</button>
          <button className="button button-danger" disabled={saving} onClick={() => void saveGlobal(true, true)}><AlertTriangle size={14} /> Emergency activation</button>
        </div>
        <label className="system-owner-maintenance-toggle"><input type="checkbox" checked={data.maintenance.global_read_only} disabled={saving || !data.maintenance.global_enabled} onChange={(event) => void toggleReadOnly(event.target.checked)} /><span><strong>Global read-only mode</strong><small>Users can view school data, but database changes are rejected. Only the verified system owner can change this mode.</small></span></label>
      </section>

      <section className="content-card system-owner-panel">
        <div className="system-owner-panel-heading"><div><span className="eyebrow">Automatic scheduling</span><h2>Schedule maintenance</h2><p>Scheduled windows turn on and expire automatically using server/database time, including when no one has the app open.</p></div><CalendarClock size={18} /></div>
        <form className="system-owner-maintenance-form" onSubmit={(event) => void scheduleMaintenance(event)}>
          <label className="field"><span>Scope</span><select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="global">Global platform</option><option value="school">One school</option><option value="module">One module in a school</option></select></label>
          {scope !== 'global' && <label className="field"><span>School</span><select required value={schoolId} onChange={(event) => setSchoolId(event.target.value)}><option value="">Choose school</option>{data.schools.map((school) => <option key={school.id} value={school.id}>{school.name}</option>)}</select></label>}
          {scope === 'module' && <label className="field"><span>Module</span><select required value={moduleKey} onChange={(event) => setModuleKey(event.target.value)}><option value="">Choose module</option>{data.modules.map((module) => <option key={module} value={module}>{module.replace(/_/g, ' ')}</option>)}</select></label>}
          <label className="field"><span>Start time</span><input type="datetime-local" required value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></label>
          <label className="field"><span>End time <small>(required for future schedules)</small></span><input type="datetime-local" required={Date.parse(startsAt) > Date.now()} min={startsAt} value={endsAt} onChange={(event) => setEndsAt(event.target.value)} /></label>
          <label className="field system-owner-maintenance-notice"><span>Maintenance notice</span><textarea rows={2} maxLength={2000} value={windowNotice} onChange={(event) => setWindowNotice(event.target.value)} placeholder="Optional notice for affected users" /></label>
          <label className="system-owner-maintenance-toggle"><input type="checkbox" checked={readOnly} onChange={(event) => setReadOnly(event.target.checked)} /><span><strong>Read-only during this window</strong><small>Enabled and enforced by the server-side database write guard.</small></span></label>
          <div className="system-owner-maintenance-submit"><button className="button button-primary" disabled={saving}><CalendarClock size={14} /> {saving ? 'Saving…' : 'Schedule maintenance'}</button></div>
        </form>
      </section>

      <section className="content-card system-owner-panel">
        <div className="system-owner-panel-heading"><div><span className="eyebrow">Maintenance status dashboard</span><h2>Maintenance windows</h2><p>Active and upcoming global, school-specific and module-specific windows.</p></div><ShieldAlert size={18} /></div>
        {!data.windows.length ? <p className="system-owner-muted">No maintenance windows configured.</p> : <div className="system-owner-window-list">{data.windows.map((window) => {
          const state = windowStatus(window, now);
          return <article key={window.id}>
            <div><strong>{window.scope === 'global' ? 'Global platform' : window.scope === 'school' ? window.school?.name ?? 'School' : `${window.school?.name ?? 'School'} · ${window.module_key}`}</strong><small>{state} · {displayDate(window.starts_at)}{window.ends_at ? ` → ${displayDate(window.ends_at)}` : ' · Until disabled'} · {window.read_only ? 'Read-only' : 'Maintenance'}</small>{window.notice && <p>{window.notice}</p>}</div>
            {state !== 'Ended' && <button className="button button-quiet" disabled={saving} onClick={() => void cancelWindow(window.id)}><X size={14} /> Cancel</button>}
          </article>;
        })}</div>}
      </section>
    </>}
  </main>;
}
