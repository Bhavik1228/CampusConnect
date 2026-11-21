import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, BookOpenCheck, Clock3, Plus, Save } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/Feedback';
import { useAuth } from '../contexts/AuthContext';
import { invokeSystemOwnerAction } from '../lib/system-owner-actions';

type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';
type IncidentSeverity = 'critical' | 'high' | 'medium' | 'low';
type Incident = {
  id: string;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  started_at: string;
  resolved_at: string | null;
  affected_services: string;
  impact: string;
  cause: string;
  fix: string;
  lessons: string;
  created_at: string;
  updated_at: string;
};
type IncidentDraft = Omit<Incident, 'id' | 'created_at' | 'updated_at'> & { id?: string };

const incidentTabs = [
  { to: '/system-owner/errors', label: 'Error dashboard', end: true },
  { to: '/system-owner/errors/incidents', label: 'System incident log', end: false },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIncident(value: unknown): value is Incident {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.title === 'string'
    && (value.severity === 'critical' || value.severity === 'high' || value.severity === 'medium' || value.severity === 'low')
    && (value.status === 'investigating' || value.status === 'identified' || value.status === 'monitoring' || value.status === 'resolved')
    && typeof value.started_at === 'string'
    && (value.resolved_at === null || typeof value.resolved_at === 'string')
    && typeof value.affected_services === 'string'
    && typeof value.impact === 'string'
    && typeof value.cause === 'string'
    && typeof value.fix === 'string'
    && typeof value.lessons === 'string'
    && typeof value.created_at === 'string'
    && typeof value.updated_at === 'string';
}

function toLocalDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function fromLocalDateTime(value: string) {
  return value ? new Date(value).toISOString() : null;
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

function newIncident(): IncidentDraft {
  return {
    title: '',
    severity: 'medium',
    status: 'investigating',
    started_at: toLocalDateTime(new Date().toISOString()),
    resolved_at: null,
    affected_services: '',
    impact: '',
    cause: '',
    fix: '',
    lessons: '',
  };
}

function draftFromIncident(incident: Incident): IncidentDraft {
  return {
    id: incident.id,
    title: incident.title,
    severity: incident.severity,
    status: incident.status,
    started_at: toLocalDateTime(incident.started_at),
    resolved_at: incident.resolved_at ? toLocalDateTime(incident.resolved_at) : null,
    affected_services: incident.affected_services,
    impact: incident.impact,
    cause: incident.cause,
    fix: incident.fix,
    lessons: incident.lessons,
  };
}

export function SystemOwnerIncidentsPage() {
  const { user } = useAuth();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [draft, setDraft] = useState<IncidentDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadIncidents = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError('');
    try {
      const { data, error: requestError } = await invokeSystemOwnerAction({
        body: { action: 'incident-list' },
      });
      if (requestError) throw requestError;
      if (!data || !Array.isArray(data.incidents) || !data.incidents.every(isIncident)) {
        throw new Error('The system owner service returned invalid incident data.');
      }
      setIncidents(data.incidents);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load the incident log.');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { void loadIncidents(); }, [loadIncidents]);

  async function saveIncident(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const resolvedAt = draft.status === 'resolved'
        ? draft.resolved_at ? fromLocalDateTime(draft.resolved_at) : new Date().toISOString()
        : null;
      const { data, error: requestError } = await invokeSystemOwnerAction({
        body: {
          action: 'save-incident',
          incidentId: draft.id,
          title: draft.title,
          severity: draft.severity,
          incidentStatus: draft.status,
          startedAt: fromLocalDateTime(draft.started_at),
          resolvedAt,
          affectedServices: draft.affected_services,
          impact: draft.impact,
          cause: draft.cause,
          fix: draft.fix,
          lessons: draft.lessons,
        },
      });
      if (requestError) throw requestError;
      if (!isIncident(data?.incident)) throw new Error('The system owner service returned an invalid incident update.');
      setIncidents((current) => [
        data.incident,
        ...current.filter((item) => item.id !== data.incident.id),
      ].sort((left, right) => right.started_at.localeCompare(left.started_at)));
      setDraft(null);
      setNotice('Incident record saved.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save the incident.');
    } finally {
      setSaving(false);
    }
  }

  function updateDraft<K extends keyof IncidentDraft>(key: K, value: IncidentDraft[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  }

  return <main className="system-owner-page">
    <header className="system-owner-header">
      <div>
        <span className="eyebrow">Operations · incident response</span>
        <h1>System incident log</h1>
        <p>Record service impact, causes, fixes, and lessons learned. Restricted to the system owner.</p>
      </div>
      <div className="system-owner-header-actions">
        {!draft && <button className="button button-primary" type="button" onClick={() => { setError(''); setDraft(newIncident()); }}>
          <Plus size={15} /> Record incident
        </button>}
      </div>
    </header>

    <nav className="system-owner-error-tabs" aria-label="Errors and incidents">
      {incidentTabs.map(({ to, label, end }) => <NavLink key={to} to={to} end={end} className={({ isActive }) => isActive ? 'active' : ''}>{label}</NavLink>)}
    </nav>

    {error && <ErrorState message={error} />}
    {notice && <p className="system-owner-release-notice" role="status">{notice}</p>}

    {draft && <form className="content-card system-owner-panel system-owner-incident-form" onSubmit={(event) => void saveIncident(event)}>
      <div className="system-owner-panel-heading"><div><span className="eyebrow">{draft.id ? 'Update record' : 'New record'}</span><h2>{draft.id ? 'Edit incident' : 'Record a system incident'}</h2></div><AlertTriangle size={17} /></div>
      <div className="system-owner-incident-fields">
        <label className="field"><span>Incident title</span><input value={draft.title} maxLength={160} required minLength={3} onChange={(event) => updateDraft('title', event.target.value)} /></label>
        <label className="field"><span>Severity</span><select value={draft.severity} onChange={(event) => updateDraft('severity', event.target.value as IncidentSeverity)}>
          <option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
        </select></label>
        <label className="field"><span>Status</span><select value={draft.status} onChange={(event) => updateDraft('status', event.target.value as IncidentStatus)}>
          <option value="investigating">Investigating</option><option value="identified">Cause identified</option><option value="monitoring">Monitoring recovery</option><option value="resolved">Resolved</option>
        </select></label>
        <label className="field"><span>Started at</span><input type="datetime-local" value={draft.started_at} required onChange={(event) => updateDraft('started_at', event.target.value)} /></label>
        {draft.status === 'resolved' && <label className="field"><span>Recovered at</span><input type="datetime-local" value={draft.resolved_at ?? ''} required onChange={(event) => updateDraft('resolved_at', event.target.value)} /></label>}
        <label className="field"><span>Affected services</span><input value={draft.affected_services} maxLength={500} placeholder="Database, authentication, web app…" onChange={(event) => updateDraft('affected_services', event.target.value)} /></label>
      </div>
      <label className="field"><span>Impact</span><textarea rows={2} maxLength={2000} value={draft.impact} onChange={(event) => updateDraft('impact', event.target.value)} placeholder="Who was affected and what could they not do?" /></label>
      <label className="field"><span>Cause</span><textarea rows={2} maxLength={3000} value={draft.cause} onChange={(event) => updateDraft('cause', event.target.value)} /></label>
      <label className="field"><span>Fix and recovery</span><textarea rows={2} maxLength={3000} value={draft.fix} onChange={(event) => updateDraft('fix', event.target.value)} /></label>
      <label className="field"><span>Lessons learned</span><textarea rows={2} maxLength={3000} value={draft.lessons} onChange={(event) => updateDraft('lessons', event.target.value)} /></label>
      <div className="system-owner-incident-actions">
        <button className="button button-secondary" type="button" onClick={() => setDraft(null)} disabled={saving}>Cancel</button>
        <button className="button button-primary" type="submit" disabled={saving}><Save size={14} /> {saving ? 'Saving…' : 'Save incident'}</button>
      </div>
    </form>}

    {loading && <LoadingState label="Loading system incidents…" />}
    {!loading && !incidents.length && !draft && <section className="content-card system-owner-panel system-owner-incident-empty">
      <BookOpenCheck size={23} /><strong>No incidents recorded</strong><span>When an incident occurs, record its impact and add the cause, resolution, and lessons learned here.</span>
    </section>}
    {!!incidents.length && <section className="system-owner-incident-list" aria-label="System incidents">
      {incidents.map((incident) => <article className="content-card system-owner-incident-card" key={incident.id}>
        <header className="system-owner-incident-heading">
          <div><span className={`system-owner-error-severity ${incident.severity}`}>{incident.severity}</span><h2>{incident.title}</h2></div>
          <div className="system-owner-incident-actions">
            <span className={`system-owner-incident-status ${incident.status}`}>{incident.status.replaceAll('_', ' ')}</span>
            <button className="button button-secondary" type="button" onClick={() => { setError(''); setDraft(draftFromIncident(incident)); }}>Edit</button>
          </div>
        </header>
        <p className="system-owner-incident-timing"><Clock3 size={14} /> Started {formatDate(incident.started_at)}{incident.resolved_at ? ` · Recovered ${formatDate(incident.resolved_at)}` : ' · No recovery time recorded'}</p>
        {incident.affected_services && <p className="system-owner-incident-services"><strong>Affected services:</strong> {incident.affected_services}</p>}
        <div className="system-owner-incident-details">
          {incident.impact && <section><h3>Impact</h3><p>{incident.impact}</p></section>}
          {incident.cause && <section><h3>Cause</h3><p>{incident.cause}</p></section>}
          {incident.fix && <section><h3>Fix and recovery</h3><p>{incident.fix}</p></section>}
          {incident.lessons && <section><h3>Lessons learned</h3><p>{incident.lessons}</p></section>}
          {!incident.impact && !incident.cause && !incident.fix && !incident.lessons && <p className="system-owner-muted">Add impact details, root cause, fix, and lessons using Edit.</p>}
        </div>
        <small className="system-owner-incident-updated">Last updated {formatDate(incident.updated_at)}</small>
      </article>)}
    </section>}
  </main>;
}
