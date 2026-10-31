import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Activity, LifeBuoy, RefreshCw, Send, Stethoscope } from 'lucide-react';
import { ErrorState, LoadingState } from '../components/Feedback';
import { useAuth } from '../contexts/AuthContext';
import { requireSupabase } from '../lib/supabase';

type TicketStatus = 'new' | 'in_progress' | 'waiting_on_requester' | 'resolved' | 'closed';
type SupportTicket = {
  id: string;
  category: string;
  title: string;
  description: string;
  status: TicketStatus;
  owner_response: string;
  created_at: string;
  updated_at: string;
};
type DiagnosticMatch = {
  rule_key: string;
  name: string;
  status: string;
  severity: string;
  result_message: string;
  fix_route: string | null;
};
type Diagnostic = {
  schoolName: string;
  role: string;
  checkedAt: string;
  summary: string;
  matches: DiagnosticMatch[];
  matchCount: number;
  canViewSetupHealth: boolean;
};

const categories = [
  { value: 'account_access', label: 'Account access' },
  { value: 'academics', label: 'Academics & classes' },
  { value: 'attendance', label: 'Attendance' },
  { value: 'finance', label: 'Finance' },
  { value: 'technical', label: 'Technical issue' },
  { value: 'other', label: 'Other' },
];

const statusLabels: Record<TicketStatus, string> = {
  new: 'Received',
  in_progress: 'In progress',
  waiting_on_requester: 'Waiting for you',
  resolved: 'Resolved',
  closed: 'Closed',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTicket(value: unknown): SupportTicket {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.category !== 'string'
    || typeof value.title !== 'string'
    || typeof value.description !== 'string'
    || typeof value.status !== 'string'
    || !(value.status in statusLabels)
    || typeof value.owner_response !== 'string'
    || typeof value.created_at !== 'string'
    || typeof value.updated_at !== 'string') {
    throw new Error('The support service returned an invalid ticket.');
  }
  return value as SupportTicket;
}

