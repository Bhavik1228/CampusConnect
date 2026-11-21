import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Accessibility, Check, Clock3, Monitor, Plus, RefreshCw, Save } from 'lucide-react';
import { ErrorState, LoadingState } from '../components/Feedback';
import { useAuth } from '../contexts/AuthContext';
import { requireSupabase } from '../lib/supabase';
import { invokeSystemOwnerAction } from '../lib/system-owner-actions';

type TestType = 'accessibility' | 'browser';
type Severity = 'critical' | 'high' | 'medium' | 'low';
type IssueStatus = 'open' | 'in_progress' | 'resolved' | 'wont_fix';
type DeviceType = 'desktop' | 'mobile' | 'tablet' | 'other';
type TestIssue = {
  id: string;
  test_type: TestType;
  title: string;
  severity: Severity;
  status: IssueStatus;
  device_type: DeviceType;
  operating_system: string;
  browser: string;
  browser_version: string;
  assistive_technology: string;
  assistive_technology_version: string;
  wcag_criterion: string;
  steps_to_reproduce: string;
  expected_result: string;
  actual_result: string;
  resolution_notes: string;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
};
type IssueDraft = Omit<TestIssue, 'id' | 'created_by' | 'updated_by' | 'created_at' | 'updated_at'> & { id?: string };

const typeLabels: Record<TestType, string> = { accessibility: 'Accessibility', browser: 'Browser' };
const severityLabels: Record<Severity, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
const statusLabels: Record<IssueStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  wont_fix: 'Won’t fix',
};
const deviceLabels: Record<DeviceType, string> = { desktop: 'Desktop', mobile: 'Mobile', tablet: 'Tablet', other: 'Other' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTestIssue(value: unknown): value is TestIssue {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && (value.test_type === 'accessibility' || value.test_type === 'browser')
    && typeof value.title === 'string'
    && (value.severity === 'critical' || value.severity === 'high' || value.severity === 'medium' || value.severity === 'low')
    && (value.status === 'open' || value.status === 'in_progress' || value.status === 'resolved' || value.status === 'wont_fix')
    && (value.device_type === 'desktop' || value.device_type === 'mobile' || value.device_type === 'tablet' || value.device_type === 'other')
    && ['operating_system', 'browser', 'browser_version', 'assistive_technology', 'assistive_technology_version',
      'wcag_criterion', 'steps_to_reproduce', 'expected_result', 'actual_result', 'resolution_notes',
      'created_by', 'updated_by', 'created_at', 'updated_at'].every((key) => typeof value[key] === 'string');
}

function newIssue(): IssueDraft {
  return {
    test_type: 'accessibility',
    title: '',
    severity: 'medium',
    status: 'open',
    device_type: 'desktop',
    operating_system: '',
    browser: '',
    browser_version: '',
    assistive_technology: '',
    assistive_technology_version: '',
    wcag_criterion: '',
    steps_to_reproduce: '',
    expected_result: '',
    actual_result: '',
    resolution_notes: '',
  };
}

function draftFromIssue(issue: TestIssue): IssueDraft {
  const { id, ...draft } = issue;
  return { ...draft, id };
}

function displayDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString();
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === 'string') {
    return typeof error.code === 'string' ? `${error.message} [${error.code}]` : error.message;
  }
  return fallback;
}

