import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Check, RefreshCw, RotateCcw, Send, ShieldCheck } from 'lucide-react';
import { ErrorState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type EmailEvent =
  | 'positive_recognition'
  | 'recognition_award'
  | 'improvement_update'
  | 'weekly_positive_summary'
  | 'library_recognition'
  | 'concern_notification'
  | 'meeting_invitation'
  | 'followup_reminder'
  | 'support_plan_review'
  | 'case_resolution'
  | 'correction_update'
  | 'staff_escalation'
  | 'manual_report';

type EmailTemplate = {
  id: string;
  school_id: string;
  event_type: EmailEvent;
  enabled: boolean;
  require_approval: boolean;
  delay_minutes: number;
  subject_template: string;
  body_template: string;
};
type EmailDelivery = {
  id: string;
  event_type: EmailEvent;
  status: string;
  created_at: string;
  scheduled_at: string;
  delivered_at: string | null;
  attempt_count: number;
};
type EmailSettings = {
  school_id: string;
  quiet_hours_start: string;
  quiet_hours_end: string;
  school_contact_email: string;
};

const eventLabels: Record<EmailEvent, string> = {
  positive_recognition: 'Positive recognition',
  recognition_award: 'Award or certificate',
  improvement_update: 'Improvement update',
  weekly_positive_summary: 'Weekly positive summary',
  library_recognition: 'Library recognition',
  concern_notification: 'Reviewed concern',
  meeting_invitation: 'Meeting invitation',
  followup_reminder: 'Follow-up reminder',
  support_plan_review: 'Support-plan review',
  case_resolution: 'Case resolution',
  correction_update: 'Correction-request update',
  staff_escalation: 'Staff escalation',
  manual_report: 'Manually emailed report link',
};

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function preview(value: string) {
  return value
    .replaceAll('{secure_link}', 'https://campus-connect.work.gd/behaviour/my')
    .replaceAll('{school_name}', 'Example School')
    .replaceAll('{school_contact}', 'school@example.org');
}

export function StudentBehaviourEmailSettings({ schoolId, userId, canConfigure }: { schoolId: string; userId: string; canConfigure: boolean }) {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [deliveries, setDeliveries] = useState<EmailDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeDelivery, setActiveDelivery] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [templateResult, settingsResult, deliveryResult] = await Promise.all([
        canConfigure
          ? client.from('student_behaviour_email_templates')
            .select('id,school_id,event_type,enabled,require_approval,delay_minutes,subject_template,body_template')
            .eq('school_id', schoolId).order('event_type')
          : Promise.resolve({ data: [], error: null }),
        canConfigure
          ? client.from('student_behaviour_settings')
            .select('school_id,quiet_hours_start,quiet_hours_end,school_contact_email')
            .eq('school_id', schoolId).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        client.from('student_behaviour_email_deliveries')
          .select('id,event_type,status,created_at,scheduled_at,delivered_at,attempt_count')
          .eq('school_id', schoolId).order('created_at', { ascending: false }).limit(100),
      ]);
      if (templateResult.error) throw templateResult.error;
      if (settingsResult.error) throw settingsResult.error;
      if (deliveryResult.error) throw deliveryResult.error;
      setTemplates((templateResult.data ?? []) as EmailTemplate[]);
      setSettings(settingsResult.data as EmailSettings | null);
      setDeliveries((deliveryResult.data ?? []) as EmailDelivery[]);
    } catch (loadError) {
      setError(messageOf(loadError, 'Could not load behaviour email settings.'));
    } finally {
      setLoading(false);
    }
  }, [canConfigure, schoolId]);

  useEffect(() => { void load(); }, [load]);

  function updateTemplate(id: string, patch: Partial<EmailTemplate>) {
    setTemplates((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  async function saveTemplate(event: FormEvent<HTMLFormElement>, template: EmailTemplate) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: saveError } = await requireSupabase().from('student_behaviour_email_templates')
        .update({
          enabled: template.enabled,
          require_approval: template.require_approval,
          delay_minutes: template.delay_minutes,
          subject_template: template.subject_template.trim(),
          body_template: template.body_template.trim(),
          updated_by: userId,
          updated_at: new Date().toISOString(),
        })
        .eq('school_id', schoolId)
        .eq('id', template.id);
      if (saveError) throw saveError;
      setNotice(`${eventLabels[template.event_type]} template saved.`);
    } catch (saveError) {
      setError(messageOf(saveError, 'Could not save this email template.'));
    } finally {
      setSaving(false);
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings || saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: saveError } = await requireSupabase().from('student_behaviour_settings')
        .update({
          quiet_hours_start: settings.quiet_hours_start,
          quiet_hours_end: settings.quiet_hours_end,
          school_contact_email: settings.school_contact_email.trim(),
          updated_by: userId,
          updated_at: new Date().toISOString(),
        })
        .eq('school_id', schoolId);
      if (saveError) throw saveError;
      setNotice('Behaviour email settings saved.');
    } catch (saveError) {
      setError(messageOf(saveError, 'Could not save behaviour email settings.'));
    } finally {
      setSaving(false);
    }
  }

  async function manageDelivery(delivery: EmailDelivery, action: 'approve' | 'retry') {
    if (activeDelivery) return;
    setActiveDelivery(delivery.id);
    setError('');
    setNotice('');
    try {
      const { error: invokeError } = await requireSupabase().functions.invoke('student-behaviour-email', {
        body: { action, deliveryId: delivery.id },
      });
      if (invokeError) throw invokeError;
      setNotice(action === 'approve' ? 'Email approved and queued for delivery.' : 'The confirmed failed email was queued for retry.');
      await load();
    } catch (actionError) {
      setError(messageOf(actionError, 'Could not update this email delivery.'));
    } finally {
      setActiveDelivery('');
    }
  }

  if (loading) return <section className="content-card"><p>Loading email settings…</p></section>;
  if (canConfigure && !settings) return <ErrorState message={error || 'Behaviour email settings are unavailable.'} />;

  return <section className="student-behaviour-email-settings">
    {error && <ErrorState message={error} />}
    {notice && <div className="behaviour-notice" role="status"><Check size={17} />{notice}</div>}
    {canConfigure && settings && <section className="content-card behaviour-email-policy">
      <div className="behaviour-card-heading">
        <div className="behaviour-card-icon"><ShieldCheck size={19} /></div>
        <div><h2>Mail and privacy controls</h2><p>Behaviour email uses the verified Mailjet sender behaviour@campus-connect.work.gd. Security notices continue to use their separate sender.</p></div>
      </div>
      <form className="behaviour-settings-form" onSubmit={(event) => void saveSettings(event)}>
        <label className="field"><span>School contact email</span><input type="email" maxLength={320} value={settings.school_contact_email}
          onChange={(event) => setSettings({ ...settings, school_contact_email: event.target.value })} /></label>
        <label className="field"><span>Quiet hours begin</span><input type="time" required value={settings.quiet_hours_start}
          onChange={(event) => setSettings({ ...settings, quiet_hours_start: event.target.value })} /></label>
        <label className="field"><span>Quiet hours end</span><input type="time" required value={settings.quiet_hours_end}
          onChange={(event) => setSettings({ ...settings, quiet_hours_end: event.target.value })} /></label>
        <button className="button button-primary" type="submit" disabled={saving}>Save mail settings</button>
      </form>
      <p className="behaviour-email-hint">Only a generic notice and a sign-in-required link are sent. Incident descriptions, student names and PDFs are not included. Meeting details are shown after sign-in.</p>
    </section>}

    {canConfigure && <div className="behaviour-email-template-list">
      {templates.map((template) => <form className="content-card behaviour-email-template" key={template.id}
        onSubmit={(event) => void saveTemplate(event, template)}>
        <header><div><h3>{eventLabels[template.event_type]}</h3><span className={`behaviour-email-status ${template.enabled ? 'enabled' : ''}`}>{template.enabled ? 'Enabled' : 'Disabled'}</span></div></header>
        <div className="behaviour-email-switches">
          <label><input type="checkbox" checked={template.enabled} onChange={(event) => updateTemplate(template.id, { enabled: event.target.checked })} /> Enable this email</label>
          <label><input type="checkbox" checked={template.require_approval} onChange={(event) => updateTemplate(template.id, { require_approval: event.target.checked })} /> Require staff approval before sending</label>
        </div>
        <label className="field"><span>Delay (minutes)</span><input type="number" min={0} max={1440} required value={template.delay_minutes}
          onChange={(event) => updateTemplate(template.id, { delay_minutes: Number(event.target.value) })} /></label>
        <label className="field"><span>Subject</span><input required maxLength={120} value={template.subject_template}
          onChange={(event) => updateTemplate(template.id, { subject_template: event.target.value })} /></label>
        <label className="field"><span>Message</span><textarea required minLength={10} maxLength={1200} rows={3} value={template.body_template}
          onChange={(event) => updateTemplate(template.id, { body_template: event.target.value })} /></label>
        <small>Available placeholders: {'{secure_link}'}, {'{school_name}'}, {'{school_contact}'}</small>
        <div className="behaviour-email-preview"><strong>Preview</strong><span>{preview(template.subject_template)}</span><p>{preview(template.body_template)}</p></div>
        <button className="button button-quiet" type="submit" disabled={saving}>Save template</button>
      </form>)}
    </div>}

    <section className="content-card behaviour-email-deliveries">
      <header className="behaviour-list-heading"><div><h2>Email delivery history</h2><p>Delivery records contain status and audit metadata, not message content or recipient addresses.</p></div>
        <button className="button button-quiet" type="button" onClick={() => void load()}><RefreshCw size={15} /> Refresh</button></header>
      {deliveries.length ? <div className="behaviour-email-delivery-list">
        {deliveries.map((delivery) => <article key={delivery.id}>
          <div><strong>{eventLabels[delivery.event_type] ?? delivery.event_type}</strong><span>{new Date(delivery.created_at).toLocaleString()}</span></div>
          <span className={`behaviour-email-status ${delivery.status}`}>{delivery.status.replaceAll('_', ' ')}</span>
          {delivery.status === 'awaiting_approval' && <button className="button button-quiet" type="button" disabled={Boolean(activeDelivery)}
            onClick={() => void manageDelivery(delivery, 'approve')}><Send size={14} />{activeDelivery === delivery.id ? 'Approving…' : 'Approve'}</button>}
          {delivery.status === 'failed' && <button className="button button-quiet" type="button" disabled={Boolean(activeDelivery)}
            onClick={() => void manageDelivery(delivery, 'retry')}><RotateCcw size={14} />{activeDelivery === delivery.id ? 'Retrying…' : 'Retry'}</button>}
          {delivery.status === 'unknown' && <small>Not retryable automatically; delivery outcome is uncertain.</small>}
        </article>)}
      </div> : <p>No behaviour email deliveries have been queued yet.</p>}
    </section>
  </section>;
}
