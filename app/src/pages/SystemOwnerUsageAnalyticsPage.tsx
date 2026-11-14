import { useCallback, useEffect, useMemo, useState } from 'react';
import { jsPDF } from 'jspdf';
import { Activity, Download, RefreshCw, UsersRound } from 'lucide-react';
import { ErrorState, LoadingState } from '../components/Feedback';
import { useAuth } from '../contexts/AuthContext';
import { requireSupabase } from '../lib/supabase';

type UsageTotals = {
  events: number;
  pageRenders: number;
  apiSamples: number;
  databaseSamples: number;
  activeUsers: number;
  activeSessions: number;
  lastActivity: string | null;
};

type ModuleUsage = {
  name: string;
  pageRenders: number;
  activeUsers: number;
  schoolsUsing: number;
  reportingSchools: number;
  previousPageRenders: number | null;
  lastUsed: string | null;
};

type DailyUsage = {
  date: string;
  pageRenders: number;
  apiSamples: number;
  databaseSamples: number;
  activeUsers: number;
  activeSessions: number;
  activeSchools: number;
};

type ServiceUsage = {
  type: string;
  name: string;
  samples: number;
  failures: number;
  unknownStatus: number;
  p95Ms: number | null;
  lastUsed: string | null;
};

type SchoolUsage = {
  schoolId: string;
  schoolName: string;
  hasTelemetry: boolean;
  events: number;
  pageRenders: number;
  apiSamples: number;
  databaseSamples: number;
  activeUsers: number;
  activeSessions: number;
  modulesUsed: number;
  lastActivity: string | null;
};

type SchoolOption = { schoolId: string; schoolName: string };

