import { useEffect, useState } from 'react';
import { ArrowUpRight, BookMarked, CalendarDays, ClipboardCheck, GraduationCap, Save, Trash2, Users, UsersRound, CircleDollarSign, UserRoundPlus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { requireSupabase } from '../lib/supabase';
import type { DashboardSummary } from '../types/database';
import { EmptyState, ErrorState, LoadingState } from '../components/Feedback';
import { TeacherDashboardPage } from './TeacherDashboardPage';

const dashboardWidgets = [
  { id: 'summary_cards', label: 'School summary cards' },
  { id: 'attendance', label: 'Attendance overview' },
  { id: 'quick_links', label: 'School management links' },
] as const;

type DashboardWidget = typeof dashboardWidgets[number]['id'];

interface SavedDashboardView {
  id: string;
  name: string;
  configuration: { widgets: DashboardWidget[] };
  updated_at: string;
}

function parseDashboardWidgets(configuration: unknown): DashboardWidget[] {
  if (!configuration || typeof configuration !== 'object' || !('widgets' in configuration) || !Array.isArray(configuration.widgets)) {
    throw new Error('A saved dashboard view has an invalid configuration. Please edit or remove that saved view.');
  }
  const allowedWidgets = new Set<string>(dashboardWidgets.map(({ id }) => id));
  if (configuration.widgets.some((widget) => typeof widget !== 'string' || !allowedWidgets.has(widget))) {
    throw new Error('A saved dashboard view contains an unsupported widget. Please edit or remove that saved view.');
  }
  return configuration.widgets as DashboardWidget[];
}

export function DashboardPage() {
  const { activeMembership } = useAuth();
  return activeMembership?.role === 'teacher' ? <TeacherDashboardPage /> : <SchoolDashboardPage />;
}

function SchoolDashboardPage() {
  const { activeMembership, user } = useAuth();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [viewError, setViewError] = useState('');
  const [savedViews, setSavedViews] = useState<SavedDashboardView[]>([]);
  const [selectedViewId, setSelectedViewId] = useState('');
  const [viewName, setViewName] = useState('');
  const [visibleWidgets, setVisibleWidgets] = useState<DashboardWidget[]>(dashboardWidgets.map(({ id }) => id));
  const [viewsLoading, setViewsLoading] = useState(false);
  const [viewsSaving, setViewsSaving] = useState(false);
  const [viewNotice, setViewNotice] = useState('');
  const schoolId = activeMembership?.school_id;
  useEffect(() => {
    if (!schoolId) return;
    let active = true;
    async function load() {
      setLoading(true);
      setError('');
      try {
        const client = requireSupabase();
        const today = new Date().toISOString().slice(0, 10);
        const [students, teachers, classes, attendance, attendanceTotal] = await Promise.all([
          client.from('students').select('id', { count: 'exact', head: true }).eq('school_id', schoolId).eq('status', 'active'),
          client.from('teacher_profiles').select('id', { count: 'exact', head: true }).eq('school_id', schoolId).eq('status', 'active'),
          client.from('school_classes').select('id', { count: 'exact', head: true }).eq('school_id', schoolId),
          client.from('attendance_records').select('id, attendance_sessions!inner(attendance_date)', { count: 'exact', head: true }).eq('school_id', schoolId).eq('attendance_sessions.attendance_date', today).eq('status', 'present'),
          client.from('attendance_records').select('id, attendance_sessions!inner(attendance_date)', { count: 'exact', head: true }).eq('school_id', schoolId).eq('attendance_sessions.attendance_date', today),
        ]);
        const result = [students.error, teachers.error, classes.error, attendance.error, attendanceTotal.error].find(Boolean);
        if (result) throw result;
        if (active) setSummary({ students: students.count ?? 0, teachers: teachers.count ?? 0, classes: classes.count ?? 0, attendanceToday: attendanceTotal.count ? { present: attendance.count ?? 0, total: attendanceTotal.count } : null });
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Dashboard data could not be loaded.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [schoolId]);

  useEffect(() => {
    setSavedViews([]);
    setSelectedViewId('');
    setViewName('');
    setVisibleWidgets(dashboardWidgets.map(({ id }) => id));
    setViewNotice('');
    setViewError('');
    if (!schoolId || !user) {
      setViewsLoading(false);
      return;
    }
    const profileId = user.id;
    let active = true;
    async function loadSavedViews() {
      setViewsLoading(true);
      setViewError('');
      try {
        const { data, error: queryError } = await requireSupabase()
          .from('dashboard_saved_views')
          .select('id, name, configuration, updated_at')
          .eq('school_id', schoolId)
          .eq('profile_id', profileId)
          .order('name');
        if (queryError) throw queryError;
        const views = ((data ?? []) as SavedDashboardView[]).map((view) => ({
          ...view,
          configuration: { widgets: parseDashboardWidgets(view.configuration) },
        }));
        if (active) {
          setSavedViews(views);
        }
      } catch (loadError) {
        if (active) setViewError(loadError instanceof Error ? loadError.message : 'Saved dashboard views could not be loaded.');
      } finally {
        if (active) setViewsLoading(false);
      }
    }
    void loadSavedViews();
    return () => { active = false; };
  }, [schoolId, user?.id]);

  function selectSavedView(id: string) {
    setSelectedViewId(id);
    setViewNotice('');
    const selected = savedViews.find((view) => view.id === id);
    setViewName(selected?.name ?? '');
    if (selected) {
      try {
        setVisibleWidgets(parseDashboardWidgets(selected.configuration));
      } catch (selectionError) {
        setViewError(selectionError instanceof Error ? selectionError.message : 'This saved dashboard view is invalid.');
      }
    } else {
      setVisibleWidgets(dashboardWidgets.map(({ id: widgetId }) => widgetId));
    }
  }

  async function saveDashboardView() {
    if (!schoolId || !user) {
      setViewError('Sign in to save a dashboard view.');
      return;
    }
    const name = viewName.trim();
    if (name.length < 2 || name.length > 80) {
      setViewError('Give this dashboard view a name between 2 and 80 characters.');
      return;
    }
    setViewsSaving(true);
    setViewError('');
    setViewNotice('');
    try {
      const values = { name, configuration: { widgets: visibleWidgets } };
      const query = requireSupabase().from('dashboard_saved_views');
      const result = selectedViewId
        ? await query.update(values).eq('id', selectedViewId).eq('school_id', schoolId).eq('profile_id', user.id).select('id, name, configuration, updated_at').single()
        : await query.insert({ ...values, school_id: schoolId, profile_id: user.id }).select('id, name, configuration, updated_at').single();
      if (result.error) throw result.error;
      const savedView = result.data as SavedDashboardView;
      const normalizedView = { ...savedView, configuration: { widgets: parseDashboardWidgets(savedView.configuration) } };
      setSavedViews((current) => [...current.filter((view) => view.id !== normalizedView.id), normalizedView].sort((left, right) => left.name.localeCompare(right.name)));
      setSelectedViewId(normalizedView.id);
      setViewName(normalizedView.name);
      setViewNotice(`“${normalizedView.name}” saved.`);
    } catch (saveError) {
      setViewError(saveError instanceof Error ? saveError.message : 'The dashboard view could not be saved.');
    } finally {
      setViewsSaving(false);
    }
  }

  async function deleteDashboardView() {
    if (!schoolId || !user || !selectedViewId) return;
    setViewsSaving(true);
    setViewError('');
    setViewNotice('');
    try {
      const { error: deleteError } = await requireSupabase().from('dashboard_saved_views')
        .delete()
        .eq('id', selectedViewId)
        .eq('school_id', schoolId)
        .eq('profile_id', user.id);
      if (deleteError) throw deleteError;
      setSavedViews((current) => current.filter((view) => view.id !== selectedViewId));
      setSelectedViewId('');
      setViewName('');
      setVisibleWidgets(dashboardWidgets.map(({ id }) => id));
      setViewNotice('Saved dashboard view deleted.');
    } catch (deleteError) {
      setViewError(deleteError instanceof Error ? deleteError.message : 'The dashboard view could not be deleted.');
    } finally {
      setViewsSaving(false);
    }
  }

  const cards = [
    { label: 'Active students', value: summary?.students ?? 0, icon: GraduationCap, color: 'purple' },
    { label: 'Teachers', value: summary?.teachers ?? 0, icon: Users, color: 'blue' },
    { label: 'Classes', value: summary?.classes ?? 0, icon: UsersRound, color: 'green' },
  ];

  const quickLinks = [
    { to: '/students', label: 'Manage students', icon: GraduationCap },
    { to: '/teachers', label: 'Manage teachers', icon: Users },
    { to: '/classes', label: 'Set up classes', icon: UsersRound },
    { to: '/subjects', label: 'Manage subjects', icon: BookMarked },
    ...(activeMembership?.role === 'school_admin' ? [{ to: '/settings', label: 'School settings', icon: BookMarked }] : []),
    ...(['school_admin', 'finance_manager', 'accountant', 'bursar', 'cashier'].includes(activeMembership?.role ?? '') ? [{ to: '/finance', label: 'Student fees', icon: CircleDollarSign }] : []),
    ...(activeMembership?.role === 'school_admin' ? [{ to: '/accounting-staff', label: 'Add accounting staff', icon: UserRoundPlus }] : []),
  ];

  return (
    <div className="page-stack">
      <div className="page-heading"><div><span className="eyebrow">School workspace</span><h1>Good day{user?.user_metadata.full_name ? `, ${(user.user_metadata.full_name as string).split(' ')[0]}` : ''}</h1><p>Here is an overview of {activeMembership?.school.name}.</p></div><span className="date-chip"><CalendarDays size={16} />{new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' }).format(new Date())}</span></div>
      {error && <ErrorState message={error} />}
      {loading ? <LoadingState label="Loading live school data…" /> : <>
        <section className="content-card" aria-label="Dashboard customization">
          <div className="section-heading"><div><span className="eyebrow">Custom views</span><h2>Customize your dashboard</h2></div></div>
          <div className="settings-fields settings-fields-spaced">
            <label className="field"><span>Saved view</span><select value={selectedViewId} disabled={viewsLoading || viewsSaving} onChange={(event) => selectSavedView(event.target.value)}>
              <option value="">Current layout (unsaved)</option>
              {savedViews.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
            </select></label>
            <label className="field"><span>View name</span><input value={viewName} onChange={(event) => setViewName(event.target.value)} maxLength={80} placeholder="e.g. Morning overview" disabled={viewsSaving} /></label>
          </div>
          <div className="settings-feature-grid">
            {dashboardWidgets.map(({ id, label }) => <label className="settings-checkbox-label" key={id}>
              <input type="checkbox" checked={visibleWidgets.includes(id)} disabled={viewsSaving} onChange={(event) => setVisibleWidgets((current) => event.target.checked ? [...current, id] : current.filter((widget) => widget !== id))} />
              <span>{label}</span>
            </label>)}
          </div>
          <div className="settings-actions">
            <button className="button button-primary" type="button" onClick={() => void saveDashboardView()} disabled={viewsLoading || viewsSaving}><Save size={15} />{viewsSaving ? 'Saving…' : selectedViewId ? 'Update saved view' : 'Save view'}</button>
            {selectedViewId && <button className="button button-quiet" type="button" onClick={() => void deleteDashboardView()} disabled={viewsSaving}><Trash2 size={15} />Delete view</button>}
          </div>
          {viewsLoading && <p className="settings-readonly">Loading your saved views…</p>}
          {viewError && <ErrorState message={viewError} />}
          {viewNotice && <p className="inline-success" role="status">{viewNotice}</p>}
        </section>
        {visibleWidgets.includes('summary_cards') && <section className="stat-grid" aria-label="School summary">{cards.map(({ label, value, icon: Icon, color }) => <article className="stat-card" key={label}><div className="stat-card-top"><span>{label}</span><span className={`stat-icon ${color}`}><Icon size={19} /></span></div><strong>{value.toLocaleString()}</strong><span className="stat-caption">From your school records</span></article>)}</section>}
        {(visibleWidgets.includes('attendance') || visibleWidgets.includes('quick_links')) && <section className="dashboard-grid">
          {visibleWidgets.includes('attendance') && <>
          <article className="content-card overview-card"><div className="section-heading"><div><span className="eyebrow">Today</span><h2>Attendance overview</h2></div><ClipboardCheck size={19} className="muted-icon" /></div>
            {summary?.attendanceToday ? <div className="attendance-summary"><div className="attendance-donut" style={{ '--attendance': `${Math.round(summary.attendanceToday.present / summary.attendanceToday.total * 100)}%` } as React.CSSProperties}><span>{Math.round(summary.attendanceToday.present / summary.attendanceToday.total * 100)}<small>%</small></span></div><div><strong>{summary.attendanceToday.present} present</strong><p>of {summary.attendanceToday.total} attendance records today</p></div></div> : <EmptyState title="No attendance recorded today" detail="When staff record today's attendance, the summary will appear here." />}
          </article>
          </>}
          {visibleWidgets.includes('quick_links') && <article className="content-card quick-links-card"><div className="section-heading"><div><span className="eyebrow">Get started</span><h2>School management</h2></div></div><div className="quick-links">{quickLinks.map(({ to, label, icon: Icon }) => <Link key={to} to={to}><Icon size={18} /><span>{label}</span><ArrowUpRight size={16} /></Link>)}</div></article>}
        </section>}
        <section className="content-card dashboard-note"><div className="note-icon"><BookMarked size={18} /></div><div><h2>One connected workspace</h2><p>School records, classes, and academic tools are scoped to your active school. Your data is loaded directly from the configured Supabase project.</p></div></section>
      </>}
    </div>
  );
}
