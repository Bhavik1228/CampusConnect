import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { usePlatformBranding } from '../contexts/PlatformBrandingContext';
import {
  Button, Card, CardContent, CardTitle, SectionHeading,
  Badge, StatusPill,
} from '../components/ui';
import {
  ArrowRight, BookOpen, CalendarDays, Check, ChevronDown, GraduationCap,
  LayoutDashboard, Menu, MessageSquareText, ShieldCheck, WalletCards, X,
} from 'lucide-react';

const capabilities = [
  {
    title: 'Student information',
    description: 'Enrolment, profiles, class placement, and academic records across the student journey.',
    icon: GraduationCap,
  },
  {
    title: 'Classes & timetables',
    description: 'Class groups, subjects, terms, and published lesson schedules for every teacher.',
    icon: LayoutDashboard,
  },
  {
    title: 'Attendance',
    description: 'Daily and lesson-level registers with absence tracking and parent notifications.',
    icon: CalendarDays,
  },
  {
    title: 'Fee management',
    description: 'Fee structures, invoices, payments, receipts, statements, and payment plans.',
    icon: WalletCards,
  },
  {
    title: 'Learning materials',
    description: 'Lesson resources, question banks, past papers, and a school library catalogue.',
    icon: BookOpen,
  },
  {
    title: 'School communication',
    description: 'Announcements, family messaging, and notices connected to the people who need them.',
    icon: MessageSquareText,
  },
];

const trustPoints = [
  { label: 'Role-based access', detail: 'Permissions matched to administrator, teacher, student, and family responsibilities.' },
  { label: 'School-scoped data', detail: 'Every record is isolated to its school; users cannot reach another school\'s information.' },
  { label: 'Built around learning', detail: 'Assessments, results, timetables, and curriculum workflows in one workspace.' },
  { label: 'Audit & reliability', detail: 'Audit logging, uptime monitoring, and sign-in event tracking for platform accountability.' },
];

