import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  BookMarked, BookOpenCheck, BookOpenText, CalendarDays, Check, ChevronDown,
  ChevronLeft, ClipboardCheck, GraduationCap, LayoutDashboard, LogOut, Menu,
  Settings, UsersRound, X, CalendarClock, CircleDollarSign, UserRoundPlus,
  Award, BriefcaseBusiness,
  MessageCircle, ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { ErrorState } from './Feedback';
import type { AppRole } from '../types/database';

const navigation: { title: string; items: { to: string; label: string; icon: LucideIcon; roles?: AppRole[] }[] }[] = [
  { title: 'Workspace', items: [
    { to: '/dashboard', label: 'Overview', icon: LayoutDashboard },
    { to: '/students', label: 'Students', icon: GraduationCap },
    { to: '/admissions', label: 'Admissions & enrolment', icon: UserRoundPlus, roles: ['school_admin'] },
    { to: '/staff', label: 'Staff & teachers', icon: BriefcaseBusiness, roles: ['school_admin', 'academic_coordinator', 'teacher'] },
    { to: '/classes', label: 'Classes', icon: UsersRound },
    { to: '/subjects', label: 'Subjects', icon: BookMarked },
  ] },
  { title: 'Academics', items: [
    { to: '/timetable', label: 'Timetable', icon: CalendarClock },
    { to: '/academic-calendar', label: 'Academic calendar', icon: CalendarDays },
    { to: '/attendance', label: 'Attendance', icon: ClipboardCheck },
    { to: '/learning', label: 'Learning', icon: BookOpenText },
    { to: '/grades-results', label: 'Grades & results', icon: Award, roles: ['school_admin', 'academic_coordinator', 'teacher', 'student', 'parent'] },
    { to: '/calendar', label: 'Calendar', icon: CalendarDays },
  ] },
  { title: 'Finance', items: [
    { to: '/finance', label: 'Student fees', icon: CircleDollarSign, roles: ['school_admin', 'finance_manager', 'accountant', 'bursar', 'cashier'] },
    { to: '/accounting-staff', label: 'Accounting staff', icon: UserRoundPlus, roles: ['school_admin'] },
  ] },
  { title: 'Communication', items: [
    { to: '/messaging', label: 'Messages', icon: MessageCircle },
    { to: '/audit-log', label: 'Audit log', icon: ShieldCheck, roles: ['school_admin'] },
  ] },
];

const pageNames: Record<string, string> = {
  '/dashboard': 'Overview', '/students': 'Students', '/admissions': 'Admissions & enrolment', '/teachers': 'Teachers', '/staff': 'Staff & teachers',
  '/classes': 'Classes', '/subjects': 'Subjects', '/timetable': 'Timetable', '/attendance': 'Attendance',
  '/learning': 'Learning', '/grades-results': 'Grades & results', '/calendar': 'Calendar', '/academic-calendar': 'Academic calendar', '/settings': 'Settings',
  '/finance': 'Student fees', '/accounting-staff': 'Accounting staff',
  '/messaging': 'Messages', '/audit-log': 'Audit log',
};

export function AppShell() {
  const { activeMembership, memberships, selectSchool, signOut, user } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [schoolMenuOpen, setSchoolMenuOpen] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const navigate = useNavigate();
  const location = useLocation();
  const title = pageNames[location.pathname] ?? 'Workspace';

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
        <a className="brand" href="/"><span className="brand-mark"><BookOpenCheck size={20} /></span><span>Campus Connect</span></a>
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
          const items = group.items.filter((item) => !item.roles || item.roles.includes(activeMembership?.role ?? 'student'));
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
        <div className="page-content">{logoutError && <ErrorState message={logoutError} />}<Outlet /></div>
        <footer className="workspace-footer"><span>Campus Connect</span><span>School information & learning management</span></footer>
      </main>
    </div>
  );
}
