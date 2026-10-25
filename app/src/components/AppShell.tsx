import { useEffect, useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  BookCopy, BookMarked, BookOpenCheck, BookOpenText, CalendarDays, Check, ChevronDown, ClipboardList, Library, Workflow, Globe,
  ChevronLeft, ClipboardCheck, GraduationCap, LayoutDashboard, LogOut, Menu,
  Settings, UsersRound, X, CalendarClock, CircleDollarSign, UserRoundPlus,
  Award, BriefcaseBusiness, FileStack, HeartPulse, ClipboardPlus,
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
    { to: '/account-security', label: 'Account security', icon: ShieldCheck },
    { to: '/permissions', label: 'Roles & permissions', icon: ShieldCheck, roles: ['school_admin'] },
    { to: '/academic-planning', label: 'Academic planning', icon: CalendarDays, roles: ['school_admin', 'academic_coordinator'] },
    { to: '/students', label: 'Students', icon: GraduationCap },
    { to: '/admissions', label: 'Admissions & enrolment', icon: UserRoundPlus, roles: ['school_admin', 'admissions_officer'], module: 'module_admissions' },
    { to: '/staff', label: 'Staff & teachers', icon: BriefcaseBusiness, roles: ['school_admin', 'academic_coordinator', 'teacher', 'hr_staff_administrator'] },
    { to: '/website-management', label: 'Website content', icon: Globe, roles: ['school_admin', 'website_editor', 'website_publisher'] },
    { to: '/admin-workflows', label: 'Administrative workflows', icon: BriefcaseBusiness, roles: ['school_admin', 'transport_manager', 'facilities_manager', 'it_support_technician', 'safeguarding_officer', 'procurement_officer', 'compliance_audit_officer'] },
    { to: '/automations', label: 'Automations', icon: Workflow, roles: ['school_admin', 'academic_coordinator'], module: 'module_automations' },
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
    { to: '/health', label: 'Health', icon: HeartPulse, roles: ['school_admin', 'nurse', 'doctor'], module: 'module_health' },
    { to: '/visitors', label: 'Visitors', icon: ClipboardPlus, roles: ['school_admin', 'secretary'], module: 'module_visitors' },
    { to: '/assignments', label: 'Assignments & homework', icon: ClipboardList, roles: ['school_admin', 'academic_coordinator', 'teacher', 'student', 'parent'], module: 'module_assignments' },
    { to: '/grades-results', label: 'Grades & results', icon: Award, roles: ['school_admin', 'academic_coordinator', 'teacher', 'student', 'parent'], module: 'module_assessment_results' },
    { to: '/calendar', label: 'Calendar', icon: CalendarDays },
  ] },
  { title: 'Finance', items: [
    { to: '/finance', label: 'Student fees', icon: CircleDollarSign, roles: ['school_admin', 'finance_manager', 'accountant', 'bursar', 'cashier', 'auditor'], module: 'module_finance' },
    { to: '/accounting-staff', label: 'Accounting & specialist staff', icon: UserRoundPlus, roles: ['school_admin'], module: 'module_finance' },
  ] },
  { title: 'Communication', items: [
    { to: '/messaging', label: 'Messages', icon: MessageCircle, module: 'module_messaging' },
    { to: '/audit-log', label: 'Audit log', icon: ShieldCheck, roles: ['school_admin', 'auditor', 'compliance_audit_officer'] },
  ] },
];

