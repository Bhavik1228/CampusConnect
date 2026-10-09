import { useEffect, useState } from 'react';
import { ArrowUpRight, BookMarked, CalendarDays, ClipboardCheck, GraduationCap, Users, UsersRound } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { requireSupabase } from '../lib/supabase';
import type { DashboardSummary } from '../types/database';
import { EmptyState, ErrorState, LoadingState } from '../components/Feedback';

export function DashboardPage() {
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

  const cards = [
    { label: 'Active students', value: summary?.students ?? 0, icon: GraduationCap, color: 'purple' },
    { label: 'Teachers', value: summary?.teachers ?? 0, icon: Users, color: 'blue' },
    { label: 'Classes', value: summary?.classes ?? 0, icon: UsersRound, color: 'green' },
  ];

  return (
    <div className="page-stack">
      <div className="page-heading"><div><span className="eyebrow">School workspace</span><h1>Good day{user?.user_metadata.full_name ? `, ${(user.user_metadata.full_name as string).split(' ')[0]}` : ''}</h1><p>Here is an overview of {activeMembership?.school.name}.</p></div><span className="date-chip"><CalendarDays size={16} />{new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' }).format(new Date())}</span></div>
      {error && <ErrorState message={error} />}
      {loading ? <LoadingState label="Loading live school data…" /> : <>
        <section className="stat-grid" aria-label="School summary">{cards.map(({ label, value, icon: Icon, color }) => <article className="stat-card" key={label}><div className="stat-card-top"><span>{label}</span><span className={`stat-icon ${color}`}><Icon size={19} /></span></div><strong>{value.toLocaleString()}</strong><span className="stat-caption">From your school records</span></article>)}</section>
        <section className="dashboard-grid">
          <article className="content-card overview-card"><div className="section-heading"><div><span className="eyebrow">Today</span><h2>Attendance overview</h2></div><ClipboardCheck size={19} className="muted-icon" /></div>
            {summary?.attendanceToday ? <div className="attendance-summary"><div className="attendance-donut" style={{ '--attendance': `${Math.round(summary.attendanceToday.present / summary.attendanceToday.total * 100)}%` } as React.CSSProperties}><span>{Math.round(summary.attendanceToday.present / summary.attendanceToday.total * 100)}<small>%</small></span></div><div><strong>{summary.attendanceToday.present} present</strong><p>of {summary.attendanceToday.total} attendance records today</p></div></div> : <EmptyState title="No attendance recorded today" detail="When staff record today's attendance, the summary will appear here." />}
          </article>
          <article className="content-card quick-links-card"><div className="section-heading"><div><span className="eyebrow">Get started</span><h2>School management</h2></div></div><div className="quick-links"><Link to="/students"><GraduationCap size={18} /><span>Manage students</span><ArrowUpRight size={16} /></Link><Link to="/teachers"><Users size={18} /><span>Manage teachers</span><ArrowUpRight size={16} /></Link><Link to="/classes"><UsersRound size={18} /><span>Set up classes</span><ArrowUpRight size={16} /></Link><Link to="/subjects"><BookMarked size={18} /><span>Manage subjects</span><ArrowUpRight size={16} /></Link></div></article>
        </section>
        <section className="content-card dashboard-note"><div className="note-icon"><BookMarked size={18} /></div><div><h2>One connected workspace</h2><p>School records, classes, and academic tools are scoped to your active school. Your data is loaded directly from the configured Supabase project.</p></div></section>
      </>}
    </div>
  );
}
