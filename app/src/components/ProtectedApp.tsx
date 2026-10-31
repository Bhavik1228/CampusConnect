import { useEffect, useState } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
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
import { AdministrativeWorkflowsPage } from '../pages/AdministrativeWorkflowsPage';
import { WebsiteManagementPage } from '../pages/WebsiteManagementPage';
import { CoursesLessonsPage } from '../pages/CoursesLessonsPage';
import { LearningMaterialsPage } from '../pages/LearningMaterialsPage';
import { AssignmentsPage } from '../pages/AssignmentsPage';
import { SystemOwnerPage } from '../pages/SystemOwnerPage';
import { SystemOwnerSchoolsPage } from '../pages/SystemOwnerSchoolsPage';
import { SystemOwnerSettingsPage } from '../pages/SystemOwnerSettingsPage';
import { SystemOwnerMaintenancePage } from '../pages/SystemOwnerMaintenancePage';
import { SystemOwnerShell } from './SystemOwnerShell';
import { LibraryPage, PublicLibraryBookPage } from '../pages/LibraryPage';
import { HealthPage } from '../pages/HealthPage';
import { VisitorsPage } from '../pages/VisitorsPage';
import { MobileInstallPage } from '../pages/MobileInstallPage';
import { AutomationsPage } from '../pages/AutomationsPage';
import { AccountSecurityPage } from '../pages/AccountSecurityPage';
import { MfaGate } from './MfaGate';
import { PermissionsManagementPage } from '../pages/PermissionsManagementPage';
import { AcademicPlanningPage } from '../pages/AcademicPlanningPage';
import { SetupHealthPage } from '../pages/SetupHealthPage';

function RouteGate({ authOnly = true, requireMembership = true }: { authOnly?: boolean; requireMembership?: boolean }) {
  const { user, loading, memberships } = useAuth();
  const location = useLocation();
  if (!isSupabaseConfigured) return <SetupRequired />;
  if (loading) return <div className="full-screen-loading"><LoadingState /></div>;
  if (authOnly && !user) return <Navigate to={`/login?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}`} replace />;
  if (user && authOnly && requireMembership && memberships.length === 0) return <SchoolSetup />;
  return <Outlet />;
}

async function checkSystemOwner() {
  const { data, error } = await requireSupabase().functions.invoke('system-owner-admin', {
    body: { action: 'check' },
  });
  if (error) {
    const status = error.context instanceof Response ? error.context.status : null;
    if (status === 401) {
      throw new Error('System-owner verification returned HTTP 401. Sign out and back in. If it continues, verify the function is deployed to this Supabase project and the project credentials match.');
    }
    throw error;
  }
  return data?.authorized === true;
}

function SchoolWorkspaceGate() {
  const { user, loading, memberships } = useAuth();
  const [access, setAccess] = useState<'checking' | 'school' | 'owner' | 'error'>('checking');
  const [accessError, setAccessError] = useState('Could not verify platform access. School workspace access is paused until verification succeeds.');
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
        if (active) {
          setAccessError(error instanceof Error ? error.message : 'Could not verify platform access. School workspace access is paused until verification succeeds.');
          setAccess('error');
        }
      });
    return () => { active = false; };
  }, [user, retry]);

  if (loading || access === 'checking') return <div className="full-screen-loading"><LoadingState label="Verifying workspace access…" /></div>;
  if (access === 'error') return <main className="config-page"><div className="config-card"><ErrorState message={accessError} /><button className="button button-primary" onClick={() => setRetry((value) => value + 1)}>Retry verification</button></div></main>;
  if (access === 'owner') return <Navigate to="/system-owner" replace />;
  if (user && memberships.length === 0) return <SchoolSetup />;
  return <Outlet />;
}

