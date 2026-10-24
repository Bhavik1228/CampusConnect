import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Download, MessageCircle, Paperclip, RefreshCw, Send } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';
import type { AppRole } from '../types/database';

interface Recipient {
  profile_id: string;
  display_name: string;
  role: AppRole;
}

interface Conversation {
  conversation_id: string;
  other_profile_id: string;
  other_display_name: string;
  other_role: AppRole;
  other_last_read_at: string | null;
  last_message: string | null;
  last_message_at: string | null;
  unread_count: number;
}

interface Message {
  id: string;
  sender_id: string;
  body: string;
  created_at: string;
}

interface Attachment {
  id: string;
  message_id: string;
  file_name: string;
  storage_path: string;
  content_type: string;
  file_size: number;
}

const roleNames: Record<AppRole, string> = {
  system_admin: 'System admin',
  school_admin: 'School admin',
  academic_coordinator: 'Academic coordinator',
  teacher: 'Teacher',
  student: 'Student',
  parent: 'Parent',
  finance_manager: 'Finance manager',
  accountant: 'Accountant',
  bursar: 'Bursar',
  cashier: 'Cashier',
  accounts_payable_officer: 'Accounts payable officer',
  auditor: 'Auditor / read-only reviewer',
  librarian: 'Librarian',
  nurse: 'School nurse',
  doctor: 'School doctor',
  secretary: 'School secretary',
};

