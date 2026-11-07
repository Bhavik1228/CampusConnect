import { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, Clock3, Database, RefreshCw, Server } from 'lucide-react';
import { ErrorState, LoadingState } from '../components/Feedback';
import { useAuth } from '../contexts/AuthContext';
import { requireSupabase } from '../lib/supabase';

type EventType = 'page' | 'request' | 'database';
type PerformanceSummary = {
  eventType: EventType;
  sampleCount: number;
  failureCount: number;
  p50Ms: number;
  p75Ms: number;
  p95Ms: number;
  maxMs: number;
};
type PerformanceGroup = PerformanceSummary & { label: string; route: string };
type SlowEvent = {
  eventType: EventType;
  label: string;
  route: string;
  durationMs: number;
  statusCode: number | null;
  createdAt: string;
};
type CoreWebVital = { name: 'lcp' | 'inp' | 'cls'; sampleCount: number; p75: number | null };
type PerformanceDashboard = {
  windowDays: number;
  totalSamples: number;
  coreWebVitals: CoreWebVital[];
  summary: PerformanceSummary[];
  groups: PerformanceGroup[];
  slowEvents: SlowEvent[];
};

const eventLabels: Record<EventType, string> = {
  page: 'Pages',
  request: 'Requests',
  database: 'Database',
};
const eventIcons = { page: Activity, request: Server, database: Database };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPerformanceDashboard(value: unknown): value is PerformanceDashboard {
  if (!isRecord(value) || !Array.isArray(value.summary) || !Array.isArray(value.groups)
    || !Array.isArray(value.slowEvents) || !Array.isArray(value.coreWebVitals)) return false;
  return (value.windowDays === 7 || value.windowDays === 30 || value.windowDays === 90)
    && typeof value.totalSamples === 'number'
    && value.coreWebVitals.every((row) => isRecord(row)
      && (row.name === 'lcp' || row.name === 'inp' || row.name === 'cls')
      && typeof row.sampleCount === 'number'
      && (row.p75 === null || typeof row.p75 === 'number'))
    && value.summary.every((row) => isRecord(row)
      && (row.eventType === 'page' || row.eventType === 'request' || row.eventType === 'database')
      && ['sampleCount', 'failureCount', 'p50Ms', 'p75Ms', 'p95Ms', 'maxMs'].every((key) => typeof row[key] === 'number'))
    && value.groups.every((row) => isRecord(row)
      && (row.eventType === 'page' || row.eventType === 'request' || row.eventType === 'database')
      && typeof row.label === 'string'
      && typeof row.route === 'string'
      && ['sampleCount', 'failureCount', 'p50Ms', 'p75Ms', 'p95Ms', 'maxMs'].every((key) => typeof row[key] === 'number'))
    && value.slowEvents.every((row) => isRecord(row)
      && (row.eventType === 'page' || row.eventType === 'request' || row.eventType === 'database')
      && typeof row.label === 'string'
      && typeof row.route === 'string'
      && typeof row.durationMs === 'number'
      && (row.statusCode === null || typeof row.statusCode === 'number')
      && typeof row.createdAt === 'string');
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

function formatDuration(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

function formatVital(name: CoreWebVital['name'], value: number | null) {
  if (value === null) return '—';
  return name === 'cls' ? value.toFixed(3) : formatDuration(value);
}

export function SystemOwnerPerformancePage() {
  const { user } = useAuth();
  const [windowDays, setWindowDays] = useState<7 | 30 | 90>(7);
  const [dashboard, setDashboard] = useState<PerformanceDashboard | null>(null);
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
        body: { action: 'performance-dashboard', windowDays },
      });
      if (requestError) throw requestError;
      if (!isPerformanceDashboard(data?.performanceDashboard)) {
        throw new Error('The system owner service returned invalid performance data.');
      }
      setDashboard(data.performanceDashboard);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load performance data.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user, windowDays]);

  useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  return <main className="system-owner-page">
    <header className="system-owner-header">
      <div>
        <span className="eyebrow">Operations · browser performance</span>
        <h1>Performance monitoring</h1>
        <p>Recorded page render, Supabase request, and database query timings across signed-in school workspaces.</p>
      </div>
      <div className="system-owner-header-actions">
        <label className="system-owner-error-window">
          <span className="sr-only">Time range</span>
          <select value={windowDays} onChange={(event) => setWindowDays(Number(event.target.value) as 7 | 30 | 90)} aria-label="Performance time range">
            <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
          </select>
        </label>
        <button className="button button-secondary" type="button" onClick={() => void loadDashboard(true)} disabled={loading || refreshing}>
          <RefreshCw size={15} className={refreshing ? 'spin' : undefined} /> Refresh
        </button>
      </div>
    </header>

    {error && <ErrorState message={error} />}
    {!dashboard && loading && <LoadingState label="Loading performance samples…" />}
    {dashboard && <>
      <section className="system-owner-stat-grid" aria-label="Platform performance overview">
        <article className="system-owner-stat"><span><Activity size={17} /></span><small>Recorded samples</small><strong>{dashboard.totalSamples.toLocaleString()}</strong><p>In the last {dashboard.windowDays} days</p></article>
        {(['page', 'request', 'database'] as const).map((type) => {
          const Icon = eventIcons[type];
          const summary = dashboard.summary.find((item) => item.eventType === type);
          return <article className="system-owner-stat" key={type}>
            <span><Icon size={17} /></span><small>{eventLabels[type]} · p95</small>
            <strong>{summary ? formatDuration(summary.p95Ms) : '—'}</strong>
            <p>{summary?.sampleCount.toLocaleString() ?? 0} samples · {summary?.failureCount.toLocaleString() ?? 0} failed requests</p>
          </article>;
        })}
      </section>

      <section className="content-card system-owner-panel">
        <div className="system-owner-panel-heading"><div><span className="eyebrow">Core Web Vitals</span><h2>Real-user experience · p75</h2>
          <p>Largest Contentful Paint, Interaction to Next Paint, and Cumulative Layout Shift captured by the existing browser monitor.</p>
        </div><Activity size={17} /></div>
        <div className="system-owner-performance-vitals">
          {(['lcp', 'inp', 'cls'] as const).map((name) => {
            const vital = dashboard.coreWebVitals.find((item) => item.name === name);
            return <article key={name}><small>{name.toUpperCase()}</small><strong>{formatVital(name, vital?.p75 ?? null)}</strong><span>{vital?.sampleCount.toLocaleString() ?? 0} samples</span></article>;
          })}
        </div>
      </section>

      <section className="content-card system-owner-panel">
        <div className="system-owner-panel-heading"><div><span className="eyebrow">Grouped by endpoint and page</span><h2>Slowest performance groups</h2>
          <p>Percentiles use browser-observed request round trips and client-side route render samples. Database times are end-to-end REST/RPC timings, not internal PostgreSQL execution time.</p>
        </div><Clock3 size={17} /></div>
        {dashboard.groups.length ? <div className="system-owner-error-table-wrap">
          <table className="system-owner-error-table">
            <thead><tr><th>Type</th><th>Endpoint / route</th><th>Samples</th><th>Failures</th><th>p50</th><th>p75</th><th>p95</th><th>Max</th></tr></thead>
            <tbody>{dashboard.groups.map((group) => <tr key={`${group.eventType}:${group.label}:${group.route}`}>
              <td>{eventLabels[group.eventType]}</td><td><code>{group.label}</code><small>{group.route}</small></td>
              <td>{group.sampleCount.toLocaleString()}</td><td>{group.failureCount.toLocaleString()}</td>
              <td>{formatDuration(group.p50Ms)}</td><td>{formatDuration(group.p75Ms)}</td><td><strong>{formatDuration(group.p95Ms)}</strong></td><td>{formatDuration(group.maxMs)}</td>
            </tr>)}</tbody>
          </table>
        </div> : <p className="system-owner-muted">No runtime samples have been recorded for this period. New page and request timing samples will appear as signed-in users use the app.</p>}
      </section>

      <section className="content-card system-owner-panel">
        <div className="system-owner-panel-heading"><div><span className="eyebrow">Highest duration first</span><h2>Slow events</h2></div><AlertTriangle size={17} /></div>
        {dashboard.slowEvents.length ? <div className="system-owner-error-table-wrap">
          <table className="system-owner-error-table">
            <thead><tr><th>Type</th><th>Endpoint / route</th><th>Duration</th><th>HTTP</th><th>Observed</th></tr></thead>
            <tbody>{dashboard.slowEvents.map((event, index) => <tr key={`${event.createdAt}:${event.label}:${index}`}>
              <td>{eventLabels[event.eventType]}</td><td><code>{event.label}</code><small>{event.route}</small></td>
              <td><strong>{formatDuration(event.durationMs)}</strong></td><td>{event.statusCode ?? '—'}</td><td>{formatDate(event.createdAt)}</td>
            </tr>)}</tbody>
          </table>
        </div> : <p className="system-owner-muted">No slow events were observed in this period.</p>}
      </section>
      <p className="system-owner-muted">Only normalized page paths, API endpoint/table names, timings, status codes, and school scope are stored. URLs, query strings, request/response bodies, and student records are not collected. Browser timing samples begin after this telemetry update is deployed and are capped at 40 API observations per user session.</p>
    </>}
  </main>;
}
