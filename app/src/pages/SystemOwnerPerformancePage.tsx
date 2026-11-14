import { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, Clock3, Database, Download, RefreshCw, Server, Stethoscope } from 'lucide-react';
import { jsPDF } from 'jspdf';
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
type ConnectionCheck = {
  category: 'Page' | 'API' | 'Table' | 'RPC' | 'Edge Function';
  name: string;
  status: 'pass' | 'fail' | 'warning';
  detail: string;
  statusCode: number | null;
  durationMs: number;
};

const appPages = [
  '/', '/login', '/mobile/install', '/verify/document/test-token', '/book/test/test',
  '/school/test/library/test', '/school/test', '/system-owner', '/system-owner/schools',
  '/system-owner/settings', '/system-owner/maintenance', '/system-owner/errors',
  '/system-owner/errors/incidents', '/system-owner/performance', '/system-owner/api-health',
  '/system-owner/releases', '/system-owner/accessibility', '/system-owner/support',
  '/account-security', '/permissions', '/setup-health', '/academic-planning', '/support',
  '/dashboard', '/behaviour/report/00000000-0000-4000-8000-000000000000', '/behaviour/my',
  '/students', '/guardian-contact-verification', '/parent-access', '/admissions',
  '/admissions/scheduling', '/teachers', '/staff', '/website-management', '/admin-workflows',
  '/automations', '/classes', '/subjects', '/timetable', '/academic-calendar', '/attendance',
  '/learning', '/curriculum-intelligence', '/past-paper-pipeline', '/courses-lessons',
  '/learning-materials', '/library', '/health', '/health/report/00000000-0000-4000-8000-000000000000',
  '/behaviour', '/visitors', '/visitors/verify/00000000-0000-4000-8000-000000000000',
  '/assignments', '/prerequisite-demo', '/draft-recovery-demo', '/grades-results',
  '/calendar', '/settings', '/finance', '/accounting-staff', '/messaging',
  '/family-communications', '/school-data', '/audit-log',
];

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

