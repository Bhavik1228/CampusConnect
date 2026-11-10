import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-behaviour-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const staffRoles = [
  'school_admin',
  'academic_coordinator',
  'teacher',
  'librarian',
  'secretary',
  'hr_staff_administrator',
  'safeguarding_officer',
];
const deliveryManagerRoles = ['school_admin', 'academic_coordinator', 'safeguarding_officer'];
const mailjetApi = 'https://api.mailjet.com/v3.1/send';

type RequestBody = {
  action?: unknown;
  recordId?: unknown;
  deliveryId?: unknown;
  eventType?: unknown;
};
type Delivery = {
  id: string;
  school_id: string;
  recipient_profile_id: string;
  event_type: string;
  record_id: string | null;
  source_type: string;
  source_id: string | null;
  target_path: string;
  status: string;
  attempt_count: number;
};

function respond(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function getBaseUrl() {
  const configured = Deno.env.get('APP_BASE_URL');
  if (!configured) throw new Error('APP_BASE_URL is not configured.');
  const url = new URL(configured);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('APP_BASE_URL must use HTTPS.');
  }
  return url.origin;
}

function safeTargetPath(path: string) {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new Error('The saved notification destination is invalid.');
  }
  return new URL(path, getBaseUrl()).toString();
}

function renderTemplate(template: string, values: Record<string, string>) {
  return template.replace(/\{([a-z_]+)\}/gi, (_token, key: string) => values[key.toLowerCase()] ?? '');
}

async function getMembershipRole(admin: SupabaseClient, schoolId: string, profileId: string) {
  const { data, error } = await admin.from('school_memberships')
    .select('role')
    .eq('school_id', schoolId)
    .eq('profile_id', profileId)
    .maybeSingle();
  if (error) throw error;
  return typeof data?.role === 'string' ? data.role : null;
}

async function queueReportEvents(
  admin: SupabaseClient,
  profileId: string,
  recordId: string,
  eventType: 'manual_report' | 'improvement_update',
  actorId: string,
) {
  const { data: report, error: reportError } = await admin.from('student_behaviour_records')
    .select('id,school_id,student_id,category,status,guardian_visible,confidential')
    .eq('id', recordId)
    .maybeSingle();
  if (reportError) throw reportError;
  if (!report || report.status !== 'published' || report.guardian_visible !== true || report.confidential) {
    return { error: 'Only a published report approved for guardian access can be emailed.' };
  }
  if (eventType === 'improvement_update' && report.category !== 'positive') {
    return { error: 'Improvement updates can only be sent for positive recognition.' };
  }

  const role = await getMembershipRole(admin, report.school_id, actorId);
  if (!role || !staffRoles.includes(role)) return { error: 'Only authorized school staff can send this notification.' };

  const { data: links, error: linkError } = await admin.from('parent_students')
    .select('parent_id')
    .eq('school_id', report.school_id)
    .eq('student_id', report.student_id);
  if (linkError) throw linkError;
  const parentIds = [...new Set((links ?? []).map((link) => link.parent_id))];
  if (!parentIds.length) return { error: 'No parent account is linked to this student.' };

  const { data: parents, error: parentsError } = await admin.from('parent_profiles')
    .select('profile_id')
    .eq('school_id', report.school_id)
    .in('id', parentIds)
    .not('profile_id', 'is', null);
  if (parentsError) throw parentsError;
  const profileIds = [...new Set((parents ?? [])
    .map((parent) => parent.profile_id)
    .filter((id): id is string => typeof id === 'string'))];
  const { data: memberships, error: membershipError } = profileIds.length
    ? await admin.from('school_memberships').select('profile_id').eq('school_id', report.school_id)
      .eq('role', 'parent').in('profile_id', profileIds)
    : { data: [], error: null };
  if (membershipError) throw membershipError;
  const recipients = [...new Set((memberships ?? []).map((item) => item.profile_id))];
  if (!recipients.length) return { error: 'No linked parent account is available for email delivery.' };

  const { data: template, error: templateError } = await admin.from('student_behaviour_email_templates')
    .select('enabled')
    .eq('school_id', report.school_id)
    .eq('event_type', eventType)
    .maybeSingle();
  if (templateError) throw templateError;
  if (!template?.enabled) return { error: 'This email type is disabled in school behaviour settings.' };

  const deliveryIds: string[] = [];
  for (const recipientId of recipients) {
    const { data: preference, error: preferenceError } = await admin.from('student_behaviour_email_preferences')
      .select('email_enabled')
      .eq('school_id', report.school_id)
      .eq('profile_id', recipientId)
      .eq('event_type', eventType)
      .maybeSingle();
    if (preferenceError) throw preferenceError;
    if (preference?.email_enabled === false) continue;
    const { data: inserted, error: enqueueError } = await admin.rpc('enqueue_student_behaviour_email', {
      target_school: report.school_id,
      target_profile: recipientId,
      target_event: eventType,
      target_record: report.id,
      target_source_type: 'record',
      target_source: report.id,
      target_path: `/behaviour/report/${report.id}`,
      target_key: `${report.id}:${eventType}:${recipientId}`,
      actor: actorId,
    });
    if (enqueueError) throw enqueueError;
    if (typeof inserted === 'string') deliveryIds.push(inserted);
  }
  return { queued: deliveryIds.length, deliveryIds };
}

