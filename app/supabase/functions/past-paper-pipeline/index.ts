import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin, Access-Control-Request-Headers',
};
const MAX_LISTING_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'CampusConnectPastPaperBot';
const ADMIN_ROLES = ['school_admin', 'academic_coordinator'];
const STAFF_ROLES = ['school_admin', 'academic_coordinator', 'teacher'];

type PipelineRequest = {
  action?: unknown;
  schoolId?: unknown;
  sourceId?: unknown;
  itemId?: unknown;
  questionId?: unknown;
  name?: unknown;
  listingUrl?: unknown;
  termsUrl?: unknown;
  rightsBasis?: unknown;
  metadataDiscoveryAllowed?: unknown;
  questionExtractionAllowed?: unknown;
  questionReuseAllowed?: unknown;
  questionText?: unknown;
  topic?: unknown;
  subtopic?: unknown;
  syllabusCode?: unknown;
  marks?: unknown;
  difficulty?: unknown;
  markScheme?: unknown;
  decision?: unknown;
  reviewerNote?: unknown;
  query?: unknown;
  idempotencyKey?: unknown;
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

function allowedHosts() {
  return new Set((Deno.env.get('PAPER_SOURCE_HOSTS') ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean));
}

function validateSourceUrl(value: unknown, hosts: Set<string>) {
  if (typeof value !== 'string') throw new Error('Provide a valid HTTPS source URL.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The source URL is invalid.');
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !hosts.has(hostname) || hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname.endsWith('.local') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) {
    throw new Error('Source URLs must use HTTPS on a host configured in PAPER_SOURCE_HOSTS.');
  }
  if ([...url.searchParams.keys()].some((key) => /token|key|auth|secret|signature|session|password|credential/i.test(key))) {
    throw new Error('Source URLs cannot contain credential-like query parameters.');
  }
  url.hash = '';
  return url;
}

function canonicalizeUrl(value: string) {
  const url = new URL(value);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || key.toLowerCase() === 'fbclid') url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.href;
}

function cleanText(value: string) {
  return value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function parseListingLinks(html: string, listingUrl: URL) {
  const links: Array<{ url: string; title: string; linkText: string }> = [];
  const pattern = /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) && links.length < 200) {
    const rawHref = match[1] ?? match[2] ?? match[3] ?? '';
    const linkText = cleanText(match[4] ?? '');
    let url: URL;
    try {
      url = new URL(rawHref, listingUrl);
    } catch {
      continue;
    }
    if (url.origin !== listingUrl.origin || !/^https:$/.test(url.protocol)) continue;
    let pathTitle = url.pathname.split('/').filter(Boolean).at(-1) ?? url.hostname;
    try {
      pathTitle = decodeURIComponent(pathTitle);
    } catch {
      // Keep the encoded path segment when the source provides invalid escapes.
    }
    const title = linkText || pathTitle;
    if (!title || !(url.pathname.toLowerCase().endsWith('.pdf')
      || /\b(past paper|question paper|mark scheme|specimen|examiner report)\b/i.test(`${title} ${url.pathname}`))) continue;
    links.push({ url: canonicalizeUrl(url.href), title: title.slice(0, 300), linkText: linkText.slice(0, 500) });
  }
  return links;
}