function SystemOwnerGate() {
  const { user } = useAuth();
  const [access, setAccess] = useState<'checking' | 'owner' | 'denied' | 'error'>('checking');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    if (!user) {
      setAccess('denied');
      return () => { active = false; };
    }
    setAccess('checking');
    void checkSystemOwner()
      .then((isOwner) => { if (active) setAccess(isOwner ? 'owner' : 'denied'); })
      .catch((error: unknown) => {
        console.error('Could not verify system owner page access.', error);
        if (active) setAccess('error');
      });
    return () => { active = false; };
  }, [user, retry]);

  if (access === 'checking') return <div className="full-screen-loading"><LoadingState label="Verifying system owner access…" /></div>;
  if (access === 'error') return <main className="config-page"><div className="config-card"><ErrorState message="Owner authorization could not be verified. Access is denied until verification succeeds." /><button className="button button-primary" onClick={() => setRetry((value) => value + 1)}>Retry verification</button></div></main>;
  if (access === 'denied') return <Navigate to={user ? '/dashboard' : '/login'} replace />;
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
      <Route path="/mobile/install" element={<MobileInstallPage />} />
      <Route path="/book/:slug/:barcode" element={<PublicLibraryBookPage />} />
      <Route path="/school/:slug/library/:barcode" element={<PublicLibraryBookPage websitePath />} />
      <Route path="/school/:slug" element={<PublicSchoolWebsitePage />} />
      <Route element={<RouteGate requireMembership={false} />}>
        <Route path="/system-owner" element={<SystemOwnerGate />}>
          <Route element={<SystemOwnerShell />}>
            <Route index element={<SystemOwnerPage />} />
            <Route path="schools" element={<SystemOwnerSchoolsPage />} />
            <Route path="settings" element={<SystemOwnerSettingsPage />} />
            <Route path="maintenance" element={<SystemOwnerMaintenancePage />} />
          </Route>
        </Route>
        <Route element={<SchoolWorkspaceGate />}>
          <Route element={<MfaGate />}>
          <Route path="/account-security" element={<AccountSecurityPage />} />
          <Route element={<AppShell />}>
          <Route path="/permissions" element={<PermissionsManagementPage />} />
          <Route path="/setup-health" element={<SetupHealthPage />} />
          <Route path="/academic-planning" element={<AcademicPlanningPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/students" element={<StudentsPage />} />
          <Route path="/admissions" element={<AdmissionsPage />} />
          <Route path="/teachers" element={<DirectoryPage kind="teachers" />} />
          <Route path="/staff" element={<StaffManagementPage />} />
          <Route path="/website-management" element={<WebsiteManagementPage />} />
          <Route path="/admin-workflows" element={<AdministrativeWorkflowsPage />} />
          <Route path="/automations" element={<AutomationsPage />} />
          <Route path="/classes" element={<DirectoryPage kind="classes" />} />
          <Route path="/subjects" element={<DirectoryPage kind="subjects" />} />
          <Route path="/timetable" element={<TimetableDashboardPage />} />
          <Route path="/academic-calendar" element={<AcademicCalendarPage />} />
          <Route path="/attendance" element={<AttendancePage />} />
          <Route path="/learning" element={<TestMakerPage />} />
          <Route path="/courses-lessons" element={<CoursesLessonsPage />} />
          <Route path="/learning-materials" element={<LearningMaterialsPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/health" element={<HealthPage />} />
          <Route path="/health/report/:visitId" element={<HealthPage />} />
          <Route path="/visitors" element={<VisitorsPage />} />
          <Route path="/visitors/verify/:visitId" element={<VisitorsPage />} />
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
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </PlatformBrandingProvider>
  );
}

function LoginRoute() {
  const { user, loading, memberships, recoveryMode } = useAuth();
  const location = useLocation();
  const [ownerStatus, setOwnerStatus] = useState<'checking' | 'owner' | 'school' | 'error'>('checking');
  const requestedDestination = new URLSearchParams(location.search).get('redirect');
  const publicBookPath = requestedDestination
    && (/^\/book\/[^/]+\/[^/]+$/.test(requestedDestination)
      || /^\/school\/[^/]+\/library\/[^/]+$/.test(requestedDestination))
    ? requestedDestination
    : null;
  const healthReportPath = requestedDestination
    && /^\/health\/report\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedDestination)
    ? requestedDestination
    : null;
  const visitorBadgePath = requestedDestination
    && /^\/visitors\/verify\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedDestination)
    ? requestedDestination
    : null;

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
  if (user && publicBookPath) return <Navigate to={publicBookPath} replace />;
  if (user && healthReportPath) return <Navigate to={healthReportPath} replace />;
  if (user && visitorBadgePath) return <Navigate to={visitorBadgePath} replace />;
  if (user && memberships.length === 0) return <SchoolSetup />;
  if (user) return <Navigate to="/dashboard" replace />;
  return <AuthScreen />;
}