async function fallbackNotification(admin: SupabaseClient, delivery: Delivery) {
  const title = delivery.event_type === 'staff_escalation'
    ? 'A behaviour notification needs attention'
    : 'A secure school update is available';
  const { data, error } = await admin.from('notifications').insert({
    school_id: delivery.school_id,
    profile_id: delivery.recipient_profile_id,
    title,
    body: 'Email delivery was unsuccessful. Sign in to Campus Connect to review the secure update.',
    target_path: delivery.target_path,
  }).select('id').single();
  if (error) throw error;
  const { error: updateError } = await admin.from('student_behaviour_email_deliveries')
    .update({ notification_id: data.id })
    .eq('id', delivery.id);
  if (updateError) throw updateError;
}

async function sendDelivery(admin: SupabaseClient, deliveryId: string) {
  const { data: claimed, error: claimError } = await admin.rpc('claim_student_behaviour_email', {
    target_delivery: deliveryId,
  });
  if (claimError) throw claimError;
  const delivery = (Array.isArray(claimed) ? claimed[0] : claimed) as Delivery | null;
  if (!delivery) return 'not_ready';

  const { data: template, error: templateError } = await admin.from('student_behaviour_email_templates')
    .select('enabled,subject_template,body_template')
    .eq('school_id', delivery.school_id)
    .eq('event_type', delivery.event_type)
    .maybeSingle();
  if (templateError) throw templateError;
  if (!template?.enabled) {
    const { error: suppressError } = await admin.from('student_behaviour_email_deliveries')
      .update({ status: 'suppressed', last_error: 'Email type disabled before delivery.' })
      .eq('id', delivery.id);
    if (suppressError) throw suppressError;
    return 'suppressed';
  }

  const { data: authUser, error: authError } = await admin.auth.admin.getUserById(delivery.recipient_profile_id);
  if (authError) throw authError;
  const recipientEmail = authUser.user?.email;
  if (!recipientEmail || !authUser.user.email_confirmed_at) {
    const { error: suppressError } = await admin.from('student_behaviour_email_deliveries')
      .update({ status: 'suppressed', last_error: 'No confirmed recipient address.' })
      .eq('id', delivery.id);
    if (suppressError) throw suppressError;
    return 'suppressed';
  }

  const apiKey = Deno.env.get('MAILJET_API_KEY');
  const secretKey = Deno.env.get('MAILJET_SECRET_KEY');
  const sender = Deno.env.get('MAILJET_BEHAVIOUR_FROM_EMAIL');
  if (!apiKey || !secretKey || !sender) {
    const { error: updateError } = await admin.from('student_behaviour_email_deliveries')
      .update({ status: 'failed', last_error: 'Mailjet behaviour sender configuration is incomplete.' })
      .eq('id', delivery.id);
    if (updateError) throw updateError;
    await fallbackNotification(admin, delivery);
    return 'failed';
  }

  const [{ data: school, error: schoolError }, { data: settings, error: settingsError }] = await Promise.all([
    admin.from('schools').select('name').eq('id', delivery.school_id).maybeSingle(),
    admin.from('student_behaviour_settings').select('school_contact_email').eq('school_id', delivery.school_id).maybeSingle(),
  ]);
  if (schoolError) throw schoolError;
  if (settingsError) throw settingsError;
  const link = safeTargetPath(delivery.target_path);
  const templateValues = {
    secure_link: link,
    school_name: school?.name ?? 'Your school',
    school_contact: settings?.school_contact_email ?? '',
  };
  const subject = renderTemplate(template.subject_template, templateValues).trim().slice(0, 120);
  const text = renderTemplate(template.body_template, templateValues).trim().slice(0, 1200);
  let response: Response;
  try {
    response = await fetch(mailjetApi, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${apiKey}:${secretKey}`)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        Messages: [{
          From: { Email: sender, Name: Deno.env.get('MAILJET_BEHAVIOUR_FROM_NAME') ?? 'Campus Connect' },
          To: [{ Email: recipientEmail }],
          Subject: subject || 'A secure school update is available',
          TextPart: text,
          CustomID: delivery.id,
        }],
      }),
    });
  } catch (networkError) {
    console.error('Mailjet request outcome is unknown for behaviour notification.', {
      deliveryId: delivery.id,
      error: networkError,
    });
    const { error: updateError } = await admin.from('student_behaviour_email_deliveries')
      .update({ status: 'unknown', last_error: 'Mailjet outcome is unknown; automatic retry was stopped to avoid duplicates.' })
      .eq('id', delivery.id);
    if (updateError) throw updateError;
    await fallbackNotification(admin, delivery);
    return 'unknown';
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (parseError) {
    console.error('Mailjet returned an unreadable behaviour-email response.', { deliveryId: delivery.id });
    const status = response.ok || response.status >= 500 ? 'unknown' : 'failed';
    const { error: updateError } = await admin.from('student_behaviour_email_deliveries')
      .update({ status, last_error: status === 'unknown'
        ? 'Mailjet outcome is unknown; automatic retry was stopped to avoid duplicates.'
        : 'Mailjet rejected the message.' })
      .eq('id', delivery.id);
    if (updateError) throw updateError;
    await fallbackNotification(admin, delivery);
    return status;
  }
  const messages = isRecord(payload) ? payload.Messages : null;
  const firstMessage = Array.isArray(messages) ? messages[0] : null;
  const messageStatus = isRecord(firstMessage) && typeof firstMessage.Status === 'string' ? firstMessage.Status : null;
  const to = isRecord(firstMessage) && Array.isArray(firstMessage.To) ? firstMessage.To[0] : null;
  const messageId = isRecord(to) && (typeof to.MessageID === 'string' || typeof to.MessageID === 'number')
    ? String(to.MessageID)
    : null;

  if (response.ok && messageStatus === 'success') {
    const { error: updateError } = await admin.from('student_behaviour_email_deliveries').update({
      status: 'sent',
      provider_reference: messageId,
      delivered_at: new Date().toISOString(),
      last_error: '',
    }).eq('id', delivery.id);
    if (updateError) throw updateError;
    return 'sent';
  }

  const outcome = (response.ok && messageStatus === null) || response.status >= 500 ? 'unknown' : 'failed';
  console.error('Mailjet did not accept a behaviour email.', { deliveryId: delivery.id, statusCode: response.status, messageStatus });
  const { error: updateError } = await admin.from('student_behaviour_email_deliveries').update({
    status: outcome,
    last_error: outcome === 'unknown'
      ? 'Mailjet outcome is unknown; automatic retry was stopped to avoid duplicates.'
      : 'Mailjet rejected the message.',
  }).eq('id', delivery.id);
  if (updateError) throw updateError;
  await fallbackNotification(admin, delivery);
  return outcome;
}

async function processDue(admin: SupabaseClient, deliveryIds?: string[]) {
  let query = admin.from('student_behaviour_email_deliveries')
    .select('id')
    .eq('status', 'queued')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at')
    .limit(100);
  if (deliveryIds?.length) query = query.in('id', deliveryIds);
  const { data, error } = await query;
  if (error) throw error;
  const results = await Promise.all((data ?? []).map((item) => sendDelivery(admin, item.id)));
  return {
    attempted: results.filter((result) => result !== 'not_ready').length,
    sent: results.filter((result) => result === 'sent').length,
    failed: results.filter((result) => result === 'failed').length,
    unknown: results.filter((result) => result === 'unknown').length,
  };
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return respond(405, { error: 'Method not allowed.' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error('Student behaviour email function has incomplete Supabase configuration.');
    return respond(500, { error: 'The email service is not configured.' });
  }
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const payload = await request.json() as RequestBody;
    if (payload.action === 'process_due') {
      const cronSecret = Deno.env.get('BEHAVIOUR_EMAIL_CRON_SECRET');
      const suppliedSecret = request.headers.get('x-behaviour-cron-secret');
      if (!cronSecret || suppliedSecret !== cronSecret) return respond(401, { error: 'Scheduled delivery authorization failed.' });
      const { error: queueError } = await admin.rpc('queue_due_student_behaviour_emails_job');
      if (queueError) throw queueError;
      return respond(200, await processDue(admin));
    }

    const bearer = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!bearer) return respond(401, { error: 'Authentication is required.' });
    const userClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${bearer}` } },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser(bearer);
    if (userError || !userData.user) return respond(401, { error: 'A valid signed-in account is required.' });
    const userId = userData.user.id;

    if (payload.action === 'email_report' || payload.action === 'queue_event') {
      if (!isUuid(payload.recordId)) return respond(400, { error: 'A valid behaviour report ID is required.' });
      const eventType = payload.action === 'email_report' ? 'manual_report' : payload.eventType;
      if (eventType !== 'manual_report' && eventType !== 'improvement_update') {
        return respond(400, { error: 'This behaviour email event is not available for manual delivery.' });
      }
      const result = await queueReportEvents(admin, userId, payload.recordId, eventType, userId);
      if ('error' in result) return respond(422, { error: result.error });
      if (!result.queued) return respond(409, { error: 'No new email was queued. The parent may be unlinked, opted out, or this notification was already queued.' });
      const deliveryResult = await processDue(admin, result.deliveryIds);
      return respond(200, { queuedCount: result.queued, ...deliveryResult });
    }

    if (payload.action === 'approve' || payload.action === 'retry') {
      if (!isUuid(payload.deliveryId)) return respond(400, { error: 'A valid delivery ID is required.' });
      const { data: delivery, error: deliveryError } = await admin.from('student_behaviour_email_deliveries')
        .select('id,school_id,status')
        .eq('id', payload.deliveryId)
        .maybeSingle();
      if (deliveryError) throw deliveryError;
      if (!delivery) return respond(404, { error: 'The delivery record was not found.' });
      const role = await getMembershipRole(admin, delivery.school_id, userId);
      if (!role || !deliveryManagerRoles.includes(role)) return respond(403, { error: 'You are not authorized to manage behaviour email delivery.' });

      if (payload.action === 'approve') {
        const { error: approveError } = await userClient.rpc('approve_student_behaviour_email', {
          target_delivery: payload.deliveryId,
        });
        if (approveError) throw approveError;
      } else {
        if (delivery.status !== 'failed') {
          return respond(409, { error: 'Only a confirmed provider rejection can be retried. Unknown delivery outcomes cannot be retried safely.' });
        }
        const { data: updated, error: retryError } = await admin.from('student_behaviour_email_deliveries')
          .update({ status: 'queued', scheduled_at: new Date().toISOString(), last_error: '' })
          .eq('id', payload.deliveryId)
          .eq('status', 'failed')
          .select('id')
          .maybeSingle();
        if (retryError) throw retryError;
        if (!updated) return respond(409, { error: 'This delivery changed state and can no longer be retried.' });
      }
      return respond(200, await processDue(admin, [payload.deliveryId]));
    }

    return respond(400, { error: 'Unsupported behaviour email action.' });
  } catch (error) {
    console.error('Student behaviour email operation failed.', error);
    return respond(500, { error: 'The secure behaviour email could not be processed.' });
  }
});
