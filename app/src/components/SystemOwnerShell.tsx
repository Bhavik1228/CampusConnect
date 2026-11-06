import { useState } from 'react';
import { AlertTriangle, Building2, Gauge, LifeBuoy, LogOut, Menu, Settings, ShieldAlert, X } from 'lucide-react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { ErrorState } from './Feedback';

const links = [
  { to: '/system-owner', label: 'Overview', icon: Gauge, end: true },
  { to: '/system-owner/schools', label: 'School management', icon: Building2 },
  { to: '/system-owner/settings', label: 'Platform settings', icon: Settings },
  { to: '/system-owner/maintenance', label: 'Maintenance mode', icon: ShieldAlert },
  { to: '/system-owner/errors', label: 'Error dashboard', icon: AlertTriangle },
  { to: '/system-owner/support', label: 'Support requests', icon: LifeBuoy },
];

const titles: Record<string, string> = {
  '/system-owner': 'Overview',
  '/system-owner/schools': 'School management',
  '/system-owner/settings': 'Platform settings',
  '/system-owner/maintenance': 'Maintenance mode',
  '/system-owner/errors': 'Error dashboard',
  '/system-owner/support': 'Support requests',
};

export function SystemOwnerShell() {
  const { user, signOut } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const navigate = useNavigate();
  const location = useLocation();

  async function logout() {
    setLogoutError('');
    try {
      await signOut();
      navigate('/login');
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : 'Could not sign out.');
    }
  }

  function sidebar() {
    return <>
      <div className="sidebar-top"><a className="brand" href="/system-owner"><span className="brand-mark"><ShieldAlert size={19} /></span><span>Platform owner</span></a><button className="icon-button mobile-close" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X size={20} /></button></div>
      <nav className="side-navigation system-owner-navigation" aria-label="System owner navigation">
        <span className="nav-label">Platform controls</span>
        {links.map(({ to, label, icon: Icon, end }) => <NavLink key={to} to={to} end={end} onClick={() => setMobileOpen(false)} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}><Icon size={18} strokeWidth={1.8} /><span>{label}</span></NavLink>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="profile-row"><span className="avatar">{user?.email?.slice(0, 1).toUpperCase()}</span><span className="profile-copy"><strong>System owner</strong><small>{user?.email}</small></span><button className="icon-button" onClick={() => void logout()} aria-label="Sign out"><LogOut size={17} /></button></div>
      </div>
    </>;
  }

  return <div className="app-layout system-owner-layout">
    <aside className="sidebar desktop-sidebar">{sidebar()}</aside>
    {mobileOpen && <div className="mobile-backdrop" onClick={() => setMobileOpen(false)}><aside className="sidebar mobile-sidebar" onClick={(event) => event.stopPropagation()}>{sidebar()}</aside></div>}
    <main className="workspace">
      <header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu size={21} /></button><span className="breadcrumbs">System owner <strong>{titles[location.pathname] ?? 'Platform control'}</strong></span></div><span className="role-badge"><span></span>system owner</span></header>
      <div className="page-content">{logoutError && <ErrorState message={logoutError} />}<Outlet /></div>
      <footer className="workspace-footer"><span>Campus Connect</span><span>Exclusive platform administration</span></footer>
    </main>
  </div>;
}
