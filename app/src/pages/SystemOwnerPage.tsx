import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, Building2, Check, CircleDollarSign, GraduationCap,
  RefreshCw, ShieldAlert, UserRound, UsersRound, X,
} from 'lucide-react';
import { ErrorState, LoadingState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

type Dashboard = {
  stats: {
    schools: number;
    activeSchools: number;
    suspendedSchools: number;
    users: number;
    students: number;
    teachers: number;
    pendingStorageRequests: number;
  };
  managedStorageConfigured: boolean;
  roles: { role: string; users: number }[];
  recentSchools: { id: string; name: string; platform_status: 'active' | 'suspended'; managed_storage_enabled: boolean; created_at: string }[];
  recentActivity: { id: string; action: string; target_type: string; target_id: string | null; details: Record<string, unknown>; created_at: string; actor_name: string | null }[];
  storageRequests: { id: string; school_id: string; school_name: string; requested_by: string; requester_name: string | null; requester_email: string | null; message: string; status: string; created_at: string }[];
  alerts: { schoolsWithoutAdmin: number; suspendedSchools: number };
  setupHealth: {
    totalSchools: number;
    checkedSchools: number;
    staleSchools: number;
    schools: {
      schoolId: string;
      schoolName: string;
      score: number | null;
      status: string;
      stale: boolean;
      lastCheckedAt: string | null;
    }[];
  };
  performance: {
    windowDays: number;
    sampleCount: number;
    metrics: { name: string; count: number; p75: number | null }[];
  };
};

function formatLabel(value: string) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

function statusClass(value: string) {
  return value.toLowerCase().replaceAll(' ', '-').replaceAll('_', '-');
}

export function SystemOwnerPage() {
  const { user } = useAuth();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [healthQuery, setHealthQuery] = useState('');
  const [pendingAction, setPendingAction] = useState('');

  const loadDashboard = useCallback(async (background = false) => {
    if (!user) return;
    if (background) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const { data: authorization, error: authorizationError } = await requireSupabase().functions.invoke('system-owner-admin', {
        body: { action: 'check' },
      });
      if (authorizationError) throw authorizationError;
      if (authorization?.authorized !== true) throw new Error('This panel is restricted to the Campus Connect system owner.');
      const { data, error: dashboardError } = await requireSupabase().functions.invoke('system-owner-admin', {
        body: { action: 'dashboard' },
      });
      if (dashboardError) throw dashboardError;
      if (!data?.dashboard?.stats || !data.dashboard.setupHealth) throw new Error('The system owner service returned an invalid dashboard response.');
      setDashboard(data.dashboard as Dashboard);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load the system owner dashboard.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user]);

  useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  const filteredSchools = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (dashboard?.recentSchools ?? []).filter((school) => !needle || school.name.toLocaleLowerCase().includes(needle));
  }, [dashboard?.recentSchools, query]);
  const filteredSetupHealthSchools = useMemo(() => {
    const needle = healthQuery.trim().toLocaleLowerCase();
    return (dashboard?.setupHealth.schools ?? []).filter((school) =>
      !needle
      || school.schoolName.toLocaleLowerCase().includes(needle)
      || school.status.toLocaleLowerCase().includes(needle));
  }, [dashboard?.setupHealth.schools, healthQuery]);
  const getPerformanceMetric = (name: string) => dashboard?.performance.metrics.find((metric) => metric.name === name);
  const formatPerformanceMetric = (name: string) => {
    const metric = getPerformanceMetric(name);
    if (!metric || metric.p75 === null) return '—';
    return name === 'cls' ? metric.p75.toFixed(3) : `${Math.round(metric.p75)} ms`;
  };

  async function setSchoolStatus(schoolId: string, status: 'active' | 'suspended') {
    setPendingAction(schoolId);
    setError('');
    setNotice('');
    try {
      const { error: actionError } = await requireSupabase().functions.invoke('system-owner-admin', {
        body: { action: 'set-school-status', schoolId, status },
      });
      if (actionError) throw actionError;
      setNotice(status === 'suspended' ? 'School suspended. Workspace access has been disabled.' : 'School reactivated.');
      await loadDashboard(true);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Could not update school status.');
    } finally {
      setPendingAction('');
    }
  }

  async function reviewStorageRequest(requestId: string, decision: 'approved' | 'denied') {
    setPendingAction(requestId);
    setError('');
    setNotice('');
    try {
      const { error: actionError } = await requireSupabase().functions.invoke('system-owner-admin', {
        body: { action: 'review-storage-request', requestId, decision },
      });
      if (actionError) throw actionError;
      setNotice(decision === 'approved' ? 'Managed storage enabled for the school.' : 'Managed-storage request denied.');
      await loadDashboard(true);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Could not review the storage request.');
    } finally {
      setPendingAction('');
    }
  }

  if (loading) return <main className="system-owner-page"><LoadingState label="Verifying owner access and loading platform data…" /></main>;

  return (
    <main className="system-owner-page">
      <header className="system-owner-header">
        <div><span className="eyebrow">Platform control</span><h1>System owner dashboard</h1><p>Private Campus Connect operations · {user?.email}</p></div>
        <div className="system-owner-header-actions">
          <button className="button button-quiet" onClick={() => void loadDashboard(true)} disabled={refreshing}><RefreshCw size={15} className={refreshing ? 'system-owner-spinning' : ''} /> Refresh</button>
        </div>
      </header>
      {error && <ErrorState message={error} />}
      {notice && <p className="inline-success" role="status">{notice}</p>}
      <section className="content-card system-owner-panel">
        <div className="system-owner-panel-heading"><div><span className="eyebrow">Operations · last {dashboard?.performance.windowDays ?? 7} days</span><h2>Platform performance monitor</h2><p>Aggregated browser experience metrics across participating school workspaces.</p></div><Activity size={17} /></div>
        <div className="system-owner-stat-grid" aria-label="Platform performance metrics">
          <article className="system-owner-stat"><span><Activity size={17} /></span><small>Samples received</small><strong>{(dashboard?.performance.sampleCount ?? 0).toLocaleString()}</strong><p>Up to 5,000 recent records</p></article>
          <article className="system-owner-stat"><span><RefreshCw size={17} /></span><small>LCP · p75</small><strong>{formatPerformanceMetric('lcp')}</strong><p>{getPerformanceMetric('lcp')?.count ?? 0} samples</p></article>
          <article className="system-owner-stat"><span><Building2 size={17} /></span><small>INP · p75</small><strong>{formatPerformanceMetric('inp')}</strong><p>{getPerformanceMetric('inp')?.count ?? 0} samples</p></article>
          <article className="system-owner-stat"><span><Check size={17} /></span><small>CLS · p75</small><strong>{formatPerformanceMetric('cls')}</strong><p>{getPerformanceMetric('cls')?.count ?? 0} samples</p></article>
        </div>
        {dashboard && dashboard.performance.sampleCount === 0 && <p className="system-owner-muted">No performance samples have been recorded yet. Metrics appear after school users close or leave a workspace session.</p>}
      </section>
      {!dashboard && !error && <ErrorState message="Platform dashboard data is not available." />}
      {dashboard && <>
        <section className="system-owner-stat-grid" aria-label="Platform statistics">
          <article className="system-owner-stat"><span><Building2 size={17} /></span><small>Registered schools</small><strong>{dashboard.stats.schools.toLocaleString()}</strong><p>{dashboard.stats.activeSchools} active · {dashboard.stats.suspendedSchools} suspended</p></article>
          <article className="system-owner-stat"><span><UserRound size={17} /></span><small>Registered users</small><strong>{dashboard.stats.users.toLocaleString()}</strong><p>Unique Campus Connect accounts</p></article>
          <article className="system-owner-stat"><span><GraduationCap size={17} /></span><small>Students</small><strong>{dashboard.stats.students.toLocaleString()}</strong><p>Across registered schools</p></article>
          <article className="system-owner-stat"><span><UsersRound size={17} /></span><small>Teachers</small><strong>{dashboard.stats.teachers.toLocaleString()}</strong><p>Across registered schools</p></article>
        </section>

        <div className="system-owner-grid">
          <section className="content-card system-owner-panel">
            <div className="system-owner-panel-heading"><div><span className="eyebrow">Platform overview</span><h2>Users by role</h2></div><UserRound size={17} /></div>
            {dashboard.roles.length ? <div className="system-owner-role-list">{dashboard.roles.map((role) => <div key={role.role}><span>{formatLabel(role.role)}</span><strong>{role.users.toLocaleString()}</strong></div>)}</div> : <p className="system-owner-muted">No school role memberships yet.</p>}
          </section>
          <section className="content-card system-owner-panel">
            <div className="system-owner-panel-heading"><div><span className="eyebrow">Needs attention</span><h2>System alerts</h2></div><AlertTriangle size={17} /></div>
            <div className="system-owner-alerts">
              {dashboard.stats.pendingStorageRequests > 0 && <div className="system-owner-alert"><AlertTriangle size={15} /><span><strong>{dashboard.stats.pendingStorageRequests} managed-storage request{dashboard.stats.pendingStorageRequests === 1 ? '' : 's'}</strong><small>Review access requests from school administrators below.</small></span></div>}
              {dashboard.stats.pendingStorageRequests > 0 && !dashboard.managedStorageConfigured && <div className="system-owner-alert"><ShieldAlert size={15} /><span><strong>Managed R2 is not configured</strong><small>Set the platform R2 secrets before approving school requests.</small></span></div>}
              {dashboard.alerts.schoolsWithoutAdmin > 0 && <div className="system-owner-alert"><ShieldAlert size={15} /><span><strong>{dashboard.alerts.schoolsWithoutAdmin} school{dashboard.alerts.schoolsWithoutAdmin === 1 ? '' : 's'} without an administrator</strong><small>Check account setup and ensure each school has an owner.</small></span></div>}
              {dashboard.stats.suspendedSchools > 0 && <div className="system-owner-alert"><ShieldAlert size={15} /><span><strong>{dashboard.stats.suspendedSchools} suspended school{dashboard.stats.suspendedSchools === 1 ? '' : 's'}</strong><small>Review the suspended school list and reactivate when appropriate.</small></span></div>}
              {dashboard.stats.pendingStorageRequests === 0 && dashboard.alerts.schoolsWithoutAdmin === 0 && dashboard.stats.suspendedSchools === 0 && <p className="system-owner-muted"><Check size={15} /> No outstanding platform alerts.</p>}
            </div>
          </section>
        </div>

        <section className="content-card system-owner-panel">
          <div className="system-owner-panel-heading">
            <div><span className="eyebrow">Cross-school readiness</span><h2>Setup &amp; data health</h2><p>Read-only readiness snapshots from each school. Detailed records remain in their school workspace.</p></div>
            <Activity size={18} />
          </div>
          <div className="system-owner-health-summary">
            <div><strong>{dashboard.setupHealth.checkedSchools} / {dashboard.setupHealth.totalSchools}</strong><span>Schools checked</span></div>
            <div><strong>{dashboard.setupHealth.staleSchools}</strong><span>Stale snapshots</span></div>
            <div><strong>{dashboard.setupHealth.totalSchools - dashboard.setupHealth.checkedSchools}</strong><span>Not checked</span></div>
          </div>
          <label className="table-search system-owner-search">
            <input value={healthQuery} onChange={(event) => setHealthQuery(event.target.value)} placeholder="Filter schools or status" aria-label="Filter setup health by school or readiness status" />
          </label>
          {filteredSetupHealthSchools.length === 0 ? (
            <p className="system-owner-muted">{dashboard.setupHealth.schools.length ? 'No schools match this filter.' : 'No schools are registered yet.'}</p>
          ) : (
            <div className="system-owner-school-list" aria-label="School setup readiness">
              {filteredSetupHealthSchools.map((school) => (
                <article className="system-owner-school system-owner-health-school" key={school.schoolId}>
                  <div>
                    <strong>{school.schoolName}</strong>
                    <small>{school.lastCheckedAt ? `Last checked ${formatDate(school.lastCheckedAt)}` : 'No health check has been run'}</small>
                  </div>
                  <div className="system-owner-health-result">
                    <strong>{school.score === null ? '—' : `${Math.round(school.score)}%`}</strong>
                    <span className={`health-status health-status-${statusClass(school.status)}`}>{school.status}</span>
                    {school.stale && <small className="system-owner-health-stale">Stale snapshot</small>}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="content-card system-owner-panel">
          <div className="system-owner-panel-heading"><div><span className="eyebrow">Support & billing workflow</span><h2>Managed storage requests</h2><p>Approve to enable the platform-managed R2 bucket for that school.</p></div><CircleDollarSign size={18} /></div>
          {!dashboard.storageRequests.length ? <p className="system-owner-muted">No pending requests.</p> : <div className="system-owner-request-list">{dashboard.storageRequests.map((request) => <article className="system-owner-request" key={request.id}>
            <div><strong>{request.school_name}</strong><small>{request.requester_name || request.requester_email || 'School administrator'} · {formatDate(request.created_at)}</small>{request.message && <p>{request.message}</p>}</div>
            <div className="system-owner-actions"><button className="button button-primary" disabled={Boolean(pendingAction) || !dashboard.managedStorageConfigured} onClick={() => void reviewStorageRequest(request.id, 'approved')}><Check size={14} /> Approve</button><button className="button button-quiet" disabled={Boolean(pendingAction)} onClick={() => void reviewStorageRequest(request.id, 'denied')}><X size={14} /> Deny</button></div>
          </article>)}</div>}
        </section>

        <section className="content-card system-owner-panel">
          <div className="system-owner-panel-heading"><div><span className="eyebrow">Platform administration</span><h2>Recently registered schools</h2><p>Quickly review status and switch a school between active and suspended.</p></div><Building2 size={18} /></div>
          <label className="table-search system-owner-search"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter recent schools" aria-label="Filter recent schools" /></label>
          <div className="system-owner-school-list">{filteredSchools.map((school) => <article className="system-owner-school" key={school.id}>
            <div><strong>{school.name}</strong><small>Registered {formatDate(school.created_at)}{school.managed_storage_enabled ? ' · Managed storage' : ''}</small></div>
            <span className={`status-pill ${school.platform_status === 'active' ? 'status-active' : 'status-muted'}`}>{school.platform_status}</span>
            <button className={`button ${school.platform_status === 'active' ? 'button-quiet' : 'button-primary'}`} disabled={Boolean(pendingAction)} onClick={() => void setSchoolStatus(school.id, school.platform_status === 'active' ? 'suspended' : 'active')}>{pendingAction === school.id ? 'Saving…' : school.platform_status === 'active' ? 'Suspend' : 'Reactivate'}</button>
          </article>)}</div>
          {!filteredSchools.length && <p className="system-owner-muted">No schools match this filter.</p>}
        </section>

        <section className="content-card system-owner-panel">
          <div className="system-owner-panel-heading"><div><span className="eyebrow">Audit trail</span><h2>Recent platform activity</h2><p>Latest system-owner changes and school-scoped audit events.</p></div><Activity size={18} /></div>
          {!dashboard.recentActivity.length ? <p className="system-owner-muted">No recent activity.</p> : <div className="system-owner-activity-list">{dashboard.recentActivity.map((activity) => <article key={activity.id}><span className="system-owner-activity-icon"><Activity size={14} /></span><div><strong>{formatLabel(activity.action)}</strong><small>{activity.actor_name || 'School member'} · {activity.target_type}{typeof activity.details.school_name === 'string' ? ` · ${activity.details.school_name}` : ''}</small></div><time>{formatDate(activity.created_at)}</time></article>)}</div>}
        </section>
      </>}
    </main>
  );
}
