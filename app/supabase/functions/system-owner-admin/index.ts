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
  search?: unknown;
  statusFilter?: unknown;
  typeFilter?: unknown;
  sortField?: unknown;
  sortAscending?: unknown;
  page?: unknown;
  pageSize?: unknown;
  school?: unknown;
  adminEmail?: unknown;
  settings?: unknown;
  enabled?: unknown;
  readOnly?: unknown;
  emergency?: unknown;
  notice?: unknown;
  scope?: unknown;
  moduleKey?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
  windowId?: unknown;
  ticketId?: unknown;
  ticketStatus?: unknown;
  ownerResponse?: unknown;
  windowDays?: unknown;
  vercelDeploymentId?: unknown;
  knownIssues?: unknown;
  cursor?: unknown;
  incidentId?: unknown;
  title?: unknown;
  severity?: unknown;
  incidentStatus?: unknown;
  startedAt?: unknown;
  resolvedAt?: unknown;
  affectedServices?: unknown;
  impact?: unknown;
  cause?: unknown;
  fix?: unknown;
  lessons?: unknown;
};

const schoolTypes = ['primary', 'secondary', 'k12', 'university', 'other'];
const subscriptionStatuses = ['free', 'trial', 'active', 'past_due', 'cancelled'];
const maintenanceModules = [
  'academics', 'admissions', 'assignments', 'attendance', 'calendar',
  'communication', 'finance', 'grades', 'learning', 'messaging',
  'library', 'staff', 'students', 'timetable',
];

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

