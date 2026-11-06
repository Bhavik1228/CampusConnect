import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface AlertRequest {
  action?: unknown;
  email?: unknown;
}

function jsonResponse(status: number, body: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function fingerprint(value: string, secret: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function getSourceAddress(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for');
  return (
    request.headers.get('cf-connecting-ip')?.trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    forwarded?.split(',').at(-1)?.trim() ||
    'unknown'
  );
}

async function sendEmail(to: string, subject: string, textBody: string) {
  const resendApiKey = Deno.env.get('RESEND_API_KEY');
  const resendFrom = Deno.env.get('RESEND_FROM_EMAIL');
  if (resendApiKey && resendFrom) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: resendFrom,
        to: [to],
        subject,
        text: textBody,
      }),
    });
    if (!response.ok) {
      console.error('Resend rejected a Campus Connect security email.', {
        status: response.status,
      });
      throw new Error('Resend failed to send the security email.');
    }
    return;
  }

  const token = Deno.env.get('POSTMARK_SERVER_TOKEN');
  const from = Deno.env.get('POSTMARK_FROM_EMAIL');
  if (!token || !from) {
    if (resendApiKey || resendFrom) throw new Error('Resend sender configuration is incomplete.');
    throw new Error('Postmark sender configuration is missing.');
  }

  const response = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': token,
    },
    body: JSON.stringify({
      From: from,
      To: to,
      Subject: subject,
      TextBody: textBody,
      MessageStream: 'outbound',
    }),
  });
  if (!response.ok) {
    console.error('Postmark rejected a Campus Connect security email.', {
      status: response.status,
    });
    throw new Error('Postmark failed to send the security email.');
  }
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed.' });
  }

  try {
    const payload = await request.json() as AlertRequest;
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!supabaseUrl) throw new Error('Supabase URL configuration is incomplete.');

    if (payload.action === 'login_succeeded') {
      const bearer = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
      if (!bearer) return jsonResponse(401, { error: 'Authentication is required.' });
      const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
      if (!anonKey) throw new Error('Supabase anonymous key configuration is incomplete.');

      const userClient = createClient(supabaseUrl, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${bearer}` } },
      });
      const { data, error } = await userClient.auth.getUser(bearer);
      if (error || !data.user?.email || !data.user.email_confirmed_at) {
        return jsonResponse(401, { error: 'A verified account is required.' });
      }

      await sendEmail(
        data.user.email,
        'New sign-in to Campus Connect',
        `A successful sign-in to your Campus Connect account was recorded at ${new Date().toISOString()}.\n\nIf this was not you, open Campus Connect and reset your password.`,
      );
      return jsonResponse(200, { status: 'sent' });
    }

    if (payload.action !== 'login_failed') {
      return jsonResponse(400, { error: 'Unsupported alert event.' });
    }
    if (typeof payload.email !== 'string' || payload.email.length > 320) {
      return jsonResponse(400, { error: 'A valid email address is required.' });
    }

    const securityEmail = Deno.env.get('SECURITY_ALERT_EMAIL');
    const fingerprintSecret = Deno.env.get('LOGIN_ALERT_HASH_SECRET');
    if (!securityEmail || !fingerprintSecret) {
      throw new Error('Login security alert configuration is missing.');
    }
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!serviceRoleKey) throw new Error('Supabase service-role configuration is incomplete.');

    const emailHash = await fingerprint(payload.email.trim().toLowerCase(), fingerprintSecret);
    const sourceHash = await fingerprint(getSourceAddress(request), fingerprintSecret);
    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: claim, error: claimError } = await serviceClient.rpc(
      'claim_login_failure_alert',
      { p_email_hash: emailHash, p_source_hash: sourceHash },
    );
    if (claimError) throw claimError;

    const shouldSendAlert = Array.isArray(claim) && claim[0]?.should_send_alert === true;
    if (!shouldSendAlert) {
      return jsonResponse(202, { status: 'recorded' });
    }

    try {
      await sendEmail(
        securityEmail,
        'Campus Connect: repeated sign-in failures',
        `Campus Connect recorded at least five failed sign-in attempts for an email address from the same network source within 15 minutes.\n\nThe attempted address and source IP are not included in this alert. Review your Supabase Auth logs if these attempts were unexpected.\n\nRecorded at ${new Date().toISOString()}.`,
      );
      const { error: finishError } = await serviceClient.rpc('finish_login_failure_alert', {
        p_email_hash: emailHash,
        p_source_hash: sourceHash,
        p_sent: true,
      });
      if (finishError) throw finishError;
    } catch (sendError) {
      await serviceClient.rpc('finish_login_failure_alert', {
        p_email_hash: emailHash,
        p_source_hash: sourceHash,
        p_sent: false,
      });
      throw sendError;
    }

    return jsonResponse(202, { status: 'alerted' });
  } catch (error) {
    console.error('Campus Connect login alert failed.', error);
    return jsonResponse(500, { error: 'The security notification could not be processed.' });
  }
});