function isConnectionChecks(value: unknown): value is ConnectionCheck[] {
  return Array.isArray(value) && value.every((check) => isRecord(check)
    && ['Page', 'API', 'Table', 'RPC', 'Edge Function'].includes(String(check.category))
    && typeof check.name === 'string'
    && ['pass', 'fail', 'warning'].includes(String(check.status))
    && typeof check.detail === 'string'
    && (check.statusCode === null || typeof check.statusCode === 'number')
    && typeof check.durationMs === 'number');
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

async function checkAppPages(): Promise<ConnectionCheck[]> {
  const results = await Promise.all(appPages.map(async (path): Promise<ConnectionCheck> => {
    const started = Date.now();
    try {
      const response = await fetch(path, { method: 'GET', credentials: 'same-origin', redirect: 'follow' });
      const contentType = response.headers.get('content-type') ?? '';
      await response.body?.cancel().catch(() => undefined);
      const ok = response.ok && contentType.includes('text/html');
      return {
        category: 'Page', name: path, status: ok ? 'pass' : 'fail',
        detail: ok ? 'Application route shell served; page-specific rendering and role permissions are not simulated.' : 'Route did not return the application HTML shell.',
        statusCode: response.status, durationMs: Date.now() - started,
      };
    } catch {
      return {
        category: 'Page', name: path, status: 'fail',
        detail: 'Route request failed.', statusCode: null, durationMs: Date.now() - started,
      };
    }
  }));
  return results;
}

function downloadConnectionReport(checks: ConnectionCheck[]) {
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const margin = 16;
  const counts = {
    pass: checks.filter((check) => check.status === 'pass').length,
    fail: checks.filter((check) => check.status === 'fail').length,
    warning: checks.filter((check) => check.status === 'warning').length,
  };
  let y = 55;
  const addHeader = (continuation = false) => {
    pdf.setFillColor(24, 60, 50);
    pdf.rect(0, 0, pageWidth, 43, 'F');
    pdf.setTextColor(222, 239, 228);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.text('CAMPUS CONNECT  /  PLATFORM OPERATIONS', margin, 13);
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(19);
    pdf.text(continuation ? 'Connection test · continued' : 'System connection report', margin, 25);
    pdf.setTextColor(225, 238, 230);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.text(`Generated ${new Date().toLocaleString()}`, margin, 35);
  };
  const footer = () => {
    const pages = pdf.getNumberOfPages();
    for (let index = 1; index <= pages; index += 1) {
      pdf.setPage(index);
      pdf.setDrawColor(224, 231, 227);
      pdf.line(margin, 282, pageWidth - margin, 282);
      pdf.setTextColor(103, 119, 110);
      pdf.setFontSize(8);
      pdf.text('Operational diagnostics · No table rows or private records included', margin, 288);
      pdf.text(`${index} / ${pages}`, pageWidth - margin, 288, { align: 'right' });
    }
  };
  addHeader();
  pdf.setTextColor(38, 51, 45);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.text('Overall result', margin, y);
  y += 9;
  pdf.setFontSize(10);
  pdf.setTextColor(counts.fail ? 164 : 32, counts.fail ? 69 : 116, counts.fail ? 73 : 87);
  pdf.text(`${counts.pass} passed   ${counts.fail} failed   ${counts.warning} warnings`, margin, y);
  y += 10;

  const categories = [...new Set(checks.map((check) => check.category))];
  for (const category of categories) {
    if (y > 266) { pdf.addPage(); addHeader(true); y = 55; }
    pdf.setFillColor(239, 244, 240);
    pdf.roundedRect(margin, y - 5, pageWidth - margin * 2, 9, 2, 2, 'F');
    pdf.setTextColor(24, 60, 50);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.text(category, margin + 3, y + 1);
    y += 9;
    for (const check of checks.filter((item) => item.category === category)) {
      const detailLines = pdf.splitTextToSize(`${check.status.toUpperCase()} · ${check.detail}`, pageWidth - margin * 2 - 8) as string[];
      const entryHeight = 5 + detailLines.length * 4;
      if (y + entryHeight > 275) { pdf.addPage(); addHeader(true); y = 55; }
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(8);
      pdf.setTextColor(42, 52, 47);
      pdf.text(pdf.splitTextToSize(check.name, pageWidth - margin * 2 - 8) as string[], margin + 3, y);
      y += 4;
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(7.5);
      pdf.setTextColor(check.status === 'fail' ? 164 : 103, check.status === 'fail' ? 69 : 119, check.status === 'fail' ? 73 : 110);
      pdf.text(detailLines, margin + 3, y);
      const metadata = `${check.statusCode === null ? 'No HTTP status' : `HTTP ${check.statusCode}`}  ·  ${check.durationMs} ms`;
      pdf.setTextColor(103, 119, 110);
      pdf.text(metadata, pageWidth - margin - 3, y, { align: 'right' });
      y += detailLines.length * 4 + 3;
    }
    y += 3;
  }
  pdf.addPage();
  addHeader(true);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.setTextColor(24, 60, 50);
  pdf.text('Scope and interpretation', margin, 58);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(55, 66, 60);
  const notes = [
    'Table checks use the privileged owner service connection and request zero rows. No record data is returned or placed in this report; row-level policies for school users are not tested.',
    'RPCs are inventoried from the live REST schema but never invoked because some may change data.',
    'Edge Function checks send OPTIONS preflight requests only; they verify gateway reachability, not each function action or its secrets.',
    'Page checks confirm the application shell serves each listed route. They do not impersonate users or verify page-specific rendering for every role.',
    'Owner authorization is enforced by the system-owner-admin service; the checks do not change school policies or impersonate school users.',
  ];
  let noteY = 68;
  for (const note of notes) {
    const lines = pdf.splitTextToSize(`• ${note}`, pageWidth - margin * 2) as string[];
    pdf.text(lines, margin, noteY);
    noteY += lines.length * 5 + 5;
  }
  footer();
  pdf.save(`campus-connect-connection-report-${new Date().toISOString().slice(0, 10)}.pdf`);
}

export function SystemOwnerPerformancePage() {
  const { user } = useAuth();
  const [windowDays, setWindowDays] = useState<7 | 30 | 90>(7);
  const [dashboard, setDashboard] = useState<PerformanceDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [testingConnections, setTestingConnections] = useState(false);
  const [connectionChecks, setConnectionChecks] = useState<ConnectionCheck[] | null>(null);

  const runConnectionTest = useCallback(async () => {
    if (!user || testingConnections) return;
    setTestingConnections(true);
    setError('');
    setConnectionChecks(null);
    try {
      const { data, error: requestError } = await requireSupabase().functions.invoke('system-owner-admin', {
        body: { action: 'connection-test' },
      });
      if (requestError) throw requestError;
      if (!isConnectionChecks(data?.checks)) throw new Error('The system owner service returned invalid connection-test results.');
      const serverChecks = data.checks;
      setConnectionChecks([...await checkAppPages(), ...serverChecks]);
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : 'Could not complete the system connection test.');
    } finally {
      setTestingConnections(false);
    }
  }, [testingConnections, user]);

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
        <button className="button button-primary" type="button" onClick={() => void runConnectionTest()} disabled={testingConnections}>
          <Stethoscope size={15} className={testingConnections ? 'spin' : undefined} /> {testingConnections ? 'Testing system…' : 'Test system connection'}
        </button>
        {connectionChecks && <button className="button button-secondary" type="button" onClick={() => downloadConnectionReport(connectionChecks)}>
          <Download size={15} /> Download PDF report
        </button>}
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
    {testingConnections && <section className="content-card system-owner-connection-progress" role="status">
      <Stethoscope size={18} /><div><strong>Checking live system connections</strong><p>Testing routes, REST tables, API schema, and function gateways. No data rows are read and no mutating functions are called.</p></div>
    </section>}
    {connectionChecks && <section className="content-card system-owner-panel system-owner-connection-results" aria-live="polite">
      <div className="system-owner-panel-heading"><div><span className="eyebrow">Live diagnostic</span><h2>Connection test results</h2>
        <p>{connectionChecks.filter((check) => check.status === 'pass').length} passed · {connectionChecks.filter((check) => check.status === 'fail').length} failed · {connectionChecks.filter((check) => check.status === 'warning').length} warnings</p>
      </div><button className="button button-secondary" type="button" onClick={() => downloadConnectionReport(connectionChecks)}><Download size={15} /> PDF report</button></div>
      <p className="system-owner-muted">Checks use the privileged owner connection for zero-row table probes. No record rows are read; role-specific RLS and page behavior are not tested. RPCs are listed only, and Edge Functions receive OPTIONS requests only.</p>
      <div className="system-owner-connection-list">
        {connectionChecks.map((check, index) => <article key={`${check.category}:${check.name}:${index}`}>
          <span className={`system-owner-connection-mark ${check.status}`} aria-label={check.status}>{check.status === 'pass' ? '✓' : check.status === 'fail' ? '!' : 'i'}</span>
          <div><strong>{check.name}</strong><small>{check.category} · {check.detail}</small></div>
          <span className="system-owner-connection-timing">{check.statusCode === null ? '—' : check.statusCode} · {check.durationMs} ms</span>
        </article>)}
      </div>
    </section>}
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
