import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Activity, LifeBuoy, RefreshCw, Send, Stethoscope } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/Feedback';
import { useAuth } from '../contexts/AuthContext';
import { requireSupabase } from '../lib/supabase';
import {
  getDiagnosticFeature,
  supportDiagnosticContextKey,
  supportRetryStorageKey,
} from '../lib/diagnostic-errors';

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
type AssistantResult = {
  answer: string;
  steps: string[];
  code: string;
  feature: string;
  schoolName: string;
  checkedAt: string;
  liveStatus: 'available' | 'maintenance' | 'unavailable';
  safeFixAvailable: boolean;
  escalated: boolean;
  ticketId?: string;
  retryPath: string | null;
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

function parseAssistant(value: unknown): AssistantResult {
  if (!isRecord(value)
    || typeof value.answer !== 'string'
    || !Array.isArray(value.steps)
    || !value.steps.every((step) => typeof step === 'string')
    || typeof value.code !== 'string'
    || typeof value.feature !== 'string'
    || typeof value.schoolName !== 'string'
    || typeof value.checkedAt !== 'string'
    || (value.liveStatus !== 'available' && value.liveStatus !== 'maintenance' && value.liveStatus !== 'unavailable')
    || typeof value.safeFixAvailable !== 'boolean'
    || typeof value.escalated !== 'boolean'
    || (value.ticketId !== undefined && typeof value.ticketId !== 'string')
    || (value.retryPath !== undefined && value.retryPath !== null && typeof value.retryPath !== 'string')) {
    throw new Error('The Support Bot returned an invalid diagnostic result.');
  }
  return { ...value, retryPath: typeof value.retryPath === 'string' ? value.retryPath : null } as AssistantResult;
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

function takeErrorContext(code: string) {
  if (!code) return '';
  try {
    const key = `${supportDiagnosticContextKey}:${code}`;
    const saved = sessionStorage.getItem(key);
    if (!saved) return '';
    sessionStorage.removeItem(key);
    const value: unknown = JSON.parse(saved);
    if (!isRecord(value) || typeof value.message !== 'string' || typeof value.createdAt !== 'number') return '';
    if (Date.now() - value.createdAt > 10 * 60_000) return '';
    return value.message.slice(0, 1000);
  } catch (error) {
    console.error('Could not restore the feature error details.', error);
    return '';
  }
}

export function SupportPage() {
  const { activeMembership, refreshMemberships } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const searchParams = new URLSearchParams(location.search);
  const initialCode = searchParams.get('code') ?? '';
  const initialFeature = searchParams.get('feature') ?? '';
  const initialFrom = searchParams.get('from') ?? '';
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [errorCode, setErrorCode] = useState(initialCode);
  const [question, setQuestion] = useState(initialCode ? `${initialFeature || 'Feature'} error ${initialCode}` : '');
  const [sourceMessage] = useState(() => takeErrorContext(initialCode));
  const [assistant, setAssistant] = useState<AssistantResult | null>(null);
  const [category, setCategory] = useState('technical');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const handledRetryFailure = useRef(false);

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
      setTickets(data.tickets.map((ticket: unknown) => parseTicket(ticket)));
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

  const escalate = useCallback(async (failureMessage: string) => {
    if (!activeMembership) return;
    setDiagnosing(true);
    setError('');
    try {
      const feature = getDiagnosticFeature(initialFrom || location.pathname);
      const { data, error: requestError } = await requireSupabase().functions.invoke('support-bot', {
        body: {
          action: 'auto-escalate',
          schoolId: activeMembership.school_id,
          code: errorCode.trim(),
          feature: initialFeature || assistant?.feature || feature.name,
          errorMessage: [sourceMessage, failureMessage].filter(Boolean).join('\nRecovery attempt: '),
          query: question.trim(),
        },
      });
      if (requestError) throw requestError;
      const ticket = parseTicket(data?.ticket);
      setNotice(`The retry still failed. Request ${ticket.id.slice(0, 8).toUpperCase()} was automatically sent to the platform owner.`);
      await loadTickets(true);
    } catch (escalationError) {
      setError(escalationError instanceof Error
        ? `The issue could not be automatically sent to the platform owner: ${escalationError.message}`
        : 'The issue could not be automatically sent to the platform owner.');
    } finally {
      setDiagnosing(false);
    }
  }, [activeMembership, assistant?.feature, errorCode, initialFeature, initialFrom, loadTickets, location.pathname, question, sourceMessage]);

  useEffect(() => {
    if (searchParams.get('retryFailed') !== '1' || handledRetryFailure.current || !activeMembership) return;
    handledRetryFailure.current = true;
    void escalate('The same feature error appeared again after safe recovery and retry.');
  }, [activeMembership, escalate, location.search]);

  async function runAssistant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeMembership) return;
    setDiagnosing(true);
    setError('');
    setNotice('');
    setAssistant(null);
    try {
      const client = requireSupabase();
      const { data: sessionData, error: refreshError } = await client.auth.refreshSession();
      if (refreshError) throw refreshError;
      if (!sessionData.session) throw new Error('Your sign-in could not be refreshed.');
      await refreshMemberships();
      const { data, error: requestError } = await client.functions.invoke('support-bot', {
        body: {
          action: 'assist',
          schoolId: activeMembership.school_id,
          code: errorCode.trim(),
          query: question.trim(),
          errorMessage: sourceMessage,
          feature: initialFeature,
          from: initialFrom || location.pathname,
        },
      });
      if (requestError) throw requestError;
      const result = parseAssistant(data?.assistant);
      setAssistant(result);
      if (result.escalated) {
        setNotice(`The Bot could not safely resolve this error. It automatically sent request ${result.ticketId?.slice(0, 8).toUpperCase() ?? ''} to the platform owner.`);
        await loadTickets(true);
      }
    } catch (assistError) {
      const message = assistError instanceof Error ? assistError.message : 'The safe access refresh or live feature check failed.';
      setError(`The safe recovery attempt failed. Sending the issue to the platform owner. ${message}`);
      await escalate(message);
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
      const context = errorCode.trim()
        ? `\n\nError code: ${errorCode.trim()}\nFeature: ${initialFeature || assistant?.feature || 'School workspace'}\nOriginal error: ${sourceMessage || '(not provided)'}`
        : '';
      const { data, error: requestError } = await requireSupabase().functions.invoke('support-bot', {
        body: {
          action: 'submit-ticket',
          schoolId: activeMembership.school_id,
          category,
          title: title.trim(),
          description: `${description.trim()}${context}`.slice(0, 5000),
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

  function retryOriginalFeature() {
    if (!assistant?.retryPath || assistant.retryPath === '/support' || assistant.retryPath.startsWith('/system-owner')) return;
    try {
      const createdAt = Date.now();
      sessionStorage.setItem(supportRetryStorageKey, JSON.stringify({
        code: assistant.code,
        path: assistant.retryPath,
        createdAt,
      }));
      window.setTimeout(() => {
        try {
          const saved = sessionStorage.getItem(supportRetryStorageKey);
          if (!saved) return;
          const retry: unknown = JSON.parse(saved);
          if (isRecord(retry) && retry.createdAt === createdAt) {
            sessionStorage.removeItem(supportRetryStorageKey);
          }
        } catch (error) {
          console.error('Could not expire the pending support retry.', error);
        }
      }, 30_000);
      navigate(assistant.retryPath);
    } catch (retryError) {
      console.error('Could not prepare automatic support escalation for the retry.', retryError);
      setError('The retry marker could not be saved in this browser. You can still retry the feature; if it fails again, submit a support request with the error code.');
    }
  }

  return <main className="support-page">
    <header className="support-header">
      <div><span className="eyebrow">Help for {activeMembership?.school.name}</span><h1><LifeBuoy size={25} /> Support Bot</h1><p>Paste a feature error code or describe the problem. The Bot checks your live school access, explains the failure, and tries a safe recovery.</p></div>
      <button className="button button-quiet" onClick={() => void loadTickets(true)} disabled={refreshing}><RefreshCw size={15} className={refreshing ? 'system-owner-spinning' : ''} /> Refresh requests</button>
    </header>
    {error && <ErrorState message={error} />}
    {notice && <p className="inline-success" role="status">{notice}</p>}

    <section className="content-card support-panel">
      <div className="support-panel-heading"><span className="support-icon"><Stethoscope size={18} /></span><div><h2>Diagnose a feature error</h2><p>Use the error code shown on the failed feature, or ask a question in plain English. The failed feature is not replayed or modified during diagnosis.</p></div></div>
      <form className="support-assistant-form" onSubmit={(event) => void runAssistant(event)}>
        <label className="field"><span>Error code (if shown)</span><input value={errorCode} onChange={(event) => setErrorCode(event.target.value.toUpperCase())} maxLength={64} placeholder="For example: CC-ATT-1A2B3C4D" /></label>
        <label className="field"><span>Your question or what happened?</span><textarea required={errorCode.trim().length === 0} minLength={errorCode.trim() ? undefined : 3} maxLength={1000} rows={3} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Paste an error code, or describe the feature and what you were trying to do." /></label>
        <button className="button button-primary" type="submit" disabled={diagnosing || (!errorCode.trim() && !question.trim())}>{diagnosing ? <RefreshCw size={15} className="system-owner-spinning" /> : <Activity size={15} />} {diagnosing ? 'Checking and refreshing access…' : 'Explain and try safe recovery'}</button>
      </form>
      {assistant && <div className="support-diagnostic-result" role="status">
        <div><strong>{assistant.answer}</strong><small>{assistant.feature} · {assistant.schoolName} · Checked {formatDate(assistant.checkedAt)}{assistant.code ? ` · ${assistant.code}` : ''}</small></div>
        {assistant.steps.length > 0 && <ol>{assistant.steps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}</ol>}
        {assistant.escalated
          ? <p>The request is saved in the platform owner's persistent inbox.</p>
          : assistant.safeFixAvailable && assistant.retryPath && assistant.retryPath !== '/support' && !assistant.retryPath.startsWith('/system-owner')
            ? <button className="button button-quiet support-retry-button" type="button" onClick={retryOriginalFeature} disabled={diagnosing}>Retry the feature — automatically report it if it fails again</button>
            : <p>If these steps do not resolve it, use the support request form below. Your error code and original details will be attached.</p>}
      </div>}
    </section>

    <section className="content-card support-panel">
      <div className="support-panel-heading"><span className="support-icon"><Send size={17} /></span><div><h2>Send a request to the platform owner</h2><p>If the Bot cannot explain the problem or a retry fails, your request and error details are saved to the owner's inbox even while they are signed out.</p></div></div>
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
