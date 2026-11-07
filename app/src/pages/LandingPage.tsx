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
  { icon: GraduationCap, tone: 'violet', title: 'Student information', description: 'Keep enrollment, profiles, class placement, and academic records together across the student journey.' },
  { icon: BookOpenText, tone: 'sky', title: 'Learning & assessment', description: 'Organize assignments, learning resources, quizzes, exams, grading, and student progress.' },
  { icon: CalendarDays, tone: 'green', title: 'Timetables & calendars', description: 'Coordinate lessons, academic terms, schedules, and school events across your organization.' },
  { icon: WalletCards, tone: 'teal', title: 'Student fee management', description: 'Manage fee structures, invoices, discounts, payment allocations, receipts, and student account balances.' },
  { icon: MessageSquareText, tone: 'amber', title: 'School communication', description: 'Keep announcements, notices, and school conversations connected to the people who need them.' },
  { icon: LayoutDashboard, tone: 'pink', title: 'Dashboards & reporting', description: 'Bring attendance, learner progress, and school information into clear role-based views.' },
  { icon: ShieldCheck, tone: 'blue', title: 'Role-based access', description: 'Give administrators, teachers, students, and families access suited to their responsibilities.' },
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

function DashboardPreview() {
  return (
    <div className="landing-preview-frame">
      <div className="landing-preview-glow" aria-hidden="true" />
      <div className="landing-preview-window">
        <div className="landing-preview-dashboard">
          <div className="preview-heading">
            <div><h2>School operations</h2></div>
            <span className="preview-school-chip"><span /> School view</span>
          </div>
          <div className="preview-stat-grid">
            <div className="preview-stat"><span>Students</span><strong>Profiles</strong><small>Enrollment records</small></div>
            <div className="preview-stat"><span>Teachers</span><strong>Team</strong><small>Staff directory</small></div>
            <div className="preview-stat"><span>Classes</span><strong>Groups</strong><small>Academic structure</small></div>
            <div className="preview-stat"><span>Learning</span><strong>Resources</strong><small>Class materials</small></div>
          </div>
          <div className="preview-lower">
            <div className="preview-chart">
              <div className="preview-card-heading"><span>School information</span><small>Workspace areas</small></div>
              <div className="preview-area-list">
                <span><i className="area-dot violet-dot" />People & records</span>
                <span><i className="area-dot teal-dot" />Classes & subjects</span>
                <span><i className="area-dot blue-dot" />Learning resources</span>
              </div>
            </div>
            <div className="preview-activity">
              <div className="preview-card-heading"><span>Workspace</span><small>Modules</small></div>
              <div className="preview-activity-item"><span className="activity-icon lavender"><GraduationCap size={15} /></span><span>Student records</span></div>
              <div className="preview-activity-item"><span className="activity-icon teal"><ClipboardCheck size={15} /></span><span>Class attendance</span></div>
              <div className="preview-activity-item"><span className="activity-icon blue"><BookOpen size={15} /></span><span>Learning materials</span></div>
            </div>
          </div>
        </div>
      </div>
      <div className="preview-floating-card"><span className="floating-icon"><UsersRound size={17} /></span><span><strong>Multi-school</strong><small>One connected structure</small></span></div>
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

  return (
    <main className="landing-page">
      <header className="landing-header">
        <div className="landing-header-inner">
          <a className="landing-brand" href="#home" onClick={closeMobileMenu}>
            <span className="landing-brand-mark">{logoUrl ? <img src={logoUrl} alt="" /> : <BookOpenCheck size={20} />}</span>
            <span>{platformName}</span>
          </a>
          <button className="landing-menu-toggle" type="button" onClick={() => setMobileMenuOpen((open) => !open)} aria-label={mobileMenuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={mobileMenuOpen}>
            {mobileMenuOpen ? <X size={21} /> : <Menu size={21} />}
          </button>
          <nav className={`landing-nav${mobileMenuOpen ? ' mobile-open' : ''}`} aria-label="Main navigation">
            <a href="#features" onClick={closeMobileMenu}>Features</a>
            <a href="#multi-school" onClick={closeMobileMenu}>Multi-school</a>
            <a href="#modules" onClick={closeMobileMenu}>Modules</a>
            <a href="#faq" onClick={closeMobileMenu}>FAQ</a>
            <div className="landing-mobile-cta">
              <Link className="landing-button landing-button-secondary" to="/login" onClick={closeMobileMenu}>{user ? 'Open workspace' : 'Sign in'}</Link>
              <Link className="landing-button landing-button-primary" to="/login" onClick={closeMobileMenu}>{user ? 'Go to dashboard' : 'Get started'} <ArrowRight size={16} /></Link>
            </div>
          </nav>
          <div className="landing-header-actions">
            <Link className="landing-login-link" to={user ? '/dashboard' : '/login'}>{user ? 'Open workspace' : 'Sign in'}</Link>
            <Link className="landing-button landing-button-primary landing-header-cta" to="/login">{user ? 'Go to dashboard' : 'Get started'} <ArrowRight size={16} /></Link>
          </div>
        </div>
      </header>
      {maintenanceNotice && <aside className="platform-maintenance-notice" role="status">{maintenanceNotice}</aside>}

      <section className="landing-hero" id="home">
        <div className="landing-container landing-hero-grid">
          <div className="landing-hero-copy">
            <h1 className="landing-reveal">One connected system for <span>school life.</span></h1>
            <p className="landing-hero-description landing-reveal">Campus Connect brings school operations, student information, learning, and communication into one organized workspace for schools and campus groups.</p>
            <div className="landing-hero-actions landing-reveal">
              <Link className="landing-button landing-button-primary landing-button-large" to="/login">Explore your workspace <ArrowRight size={18} /></Link>
              <a className="landing-button landing-button-secondary landing-button-large" href="#features"><BookOpenText size={17} /> Explore the platform</a>
            </div>
            <div className="landing-proof-points landing-reveal">
              <span><Check size={15} /> School-scoped workspace</span>
              <span><Check size={15} /> Role-based access</span>
              <span><Check size={15} /> Built around learning</span>
            </div>
          </div>
          <div className="landing-hero-visual landing-reveal"><DashboardPreview /></div>
        </div>
        <a className="landing-scroll-cue" href="#features">Discover the platform <ChevronDown size={15} /></a>
      </section>

      <section className="landing-section landing-features" id="features">
        <div className="landing-container">
          <div className="landing-section-heading landing-reveal">
            <h2>Bring the school day into focus.</h2>
            <p>A shared foundation for the everyday work of running a school and supporting learning.</p>
          </div>
          <div className="landing-feature-grid">
            {features.map(({ icon: Icon, tone, title, description }) => (
              <article className="landing-feature-card" key={title}>
                <span className={`landing-feature-icon ${tone}`}><Icon size={21} strokeWidth={1.8} /></span>
                <h3>{title}</h3><p>{description}</p><span className="landing-card-line" aria-hidden="true" />
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="landing-section landing-multischool" id="multi-school">
        <div className="landing-container landing-multischool-grid">
          <div className="landing-multischool-copy">
            <h2 className="landing-reveal">A wider view for connected schools.</h2>
            <p className="landing-multischool-lead landing-reveal">Give each school its own workspace and keep access organized through school membership.</p>
            <ul className="landing-check-list">
              <li className="landing-reveal"><span><Check size={15} /></span><div><strong>Separate school workspaces</strong><p>Keep records associated with the school they belong to.</p></div></li>
              <li className="landing-reveal"><span><Check size={15} /></span><div><strong>School memberships and roles</strong><p>Connect users to the schools and responsibilities they serve.</p></div></li>
              <li className="landing-reveal"><span><Check size={15} /></span><div><strong>Room to grow</strong><p>Extend the platform as academic and administrative needs change.</p></div></li>
            </ul>
          </div>
          <div className="landing-network-card landing-reveal">
            <div className="network-card-header"><span className="network-card-title"><span className="network-mark"><UsersRound size={17} /></span>Workspace structure</span><span className="network-status">Illustrative model</span></div>
            <div className="network-connector" aria-hidden="true"><span /><span /><span /></div>
            <div className="network-nodes">
              <div className="network-node network-node-main"><span className="node-icon node-violet"><LayoutDashboard size={19} /></span><span><strong>Campus Connect</strong><small>Multi-school platform</small></span><ArrowRight size={15} /></div>
              <div className="network-child-nodes">
                <div className="network-node"><span className="node-icon node-blue"><GraduationCap size={17} /></span><span><strong>School workspace</strong><small>School-scoped records</small></span></div>
                <div className="network-node"><span className="node-icon node-teal"><BookOpen size={17} /></span><span><strong>School workspace</strong><small>School-scoped records</small></span></div>
                <div className="network-node network-node-muted"><span className="node-icon node-muted"><Users size={17} /></span><span><strong>Additional school</strong><small>Separate membership</small></span></div>
              </div>
            </div>
            <div className="network-card-footer"><ShieldCheck size={15} /><span>School membership controls access to school records.</span></div>
          </div>
        </div>
      </section>

      <section className="landing-section landing-modules" id="modules">
        <div className="landing-container">
          <div className="landing-section-heading landing-reveal">
            <h2>One place for essential school workflows.</h2>
            <p>Campus Connect is being built to bring these school information, operations, and learning workflows together.</p>
          </div>
          <div className="landing-modules-grid">
            {modules.map(([number, title, description]) => (
              <article className="landing-module-card landing-reveal" key={number}>
                <span>{number}</span><h3>{title}</h3><p>{description}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="landing-section landing-flow">
        <div className="landing-container">
          <div className="landing-section-heading landing-reveal">
            <h2>From school structure to learning progress.</h2>
          </div>
          <div className="landing-flow-grid">
            <article className="landing-flow-card landing-reveal"><span className="flow-number">01</span><div className="flow-icon"><Building2 size={22} /></div><h3>Set up your school</h3><p>Define school workspaces, academic groups, records, and who can access them.</p></article>
            <article className="landing-flow-card landing-reveal"><span className="flow-number">02</span><div className="flow-icon"><ClipboardCheck size={22} /></div><h3>Coordinate everyday work</h3><p>Bring attendance, school communication, schedules, and learning into daily use.</p></article>
            <article className="landing-flow-card landing-reveal"><span className="flow-number">03</span><div className="flow-icon"><BookOpenText size={22} /></div><h3>Support learning</h3><p>Keep academic information and learning workflows connected to each student.</p></article>
          </div>
        </div>
      </section>

      <section className="landing-section landing-faq" id="faq">
        <div className="landing-container landing-faq-container">
          <div className="landing-section-heading landing-reveal">
            <h2>Good to know.</h2>
            <p>Some practical details about Campus Connect.</p>
          </div>
          <div className="landing-faq-list">
            {questions.map(({ question, answer }, index) => {
              const expanded = activeQuestion === index;
              const answerId = `landing-faq-answer-${index}`;
              return <article className={`landing-faq-item landing-reveal${expanded ? ' expanded' : ''}`} key={question}>
                <h3><button type="button" aria-expanded={expanded} aria-controls={answerId} onClick={() => setActiveQuestion(expanded ? null : index)}><span>{question}</span><span className="faq-plus" aria-hidden="true" /></button></h3>
                <div className="landing-faq-answer" id={answerId} hidden={!expanded}><p>{answer}</p></div>
              </article>;
            })}
          </div>
        </div>
      </section>

      <section className="landing-cta-section" id="contact">
        <div className="landing-container">
          <div className="landing-cta-card landing-reveal">
            <div className="cta-glow" aria-hidden="true" />
            <h2>Bring your school information and learning into one workspace.</h2>
            <p>Start by setting up an account and creating your school workspace.</p>
            <Link className="landing-button landing-button-primary landing-button-large" to="/login">Get started <ArrowRight size={18} /></Link>
          </div>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="landing-container landing-footer-inner">
          <a className="landing-brand" href="#home"><span className="landing-brand-mark">{logoUrl ? <img src={logoUrl} alt="" /> : <BookOpenCheck size={18} />}</span><span>{platformName}</span></a>
          <p>School information, operations, and learning in one connected system.</p>
          <a href="#home" className="landing-back-top">Back to top ↑</a>
        </div>
        <div className="landing-container landing-footer-bottom"><span>{platformName}</span><Link to="/login">Sign in to your workspace</Link></div>
      </footer>
    </main>
  );
}
