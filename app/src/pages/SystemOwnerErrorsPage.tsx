import { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, Clock3, RefreshCw, ShieldAlert } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/Feedback';
import { useAuth } from '../contexts/AuthContext';
import { requireSupabase } from '../lib/supabase';

type Severity = 'critical' | 'high' | 'medium' | 'low';
type ErrorGroup = {
  code: string;
  featureCode: string;
  kind: string;
  severity: Severity;
  occurrences: number;
  affectedSchools: number;
  firstSeenAt: string;
  lastSeenAt: string;
};
type ErrorDashboard = {
  windowDays: number;
  totalEvents: number;
  severityCounts: Record<Severity, number>;
  errors: ErrorGroup[];
};

const severityOrder: Severity[] = ['critical', 'high', 'medium', 'low'];
const severityIcons = {
  critical: ShieldAlert,
  high: AlertTriangle,
  medium: Activity,
  low: Clock3,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrorDashboard(value: unknown): value is ErrorDashboard {
  if (!isRecord(value)) return false;
  const severityCounts = value.severityCounts;
  const errors = value.errors;
  if (!isRecord(severityCounts) || !Array.isArray(errors)) return false;
  return (value.windowDays === 7 || value.windowDays === 30 || value.windowDays === 90)
    && typeof value.totalEvents === 'number'
    && severityOrder.every((severity) => typeof severityCounts[severity] === 'number')
    && errors.every((item) =>
      isRecord(item)
      && typeof item.code === 'string'
      && typeof item.featureCode === 'string'
      && typeof item.kind === 'string'
      && typeof item.severity === 'string'
      && severityOrder.some((severity) => item.severity === severity)
      && typeof item.occurrences === 'number'
      && typeof item.affectedSchools === 'number'
      && typeof item.firstSeenAt === 'string'
      && typeof item.lastSeenAt === 'string');
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

export function SystemOwnerErrorsPage() {
  const { user } = useAuth();
  const [windowDays, setWindowDays] = useState<7 | 30 | 90>(30);
  const [dashboard, setDashboard] = useState<ErrorDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const loadDashboard = useCallback(async (background = false) => {
    if (!user) return;
    if (background) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const { data, error: requestError } = await requireSupabase().functions.invoke('system-owner-admin', {
        body: { action: 'error-dashboard', windowDays },
      });
      if (requestError) throw requestError;
      if (!isErrorDashboard(data?.errorDashboard)) {
        throw new Error('The system owner service returned invalid error dashboard data.');
      }
      setDashboard(data.errorDashboard);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load the error dashboard.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user, windowDays]);

  useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  return <main className="system-owner-page">
    <header className="system-owner-header">
      <div>
        <span className="eyebrow">Operations · application diagnostics</span>
        <h1>Error dashboard</h1>
        <p>Application errors grouped by diagnostic code, frequency, and category-based severity.</p>
      </div>
      <div className="system-owner-header-actions">
        <label className="system-owner-error-window">
          <span className="sr-only">Time range</span>
          <select
            value={windowDays}
            onChange={(event) => setWindowDays(Number(event.target.value) as 7 | 30 | 90)}
            aria-label="Error dashboard time range"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </label>
        <button className="button button-secondary" type="button" onClick={() => void loadDashboard(true)} disabled={loading || refreshing}>
          <RefreshCw size={15} className={refreshing ? 'spin' : undefined} /> Refresh
        </button>
      </div>
    </header>

    <nav className="system-owner-error-tabs" aria-label="Errors and incidents">
      <NavLink to="/system-owner/errors" end className={({ isActive }) => isActive ? 'active' : ''}>Error dashboard</NavLink>
      <NavLink to="/system-owner/errors/incidents" className={({ isActive }) => isActive ? 'active' : ''}>System incident log</NavLink>
    </nav>

    {error && <ErrorState message={error} />}
    {!dashboard && loading && <LoadingState label="Loading application error events…" />}
    {dashboard && <>
      <section className="system-owner-stat-grid" aria-label="Error severity summary">
        <article className="system-owner-stat">
          <span><Activity size={17} /></span><small>Recorded events</small>
          <strong>{dashboard.totalEvents.toLocaleString()}</strong><p>In the last {dashboard.windowDays} days</p>
        </article>
        {severityOrder.map((severity) => {
          const Icon = severityIcons[severity];
          return <article className="system-owner-stat" key={severity}>
            <span className={`system-owner-error-icon ${severity}`}><Icon size={17} /></span>
            <small>{severity[0].toUpperCase() + severity.slice(1)} severity</small>
            <strong>{dashboard.severityCounts[severity].toLocaleString()}</strong>
            <p>Events classified as {severity}</p>
          </article>;
        })}
      </section>

      <section className="content-card system-owner-panel">
        <div className="system-owner-panel-heading">
          <div><span className="eyebrow">Most frequent first</span><h2>Grouped application errors</h2>
            <p>Counts represent error panels shown to signed-in school members. Severity is derived from the diagnostic category, not a confirmed impact assessment.</p>
          </div>
          <AlertTriangle size={17} />
        </div>
        {dashboard.errors.length ? <div className="system-owner-error-table-wrap">
          <table className="system-owner-error-table">
            <thead><tr>
              <th scope="col">Diagnostic code</th><th scope="col">Feature</th><th scope="col">Severity</th>
              <th scope="col">Occurrences</th><th scope="col">Schools</th><th scope="col">First / last seen</th>
            </tr></thead>
            <tbody>{dashboard.errors.map((item) => <tr key={item.code}>
              <td><code>{item.code}</code><small>{item.kind}</small></td>
              <td>{item.featureCode}</td>
              <td><span className={`system-owner-error-severity ${item.severity}`}>{item.severity}</span></td>
              <td><strong>{item.occurrences.toLocaleString()}</strong></td>
              <td>{item.affectedSchools.toLocaleString()}</td>
              <td><span>{formatDate(item.firstSeenAt)}</span><small>Last: {formatDate(item.lastSeenAt)}</small></td>
            </tr>)}</tbody>
          </table>
        </div> : <p className="system-owner-muted">No diagnostic events were recorded in this period. Events appear when a signed-in school member sees a standard application error panel.</p>}
        <p className="system-owner-muted">Only diagnostic codes, feature/category, severity, school scope, and timestamps are retained for up to 90 days. Raw error messages and contact details are not collected.</p>
      </section>
    </>}
  </main>;
}
