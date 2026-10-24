import { useEffect, useState } from 'react';
import { ArrowUpRight, BookMarked, CalendarDays, ClipboardCheck, GraduationCap, Users, UsersRound, CircleDollarSign, UserRoundPlus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { requireSupabase } from '../lib/supabase';
import type { DashboardSummary } from '../types/database';
import { EmptyState, ErrorState, LoadingState } from '../components/Feedback';
import { TeacherDashboardPage } from './TeacherDashboardPage';

export function DashboardPage() {
  const { activeMembership } = useAuth();
  return activeMembership?.role === 'teacher' ? <TeacherDashboardPage /> : <SchoolDashboardPage />;
}

function SchoolDashboardPage() {
  const { activeMembership, user } = useAuth();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
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

  type DashboardView = 'overview' | 'attendance' | 'operations' | 'admin';

  const dashboardViewOptions: { id: DashboardView; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'attendance', label: 'Attendance focus' },
    { id: 'operations', label: 'Operations' },
    { id: 'admin', label: 'Administration' },
  ];

  const [dashboardView, setDashboardView] = useState<DashboardView>(() => {
    const saved = localStorage.getItem('campus-connect-dashboard-view');
    return (saved as DashboardView | null) ?? 'overview';
  });

  useEffect(() => {
    localStorage.setItem('campus-connect-dashboard-view', dashboardView);
  }, [dashboardView]);

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
        <section className="content-card" aria-label="Saved dashboard view selector">
          <div className="section-heading"><div><span className="eyebrow">Custom views</span><h2>Saved dashboard layout</h2></div></div>
          <div className="settings-fields settings-fields-spaced">
            <label className="field"><span>Current dashboard view</span><select value={dashboardView} onChange={(event) => setDashboardView(event.target.value as DashboardView)}>
              {dashboardViewOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select></label>
          </div>
          <p className="settings-readonly">Saved dashboard views are stored in this browser so your school team can return to a preferred overview quickly.</p>
        </section>
        <section className="stat-grid" aria-label="School summary">{cards.map(({ label, value, icon: Icon, color }) => <article className="stat-card" key={label}><div className="stat-card-top"><span>{label}</span><span className={`stat-icon ${color}`}><Icon size={19} /></span></div><strong>{value.toLocaleString()}</strong><span className="stat-caption">From your school records</span></article>)}</section>
        {dashboardView === 'overview' && <section className="dashboard-grid">
          <article className="content-card overview-card"><div className="section-heading"><div><span className="eyebrow">Today</span><h2>Attendance overview</h2></div><ClipboardCheck size={19} className="muted-icon" /></div>
            {summary?.attendanceToday ? <div className="attendance-summary"><div className="attendance-donut" style={{ '--attendance': `${Math.round(summary.attendanceToday.present / summary.attendanceToday.total * 100)}%` } as React.CSSProperties}><span>{Math.round(summary.attendanceToday.present / summary.attendanceToday.total * 100)}<small>%</small></span></div><div><strong>{summary.attendanceToday.present} present</strong><p>of {summary.attendanceToday.total} attendance records today</p></div></div> : <EmptyState title="No attendance recorded today" detail="When staff record today's attendance, the summary will appear here." />}
          </article>
          <article className="content-card quick-links-card"><div className="section-heading"><div><span className="eyebrow">Get started</span><h2>School management</h2></div></div><div className="quick-links">{quickLinks.map(({ to, label, icon: Icon }) => <Link key={to} to={to}><Icon size={18} /><span>{label}</span><ArrowUpRight size={16} /></Link>)}</div></article>
        </section>}
        {dashboardView === 'attendance' && <section className="dashboard-grid">
          <article className="content-card overview-card"><div className="section-heading"><div><span className="eyebrow">Attendance</span><h2>Today’s coverage</h2></div><ClipboardCheck size={19} className="muted-icon" /></div>
            {summary?.attendanceToday ? <div className="attendance-summary"><div className="attendance-donut" style={{ '--attendance': `${Math.round(summary.attendanceToday.present / summary.attendanceToday.total * 100)}%` } as React.CSSProperties}><span>{Math.round(summary.attendanceToday.present / summary.attendanceToday.total * 100)}<small>%</small></span></div><div><strong>{summary.attendanceToday.present} present</strong><p>of {summary.attendanceToday.total} attendance records today</p></div></div> : <EmptyState title="Attendance is still empty" detail="No records have been captured for the current day yet." />}
          </article>
          <article className="content-card quick-links-card"><div className="section-heading"><div><span className="eyebrow">Quick access</span><h2>Attendance actions</h2></div></div><div className="quick-links"><Link to="/attendance"><ClipboardCheck size={18} /><span>Open attendance register</span><ArrowUpRight size={16} /></Link><Link to="/students"><GraduationCap size={18} /><span>Review student status</span><ArrowUpRight size={16} /></Link></div></article>
        </section>}
        {dashboardView === 'operations' && <section className="dashboard-grid">
          <article className="content-card overview-card"><div className="section-heading"><div><span className="eyebrow">Operations</span><h2>School activity snapshot</h2></div></div>
            <p className="settings-readonly">This view keeps the daily school operations summary visible so staff can move between students, classes, and subject records without losing context.</p>
            <div className="quick-links"><Link to="/classes"><UsersRound size={18} /><span>Classes</span><ArrowUpRight size={16} /></Link><Link to="/subjects"><BookMarked size={18} /><span>Subjects</span><ArrowUpRight size={16} /></Link><Link to="/timetable"><CalendarDays size={18} /><span>Timetable</span><ArrowUpRight size={16} /></Link></div>
          </article>
          <article className="content-card quick-links-card"><div className="section-heading"><div><span className="eyebrow">Priority actions</span><h2>Operational tasks</h2></div></div><div className="quick-links">{quickLinks.map(({ to, label, icon: Icon }) => <Link key={to} to={to}><Icon size={18} /><span>{label}</span><ArrowUpRight size={16} /></Link>)}</div></article>
        </section>}
        {dashboardView === 'admin' && <section className="dashboard-grid">
          <article className="content-card overview-card"><div className="section-heading"><div><span className="eyebrow">Administration</span><h2>Governance at a glance</h2></div></div>
            <p className="settings-readonly">This layout prioritises changes to school structure, security, and portal settings so administrators can review the key operational areas fast.</p>
            <div className="quick-links"><Link to="/settings"><BookMarked size={18} /><span>School settings</span><ArrowUpRight size={16} /></Link><Link to="/audit-log"><ClipboardCheck size={18} /><span>Audit log</span><ArrowUpRight size={16} /></Link><Link to="/reports"><UsersRound size={18} /><span>Reports</span><ArrowUpRight size={16} /></Link></div>
          </article>
          <article className="content-card quick-links-card"><div className="section-heading"><div><span className="eyebrow">Control centre</span><h2>Secure actions</h2></div></div><div className="quick-links">{quickLinks.filter(({ to }) => ['/settings', '/audit-log', '/students', '/teachers', '/finance'].includes(to)).map(({ to, label, icon: Icon }) => <Link key={to} to={to}><Icon size={18} /><span>{label}</span><ArrowUpRight size={16} /></Link>)}</div></article>
        </section>}
        <section className="content-card dashboard-note"><div className="note-icon"><BookMarked size={18} /></div><div><h2>One connected workspace</h2><p>School records, classes, and academic tools are scoped to your active school. Your data is loaded directly from the configured Supabase project.</p></div></section>
      </>}
    </div>
  );
}
