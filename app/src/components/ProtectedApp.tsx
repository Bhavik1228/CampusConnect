import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { isSupabaseConfigured } from '../lib/supabase';
import { AppShell } from './AppShell';
import { AuthScreen } from './AuthScreen';
import { LoadingState } from './Feedback';
import { SchoolSetup } from './SchoolSetup';
import { DashboardPage } from '../pages/DashboardPage';
import { DirectoryPage } from '../pages/DirectoryPage';
import { AcademicPages } from '../pages/AcademicPages';
import { AttendancePage } from '../pages/AttendancePage';
import { SchoolSettingsPage } from '../pages/SchoolSettingsPage';
import { LandingPage } from '../pages/LandingPage';

function RouteGate({ authOnly = true }: { authOnly?: boolean }) {
  const { user, loading, memberships } = useAuth();
  if (!isSupabaseConfigured) return <SetupRequired />;
  if (loading) return <div className="full-screen-loading"><LoadingState /></div>;
  if (authOnly && !user) return <Navigate to="/login" replace />;
  if (user && authOnly && memberships.length === 0) return <SchoolSetup />;
  return <Outlet />;
}

function SetupRequired() {
  return <main className="config-page"><div className="config-card"><span className="brand-mark"><BookOpenCheckIcon /></span><span className="eyebrow">One setup step remaining</span><h1>Connect your Supabase project</h1><p>The app is configured to use Supabase Auth and PostgreSQL, but no project credentials are present yet. Add the public project URL and anon key to your local <code>.env</code> file.</p><pre>VITE_SUPABASE_URL=https://your-project.supabase.co{'\n'}VITE_SUPABASE_ANON_KEY=your-anon-key</pre><p>Then apply the migration in <code>supabase/migrations</code> using the Supabase CLI or SQL editor, and restart the dev server. Never put a service-role key in this app.</p></div></main>;
}

function BookOpenCheckIcon() {
  return <span aria-hidden="true">CC</span>;
}

export function ProtectedApp() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginRoute />} />
      <Route element={<RouteGate />}>
        <Route element={<AppShell />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/students" element={<DirectoryPage kind="students" />} />
          <Route path="/teachers" element={<DirectoryPage kind="teachers" />} />
          <Route path="/classes" element={<DirectoryPage kind="classes" />} />
          <Route path="/subjects" element={<DirectoryPage kind="subjects" />} />
          <Route path="/attendance" element={<AttendancePage />} />
          <Route path="/learning" element={<AcademicPages kind="learning" />} />
          <Route path="/calendar" element={<AcademicPages kind="calendar" />} />
          <Route path="/settings" element={<SchoolSettingsPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function LoginRoute() {
  const { user, loading, memberships, recoveryMode } = useAuth();
  if (!isSupabaseConfigured) return <SetupRequired />;
  if (loading) return <div className="full-screen-loading"><LoadingState /></div>;
  if (recoveryMode) return <AuthScreen />;
  if (user && memberships.length === 0) return <SchoolSetup />;
  if (user) return <Navigate to="/dashboard" replace />;
  return <AuthScreen />;
}