function formatDate(value: string | null) {
  if (!value) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

export function MessagingPage() {
  const { activeMembership, user } = useAuth();
  const schoolId = activeMembership?.school_id;
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [activeConversation, setActiveConversation] = useState('');
  const [selectedRecipient, setSelectedRecipient] = useState('');
  const [draft, setDraft] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [attachmentsEnabled, setAttachmentsEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const activeThread = conversations.find((item) => item.conversation_id === activeConversation) ?? null;
  const attachmentsByMessage = useMemo(() => {
    const grouped = new Map<string, Attachment[]>();
    for (const attachment of attachments) {
      grouped.set(attachment.message_id, [...(grouped.get(attachment.message_id) ?? []), attachment]);
    }
    return grouped;
  }, [attachments]);

  const loadThreads = useCallback(async () => {
    if (!schoolId) return;
    setError('');
    try {
      const client = requireSupabase();
      const [{ data: threadData, error: threadError }, { data: recipientData, error: recipientError }, { data: settingData, error: settingError }] = await Promise.all([
        client.rpc('list_direct_conversations', { target_school: schoolId }),
        client.rpc('list_message_recipients', { target_school: schoolId }),
        client.rpc('get_messaging_settings', { target_school: schoolId }),
      ]);
      if (threadError) throw threadError;
      if (recipientError) throw recipientError;
      if (settingError) throw settingError;
      const nextThreads = (threadData ?? []) as Conversation[];
      const settings = settingData?.[0] as { module_messaging: boolean; messaging_attachments: boolean } | undefined;
      setConversations(nextThreads);
      setRecipients((recipientData ?? []) as Recipient[]);
      setAttachmentsEnabled(settings?.messaging_attachments ?? true);
      setActiveConversation((current) => current && nextThreads.some((thread) => thread.conversation_id === current)
        ? current
        : (nextThreads[0]?.conversation_id ?? ''));
      if (settings && !settings.module_messaging) {
        setError('Internal messaging is disabled by your school administrator.');
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load school messages.');
    } finally {
      setLoading(false);
    }
  }, [schoolId]);

  const loadMessages = useCallback(async () => {
    if (!schoolId || !activeConversation) {
      setMessages([]);
      setAttachments([]);
      return;
    }
    try {
      const client = requireSupabase();
      const { data: messageData, error: messageError } = await client
        .from('messages')
        .select('id, sender_id, body, created_at')
        .eq('school_id', schoolId)
        .eq('conversation_id', activeConversation)
        .order('created_at');
      if (messageError) throw messageError;
      const messageRows = (messageData ?? []) as Message[];
      setMessages(messageRows);
      const messageIds = messageRows.map((message) => message.id);
      if (messageIds.length) {
        const { data: attachmentData, error: attachmentError } = await client
          .from('message_attachments')
          .select('id, message_id, file_name, storage_path, content_type, file_size')
          .eq('school_id', schoolId)
          .in('message_id', messageIds);
        if (attachmentError) throw attachmentError;
        setAttachments((attachmentData ?? []) as Attachment[]);
      } else {
        setAttachments([]);
      }
      const { error: readError } = await client.rpc('mark_conversation_read', {
        target_conversation: activeConversation,
      });
      if (readError) throw readError;
      setConversations((current) => current.map((thread) => thread.conversation_id === activeConversation
        ? { ...thread, unread_count: 0 }
        : thread));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load this conversation.');
    }
  }, [activeConversation, refreshKey, schoolId]);

  useEffect(() => {
    setActiveConversation('');
    setSelectedRecipient('');
    setConversations([]);
    setRecipients([]);
    setMessages([]);
    setAttachments([]);
    setDraft('');
    setFile(null);
    setError('');
    setLoading(true);
  }, [schoolId]);

  useEffect(() => { void loadThreads(); }, [loadThreads, refreshKey]);
  useEffect(() => { void loadMessages(); }, [loadMessages]);
  useEffect(() => {
    const interval = window.setInterval(() => setRefreshKey((key) => key + 1), 15000);
    return () => window.clearInterval(interval);
  }, []);

  async function beginConversation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !selectedRecipient) return;
    setError('');
    try {
      const { data, error: startError } = await requireSupabase().rpc('start_direct_conversation', {
        target_school: schoolId,
        target_profile: selectedRecipient,
      });
      if (startError) throw startError;
      setActiveConversation(data as string);
      setSelectedRecipient('');
      setRefreshKey((key) => key + 1);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Could not start this conversation.');
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !activeConversation || !user || (!draft.trim() && !file)) return;
    setSending(true);
    setError('');
    let uploadedPath: string | null = null;
    try {
      const client = requireSupabase();
      const messageBody = draft.trim() || (file ? 'Shared an attachment.' : '');
      if (file) {
        if (file.size > 10 * 1024 * 1024 || file.name.length > 200) {
          throw new Error('Attachments must be no larger than 10 MB and have a filename under 200 characters.');
        }
        const path = `${schoolId}/${activeConversation}/${user.id}/${crypto.randomUUID()}`;
        const { error: uploadError } = await client.storage.from('message-attachments').upload(path, file, {
          contentType: file.type,
          upsert: false,
        });
        if (uploadError) throw uploadError;
        uploadedPath = path;
        const { error: messageError } = await client.rpc('send_message_with_attachment', {
          target_school: schoolId,
          target_conversation: activeConversation,
          message_body: draft.trim(),
          target_file_name: file.name,
          target_storage_path: path,
          target_content_type: file.type,
          target_file_size: file.size,
        });
        if (messageError) throw messageError;
      } else {
        const { error: messageError } = await client
          .from('messages')
          .insert({
            school_id: schoolId,
            conversation_id: activeConversation,
            sender_id: user.id,
            body: messageBody,
          });
        if (messageError) throw messageError;
      }
      setDraft('');
      setFile(null);
      setRefreshKey((key) => key + 1);
      await loadMessages();
    } catch (sendError) {
      if (uploadedPath) {
        const { error: cleanupError } = await requireSupabase().storage.from('message-attachments').remove([uploadedPath]);
        if (cleanupError) console.error('Unable to remove an unlinked message attachment.', cleanupError);
      }
      setError(sendError instanceof Error ? sendError.message : 'Could not send this message.');
    } finally {
      setSending(false);
    }
  }

  async function downloadAttachment(attachment: Attachment) {
    setError('');
    try {
      const { data, error: linkError } = await requireSupabase()
        .storage.from('message-attachments').createSignedUrl(attachment.storage_path, 60);
      if (linkError) throw linkError;
      window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : 'Could not download this attachment.');
    }
  }

  if (loading) return <LoadingState label="Loading internal messages…" />;

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div><span className="eyebrow">School workspace</span><h1>Internal messaging</h1><p>Private direct messages for authorized school members.</p></div>
        <button className="button button-quiet" type="button" onClick={() => setRefreshKey((key) => key + 1)}><RefreshCw size={16} />Refresh</button>
      </div>
      {error && <ErrorState message={error} />}
      {!error.includes('disabled') && <div className="messaging-layout">
        <aside className="content-card messaging-sidebar">
          <div className="section-heading"><div><span className="eyebrow">Conversations</span><h2>Direct messages</h2></div><MessageCircle size={19} className="muted-icon" /></div>
          <form className="messaging-new-form" onSubmit={(event) => void beginConversation(event)}>
            <label className="field"><span>New message</span><select value={selectedRecipient} onChange={(event) => setSelectedRecipient(event.target.value)} required>
              <option value="">Choose an authorized recipient</option>
              {recipients.map((recipient) => <option key={recipient.profile_id} value={recipient.profile_id}>{recipient.display_name} · {roleNames[recipient.role]}</option>)}
            </select></label>
            <button className="button button-primary" type="submit" disabled={!selectedRecipient}>Open conversation</button>
          </form>
          <div className="messaging-thread-list">
            {conversations.map((thread) => <button
              type="button"
              key={thread.conversation_id}
              className={`messaging-thread${activeConversation === thread.conversation_id ? ' active' : ''}`}
              onClick={() => setActiveConversation(thread.conversation_id)}
            >
              <span className="messaging-thread-top"><strong>{thread.other_display_name}</strong>{thread.unread_count > 0 && <span className="messaging-unread">{thread.unread_count}</span>}</span>
              <small>{thread.last_message || 'No messages yet'}</small>
              <small className="muted-text">{thread.last_message_at ? formatDate(thread.last_message_at) : roleNames[thread.other_role]}</small>
            </button>)}
          </div>
        </aside>
        <section className="content-card messaging-conversation">
          {activeThread ? <>
            <div className="section-heading"><div><span className="eyebrow">{roleNames[activeThread.other_role]}</span><h2>{activeThread.other_display_name}</h2></div></div>
            <div className="messaging-history" aria-live="polite">
              {messages.length === 0 ? <EmptyState title="Start the conversation" detail="Send a message to begin this private conversation." /> : messages.map((message) => <article className={`message-bubble${message.sender_id === user?.id ? ' own' : ''}`} key={message.id}>
                <p>{message.body}</p>
                {(attachmentsByMessage.get(message.id) ?? []).map((attachment) => <button className="message-attachment" key={attachment.id} type="button" onClick={() => void downloadAttachment(attachment)}><Download size={15} /><span>{attachment.file_name}</span><small>{Math.ceil(attachment.file_size / 1024)} KB</small></button>)}
                <time>{formatDate(message.created_at)}{message.sender_id === user?.id ? ` · ${activeThread.other_last_read_at && message.created_at <= activeThread.other_last_read_at ? 'Read' : 'Sent'}` : ''}</time>
              </article>)}
            </div>
            <form className="messaging-compose" onSubmit={(event) => void sendMessage(event)}>
              <label className="field"><span>Message</span><textarea value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={10000} rows={3} placeholder="Write a message…" /></label>
              <div className="messaging-compose-actions">
                {attachmentsEnabled && <label className="button button-quiet messaging-file-button"><Paperclip size={16} />{file ? file.name : 'Attach file'}<input type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.txt,.doc,.docx" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>}
                {file && <button className="button button-quiet" type="button" onClick={() => setFile(null)}>Remove file</button>}
                <button className="button button-primary" type="submit" disabled={sending || (!draft.trim() && !file)}><Send size={16} />{sending ? 'Sending…' : 'Send'}</button>
              </div>
            </form>
          </> : <EmptyState title="Choose a conversation" detail="Start a direct message or select one from your conversation list." />}
        </section>
      </div>}
    </div>
  );
}