type UsageAnalytics = {
  fromDate: string;
  throughDate: string;
  selectedSchoolId: string | null;
  registeredSchools: number;
  reportingSchools: number;
  coveragePercent: number | null;
  comparisonAvailable: boolean;
  totals: UsageTotals;
  previousTotals: { events: number | null; activeUsers: number | null };
  daily: DailyUsage[];
  modules: ModuleUsage[];
  services: ServiceUsage[];
  schoolOptions: SchoolOption[];
  schools: SchoolUsage[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || isNumber(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isUsageAnalytics(value: unknown): value is UsageAnalytics {
  if (!isRecord(value) || !isRecord(value.totals) || !isRecord(value.previousTotals)
    || !Array.isArray(value.daily) || !Array.isArray(value.modules)
    || !Array.isArray(value.services) || !Array.isArray(value.schoolOptions)
    || !Array.isArray(value.schools)) return false;
  const totals = value.totals;
  const previousTotals = value.previousTotals;
  const schoolOptions = value.schoolOptions;
  return typeof value.fromDate === 'string'
    && typeof value.throughDate === 'string'
    && (value.selectedSchoolId === null || typeof value.selectedSchoolId === 'string')
    && isNumber(value.registeredSchools)
    && isNumber(value.reportingSchools)
    && (value.coveragePercent === null || isNumber(value.coveragePercent))
    && typeof value.comparisonAvailable === 'boolean'
    && ['events', 'pageRenders', 'apiSamples', 'databaseSamples', 'activeUsers', 'activeSessions'].every((key) => isNumber(totals[key]))
    && isStringOrNull(totals.lastActivity)
    && ['events', 'activeUsers'].every((key) => isNumberOrNull(previousTotals[key]))
    && value.daily.every((row) => isRecord(row) && typeof row.date === 'string'
      && ['pageRenders', 'apiSamples', 'databaseSamples', 'activeUsers', 'activeSessions', 'activeSchools'].every((key) => isNumber(row[key])))
    && value.modules.every((row) => isRecord(row) && typeof row.name === 'string'
      && ['pageRenders', 'activeUsers', 'schoolsUsing', 'reportingSchools'].every((key) => isNumber(row[key]))
      && isNumberOrNull(row.previousPageRenders) && isStringOrNull(row.lastUsed))
    && value.services.every((row) => isRecord(row) && typeof row.name === 'string' && typeof row.type === 'string'
      && ['samples', 'failures', 'unknownStatus'].every((key) => isNumber(row[key]))
      && isNumberOrNull(row.p95Ms) && isStringOrNull(row.lastUsed))
    && schoolOptions.every((row: unknown) => isRecord(row) && typeof row.schoolId === 'string' && typeof row.schoolName === 'string')
    && value.schools.every((row) => isRecord(row) && typeof row.schoolId === 'string'
      && typeof row.schoolName === 'string' && typeof row.hasTelemetry === 'boolean'
      && ['events', 'pageRenders', 'apiSamples', 'databaseSamples', 'activeUsers', 'activeSessions', 'modulesUsed'].every((key) => isNumber(row[key]))
      && isStringOrNull(row.lastActivity));
}

function getDefaultDates() {
  const throughDate = new Date().toISOString().slice(0, 10);
  const start = new Date(`${throughDate}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - 29);
  return { fromDate: start.toISOString().slice(0, 10), throughDate };
}

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value);
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString() : 'No observation';
}

function formatPercentChange(current: number, previous: number | null) {
  if (previous === null) return 'Comparison unavailable';
  if (previous === 0) return current === 0 ? 'No change' : 'New in period';
  const change = ((current - previous) / previous) * 100;
  return `${change > 0 ? '+' : ''}${change.toFixed(1)}%`;
}

function csvCell(value: string | number) {
  const safeValue = String(value).replace(/^[\s]*([=+\-@])/, '\'$1');
  return `"${safeValue.replace(/"/g, '""')}"`;
}

function downloadCsv(analytics: UsageAnalytics) {
  const lines = [
    ['Report date range', analytics.fromDate, analytics.throughDate].map(csvCell).join(','),
    ['Telemetry coverage', analytics.reportingSchools, 'of', analytics.registeredSchools, 'schools'].map(csvCell).join(','),
    ['Section', 'Name', 'Observed page renders', 'Active users', 'Schools using', 'Reporting schools', 'Additional detail'].map(csvCell).join(','),
    ...analytics.modules.map((row) => [
      'Module', row.name, row.pageRenders, row.activeUsers, row.schoolsUsing, row.reportingSchools,
      row.reportingSchools === 0 ? 'No page telemetry observed' : row.previousPageRenders === null ? 'Comparison unavailable' : `Previous period renders: ${row.previousPageRenders}`,
    ].map(csvCell).join(',')),
    ...analytics.daily.map((row) => [
      'Daily', row.date, row.pageRenders, row.activeUsers, row.activeSchools, '', `API samples: ${row.apiSamples}; database samples: ${row.databaseSamples}`,
    ].map(csvCell).join(',')),
    ...analytics.schools.map((row) => [
      'School', row.schoolName, row.hasTelemetry ? row.pageRenders : 'No telemetry', row.hasTelemetry ? row.activeUsers : 'No telemetry',
      row.pageRenders ? row.modulesUsed : 'No page telemetry', '',
      row.hasTelemetry ? `Last observed: ${row.lastActivity ?? 'unknown'}` : 'No telemetry observed in selected period',
    ].map(csvCell).join(',')),
    ...analytics.services.map((row) => [
      row.type, row.name, row.samples, '', '', '', `Failures: ${row.failures}; p95: ${row.p95Ms === null ? 'unknown' : `${row.p95Ms} ms`}`,
    ].map(csvCell).join(',')),
  ];
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `campus-connect-usage-${analytics.fromDate}-to-${analytics.throughDate}.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadPdf(analytics: UsageAnalytics) {
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const margin = 44;
  let y = 52;
  const addPageIfNeeded = (height = 20) => {
    if (y + height > pdf.internal.pageSize.getHeight() - 44) {
      pdf.addPage();
      y = 48;
    }
  };
  const heading = (text: string) => {
    addPageIfNeeded(34);
    pdf.setTextColor(33, 45, 70);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(14);
    pdf.text(text, margin, y);
    y += 22;
  };
  const row = (text: string) => {
    const lines = pdf.splitTextToSize(text.slice(0, 220), pageWidth - margin * 2) as string[];
    addPageIfNeeded(lines.length * 12 + 4);
    pdf.setTextColor(74, 84, 105);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.text(lines, margin, y);
    y += lines.length * 12;
  };

  pdf.setFillColor(33, 45, 70);
  pdf.rect(0, 0, pageWidth, 110, 'F');
  pdf.setTextColor(255, 255, 255);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(21);
  pdf.text('Platform usage report', margin, 48);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10);
  const schoolName = analytics.selectedSchoolId
    ? analytics.schoolOptions.find((school) => school.schoolId === analytics.selectedSchoolId)?.schoolName ?? 'Selected school'
    : 'Platform-wide';
  pdf.text(`${analytics.fromDate} to ${analytics.throughDate} | ${schoolName}`, margin, 70);
  pdf.text(`Generated ${new Date().toLocaleString()}`, margin, 88);
  y = 136;

  heading('Observed platform activity');
  row(`Active users (aggregated): ${formatNumber(analytics.totals.activeUsers)} | Active sessions: ${formatNumber(analytics.totals.activeSessions)}`);
  row(`Route-render samples: ${formatNumber(analytics.totals.pageRenders)} | API samples: ${formatNumber(analytics.totals.apiSamples)} | Database samples: ${formatNumber(analytics.totals.databaseSamples)}`);
  row(`Telemetry coverage: ${analytics.reportingSchools} of ${analytics.registeredSchools} schools${analytics.coveragePercent === null ? '' : ` (${analytics.coveragePercent}%)`}`);
  row('Counts are observed telemetry samples, not complete page views or proof of task completion. No student records or individual user identities are included.');
  row('Equal-length period comparisons are omitted whenever the previous period falls outside the 90-day telemetry retention window.');

  heading('Module usage');
  analytics.modules.forEach((module) => row(`${module.name}: ${module.reportingSchools === 0 ? 'No page telemetry observed' : `${formatNumber(module.pageRenders)} route renders | ${formatNumber(module.activeUsers)} active users | ${module.schoolsUsing}/${module.reportingSchools} reporting schools`}`));

  heading('Daily activity');
  analytics.daily.forEach((day) => row(`${day.date}: ${day.pageRenders} route renders | ${day.activeUsers} active users | ${day.apiSamples} API samples | ${day.databaseSamples} database samples`));
  if (!analytics.daily.length) row('No daily telemetry was observed in this period.');

  heading('School-level aggregates');
  analytics.schools.forEach((school) => row(`${school.schoolName}: ${school.hasTelemetry ? `${formatNumber(school.pageRenders)} route renders | ${formatNumber(school.activeUsers)} active users | ${school.modulesUsed} modules` : 'No telemetry observed'}`));

  heading('API and database service samples');
  analytics.services.forEach((service) => row(`${service.type} | ${service.name}: ${formatNumber(service.samples)} samples | ${service.failures} observed failures | p95 ${service.p95Ms === null ? 'unknown' : `${service.p95Ms} ms`}`));
  if (!analytics.services.length) row('No API or database service telemetry was observed in this period.');

  pdf.save(`campus-connect-usage-${analytics.fromDate}-to-${analytics.throughDate}.pdf`);
}

function UsageTrend({ rows }: { rows: DailyUsage[] }) {
  const maxViews = Math.max(1, ...rows.map((row) => row.pageRenders));
  const maxUsers = Math.max(1, ...rows.map((row) => row.activeUsers));
  const firstDay = rows.length ? new Date(`${rows[0].date}T00:00:00Z`).getTime() : 0;
  const lastDay = rows.length ? new Date(`${rows[rows.length - 1].date}T00:00:00Z`).getTime() : firstDay;
  const daySpan = Math.max(1, (lastDay - firstDay) / 86400000 + 1);
  const xForDate = (date: string) => firstDay === lastDay
    ? 20
    : 20 + ((new Date(`${date}T00:00:00Z`).getTime() - firstDay) / (lastDay - firstDay)) * 720;
  const points = rows.map((row, index) => {
    const x = xForDate(row.date);
    const y = 175 - (row.activeUsers / maxUsers) * 145;
    const priorDate = index ? new Date(`${rows[index - 1].date}T00:00:00Z`).getTime() : 0;
    const currentDate = new Date(`${row.date}T00:00:00Z`).getTime();
    const newSegment = index === 0 || currentDate - priorDate > 86400000;
    return { x, y, newSegment, date: row.date, activeUsers: row.activeUsers };
  });
  const path = points.map((point) => `${point.newSegment ? 'M' : 'L'}${point.x},${point.y}`).join(' ');
  return <div className="usage-trend-wrap">
    {rows.length ? <svg className="usage-trend-chart" viewBox="0 0 760 220" role="img" aria-label="Daily observed page renders and active-user trend">
      {[0, 1, 2, 3].map((line) => <line key={line} x1="20" x2="740" y1={30 + line * 48} y2={30 + line * 48} className="usage-chart-grid" />)}
      {rows.map((row) => {
        const x = xForDate(row.date);
        const barHeight = (row.pageRenders / maxViews) * 145;
        return <rect key={row.date} x={x - Math.max(1, Math.min(6, 350 / daySpan))} y={175 - barHeight} width={Math.max(2, Math.min(12, 700 / daySpan))} height={barHeight} rx="2" className="usage-chart-bar">
          <title>{row.date}: {row.pageRenders} route renders, {row.activeUsers} active users</title>
        </rect>;
      })}
      <path d={path} className="usage-chart-users" />
      {points.map((point) => <circle key={`${point.date}-user`} cx={point.x} cy={point.y} r="2.5" className="usage-chart-user-point"><title>{point.date}: {point.activeUsers} active users</title></circle>)}
      {rows.length > 0 && <>
        <text x="20" y="207" className="usage-chart-label">{rows[0].date}</text>
        <text x="740" y="207" textAnchor="end" className="usage-chart-label">{rows[rows.length - 1].date}</text>
      </>}
    </svg> : <p className="usage-empty">No daily telemetry was observed for this date range.</p>}
    <div className="usage-chart-legend"><span><i className="usage-legend-bar" /> Route-render samples</span><span><i className="usage-legend-line" /> Daily active users</span></div>
  </div>;
}

export function SystemOwnerUsageAnalyticsPage() {
  const { user } = useAuth();
  const defaults = useMemo(getDefaultDates, []);
  const [fromDate, setFromDate] = useState(defaults.fromDate);
  const [throughDate, setThroughDate] = useState(defaults.throughDate);
  const [schoolId, setSchoolId] = useState('');
  const [applied, setApplied] = useState(defaults);
  const [analytics, setAnalytics] = useState<UsageAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const earliestDate = new Date(`${throughDate}T00:00:00.000Z`);
  earliestDate.setUTCDate(earliestDate.getUTCDate() - 89);
  const minimumFromDate = earliestDate.toISOString().slice(0, 10);

  const loadAnalytics = useCallback(async (background = false) => {
    if (!user) return;
    if (background) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const { data, error: requestError } = await requireSupabase().functions.invoke('system-owner-admin', {
        body: { action: 'usage-analytics', fromDate: applied.fromDate, throughDate: applied.throughDate, schoolId: schoolId || null },
      });
      if (requestError) throw requestError;
      if (!isUsageAnalytics(data?.usageAnalytics)) throw new Error('The system owner service returned invalid platform usage data.');
      setAnalytics(data.usageAnalytics);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load platform usage analytics.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [applied, schoolId, user]);

  useEffect(() => { void loadAnalytics(); }, [loadAnalytics]);

  const filtersPending = analytics !== null
    && (fromDate !== applied.fromDate
      || throughDate !== applied.throughDate
      || schoolId !== (analytics.selectedSchoolId ?? ''));

  return <main className="system-owner-page system-owner-usage-page">
    <header className="system-owner-header">
      <div>
        <span className="eyebrow">Platform insights · Aggregated telemetry</span>
        <h1>Platform usage analytics</h1>
        <p>See which school modules and services have observed activity, with school-level aggregates and no access to private school records.</p>
      </div>
      <div className="system-owner-header-actions">
        <button className="button button-secondary" type="button" onClick={() => void loadAnalytics(true)} disabled={loading || refreshing}>
          <RefreshCw size={15} className={refreshing ? 'spin' : undefined} /> Refresh
        </button>
        <button className="button button-secondary" type="button" onClick={() => analytics && downloadCsv(analytics)} disabled={!analytics || loading || refreshing || filtersPending}>
          <Download size={15} /> Export CSV
        </button>
        <button className="button button-primary" type="button" onClick={() => analytics && downloadPdf(analytics)} disabled={!analytics || loading || refreshing || filtersPending}>
          <Download size={15} /> Export PDF
        </button>
      </div>
    </header>

    <form className="usage-filter-bar" onSubmit={(event) => {
      event.preventDefault();
      const selectedRangeDays = (Date.parse(`${throughDate}T00:00:00.000Z`) - Date.parse(`${fromDate}T00:00:00.000Z`)) / 86400000;
      if (selectedRangeDays < 0 || selectedRangeDays > 89) {
        setError('Choose a valid date range of up to 90 days.');
        return;
      }
      setError('');
      setApplied({ fromDate, throughDate });
    }}>
      <label><span>From</span><input type="date" value={fromDate} min={minimumFromDate} max={throughDate} onChange={(event) => setFromDate(event.target.value)} required /></label>
      <label><span>Through</span><input type="date" value={throughDate} min={fromDate} max={new Date().toISOString().slice(0, 10)} onChange={(event) => setThroughDate(event.target.value)} required /></label>
      <label className="usage-school-filter"><span>School</span><select value={schoolId} onChange={(event) => setSchoolId(event.target.value)}>
        <option value="">All schools</option>
        {(analytics?.schoolOptions ?? []).map((school) => <option key={school.schoolId} value={school.schoolId}>{school.schoolName}</option>)}
      </select></label>
      <button className="button button-primary" type="submit">Apply filters</button>
    </form>

    {loading && !analytics ? <LoadingState /> : error && !analytics ? <div><ErrorState message={error} /><button className="button button-secondary" type="button" onClick={() => void loadAnalytics()}>Try again</button></div> : analytics ? <>
      {error && <div className="usage-inline-error" role="alert">{error} <button type="button" onClick={() => void loadAnalytics()}>Retry</button></div>}
      <div className="usage-coverage-note">
        <Activity size={18} />
        <span><strong>{analytics.reportingSchools} of {analytics.registeredSchools} schools have observed telemetry{analytics.coveragePercent === null ? '' : ` (${analytics.coveragePercent}%)`}</strong>
          <small>Unreported activity is unknown, not zero. Counts are instrumented route-render and sampled API/database events; they do not prove task completion.</small>
        </span>
      </div>
      <section className="usage-summary-grid" aria-label="Usage summary">
        <article className="usage-summary-card"><span>Active users</span><strong>{formatNumber(analytics.totals.activeUsers)}</strong><small>Distinct signed-in profiles, aggregated</small><em>{formatPercentChange(analytics.totals.activeUsers, analytics.previousTotals.activeUsers)}{analytics.previousTotals.activeUsers === null ? '' : ' vs previous equal-length period'}</em></article>
        <article className="usage-summary-card"><span>Route-render samples</span><strong>{formatNumber(analytics.totals.pageRenders)}</strong><small>Observed page renders, not complete traffic counts</small><em>{formatPercentChange(analytics.totals.events, analytics.previousTotals.events)}{analytics.previousTotals.events === null ? '' : ' overall telemetry vs previous period'}</em></article>
        <article className="usage-summary-card"><span>Observed API samples</span><strong>{formatNumber(analytics.totals.apiSamples)}</strong><small>Sampled Edge Function and Auth requests</small><em>{formatNumber(analytics.totals.databaseSamples)} database / RPC samples</em></article>
        <article className="usage-summary-card"><span>Reporting schools</span><strong>{analytics.reportingSchools}<small> / {analytics.registeredSchools}</small></strong><small>Schools with any usage telemetry in this range</small><em>Last activity: {formatDate(analytics.totals.lastActivity)}</em></article>
      </section>

      <section className="usage-panel">
        <div className="usage-panel-heading"><div><h2>Activity over time</h2><p>Daily route renders and distinct active profiles. Days without telemetry are not inferred.</p></div><UsersRound size={20} /></div>
        <UsageTrend rows={analytics.daily} />
      </section>

      <section className="usage-panel">
        <div className="usage-panel-heading"><div><h2>Module adoption</h2><p>Adoption rate is calculated only among schools with page telemetry in this date range.</p></div></div>
        {!analytics.modules.some((module) => module.reportingSchools > 0) && <p className="usage-empty">No page-render telemetry was observed in the selected scope, so module adoption cannot be estimated.</p>}
        <div className="usage-module-list">{analytics.modules.map((module) => {
          const adoption = module.reportingSchools ? Math.round((module.schoolsUsing / module.reportingSchools) * 100) : null;
          return <article className="usage-module-row" key={module.name}>
            <div className="usage-module-title"><strong>{module.name}</strong><span>{module.reportingSchools ? `${formatNumber(module.pageRenders)} route renders · ${formatNumber(module.activeUsers)} active users` : 'No page telemetry observed'}</span></div>
            <div className="usage-module-track" aria-label={adoption === null ? 'No page telemetry for adoption estimate' : `${adoption}% of reporting schools`}><span style={{ width: `${adoption ?? 0}%` }} /></div>
            <div className="usage-module-meta"><strong>{adoption === null ? '—' : `${adoption}%`}</strong><span>{module.reportingSchools ? `${module.schoolsUsing}/${module.reportingSchools} reporting schools` : 'No reporting schools'}</span><small>{module.reportingSchools ? `${formatPercentChange(module.pageRenders, module.previousPageRenders)}${module.previousPageRenders === null ? '' : ' vs prior period'}` : 'No comparison'}</small></div>
          </article>;
        })}</div>
      </section>

      <section className="usage-panel">
        <div className="usage-panel-heading"><div><h2>School comparison</h2><p>Aggregate activity only. Schools without reported samples are explicitly marked as unknown.</p></div></div>
        <div className="usage-table-wrap"><table className="usage-table">
          <thead><tr><th>School</th><th>Status</th><th>Route renders</th><th>Active users</th><th>Modules used</th><th>Last observed</th></tr></thead>
          <tbody>{analytics.schools.map((school) => <tr key={school.schoolId}>
            <td>{school.schoolName}</td>
            <td><span className={`usage-status ${school.hasTelemetry ? 'is-observed' : 'is-unknown'}`}>{school.hasTelemetry ? 'Observed' : 'No telemetry'}</span></td>
            <td>{school.hasTelemetry ? formatNumber(school.pageRenders) : '—'}</td>
            <td>{school.hasTelemetry ? formatNumber(school.activeUsers) : '—'}</td>
            <td>{school.pageRenders ? `${school.modulesUsed} / ${analytics.modules.length}` : 'No page telemetry'}</td>
            <td>{formatDate(school.lastActivity)}</td>
          </tr>)}</tbody>
        </table></div>
      </section>

      <section className="usage-panel">
        <div className="usage-panel-heading"><div><h2>Service activity</h2><p>Observed API, Edge Function, Auth, database and RPC sample counts; no request payloads are exposed.</p></div></div>
        <div className="usage-table-wrap"><table className="usage-table">
          <thead><tr><th>Service</th><th>Observed samples</th><th>Failures</th><th>p95 duration</th><th>Last observed</th></tr></thead>
          <tbody>{analytics.services.map((service) => <tr key={`${service.type}:${service.name}`}>
            <td><strong>{service.name}</strong><small>{service.type}</small></td>
            <td>{formatNumber(service.samples)}</td><td>{formatNumber(service.failures)}</td>
            <td>{service.p95Ms === null ? 'Unknown' : `${Math.round(service.p95Ms)} ms`}</td><td>{formatDate(service.lastUsed)}</td>
          </tr>)}
          {!analytics.services.length && <tr><td colSpan={5}>No service telemetry was observed in this period.</td></tr>}
          </tbody>
        </table></div>
      </section>
      <p className="usage-report-footnote">These reports use only existing, sampled operational telemetry. Active-user counts are distinct profile totals calculated on the server and never include user IDs. No school records, event payloads, or student identities are queried. Period comparisons are unavailable when prior data falls outside the 90-day retention window.</p>
    </> : null}
  </main>;
}