function isShortText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function secretMatches(provided: string | null, expected: string) {
  if (!provided || !expected || provided.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return mismatch === 0;
}

type VercelDeployment = {
  id: string;
  name: string;
  url: string;
  inspectorUrl: string;
  state: string;
  createdAt: number;
  readyAt: number | null;
  commit: {
    message: string;
    sha: string;
    branch: string;
  };
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function safeVercelUrl(value: unknown, allowedHost: (hostname: string) => boolean) {
  if (!isNonEmptyString(value)) return null;
  try {
    const url = new URL(value.startsWith('http') ? value : `https://${value}`);
    return url.protocol === 'https:' && allowedHost(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

async function getVercelProductionDeployments(cursor: string | null) {
  const token = Deno.env.get('VERCEL_TOKEN');
  const projectId = Deno.env.get('VERCEL_PROJECT_ID');
  const teamId = Deno.env.get('VERCEL_TEAM_ID');
  if (!token || !projectId) {
    throw new Error('Vercel release history is not configured. Set VERCEL_TOKEN and VERCEL_PROJECT_ID as system-owner-admin Edge Function secrets. Set VERCEL_TEAM_ID for a team-owned project.');
  }

  const url = new URL('https://api.vercel.com/v7/deployments');
  url.searchParams.set('projectId', projectId);
  url.searchParams.set('target', 'production');
  url.searchParams.set('state', 'READY');
  url.searchParams.set('limit', '100');
  if (cursor) url.searchParams.set('until', cursor);
  if (teamId) url.searchParams.set('teamId', teamId);

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    console.error('Vercel deployment history request failed.', {
      status: response.status,
      statusText: response.statusText,
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error('Vercel rejected the configured token. Check its validity and deployment-read permissions.');
    }
    if (response.status === 404) {
      throw new Error('Vercel could not find the configured project. Check VERCEL_PROJECT_ID and VERCEL_TEAM_ID.');
    }
    throw new Error(`Vercel deployment history is unavailable (HTTP ${response.status}).`);
  }

  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.deployments)) {
    throw new Error('Vercel returned an invalid deployment history response.');
  }

  const deployments = payload.deployments.map((item): VercelDeployment => {
    if (!isRecord(item)
      || !isNonEmptyString(item.uid)
      || !isNonEmptyString(item.name)
      || !isNonEmptyString(item.url)
      || typeof item.createdAt !== 'number'
      || !Number.isFinite(item.createdAt)) {
      throw new Error('Vercel returned a deployment with an invalid release record.');
    }

    const deploymentUrl = safeVercelUrl(item.url, (hostname) => hostname.endsWith('.vercel.app'));
    const inspectorUrl = safeVercelUrl(item.inspectorUrl, (hostname) =>
      hostname === 'vercel.com' || hostname.endsWith('.vercel.com'));
    if (!deploymentUrl || !inspectorUrl) {
      throw new Error('Vercel returned a deployment with an invalid link.');
    }

    const meta = isRecord(item.meta) ? item.meta : {};
    return {
      id: item.uid,
      name: item.name,
      url: deploymentUrl,
      inspectorUrl,
      state: isNonEmptyString(item.readyState) ? item.readyState : 'READY',
      createdAt: item.createdAt,
      readyAt: typeof item.ready === 'number' && Number.isFinite(item.ready) ? item.ready : null,
      commit: {
        message: isNonEmptyString(meta.githubCommitMessage) ? meta.githubCommitMessage.slice(0, 1000) : '',
        sha: isNonEmptyString(meta.githubCommitSha) ? meta.githubCommitSha.slice(0, 40) : '',
        branch: isNonEmptyString(meta.githubCommitRef) ? meta.githubCommitRef.slice(0, 120) : '',
      },
    };
  });
  const rawCursor = isRecord(payload.pagination) ? payload.pagination.next : null;
  const nextCursor = (typeof rawCursor === 'number' && Number.isSafeInteger(rawCursor) && rawCursor > 0)
    ? String(rawCursor)
    : (isNonEmptyString(rawCursor) && /^\d{1,20}$/.test(rawCursor) ? rawCursor : null);
  return { deployments, nextCursor };
}

async function collectSystemHealth(serviceClient: ReturnType<typeof createClient>) {
  const check = async (name: string, operation: () => Promise<unknown>) => {
    const startedAt = performance.now();
    try {
      await operation();
      return { name, status: 'operational', latencyMs: Math.round(performance.now() - startedAt), message: 'Connected' };
    } catch (error) {
      return {
        name,
        status: 'unavailable',
        latencyMs: Math.round(performance.now() - startedAt),
        message: error instanceof Error ? error.message : 'Health check failed.',
      };
    }
  };
  const [database, authentication, storage] = await Promise.all([
    check('database', async () => {
      const { error } = await serviceClient.from('platform_maintenance').select('id').eq('id', 1).single();
      if (error) throw error;
    }),
    check('authentication', async () => {
      const { error } = await serviceClient.auth.admin.listUsers({ page: 1, perPage: 1 });
      if (error) throw error;
    }),
    check('storage', async () => {
      const { error } = await serviceClient.storage.listBuckets();
      if (error) throw error;
    }),
  ]);
  return {
    observedAt: new Date().toISOString(),
    checks: [
      {
        name: 'application',
        status: 'operational',
        latencyMs: null,
        message: `System owner service responding · Deno ${Deno.version.deno}`,
      },
      database,
      authentication,
      storage,
    ],
  };
}

async function recordSystemHealth(serviceClient: ReturnType<typeof createClient>) {
  const health = await collectSystemHealth(serviceClient);
  const probeId = crypto.randomUUID();
  const { error: insertError } = await serviceClient.from('system_health_observations').insert(
    health.checks.map((check) => ({
      probe_id: probeId,
      component: check.name,
      status: check.status,
      latency_ms: check.latencyMs,
      message: check.message.slice(0, 1000),
      checked_at: health.observedAt,
    })),
  );
  if (insertError) throw insertError;

  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { error: retentionError } = await serviceClient.from('system_health_observations')
    .delete().lt('checked_at', cutoff);
  if (retentionError) throw retentionError;

  const { data: uptimeHistory, error: historyError } = await serviceClient.rpc('platform_owner_uptime_history');
  if (historyError) throw historyError;
  return { ...health, uptimeHistory };
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (request.method !== 'POST') return respond(405, { error: 'Method not allowed.' });

  try {
    const payload = await request.json() as OwnerRequest;
    if (!isRecord(payload) || typeof payload.action !== 'string') {
      return respond(400, { error: 'Provide a system owner action.' });
    }
    const monitorRequest = payload.action === 'system-health-monitor';
    const accessToken = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!accessToken && !monitorRequest) return respond(401, { error: 'Sign in to access the system owner panel.' });

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const ownerId = Deno.env.get('SYSTEM_OWNER_USER_ID');
    if (!supabaseUrl || !serviceRoleKey || (!monitorRequest && !anonKey)) {
      throw new Error('System owner function configuration is incomplete.');
    }
    if (monitorRequest) {
      const monitorSecret = Deno.env.get('SYSTEM_HEALTH_MONITOR_SECRET') ?? '';
      if (!secretMatches(request.headers.get('x-system-health-monitor-secret'), monitorSecret)) {
        return respond(401, { error: 'Invalid system health monitor credentials.' });
      }
      const monitorClient = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const recordedHealth = await recordSystemHealth(monitorClient);
      return respond(200, {
        observedAt: recordedHealth.observedAt,
        checks: recordedHealth.checks,
        uptimeHistory: recordedHealth.uptimeHistory,
        historySaved: true,
      });
    }
    if (!ownerId || !isUuid(ownerId)) throw new Error('Set SYSTEM_OWNER_USER_ID to the platform owner Supabase Auth user ID.');

    const userClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser(accessToken);
    if (authError || !user) return respond(401, { error: 'Your session is invalid. Sign in again.' });
    if (user.id !== ownerId) return respond(200, { authorized: false });

    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    if (payload.action === 'check') return respond(200, { authorized: true });

    if (payload.action === 'system-health') {
      const recordedHealth = await recordSystemHealth(serviceClient);
      return respond(200, {
        ...recordedHealth,
        historySaved: true,
      });
    }

    if (payload.action === 'error-dashboard') {
      const windowDays = payload.windowDays;
      if (windowDays !== 7 && windowDays !== 30 && windowDays !== 90) {
        return respond(400, { error: 'Choose a 7, 30, or 90 day error dashboard window.' });
      }
      const { data: errorDashboard, error: dashboardError } = await serviceClient.rpc(
        'platform_owner_error_dashboard',
        { window_days: windowDays },
      );
      if (dashboardError) throw dashboardError;
      return respond(200, { errorDashboard });
    }

    if (payload.action === 'performance-dashboard') {
      const windowDays = payload.windowDays;
      if (windowDays !== 7 && windowDays !== 30 && windowDays !== 90) {
        return respond(400, { error: 'Choose a 7, 30, or 90 day performance dashboard window.' });
      }
      const retentionCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      const { error: retentionError } = await serviceClient
        .from('platform_runtime_performance_events')
        .delete()
        .lt('created_at', retentionCutoff);
      if (retentionError) throw retentionError;
      const { data: performanceDashboard, error: dashboardError } = await serviceClient.rpc(
        'platform_owner_performance_dashboard',
        { window_days: windowDays },
      );
      if (dashboardError) throw dashboardError;
      const { data: vitalRows, error: vitalError } = await serviceClient
        .from('platform_performance_metrics')
        .select('metric_name,metric_value')
        .gte('created_at', new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString())
        .order('created_at', { ascending: false })
        .limit(5000);
      if (vitalError) throw vitalError;
      const coreWebVitals = ['lcp', 'inp', 'cls'].map((name) => {
        const values = (vitalRows ?? [])
          .filter((row) => row.metric_name === name)
          .map((row) => Number(row.metric_value))
          .filter((value) => Number.isFinite(value) && value >= 0)
          .sort((left, right) => left - right);
        return {
          name,
          sampleCount: values.length,
          p75: values.length ? values[Math.ceil(values.length * 0.75) - 1] : null,
        };
      });
      return respond(200, { performanceDashboard: { ...performanceDashboard, coreWebVitals } });
    }

    if (payload.action === 'incident-list') {
      const { data: incidents, error: incidentsError } = await serviceClient
        .from('platform_incidents')
        .select('id,title,severity,status,started_at,resolved_at,affected_services,impact,cause,fix,lessons,created_at,updated_at')
        .order('started_at', { ascending: false })
        .limit(500);
      if (incidentsError) throw incidentsError;
      return respond(200, { incidents: incidents ?? [] });
    }

    if (payload.action === 'save-incident') {
      const incidentId = payload.incidentId;
      const title = payload.title;
      const severity = payload.severity;
      const incidentStatus = payload.incidentStatus;
      const startedAt = payload.startedAt;
      const resolvedAt = payload.resolvedAt;
      const affectedServices = payload.affectedServices;
      const impact = payload.impact;
      const cause = payload.cause;
      const fix = payload.fix;
      const lessons = payload.lessons;
      const validSeverities = ['critical', 'high', 'medium', 'low'];
      const validStatuses = ['investigating', 'identified', 'monitoring', 'resolved'];
      const validDate = (value: unknown): value is string =>
        typeof value === 'string' && Number.isFinite(Date.parse(value));
      if ((incidentId !== undefined && !isUuid(incidentId))
        || typeof title !== 'string' || title.trim().length < 3 || title.trim().length > 160
        || typeof severity !== 'string' || !validSeverities.includes(severity)
        || typeof incidentStatus !== 'string' || !validStatuses.includes(incidentStatus)
        || !validDate(startedAt)
        || (resolvedAt !== null && resolvedAt !== undefined && !validDate(resolvedAt))
        || !isShortText(affectedServices, 500)
        || !isShortText(impact, 2000)
        || !isShortText(cause, 3000)
        || !isShortText(fix, 3000)
        || !isShortText(lessons, 3000)) {
        return respond(400, { error: 'Provide a valid incident with supported severity, status, dates, and field lengths.' });
      }
      const resolvedAtValue = typeof resolvedAt === 'string' ? resolvedAt : null;
      if (resolvedAtValue && Date.parse(resolvedAtValue) < Date.parse(startedAt)) {
        return respond(400, { error: 'The recovery time cannot be earlier than the incident start time.' });
      }
      if (incidentStatus === 'resolved' && !resolvedAtValue) {
        return respond(400, { error: 'Provide a recovery time for a resolved incident.' });
      }

      const incidentValues = {
        title: title.trim(),
        severity,
        status: incidentStatus,
        started_at: new Date(startedAt).toISOString(),
        resolved_at: resolvedAtValue ? new Date(resolvedAtValue).toISOString() : null,
        affected_services: affectedServices.trim(),
        impact: impact.trim(),
        cause: cause.trim(),
        fix: fix.trim(),
        lessons: lessons.trim(),
        updated_at: new Date().toISOString(),
        updated_by: user.id,
      };
      const query = incidentId
        ? serviceClient.from('platform_incidents').update(incidentValues).eq('id', incidentId)
        : serviceClient.from('platform_incidents').insert({ ...incidentValues, created_by: user.id });
      const { data: incident, error: saveError } = await query
        .select('id,title,severity,status,started_at,resolved_at,affected_services,impact,cause,fix,lessons,created_at,updated_at')
        .maybeSingle();
      if (saveError) throw saveError;
      if (!incident) return respond(404, { error: 'The incident was not found.' });
      return respond(200, { incident });
    }

    if (payload.action === 'release-history') {
      const cursor = payload.cursor === undefined || payload.cursor === null ? null : payload.cursor;
      if (cursor !== null && (typeof cursor !== 'string' || !/^\d{1,20}$/.test(cursor))) {
        return respond(400, { error: 'Provide a valid Vercel release history cursor.' });
      }
      const { deployments, nextCursor } = await getVercelProductionDeployments(cursor);
      const deploymentIds = deployments.map((deployment) => deployment.id);
      let notesByDeployment = new Map<string, { knownIssues: string; updatedAt: string }>();
      if (deploymentIds.length) {
        const { data: notes, error: notesError } = await serviceClient
          .from('platform_release_known_issues')
          .select('vercel_deployment_id,known_issues,updated_at')
          .in('vercel_deployment_id', deploymentIds);
        if (notesError) throw notesError;
        notesByDeployment = new Map((notes ?? []).map((note) => [
          note.vercel_deployment_id,
          { knownIssues: note.known_issues, updatedAt: note.updated_at },
        ]));
      }
      return respond(200, {
        deployments: deployments.map((deployment) => ({
          ...deployment,
          knownIssues: notesByDeployment.get(deployment.id)?.knownIssues ?? '',
          knownIssuesUpdatedAt: notesByDeployment.get(deployment.id)?.updatedAt ?? null,
        })),
        nextCursor,
      });
    }

    if (payload.action === 'save-release-known-issues') {
      const deploymentId = payload.vercelDeploymentId;
      const knownIssues = payload.knownIssues;
      if (typeof deploymentId !== 'string'
        || !/^[A-Za-z0-9_-]{5,128}$/.test(deploymentId)
        || typeof knownIssues !== 'string'
        || knownIssues.length > 3000) {
        return respond(400, { error: 'Provide a valid deployment and known-issues note under 3,000 characters.' });
      }

      const trimmedIssues = knownIssues.trim();
      if (!trimmedIssues) {
        const { error: deleteError } = await serviceClient
          .from('platform_release_known_issues')
          .delete()
          .eq('vercel_deployment_id', deploymentId);
        if (deleteError) throw deleteError;
        return respond(200, { vercelDeploymentId: deploymentId, knownIssues: '', updatedAt: null });
      }

      const { data: savedNote, error: saveError } = await serviceClient
        .from('platform_release_known_issues')
        .upsert({
          vercel_deployment_id: deploymentId,
          known_issues: trimmedIssues,
          updated_by: user.id,
          updated_at: new Date().toISOString(),
        })
        .select('vercel_deployment_id,known_issues,updated_at')
        .single();
      if (saveError) throw saveError;
      return respond(200, {
        vercelDeploymentId: savedNote.vercel_deployment_id,
        knownIssues: savedNote.known_issues,
        updatedAt: savedNote.updated_at,
      });
    }

    if (payload.action === 'support-inbox') {
      const tickets: Array<Record<string, unknown>> = [];
      const pageSize = 500;
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await serviceClient
          .from('support_tickets')
          .select('id,school_id,school_name,requester_name,requester_email,requester_role,category,title,description,status,owner_response,created_at,updated_at')
          .in('status', ['new', 'in_progress', 'waiting_on_requester'])
          .order('created_at', { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (error) throw error;
        tickets.push(...(data ?? []));
        if ((data ?? []).length < pageSize) break;
      }
      return respond(200, { tickets });
    }

    if (payload.action === 'update-support-ticket') {
      const ticketStatuses = ['new', 'in_progress', 'waiting_on_requester', 'resolved', 'closed'];
      if (!isUuid(payload.ticketId)
        || typeof payload.ticketStatus !== 'string'
        || !ticketStatuses.includes(payload.ticketStatus)
        || !isShortText(payload.ownerResponse, 4000)) {
        return respond(400, { error: 'Provide a valid support request, status, and response.' });
      }
      const { data: ticket, error } = await serviceClient
        .from('support_tickets')
        .update({
          status: payload.ticketStatus,
          owner_response: payload.ownerResponse.trim(),
        })
        .eq('id', payload.ticketId)
        .select('id,status,owner_response,updated_at')
        .maybeSingle();
      if (error) throw error;
      if (!ticket) return respond(404, { error: 'The support request was not found.' });
      return respond(200, { ticket });
    }

    if (payload.action === 'dashboard') {
      const { data, error } = await serviceClient.rpc('platform_owner_dashboard');
      if (error) throw error;
      const { data: setupHealth, error: setupHealthError } = await serviceClient
        .rpc('platform_owner_setup_health_overview');
      if (setupHealthError) throw setupHealthError;
      const { data: performanceRows, error: performanceError } = await serviceClient
        .from('platform_performance_metrics')
        .select('metric_name, metric_value')
        .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
        .order('created_at', { ascending: false })
        .limit(5000);
      if (performanceError) throw performanceError;
      const performanceMetrics = ['lcp', 'inp', 'cls'].map((metricName) => {
        const values = (performanceRows ?? [])
          .filter((row) => row.metric_name === metricName)
          .map((row) => Number(row.metric_value))
          .filter((value) => Number.isFinite(value) && value >= 0)
          .sort((left, right) => left - right);
        return {
          name: metricName,
          count: values.length,
          p75: values.length ? values[Math.ceil(values.length * 0.75) - 1] : null,
        };
      });
      const managedStorageConfigured = Boolean(
        Deno.env.get('R2_ACCOUNT_ID')
        && Deno.env.get('R2_BUCKET_NAME')
        && Deno.env.get('R2_ACCESS_KEY_ID')
        && Deno.env.get('R2_SECRET_ACCESS_KEY'),
      );
      return respond(200, {
        dashboard: {
          ...data,
          managedStorageConfigured,
          setupHealth,
          performance: {
            windowDays: 7,
            sampleCount: performanceRows?.length ?? 0,
            metrics: performanceMetrics,
          },
        },
      });
    }

    if (payload.action === 'maintenance-dashboard') {
      const [
        { data: maintenance, error: maintenanceError },
        { data: status, error: statusError },
        { data: windows, error: windowsError },
        { data: schools, error: schoolsError },
      ] = await Promise.all([
        serviceClient.from('platform_maintenance').select('*').eq('id', 1).single(),
        serviceClient.rpc('platform_maintenance_status'),
        serviceClient.from('platform_maintenance_windows')
          .select('id,scope,school_id,module_key,starts_at,ends_at,read_only,notice,cancelled_at,created_at,school:schools(name)')
          .is('cancelled_at', null)
          .order('starts_at', { ascending: true })
          .limit(100),
        serviceClient.from('schools').select('id,name').order('name').limit(1000),
      ]);
      if (maintenanceError) throw maintenanceError;
      if (statusError) throw statusError;
      if (windowsError) throw windowsError;
      if (schoolsError) throw schoolsError;
      return respond(200, { maintenance, status, windows, schools, modules: maintenanceModules });
    }

    if (payload.action === 'set-global-maintenance') {
      if (typeof payload.enabled !== 'boolean'
        || typeof payload.readOnly !== 'boolean'
        || typeof payload.emergency !== 'boolean'
        || !isShortText(payload.notice, 2000)) {
        return respond(400, { error: 'Provide a valid global maintenance state, access mode, and notice.' });
      }
      const enabled = payload.enabled;
      const { error } = await serviceClient.from('platform_maintenance').upsert({
        id: 1,
        global_enabled: enabled,
        global_read_only: enabled && payload.readOnly,
        emergency_enabled: enabled && payload.emergency,
        notice: payload.notice,
        updated_by: user.id,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });
      if (error) throw error;
      if (!enabled) {
        const { error: cancelError } = await serviceClient.from('platform_maintenance_windows')
          .update({ cancelled_at: new Date().toISOString() })
          .eq('scope', 'global')
          .is('cancelled_at', null);
        if (cancelError) throw cancelError;
      }
      const { error: activityError } = await serviceClient.from('platform_activity').insert({
        actor_id: user.id,
        action: enabled ? payload.emergency ? 'emergency_maintenance_activated' : 'global_maintenance_activated' : 'global_maintenance_disabled',
        target_type: 'platform_maintenance',
        details: { read_only: enabled && payload.readOnly, emergency: enabled && payload.emergency },
      });
      if (activityError) throw activityError;
      return respond(200, { enabled });
    }

    if (payload.action === 'schedule-maintenance') {
      if (!['global', 'school', 'module'].includes(String(payload.scope))
        || typeof payload.startsAt !== 'string'
        || !Number.isFinite(Date.parse(payload.startsAt))
        || (payload.endsAt !== null && payload.endsAt !== undefined
          && (typeof payload.endsAt !== 'string' || !Number.isFinite(Date.parse(payload.endsAt))))
        || (typeof payload.endsAt === 'string' && Date.parse(payload.endsAt) <= Date.parse(payload.startsAt))
        || (Date.parse(payload.startsAt) > Date.now() && !payload.endsAt)
        || typeof payload.readOnly !== 'boolean'
        || !isShortText(payload.notice, 2000)) {
        return respond(400, { error: 'Enter valid maintenance scope, start/end times, mode, and notice.' });
      }
      const scope = payload.scope as string;
      if ((scope === 'school' || scope === 'module') && !isUuid(payload.schoolId)) {
        return respond(400, { error: 'Choose a valid school for scoped maintenance.' });
      }
      if (scope === 'module' && (typeof payload.moduleKey !== 'string' || !maintenanceModules.includes(payload.moduleKey))) {
        return respond(400, { error: 'Choose a valid module for module-specific maintenance.' });
      }
      const { data, error } = await serviceClient.from('platform_maintenance_windows').insert({
        scope,
        school_id: scope === 'global' ? null : payload.schoolId,
        module_key: scope === 'module' ? payload.moduleKey : null,
        starts_at: new Date(payload.startsAt).toISOString(),
        ends_at: typeof payload.endsAt === 'string' ? new Date(payload.endsAt).toISOString() : null,
        read_only: payload.readOnly,
        notice: payload.notice,
        created_by: user.id,
      }).select('id').single();
      if (error) throw error;
      const { error: activityError } = await serviceClient.from('platform_activity').insert({
        actor_id: user.id,
        action: 'maintenance_scheduled',
        target_type: 'maintenance_window',
        target_id: data.id,
        details: { scope, school_id: scope === 'global' ? null : payload.schoolId, module: scope === 'module' ? payload.moduleKey : null },
      });
      if (activityError) throw activityError;
      return respond(200, { windowId: data.id });
    }

    if (payload.action === 'set-scoped-maintenance') {
      if ((payload.scope !== 'school' && payload.scope !== 'module')
        || !isUuid(payload.schoolId)
        || typeof payload.enabled !== 'boolean'
        || typeof payload.readOnly !== 'boolean'
        || !isShortText(payload.notice, 2000)
        || (payload.scope === 'module' && (typeof payload.moduleKey !== 'string' || !maintenanceModules.includes(payload.moduleKey)))) {
        return respond(400, { error: 'Provide a valid school/module maintenance scope and access mode.' });
      }
      if (!payload.enabled) {
        const updateQuery = serviceClient.from('platform_maintenance_windows')
          .update({ cancelled_at: new Date().toISOString() })
          .eq('scope', payload.scope)
          .eq('school_id', payload.schoolId)
          .is('cancelled_at', null)
          .lte('starts_at', new Date().toISOString())
          .is('ends_at', null);
        const { error } = payload.scope === 'module'
          ? await updateQuery.eq('module_key', payload.moduleKey)
          : await updateQuery;
        if (error) throw error;
      } else {
        const existingQuery = serviceClient.from('platform_maintenance_windows')
          .select('id', { count: 'exact', head: true })
          .eq('scope', payload.scope)
          .eq('school_id', payload.schoolId)
          .is('cancelled_at', null)
          .lte('starts_at', new Date().toISOString())
          .is('ends_at', null);
        const { error: existingError, count } = payload.scope === 'module'
          ? await existingQuery.eq('module_key', payload.moduleKey)
          : await existingQuery;
        if (existingError) throw existingError;
        if (count) return respond(409, { error: 'This maintenance mode is already enabled.' });
        const { error } = await serviceClient.from('platform_maintenance_windows').insert({
          scope: payload.scope,
          school_id: payload.schoolId,
          module_key: payload.scope === 'module' ? payload.moduleKey : null,
          starts_at: new Date().toISOString(),
          ends_at: null,
          read_only: payload.readOnly,
          notice: payload.notice,
          created_by: user.id,
        });
        if (error) throw error;
      }
      const { error: activityError } = await serviceClient.from('platform_activity').insert({
        actor_id: user.id,
        action: `${payload.scope}_maintenance_${payload.enabled ? 'activated' : 'disabled'}`,
        target_type: payload.scope,
        target_id: payload.schoolId,
        details: { module: payload.scope === 'module' ? payload.moduleKey : null, read_only: payload.enabled && payload.readOnly },
      });
      if (activityError) throw activityError;
      return respond(200, { enabled: payload.enabled });
    }

    if (payload.action === 'cancel-maintenance') {
      if (!isUuid(payload.windowId)) return respond(400, { error: 'Choose a valid scheduled maintenance window.' });
      const { data, error } = await serviceClient.from('platform_maintenance_windows')
        .update({ cancelled_at: new Date().toISOString() })
        .eq('id', payload.windowId)
        .is('cancelled_at', null)
        .select('id,scope,school_id,module_key')
        .maybeSingle();
      if (error) throw error;
      if (!data) return respond(404, { error: 'The maintenance window has already ended or been cancelled.' });
      const { error: activityError } = await serviceClient.from('platform_activity').insert({
        actor_id: user.id,
        action: 'maintenance_cancelled',
        target_type: 'maintenance_window',
        target_id: data.id,
        details: { scope: data.scope, school_id: data.school_id, module: data.module_key },
      });
      if (activityError) throw activityError;
      return respond(200, { cancelled: true });
    }

    if (payload.action === 'list-schools') {
      const sortFields = ['created_at', 'name', 'status', 'subscription'];
      const statusFilter = payload.statusFilter === 'active' || payload.statusFilter === 'suspended' ? payload.statusFilter : '';
      const typeFilter = typeof payload.typeFilter === 'string' && schoolTypes.includes(payload.typeFilter) ? payload.typeFilter : '';
      const { data, error } = await serviceClient.rpc('platform_owner_school_list', {
        search_text: typeof payload.search === 'string' ? payload.search.trim().slice(0, 120) : '',
        status_filter: statusFilter,
        type_filter: typeFilter,
        sort_field: typeof payload.sortField === 'string' && sortFields.includes(payload.sortField) ? payload.sortField : 'created_at',
        sort_ascending: payload.sortAscending === true,
        page_number: typeof payload.page === 'number' ? Math.max(1, Math.floor(payload.page)) : 1,
        page_size: typeof payload.pageSize === 'number' ? Math.min(50, Math.max(1, Math.floor(payload.pageSize))) : 20,
      });
      if (error) throw error;
      const { data: platformSettings, error: settingsError } = await serviceClient
        .from('platform_settings')
        .select('supported_school_types')
        .eq('id', 1)
        .single();
      if (settingsError) throw settingsError;
      return respond(200, {
        result: data,
        supportedSchoolTypes: platformSettings.supported_school_types,
      });
    }

    if (payload.action === 'get-platform-settings') {
      const { data, error } = await serviceClient.from('platform_settings')
        .select('platform_name,logo_url,favicon_url,contact_email,contact_phone,default_language,default_timezone,default_date_format,supported_school_types,default_academic_configuration,global_feature_availability,maintenance_notice,default_notification_settings')
        .eq('id', 1)
        .single();
      if (error) throw error;
      return respond(200, { settings: data });
    }

    if (payload.action === 'save-platform-settings') {
      if (!isRecord(payload.settings)) return respond(400, { error: 'Platform settings are required.' });
      const settings = payload.settings;
      const textLimits: Record<string, number> = {
        platform_name: 120, logo_url: 2000, favicon_url: 2000, contact_email: 320,
        contact_phone: 40, default_language: 20, default_timezone: 100,
        default_date_format: 40, maintenance_notice: 2000,
      };
      for (const [key, limit] of Object.entries(textLimits)) {
        if (!isShortText(settings[key], limit)) return respond(400, { error: `Invalid platform setting: ${key}.` });
      }
      if (!Array.isArray(settings.supported_school_types)
        || settings.supported_school_types.length === 0
        || new Set(settings.supported_school_types).size !== settings.supported_school_types.length
        || !settings.supported_school_types.every((value) => typeof value === 'string' && schoolTypes.includes(value))) {
        return respond(400, { error: 'Choose valid supported school types.' });
      }
      if (!['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD.MM.YYYY'].includes(String(settings.default_date_format))) {
        return respond(400, { error: 'Choose a supported date format.' });
      }
      for (const key of ['default_academic_configuration', 'global_feature_availability', 'default_notification_settings']) {
        if (!isRecord(settings[key])) return respond(400, { error: `Invalid platform setting: ${key}.` });
      }
      const academic = settings.default_academic_configuration as Record<string, unknown>;
      if (!Number.isInteger(academic.academicYearStartMonth) || Number(academic.academicYearStartMonth) < 1 || Number(academic.academicYearStartMonth) > 12
        || !Number.isInteger(academic.academicYearStartDay) || Number(academic.academicYearStartDay) < 1 || Number(academic.academicYearStartDay) > 28
        || !Number.isInteger(academic.termCount) || Number(academic.termCount) < 1 || Number(academic.termCount) > 6) {
        return respond(400, { error: 'Academic year and term defaults are invalid.' });
      }
      const features = settings.global_feature_availability as Record<string, unknown>;
      if (Object.values(features).some((value) => typeof value !== 'boolean')) {
        return respond(400, { error: 'Global feature availability values must be enabled or disabled.' });
      }
      const notifications = settings.default_notification_settings as Record<string, unknown>;
      if (['email', 'inApp', 'maintenanceNotices'].some((key) => typeof notifications[key] !== 'boolean')) {
        return respond(400, { error: 'Default notification settings are invalid.' });
      }
      const { error } = await serviceClient.rpc('platform_owner_save_settings', {
        settings_value: settings,
        actor: user.id,
      });
      if (error) throw error;
      const { error: activityError } = await serviceClient.from('platform_activity').insert({
        actor_id: user.id,
        action: 'platform_settings_updated',
        target_type: 'platform_settings',
        details: {},
      });
      if (activityError) throw activityError;
      return respond(200, { saved: true });
    }

    if (payload.action === 'register-school' || payload.action === 'update-school') {
      if (!isRecord(payload.school)) return respond(400, { error: 'School information is required.' });
      const school = payload.school;
      if (typeof school.name !== 'string' || school.name.trim().length < 2 || school.name.trim().length > 120) {
        return respond(400, { error: 'School name must be between 2 and 120 characters.' });
      }
      const optionalTextLimits: Record<string, number> = {
        contact_email: 320, contact_phone: 40, address: 500, website: 2000,
        timezone: 100, default_language: 20, logo_path: 2000, favicon_path: 2000,
        subscription_plan: 100,
      };
      for (const [key, limit] of Object.entries(optionalTextLimits)) {
        if (school[key] !== undefined && school[key] !== null && !isShortText(school[key], limit)) {
          return respond(400, { error: `Invalid school field: ${key}.` });
        }
      }
      if (school.school_type !== null && school.school_type !== '' && !schoolTypes.includes(String(school.school_type))) {
        return respond(400, { error: 'Choose a supported school type.' });
      }
      if (school.subscription_status !== undefined && !subscriptionStatuses.includes(String(school.subscription_status))) {
        return respond(400, { error: 'Choose a valid school subscription status.' });
      }
      if (school.subscription_ends_at !== null && school.subscription_ends_at !== undefined
        && (typeof school.subscription_ends_at !== 'string' || !Number.isFinite(Date.parse(school.subscription_ends_at)))) {
        return respond(400, { error: 'Enter a valid subscription end date.' });
      }
      if (school.date_format !== undefined && !['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD.MM.YYYY'].includes(String(school.date_format))) {
        return respond(400, { error: 'Choose a supported school date format.' });
      }
      let schoolDefaults: { default_timezone: string; default_language: string; default_date_format: string; supported_school_types: string[] } | null = null;
      if (payload.action === 'register-school') {
        const { data, error } = await serviceClient.from('platform_settings')
          .select('default_timezone,default_language,default_date_format,supported_school_types')
          .eq('id', 1)
          .single();
        if (error) throw error;
        schoolDefaults = data;
        if (school.school_type && !data.supported_school_types.includes(school.school_type)) {
          return respond(400, { error: 'This school type is not currently supported by the platform.' });
        }
      }
      const schoolFields = {
        name: school.name.trim(),
        school_type: school.school_type || null,
        contact_email: isShortText(school.contact_email, 320) ? school.contact_email.trim() || null : null,
        contact_phone: isShortText(school.contact_phone, 40) ? school.contact_phone.trim() || null : null,
        address: isShortText(school.address, 500) ? school.address.trim() || null : null,
        website: isShortText(school.website, 2000) ? school.website.trim() || null : null,
        timezone: isShortText(school.timezone, 100) ? school.timezone.trim() || schoolDefaults?.default_timezone || 'UTC' : schoolDefaults?.default_timezone || 'UTC',
        default_language: isShortText(school.default_language, 20) ? school.default_language.trim() || schoolDefaults?.default_language || 'en' : schoolDefaults?.default_language || 'en',
        date_format: typeof school.date_format === 'string' ? school.date_format : schoolDefaults?.default_date_format || 'YYYY-MM-DD',
        logo_path: isShortText(school.logo_path, 2000) ? school.logo_path.trim() || null : null,
        favicon_path: isShortText(school.favicon_path, 2000) ? school.favicon_path.trim() || null : null,
        subscription_status: subscriptionStatuses.includes(String(school.subscription_status)) ? school.subscription_status : 'free',
        subscription_plan: isShortText(school.subscription_plan, 100) ? school.subscription_plan.trim() || 'phase_1_free' : 'phase_1_free',
        subscription_ends_at: typeof school.subscription_ends_at === 'string' && school.subscription_ends_at ? school.subscription_ends_at : null,
      };
      let schoolId: string;
      if (payload.action === 'register-school') {
        const { data, error } = await serviceClient.from('schools')
          .insert({ ...schoolFields, created_by: user.id })
          .select('id,name')
          .single();
        if (error) throw error;
        schoolId = data.id;
      } else {
        if (!isUuid(payload.schoolId)) return respond(400, { error: 'Choose a valid school.' });
        const { data, error } = await serviceClient.from('schools')
          .update(schoolFields)
          .eq('id', payload.schoolId)
          .select('id,name')
          .maybeSingle();
        if (error) throw error;
        if (!data) return respond(404, { error: 'The school was not found.' });
        schoolId = data.id;
      }
      const { error: activityError } = await serviceClient.from('platform_activity').insert({
        actor_id: user.id,
        action: payload.action === 'register-school' ? 'school_registered_by_platform' : 'school_information_updated',
        target_type: 'school',
        target_id: schoolId,
        details: { school_name: schoolFields.name },
      });
      if (activityError) throw activityError;
      return respond(200, { schoolId });
    }

    if (payload.action === 'assign-school-admin') {
      if (!isUuid(payload.schoolId) || typeof payload.adminEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.adminEmail)) {
        return respond(400, { error: 'Enter the email address of an existing Campus Connect user.' });
      }
      const { data: school, error: schoolError } = await serviceClient.from('schools').select('id,name').eq('id', payload.schoolId).maybeSingle();
      if (schoolError) throw schoolError;
      if (!school) return respond(404, { error: 'The school was not found.' });
      const { data: profile, error: profileError } = await serviceClient.from('profiles')
        .select('id,email,full_name')
        .eq('email', payload.adminEmail.trim().toLowerCase())
        .maybeSingle();
      if (profileError) throw profileError;
      if (!profile) return respond(404, { error: 'No Campus Connect account was found for that email. The administrator must sign up first.' });
      const { error: membershipError } = await serviceClient.from('school_memberships')
        .upsert({ school_id: school.id, profile_id: profile.id, role: 'school_admin' }, { onConflict: 'school_id,profile_id' });
      if (membershipError) throw membershipError;
      const { error: activityError } = await serviceClient.from('platform_activity').insert({
        actor_id: user.id,
        action: 'school_administrator_assigned',
        target_type: 'school',
        target_id: school.id,
        details: { school_name: school.name, administrator_email: profile.email },
      });
      if (activityError) throw activityError;
      return respond(200, { administrator: { id: profile.id, name: profile.full_name, email: profile.email } });
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
