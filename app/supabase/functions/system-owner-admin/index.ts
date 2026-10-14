import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin, Access-Control-Request-Headers',
};

type OwnerRequest = {
  action?: unknown;
  schoolId?: unknown;
  status?: unknown;
  requestId?: unknown;
  decision?: unknown;
};

function respond(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (request.method !== 'POST') return respond(405, { error: 'Method not allowed.' });

  try {
    const accessToken = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!accessToken) return respond(401, { error: 'Sign in to access the system owner panel.' });

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const ownerId = Deno.env.get('SYSTEM_OWNER_USER_ID');
    if (!supabaseUrl || !anonKey || !serviceRoleKey) throw new Error('System owner function configuration is incomplete.');
    if (!ownerId || !isUuid(ownerId)) throw new Error('Set SYSTEM_OWNER_USER_ID to the platform owner Supabase Auth user ID.');

    const userClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser(accessToken);
    if (authError || !user) return respond(401, { error: 'Your session is invalid. Sign in again.' });
    if (user.id !== ownerId) return respond(403, { error: 'This panel is restricted to the Campus Connect system owner.' });

    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const payload = await request.json() as OwnerRequest;

    if (payload.action === 'check') return respond(200, { authorized: true });

    if (payload.action === 'dashboard') {
      const { data, error } = await serviceClient.rpc('platform_owner_dashboard');
      if (error) throw error;
      const managedStorageConfigured = Boolean(
        Deno.env.get('R2_ACCOUNT_ID')
        && Deno.env.get('R2_BUCKET_NAME')
        && Deno.env.get('R2_ACCESS_KEY_ID')
        && Deno.env.get('R2_SECRET_ACCESS_KEY'),
      );
      return respond(200, { dashboard: { ...data, managedStorageConfigured } });
    }

    if (payload.action === 'set-school-status') {
      if (!isUuid(payload.schoolId) || (payload.status !== 'active' && payload.status !== 'suspended')) {
        return respond(400, { error: 'Choose a valid school and platform status.' });
      }
      const { data: school, error: updateError } = await serviceClient
        .from('schools')
        .update({ platform_status: payload.status })
        .eq('id', payload.schoolId)
        .select('id,name,platform_status')
        .maybeSingle();
      if (updateError) throw updateError;
      if (!school) return respond(404, { error: 'The school was not found.' });
      const { error: activityError } = await serviceClient.from('platform_activity').insert({
        actor_id: user.id,
        action: payload.status === 'suspended' ? 'school_suspended' : 'school_reactivated',
        target_type: 'school',
        target_id: school.id,
        details: { school_name: school.name },
      });
      if (activityError) throw activityError;
      return respond(200, { school });
    }

    if (payload.action === 'review-storage-request') {
      if (!isUuid(payload.requestId) || (payload.decision !== 'approved' && payload.decision !== 'denied')) {
        return respond(400, { error: 'Choose a valid storage request and decision.' });
      }
      if (payload.decision === 'approved' && !(
        Deno.env.get('R2_ACCOUNT_ID')
        && Deno.env.get('R2_BUCKET_NAME')
        && Deno.env.get('R2_ACCESS_KEY_ID')
        && Deno.env.get('R2_SECRET_ACCESS_KEY')
      )) {
        return respond(503, { error: 'Managed R2 storage is not configured on the platform yet. Configure its Edge Function secrets before approving requests.' });
      }
      const { data: storageRequest, error: requestError } = await serviceClient
        .from('managed_storage_requests')
        .update({
          status: payload.decision,
          reviewed_by: user.id,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', payload.requestId)
        .eq('status', 'pending')
        .select('id,school_id,status')
        .maybeSingle();
      if (requestError) throw requestError;
      if (!storageRequest) return respond(409, { error: 'This request is no longer pending.' });

      if (payload.decision === 'approved') {
        const { error: enableError } = await serviceClient.from('schools')
          .update({ managed_storage_enabled: true }).eq('id', storageRequest.school_id);
        if (enableError) throw enableError;
      }
      const { error: activityError } = await serviceClient.from('platform_activity').insert({
        actor_id: user.id,
        action: `managed_storage_${payload.decision}`,
        target_type: 'managed_storage_request',
        target_id: storageRequest.id,
        details: { school_id: storageRequest.school_id },
      });
      if (activityError) throw activityError;
      return respond(200, { request: storageRequest });
    }

    return respond(400, { error: 'Unsupported system owner action.' });
  } catch (error) {
    console.error('Campus Connect system owner request failed.', error);
    return respond(500, {
      error: error instanceof Error ? error.message : 'The system owner request could not be completed.',
    });
  }
});
