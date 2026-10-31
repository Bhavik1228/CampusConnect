import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin, Access-Control-Request-Headers',
};

const ticketCategories = new Set([
  'account_access', 'academics', 'attendance', 'finance', 'technical', 'other',
]);
const setupHealthRoles = new Set(['school_admin', 'academic_coordinator']);

type SupportRequest = {
  action?: unknown;
  schoolId?: unknown;
  query?: unknown;
  category?: unknown;
  title?: unknown;
  description?: unknown;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return respond(405, { error: 'Method not allowed.' });

  try {
    const accessToken = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!accessToken) return respond(401, { error: 'Sign in to use Campus Connect support.' });

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      throw new Error('Support service configuration is incomplete.');
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser(accessToken);
    if (authError || !user) return respond(401, { error: 'Your session is invalid. Sign in again.' });

    const payload = await request.json() as SupportRequest;
    if (!isUuid(payload.schoolId)) return respond(400, { error: 'Choose a valid school workspace.' });

    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: membership, error: membershipError } = await serviceClient
      .from('school_memberships')
      .select('role, school:schools!inner(id,name,platform_status)')
      .eq('school_id', payload.schoolId)
      .eq('profile_id', user.id)
      .maybeSingle();
    if (membershipError) throw membershipError;
    if (!membership || !isRecord(membership.school)) {
      return respond(403, { error: 'Your account does not have access to this school workspace.' });
    }
    if (membership.school.platform_status !== 'active') {
      return respond(423, { error: 'This school workspace is currently suspended.' });
    }
    const role = membership.role;
    const schoolName = membership.school.name;

    if (payload.action === 'diagnose') {
      const query = typeof payload.query === 'string' ? payload.query.trim() : '';
      if (query.length > 1000) return respond(400, { error: 'Diagnostic questions must be 1,000 characters or fewer.' });

      const maintenancePromise = userClient.rpc('platform_maintenance_status', {
        target_school: payload.schoolId,
        target_module: null,
      });
      let health: Record<string, unknown> | null = null;
      if (setupHealthRoles.has(role)) {
        const [healthResult, maintenanceResult] = await Promise.all([
          userClient.rpc('run_school_setup_health_check', { target_school: payload.schoolId }),
          maintenancePromise,
        ]);
        if (healthResult.error) throw healthResult.error;
        if (maintenanceResult.error) throw maintenanceResult.error;
        if (!isRecord(healthResult.data) || !isRecord(maintenanceResult.data)) {
          throw new Error('The diagnostic service returned an invalid response.');
        }
        health = healthResult.data;
        const checks = Array.isArray(health.checks) ? health.checks.filter(isRecord) : [];
        const terms = query.toLocaleLowerCase().split(/\s+/).filter((term) => term.length > 2);
        const unresolved = checks.filter((check) =>
          check.status === 'failed' || check.status === 'warning' || check.status === 'needs_review');
        const matched = terms.length
          ? unresolved.filter((check) => {
            const searchable = [
              check.name, check.description, check.category_label, check.result_message,
              ...(Array.isArray(check.workflows) ? check.workflows : []),
            ].filter((value): value is string => typeof value === 'string').join(' ').toLocaleLowerCase();
            return terms.some((term) => searchable.includes(term));
          })
          : unresolved;
        const matches = (terms.length ? matched : unresolved).slice(0, 8).map((check) => ({
          rule_key: check.rule_key,
          name: check.name,
          status: check.status,
          severity: check.severity,
          result_message: check.result_message,
          fix_route: check.fix_route,
        }));
        return respond(200, {
          diagnostic: {
            schoolName,
            role,
            checkedAt: typeof health.last_checked_at === 'string' ? health.last_checked_at : new Date().toISOString(),
            summary: typeof health.readiness_status === 'string'
              ? `Live setup check for ${schoolName}: ${health.readiness_status}. ${unresolved.length} setup item${unresolved.length === 1 ? '' : 's'} need attention.${terms.length && !matched.length ? ' No open setup item matched that lookup.' : ''}`
              : `The live setup check completed for ${schoolName}.`,
            matches,
            matchCount: matched.length,
            canViewSetupHealth: true,
            maintenance: maintenanceResult.data,
          },
        });
      }

      const { data: maintenance, error: maintenanceError } = await maintenancePromise;
      if (maintenanceError) throw maintenanceError;
      if (!isRecord(maintenance)) throw new Error('The diagnostic service returned an invalid maintenance status.');
      return respond(200, {
        diagnostic: {
          schoolName,
          role,
          checkedAt: new Date().toISOString(),
          summary: `Live workspace check for ${schoolName} succeeded. Your signed-in ${role.replaceAll('_', ' ')} membership is active.${maintenance.active === true ? ' The platform is currently in maintenance mode.' : ''}`,
          matches: [],
          matchCount: 0,
          canViewSetupHealth: false,
          maintenance,
        },
      });
    }

    if (payload.action === 'list-tickets') {
      const { data: tickets, error: ticketsError } = await serviceClient
        .from('support_tickets')
        .select('id,category,title,description,status,owner_response,created_at,updated_at')
        .eq('requester_id', user.id)
        .eq('school_id', payload.schoolId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (ticketsError) throw ticketsError;
      return respond(200, { tickets: tickets ?? [] });
    }

    if (payload.action === 'submit-ticket') {
      const category = typeof payload.category === 'string' ? payload.category : '';
      const title = typeof payload.title === 'string' ? payload.title.trim() : '';
      const description = typeof payload.description === 'string' ? payload.description.trim() : '';
      if (!ticketCategories.has(category)) return respond(400, { error: 'Choose a valid support category.' });
      if (title.length < 3 || title.length > 120) {
        return respond(400, { error: 'Enter a request title between 3 and 120 characters.' });
      }
      if (description.length < 10 || description.length > 5000) {
        return respond(400, { error: 'Describe the issue in 10 to 5,000 characters.' });
      }

      const requesterName = typeof user.user_metadata.full_name === 'string' && user.user_metadata.full_name.trim()
        ? user.user_metadata.full_name.trim().slice(0, 120)
        : user.email ?? 'Campus Connect user';
      const { data: ticket, error: insertError } = await serviceClient
        .from('support_tickets')
        .insert({
          school_id: payload.schoolId,
          school_name: schoolName,
          requester_id: user.id,
          requester_name: requesterName,
          requester_email: user.email ?? null,
          requester_role: role,
          category,
          title,
          description,
        })
        .select('id,category,title,description,status,owner_response,created_at,updated_at')
        .single();
      if (insertError) throw insertError;
      return respond(201, { ticket });
    }

    return respond(400, { error: 'Unsupported support action.' });
  } catch (error) {
    console.error('Campus Connect support request failed.', error);
    return respond(500, {
      error: error instanceof Error ? error.message : 'The support request could not be completed.',
    });
  }
});
