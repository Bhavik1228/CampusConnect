import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { PDFDocument, StandardFonts, rgb } from 'npm:pdf-lib@1.17.1';
import QRCode from 'npm:qrcode@1.5.4';

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
  schoolId?: unknown;
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

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character);
}

function renderBrandedEmail(schoolName: string, subject: string, body: string, secureLink: string) {
  const paragraphs = escapeHtml(body)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p style="margin:0 0 14px;color:#33413c;font:15px/1.65 Arial,sans-serif">${line}</p>`)
    .join('');
  const safeSchool = escapeHtml(schoolName);
  const safeSubject = escapeHtml(subject);
  const safeLink = escapeHtml(secureLink);
  return `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f3f5f2">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e1e8e3;border-radius:12px;overflow:hidden">
      <tr><td style="padding:22px 28px;background:#183c32;color:#fff">
        <div style="font:700 12px/1.2 Arial,sans-serif;letter-spacing:1.6px;color:#d9ebdf">CAMPUS CONNECT</div>
        <div style="margin-top:9px;font:14px/1.4 Arial,sans-serif;color:#fff">${safeSchool}</div>
      </td></tr>
      <tr><td style="padding:30px 28px 12px">
        <div style="margin-bottom:10px;color:#b66b32;font:700 11px/1.2 Arial,sans-serif;letter-spacing:1.2px;text-transform:uppercase">STUDENT WELLBEING</div>
        <h1 style="margin:0 0 20px;color:#183c32;font:700 23px/1.25 Arial,sans-serif">${safeSubject}</h1>
        ${paragraphs}
        <table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0 12px"><tr>
          <td style="border-radius:7px;background:#20745b">
            <a href="${safeLink}" style="display:inline-block;padding:13px 20px;color:#fff;text-decoration:none;font:700 14px/1 Arial,sans-serif">Open secure update</a>
          </td>
        </tr></table>
        <p style="margin:20px 0 8px;color:#66736d;font:12px/1.6 Arial,sans-serif">Sign in to Campus Connect to view this private school update. Please do not forward this email.</p>
      </td></tr>
      <tr><td style="padding:16px 28px;border-top:1px solid #e8ede9;background:#fafbf9;color:#758078;font:11px/1.6 Arial,sans-serif">
        A secure message from ${safeSchool} via Campus Connect.<br>Student information is confidential and intended only for the linked family.
      </td></tr>
    </table>
  </body></html>`;
}

function pdfSafe(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]/g, ' ');
}

function base64(bytes: Uint8Array) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

async function createBehaviourReportPdf(report: Record<string, unknown>, reportUrl: string) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 44;
  const ink = rgb(0.09, 0.22, 0.19);
  const muted = rgb(0.35, 0.41, 0.38);
  const green = rgb(0.13, 0.45, 0.35);
  const pale = rgb(0.95, 0.97, 0.95);
  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const addPage = () => {
    page = pdf.addPage([pageWidth, pageHeight]);
    y = pageHeight - 62;
    page.drawText('CAMPUS CONNECT  /  STUDENT WELLBEING', {
      x: margin, y: pageHeight - 34, size: 8, font: bold, color: green,
    });
    page.drawLine({
      start: { x: margin, y: pageHeight - 43 },
      end: { x: pageWidth - margin, y: pageHeight - 43 },
      thickness: 0.7,
      color: pale,
    });
  };
  const ensureSpace = (height: number) => {
    if (y - height < 68) addPage();
  };
  const drawSection = (title: string) => {
    ensureSpace(32);
    y -= 8;
    page.drawRectangle({ x: margin, y: y - 18, width: pageWidth - margin * 2, height: 24, color: pale });
    page.drawText(pdfSafe(title.toUpperCase()), { x: margin + 10, y: y - 10, size: 9, font: bold, color: ink });
    y -= 32;
  };
  const drawField = (label: string, value: string) => {
    const text = pdfSafe(value.trim());
    if (!text) return;
    const size = 9;
    const maxWidth = pageWidth - margin * 2 - 112;
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (regular.widthOfTextAtSize(next, size) > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
    for (let index = 0; index < lines.length; index += 1) {
      ensureSpace(15);
      page.drawText(index === 0 ? pdfSafe(label) : '', {
        x: margin, y: y - size, size: 8, font: bold, color: muted,
      });
      page.drawText(lines[index], {
        x: margin + 112, y: y - size, size, font: regular, color: ink,
      });
      y -= 14;
    }
    y -= 3;
  };

  page.drawRectangle({
    x: 0, y: pageHeight - 126, width: pageWidth, height: 126, color: ink,
  });
  page.drawRectangle({
    x: 0, y: pageHeight - 130, width: pageWidth, height: 4, color: green,
  });
  page.drawText('CAMPUS CONNECT  /  STUDENT WELLBEING', {
    x: margin, y: pageHeight - 45, size: 9, font: bold, color: rgb(0.82, 0.91, 0.85),
  });
  page.drawText('Student behaviour report', {
    x: margin, y: pageHeight - 82, size: 22, font: bold, color: rgb(1, 1, 1),
  });
  page.drawText(pdfSafe(String(report.school_name || 'School')), {
    x: margin, y: pageHeight - 105, size: 10, font: regular, color: rgb(0.91, 0.95, 0.92),
  });
  y = pageHeight - 154;

  drawSection('Student details');
  drawField('Student', String(report.student_name || ''));
  drawField('Student ID', String(report.student_number || ''));
  drawField('Class', String(report.class_name || 'Not assigned'));
  drawSection('Behaviour record');
  drawField('Record type', `${report.behaviour_type_name || ''} (${report.category === 'positive' ? 'Positive' : 'Behaviour concern'})`);
  drawField('Occurred', new Date(String(report.occurred_at)).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC');
  drawField('Reported by', String(report.reported_by_name || 'School staff'));
  drawField('Report reference', String(report.id || ''));
  drawField('Recorded', report.created_at
    ? new Date(String(report.created_at)).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC'
    : '');
  drawField('Location', String(report.location || 'Not recorded'));
  drawField('Context', String(report.context || ''));
  drawField('Severity', String(report.severity || ''));
  drawField('What happened', String(report.description || ''));
  drawField('Student perspective', String(report.student_perspective || ''));
  drawField('Actions taken', String(report.actions_taken || 'No immediate action recorded.'));
  drawField('Follow-up / consequence', String(report.action_name || 'No follow-up action selected.'));
  if (typeof report.points_awarded === 'number') drawField('Points', String(report.points_awarded));
  ensureSpace(150);
  drawSection('Secure report access');
  drawField('Privacy', String(report.privacy_note || 'This copy is prepared for the linked family of the named student.'));
  const qr = QRCode.create(reportUrl, { errorCorrectionLevel: 'Q' });
  const qrSize = Math.min(104, qr.modules.size * 1.65);
  const moduleSize = qrSize / qr.modules.size;
  const qrX = margin;
  const qrY = y - qrSize;
  page.drawRectangle({ x: qrX - 5, y: qrY - 5, width: qrSize + 10, height: qrSize + 10, color: rgb(1, 1, 1), borderColor: pale, borderWidth: 1 });
  for (let row = 0; row < qr.modules.size; row += 1) {
    for (let column = 0; column < qr.modules.size; column += 1) {
      if (qr.modules.get(row, column)) {
        page.drawRectangle({
          x: qrX + column * moduleSize,
          y: qrY + (qr.modules.size - row - 1) * moduleSize,
          width: moduleSize,
          height: moduleSize,
          color: ink,
        });
      }
    }
  }
  page.drawText('Scan to sign in and open this protected report.', {
    x: qrX + qrSize + 22, y: qrY + qrSize - 12, size: 9, font: bold, color: ink, maxWidth: 170,
  });
  page.drawText('The QR code contains a secure link only; report details are shown after sign-in.', {
    x: qrX + qrSize + 22, y: qrY + qrSize - 32, size: 8, font: regular, color: muted, maxWidth: 170, lineHeight: 12,
  });
  const pageCount = pdf.getPageCount();
  pdf.getPages().forEach((pdfPage, index) => {
    pdfPage.drawText(`Confidential student information - ${index + 1} of ${pageCount}`, {
      x: margin, y: 34, size: 7, font: regular, color: muted,
    });
  });
  return pdf.save();
}

function redactOtherStudentIdentities(value: string, identities: string[]) {
  return identities.reduce((text, identity) => {
    const escaped = identity.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return escaped.length >= 2
      ? text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu'), '[withheld]')
      : text;
  }, value);
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
  if (!report || !['published', 'resolved', 'closed'].includes(report.status)
    || report.guardian_visible !== true || report.confidential) {
    return { error: 'Only a published, resolved, or closed report approved for guardian access can be emailed.' };
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

  const apiKey = Deno.env.get('MAILJET_BEHAVIOUR_API_KEY');
  const secretKey = Deno.env.get('MAILJET_BEHAVIOUR_SECRET_KEY');
  const sender = Deno.env.get('MAILJET_BEHAVIOUR_FROM_EMAIL');
  if (!apiKey || !secretKey || !sender) {
    const { error: updateError } = await admin.from('student_behaviour_email_deliveries')
      .update({ status: 'failed', last_error: 'Mailjet behaviour-specific credentials or sender are not configured.' })
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
  const htmlText = renderTemplate(template.body_template, {
    ...templateValues,
    secure_link: 'the secure button below',
  }).trim().slice(0, 1200);
  const attachments: { ContentType: string; Filename: string; Base64Content: string }[] = [];
  if (delivery.event_type === 'manual_report') {
    const failPdfPreparation = async (reason: string) => {
      const { error: updateError } = await admin.from('student_behaviour_email_deliveries')
        .update({ status: 'failed', last_error: 'The report PDF could not be prepared safely.' })
        .eq('id', delivery.id);
      if (updateError) throw updateError;
      console.error('Could not prepare a behaviour report PDF.', { deliveryId: delivery.id, reason });
    };
    const { data: report, error: reportError } = await admin.from('student_behaviour_records')
      .select('id,school_id,student_id,student_name,student_number,class_name,school_name,behaviour_type_name,category,points_awarded,action_name,reported_by_name,occurred_at,location,context,description,student_perspective,severity,actions_taken,status,guardian_visible,confidential,created_at')
      .eq('id', delivery.record_id ?? '')
      .eq('school_id', delivery.school_id)
      .maybeSingle();
    if (reportError) {
      await failPdfPreparation('Report lookup failed.');
      return 'failed';
    }
    if (!report || report.guardian_visible !== true || report.confidential
      || !['published', 'resolved', 'closed'].includes(report.status)) {
      const { error: suppressError } = await admin.from('student_behaviour_email_deliveries')
        .update({ status: 'suppressed', last_error: 'Report access was withdrawn before delivery.' })
        .eq('id', delivery.id);
      if (suppressError) throw suppressError;
      return 'suppressed';
    }
    try {
      if (delivery.target_path !== `/behaviour/report/${report.id}`) {
        throw new Error('Report destination does not match the queued report.');
      }
      const { data: parent, error: parentError } = await admin.from('parent_profiles')
        .select('id')
        .eq('school_id', report.school_id)
        .eq('profile_id', delivery.recipient_profile_id)
        .maybeSingle();
      if (parentError) throw parentError;
      const [{ data: parentLink, error: linkError }, { data: parentMembership, error: membershipError }, { data: preference, error: preferenceError }] = await Promise.all([
        parent
          ? admin.from('parent_students').select('parent_id').eq('school_id', report.school_id)
            .eq('student_id', report.student_id).eq('parent_id', parent.id).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        admin.from('school_memberships').select('profile_id').eq('school_id', report.school_id)
          .eq('profile_id', delivery.recipient_profile_id).eq('role', 'parent').maybeSingle(),
        admin.from('student_behaviour_email_preferences').select('email_enabled')
          .eq('school_id', report.school_id).eq('profile_id', delivery.recipient_profile_id)
          .eq('event_type', 'manual_report').maybeSingle(),
      ]);
      if (linkError) throw linkError;
      if (membershipError) throw membershipError;
      if (preferenceError) throw preferenceError;
      if (!parent || !parentLink || !parentMembership || preference?.email_enabled === false) {
        const { error: suppressError } = await admin.from('student_behaviour_email_deliveries')
          .update({ status: 'suppressed', last_error: 'The recipient is no longer eligible for this report email.' })
          .eq('id', delivery.id);
        if (suppressError) throw suppressError;
        return 'suppressed';
      }
      const { data: participants, error: participantsError } = await admin.from('student_behaviour_record_participants')
        .select('student_id')
        .eq('school_id', report.school_id)
        .eq('record_id', report.id)
        .neq('student_id', report.student_id);
      if (participantsError) throw participantsError;
      const participantIds = [...new Set((participants ?? []).map((item) => item.student_id))];
      let identities: string[] = [];
      if (participantIds.length) {
        const { data: students, error: studentsError } = await admin.from('students')
          .select('first_name,last_name,student_number')
          .eq('school_id', report.school_id)
          .in('id', participantIds);
        if (studentsError) throw studentsError;
        identities = (students ?? []).flatMap((student) => [
          `${student.first_name} ${student.last_name}`,
          student.first_name,
          student.last_name,
          student.student_number,
        ]).filter((identity) => typeof identity === 'string' && identity.trim().length >= 1);
      }
      const privateFields = ['context', 'description', 'student_perspective', 'actions_taken'] as const;
      const parentSafeReport: Record<string, unknown> = {
        ...report,
        privacy_note: participantIds.length
          ? 'Names and student IDs of other students involved have been withheld.'
          : 'This copy is prepared for the linked family of the named student.',
      };
      for (const field of privateFields) {
        parentSafeReport[field] = redactOtherStudentIdentities(String(report[field] ?? ''), identities);
      }
      const pdfBytes = await createBehaviourReportPdf(parentSafeReport, link);
      attachments.push({
        ContentType: 'application/pdf',
        Filename: 'student-behaviour-report.pdf',
        Base64Content: base64(pdfBytes),
      });
    } catch (pdfError) {
      await failPdfPreparation(pdfError instanceof Error ? pdfError.message : 'PDF generation failed.');
      return 'failed';
    }
  }
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
          HTMLPart: renderBrandedEmail(templateValues.school_name, subject || 'A secure school update is available', htmlText, link),
          ...(attachments.length ? { Attachments: attachments } : {}),
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

    if (payload.action === 'configure_schedule') {
      if (!isUuid(payload.schoolId)) return respond(400, { error: 'A valid school ID is required.' });
      const role = await getMembershipRole(admin, payload.schoolId, userId);
      if (role !== 'school_admin') return respond(403, { error: 'Only a school administrator can configure scheduled delivery.' });
      const cronSecret = Deno.env.get('BEHAVIOUR_EMAIL_CRON_SECRET');
      if (!cronSecret) return respond(500, { error: 'Scheduled email authorization is not configured.' });
      const { error: configureError } = await admin.rpc('configure_student_behaviour_email_scheduler', {
        target_secret: cronSecret,
      });
      if (configureError) throw configureError;
      return respond(200, { configured: true, interval: '15 minutes' });
    }

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