function parseDiagnostic(value: unknown): Diagnostic {
  if (!isRecord(value)
    || typeof value.schoolName !== 'string'
    || typeof value.role !== 'string'
    || typeof value.checkedAt !== 'string'
    || typeof value.summary !== 'string'
    || !Array.isArray(value.matches)
    || typeof value.matchCount !== 'number'
    || typeof value.canViewSetupHealth !== 'boolean') {
    throw new Error('The diagnostic service returned an invalid result.');
  }
  const matches = value.matches.map((match) => {
    if (!isRecord(match)
      || typeof match.rule_key !== 'string'
      || typeof match.name !== 'string'
      || typeof match.status !== 'string'
      || typeof match.severity !== 'string'
      || typeof match.result_message !== 'string'
      || (match.fix_route !== null && typeof match.fix_route !== 'string')) {
      throw new Error('The diagnostic service returned an invalid health check.');
    }
    return match as DiagnosticMatch;
  });
  return { ...value, matches } as Diagnostic;
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

export function SupportPage() {
  const { activeMembership } = useAuth();
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [question, setQuestion] = useState('');
  const [diagnostic, setDiagnostic] = useState<Diagnostic | null>(null);
  const [category, setCategory] = useState('technical');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  const loadTickets = useCallback(async (background = false) => {
    if (!activeMembership) return;
    if (background) setRefreshing(true);
    else setLoading(true);
    try {
      const { data, error: requestError } = await requireSupabase().functions.invoke('support-bot', {
        body: { action: 'list-tickets', schoolId: activeMembership.school_id },
      });
      if (requestError) throw requestError;
      if (!Array.isArray(data?.tickets)) throw new Error('The support service returned an invalid ticket list.');
      setTickets(data.tickets.map(parseTicket));
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load your support requests.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeMembership]);

  useEffect(() => { void loadTickets(); }, [loadTickets]);
  useEffect(() => {
    const timer = window.setInterval(() => { void loadTickets(true); }, 30_000);
    return () => window.clearInterval(timer);
  }, [loadTickets]);

  async function runDiagnostic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeMembership) return;
    setDiagnosing(true);
    setError('');
    setNotice('');
    try {
      const { data, error: requestError } = await requireSupabase().functions.invoke('support-bot', {
        body: {
          action: 'diagnose',
          schoolId: activeMembership.school_id,
          query: question.trim(),
        },
      });
      if (requestError) throw requestError;
      setDiagnostic(parseDiagnostic(data?.diagnostic));
    } catch (diagnosticError) {
      setError(diagnosticError instanceof Error ? diagnosticError.message : 'The live diagnostic could not be completed.');
    } finally {
      setDiagnosing(false);
    }
  }

  async function submitTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeMembership) return;
    setSubmitting(true);
    setError('');
    setNotice('');
    try {
      const { data, error: requestError } = await requireSupabase().functions.invoke('support-bot', {
        body: {
          action: 'submit-ticket',
          schoolId: activeMembership.school_id,
          category,
          title: title.trim(),
          description: description.trim(),
        },
      });
      if (requestError) throw requestError;
      const ticket = parseTicket(data?.ticket);
      setNotice(`Request ${ticket.id.slice(0, 8).toUpperCase()} was saved and sent to the support team.`);
      setTitle('');
      setDescription('');
      void loadTickets(true);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Your support request could not be submitted.');
    } finally {
      setSubmitting(false);
    }
  }

  return <main className="support-page">
    <header className="support-header">
      <div><span className="eyebrow">Help for {activeMembership?.school.name}</span><h1><LifeBuoy size={25} /> Support Bot</h1><p>Run a live workspace check, submit a request, and follow its status here.</p></div>
      <button className="button button-quiet" onClick={() => void loadTickets(true)} disabled={refreshing}><RefreshCw size={15} className={refreshing ? 'system-owner-spinning' : ''} /> Refresh requests</button>
    </header>
    {error && <ErrorState message={error} />}
    {notice && <p className="inline-success" role="status">{notice}</p>}

    <section className="content-card support-panel">
      <div className="support-panel-heading"><span className="support-icon"><Stethoscope size={18} /></span><div><h2>Live diagnostic lookup</h2><p>Checks your signed-in account and this school's current backend status. School health details are shown only to authorized school administrators and academic coordinators.</p></div></div>
      <form className="support-diagnostic-form" onSubmit={(event) => void runDiagnostic(event)}>
        <label className="field"><span>What is going wrong? (optional)</span><input value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={1000} placeholder="For example: timetable setup, attendance, or account access" /></label>
        <button className="button button-primary" type="submit" disabled={diagnosing}>{diagnosing ? <RefreshCw size={15} className="system-owner-spinning" /> : <Activity size={15} />} {diagnosing ? 'Checking live data…' : 'Run diagnostic'}</button>
      </form>
      {diagnostic && <div className="support-diagnostic-result" role="status">
        <div><strong>{diagnostic.summary}</strong><small>{diagnostic.schoolName} · {diagnostic.role.replaceAll('_', ' ')} · Checked {formatDate(diagnostic.checkedAt)}</small></div>
        {diagnostic.matches.length > 0
          ? <ul>{diagnostic.matches.map((match) => <li key={match.rule_key}><span className={`support-severity ${match.severity}`}>{match.severity}</span><div><strong>{match.name}</strong><p>{match.result_message}</p>{match.fix_route && <a href={match.fix_route}>Open the related workspace</a>}</div></li>)}</ul>
          : <p>{diagnostic.canViewSetupHealth ? 'No unresolved setup checks matched this lookup.' : 'Your role does not include school setup-health access. The live account, school membership, and platform status were verified.'}</p>}
      </div>}
    </section>

    <section className="content-card support-panel">
      <div className="support-panel-heading"><span className="support-icon"><Send size={17} /></span><div><h2>Submit a support request</h2><p>Requests are attached to your authenticated account, role, and current school. The platform owner can respond in this panel.</p></div></div>
      <form className="support-ticket-form" onSubmit={(event) => void submitTicket(event)}>
        <label className="field"><span>Category</span><select value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label className="field"><span>Request title</span><input required minLength={3} maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Briefly summarize the issue" /></label>
        <label className="field support-description"><span>What happened?</span><textarea required minLength={10} maxLength={5000} rows={5} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Include the steps to reproduce the issue and what you expected to happen." /></label>
        <button className="button button-primary" type="submit" disabled={submitting}>{submitting ? 'Submitting…' : 'Send support request'}</button>
      </form>
    </section>

    <section className="content-card support-panel">
      <div className="support-panel-heading"><span className="support-icon"><LifeBuoy size={18} /></span><div><h2>Your support requests</h2><p>Statuses and owner responses refresh automatically while this page is open.</p></div></div>
      {loading ? <LoadingState label="Loading your support requests…" /> : tickets.length
        ? <div className="support-ticket-list">{tickets.map((ticket) => <article className="support-ticket" key={ticket.id}>
          <div className="support-ticket-heading"><div><span className="support-ticket-category">{ticket.category.replaceAll('_', ' ')}</span><h3>{ticket.title}</h3><small>Request {ticket.id.slice(0, 8).toUpperCase()} · Submitted {formatDate(ticket.created_at)}</small></div><span className={`support-ticket-status ${ticket.status}`}>{statusLabels[ticket.status]}</span></div>
          <p>{ticket.description}</p>
          {ticket.owner_response && <div className="support-owner-response"><strong>Platform owner response</strong><p>{ticket.owner_response}</p><small>Updated {formatDate(ticket.updated_at)}</small></div>}
        </article>)}</div>
        : <p className="support-empty">You have not submitted any support requests for this school yet.</p>}
    </section>
  </main>;
}