export function LandingPage() {
  const { user } = useAuth();
  const { platformName } = usePlatformBranding();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  const goToLogin = () => { setMobileOpen(false); navigate('/login'); };

  return (
    <main className="landing-page cc-flex-col cc-h-full">
      <header className="landing-header cc-sticky top-0 z-40 border-b border-border/60 bg-surface/80 backdrop-blur-sm">
        <div className="landing-header-inner cc-flex items-center justify-between gap-4 px-4 py-3">
          <Link
            to="/"
            className="landing-brand cc-flex items-center gap-3 text-ink font-bold text-sm tracking-tight"
            onClick={() => setMobileOpen(false)}
          >
            <span className="landing-brand-mark">
              <ShieldCheck size={19} />
            </span>
            <span>{platformName}</span>
          </Link>

          <button
            className="landing-menu-toggle btn-icon md:hidden"
            onClick={() => setMobileOpen((open) => !open)}
            aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={mobileOpen}
          >
            {mobileOpen ? <X size={20} /> : <Menu size={20} />}
          </button>

          <nav
            className={`landing-nav cc-flex items-center gap-6 md:gap-8 text-sm font-semibold ${mobileOpen ? 'mobile-open' : ''}`}
            aria-label="Main navigation"
          >
            <Link to="#capabilities" className="cc-text-muted hover:cc-text-primary transition-colors" onClick={() => setMobileOpen(false)}>
              Platform
            </Link>
            <Link to="#capabilities" className="cc-text-muted hover:cc-text-primary transition-colors" onClick={() => setMobileOpen(false)}>
              Capabilities
            </Link>
            <div className="landing-mobile-cc ml-4 hidden md:flex items-center gap-3">
              <Link
                to={user ? '/dashboard' : '/login'}
                className="text-sm font-semibold text-muted hover:text-ink"
                onClick={goToLogin}
              >
                {user ? 'Open workspace' : 'Sign in'}
              </Link>
              <Button variant="primary" size="large" onClick={goToLogin}>
                {user ? 'Go to dashboard' : 'Get started'} <ArrowRight size={16} />
              </Button>
            </div>
          </nav>
        </div>

        {mobileOpen && (
          <div className="landing-mobile-panel fixed inset-0 z-50 bg-surface/95 backdrop-blur-md">
            <div className="cc-flex items-center justify-between px-6 py-5 border-b border-border">
              <Link to="/" className="cc-flex items-center gap-2 text-ink font-bold text-sm" onClick={() => setMobileOpen(false)}>
                <ShieldCheck size={17} /><span>{platformName}</span>
              </Link>
              <button className="btn-icon" onClick={() => setMobileOpen(false)} aria-label="Close navigation">
                <X size={20} />
              </button>
            </div>
            <nav className="cc-flex-col gap-1 px-6 py-6" aria-label="Mobile navigation">
              <Link to="#capabilities" className="block py-3 text-lg font-semibold text-ink hover:cc-text-primary" onClick={() => setMobileOpen(false)}>
                Platform
              </Link>
              <Link to="#capabilities" className="block py-3 text-lg font-semibold text-ink hover:cc-text-primary" onClick={() => setMobileOpen(false)}>
                Capabilities
              </Link>
              <div className="pt-4 border-t border-border">
                <button
                  className="btn-base btn-default w-full cc-justify-start text-left py-3 text-sm font-semibold"
                  onClick={goToLogin}
                >
                  {user ? 'Open workspace' : 'Sign in'}
                </button>
                <button
                  className="btn-base btn-primary w-full cc-justify-start text-left py-3 text-sm font-semibold mt-2"
                  onClick={goToLogin}
                >
                  {user ? 'Go to dashboard' : 'Get started'} <ArrowRight size={16} />
                </button>
              </div>
            </nav>
          </div>
        )}
      </header>

      <section className="landing-hero py-20 px-6 lg:py-28">
        <div className="landing-container max-w-7xl mx-auto">
          <div className="landing-hero-grid grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
            <div className="landing-hero-copy cc-flex-col gap-6">
              <span className="eyebrow cc-text-primary font-semibold tracking-wide">School information &amp; learning management</span>
              <h1 className="cc-text-4xl cc-font-bold cc-leading-tight cc-text-ink">
                One connected system for <span className="cc-text-primary">school life.</span>
              </h1>
              <p className="cc-text-lg cc-leading-relaxed cc-text-text max-w-lg">
                Campus Connect brings school operations, student information, learning, and communication
                into one organized workspace — built around the responsibilities of each person who uses it.
              </p>
              <div className="cc-flex flex-col sm:flex-row gap-4">
                <Button variant="primary" size="large" onClick={goToLogin}>
                  Create your school workspace <ArrowRight size={18} />
                </Button>
                <a
                  href="#capabilities"
                  className="btn-base btn-default btn-quiet text-sm font-semibold px-4 py-2 cc-text-muted hover:cc-text-ink hover:bg-surface-soft"
                  onClick={() => setMobileOpen(false)}
                >
                  See the platform <ArrowRight size={16} />
                </a>
              </div>
              <div className="landing-proof-points cc-flex flex-wrap gap-4">
                {trustPoints.map((point, index) => (
                  <span key={index} className="cc-flex items-center gap-2 cc-text-sm cc-text-text">
                    <Check size={14} className="cc-text-success" />
                    {point.label}
                  </span>
                ))}
              </div>
            </div>

            <div className="landing-hero-visual cc-relative">
              <div className="preview-frame rounded-xl border border-border bg-surface shadow-md overflow-hidden">
                <div className="preview-toolbar cc-flex items-center gap-2 px-4 py-2 bg-surface-soft border-b border-border">
                  <div className="cc-flex gap-1.5">
                    <span className="preview-dot w-2 h-2 rounded-full bg-red-400/60"></span>
                    <span className="preview-dot w-2 h-2 rounded-full bg-yellow-400/60"></span>
                    <span className="preview-dot w-2 h-2 rounded-full bg-green-400/60"></span>
                  </div>
                  <span className="ml-auto text-[10px] cc-text-muted font-medium">Campus Connect · Workspace preview</span>
                </div>
                <div className="p-6">
                  <div className="grid grid-cols-3 gap-4 mb-6">
                    <Card className="p-4">
                      <CardContent>
                        <div className="cc-flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg bg-primary-soft cc-flex items-center justify-center text-primary">
                            <GraduationCap size={16} />
                          </div>
                          <div>
                            <div className="text-xs cc-text-muted font-semibold">Active students</div>
                            <div className="text-lg font-bold cc-text-ink">1,204</div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                    <Card className="p-4">
                      <CardContent>
                        <div className="cc-flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg bg-primary-soft cc-flex items-center justify-center text-primary">
                            <LayoutDashboard size={16} />
                          </div>
                          <div>
                            <div className="text-xs cc-text-muted font-semibold">Classes this week</div>
                            <div className="text-lg font-bold cc-text-ink">86</div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                    <Card className="p-4">
                      <CardContent>
                        <div className="cc-flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg bg-primary-soft cc-flex items-center justify-center text-primary">
                            <CalendarDays size={16} />
                          </div>
                          <div>
                            <div className="text-xs cc-text-muted font-semibold">Attendance today</div>
                            <div className="text-lg font-bold cc-text-ink">94%</div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                  <Card className="border-t-0 rounded-t-none">
                    <CardHeader>
                      <CardTitle>Recent student records</CardTitle>
                    </CardHeader>
                    <CardContent className="pt-0">
                      <div className="overflow-x-auto">
                        <table className="table text-sm">
                          <thead>
                            <tr>
                              <th>Student</th>
                              <th className="text-right">Class</th>
                              <th className="text-right">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              <td>Amara Okafor</td>
                              <td className="text-right">Year 7 · Blue</td>
                              <td className="text-right"><StatusPill variant="success" label="Active" /></td>
                            </tr>
                            <tr>
                              <td>Liam Chen</td>
                              <td className="text-right">Year 8 · Red</td>
                              <td className="text-right"><StatusPill variant="success" label="Active" /></td>
                            </tr>
                            <tr>
                              <td>Sofia Rossi</td>
                              <td className="text-right">Year 7 · Green</td>
                              <td className="text-right"><StatusPill variant="warning" label="Absent" /></td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </div>
              <p className="mt-4 text-xs cc-text-muted text-center">Illustrative workspace preview built from real Campus Connect components.</p>
            </div>
          </div>
        </div>
      </section>

      <section id="capabilities" className="landing-section bg-surface-soft py-20 px-6 lg:py-28">
        <div className="landing-container max-w-7xl mx-auto">
          <SectionHeading
            eyebrow="Platform"
            title="Everything a school day needs"
            description="Campus Connect brings operations, student records, learning, and communication into one workspace."
            titleTag="h2"
          />
          <div className="landing-capability-grid mt-12 grid grid-cols-2 md:grid-cols-3 gap-6">
            {capabilities.map((cap) => (
              <Card key={cap.title} className="p-6 hover:shadow-md transition-shadow">
                <CardHeader>
                  <div className="w-10 h-10 rounded-lg bg-primary-soft cc-flex items-center justify-center text-primary mb-4">
                    <cap.icon size={18} />
                  </div>
                  <CardTitle className="cc-text-xl">{cap.title}</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <p className="cc-text-sm cc-text-text leading-relaxed">{cap.description}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section className="landing-section py-20 px-6 lg:py-28">
        <div className="landing-container max-w-7xl mx-auto">
          <SectionHeading
            eyebrow="Security &amp; reliability"
            title="Built for school accountability"
            description="Controls and visibility that match how a school actually operates."
            titleTag="h2"
          />
          <div className="mt-12 grid md:grid-cols-2 gap-8">
            <div className="cc-flex gap-4">
              <Badge variant="success" className="flex-shrink-0">Verified access</Badge>
              <div>
                <div className="font-semibold cc-text-ink">Role-based permissions</div>
                <div className="cc-text-sm cc-text-muted">Every action runs under the user's school role — administrators, teachers, families, and accounting staff each see only what applies to them.</div>
              </div>
            </div>
            <div className="cc-flex gap-4 mt-6 md:mt-0">
              <Badge variant="soft" className="flex-shrink-0">Isolated data</Badge>
              <div>
                <div className="font-semibold cc-text-ink">School-scoped records</div>
                <div className="cc-text-sm cc-text-muted">Student, finance, and attendance records stay inside their school workspace. Cross-school access is not possible by design.</div>
              </div>
            </div>
            <div className="cc-flex gap-4 mt-6 md:mt-0">
              <Badge variant="soft" className="flex-shrink-0">Audit trail</Badge>
              <div>
                <div className="font-semibold cc-text-ink">Audit logging</div>
                <div className="cc-text-sm cc-text-muted">Sensitive operations are recorded so administrators can review who changed what and when.</div>
              </div>
            </div>
            <div className="cc-flex gap-4 mt-6 md:mt-0">
              <Badge variant="soft" className="flex-shrink-0">Monitored uptime</Badge>
              <div>
                <div className="font-semibold cc-text-ink">Platform health</div>
                <div className="cc-text-sm cc-text-muted">Live service checks and browser performance monitoring keep the platform accountable to its schools.</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="landing-cta py-20 px-6 lg:py-28">
        <div className="landing-container max-w-4xl mx-auto">
          <Card className="p-10 md:p-16 rounded-2xl border border-border bg-surface-soft text-center">
            <div className="cc-flex justify-center">
              <h2 className="cc-text-3xl cc-font-bold cc-leading-tight cc-text-ink">Ready to connect your school?</h2>
            </div>
            <p className="mt-4 cc-text-lg cc-text-text max-w-xl mx-auto">
              Set up an account, create your school workspace, and invite your team. No installation required.
            </p>
            <div className="mt-8">
              <Button variant="primary" size="large" onClick={goToLogin} className="w-full md:w-auto">
                Get started <ArrowRight size={18} />
              </Button>
            </div>
          </Card>
        </div>
      </section>

      <footer className="landing-footer border-t border-border bg-surface py-10 px-6">
        <div className="landing-container max-w-7xl mx-auto cc-flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="cc-flex items-center gap-3">
            <ShieldCheck size={17} />
            <span className="font-bold text-sm cc-text-ink tracking-tight">{platformName}</span>
          </div>
          <p className="text-sm cc-text-muted">School information, operations, and learning in one connected system.</p>
          <div className="cc-flex gap-4 text-sm">
            <Link to="#capabilities" className="cc-text-muted hover:cc-text-primary">Platform</Link>
            <Link to={user ? '/dashboard' : '/login'} className="cc-text-primary font-semibold" onClick={goToLogin}>
              {user ? 'Open workspace' : 'Sign in'}
            </Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
