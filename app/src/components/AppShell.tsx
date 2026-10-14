import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  BookCopy, BookMarked, BookOpenCheck, BookOpenText, CalendarDays, Check, ChevronDown, ClipboardList, Library,
  ChevronLeft, ClipboardCheck, GraduationCap, LayoutDashboard, LogOut, Menu,
  Settings, UsersRound, X, CalendarClock, CircleDollarSign, UserRoundPlus,
  Award, BriefcaseBusiness, FileStack,
  MessageCircle, ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { usePlatformBranding } from '../contexts/PlatformBrandingContext';
import { ErrorState, LoadingState } from './Feedback';
import type { AppRole } from '../types/database';
import { requireSupabase } from '../lib/supabase';

const navigation: { title: string; items: { to: string; label: string; icon: LucideIcon; roles?: AppRole[]; module?: string }[] }[] = [
  { title: 'Workspace', items: [
    { to: '/dashboard', label: 'Overview', icon: LayoutDashboard },
    { to: '/students', label: 'Students', icon: GraduationCap },
    { to: '/admissions', label: 'Admissions & enrolment', icon: UserRoundPlus, roles: ['school_admin'], module: 'module_admissions' },
    { to: '/staff', label: 'Staff & teachers', icon: BriefcaseBusiness, roles: ['school_admin', 'academic_coordinator', 'teacher'] },
    { to: '/classes', label: 'Classes', icon: UsersRound },
    { to: '/subjects', label: 'Subjects', icon: BookMarked },
  ] },
  { title: 'Academics', items: [
    { to: '/timetable', label: 'Timetable', icon: CalendarClock, module: 'module_timetable' },
    { to: '/academic-calendar', label: 'Academic calendar', icon: CalendarDays },
    { to: '/attendance', label: 'Attendance', icon: ClipboardCheck, module: 'module_attendance' },
    { to: '/learning', label: 'Learning', icon: BookOpenText, module: 'module_learning' },
    { to: '/courses-lessons', label: 'Courses & lessons', icon: Library, module: 'module_learning' },
    { to: '/learning-materials', label: 'Learning materials', icon: FileStack, module: 'module_learning' },
    { to: '/library', label: 'Library', icon: BookCopy, module: 'module_library' },
    { to: '/assignments', label: 'Assignments & homework', icon: ClipboardList, roles: ['school_admin', 'academic_coordinator', 'teacher', 'student', 'parent'], module: 'module_assignments' },
    { to: '/grades-results', label: 'Grades & results', icon: Award, roles: ['school_admin', 'academic_coordinator', 'teacher', 'student', 'parent'], module: 'module_assessment_results' },
    { to: '/calendar', label: 'Calendar', icon: CalendarDays },
  ] },
  { title: 'Finance', items: [
    { to: '/finance', label: 'Student fees', icon: CircleDollarSign, roles: ['school_admin', 'finance_manager', 'accountant', 'bursar', 'cashier'], module: 'module_finance' },
    { to: '/accounting-staff', label: 'Accounting staff', icon: UserRoundPlus, roles: ['school_admin'], module: 'module_finance' },
  ] },
  { title: 'Communication', items: [
    { to: '/messaging', label: 'Messages', icon: MessageCircle, module: 'module_messaging' },
    { to: '/audit-log', label: 'Audit log', icon: ShieldCheck, roles: ['school_admin'] },
  ] },
];

const pageNames: Record<string, string> = {
  '/dashboard': 'Overview', '/students': 'Students', '/admissions': 'Admissions & enrolment', '/teachers': 'Teachers', '/staff': 'Staff & teachers',
  '/classes': 'Classes', '/subjects': 'Subjects', '/timetable': 'Timetable', '/attendance': 'Attendance',
  '/learning': 'Learning', '/courses-lessons': 'Courses & lessons', '/learning-materials': 'Learning materials', '/assignments': 'Assignments & homework', '/grades-results': 'Grades & results', '/calendar': 'Calendar', '/academic-calendar': 'Academic calendar', '/settings': 'Settings',
  '/finance': 'Student fees', '/accounting-staff': 'Accounting staff',
  '/messaging': 'Messages', '/audit-log': 'Audit log',
  '/library': 'Library',
};

