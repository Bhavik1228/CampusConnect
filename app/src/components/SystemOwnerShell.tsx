import { useEffect, useState } from 'react';
import {
  Accessibility, Activity, AlertTriangle, Building2, ChevronDown, Gauge, History, LifeBuoy,
  LogOut, Menu, Server, Settings, ShieldAlert, X,
  type LucideIcon,
} from 'lucide-react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { ErrorState } from './Feedback';

type OwnerNavigationItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  nested?: boolean;
};

type OwnerNavigationGroup = {
  id: string;
  title: string;
  icon: LucideIcon;
  items: OwnerNavigationItem[];
};

const groups: OwnerNavigationGroup[] = [
  {
    id: 'schools',
    title: 'School Management',
    icon: Building2,
    items: [{ to: '/system-owner/schools', label: 'All schools', icon: Building2 }],
  },
  {
    id: 'configuration',
    title: 'Platform Configuration',
    icon: Settings,
    items: [{ to: '/system-owner/settings', label: 'Platform settings', icon: Settings }],
  },
  {
    id: 'security',
    title: 'Security & Compliance',
    icon: Accessibility,
    items: [{ to: '/system-owner/accessibility', label: 'Accessibility & browser tests', icon: Accessibility }],
  },
  {
    id: 'operations',
    title: 'Operations & Monitoring',
    icon: Activity,
    items: [
      { to: '/system-owner/errors', label: 'Error dashboard', icon: AlertTriangle, end: true },
      { to: '/system-owner/errors/incidents', label: 'System incident log', icon: AlertTriangle, nested: true },
      { to: '/system-owner/performance', label: 'Performance monitoring', icon: Activity },
      { to: '/system-owner/api-health', label: 'API health', icon: Server },
      { to: '/system-owner/usage-analytics', label: 'Platform usage analytics', icon: Gauge },
    ],
  },
  {
    id: 'support',
    title: 'Support Centre',
    icon: LifeBuoy,
    items: [{ to: '/system-owner/support', label: 'Support requests', icon: LifeBuoy }],
  },
  {
    id: 'releases',
    title: 'Releases & Maintenance',
    icon: History,
    items: [
      { to: '/system-owner/maintenance', label: 'Maintenance mode', icon: ShieldAlert },
      { to: '/system-owner/releases', label: 'Release history', icon: History },
    ],
  },
];

const titles: Record<string, string> = {
  '/system-owner': 'Overview',
  '/system-owner/schools': 'All schools',
  '/system-owner/settings': 'Platform settings',
  '/system-owner/maintenance': 'Maintenance mode',
  '/system-owner/errors': 'Error dashboard',
  '/system-owner/errors/incidents': 'System incident log',
  '/system-owner/performance': 'Performance monitoring',
  '/system-owner/api-health': 'API health',
  '/system-owner/usage-analytics': 'Platform usage analytics',
  '/system-owner/releases': 'Release history',
  '/system-owner/accessibility': 'Accessibility & browser tests',
  '/system-owner/support': 'Support requests',
};

export function SystemOwnerShell() {
  const { user, signOut } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [logoutError, setLogoutError] = useState('');
  const navigate = useNavigate();
  const location = useLocation();
  const activeGroup = groups.find((group) => group.items.some(({ to }) =>
    location.pathname === to || location.pathname.startsWith(`${to}/`)));
  const pageTitle = titles[location.pathname] ?? 'Platform administration';

  useEffect(() => {
    setExpandedGroup(activeGroup?.id ?? null);
  }, [activeGroup?.id, location.pathname]);

  useEffect(() => {
    document.title = `${pageTitle} · Campus Connect`;
  }, [pageTitle]);

  async function logout() {
    setLogoutError('');
    try {
      await signOut();
      navigate('/login');
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : 'Could not sign out.');
    }
  }

  function sidebar(side: 'desktop' | 'mobile') {
    return <>
      <div className="sidebar-top">
        <NavLink className="brand" to="/system-owner" end onClick={() => setMobileOpen(false)}>
          <span className="brand-mark"><ShieldAlert size={19} /></span><span>Platform owner</span>
        </NavLink>
        <button className="icon-button mobile-close" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X size={20} /></button>
      </div>
      <nav className="side-navigation system-owner-navigation" aria-label="System owner navigation">
        <NavLink to="/system-owner" end onClick={() => setMobileOpen(false)} className={({ isActive }) => `nav-item dashboard-nav-item${isActive ? ' active' : ''}`}>
          <Gauge size={18} strokeWidth={1.8} /><span>Overview</span>
        </NavLink>
        {groups.map((group) => {
          const Icon = group.icon;
          const expanded = expandedGroup === group.id;
          const active = activeGroup?.id === group.id;
          const groupId = `${side}-owner-navigation-${group.id}`;
          return <section className={`nav-group${active ? ' has-active-route' : ''}`} key={group.id}>
            <button
              type="button"
              className={`nav-group-toggle${active ? ' active' : ''}`}
              onClick={() => setExpandedGroup(expanded ? null : group.id)}
              aria-expanded={expanded}
              aria-controls={groupId}
            >
              <Icon size={18} strokeWidth={1.8} />
              <span>{group.title}</span>
              <ChevronDown size={15} className={expanded ? 'nav-group-chevron expanded' : 'nav-group-chevron'} aria-hidden="true" />
            </button>
            <div id={groupId} className="nav-group-items" hidden={!expanded}>
              {group.items.map(({ to, label, icon: ItemIcon, end, nested }) =>
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  onClick={() => setMobileOpen(false)}
                  className={({ isActive }) => `nav-item${isActive ? ' active' : ''}${nested ? ' nav-item-child' : ''}`}
                >
                  <ItemIcon size={17} strokeWidth={1.8} /><span>{label}</span>
                </NavLink>)}
            </div>
          </section>;
        })}
      </nav>
      <div className="sidebar-bottom">
        <div className="profile-row">
          <span className="avatar">{user?.email?.slice(0, 1).toUpperCase()}</span>
          <span className="profile-copy"><strong>System owner</strong><small>{user?.email}</small></span>
          <button className="icon-button" onClick={() => void logout()} aria-label="Sign out"><LogOut size={17} /></button>
        </div>
      </div>
    </>;
  }

  return <div className="app-layout system-owner-layout">
    <aside className="sidebar desktop-sidebar">{sidebar('desktop')}</aside>
    {mobileOpen && <div className="mobile-backdrop" onClick={() => setMobileOpen(false)}>
      <aside className="sidebar mobile-sidebar" onClick={(event) => event.stopPropagation()}>{sidebar('mobile')}</aside>
    </div>}
    <main className="workspace">
      <header className="topbar">
        <div className="topbar-left">
          <button className="icon-button mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu size={21} /></button>
          <span className="breadcrumbs">System owner <strong>{activeGroup ? `${activeGroup.title} / ${pageTitle}` : pageTitle}</strong></span>
        </div>
        <span className="role-badge"><span></span>system owner</span>
      </header>
      <div className="page-content">{logoutError && <ErrorState message={logoutError} />}<Outlet /></div>
      <footer className="workspace-footer"><span>Campus Connect</span><span>Exclusive platform administration</span></footer>
    </main>
  </div>;
}