const teacherNavigation: typeof navigation = [
  { title: 'Teaching', items: [
    { to: '/dashboard', label: 'My dashboard', icon: LayoutDashboard },
    { to: '/timetable', label: 'My timetable', icon: CalendarClock, module: 'module_timetable' },
    { to: '/classes', label: 'My classes', icon: UsersRound },
    { to: '/subjects', label: 'My subjects', icon: BookMarked },
    { to: '/attendance', label: 'Attendance', icon: ClipboardCheck, module: 'module_attendance' },
    { to: '/learning', label: 'Assessments', icon: BookOpenCheck, module: 'module_learning' },
    { to: '/assignments', label: 'Assignments', icon: ClipboardList, module: 'module_assignments' },
    { to: '/grades-results', label: 'Grades & results', icon: Award, module: 'module_assessment_results' },
    { to: '/courses-lessons', label: 'Courses & lessons', icon: Library, module: 'module_learning' },
    { to: '/learning-materials', label: 'Learning materials', icon: FileStack, module: 'module_learning' },
    { to: '/calendar', label: 'Calendar', icon: CalendarDays },
    { to: '/messaging', label: 'Messages', icon: MessageCircle, module: 'module_messaging' },
  ] },
];

const pageNames: Record<string, string> = {
  '/dashboard': 'Overview', '/students': 'Students', '/admissions': 'Admissions & enrolment', '/teachers': 'Teachers', '/staff': 'Staff & teachers',
  '/classes': 'Classes', '/subjects': 'Subjects', '/timetable': 'Timetable', '/attendance': 'Attendance',
  '/learning': 'Learning', '/courses-lessons': 'Courses & lessons', '/learning-materials': 'Learning materials', '/assignments': 'Assignments & homework', '/grades-results': 'Grades & results', '/calendar': 'Calendar', '/academic-calendar': 'Academic calendar', '/settings': 'Settings',
  '/finance': 'Student fees', '/accounting-staff': 'Accounting & specialist staff',
  '/website-management': 'Website content', '/admin-workflows': 'Administrative workflows',
  '/account-security': 'Account security',
  '/permissions': 'Roles & permissions',
  '/academic-planning': 'Academic planning',
  '/automations': 'Automations',
  '/messaging': 'Messages', '/audit-log': 'Audit log',
  '/library': 'Library', '/health': 'Student health', '/health/report': 'Health report', '/visitors': 'Visitor management',
};