export function SystemOwnerAccessibilityPage() {
  const { user } = useAuth();
  const [issues, setIssues] = useState<TestIssue[]>([]);
  const [draft, setDraft] = useState<IssueDraft | null>(null);
  const [testTypeFilter, setTestTypeFilter] = useState<'all' | TestType>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | IssueStatus>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadIssues = useCallback(async (background = false) => {
    if (!user) return;
    if (background) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const { data, error: requestError } = await requireSupabase().functions.invoke('system-owner-admin', {
        body: { action: 'accessibility-test-issues' },
      });
      if (requestError) throw requestError;
      if (!Array.isArray(data?.issues) || !data.issues.every(isTestIssue)) {
        throw new Error('The system owner service returned invalid accessibility test records.');
      }
      setIssues(data.issues);
    } catch (loadError) {
      setError(errorMessage(loadError, 'Could not load accessibility and browser test issues.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user]);

  useEffect(() => { void loadIssues(); }, [loadIssues]);

  const filteredIssues = useMemo(() => issues.filter((issue) =>
    (testTypeFilter === 'all' || issue.test_type === testTypeFilter)
    && (statusFilter === 'all' || issue.status === statusFilter)), [issues, statusFilter, testTypeFilter]);
  const openCount = issues.filter((issue) => issue.status === 'open' || issue.status === 'in_progress').length;
  const accessibilityCount = issues.filter((issue) => issue.test_type === 'accessibility').length;
  const browserCount = issues.filter((issue) => issue.test_type === 'browser').length;

  function updateDraft<K extends keyof IssueDraft>(key: K, value: IssueDraft[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  }

  async function saveIssue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { data, error: saveError } = await invokeSystemOwnerAction({
        body: {
          action: 'save-accessibility-test-issue',
          testIssueId: draft.id,
          testType: draft.test_type,
          title: draft.title,
          severity: draft.severity,
          status: draft.status,
          deviceType: draft.device_type,
          operatingSystem: draft.operating_system,
          browser: draft.browser,
          browserVersion: draft.browser_version,
          assistiveTechnology: draft.assistive_technology,
          assistiveTechnologyVersion: draft.assistive_technology_version,
          wcagCriterion: draft.wcag_criterion,
          stepsToReproduce: draft.steps_to_reproduce,
          expectedResult: draft.expected_result,
          actualResult: draft.actual_result,
          resolutionNotes: draft.resolution_notes,
        },
      });
      if (saveError) throw saveError;
      if (!isTestIssue(data?.issue)) throw new Error('The system owner service returned an invalid test issue.');
      setIssues((current) => [data.issue, ...current.filter((issue) => issue.id !== data.issue.id)]
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at)));
      setDraft(null);
      setNotice('Test issue saved.');
    } catch (saveError) {
      setError(errorMessage(saveError, 'Could not save this test issue.'));
    } finally {
      setSaving(false);
    }
  }

  return <main className="system-owner-page">
    <header className="system-owner-header">
      <div>
        <span className="eyebrow">Quality · inclusive access</span>
        <h1>Accessibility and browser tests</h1>
        <p>Record reproducible issues with the device, browser, and assistive technology used to find them.</p>
      </div>
      <div className="system-owner-header-actions">
        <button className="button button-quiet" type="button" onClick={() => void loadIssues(true)} disabled={loading || refreshing}>
          <RefreshCw size={15} className={refreshing ? 'system-owner-spinning' : undefined} /> Refresh
        </button>
        {!draft && <button className="button button-primary" type="button" onClick={() => { setError(''); setDraft(newIssue()); }}>
          <Plus size={15} /> Record an issue
        </button>}
      </div>
    </header>

    {error && <ErrorState message={error} />}
    {notice && <p className="system-owner-release-notice" role="status">{notice}</p>}

    <section className="system-owner-accessibility-summary" aria-label="Test issue summary">
      <article><span><Accessibility size={17} /></span><div><strong>{accessibilityCount}</strong><small>Accessibility issues</small></div></article>
      <article><span><Monitor size={17} /></span><div><strong>{browserCount}</strong><small>Browser issues</small></div></article>
      <article><span><Clock3 size={17} /></span><div><strong>{openCount}</strong><small>Open or in progress</small></div></article>
    </section>

    {draft && <form className="content-card system-owner-panel system-owner-test-form" onSubmit={(event) => void saveIssue(event)}>
      <div className="system-owner-panel-heading">
        <div><span className="eyebrow">{draft.id ? 'Update record' : 'New record'}</span><h2>{draft.id ? 'Edit a test issue' : 'Record a test issue'}</h2></div>
        <Accessibility size={18} />
      </div>
      <div className="system-owner-test-grid">
        <label className="field"><span>Test area</span><select value={draft.test_type} onChange={(event) => updateDraft('test_type', event.target.value as TestType)}>{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="field"><span>Severity</span><select value={draft.severity} onChange={(event) => updateDraft('severity', event.target.value as Severity)}>{Object.entries(severityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="field system-owner-test-wide"><span>Issue title</span><input value={draft.title} maxLength={180} minLength={3} required onChange={(event) => updateDraft('title', event.target.value)} placeholder="Describe the barrier or browser-specific problem" /></label>
        <label className="field"><span>Status</span><select value={draft.status} onChange={(event) => updateDraft('status', event.target.value as IssueStatus)}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="field"><span>Device</span><select value={draft.device_type} onChange={(event) => updateDraft('device_type', event.target.value as DeviceType)}>{Object.entries(deviceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="field"><span>Operating system and version</span><input value={draft.operating_system} maxLength={120} required onChange={(event) => updateDraft('operating_system', event.target.value)} placeholder="e.g. Windows 11, iOS 18" /></label>
        <label className="field"><span>Browser</span><input value={draft.browser} maxLength={120} onChange={(event) => updateDraft('browser', event.target.value)} placeholder="e.g. Firefox" /></label>
        <label className="field"><span>Browser version</span><input value={draft.browser_version} maxLength={80} onChange={(event) => updateDraft('browser_version', event.target.value)} /></label>
        <label className="field"><span>Assistive technology</span><input value={draft.assistive_technology} maxLength={160} onChange={(event) => updateDraft('assistive_technology', event.target.value)} placeholder="e.g. NVDA, VoiceOver, keyboard only" /></label>
        <label className="field"><span>Assistive technology version</span><input value={draft.assistive_technology_version} maxLength={80} onChange={(event) => updateDraft('assistive_technology_version', event.target.value)} /></label>
        <label className="field"><span>WCAG criterion (optional)</span><input value={draft.wcag_criterion} maxLength={80} onChange={(event) => updateDraft('wcag_criterion', event.target.value)} placeholder="e.g. 2.4.7 Focus Visible" /></label>
        <label className="field system-owner-test-wide"><span>Steps to reproduce</span><textarea value={draft.steps_to_reproduce} minLength={3} maxLength={4000} rows={3} required onChange={(event) => updateDraft('steps_to_reproduce', event.target.value)} /></label>
        <label className="field"><span>Expected result</span><textarea value={draft.expected_result} maxLength={2000} rows={3} onChange={(event) => updateDraft('expected_result', event.target.value)} /></label>
        <label className="field"><span>Actual result</span><textarea value={draft.actual_result} minLength={3} maxLength={2000} rows={3} required onChange={(event) => updateDraft('actual_result', event.target.value)} /></label>
        <label className="field system-owner-test-wide"><span>Resolution notes{draft.status === 'resolved' ? ' (required)' : ''}</span><textarea value={draft.resolution_notes} minLength={draft.status === 'resolved' ? 3 : undefined} maxLength={2000} rows={2} required={draft.status === 'resolved'} onChange={(event) => updateDraft('resolution_notes', event.target.value)} /></label>
      </div>
      <p className="system-owner-muted">Enter a browser or assistive technology so the environment can be reproduced.</p>
      <div className="system-owner-incident-actions">
        <button className="button button-quiet" type="button" onClick={() => setDraft(null)} disabled={saving}>Cancel</button>
        <button className="button button-primary" type="submit" disabled={saving}><Save size={14} />{saving ? 'Saving…' : 'Save issue'}</button>
      </div>
    </form>}

    <section className="content-card system-owner-panel">
      <div className="system-owner-accessibility-filters">
        <div><span className="eyebrow">Issue register</span><h2>Recorded test issues</h2><p>{issues.length} records · up to 500 most recently updated</p></div>
        <div className="system-owner-accessibility-filter-controls">
          <label><span>Test area</span><select value={testTypeFilter} onChange={(event) => setTestTypeFilter(event.target.value as 'all' | TestType)}><option value="all">All areas</option>{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as 'all' | IssueStatus)}><option value="all">All statuses</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        </div>
      </div>
      {loading ? <LoadingState label="Loading accessibility and browser test issues…" /> : filteredIssues.length
        ? <div className="system-owner-test-list">{filteredIssues.map((issue) => <article className="system-owner-test-issue" key={issue.id}>
          <div className="system-owner-test-issue-heading">
            <div><span className={`system-owner-test-badge ${issue.test_type}`}>{typeLabels[issue.test_type]}</span><span className={`system-owner-test-severity ${issue.severity}`}>{severityLabels[issue.severity]}</span><h3>{issue.title}</h3></div>
            <button className="button button-quiet" type="button" onClick={() => { setError(''); setDraft(draftFromIssue(issue)); }}><Save size={14} /> Edit</button>
          </div>
          <div className="system-owner-test-environment">
            <span><Monitor size={14} />{deviceLabels[issue.device_type]} · {issue.operating_system}</span>
            {issue.browser && <span>{issue.browser}{issue.browser_version ? ` ${issue.browser_version}` : ''}</span>}
            {issue.assistive_technology && <span><Accessibility size={14} />{issue.assistive_technology}{issue.assistive_technology_version ? ` ${issue.assistive_technology_version}` : ''}</span>}
            {issue.wcag_criterion && <span>WCAG {issue.wcag_criterion}</span>}
            <span className={`system-owner-test-status ${issue.status}`}>{statusLabels[issue.status]}</span>
          </div>
          <div className="system-owner-test-details">
            <section><h4>Steps to reproduce</h4><p>{issue.steps_to_reproduce}</p></section>
            <section><h4>Expected</h4><p>{issue.expected_result || 'Not recorded'}</p></section>
            <section><h4>Actual</h4><p>{issue.actual_result}</p></section>
            {issue.resolution_notes && <section><h4>Resolution notes</h4><p>{issue.resolution_notes}</p></section>}
          </div>
          <p className="system-owner-test-updated"><Check size={13} /> Updated {displayDate(issue.updated_at)}</p>
        </article>)}</div>
        : <div className="system-owner-test-empty"><Accessibility size={22} /><strong>{issues.length ? 'No matching test issues' : 'No test issues recorded yet'}</strong><span>{issues.length ? 'Change the filters to see other records.' : 'Record a reproducible browser or accessibility issue to begin the tracker.'}</span></div>}
    </section>
  </main>;
}