async function readLimited(response: Response, maxBytes: number) {
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > maxBytes) throw new Error('The source listing exceeds the 2 MB limit.');
  if (!response.body) throw new Error('The source returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('The source listing exceeds the 2 MB limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

async function fetchSameHost(url: URL, maxBytes: number, accept: string, allowRedirects = true) {
  let current = url;
  for (let count = 0; count <= MAX_REDIRECTS; count += 1) {
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      headers: { Accept: accept, 'User-Agent': USER_AGENT },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!allowRedirects) throw new Error('The listing page redirected. Update the registered URL to the permitted destination and retry.');
      if (!location || count === MAX_REDIRECTS) throw new Error('Source exceeded the safe redirect limit.');
      const redirected = new URL(location, current);
      if (redirected.protocol !== 'https:' || redirected.hostname !== url.hostname
        || redirected.username || redirected.password || redirected.port) {
        throw new Error('Cross-host or non-HTTPS redirects are not followed.');
      }
      current = redirected;
      continue;
    }
    if (response.status === 404 && current.pathname.endsWith('/robots.txt')) {
      return { response, text: '' };
    }
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`);
    const text = await readLimited(response, maxBytes);
    return { response, text };
  }
  throw new Error('Could not resolve the source URL.');
}

function robotsAllows(robotsText: string, url: URL) {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
  let group: { agents: string[]; rules: Array<{ allow: boolean; path: string }> } | null = null;
  let sawDirective = false;
  for (const rawLine of robotsText.split(/\r?\n/)) {
    const line = rawLine.split('#', 1)[0].trim();
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const directive = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (directive === 'user-agent') {
      if (!group || sawDirective) {
        group = { agents: [], rules: [] };
        groups.push(group);
        sawDirective = false;
      }
      group.agents.push(value.toLowerCase());
    } else if ((directive === 'allow' || directive === 'disallow') && group) {
      sawDirective = true;
      if (value) group.rules.push({ allow: directive === 'allow', path: value });
    }
  }
  const specific = groups.filter((item) => item.agents.some((agent) => agent !== '*' && USER_AGENT.toLowerCase().includes(agent)));
  const selected = specific.length ? specific : groups.filter((item) => item.agents.includes('*'));
  let path: string;
  try {
    path = decodeURI(`${url.pathname}${url.search}`);
  } catch {
    return false;
  }
  const rules = selected.flatMap((item) => item.rules).filter((rule) => {
    let rulePath = rule.path;
    try {
      rulePath = decodeURI(rule.path);
    } catch {
      return !rule.allow;
    }
    const escaped = rulePath.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const expression = new RegExp(`^${escaped}${rulePath.endsWith('$') ? '$' : ''}`);
    return expression.test(path);
  }).sort((left, right) => right.path.length - left.path.length);
  return !rules.length || rules[0].allow;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validateQuestion(payload: PipelineRequest) {
  const errors: string[] = [];
  const questionText = typeof payload.questionText === 'string' ? payload.questionText.trim() : '';
  const topic = typeof payload.topic === 'string' ? payload.topic.trim() : '';
  const subtopic = typeof payload.subtopic === 'string' ? payload.subtopic.trim() : '';
  const syllabusCode = typeof payload.syllabusCode === 'string' ? payload.syllabusCode.trim() : '';
  const markScheme = typeof payload.markScheme === 'string' ? payload.markScheme.trim() : '';
  const marks = Number(payload.marks);
  const difficulty = payload.difficulty;
  if (questionText.length < 10 || questionText.length > 12000) errors.push('Question text must be 10–12,000 characters.');
  if (topic.length < 1 || topic.length > 160) errors.push('Topic is required and must be at most 160 characters.');
  if (subtopic.length > 160) errors.push('Subtopic must be at most 160 characters.');
  if (syllabusCode.length > 40) errors.push('Syllabus code must be at most 40 characters.');
  if (!Number.isFinite(marks) || marks <= 0 || marks > 1000) errors.push('Marks must be greater than 0 and no more than 1,000.');
  if (!['Foundation', 'Standard', 'Challenging'].includes(String(difficulty))) errors.push('Choose a supported difficulty.');
  if (markScheme.length > 12000) errors.push('Mark scheme must be at most 12,000 characters.');
  return {
    errors,
    values: {
      question_text: questionText,
      topic,
      subtopic,
      syllabus_code: syllabusCode,
      marks,
      difficulty: String(difficulty),
      mark_scheme: markScheme,
    },
  };
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return respond(405, { error: 'Method not allowed.' });

  try {
    const accessToken = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!accessToken) return respond(401, { error: 'Sign in to use the past-paper pipeline.' });
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !anonKey || !serviceRoleKey) throw new Error('Past-paper pipeline configuration is incomplete.');

    const userClient = createClient<any>(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser(accessToken);
    if (authError || !user) return respond(401, { error: 'Your session is invalid. Sign in again.' });
    const payload = await request.json() as PipelineRequest;
    if (!isUuid(payload.schoolId)) return respond(400, { error: 'Select a valid school.' });

    const { data: membership, error: membershipError } = await userClient
      .from('school_memberships')
      .select('role')
      .eq('school_id', payload.schoolId)
      .eq('profile_id', user.id)
      .maybeSingle();
    if (membershipError) throw membershipError;
    const role = membership?.role;
    if (!role || !STAFF_ROLES.includes(role)) return respond(403, { error: 'A teacher or school academic lead account is required.' });
    const isAdmin = ADMIN_ROLES.includes(role);
    const service = createClient<any>(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const [{ data: moduleSettings, error: moduleError }, { data: permissionSummary, error: permissionError }, { data: maintenance, error: maintenanceError }] = await Promise.all([
      service.from('school_module_settings').select('module_learning').eq('school_id', payload.schoolId).maybeSingle(),
      userClient.rpc('get_school_permission_summary', { target_school: payload.schoolId }),
      userClient.rpc('platform_maintenance_status', { target_school: payload.schoolId, target_module: 'learning' }),
    ]);
    if (moduleError) throw moduleError;
    if (permissionError) throw permissionError;
    if (maintenanceError) throw maintenanceError;
    if (moduleSettings?.module_learning !== true) return respond(403, { error: 'The Learning module is not enabled for this school.' });
    if (!isRecord(permissionSummary) || !isRecord(permissionSummary.learning)
      || typeof permissionSummary.learning.access !== 'boolean') {
      throw new Error('The school permission service returned an invalid Learning permission.');
    }
    if (permissionSummary.learning.access === false) return respond(403, { error: 'Your school role does not have permission to access Learning.' });
    if (!isRecord(maintenance) || typeof maintenance.active !== 'boolean') {
      throw new Error('The school maintenance service returned an invalid Learning status.');
    }
    if (maintenance.active) return respond(503, { error: 'The Learning module is temporarily under maintenance.' });
    const requiredPermissionByAction: Record<string, string> = {
      list: 'view',
      'register-source': 'create',
      discover: 'create',
      'pause-source': 'edit',
      'review-item': 'approve',
      'submit-question': 'create',
      'review-question': 'approve',
      'search-approved': 'view',
      'import-question': 'create',
      'remove-restricted-question': 'delete',
    };
    const requiredPermission = typeof payload.action === 'string' ? requiredPermissionByAction[payload.action] : undefined;
    if (requiredPermission && permissionSummary.learning[requiredPermission] !== true) {
      return respond(403, { error: `Your school role does not have the ${requiredPermission} permission for Learning.` });
    }
    const recordAudit = async (
      schoolId: string,
      userId: string,
      action: string,
      targetTable: string,
      targetId: string | null,
      correlationId: string,
    ) => {
      const { error } = await service.from('audit_logs').insert({
        school_id: schoolId,
        actor_id: userId,
        action,
        target_table: targetTable,
        target_id: targetId,
        metadata: { correlation_id: correlationId },
      });
      if (error) throw new Error(`The change could not be audited: ${error.message}`);
    };
    const requireAdmin = () => {
      if (!isAdmin) throw new Response('Only school administrators and academic coordinators can perform this action.', { status: 403 });
    };

    if (payload.action === 'list') {
      const [sources, jobs, items, questions] = await Promise.all([
        service.from('past_paper_sources').select('*').eq('school_id', payload.schoolId).order('created_at', { ascending: false }),
        service.from('past_paper_discovery_jobs').select('*').eq('school_id', payload.schoolId).order('created_at', { ascending: false }).limit(50),
        service.from('past_paper_discovery_items').select('*').eq('school_id', payload.schoolId).order('created_at', { ascending: false }).limit(200),
        service.from('past_paper_catalogue_questions').select('*').eq('school_id', payload.schoolId)
          .order('created_at', { ascending: false }).limit(200),
      ]);
      for (const result of [sources, jobs, items, questions]) if (result.error) throw result.error;
      let restrictedQuestions: Array<Record<string, unknown>> = [];
      if (isAdmin) {
        const { data, error } = await service.from('past_paper_restricted_questions')
          .select('id,learning_question_id,question_text,source_name,registered_source_name,source_status,question_reuse_allowed,catalogue_review_status,item_review_status')
          .eq('school_id', payload.schoolId).order('source_name').limit(200);
        if (error) throw error;
        restrictedQuestions = data ?? [];
      }
      const activeContentSourceIds = new Set((sources.data ?? [])
        .filter((source) => source.status === 'active' && source.question_extraction_allowed && source.question_reuse_allowed)
        .map((source) => source.id));
      const approvedItemIds = new Set((items.data ?? [])
        .filter((item) => item.review_status === 'approved')
        .map((item) => item.id));
      return respond(200, {
        sources: sources.data ?? [],
        jobs: jobs.data ?? [],
        items: items.data ?? [],
        questions: (questions.data ?? []).filter((question) => activeContentSourceIds.has(question.source_id)
          && approvedItemIds.has(question.discovery_item_id)
          && (question.review_status === 'approved' || isAdmin || question.created_by === user.id)),
        restrictedQuestions,
      });
    }

    if (payload.action === 'register-source') {
      requireAdmin();
      const hosts = allowedHosts();
      if (!hosts.size) throw new Error('Configure PAPER_SOURCE_HOSTS with explicitly approved public source hosts before registering a source.');
      const listingUrl = validateSourceUrl(payload.listingUrl, hosts);
      const termsUrl = validateSourceUrl(payload.termsUrl, hosts);
      if (typeof payload.name !== 'string' || payload.name.trim().length < 1 || payload.name.trim().length > 120
        || typeof payload.rightsBasis !== 'string' || payload.rightsBasis.trim().length < 8
        || payload.metadataDiscoveryAllowed !== true
        || typeof payload.questionExtractionAllowed !== 'boolean'
        || typeof payload.questionReuseAllowed !== 'boolean'
        || (payload.questionReuseAllowed === true && payload.questionExtractionAllowed !== true)) {
        return respond(400, { error: 'Provide a source name, terms, documented rights basis, and explicit permissions. Question reuse requires extraction permission.' });
      }
      const { data, error } = await service.from('past_paper_sources').insert({
        school_id: payload.schoolId,
        created_by: user.id,
        name: payload.name.trim(),
        listing_url: canonicalizeUrl(listingUrl.href),
        canonical_host: listingUrl.hostname,
        terms_url: canonicalizeUrl(termsUrl.href),
        rights_basis: payload.rightsBasis.trim(),
        metadata_discovery_allowed: true,
        question_extraction_allowed: payload.questionExtractionAllowed,
        question_reuse_allowed: payload.questionReuseAllowed,
      }).select().single();
      if (error) throw error;
      await recordAudit(payload.schoolId, user.id, 'past_paper_source_registered', 'past_paper_sources', data.id, crypto.randomUUID());
      return respond(200, { source: data });
    }

    if (payload.action === 'discover') {
      requireAdmin();
      if (!isUuid(payload.sourceId)) return respond(400, { error: 'Select a valid source.' });
      const { data: source, error: sourceError } = await service.from('past_paper_sources')
        .select('*').eq('id', payload.sourceId).eq('school_id', payload.schoolId).maybeSingle();
      if (sourceError) throw sourceError;
      if (!source || source.status !== 'active' || !source.metadata_discovery_allowed) {
        return respond(403, { error: 'This source is unavailable or metadata discovery is not authorized.' });
      }
      const hosts = allowedHosts();
      const listingUrl = validateSourceUrl(source.listing_url, hosts);
      if (listingUrl.hostname !== source.canonical_host) throw new Error('The configured source host no longer matches its canonical host.');
      if (!isUuid(payload.idempotencyKey)) return respond(400, { error: 'Provide a valid discovery idempotency key.' });
      const { data: previousJob, error: previousJobError } = await service.from('past_paper_discovery_jobs')
        .select('id,correlation_id,status,discovered_count,failure_reason')
        .eq('school_id', payload.schoolId).eq('idempotency_key', payload.idempotencyKey).maybeSingle();
      if (previousJobError) throw previousJobError;
      if (previousJob?.status === 'completed') {
        return respond(200, {
          jobId: previousJob.id,
          correlationId: previousJob.correlation_id,
          discoveredCount: previousJob.discovered_count,
          replayed: true,
        });
      }
      if (previousJob) {
        return respond(409, {
          jobId: previousJob.id,
          correlationId: previousJob.correlation_id,
          error: previousJob.failure_reason ?? `This idempotency key already has a ${previousJob.status} job.`,
        });
      }
      if (source.last_discovery_at && Date.now() - new Date(source.last_discovery_at).getTime() < 60_000) {
        return respond(429, { error: 'Wait at least one minute between discovery requests for this source.' });
      }
      const correlationId = crypto.randomUUID();
      const { data: job, error: jobError } = await service.from('past_paper_discovery_jobs').insert({
        school_id: payload.schoolId,
        source_id: source.id,
        requested_by: user.id,
        correlation_id: correlationId,
        idempotency_key: payload.idempotencyKey,
        status: 'running',
        started_at: new Date().toISOString(),
      }).select().single();
      if (jobError?.code === '23505') return respond(429, { error: 'A discovery job is already running for this source or this request was already submitted.' });
      if (jobError) throw jobError;
      const startedAt = new Date().toISOString();
      const { error: startSourceError } = await service.from('past_paper_sources').update({
        last_discovery_at: startedAt,
        updated_at: startedAt,
      }).eq('id', source.id).eq('school_id', payload.schoolId);
      if (startSourceError) {
        const { error: failJobError } = await service.from('past_paper_discovery_jobs').update({
          status: 'failed',
          failure_reason: startSourceError.message.slice(0, 1000),
          completed_at: new Date().toISOString(),
        }).eq('id', job.id).eq('school_id', payload.schoolId);
        if (failJobError) throw new Error(`${startSourceError.message}; failed job status could not be recorded: ${failJobError.message}`);
        throw startSourceError;
      }

      try {
        const robotsUrl = new URL('/robots.txt', listingUrl);
        const { text: robotsText } = await fetchSameHost(robotsUrl, 256 * 1024, 'text/plain');
        if (!robotsAllows(robotsText, listingUrl)) throw new Error('robots.txt disallows access to this listing URL.');
        const { response, text: html } = await fetchSameHost(listingUrl, MAX_LISTING_BYTES, 'text/html', false);
        if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) {
          throw new Error('The listing URL did not return an HTML page. PDF files are not downloaded or processed by discovery.');
        }
        const discovered = parseListingLinks(html, listingUrl);
        let insertedCount = 0;
        for (const link of discovered) {
          const { data: existing, error: lookupError } = await service.from('past_paper_discovery_items')
            .select('id').eq('school_id', payload.schoolId).eq('source_id', source.id)
            .eq('canonical_url', link.url).maybeSingle();
          if (lookupError) throw lookupError;
          if (existing) continue;
          const { error: insertError } = await service.from('past_paper_discovery_items').insert({
            school_id: payload.schoolId,
            source_id: source.id,
            job_id: job.id,
            canonical_url: link.url,
            title: link.title,
            link_text: link.linkText,
          });
          if (insertError) throw insertError;
          insertedCount += 1;
        }
        const completedAt = new Date().toISOString();
        const [{ error: updateJobError }, { error: updateSourceError }] = await Promise.all([
          service.from('past_paper_discovery_jobs').update({
            status: 'completed', discovered_count: insertedCount, completed_at: completedAt,
          }).eq('id', job.id).eq('school_id', payload.schoolId),
          service.from('past_paper_sources').update({
            last_robots_check_at: completedAt, last_discovery_at: completedAt, updated_at: completedAt,
          }).eq('id', source.id).eq('school_id', payload.schoolId),
        ]);
        if (updateJobError) throw updateJobError;
        if (updateSourceError) throw updateSourceError;
        await recordAudit(payload.schoolId, user.id, 'past_paper_metadata_discovered', 'past_paper_discovery_jobs', job.id, correlationId);
        return respond(200, { jobId: job.id, correlationId, discoveredCount: insertedCount });
      } catch (discoveryError) {
        const message = discoveryError instanceof Error ? discoveryError.message : 'Source discovery failed.';
        const { error: updateError } = await service.from('past_paper_discovery_jobs').update({
          status: 'failed', failure_reason: message.slice(0, 1000), completed_at: new Date().toISOString(),
        }).eq('id', job.id).eq('school_id', payload.schoolId);
        if (updateError) throw new Error(`${message} Job status could not be recorded: ${updateError.message}`);
        throw discoveryError;
      }
    }

    if (payload.action === 'pause-source') {
      requireAdmin();
      if (!isUuid(payload.sourceId)) return respond(400, { error: 'Select a valid source.' });
      const { data: source, error: sourceError } = await service.from('past_paper_sources')
        .select('id,status').eq('id', payload.sourceId).eq('school_id', payload.schoolId).maybeSingle();
      if (sourceError) throw sourceError;
      if (!source) return respond(404, { error: 'Source was not found in this school.' });
      const { error } = await service.from('past_paper_sources').update({
        status: 'paused',
        updated_at: new Date().toISOString(),
      }).eq('id', source.id).eq('school_id', payload.schoolId);
      if (error) throw error;
      await recordAudit(payload.schoolId, user.id, 'past_paper_source_paused', 'past_paper_sources', source.id, crypto.randomUUID());
      return respond(200, { success: true });
    }

    if (payload.action === 'remove-restricted-question') {
      requireAdmin();
      if (!isUuid(payload.questionId)) return respond(400, { error: 'Select a valid restricted school question.' });
      const { data: restricted, error: restrictedError } = await service.from('past_paper_restricted_questions')
        .select('id').eq('id', payload.questionId).eq('school_id', payload.schoolId).maybeSingle();
      if (restrictedError) throw restrictedError;
      if (!restricted) return respond(404, { error: 'The question is not restricted or does not belong to this school.' });
      const { data: correlationId, error } = await service.rpc('remove_restricted_past_paper_question', {
        target_school: payload.schoolId,
        target_catalogue_question: restricted.id,
        target_actor: user.id,
      });
      if (error) throw error;
      return respond(200, { success: true, correlationId });
    }

    if (payload.action === 'review-item') {
      requireAdmin();
      if (!isUuid(payload.itemId) || !['approved', 'rejected'].includes(String(payload.decision))) {
        return respond(400, { error: 'Provide a discovered item and an approve/reject decision.' });
      }
      const { data: item, error: itemError } = await service.from('past_paper_discovery_items')
        .select('id,source_id').eq('id', payload.itemId).eq('school_id', payload.schoolId).maybeSingle();
      if (itemError) throw itemError;
      if (!item) return respond(404, { error: 'Discovered item was not found in this school.' });
      const { data: source, error: sourceError } = await service.from('past_paper_sources')
        .select('status,metadata_discovery_allowed').eq('id', item.source_id).eq('school_id', payload.schoolId).single();
      if (sourceError) throw sourceError;
      if (source.status !== 'active' || !source.metadata_discovery_allowed) {
        return respond(403, { error: 'This source is paused or metadata discovery is no longer authorized.' });
      }
      const { error } = await service.from('past_paper_discovery_items').update({
        review_status: payload.decision,
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
      }).eq('id', item.id).eq('school_id', payload.schoolId);
      if (error) throw error;
      await recordAudit(payload.schoolId, user.id, `past_paper_metadata_${payload.decision}`, 'past_paper_discovery_items', item.id, crypto.randomUUID());
      return respond(200, { success: true });
    }

    if (payload.action === 'submit-question') {
      if (!STAFF_ROLES.includes(role)) return respond(403, { error: 'School staff access is required.' });
      if (!isUuid(payload.sourceId) || !isUuid(payload.itemId)) return respond(400, { error: 'Select a valid source paper.' });
      const { data: source, error: sourceError } = await service.from('past_paper_sources')
        .select('status,question_extraction_allowed,question_reuse_allowed')
        .eq('id', payload.sourceId).eq('school_id', payload.schoolId).maybeSingle();
      if (sourceError) throw sourceError;
      if (!source || source.status !== 'active' || !source.question_extraction_allowed || !source.question_reuse_allowed) {
        return respond(403, { error: 'This source does not authorize question extraction and school reuse.' });
      }
      const { data: item, error: itemError } = await service.from('past_paper_discovery_items')
        .select('id,source_id,review_status').eq('id', payload.itemId)
        .eq('school_id', payload.schoolId).eq('source_id', payload.sourceId).maybeSingle();
      if (itemError) throw itemError;
      if (!item || item.review_status !== 'approved') return respond(400, { error: 'Approve the source metadata before submitting question content.' });
      const validated = validateQuestion(payload);
      if (validated.errors.length) return respond(400, { error: 'Question validation failed.', validationErrors: validated.errors });
      const normalized = validated.values.question_text.toLowerCase().replace(/\s+/g, ' ').trim();
      const fingerprint = await sha256(`${normalized}|${validated.values.topic.toLowerCase()}|${validated.values.marks}`);
      const { data, error } = await service.from('past_paper_catalogue_questions').insert({
        school_id: payload.schoolId,
        source_id: payload.sourceId,
        discovery_item_id: payload.itemId,
        created_by: user.id,
        ...validated.values,
        content_fingerprint: fingerprint,
      }).select().single();
      if (error?.code === '23505') return respond(409, { error: 'A question with the same text, topic, and marks is already recorded for this source.' });
      if (error) throw error;
      await recordAudit(payload.schoolId, user.id, 'past_paper_question_submitted', 'past_paper_catalogue_questions', data.id, crypto.randomUUID());
      return respond(200, { question: data });
    }

    if (payload.action === 'review-question') {
      requireAdmin();
      if (!isUuid(payload.questionId) || !['approved', 'rejected'].includes(String(payload.decision))) {
        return respond(400, { error: 'Provide a question and an approve/reject decision.' });
      }
      const { data: question, error: questionError } = await service.from('past_paper_catalogue_questions')
        .select('id,source_id,discovery_item_id')
        .eq('id', payload.questionId).eq('school_id', payload.schoolId).maybeSingle();
      if (questionError) throw questionError;
      if (!question) return respond(404, { error: 'Question was not found in this school.' });
      if (payload.decision === 'approved') {
        const [{ data: source, error: sourceError }, { data: item, error: itemError }] = await Promise.all([
          service.from('past_paper_sources').select('status,question_reuse_allowed').eq('id', question.source_id).eq('school_id', payload.schoolId).single(),
          service.from('past_paper_discovery_items').select('review_status').eq('id', question.discovery_item_id).eq('school_id', payload.schoolId).single(),
        ]);
        if (sourceError) throw sourceError;
        if (itemError) throw itemError;
        if (source.status !== 'active' || !source.question_reuse_allowed || item.review_status !== 'approved') {
          return respond(403, { error: 'Approve is blocked until source reuse permission and paper metadata are approved.' });
        }
      }
      const { error } = await service.from('past_paper_catalogue_questions').update({
        review_status: payload.decision,
        reviewer_note: typeof payload.reviewerNote === 'string' ? payload.reviewerNote.trim().slice(0, 2000) : '',
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
      }).eq('id', question.id).eq('school_id', payload.schoolId);
      if (error) throw error;
      await recordAudit(payload.schoolId, user.id, `past_paper_question_${payload.decision}`, 'past_paper_catalogue_questions', question.id, crypto.randomUUID());
      return respond(200, { success: true });
    }

    if (payload.action === 'search-approved') {
      const query = typeof payload.query === 'string'
        ? payload.query.replace(/[^\p{L}\p{N}\s-]/gu, '').trim().slice(0, 100)
        : '';
      let requestQuery = service.from('past_paper_catalogue_questions')
        .select('id,source_id,discovery_item_id,question_text,topic,subtopic,syllabus_code,marks,difficulty,mark_scheme,created_at')
        .eq('school_id', payload.schoolId).eq('review_status', 'approved')
        .order('created_at', { ascending: false }).limit(100);
      if (query) requestQuery = requestQuery.or(`question_text.ilike.%${query}%,topic.ilike.%${query}%,syllabus_code.ilike.%${query}%`);
      const { data, error } = await requestQuery;
      if (error) throw error;
      const eligible = [];
      for (const question of data ?? []) {
        const [{ data: source, error: sourceError }, { data: item, error: itemError }] = await Promise.all([
          service.from('past_paper_sources').select('name,status,question_reuse_allowed')
            .eq('id', question.source_id).eq('school_id', payload.schoolId).single(),
          service.from('past_paper_discovery_items').select('title,canonical_url,review_status')
            .eq('id', question.discovery_item_id).eq('school_id', payload.schoolId).single(),
        ]);
        if (sourceError) throw sourceError;
        if (itemError) throw itemError;
        if (source.status === 'active' && source.question_reuse_allowed && item.review_status === 'approved') {
          eligible.push({ ...question, source_name: source.name, paper_title: item.title, source_url: item.canonical_url });
        }
      }
      return respond(200, { questions: eligible });
    }

    if (payload.action === 'import-question') {
      if (!isUuid(payload.questionId)) return respond(400, { error: 'Select a valid catalogue question.' });
      const [{ data: moduleSettings, error: moduleError }, { data: question, error: questionError }] = await Promise.all([
        service.from('school_module_settings').select('module_learning').eq('school_id', payload.schoolId).maybeSingle(),
        service.from('past_paper_catalogue_questions').select('*').eq('id', payload.questionId)
          .eq('school_id', payload.schoolId).eq('review_status', 'approved').maybeSingle(),
      ]);
      if (moduleError) throw moduleError;
      if (questionError) throw questionError;
      if (!moduleSettings?.module_learning) return respond(403, { error: 'The Learning module is not enabled for this school.' });
      if (!question) return respond(404, { error: 'Approved question was not found for this school.' });
      const [{ data: source, error: sourceError }, { data: item, error: itemError }] = await Promise.all([
        service.from('past_paper_sources').select('name,status,question_reuse_allowed')
          .eq('id', question.source_id).eq('school_id', payload.schoolId).single(),
        service.from('past_paper_discovery_items').select('title,canonical_url,review_status')
          .eq('id', question.discovery_item_id).eq('school_id', payload.schoolId).single(),
      ]);
      if (sourceError) throw sourceError;
      if (itemError) throw itemError;
      if (source.status !== 'active' || !source.question_reuse_allowed || item.review_status !== 'approved') {
        return respond(403, { error: 'The question is not currently eligible for reuse.' });
      }
      const { data: existing, error: existingError } = await service.from('learning_questions')
        .select('id').eq('school_id', payload.schoolId).eq('catalogue_question_id', question.id).maybeSingle();
      if (existingError) throw existingError;
      if (existing) return respond(200, { questionId: existing.id, alreadyImported: true });
      const { data: imported, error: importError } = await service.from('learning_questions').insert({
        school_id: payload.schoolId,
        created_by: user.id,
        catalogue_question_id: question.id,
        question_text: question.question_text,
        topic: question.topic,
        subtopic: question.subtopic,
        marks: question.marks,
        difficulty: question.difficulty,
        source_name: `${source.name} · ${item.title}`,
        source_url: item.canonical_url,
        mark_scheme: question.mark_scheme,
      }).select('id').single();
      if (importError?.code === '23505') {
        const { data: raced, error: raceError } = await service.from('learning_questions')
          .select('id').eq('school_id', payload.schoolId).eq('catalogue_question_id', question.id).maybeSingle();
        if (raceError) throw raceError;
        if (raced) return respond(200, { questionId: raced.id, alreadyImported: true });
      }
      if (importError) throw importError;
      await recordAudit(payload.schoolId, user.id, 'past_paper_question_imported', 'learning_questions', imported.id, crypto.randomUUID());
      return respond(200, { questionId: imported.id, alreadyImported: false });
    }

    return respond(400, { error: 'Unknown past-paper pipeline action.' });
  } catch (error) {
    if (error instanceof Response) return respond(error.status, { error: await error.text() });
    console.error('Past-paper pipeline request failed.', error);
    return respond(500, { error: error instanceof Error ? error.message : 'Past-paper pipeline request failed.' });
  }
});
