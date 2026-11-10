import { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, Clock3, RefreshCw, Server } from 'lucide-react';
import { ErrorState, LoadingState } from '../components/Feedback';
import { useAuth } from '../contexts/AuthContext';
import { requireSupabase } from '../lib/supabase';

type EndpointType = 'request' | 'database';
interface ApiEndpoint {
  eventType: EndpointType;
  label: string;
  sampleCount: number;
  failureCount: number;
  unknownStatusCount: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  lastObservedAt: string;
}
interface ApiFailure {
  eventType: EndpointType;
  label: string;
  durationMs: number;
  statusCode: number;
  observedAt: string;
}
interface ApiHealthDashboard {
  windowDays: number;
  totalSamples: number;
  failureCount: number;
  knownStatusCount: number;
  unknownStatusCount: number;
  failureRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  lastObservedAt: string | null;
  endpointCount: number;
  endpoints: ApiEndpoint[];
  recentFailures: ApiFailure[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isApiHealthDashboard(value: unknown): value is ApiHealthDashboard {
  if (!isRecord(value) || !Array.isArray(value.endpoints) || !Array.isArray(value.recentFailures)) return false;
  const isEndpoint = (row: unknown): row is ApiEndpoint => isRecord(row)
    && (row.eventType === 'request' || row.eventType === 'database')
    && typeof row.label === 'string'
    && typeof row.lastObservedAt === 'string'
    && ['sampleCount', 'failureCount', 'unknownStatusCount', 'p50Ms', 'p95Ms', 'maxMs'].every(
      (key) => typeof row[key] === 'number' && Number.isFinite(row[key]),
    );
  const isFailure = (row: unknown): row is ApiFailure => isRecord(row)
    && (row.eventType === 'request' || row.eventType === 'database')
    && typeof row.label === 'string'
    && typeof row.durationMs === 'number'
    && typeof row.statusCode === 'number'
    && typeof row.observedAt === 'string';
  return (value.windowDays === 7 || value.windowDays === 30 || value.windowDays === 90)
    && ['totalSamples', 'failureCount', 'knownStatusCount', 'unknownStatusCount', 'endpointCount'].every(
      (key) => typeof value[key] === 'number' && Number.isFinite(value[key]),
    )
    && isNumberOrNull(value.failureRate)
    && isNumberOrNull(value.p50Ms)
    && isNumberOrNull(value.p95Ms)
    && isNumberOrNull(value.maxMs)
    && (value.lastObservedAt === null || typeof value.lastObservedAt === 'string')
    && value.endpoints.every(isEndpoint)
    && value.recentFailures.every(isFailure);
}

function formatDuration(value: number | null) {
  if (value === null) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'No observations';
}

function endpointTypeLabel(type: EndpointType) {
  return type === 'database' ? 'Database / RPC' : 'API / Edge Function';
}

export function SystemOwnerApiHealthPage() {
  const { user } = useAuth();
  const [windowDays, setWindowDays] = useState<7 | 30 | 90>(7);
  const [dashboard, setDashboard] = useState<ApiHealthDashboard | null>(null);
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
        body: { action: 'api-health-dashboard', windowDays },
      });
      if (requestError) throw requestError;
      if (!isApiHealthDashboard(data?.apiHealthDashboard)) {
        throw new Error('The system owner service returned invalid API health data.');
      }
      setDashboard(data.apiHealthDashboard);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load API health data.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user, windowDays]);

  useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  const observationStatus = dashboard?.failureCount
    ? 'Failures observed'
    : dashboard?.totalSamples
      ? 'No observed HTTP failures'
      : 'No observations';
  const observationStatusClass = dashboard?.failureCount
    ? 'system-owner-api-health-status-failure'
    : dashboard?.totalSamples
      ? 'system-owner-api-health-status-observed'
      : 'system-owner-api-health-status-empty';

  return <main className="system-owner-page">
    <header className="system-owner-header">
      <div>
        <span className="eyebrow">Operations · API telemetry</span>
        <h1>API health dashboard</h1>
        <p>Observed endpoint failures and response times from signed-in school workspaces.</p>
      </div>
      <div className="system-owner-header-actions">
        <label className="system-owner-error-window">
          <span className="sr-only">Time range</span>
          <select value={windowDays} onChange={(event) => setWindowDays(Number(event.target.value) as 7 | 30 | 90)} aria-label="API health time range">
            <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
          </select>
        </label>
        <button className="button button-secondary" type="button" onClick={() => void loadDashboard(true)} disabled={loading || refreshing}>
          <RefreshCw size={15} className={refreshing ? 'spin' : undefined} /> Refresh
        </button>
      </div>
    </header>

    {error && <ErrorState message={error} />}
    {!dashboard && loading && <LoadingState label="Loading observed API calls…" />}
    {dashboard && <>
      <section className="system-owner-api-health-status" aria-live="polite">
        <span className={observationStatusClass}>{observationStatus}</span>
        <p>Last observed request: {formatDate(dashboard.lastObservedAt)}</p>
      </section>

      <section className="system-owner-stat-grid" aria-label="API health summary">
        <article className="system-owner-stat"><span><Server size={17} /></span><small>Observed API calls</small><strong>{dashboard.totalSamples.toLocaleString()}</strong><p>Across {dashboard.endpointCount.toLocaleString()} endpoint groups in {dashboard.windowDays} days</p></article>
        <article className="system-owner-stat"><span><AlertTriangle size={17} /></span><small>HTTP failures observed</small><strong>{dashboard.failureCount.toLocaleString()}</strong><p>{dashboard.knownStatusCount.toLocaleString()} calls with a reported HTTP status</p></article>
        <article className="system-owner-stat"><span><Activity size={17} /></span><small>Failure rate</small><strong>{dashboard.failureRate === null ? '—' : `${dashboard.failureRate}%`}</strong><p>Among observed HTTP statuses; excludes unknown status</p></article>
        <article className="system-owner-stat"><span><Clock3 size={17} /></span><small>Response time · p95</small><strong>{formatDuration(dashboard.p95Ms)}</strong><p>p50 {formatDuration(dashboard.p50Ms)} · max {formatDuration(dashboard.maxMs)}</p></article>
      </section>

      <section className="content-card system-owner-panel">
        <div className="system-owner-panel-heading"><div><span className="eyebrow">Grouped by observed service</span><h2>Endpoint response times and failures</h2>
          <p>Calls are grouped by normalized Supabase resource name. p95 is the response-time threshold containing 95% of observed calls.</p>
        </div><Server size={17} /></div>
        {dashboard.endpoints.length ? <div className="system-owner-error-table-wrap">
          <table className="system-owner-error-table">
            <thead><tr><th>Service</th><th>Endpoint</th><th>Samples</th><th>Failures</th><th>Status unknown</th><th>p50</th><th>p95</th><th>Max</th><th>Last observed</th></tr></thead>
            <tbody>{dashboard.endpoints.map((endpoint) => <tr key={`${endpoint.eventType}:${endpoint.label}`}>
              <td>{endpointTypeLabel(endpoint.eventType)}</td>
              <td><code>{endpoint.label}</code></td>
              <td>{endpoint.sampleCount.toLocaleString()}</td>
              <td><strong>{endpoint.failureCount.toLocaleString()}</strong></td>
              <td>{endpoint.unknownStatusCount.toLocaleString()}</td>
              <td>{formatDuration(endpoint.p50Ms)}</td>
              <td>{formatDuration(endpoint.p95Ms)}</td>
              <td>{formatDuration(endpoint.maxMs)}</td>
              <td>{formatDate(endpoint.lastObservedAt)}</td>
            </tr>)}</tbody>
          </table>
        </div> : <p className="system-owner-muted">No API or database endpoint observations were collected in this period. Activity will appear after signed-in school users use the app.</p>}
      </section>

      <section className="content-card system-owner-panel">
        <div className="system-owner-panel-heading"><div><span className="eyebrow">HTTP status 400 and above</span><h2>Recent observed failures</h2>
          <p>Most recent 100 failures, with endpoint, response time, and status code. Request URLs, query strings, and bodies are not shown.</p>
        </div><AlertTriangle size={17} /></div>
        {dashboard.recentFailures.length ? <div className="system-owner-error-table-wrap">
          <table className="system-owner-error-table">
            <thead><tr><th>Service</th><th>Endpoint</th><th>HTTP status</th><th>Response time</th><th>Observed</th></tr></thead>
            <tbody>{dashboard.recentFailures.map((failure, index) => <tr key={`${failure.observedAt}:${failure.label}:${index}`}>
              <td>{endpointTypeLabel(failure.eventType)}</td>
              <td><code>{failure.label}</code></td>
              <td><strong>{failure.statusCode}</strong></td>
              <td>{formatDuration(failure.durationMs)}</td>
              <td>{formatDate(failure.observedAt)}</td>
            </tr>)}</tbody>
          </table>
        </div> : <p className="system-owner-muted">No HTTP failures with a reported status code were observed in this period.</p>}
      </section>

      <p className="system-owner-muted">This dashboard reports sampled browser observations, not synthetic probes or a guarantee of current service availability. Each signed-in school-workspace session records up to 40 API observations. A missing HTTP status is counted as unknown, not as success or failure.</p>
    </>}
  </main>;
}
