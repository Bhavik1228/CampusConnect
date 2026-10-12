import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const accountingRoles = new Set(['finance_manager', 'accountant', 'bursar', 'cashier']);

interface InviteRequest {
  schoolId?: unknown;
  fullName?: unknown;
  email?: unknown;
  role?: unknown;
}

function respond(status: number, body: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return respond(405, { error: 'Method not allowed.' });

  try {
    const authorization = request.headers.get('Authorization');
    const accessToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!accessToken) return respond(401, { error: 'Sign in as a school administrator to invite staff.' });

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      throw new Error('Staff invitation service configuration is incomplete.');
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser(accessToken);
    if (authError || !user) return respond(401, { error: 'Your session is invalid. Sign in again and retry.' });

    const payload = await request.json() as InviteRequest;
    const schoolId = typeof payload.schoolId === 'string' ? payload.schoolId.trim() : '';
    const fullName = typeof payload.fullName === 'string' ? payload.fullName.trim() : '';
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    const role = typeof payload.role === 'string' ? payload.role : '';

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(schoolId)) {
      return respond(400, { error: 'Choose a valid school.' });
    }
    if (fullName.length < 2 || fullName.length > 120) {
      return respond(400, { error: 'Enter a name between 2 and 120 characters.' });
    }
    if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return respond(400, { error: 'Enter a valid email address.' });
    }
    if (!accountingRoles.has(role)) {
      return respond(400, { error: 'Choose a supported accounting role.' });
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: adminMembership, error: membershipCheckError } = await adminClient
      .from('school_memberships')
      .select('id')
      .eq('school_id', schoolId)
      .eq('profile_id', user.id)
      .eq('role', 'school_admin')
      .maybeSingle();
    if (membershipCheckError) throw membershipCheckError;
    if (!adminMembership) return respond(403, { error: 'Only a school administrator can invite accounting staff.' });

    const { data: invitation, error: invitationError } = await adminClient.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName },
    });
    if (invitationError) {
      console.error('Campus Connect could not invite accounting staff.', invitationError.message);
      return respond(400, { error: invitationError.message });
    }
    if (!invitation.user) throw new Error('Supabase did not return the invited user.');

    const { error: createMembershipError } = await adminClient
      .from('school_memberships')
      .insert({ school_id: schoolId, profile_id: invitation.user.id, role });
    if (createMembershipError) {
      const { error: cleanupError } = await adminClient.auth.admin.deleteUser(invitation.user.id);
      if (cleanupError) console.error('Campus Connect could not revoke an incomplete staff invitation.', cleanupError.message);
      throw new Error(`The invitation email was sent, but school access could not be created: ${createMembershipError.message}`);
    }

    return respond(201, { status: 'invited' });
  } catch (error) {
    console.error('Campus Connect staff invitation failed.', error);
    return respond(500, {
      error: error instanceof Error ? error.message : 'The staff invitation could not be completed.',
    });
  }
});
