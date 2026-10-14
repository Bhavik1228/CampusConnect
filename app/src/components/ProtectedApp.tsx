import { useEffect, useState } from 'react';
import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { PlatformBrandingProvider } from '../contexts/PlatformBrandingContext';
import { isSupabaseConfigured } from '../lib/supabase';
import { requireSupabase } from '../lib/supabase';
import { ErrorState, LoadingState } from './Feedback';
import { AppShell } from './AppShell';
import { AuthScreen } from './AuthScreen';
import { SchoolSetup } from './SchoolSetup';
import { DashboardPage } from '../pages/DashboardPage';
import { DirectoryPage } from '../pages/DirectoryPage';
import { AcademicPages } from '../pages/AcademicPages';
import { AttendancePage } from '../pages/AttendancePage';
import { SchoolSettingsPage } from '../pages/SchoolSettingsPage';
import { LandingPage } from '../pages/LandingPage';
import { TimetableDashboardPage } from '../pages/TimetableDashboardPage';
import { AcademicCalendarPage } from '../pages/AcademicCalendarPage';
import { TestMakerPage } from '../pages/TestMakerPage';
import { FinancePage } from '../pages/FinancePage';
import { AccountingStaffPage } from '../pages/AccountingStaffPage';
import { GradesResultsPage } from '../pages/GradesResultsPage';
import { PublicSchoolWebsitePage } from '../pages/PublicSchoolWebsitePage';
import { StaffManagementPage } from '../pages/StaffManagementPage';
import { MessagingPage } from '../pages/MessagingPage';
import { AuditLogPage } from '../pages/AuditLogPage';
import { AdmissionsPage } from '../pages/AdmissionsPage';
import { StudentsPage } from '../pages/StudentsPage';
import { CoursesLessonsPage } from '../pages/CoursesLessonsPage';
import { LearningMaterialsPage } from '../pages/LearningMaterialsPage';
import { AssignmentsPage } from '../pages/AssignmentsPage';
import { SystemOwnerPage } from '../pages/SystemOwnerPage';

function RouteGate({ authOnly = true, requireMembership = true }: { authOnly?: boolean; requireMembership?: boolean }) {
  const { user, loading, memberships } = useAuth();
  if (!isSupabaseConfigured) return <SetupRequired />;
  if (loading) return <div className="full-screen-loading"><LoadingState /></div>;
  if (authOnly && !user) return <Navigate to="/login" replace />;
  if (user && authOnly && requireMembership && memberships.length === 0) return <SchoolSetup />;
  return <Outlet />;
}

async function checkSystemOwner() {
  const { data, error } = await requireSupabase().functions.invoke('system-owner-admin', {
    body: { action: 'check' },
  });
  if (error) throw error;
  return data?.authorized === true;
}

function SchoolWorkspaceGate() {
  const { user, loading, memberships } = useAuth();
  const [access, setAccess] = useState<'checking' | 'school' | 'owner' | 'error'>('checking');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    if (!user) {
      setAccess('school');
      return () => { active = false; };
    }
    setAccess('checking');
    void checkSystemOwner()
      .then((isOwner) => { if (active) setAccess(isOwner ? 'owner' : 'school'); })
      .catch((error: unknown) => {
        console.error('Could not verify access to the school workspace.', error);
        if (active) setAccess('error');
      });
    return () => { active = false; };
  }, [user, retry]);

  if (loading || access === 'checking') return <div className="full-screen-loading"><LoadingState label="Verifying workspace access…" /></div>;
  if (access === 'error') return <main className="config-page"><div className="config-card"><ErrorState message="Could not verify platform access. School workspace access is paused until verification succeeds." /><button className="button button-primary" onClick={() => setRetry((value) => value + 1)}>Retry verification</button></div></main>;
  if (access === 'owner') return <Navigate to="/system-owner" replace />;
  if (user && memberships.length === 0) return <SchoolSetup />;
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
    <PlatformBrandingProvider>
      <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginRoute />} />
      <Route path="/school/:slug" element={<PublicSchoolWebsitePage />} />
      <Route element={<RouteGate requireMembership={false} />}>
        <Route path="/system-owner" element={<SystemOwnerPage />} />
        <Route element={<SchoolWorkspaceGate />}>
          <Route element={<AppShell />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/students" element={<StudentsPage />} />
          <Route path="/admissions" element={<AdmissionsPage />} />
          <Route path="/teachers" element={<DirectoryPage kind="teachers" />} />
          <Route path="/staff" element={<StaffManagementPage />} />
          <Route path="/classes" element={<DirectoryPage kind="classes" />} />
          <Route path="/subjects" element={<DirectoryPage kind="subjects" />} />
          <Route path="/timetable" element={<TimetableDashboardPage />} />
          <Route path="/academic-calendar" element={<AcademicCalendarPage />} />
          <Route path="/attendance" element={<AttendancePage />} />
          <Route path="/learning" element={<TestMakerPage />} />
          <Route path="/courses-lessons" element={<CoursesLessonsPage />} />
          <Route path="/learning-materials" element={<LearningMaterialsPage />} />
          <Route path="/assignments" element={<AssignmentsPage />} />
          <Route path="/grades-results" element={<GradesResultsPage />} />
          <Route path="/calendar" element={<AcademicPages kind="calendar" />} />
          <Route path="/settings" element={<SchoolSettingsPage />} />
          <Route path="/finance" element={<FinancePage />} />
          <Route path="/accounting-staff" element={<AccountingStaffPage />} />
          <Route path="/messaging" element={<MessagingPage />} />
          <Route path="/audit-log" element={<AuditLogPage />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </PlatformBrandingProvider>
  );
}

function LoginRoute() {
  const { user, loading, memberships, recoveryMode } = useAuth();
  const [ownerStatus, setOwnerStatus] = useState<'checking' | 'owner' | 'school' | 'error'>('checking');

  useEffect(() => {
    let active = true;
    if (!user || recoveryMode) {
      setOwnerStatus('school');
      return () => { active = false; };
    }
    setOwnerStatus('checking');
    void checkSystemOwner()
      .then((isOwner) => { if (active) setOwnerStatus(isOwner ? 'owner' : 'school'); })
      .catch((error: unknown) => {
        console.error('Could not verify system owner sign-in destination.', error);
        if (active) setOwnerStatus('error');
      });
    return () => { active = false; };
  }, [user, recoveryMode]);

  if (!isSupabaseConfigured) return <SetupRequired />;
  if (loading) return <div className="full-screen-loading"><LoadingState /></div>;
  if (recoveryMode) return <AuthScreen />;
  if (user && ownerStatus === 'checking') return <div className="full-screen-loading"><LoadingState label="Verifying account…" /></div>;
  if (user && ownerStatus === 'error') return <main className="config-page"><div className="config-card"><ErrorState message="Could not verify your account's platform access. Please reload and try again." /></div></main>;
  if (user && ownerStatus === 'owner') return <Navigate to="/system-owner" replace />;
  if (user && memberships.length === 0) return <SchoolSetup />;
  if (user) return <Navigate to="/dashboard" replace />;
  return <AuthScreen />;
}