export function AppShell() {
  const { activeMembership, memberships, selectSchool, signOut, user } = useAuth();
  const { platformName, logoUrl, maintenanceNotice } = usePlatformBranding();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [schoolMenuOpen, setSchoolMenuOpen] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const [modules, setModules] = useState<Record<string, boolean> | null>(null);
  const [modulesError, setModulesError] = useState('');
  const [maintenance, setMaintenance] = useState<{ active: boolean; scope: string | null; read_only: boolean; notice: string; ends_at: string | null; emergency: boolean } | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const title = pageNames[location.pathname] ?? 'Workspace';
  const moduleForPath: Record<string, string> = {
    '/admissions': 'module_admissions',
    '/timetable': 'module_timetable',
    '/attendance': 'module_attendance',
    '/learning': 'module_learning',
    '/courses-lessons': 'module_learning',
    '/learning-materials': 'module_learning',
    '/assignments': 'module_assignments',
    '/grades-results': 'module_assessment_results',
    '/finance': 'module_finance',
    '/accounting-staff': 'module_finance',
    '/messaging': 'module_messaging',
    '/library': 'module_library',
  };
  const maintenanceModuleForPath: Record<string, string> = {
    '/admissions': 'admissions',
    '/timetable': 'timetable',
    '/attendance': 'attendance',
    '/learning': 'learning',
    '/courses-lessons': 'learning',
    '/learning-materials': 'learning',
    '/assignments': 'assignments',
    '/grades-results': 'grades',
    '/finance': 'finance',
    '/accounting-staff': 'finance',
    '/messaging': 'messaging',
    '/library': 'library',
    '/students': 'students',
    '/teachers': 'staff',
    '/staff': 'staff',
    '/classes': 'academics',
    '/subjects': 'academics',
    '/calendar': 'calendar',
    '/academic-calendar': 'calendar',
  };
  const disabledModule = moduleForPath[location.pathname] && modules?.[moduleForPath[location.pathname]] === false;

  useEffect(() => {
    let active = true;
    setModules(null);
    setModulesError('');
    if (!activeMembership) return () => { active = false; };
    void (async () => {
      try {
        const [moduleResult, maintenanceResult] = await Promise.all([
          requireSupabase().from('school_module_settings')
            .select('module_admissions,module_attendance,module_timetable,module_learning,module_assignments,module_assessment_results,module_finance,module_messaging,module_library')
            .eq('school_id', activeMembership.school_id)
            .maybeSingle(),
          requireSupabase().rpc('platform_maintenance_status', {
            target_school: activeMembership.school_id,
            target_module: maintenanceModuleForPath[location.pathname] ?? null,
          }),
        ]);
        if (moduleResult.error) throw moduleResult.error;
        if (!moduleResult.data) throw new Error('School module settings are missing. Ask a school administrator to check the school setup.');
        if (maintenanceResult.error) throw maintenanceResult.error;
        if (!maintenanceResult.data || typeof maintenanceResult.data.active !== 'boolean') throw new Error('Maintenance status returned an invalid response.');
        if (active) {
          setModules(moduleResult.data as Record<string, boolean>);
          setMaintenance(maintenanceResult.data);
        }
      } catch (error) {
        console.error('Could not load school feature availability.', error);
        if (active) setModulesError(error instanceof Error ? error.message : 'Could not load school feature availability.');
      }
    })();
    return () => { active = false; };
  }, [activeMembership?.school_id, location.pathname]);

  useEffect(() => {
    if (!activeMembership) return;
    let active = true;
    const refreshStatus = async () => {
      try {
        const { data, error } = await requireSupabase().rpc('platform_maintenance_status', {
          target_school: activeMembership.school_id,
          target_module: maintenanceModuleForPath[location.pathname] ?? null,
        });
        if (error) throw error;
        if (!data || typeof data.active !== 'boolean') throw new Error('Maintenance status returned an invalid response.');
        if (active) setMaintenance(data);
      } catch (error) {
        console.error('Could not refresh maintenance status.', error);
        if (active) setModulesError(error instanceof Error ? error.message : 'Could not refresh maintenance status.');
      }
    };
    const timer = window.setInterval(() => { void refreshStatus(); }, 20_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [activeMembership?.school_id, location.pathname]);

  async function logout() {
    setLogoutError('');
    try {
      await signOut();
      navigate('/login');
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : 'Could not sign out.');
    }
  }

  function sidebarContent() {
    const isAccountingRole = ['finance_manager', 'accountant', 'bursar', 'cashier'].includes(activeMembership?.role ?? '');
    return <>
      <div className="sidebar-top">
        <a className="brand" href="/"><span className="brand-mark">{logoUrl ? <img src={logoUrl} alt="" /> : <BookOpenCheck size={20} />}</span><span>{platformName}</span></a>
        <button className="icon-button mobile-close" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X size={20} /></button>
      </div>
      <div className="school-picker-wrap">
        <button className="school-picker" onClick={() => setSchoolMenuOpen(!schoolMenuOpen)} aria-expanded={schoolMenuOpen}>
          <span className="school-monogram">{activeMembership?.school.name.slice(0, 1).toUpperCase() ?? 'S'}</span>
          <span className="school-picker-copy"><strong>{activeMembership?.school.name}</strong><small>{activeMembership?.role.replace(/_/g, ' ')}</small></span>
          <ChevronDown size={16} />
        </button>
        {schoolMenuOpen && <div className="school-menu">{memberships.map((membership) => <button key={membership.school_id} onClick={() => { selectSchool(membership.school_id); setSchoolMenuOpen(false); setMobileOpen(false); }}><span>{membership.school.name}</span>{membership.school_id === activeMembership?.school_id && <Check size={15} />}</button>)}</div>}
      </div>
      <nav className="side-navigation" aria-label="Main navigation">
        {navigation.map((group) => {
          const items = group.items.filter((item) => (!item.roles || item.roles.includes(activeMembership?.role ?? 'student'))
            && (!item.module || modules?.[item.module] !== false));
          return items.length ? <div className="nav-group" key={group.title}><span className="nav-label">{group.title}</span>{items.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} onClick={() => setMobileOpen(false)} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}><Icon size={18} strokeWidth={1.8} /><span>{label}</span></NavLink>)}</div> : null;
        })}
      </nav>
      <div className="sidebar-bottom">
        {!isAccountingRole && <NavLink to="/settings" onClick={() => setMobileOpen(false)} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}><Settings size={18} strokeWidth={1.8} /><span>Settings</span></NavLink>}
        <div className="profile-row"><span className="avatar">{(user?.user_metadata.full_name as string | undefined)?.slice(0, 1).toUpperCase() ?? user?.email?.slice(0, 1).toUpperCase()}</span><span className="profile-copy"><strong>{(user?.user_metadata.full_name as string | undefined) ?? user?.email}</strong><small>{user?.email}</small></span><button className="icon-button" onClick={() => void logout()} aria-label="Sign out"><LogOut size={17} /></button></div>
      </div>
    </>;
  }

  return (
    <div className="app-layout">
      <aside className="sidebar desktop-sidebar">{sidebarContent()}</aside>
      {mobileOpen && <div className="mobile-backdrop" onClick={() => setMobileOpen(false)}><aside className="sidebar mobile-sidebar" onClick={(event) => event.stopPropagation()}>{sidebarContent()}</aside></div>}
      <main className="workspace">
        <header className="topbar">
          <div className="topbar-left"><button className="icon-button mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu size={21} /></button><span className="breadcrumbs">Workspace <ChevronLeft size={14} className="crumb-chevron" /> <strong>{title}</strong></span></div>
          <div className="topbar-actions"><span className="role-badge"><span></span>{activeMembership?.role.replace(/_/g, ' ')}</span></div>
        </header>
        <div className="page-content">
          {maintenance?.active && <aside className="platform-maintenance-notice" role="status">{maintenance.notice || maintenanceNotice || 'Maintenance is in progress.'}{maintenance.read_only ? ' This workspace is read-only; changes are temporarily disabled.' : ''}{maintenance.ends_at ? ` Scheduled until ${new Date(maintenance.ends_at).toLocaleString()}.` : ''}</aside>}
          {!maintenance?.active && maintenanceNotice && <aside className="platform-maintenance-notice" role="status">{maintenanceNotice}</aside>}
          {logoutError && <ErrorState message={logoutError} />}
          {modulesError ? <ErrorState message={modulesError} /> : modules === null || maintenance === null ? <LoadingState label="Loading school features…" /> : maintenance.active && !maintenance.read_only ? <section className="content-card school-maintenance-block"><span className="brand-mark"><ShieldCheck size={20} /></span><span className="eyebrow">Maintenance in progress</span><h1>{maintenance.emergency ? 'Emergency maintenance' : 'This workspace is temporarily unavailable'}</h1><p>{maintenance.notice || maintenanceNotice || 'Campus Connect is undergoing maintenance. Please try again later.'}</p>{maintenance.ends_at && <small>Scheduled to end {new Date(maintenance.ends_at).toLocaleString()}.</small>}<button className="button button-quiet" onClick={() => void logout()}><LogOut size={14} /> Sign out</button></section> : disabledModule ? <section className="content-card system-owner-panel"><h2>This feature is unavailable</h2><p className="system-owner-muted">This module is disabled for your school by platform or school settings.</p></section> : <Outlet />}
        </div>
        <footer className="workspace-footer"><span>Campus Connect</span><span>School information & learning management</span></footer>
      </main>
    </div>
  );
}
