import { useCallback, useEffect, useState } from 'react';
import { LifeBuoy, RefreshCw, Save } from 'lucide-react';
import { ErrorState, LoadingState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';
import { invokeSystemOwnerAction } from '../lib/system-owner-actions';

type TicketStatus = 'new' | 'in_progress' | 'waiting_on_requester' | 'resolved' | 'closed';
type SupportTicket = {
  id: string;
  school_id: string | null;
  school_name: string;
  requester_name: string;
  requester_email: string | null;
  requester_role: string;
  category: string;
  title: string;
  description: string;
  status: TicketStatus;
  owner_response: string;
  created_at: string;
  updated_at: string;
};
type TicketDraft = { status: TicketStatus; response: string };

const statusOptions: Array<{ value: TicketStatus; label: string }> = [
  { value: 'new', label: 'New' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'waiting_on_requester', label: 'Waiting for requester' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTicket(value: unknown): SupportTicket {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || (value.school_id !== null && typeof value.school_id !== 'string')
    || typeof value.school_name !== 'string'
    || typeof value.requester_name !== 'string'
    || (value.requester_email !== null && typeof value.requester_email !== 'string')
    || typeof value.requester_role !== 'string'
    || typeof value.category !== 'string'
    || typeof value.title !== 'string'
    || typeof value.description !== 'string'
    || typeof value.status !== 'string'
    || !statusOptions.some((option) => option.value === value.status)
    || typeof value.owner_response !== 'string'
    || typeof value.created_at !== 'string'
    || typeof value.updated_at !== 'string') {
    throw new Error('The support inbox returned an invalid request.');
  }
  return value as SupportTicket;
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

export function SystemOwnerSupportPage() {
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [drafts, setDrafts] = useState<Record<string, TicketDraft>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingTicket, setSavingTicket] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadInbox = useCallback(async (background = false) => {
    if (background) setRefreshing(true);
    else setLoading(true);
    try {
      const { data, error: requestError } = await requireSupabase().functions.invoke('system-owner-admin', {
        body: { action: 'support-inbox' },
      });
      if (requestError) throw requestError;
      if (!Array.isArray(data?.tickets)) throw new Error('The support inbox returned an invalid request list.');
      const nextTickets: SupportTicket[] = data.tickets.map((ticket: unknown) => parseTicket(ticket));
      setTickets(nextTickets);
      setDrafts((current) => Object.fromEntries(nextTickets.map((ticket) => [
        ticket.id,
        current[ticket.id] ?? { status: ticket.status, response: ticket.owner_response },
      ])));
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load support requests.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void loadInbox(); }, [loadInbox]);
  useEffect(() => {
    const timer = window.setInterval(() => { void loadInbox(true); }, 30_000);
    return () => window.clearInterval(timer);
  }, [loadInbox]);

  function updateDraft(ticketId: string, changes: Partial<TicketDraft>) {
    setDrafts((current) => ({ ...current, [ticketId]: { ...current[ticketId], ...changes } }));
  }

  async function saveTicket(ticketId: string) {
    const draft = drafts[ticketId];
    if (!draft) return;
    setSavingTicket(ticketId);
    setError('');
    setNotice('');
    try {
      const { error: saveError } = await invokeSystemOwnerAction({
        body: {
          action: 'update-support-ticket',
          ticketId,
          ticketStatus: draft.status,
          ownerResponse: draft.response,
        },
      });
      if (saveError) throw saveError;
      setNotice('Support request updated. The requester will see the status and response in Support Bot.');
      await loadInbox(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not update this support request.');
    } finally {
      setSavingTicket('');
    }
  }

  const newCount = tickets.filter((ticket) => ticket.status === 'new').length;
  return <main className="system-owner-page">
    <header className="system-owner-header"><div><span className="eyebrow">Persistent request inbox</span><h1>Support requests</h1><p>Unresolved requests stay here across sign-outs and are shared only with the verified platform owner.</p></div><button className="button button-quiet" disabled={refreshing} onClick={() => void loadInbox(true)}><RefreshCw size={15} className={refreshing ? 'system-owner-spinning' : ''} /> Refresh inbox</button></header>
    {error && <ErrorState message={error} />}
    {notice && <p className="inline-success" role="status">{notice}</p>}
    <section className="content-card support-panel">
      <div className="support-panel-heading"><span className="support-icon"><LifeBuoy size={18} /></span><div><h2>{tickets.length} unresolved request{tickets.length === 1 ? '' : 's'}</h2><p>{newCount} new · Requests remain in this inbox until marked resolved or closed. The inbox refreshes every 30 seconds.</p></div></div>
      {loading ? <LoadingState label="Loading persistent support requests…" /> : tickets.length
        ? <div className="support-ticket-list">{tickets.map((ticket) => {
          const draft = drafts[ticket.id] ?? { status: ticket.status, response: ticket.owner_response };
          return <article className="support-ticket owner-support-ticket" key={ticket.id}>
            <div className="support-ticket-heading"><div><span className="support-ticket-category">{ticket.category.replaceAll('_', ' ')} · {ticket.requester_role.replaceAll('_', ' ')}</span><h3>{ticket.title}</h3><small>{ticket.school_name} · {ticket.requester_name}{ticket.requester_email ? ` · ${ticket.requester_email}` : ''} · {formatDate(ticket.created_at)}</small></div><span className={`support-ticket-status ${ticket.status}`}>{ticket.status.replaceAll('_', ' ')}</span></div>
            <p>{ticket.description}</p>
            <div className="support-owner-controls">
              <label className="field"><span>Status</span><select value={draft.status} onChange={(event) => updateDraft(ticket.id, { status: event.target.value as TicketStatus })}>{statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              <label className="field"><span>Response for requester</span><textarea rows={3} maxLength={4000} value={draft.response} onChange={(event) => updateDraft(ticket.id, { response: event.target.value })} placeholder="Add a response or next steps. It will appear in the requester's Support Bot." /></label>
              <button className="button button-primary" disabled={savingTicket === ticket.id} onClick={() => void saveTicket(ticket.id)}><Save size={14} /> {savingTicket === ticket.id ? 'Saving…' : 'Save update'}</button>
            </div>
          </article>;
        })}</div>
        : <p className="support-empty">No unresolved support requests. New requests are saved here even when you are signed out.</p>}
    </section>
  </main>;
}