export function AppShell() {
  const { activeMembership, memberships, selectSchool, signOut, user } = useAuth();
  const { platformName, logoUrl, maintenanceNotice } = usePlatformBranding();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [schoolMenuOpen, setSchoolMenuOpen] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const [isHeadOfDepartment, setIsHeadOfDepartment] = useState(false);
  const [modules, setModules] = useState<Record<string, boolean> | null>(null);
  const [permissionSummary, setPermissionSummary] = useState<Record<string, Record<string, boolean>> | null>(null);
  const [modulesError, setModulesError] = useState('');
  const [maintenance, setMaintenance] = useState<{ active: boolean; scope: string | null; read_only: boolean; notice: string; ends_at: string | null; emergency: boolean } | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const isHealthcareRole = activeMembership?.role === 'nurse' || activeMembership?.role === 'doctor';
  const isSecretaryRole = activeMembership?.role === 'secretary';
  const isRestrictedRole = isHealthcareRole || isSecretaryRole;
  const limitedRolePaths: Partial<Record<AppRole, string[]>> = {
    auditor: ['/dashboard', '/finance', '/audit-log', '/account-security'],
    librarian: ['/dashboard', '/library', '/account-security'],
    accounts_payable_officer: ['/dashboard', '/account-security'],
    website_editor: ['/dashboard', '/website-management', '/account-security'],
    website_publisher: ['/dashboard', '/website-management', '/account-security'],
    admissions_officer: ['/dashboard', '/admissions', '/account-security'],
    hr_staff_administrator: ['/dashboard', '/staff', '/account-security'],
    transport_manager: ['/dashboard', '/admin-workflows', '/account-security'],
    facilities_manager: ['/dashboard', '/admin-workflows', '/account-security'],
    it_support_technician: ['/dashboard', '/admin-workflows', '/account-security'],
    safeguarding_officer: ['/dashboard', '/admin-workflows', '/account-security'],
    procurement_officer: ['/dashboard', '/admin-workflows', '/account-security'],
    compliance_audit_officer: ['/dashboard', '/admin-workflows', '/audit-log', '/account-security'],
  };
  const rolePaths = limitedRolePaths[activeMembership?.role ?? 'student'];
  const isLimitedRole = rolePaths !== undefined;
  const title = pageNames[location.pathname]
    ?? (location.pathname.startsWith('/health/report/') ? 'Health report' : location.pathname.startsWith('/visitors/verify/') ? 'Badge verification' : 'Workspace');
  const modulePath = location.pathname.startsWith('/health/report/')
    ? '/health'
    : location.pathname.startsWith('/visitors/verify/') ? '/visitors' : location.pathname;
  const isHealthRoute = modulePath === '/health';
  const isVisitorRoute = modulePath === '/visitors';
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
    '/automations': 'module_automations',
    '/messaging': 'module_messaging',
    '/library': 'module_library',
    '/health': 'module_health',
    '/visitors': 'module_visitors',
  };
  const permissionModuleForPath: Record<string, string> = {
    '/students': 'students',
    '/admissions': 'admissions',
    '/staff': 'staff',
    '/teachers': 'staff',
    '/website-management': 'website',
    '/admin-workflows': 'administrative_workflows',
    '/automations': 'academics',
    '/classes': 'academics',
    '/subjects': 'academics',
    '/academic-calendar': 'academics',
    '/timetable': 'timetable',
    '/attendance': 'attendance',
    '/learning': 'learning',
    '/courses-lessons': 'learning',
    '/learning-materials': 'learning',
    '/assignments': 'assignments',
    '/grades-results': 'assessment_results',
    '/calendar': 'academics',
    '/finance': 'finance',
    '/accounting-staff': 'finance',
    '/library': 'library',
    '/health': 'health',
    '/visitors': 'visitors',
    '/messaging': 'messaging',
    '/audit-log': 'audit',
  };
  const permissionModule = permissionModuleForPath[modulePath];
  const permissionDenied = Boolean(permissionModule && permissionSummary?.[permissionModule]?.access === false);
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
    '/automations': 'communication',
    '/messaging': 'messaging',
    '/library': 'library',
    '/health': 'health',
    '/visitors': 'visitors',
    '/students': 'students',
    '/teachers': 'staff',
    '/staff': 'staff',
    '/classes': 'academics',
    '/subjects': 'academics',
    '/calendar': 'calendar',
    '/academic-calendar': 'calendar',
  };
  const disabledModule = moduleForPath[modulePath] && modules?.[moduleForPath[modulePath]] === false;

  useEffect(() => {
    let active = true;
    setIsHeadOfDepartment(false);
    if (activeMembership?.role !== 'teacher' || !activeMembership.school_id || !user?.id) {
      return () => { active = false; };
    }
    void (async () => {
      try {
        const client = requireSupabase();
        const { data: teachers, error: teacherError } = await client.from('teacher_profiles')
          .select('id').eq('school_id', activeMembership.school_id).eq('profile_id', user.id);
        if (teacherError) throw teacherError;
        const teacherIds = (teachers ?? []).map((teacher) => teacher.id);
        if (!teacherIds.length) return;
        const { data: responsibilities, error: responsibilityError } = await client.from('teacher_responsibilities')
          .select('id').eq('school_id', activeMembership.school_id)
          .eq('responsibility_type', 'head_of_department').in('teacher_id', teacherIds);
        if (responsibilityError) throw responsibilityError;
        if (active) setIsHeadOfDepartment((responsibilities ?? []).length > 0);
      } catch (error) {
        console.error('Could not verify teacher responsibilities for navigation.', error);
      }
    })();
    return () => { active = false; };
  }, [activeMembership?.role, activeMembership?.school_id, user?.id]);

  useEffect(() => {
    let active = true;
    setModules(null);
    setModulesError('');
    if (!activeMembership) return () => { active = false; };
    void (async () => {
      try {
        const client = requireSupabase();
        const [moduleResult, maintenanceResult] = await Promise.all([
          isRestrictedRole
            ? client.rpc(isHealthcareRole ? 'health_access_enabled' : 'visitor_access_enabled', { target_school: activeMembership.school_id })
            : client.from('school_module_settings')
              .select('module_admissions,module_attendance,module_timetable,module_learning,module_assignments,module_assessment_results,module_finance,module_messaging,module_library,module_health,module_visitors,module_automations')
              .eq('school_id', activeMembership.school_id)
              .maybeSingle(),
          client.rpc('platform_maintenance_status', {
            target_school: activeMembership.school_id,
            target_module: maintenanceModuleForPath[modulePath] ?? null,
          }),
        ]);
        if (moduleResult.error) throw moduleResult.error;
        if (isRestrictedRole && typeof moduleResult.data !== 'boolean') throw new Error('Could not verify that this school module is enabled.');
        if (!isRestrictedRole && !moduleResult.data) throw new Error('School module settings are missing. Ask a school administrator to check the school setup.');
        if (maintenanceResult.error) throw maintenanceResult.error;
        if (!maintenanceResult.data || typeof maintenanceResult.data.active !== 'boolean') throw new Error('Maintenance status returned an invalid response.');
        if (active) {
          setModules(isRestrictedRole
            ? { [isHealthcareRole ? 'module_health' : 'module_visitors']: moduleResult.data === true }
            : moduleResult.data as Record<string, boolean>);
          setMaintenance(maintenanceResult.data);
        }
      } catch (error) {
        console.error('Could not load school feature availability.', error);
        if (active) setModulesError(error instanceof Error ? error.message : 'Could not load school feature availability.');
      }
    })();
    return () => { active = false; };
  }, [activeMembership?.school_id, location.pathname, isHealthcareRole, isRestrictedRole]);

  useEffect(() => {
    let active = true;
    if (!activeMembership?.school_id) {
      setPermissionSummary(null);
      return () => { active = false; };
    }
    setPermissionSummary(null);
    setModulesError('');
    void (async () => {
      try {
        const { data, error } = await requireSupabase().rpc('get_school_permission_summary', {
          target_school: activeMembership.school_id,
        });
        if (error) throw error;
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          throw new Error('The school permission summary returned an invalid response.');
        }
        if (active) setPermissionSummary(data as Record<string, Record<string, boolean>>);
      } catch (error) {
        console.error('Could not load school permission summary.', error);
        if (active) setModulesError(error instanceof Error ? error.message : 'Could not load school permissions.');
      }
    })();
    return () => { active = false; };
  }, [activeMembership?.school_id]);

  useEffect(() => {
    if (!activeMembership) return;
    let active = true;
    const refreshStatus = async () => {
      try {
        const { data, error } = await requireSupabase().rpc('platform_maintenance_status', {
          target_school: activeMembership.school_id,
          target_module: maintenanceModuleForPath[modulePath] ?? null,
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

  useEffect(() => {
    const targetSchoolId = activeMembership?.school_id;
    if (!targetSchoolId || !user?.id || typeof PerformanceObserver === 'undefined') return;

    let largestContentfulPaint = 0;
    let cumulativeLayoutShift = 0;
    let interactionToNextPaint = 0;
    let hasLayoutShift = false;
    let hasInteraction = false;
    let disposed = false;
    let persisting = false;
    let persistAgain = false;
    let persistTimer: number | undefined;
    const sessionId = crypto.randomUUID();
    const observers: { observer: PerformanceObserver; consume: (entry: PerformanceEntry) => void }[] = [];

    const observe = (type: string, consume: (entry: PerformanceEntry) => void) => {
      if (!PerformanceObserver.supportedEntryTypes.includes(type)) return;
      const observer = new PerformanceObserver((list) => {
        list.getEntries().forEach(consume);
        schedulePersist();
      });
      observer.observe({ type, buffered: true });
      observers.push({ observer, consume });
    };

    observe('largest-contentful-paint', (entry) => {
      largestContentfulPaint = Math.max(largestContentfulPaint, entry.startTime);
    });
    observe('layout-shift', (entry) => {
      const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
      if (!shift.hadRecentInput) {
        cumulativeLayoutShift += shift.value;
        hasLayoutShift = true;
      }
    });
    observe('event', (entry) => {
      const event = entry as PerformanceEntry & { interactionId?: number };
      if ((event.interactionId ?? 0) > 0) {
        interactionToNextPaint = Math.max(interactionToNextPaint, entry.duration);
        hasInteraction = true;
      }
    });

    const persistMetrics = async () => {
      if (persisting) {
        persistAgain = true;
        return;
      }
      observers.forEach(({ observer, consume }) => observer.takeRecords().forEach(consume));
      if (persistTimer !== undefined) {
        window.clearTimeout(persistTimer);
        persistTimer = undefined;
      }
      const metrics = [
        ...(largestContentfulPaint > 0 ? [{ school_id: targetSchoolId, profile_id: user.id, session_id: sessionId, metric_name: 'lcp', metric_value: largestContentfulPaint }] : []),
        ...(hasLayoutShift ? [{ school_id: targetSchoolId, profile_id: user.id, session_id: sessionId, metric_name: 'cls', metric_value: cumulativeLayoutShift }] : []),
        ...(hasInteraction ? [{ school_id: targetSchoolId, profile_id: user.id, session_id: sessionId, metric_name: 'inp', metric_value: interactionToNextPaint }] : []),
      ];
      if (metrics.length === 0) return;
      persisting = true;
      try {
        const { error } = await requireSupabase().from('platform_performance_metrics').upsert(metrics, {
          onConflict: 'school_id,profile_id,session_id,metric_name',
        });
        if (error) throw error;
      } catch (error) {
        console.error('Could not record platform performance metrics.', error);
      } finally {
        persisting = false;
        if (persistAgain) {
          persistAgain = false;
          void persistMetrics();
        }
      }
    };

    function schedulePersist() {
      if (disposed) return;
      if (persistTimer !== undefined) window.clearTimeout(persistTimer);
      persistTimer = window.setTimeout(() => { void persistMetrics(); }, 1500);
    }

    window.addEventListener('pagehide', persistMetrics);
    return () => {
      disposed = true;
      void persistMetrics();
      window.removeEventListener('pagehide', persistMetrics);
      observers.forEach(({ observer }) => observer.disconnect());
    };
  }, [activeMembership?.school_id, user?.id]);

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
    const roleNavigation = isLimitedRole
      ? navigation.map((group) => ({ ...group, items: group.items.filter((item) => rolePaths.includes(item.to)) }))
        .filter((group) => group.items.length > 0)
      : activeMembership?.role === 'teacher'
      ? teacherNavigation.map((group) => group.title === 'Teaching' && isHeadOfDepartment
        ? { ...group, items: [...group.items, { to: '/staff', label: 'Department staff', icon: BriefcaseBusiness }] }
        : group)
      : navigation;
    const visibleNavigation = isRestrictedRole
      ? roleNavigation.map((group) => ({
        ...group,
        items: group.items.filter((item) => item.to === (isHealthcareRole ? '/health' : '/visitors')),
      })).filter((group) => group.items.length > 0)
      : roleNavigation;
    return <>
      <div className="sidebar-top">
        <a className="brand" href="/"><span className="brand-mark">{logoUrl ? <img src={logoUrl} alt="" /> : <BookOpenCheck size={20} />}</span><span>{platformName}</span></a>
        <button className="icon-button mobile-close" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X size={20} /></button>
      </div>
      {!isRestrictedRole && !isLimitedRole && <div className="school-picker-wrap">
        <button className="school-picker" onClick={() => setSchoolMenuOpen(!schoolMenuOpen)} aria-expanded={schoolMenuOpen}>
          <span className="school-monogram">{activeMembership?.school.name.slice(0, 1).toUpperCase() ?? 'S'}</span>
          <span className="school-picker-copy"><strong>{activeMembership?.school.name}</strong><small>{activeMembership?.role.replace(/_/g, ' ')}</small></span>
          <ChevronDown size={16} />
        </button>
        {schoolMenuOpen && <div className="school-menu">{memberships.map((membership) => <button key={membership.school_id} onClick={() => { selectSchool(membership.school_id); setSchoolMenuOpen(false); setMobileOpen(false); }}><span>{membership.school.name}</span>{membership.school_id === activeMembership?.school_id && <Check size={15} />}</button>)}</div>}
      </div>}
      <nav className="side-navigation" aria-label="Main navigation">
        {visibleNavigation.map((group) => {
          const items = group.items.filter((item) => (!item.roles || item.roles.includes(activeMembership?.role ?? 'student'))
            && (!item.module || modules?.[item.module] !== false)
            && (!permissionModuleForPath[item.to] || permissionSummary?.[permissionModuleForPath[item.to]]?.access !== false));
          return items.length ? <div className="nav-group" key={group.title}><span className="nav-label">{group.title}</span>{items.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} onClick={() => setMobileOpen(false)} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}><Icon size={18} strokeWidth={1.8} /><span>{label}</span></NavLink>)}</div> : null;
        })}
      </nav>
      <div className="sidebar-bottom">
        {!isRestrictedRole && !isLimitedRole && !isAccountingRole && activeMembership?.role !== 'teacher' && <NavLink to="/settings" onClick={() => setMobileOpen(false)} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}><Settings size={18} strokeWidth={1.8} /><span>Settings</span></NavLink>}
        <div className="profile-row"><span className="avatar">{(user?.user_metadata.full_name as string | undefined)?.slice(0, 1).toUpperCase() ?? user?.email?.slice(0, 1).toUpperCase()}</span><span className="profile-copy"><strong>{(user?.user_metadata.full_name as string | undefined) ?? user?.email}</strong><small>{user?.email}</small></span><button className="icon-button" onClick={() => void logout()} aria-label="Sign out"><LogOut size={17} /></button></div>
      </div>
    </>;
  }

  if (isHealthcareRole && !isHealthRoute) return <Navigate to="/health" replace />;
  if (isSecretaryRole && !isVisitorRoute) return <Navigate to="/visitors" replace />;
  if (rolePaths && !rolePaths.includes(modulePath)) return <Navigate to="/dashboard" replace />;
  if (location.pathname === '/permissions' && activeMembership?.role !== 'school_admin') return <Navigate to="/dashboard" replace />;

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
          {permissionDenied
            ? <section className="content-card"><ErrorState message="Your current role permissions do not allow access to this module. Contact a school administrator if you need access." /></section>
            : modulesError
              ? <ErrorState message={modulesError} />
              : modules === null || maintenance === null
                ? <LoadingState label="Loading school features…" />
                : maintenance.active && !maintenance.read_only
                  ? <section className="content-card school-maintenance-block"><span className="brand-mark"><ShieldCheck size={20} /></span><span className="eyebrow">Maintenance in progress</span><h1>{maintenance.emergency ? 'Emergency maintenance' : 'This workspace is temporarily unavailable'}</h1><p>{maintenance.notice || maintenanceNotice || 'Campus Connect is undergoing maintenance. Please try again later.'}</p>{maintenance.ends_at && <small>Scheduled to end {new Date(maintenance.ends_at).toLocaleString()}.</small>}<button className="button button-quiet" onClick={() => void logout()}><LogOut size={14} /> Sign out</button></section>
                  : disabledModule
                    ? <section className="content-card system-owner-panel"><h2>This feature is unavailable</h2><p className="system-owner-muted">This module is disabled for your school by platform or school settings.</p></section>
                    : <Outlet />}
        </div>
        <footer className="workspace-footer"><span>Campus Connect</span><span>School information & learning management</span></footer>
      </main>
    </div>
  );
}
