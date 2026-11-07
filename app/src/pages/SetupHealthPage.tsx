import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowRight, BookOpenCheck, Check, CircleDollarSign,
  ClipboardCheck, GraduationCap, RefreshCw, ShieldAlert, UsersRound,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/Feedback';
import { useAuth } from '../contexts/AuthContext';
import { requireSupabase } from '../lib/supabase';
import type { AppRole } from '../types/database';

type CheckStatus = 'passed' | 'failed' | 'warning' | 'not_applicable' | 'needs_review';
type HealthCheck = {
  rule_key: string;
  name: string;
  description: string;
  category: string;
  category_label: string;
  workflows: string[];
  severity: 'critical' | 'high' | 'medium' | 'low' | 'informational';
  owner_role: string;
  status: CheckStatus;
  is_applicable: boolean;
  blocks_workflow: boolean;
  fix_route: string | null;
  result_message: string;
  affected_count: number | null;
  checked_at: string;
};
type HealthCategory = {
  key: string;
  label: string;
  score: number | null;
  status: string;
  completed_checks: number;
  total_checks: number;
  failed_checks: number;
  warnings: number;
};
type HealthWorkflow = {
  key: string;
  label: string;
  description: string;
  score: number | null;
  status: string;
  completed_checks: number;
  total_checks: number;
  blockers: number;
  warnings: number;
};
type HealthSnapshot = {
  has_run: boolean;
  run_id: string | null;
  readiness_score: number;
  readiness_status: string;
  completed_checks: number;
  total_checks: number;
  failed_checks: number;
  critical_blockers: number;
  warnings: number;
  stale: boolean;
  last_checked_at: string | null;
  categories: HealthCategory[];
  workflows: HealthWorkflow[];
  checks: HealthCheck[];
  scoring_formula?: string;
};

