import { useState } from 'react';
import {
  ArrowRight, BookOpen, BookOpenCheck, BookOpenText, Building2, CalendarDays,
  Check, ChevronDown, ClipboardCheck, GraduationCap, LayoutDashboard, Menu,
  MessageSquareText, ShieldCheck, Users, UsersRound, WalletCards, X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { usePlatformBranding } from '../contexts/PlatformBrandingContext';

const features = [
  { icon: GraduationCap, title: 'Student information', description: 'Keep enrollment, profiles, class placement, and academic records together across the student journey.' },
  { icon: BookOpenText, title: 'Learning & assessment', description: 'Organize assignments, learning resources, quizzes, exams, grading, and student progress.' },
  { icon: CalendarDays, title: 'Timetables & calendars', description: 'Coordinate lessons, academic terms, schedules, and school events across your organization.' },
  { icon: WalletCards, title: 'Student fee management', description: 'Manage fee structures, invoices, discounts, payment allocations, receipts, and student account balances.' },
  { icon: MessageSquareText, title: 'School communication', description: 'Keep announcements, notices, and school conversations connected to the people who need them.' },
  { icon: LayoutDashboard, title: 'Dashboards & reporting', description: 'Bring attendance, learner progress, and school information into clear role-based views.' },
  { icon: ShieldCheck, title: 'Role-based access', description: 'Give administrators, teachers, students, and families access suited to their responsibilities.' },
  { icon: UsersRound, title: 'Multi-school workspaces', description: 'Give each school its own workspace and organize access through school memberships.' },
];

const modules = [
  ['01', 'Admissions & enrolment', 'Student applications, documents, decisions, registration, class placement, and admission history.'],
  ['02', 'Academic records', 'Classes, subjects, terms, and progress.'],
  ['03', 'Attendance', 'Daily attendance and absence tracking.'],
  ['04', 'Assignments', 'Set work, due dates, and submissions.'],
  ['05', 'Exams & grades', 'Assessment schedules and results.'],
  ['06', 'Learning materials', 'Share lesson resources and files.'],
  ['07', 'Announcements', 'Publish updates to the school community.'],
  ['08', 'Parent & student access', 'Connect families with school information.'],
];

const questions = [
  {
    question: 'Is Campus Connect designed for multiple schools?',
    answer: 'Yes. School-scoped records and memberships are part of the system. An account can create its first school workspace; tools to invite people and manage a full multi-school organization are still being developed.',
  },
  {
    question: 'What can schools manage in the system?',
    answer: 'The system is designed to bring together school records and learning workflows, including people, classes, subjects, attendance, assignments, learning resources, communication, and academic information.',
  },
  {
    question: 'Which roles can use Campus Connect?',
    answer: 'The access model includes school administrators, teachers, students, parents or guardians, and accounting staff. School administrators can invite finance managers, accountants, bursars, and cashiers with role-specific access.',
  },
  {
    question: 'Is every feature already available?',
    answer: 'Campus Connect is under active development. The current app includes account access, school setup, core school directories, a dashboard, school settings, and attendance recording. Additional learning and communication workflows are still being built.',
  },
];

function WorkspacePreview() {
  return (
    <div className="cc-landing-preview" aria-hidden="true">
      <div className="cc-preview-window">
        <div className="cc-preview-bar">
          <span className="cc-preview-dot cc-dot-danger" />
          <span className="cc-preview-dot cc-dot-warning" />
          <span className="cc-preview-dot cc-dot-success" />
        </div>
        <div className="cc-preview-body">
          <aside className="cc-preview-sidebar">
            <div className="cc-preview-brand"><BookOpenCheck size={14} /><span>Campus</span></div>
            <nav className="cc-preview-nav">
              <a className="cc-preview-nav-item active"><span>Dashboard</span></a>
              <a className="cc-preview-nav-item"><span>Students</span></a>
              <a className="cc-preview-nav-item"><span>Attendance</span></a>
              <a className="cc-preview-nav-item"><span>Learning</span></a>
            </nav>
          </aside>
          <main className="cc-preview-main">
            <header className="cc-preview-topbar">
              <span className="cc-preview-school">School workspace</span>
              <span className="cc-preview-user">You</span>
            </header>
            <div className="cc-preview-grid">
              <div className="cc-preview-panel"><span className="cc-panel-label">Students</span><span className="cc-panel-note">Enrollment and profiles</span></div>
              <div className="cc-preview-panel"><span className="cc-panel-label">Attendance</span><span className="cc-panel-note">Daily class attendance</span></div>
              <div className="cc-preview-panel"><span className="cc-panel-label">Learning resources</span><span className="cc-panel-note">Lessons and materials</span></div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

export function LandingPage() {
  const { user } = useAuth();
  const { platformName, logoUrl, maintenanceNotice } = usePlatformBranding();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [activeQuestion, setActiveQuestion] = useState<number | null>(0);

  function closeMobileMenu() {
    setMobileMenuOpen(false);
  }

  const signInLabel = user ? 'Open workspace' : 'Sign in';
  const dashboardLabel = user ? 'Go to dashboard' : 'Get started';

  return (
    <main className="cc-landing-page">
      <header className="cc-landing-header">
        <div className="cc-landing-header-inner">
          <a className="cc-landing-brand" href="#home" onClick={closeMobileMenu}>
            <span className="cc-landing-brand-mark">{logoUrl ? <img src={logoUrl} alt="" /> : <BookOpenCheck size={18} />}</span>
            <span>{platformName}</span>
          </a>
          <button className="cc-landing-menu-toggle" type="button" onClick={() => setMobileMenuOpen((open) => !open)} aria-label={mobileMenuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={mobileMenuOpen}>
            {mobileMenuOpen ? <X size={21} /> : <Menu size={21} />}
          </button>
          <nav className={`cc-landing-nav${mobileMenuOpen ? ' cc-landing-nav--open' : ''}`} aria-label="Main navigation">
            <a href="#features" onClick={closeMobileMenu}>Features</a>
            <a href="#multi-school" onClick={closeMobileMenu}>Multi-school</a>
            <a href="#modules" onClick={closeMobileMenu}>Modules</a>
            <a href="#faq" onClick={closeMobileMenu}>FAQ</a>
            <div className="cc-landing-mobile-cta">
              <Link className="cc-btn cc-btn-ghost cc-btn-full" to="/login" onClick={closeMobileMenu}>{signInLabel}</Link>
              <Link className="cc-btn cc-btn-primary cc-btn-full" to="/login" onClick={closeMobileMenu}>{dashboardLabel} <ArrowRight size={16} /></Link>
            </div>
          </nav>
          <div className="cc-landing-actions">
            <Link className="cc-landing-link" to={user ? '/dashboard' : '/login'}>{signInLabel}</Link>
            <Link className="cc-btn cc-btn-primary" to="/login">{dashboardLabel} <ArrowRight size={16} /></Link>
          </div>
        </div>
      </header>
      {maintenanceNotice && <aside className="cc-maintenance-notice" role="status">{maintenanceNotice}</aside>}

      <section className="cc-landing-hero" id="home">
        <div className="cc-landing-container">
          <div className="cc-landing-hero-grid">
            <div className="cc-landing-hero-copy">
              <h1>One connected system for <span>school life.</span></h1>
              <p>Campus Connect brings school operations, student information, learning, and communication into one organized workspace for schools and campus groups.</p>
              <div className="cc-landing-hero-actions">
                <Link className="cc-btn cc-btn-primary cc-btn-large" to="/login">Explore your workspace <ArrowRight size={18} /></Link>
                <a className="cc-btn cc-btn-secondary cc-btn-large" href="#features">Explore the platform</a>
              </div>
              <div className="cc-landing-proof-points">
                <span><Check size={15} /> School-scoped workspace</span>
                <span><Check size={15} /> Role-based access</span>
                <span><Check size={15} /> Built around learning</span>
              </div>
            </div>
            <div className="cc-landing-hero-visual"><WorkspacePreview /></div>
          </div>
          <a className="cc-landing-scroll-cue" href="#features">Discover the platform <ChevronDown size={15} /></a>
        </div>
      </section>

      <section className="cc-landing-section landing-features" id="features">
        <div className="cc-landing-container">
          <div className="cc-landing-section-heading">
            <h2>Bring the school day into focus.</h2>
            <p>A shared foundation for the everyday work of running a school and supporting learning.</p>
          </div>
          <div className="cc-landing-feature-grid">
            {features.map(({ icon: Icon, title, description }) => (
              <article className="cc-landing-feature-card" key={title}>
                <span className="cc-landing-feature-icon"><Icon size={21} strokeWidth={1.8} /></span>
                <h3>{title}</h3><p>{description}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="cc-landing-section landing-multischool" id="multi-school">
        <div className="cc-landing-container landing-multischool-grid">
          <div className="landing-multischool-copy">
            <h2>A wider view for connected schools.</h2>
            <p>Give each school its own workspace and keep access organized through school membership.</p>
            <ul className="landing-check-list">
              <li><span><Check size={15} /></span><div><strong>Separate school workspaces</strong><p>Keep records associated with the school they belong to.</p></div></li>
              <li><span><Check size={15} /></span><div><strong>School memberships and roles</strong><p>Connect users to the schools and responsibilities they serve.</p></div></li>
              <li><span><Check size={15} /></span><div><strong>Room to grow</strong><p>Extend the platform as academic and administrative needs change.</p></div></li>
            </ul>
          </div>
          <div className="landing-network-card">
            <div className="network-card-header"><span className="network-card-title"><span className="network-mark cc-node-icon cc-node-primary"><UsersRound size={17} /></span>Workspace structure</span><span className="network-status">Illustrative model</span></div>
            <div className="network-nodes">
              <div className="network-node network-node-main"><span className="node-icon cc-node-icon cc-node-primary"><LayoutDashboard size={19} /></span><span><strong>Campus Connect</strong><small>Multi-school platform</small></span><ArrowRight size={15} /></div>
              <div className="network-child-nodes">
                <div className="network-node"><span className="node-icon cc-node-icon cc-node-secondary"><GraduationCap size={17} /></span><span><strong>School workspace</strong><small>School-scoped records</small></span></div>
                <div className="network-node"><span className="node-icon cc-node-icon cc-node-secondary"><BookOpen size={17} /></span><span><strong>School workspace</strong><small>School-scoped records</small></span></div>
                <div className="network-node"><span className="node-icon cc-node-icon cc-node-muted"><Users size={17} /></span><span><strong>Additional school</strong><small>Separate membership</small></span></div>
              </div>
            </div>
            <div className="network-card-footer"><ShieldCheck size={15} /><span>School membership controls access to school records.</span></div>
          </div>
        </div>
      </section>

      <section className="cc-landing-section landing-modules" id="modules">
        <div className="cc-landing-container">
          <div className="cc-landing-section-heading">
            <h2>One place for essential school workflows.</h2>
            <p>Campus Connect is being built to bring these school information, operations, and learning workflows together.</p>
          </div>
          <div className="cc-landing-modules-grid">
            {modules.map(([number, title, description]) => (
              <article className="cc-landing-module-card" key={number}>
                <span>{number}</span><h3>{title}</h3><p>{description}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="cc-landing-section landing-flow">
        <div className="cc-landing-container">
          <div className="cc-landing-section-heading">
            <h2>From school structure to learning progress.</h2>
          </div>
          <div className="cc-landing-flow-grid">
            <article className="cc-landing-flow-card"><span className="cc-flow-number">01</span><div className="cc-flow-icon"><Building2 size={22} /></div><h3>Set up your school</h3><p>Define school workspaces, academic groups, records, and who can access them.</p></article>
            <article className="cc-landing-flow-card"><span className="cc-flow-number">02</span><div className="cc-flow-icon"><ClipboardCheck size={22} /></div><h3>Coordinate everyday work</h3><p>Bring attendance, school communication, schedules, and learning into daily use.</p></article>
            <article className="cc-landing-flow-card"><span className="cc-flow-number">03</span><div className="cc-flow-icon"><BookOpenText size={22} /></div><h3>Support learning</h3><p>Keep academic information and learning workflows connected to each student.</p></article>
          </div>
        </div>
      </section>

      <section className="cc-landing-section landing-faq" id="faq">
        <div className="cc-landing-container landing-faq-container">
          <div className="cc-landing-section-heading">
            <h2>Good to know.</h2>
            <p>Some practical details about Campus Connect.</p>
          </div>
          <div className="landing-faq-list">
            {questions.map(({ question, answer }, index) => {
              const expanded = activeQuestion === index;
              const answerId = `landing-faq-answer-${index}`;
              return <article className={`landing-faq-item${expanded ? ' expanded' : ''}`} key={question}>
                <h3><button type="button" aria-expanded={expanded} aria-controls={answerId} onClick={() => setActiveQuestion(expanded ? null : index)}><span>{question}</span><span className="cc-faq-plus" aria-hidden="true" /></button></h3>
                <div className="landing-faq-answer" id={answerId} hidden={!expanded}><p>{answer}</p></div>
              </article>;
            })}
          </div>
        </div>
      </section>

      <section className="cc-landing-cta" id="contact">
        <div className="cc-landing-container">
          <div className="cc-landing-cta-card">
            <h2>Bring your school information and learning into one workspace.</h2>
            <p>Start by setting up an account and creating your school workspace.</p>
            <Link className="cc-btn cc-btn-primary cc-btn-large" to="/login">Get started <ArrowRight size={18} /></Link>
          </div>
        </div>
      </section>

      <footer className="cc-landing-footer">
        <div className="cc-landing-footer-inner">
          <a className="cc-landing-brand" href="#home"><span className="cc-landing-brand-mark">{logoUrl ? <img src={logoUrl} alt="" /> : <BookOpenCheck size={16} />}</span><span>{platformName}</span></a>
          <p>School information, operations, and learning in one connected system.</p>
          <a href="#home" className="cc-landing-back-top">Back to top ↑</a>
        </div>
        <div className="cc-landing-footer-bottom"><span>{platformName}</span><Link to="/login">Sign in to your workspace</Link></div>
      </footer>
    </main>
  );
}
