import { useEffect, useState } from 'react';
import { ArrowUpRight, BookMarked, CalendarDays, ClipboardCheck, GraduationCap, Globe, Users, UsersRound, CircleDollarSign, UserRoundPlus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { requireSupabase } from '../lib/supabase';
import { resolveTimeZone } from '../lib/timezone';
import type { DashboardSummary } from '../types/database';
import { EmptyState, ErrorState, LoadingState } from '../components/Feedback';
import { TeacherDashboardPage } from './TeacherDashboardPage';

interface MorningRegister {
  id: string;
  class_id: string;
  session_type: 'daily' | 'morning';
  status: 'open' | 'submitted' | 'closed';
  school_class: { name: string } | { name: string }[] | null;
  attendance_records: { status: string }[] | null;
}

async function loadMorningRegisters(schoolId: string, attendanceDate: string): Promise<MorningRegister[]> {
  const pageSize = 500;
  const registers: MorningRegister[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await requireSupabase().from('attendance_sessions')
      .select('id,class_id,session_type,status,school_class:school_classes(name),attendance_records(status)')
      .eq('school_id', schoolId).eq('attendance_date', attendanceDate).in('session_type', ['daily', 'morning'])
      .order('session_type').order('class_id').range(offset, offset + pageSize - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as MorningRegister[];
    registers.push(...page);
    if (page.length < pageSize) return registers;
  }
}

export function DashboardPage() {
  const { activeMembership } = useAuth();
  return activeMembership?.role === 'teacher' ? <TeacherDashboardPage /> : <SchoolDashboardPage />;
}

function SchoolDashboardPage() {
  const { activeMembership, user } = useAuth();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [morningRegisters, setMorningRegisters] = useState<MorningRegister[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const schoolId = activeMembership?.school_id;
  const schoolTimeZone = resolveTimeZone(activeMembership?.school.timezone);
  const restrictedDashboardRole = [
    'accounts_payable_officer', 'auditor', 'librarian', 'website_editor', 'website_publisher',
    'admissions_officer', 'hr_staff_administrator', 'transport_manager', 'facilities_manager',
    'it_support_technician', 'safeguarding_officer', 'procurement_officer', 'compliance_audit_officer',
  ].includes(activeMembership?.role ?? '');
  useEffect(() => {
    if (!schoolId || restrictedDashboardRole) {
      setSummary(null);
      setMorningRegisters([]);
      setLoading(false);
      return;
    }
    let active = true;
    async function load(activeSchoolId: string) {
      setLoading(true);
      setError('');
      try {
        const client = requireSupabase();
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: schoolTimeZone }).format(new Date());
        const [students, teachers, classes, attendance, attendanceTotal, registerResult] = await Promise.all([
          client.from('students').select('id', { count: 'exact', head: true }).eq('school_id', activeSchoolId).eq('status', 'active'),
          client.from('teacher_profiles').select('id', { count: 'exact', head: true }).eq('school_id', activeSchoolId).eq('status', 'active'),
          client.from('school_classes').select('id', { count: 'exact', head: true }).eq('school_id', activeSchoolId),
          client.from('attendance_records').select('id, attendance_sessions!inner(attendance_date)', { count: 'exact', head: true }).eq('school_id', activeSchoolId).eq('attendance_sessions.attendance_date', today).eq('status', 'present'),
          client.from('attendance_records').select('id, attendance_sessions!inner(attendance_date)', { count: 'exact', head: true }).eq('school_id', activeSchoolId).eq('attendance_sessions.attendance_date', today),
          loadMorningRegisters(activeSchoolId, today),
        ]);
        const result = [students.error, teachers.error, classes.error, attendance.error, attendanceTotal.error].find(Boolean);
        if (result) throw result;
        if (active) {
          setSummary({ students: students.count ?? 0, teachers: teachers.count ?? 0, classes: classes.count ?? 0, attendanceToday: attendanceTotal.count ? { present: attendance.count ?? 0, total: attendanceTotal.count } : null });
          setMorningRegisters(registerResult);
        }
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Dashboard data could not be loaded.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void load(schoolId);
    return () => { active = false; };
  }, [restrictedDashboardRole, schoolId, schoolTimeZone]);

  const cards = [
    { label: 'Active students', value: summary?.students ?? 0, icon: GraduationCap, color: 'purple' },
    { label: 'Teachers', value: summary?.teachers ?? 0, icon: Users, color: 'blue' },
    { label: 'Classes', value: summary?.classes ?? 0, icon: UsersRound, color: 'green' },
  ];
  const primaryMorningRegisters = new Map<string, MorningRegister>();
  for (const register of morningRegisters) {
    const current = primaryMorningRegisters.get(register.class_id);
    if (!current || (register.session_type === 'morning' && current.session_type === 'daily')) {
      primaryMorningRegisters.set(register.class_id, register);
    }
  }
  const morningRegisterRows = [...primaryMorningRegisters.values()]
    .sort((left, right) => ((Array.isArray(left.school_class) ? left.school_class[0]?.name : left.school_class?.name) ?? '')
      .localeCompare((Array.isArray(right.school_class) ? right.school_class[0]?.name : right.school_class?.name) ?? ''));
  const morningCounts = {
    open: morningRegisterRows.filter((register) => register.status === 'open').length,
    submitted: morningRegisterRows.filter((register) => register.status === 'submitted').length,
    absent: morningRegisterRows.reduce((total, register) => total + (register.attendance_records ?? []).filter((record) => record.status === 'absent').length, 0),
    late: morningRegisterRows.reduce((total, register) => total + (register.attendance_records ?? []).filter((record) => record.status === 'late').length, 0),
    marked: morningRegisterRows.reduce((total, register) => total + (register.attendance_records?.length ?? 0), 0),
  };

  const standardQuickLinks = [
    { to: '/students', label: 'Manage students', icon: GraduationCap },
    { to: '/teachers', label: 'Manage teachers', icon: Users },
    { to: '/classes', label: 'Set up classes', icon: UsersRound },
    { to: '/subjects', label: 'Manage subjects', icon: BookMarked },
    ...(activeMembership?.role === 'school_admin' ? [{ to: '/settings', label: 'School settings', icon: BookMarked }] : []),
    ...(['school_admin', 'finance_manager', 'accountant', 'bursar', 'cashier'].includes(activeMembership?.role ?? '') ? [{ to: '/finance', label: 'Student fees', icon: CircleDollarSign }] : []),
    ...(activeMembership?.role === 'school_admin' ? [{ to: '/accounting-staff', label: 'Add accounting staff', icon: UserRoundPlus }] : []),
  ];
  const quickLinks = activeMembership?.role === 'librarian'
    ? [{ to: '/library', label: 'Manage the library', icon: BookMarked }]
    : activeMembership?.role === 'auditor'
      ? [
        { to: '/finance', label: 'Review student fee records', icon: CircleDollarSign },
        { to: '/audit-log', label: 'Review audit history', icon: ClipboardCheck },
      ]
      : activeMembership?.role === 'accounts_payable_officer'
        ? []
        : activeMembership?.role === 'website_editor' || activeMembership?.role === 'website_publisher'
          ? [{ to: '/website-management', label: 'Manage website content', icon: Globe }]
          : activeMembership?.role === 'admissions_officer'
            ? [{ to: '/admissions', label: 'Review admission applications', icon: GraduationCap }]
            : activeMembership?.role === 'hr_staff_administrator'
              ? [{ to: '/staff', label: 'Manage staff records', icon: Users }]
              : ['transport_manager', 'facilities_manager', 'it_support_technician', 'safeguarding_officer', 'procurement_officer', 'compliance_audit_officer'].includes(activeMembership?.role ?? '')
                ? [
                  { to: '/admin-workflows', label: 'Open operational workflows', icon: ClipboardCheck },
                  ...(activeMembership?.role === 'compliance_audit_officer' ? [{ to: '/audit-log', label: 'Review audit history', icon: ClipboardCheck }] : []),
                ]
        : standardQuickLinks;

  return (
    <div className="page-stack">
      <div className="page-heading"><div><span className="eyebrow">School workspace</span><h1>Good day{user?.user_metadata.full_name ? `, ${(user.user_metadata.full_name as string).split(' ')[0]}` : ''}</h1><p>Here is an overview of {activeMembership?.school.name}.</p></div><span className="date-chip"><CalendarDays size={16} />{new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' }).format(new Date())}</span></div>
      {error && <ErrorState message={error} />}
      {loading ? <LoadingState label="Loading live school data…" /> : <>
        {!restrictedDashboardRole && <section className="stat-grid" aria-label="School summary">{cards.map(({ label, value, icon: Icon, color }) => <article className="stat-card" key={label}><div className="stat-card-top"><span>{label}</span><span className={`stat-icon ${color}`}><Icon size={19} /></span></div><strong>{value.toLocaleString()}</strong><span className="stat-caption">From your school records</span></article>)}</section>}
        <section className="dashboard-grid">
          {!restrictedDashboardRole && <>
          <article className="content-card overview-card morning-operations-card"><div className="section-heading"><div><span className="eyebrow">School operations · today</span><h2>Morning operations</h2></div><ClipboardCheck size={19} className="muted-icon" /></div>
            <div className="morning-operations-stats" aria-label="Morning register totals">
              <div><strong>{morningRegisterRows.length}</strong><span>Registers started</span></div>
              <div><strong>{morningCounts.open}</strong><span>Open</span></div>
              <div><strong>{morningCounts.submitted}</strong><span>Submitted</span></div>
              <div><strong>{morningCounts.absent}</strong><span>Absent</span></div>
              <div><strong>{morningCounts.late}</strong><span>Late</span></div>
            </div>
            {morningRegisterRows.length ? <>
              <div className="table-scroll morning-register-scroll"><table><thead><tr><th>Class</th><th>Register</th><th>Marked</th><th>Absent / late</th><th>Status</th><th /></tr></thead><tbody>
                {morningRegisterRows.map((register) => {
                  const classRelation = Array.isArray(register.school_class) ? register.school_class[0] : register.school_class;
                  const records = register.attendance_records ?? [];
                  const absent = records.filter((record) => record.status === 'absent').length;
                  const late = records.filter((record) => record.status === 'late').length;
                  return <tr key={register.id}>
                    <td><strong>{classRelation?.name ?? 'Class'}</strong></td>
                    <td>{register.session_type === 'morning' ? 'Morning' : 'Daily'}</td>
                    <td>{records.length}</td>
                    <td>{absent} absent · {late} late</td>
                    <td><span className={`attendance-state-chip state-${register.status}`}>{register.status}</span></td>
                    <td><Link className="morning-register-link" to="/attendance">Open<ArrowUpRight size={13} /></Link></td>
                  </tr>;
                })}
              </tbody></table></div>
              <p className="morning-operations-footnote">{morningCounts.marked} attendance mark{morningCounts.marked === 1 ? '' : 's'} recorded across today's daily and morning registers.</p>
            </> : <EmptyState title="No morning registers started" detail="Daily and morning register activity will appear here as staff record attendance." />}
          </article>
          </>}
          <article className="content-card quick-links-card"><div className="section-heading"><div><span className="eyebrow">Get started</span><h2>School management</h2></div></div><div className="quick-links">{quickLinks.map(({ to, label, icon: Icon }) => <Link key={to} to={to}><Icon size={18} /><span>{label}</span><ArrowUpRight size={16} /></Link>)}</div></article>
        </section>
        <section className="content-card dashboard-note"><div className="note-icon"><BookMarked size={18} /></div><div><h2>{activeMembership?.role === 'accounts_payable_officer' ? 'Accounts payable access' : activeMembership?.role === 'auditor' ? 'Read-only review access' : activeMembership?.role === 'librarian' ? 'Library workspace' : activeMembership?.role === 'website_editor' || activeMembership?.role === 'website_publisher' ? 'Website content access' : activeMembership?.role === 'admissions_officer' ? 'Admissions workspace' : activeMembership?.role === 'hr_staff_administrator' ? 'HR workspace' : ['transport_manager', 'facilities_manager', 'it_support_technician', 'safeguarding_officer', 'procurement_officer', 'compliance_audit_officer'].includes(activeMembership?.role ?? '') ? 'Operational workflow access' : 'One connected workspace'}</h2><p>{activeMembership?.role === 'accounts_payable_officer' ? 'Supplier invoice and payment workflows are not available yet. Your account is restricted to this workspace until those features are released.' : activeMembership?.role === 'auditor' ? 'You can review this school’s finance records and audit history. Your role cannot change or approve records.' : activeMembership?.role === 'librarian' ? 'Use the Library section to manage the catalogue, requests, checkouts, and returns.' : activeMembership?.role === 'website_editor' ? 'Create and submit website content drafts. Only a website publisher or school administrator can publish changes.' : activeMembership?.role === 'website_publisher' ? 'Review submitted school website drafts and publish approved content.' : activeMembership?.role === 'admissions_officer' ? 'Review, assign, and register admissions applications for your school.' : activeMembership?.role === 'hr_staff_administrator' ? 'Manage staff directory records and private staff documents. School membership and platform roles remain controlled by school administrators.' : activeMembership?.role === 'safeguarding_officer' ? 'Manage confidential safeguarding concerns and referrals. Access is limited to your school’s safeguarding workspace.' : ['transport_manager', 'facilities_manager', 'it_support_technician', 'procurement_officer', 'compliance_audit_officer'].includes(activeMembership?.role ?? '') ? 'Manage only your assigned operational domain and review its status history.' : 'School records, classes, and academic tools are scoped to your active school. Your data is loaded directly from the configured Supabase project.'}</p></div></section>
      </>}
    </div>
  );
}