const checkStatuses = new Set<CheckStatus>(['passed', 'failed', 'warning', 'not_applicable', 'needs_review']);
const checkSeverities = new Set<HealthCheck['severity']>(['critical', 'high', 'medium', 'low', 'informational']);
const categories = [
  { key: 'school_profile', label: 'School Profile', icon: Activity },
  { key: 'academic_years', label: 'Academic Years & Terms', icon: BookOpenCheck },
  { key: 'classes', label: 'Classes & Streams', icon: UsersRound },
  { key: 'subjects', label: 'Subjects', icon: GraduationCap },
  { key: 'staff', label: 'Staff & Teachers', icon: UsersRound },
  { key: 'students', label: 'Students', icon: ClipboardCheck },
  { key: 'fees', label: 'Fees & Finance', icon: CircleDollarSign },
  { key: 'website', label: 'Website', icon: Activity },
];
const workflowOrder = ['timetable', 'attendance', 'reports', 'fees', 'daily_operations'];
const routeRoles: Record<string, AppRole[]> = {
  '/settings?tab=profile': ['school_admin'],
  '/settings?tab=modules': ['school_admin'],
  '/settings?tab=attendance': ['school_admin'],
  '/settings?tab=academics': ['school_admin'],
  '/academic-calendar': ['school_admin', 'academic_coordinator'],
  '/classes': ['school_admin', 'academic_coordinator'],
  '/subjects': ['school_admin', 'academic_coordinator'],
  '/staff': ['school_admin', 'academic_coordinator', 'hr_staff_administrator'],
  '/students': ['school_admin'],
  '/finance': ['school_admin', 'finance_manager', 'accountant', 'bursar', 'cashier'],
  '/website-management': ['school_admin', 'website_editor', 'website_publisher'],
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCheckStatus(value: unknown): value is CheckStatus {
  return typeof value === 'string' && checkStatuses.has(value as CheckStatus);
}

function isCheckSeverity(value: unknown): value is HealthCheck['severity'] {
  return typeof value === 'string' && checkSeverities.has(value as HealthCheck['severity']);
}

function parseCheck(value: unknown): HealthCheck {
  if (!isObject(value)
    || typeof value.rule_key !== 'string'
    || typeof value.name !== 'string'
    || typeof value.description !== 'string'
    || typeof value.category !== 'string'
    || typeof value.category_label !== 'string'
    || !Array.isArray(value.workflows)
    || !value.workflows.every((workflow) => typeof workflow === 'string')
    || !isCheckSeverity(value.severity)
    || typeof value.owner_role !== 'string'
    || !isCheckStatus(value.status)
    || typeof value.is_applicable !== 'boolean'
    || typeof value.blocks_workflow !== 'boolean'
    || (value.fix_route !== null && typeof value.fix_route !== 'string')
    || typeof value.result_message !== 'string'
    || (value.affected_count !== null && typeof value.affected_count !== 'number')
    || typeof value.checked_at !== 'string') {
    throw new Error('The setup health response contained an invalid check. Please retry.');
  }
  return {
    rule_key: value.rule_key,
    name: value.name,
    description: value.description,
    category: value.category,
    category_label: value.category_label,
    workflows: value.workflows.filter((workflow): workflow is string => typeof workflow === 'string'),
    severity: value.severity,
    owner_role: value.owner_role,
    status: value.status,
    is_applicable: value.is_applicable,
    blocks_workflow: value.blocks_workflow,
    fix_route: value.fix_route,
    result_message: value.result_message,
    affected_count: value.affected_count,
    checked_at: value.checked_at,
  };
}

function parseHealthSnapshot(value: unknown): HealthSnapshot {
  if (!isObject(value)
    || typeof value.has_run !== 'boolean'
    || typeof value.stale !== 'boolean'
    || !Array.isArray(value.categories)
    || !Array.isArray(value.workflows)
    || !Array.isArray(value.checks)) {
    throw new Error('The setup health response is incomplete. Please retry.');
  }
  const checks = value.checks.map(parseCheck);
  if (!value.has_run) {
    return {
      has_run: false,
      run_id: null,
      readiness_score: 0,
      readiness_status: 'Not checked',
      completed_checks: 0,
      total_checks: 0,
      failed_checks: 0,
      critical_blockers: 0,
      warnings: 0,
      stale: false,
      last_checked_at: null,
      categories: [],
      workflows: [],
      checks: [],
    };
  }
  if (typeof value.readiness_score !== 'number'
    || typeof value.readiness_status !== 'string'
    || typeof value.completed_checks !== 'number'
    || typeof value.total_checks !== 'number'
    || typeof value.failed_checks !== 'number'
    || typeof value.critical_blockers !== 'number'
    || typeof value.warnings !== 'number'
    || typeof value.last_checked_at !== 'string') {
    throw new Error('The saved setup health summary is incomplete. Run a new health check.');
  }
  const parsedCategories = value.categories.filter(isObject).map((category) => ({
    key: String(category.key),
    label: String(category.label),
    score: typeof category.score === 'number' ? category.score : null,
    status: String(category.status),
    completed_checks: Number(category.completed_checks),
    total_checks: Number(category.total_checks),
    failed_checks: Number(category.failed_checks),
    warnings: Number(category.warnings),
  }));
  const parsedWorkflows = value.workflows.filter(isObject).map((workflow) => ({
    key: String(workflow.key),
    label: String(workflow.label),
    description: String(workflow.description),
    score: typeof workflow.score === 'number' ? workflow.score : null,
    status: String(workflow.status),
    completed_checks: Number(workflow.completed_checks),
    total_checks: Number(workflow.total_checks),
    blockers: Number(workflow.blockers),
    warnings: Number(workflow.warnings),
  }));
  return {
    has_run: true,
    run_id: typeof value.run_id === 'string' ? value.run_id : null,
    readiness_score: value.readiness_score,
    readiness_status: value.readiness_status,
    completed_checks: value.completed_checks,
    total_checks: value.total_checks,
    failed_checks: value.failed_checks,
    critical_blockers: value.critical_blockers,
    warnings: value.warnings,
    stale: value.stale,
    last_checked_at: value.last_checked_at,
    categories: parsedCategories,
    workflows: parsedWorkflows,
    checks,
    scoring_formula: typeof value.scoring_formula === 'string' ? value.scoring_formula : undefined,
  };
}

function statusClass(value: string) {
  return value.toLowerCase().replaceAll(' ', '-').replaceAll('_', '-');
}

function canOpenFix(check: HealthCheck, role: AppRole) {
  if (!check.fix_route) return false;
  if (role === 'school_admin') return true;
  return routeRoles[check.fix_route]?.includes(role) ?? false;
}

function readableRole(role: string) {
  return role.replaceAll('_', ' ');
}

export function SetupHealthPage() {
  const { activeMembership } = useAuth();
  const navigate = useNavigate();
  const schoolId = activeMembership?.school_id;
  const currentRole = activeMembership?.role ?? 'student';
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [resolvedChecks, setResolvedChecks] = useState<string[]>([]);

  const runHealthCheck = useCallback(async (previous: HealthSnapshot | null = null) => {
    if (!schoolId) return;
    setRunning(true);
    setError('');
    try {
      const { data, error: rpcError } = await requireSupabase()
        .rpc('run_school_setup_health_check', { target_school: schoolId });
      if (rpcError) throw rpcError;
      const next = parseHealthSnapshot(data);
      if (!next.has_run) throw new Error('The server did not save a completed health check.');
      if (previous?.has_run) {
        const previousUnresolved = new Map(previous.checks
          .filter((check) => check.status === 'failed' || check.status === 'warning' || check.status === 'needs_review')
          .map((check) => [check.rule_key, check.name]));
        const resolved = next.checks
          .filter((check) => check.status === 'passed' && previousUnresolved.has(check.rule_key))
          .map((check) => check.name);
        setResolvedChecks(resolved);
      } else {
        setResolvedChecks([]);
      }
      setSnapshot(next);
    } catch (runError) {
      console.error('Could not run the school setup health check.', runError);
      setError(runError instanceof Error ? runError.message : 'The health check could not be completed. Retry to see current results.');
    } finally {
      setRunning(false);
    }
  }, [schoolId]);

  useEffect(() => {
    let active = true;
    async function loadSnapshot() {
      setSnapshot(null);
      setLoading(true);
      setError('');
      if (!schoolId) {
        setLoading(false);
        return;
      }
      try {
        const { data, error: rpcError } = await requireSupabase()
          .rpc('get_school_setup_health', { target_school: schoolId });
        if (rpcError) throw rpcError;
        const loaded = parseHealthSnapshot(data);
        if (!active) return;
        setSnapshot(loaded);
        if (loaded.has_run && loaded.stale) void runHealthCheck(loaded);
      } catch (loadError) {
        console.error('Could not load school setup health.', loadError);
        if (active) setError(loadError instanceof Error ? loadError.message : 'Setup health could not be loaded. Retry to continue.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadSnapshot();
    return () => { active = false; };
  }, [schoolId, runHealthCheck]);

  const availableFilters = useMemo(() => {
    if (!snapshot) return [];
    const values: Array<{ key: string; label: string }> = [
      { key: 'all', label: 'All checks' },
      { key: 'critical', label: 'Critical blockers' },
      { key: 'failed', label: 'Failed' },
      { key: 'warnings', label: 'Warnings & review' },
    ];
    if (currentRole === 'school_admin' || snapshot.checks.some((check) => check.owner_role === currentRole)) {
      values.push({ key: 'mine', label: 'My responsibilities' });
    }
    for (const workflow of snapshot.workflows) values.push({ key: `workflow:${workflow.key}`, label: `${workflow.label} workflow` });
    for (const category of snapshot.categories) values.push({ key: `category:${category.key}`, label: category.label });
    return values;
  }, [currentRole, snapshot]);

  const visibleChecks = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.checks.filter((check) => {
      if (filter === 'critical') return check.is_applicable && check.status === 'failed' && check.severity === 'critical';
      if (filter === 'failed') return check.is_applicable && check.status === 'failed';
      if (filter === 'warnings') return check.is_applicable && (check.status === 'warning' || check.status === 'needs_review');
      if (filter === 'mine') return currentRole === 'school_admin' || check.owner_role === currentRole;
      if (filter.startsWith('workflow:')) return check.workflows.includes(filter.slice('workflow:'.length));
      if (filter.startsWith('category:')) return check.category === filter.slice('category:'.length);
      return true;
    });
  }, [currentRole, filter, snapshot]);

  const workflowCards = useMemo(() => {
    if (!snapshot) return [];
    return workflowOrder.map((key) => snapshot.workflows.find((workflow) => workflow.key === key)).filter((workflow): workflow is HealthWorkflow => workflow !== undefined);
  }, [snapshot]);

  function openFix(check: HealthCheck) {
    if (!check.fix_route || !canOpenFix(check, currentRole)) return;
    navigate(check.fix_route, {
      state: { setupHealthReturn: { from: '/setup-health', ruleKey: check.rule_key } },
    });
  }

  if (loading && !snapshot) return <LoadingState label="Loading setup and data health…" />;

  return (
    <div className="setup-health-page">
      <header className="setup-health-header">
        <div>
          <span className="eyebrow">School readiness</span>
          <h1>Setup &amp; Data Health</h1>
          <p>See what is ready, what needs attention, and which school workflows may be blocked.</p>
        </div>
        <button className="button button-primary" type="button" onClick={() => void runHealthCheck(snapshot)} disabled={!schoolId || running}>
          <RefreshCw size={15} className={running ? 'setup-health-spinning' : undefined} />
          {running ? 'Checking…' : snapshot?.has_run ? 'Run health check' : 'Run first health check'}
        </button>
      </header>

      <div className="setup-health-meta">
        <span>{activeMembership?.school.name ?? 'Current school'}</span>
        <span aria-hidden="true">·</span>
        <span>{snapshot?.last_checked_at ? `Last checked ${new Date(snapshot.last_checked_at).toLocaleString()}` : 'No completed check yet'}</span>
        {snapshot?.stale && <span className="health-status health-status-warning">Results may be out of date</span>}
      </div>

      {error && <div className="setup-health-error" role="alert"><ErrorState message={error} /><button className="button button-quiet" type="button" onClick={() => snapshot?.has_run ? void runHealthCheck(snapshot) : void runHealthCheck()}>Retry</button></div>}
      {resolvedChecks.length > 0 && <div className="setup-health-resolved" role="status"><Check size={16} /><span>Resolved since the last check: {resolvedChecks.join(', ')}</span></div>}

      {!snapshot?.has_run ? (
        <section className="setup-health-empty content-card">
          <span className="setup-health-empty-icon"><Activity size={21} /></span>
          <h2>Run your first readiness check</h2>
          <p>Campus Connect will evaluate the school’s current academic, people, finance, profile and website configuration. The results are calculated securely from school-scoped records.</p>
          <button className="button button-primary" type="button" onClick={() => void runHealthCheck()} disabled={running}>
            {running ? 'Checking…' : 'Run health check'}
          </button>
        </section>
      ) : (
        <>
          <section className="setup-health-score content-card" aria-labelledby="setup-health-score-title">
            <div className="setup-health-score-main">
              <div className={`setup-health-score-ring ${statusClass(snapshot.readiness_status)}`}>
                <strong>{Math.round(snapshot.readiness_score)}%</strong>
                <span>ready</span>
              </div>
              <div className="setup-health-score-copy">
                <span className={`health-status health-status-${statusClass(snapshot.readiness_status)}`}>{snapshot.readiness_status}</span>
                <h2 id="setup-health-score-title">Overall readiness</h2>
                <p>Weighted across applicable configuration checks. Critical blockers prevent a Ready status.</p>
              </div>
            </div>
            <div className="setup-health-stat-grid">
              <div><strong>{snapshot.completed_checks}<small> / {snapshot.total_checks}</small></strong><span>Checks passed</span></div>
              <div className={snapshot.failed_checks ? 'has-issue' : ''}><strong>{snapshot.failed_checks}</strong><span>Failed checks</span></div>
              <div className={snapshot.critical_blockers ? 'has-critical' : ''}><strong>{snapshot.critical_blockers}</strong><span>Critical blockers</span></div>
              <div className={snapshot.warnings ? 'has-warning' : ''}><strong>{snapshot.warnings}</strong><span>Warnings / review</span></div>
            </div>
          </section>

          <section className="setup-health-section" aria-labelledby="setup-health-workflows-title">
            <div className="setup-health-section-heading">
              <div><span className="eyebrow">Operational readiness</span><h2 id="setup-health-workflows-title">Workflows</h2></div>
            </div>
            <div className="setup-health-workflow-grid">
              {workflowCards.map((workflow) => (
                <button className="setup-health-workflow-card content-card" type="button" key={workflow.key} onClick={() => setFilter(`workflow:${workflow.key}`)}>
                  <span className={`health-status health-status-${statusClass(workflow.status)}`}>{workflow.status}</span>
                  <strong>{workflow.label}</strong>
                  <span className="setup-health-workflow-description">{workflow.description}</span>
                  <span className="setup-health-workflow-metrics">
                    {workflow.status === 'Module Disabled' ? 'Module disabled' : workflow.total_checks === 0 ? 'Not applicable' : `${workflow.score ?? 0}% ready`}
                    {workflow.blockers > 0 && <span className="health-inline-critical"><ShieldAlert size={13} /> {workflow.blockers} blocker{workflow.blockers === 1 ? '' : 's'}</span>}
                    {workflow.warnings > 0 && <span>{workflow.warnings} warning{workflow.warnings === 1 ? '' : 's'}</span>}
                  </span>
                  <span className="setup-health-card-link">View checks <ArrowRight size={14} /></span>
                </button>
              ))}
            </div>
          </section>

          <section className="setup-health-section" aria-labelledby="setup-health-categories-title">
            <div className="setup-health-section-heading">
              <div><span className="eyebrow">Configuration overview</span><h2 id="setup-health-categories-title">Categories</h2></div>
            </div>
            <div className="setup-health-category-grid">
              {categories.map((category) => {
                const summary = snapshot.categories.find((item) => item.key === category.key);
                const Icon = category.icon;
                return (
                  <button className="setup-health-category-card content-card" type="button" key={category.key} onClick={() => setFilter(`category:${category.key}`)}>
                    <span className="setup-health-category-icon"><Icon size={17} /></span>
                    <span className="setup-health-category-title">{category.label}</span>
                    <strong>{summary?.status === 'Not Applicable' ? 'Not applicable' : `${summary?.score ?? 0}%`}</strong>
                    <small>{summary?.completed_checks ?? 0} / {summary?.total_checks ?? 0} passed</small>
                    <span className="setup-health-category-flags">
                      {(summary?.failed_checks ?? 0) > 0 && <em className="flag-failed">{summary?.failed_checks} failed</em>}
                      {(summary?.warnings ?? 0) > 0 && <em className="flag-warning">{summary?.warnings} warning{summary?.warnings === 1 ? '' : 's'}</em>}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="setup-health-section setup-health-checklist" aria-labelledby="setup-health-checklist-title">
            <div className="setup-health-section-heading">
              <div><span className="eyebrow">Detailed results</span><h2 id="setup-health-checklist-title">Setup checklist</h2></div>
              <label className="setup-health-filter">
                <span className="sr-only">Filter setup checks</span>
                <select value={filter} onChange={(event) => setFilter(event.target.value)}>
                  {availableFilters.map((option) => <option value={option.key} key={option.key}>{option.label}</option>)}
                </select>
              </label>
            </div>
            {visibleChecks.length === 0 ? (
              <div className="setup-health-no-results content-card">No checks match this filter.</div>
            ) : categories.map((category) => {
              const checks = visibleChecks.filter((check) => check.category === category.key);
              if (!checks.length) return null;
              return (
                <details className="setup-health-category-details content-card" key={category.key}>
                  <summary>
                    <span>{category.label}</span>
                    <small>{checks.filter((check) => check.status === 'passed').length} passed, {checks.filter((check) => check.status === 'failed').length} failed, {checks.filter((check) => check.status === 'warning' || check.status === 'needs_review').length} warnings</small>
                  </summary>
                  <div className="setup-health-check-list">
                    {checks.map((check) => (
                      <article className={`setup-health-check health-check-${statusClass(check.status)}`} key={check.rule_key}>
                        <div className="setup-health-check-icon" aria-hidden="true">
                          {check.status === 'passed' ? <Check size={16} /> : check.status === 'not_applicable' ? <Activity size={16} /> : <AlertTriangle size={16} />}
                        </div>
                        <div className="setup-health-check-content">
                          <div className="setup-health-check-title-row">
                            <h3>{check.name}</h3>
                            <span className={`health-status health-status-${statusClass(check.status)}`}>{check.status.replaceAll('_', ' ')}</span>
                            <span className={`health-severity health-severity-${check.severity}`}>{check.severity}</span>
                          </div>
                          <p>{check.description}</p>
                          <p className="setup-health-result-message">{check.result_message}</p>
                          <div className="setup-health-check-meta">
                            <span>Owner: {readableRole(check.owner_role)}</span>
                            {check.workflows.length > 0 && <span>Workflows: {check.workflows.map((workflow) => workflow.replaceAll('_', ' ')).join(', ')}</span>}
                            {check.affected_count !== null && <span>{check.affected_count} affected</span>}
                          </div>
                        </div>
                        {check.status !== 'passed' && check.status !== 'not_applicable' && check.fix_route && (
                          canOpenFix(check, currentRole)
                            ? <button className="button button-secondary setup-health-fix" type="button" onClick={() => openFix(check)}>Fix <ArrowRight size={14} /></button>
                            : <span className="setup-health-required-role">Requires {readableRole(check.owner_role)}</span>
                        )}
                      </article>
                    ))}
                  </div>
                </details>
              );
            })}
          </section>
          {snapshot.scoring_formula && <p className="setup-health-scoring-note">{snapshot.scoring_formula}</p>}
        </>
      )}
    </div>
  );
}
