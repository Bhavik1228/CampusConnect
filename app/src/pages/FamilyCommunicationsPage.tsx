import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Check, MailOpen, Megaphone, RefreshCw, Send, UsersRound } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

interface FamilyCommunication {
  communication_id: string;
  title: string;
  body: string;
  class_name: string | null;
  created_at: string;
  delivery_id: string | null;
  delivered_at: string | null;
  read_at: string | null;
  recipient_count: number;
  read_count: number;
}

interface SchoolClass {
  id: string;
  name: string;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function FamilyCommunicationsPage() {
  const { activeMembership } = useAuth();
  const schoolId = activeMembership?.school_id;
  const canManage = activeMembership?.role === 'school_admin' || activeMembership?.role === 'academic_coordinator';
  const isParent = activeMembership?.role === 'parent';
  const [communications, setCommunications] = useState<FamilyCommunication[]>([]);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [classId, setClassId] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [readingId, setReadingId] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadCommunications = useCallback(async () => {
    if (!schoolId) return;
    setError('');
    try {
      const client = requireSupabase();
      const { data, error: communicationsError } = await client.rpc('list_family_communications', {
        target_school: schoolId,
      });
      if (communicationsError) throw communicationsError;
      setCommunications((data ?? []) as FamilyCommunication[]);
      if (canManage) {
        const { data: classData, error: classesError } = await client
          .from('school_classes')
          .select('id, name')
          .eq('school_id', schoolId)
          .order('name');
        if (classesError) throw classesError;
        setClasses((classData ?? []) as SchoolClass[]);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load family communications.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [canManage, schoolId]);

  useEffect(() => {
    setLoading(true);
    setCommunications([]);
    setClasses([]);
    void loadCommunications();
  }, [loadCommunications]);

  async function sendCommunication(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !canManage || sending) return;
    setSending(true);
    setError('');
    setNotice('');
    try {
      const { data, error: sendError } = await requireSupabase().rpc('send_family_communication', {
        target_school: schoolId,
        communication_title: title,
        communication_body: body,
        target_class: classId || null,
      });
      if (sendError) throw sendError;
      const deliveredCount = Number(data?.[0]?.delivered_count ?? 0);
      setTitle('');
      setBody('');
      setClassId('');
      setNotice(`Message added to ${deliveredCount} family inbox${deliveredCount === 1 ? '' : 'es'}.`);
      await loadCommunications();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Could not send this family communication.');
    } finally {
      setSending(false);
    }
  }

  async function markAsRead(deliveryId: string) {
    if (!deliveryId || readingId) return;
    setReadingId(deliveryId);
    setError('');
    try {
      const { error: readError } = await requireSupabase().rpc('mark_family_communication_read', {
        target_delivery: deliveryId,
      });
      if (readError) throw readError;
      setCommunications((current) => current.map((item) => item.delivery_id === deliveryId
        ? { ...item, read_at: new Date().toISOString() }
        : item));
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : 'Could not update the message read status.');
    } finally {
      setReadingId('');
    }
  }

  function refresh() {
    setRefreshing(true);
    void loadCommunications();
  }

  if (!canManage && !isParent) {
    return <div className="page-stack">
      <div className="page-heading"><div><span className="eyebrow">Communication</span><h1>Family communications</h1></div></div>
      <ErrorState message="Your school role cannot access family communications." />
    </div>;
  }

  return <div className="page-stack family-communications-page">
    <div className="page-heading">
      <div>
        <span className="eyebrow">{canManage ? 'School communication' : 'Family inbox'}</span>
        <h1>Family communication centre</h1>
        <p>{canManage
          ? 'Send an in-app notice to every linked family or to families in a specific class.'
          : 'School notices addressed to your family appear here.'}</p>
      </div>
      <button className="button button-quiet" type="button" onClick={refresh} disabled={loading || refreshing}>
        <RefreshCw size={16} className={refreshing ? 'spin' : undefined} /> Refresh
      </button>
    </div>

    {error && <ErrorState message={error} />}
    {notice && <div className="family-communications-notice" role="status"><Check size={17} />{notice}</div>}

    {canManage && <form className="content-card family-communication-composer" onSubmit={(event) => void sendCommunication(event)}>
      <div className="family-communication-card-heading">
        <Megaphone size={19} />
        <div><h2>Compose family notice</h2><p>Delivery is in-app only. No email or SMS is sent.</p></div>
      </div>
      <label className="field">
        <span>Audience</span>
        <select value={classId} onChange={(event) => setClassId(event.target.value)}>
          <option value="">All linked families</option>
          {classes.map((schoolClass) => <option key={schoolClass.id} value={schoolClass.id}>{schoolClass.name} families</option>)}
        </select>
      </label>
      <label className="field">
        <span>Title</span>
        <input value={title} onChange={(event) => setTitle(event.target.value)} minLength={2} maxLength={160} required />
      </label>
      <label className="field">
        <span>Message</span>
        <textarea value={body} onChange={(event) => setBody(event.target.value)} minLength={2} maxLength={10000} rows={5} required />
      </label>
      <div className="family-communication-form-footer">
        <p className="panel-footnote">Only active students with linked parent accounts receive this notice. Each family account is included once.</p>
        <button className="button button-primary" type="submit" disabled={sending || loading}>
          <Send size={16} />{sending ? 'Sending…' : 'Send notice'}
        </button>
      </div>
    </form>}

    <section className="content-card family-communication-history">
      <div className="family-communication-card-heading">
        {canManage ? <UsersRound size={19} /> : <MailOpen size={19} />}
        <div><h2>{canManage ? 'Delivery history' : 'Your notices'}</h2>
          <p>{canManage ? 'Delivered means available in the linked family in-app inbox.' : 'Mark a notice as read after reviewing it.'}</p></div>
      </div>
      {loading ? <LoadingState label="Loading family communications…" />
        : communications.length === 0
          ? <EmptyState
            title={canManage ? 'No family notices yet' : 'Your inbox is clear'}
            detail={canManage ? 'Sent notices and their delivery/read counts will appear here.' : 'New school notices addressed to your family will appear here.'}
          />
          : <div className="family-communication-list">
            {communications.map((item) => <article className="family-communication-item" key={item.delivery_id ?? item.communication_id}>
              <div className="family-communication-item-top">
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.class_name ? `${item.class_name} families` : 'All linked families'} · {formatDate(item.created_at)}</p>
                </div>
                {canManage
                  ? <span className="status-pill family-communication-read-status">{item.read_count} / {item.recipient_count} read</span>
                  : <span className={`status-pill ${item.read_at ? 'family-communication-read-status' : 'family-communication-unread-status'}`}>{item.read_at ? 'Read' : 'Unread'}</span>}
              </div>
              <p className="family-communication-body">{item.body}</p>
              {canManage
                ? <p className="family-communication-delivery">{item.recipient_count} family inbox{item.recipient_count === 1 ? '' : 'es'} · {item.read_count} read</p>
                : <div className="family-communication-item-bottom">
                  <span>Received {item.delivered_at ? formatDate(item.delivered_at) : 'in your inbox'}</span>
                  {!item.read_at && item.delivery_id && <button className="button button-quiet" type="button" disabled={readingId === item.delivery_id || Boolean(readingId)} onClick={() => void markAsRead(item.delivery_id ?? '')}>
                    <Check size={15} />{readingId === item.delivery_id ? 'Updating…' : 'Mark as read'}
                  </button>}
                </div>}
            </article>)}
          </div>}
    </section>
  </div>;
}
