import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-api-version, x-paper-worker-secret',
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
  documentDownloadAllowed?: unknown;
  documentStorageAllowed?: unknown;
  ocrAllowed?: unknown;
  curriculum?: unknown;
  subjectName?: unknown;
  syllabusVersion?: unknown;
  scheduleEnabled?: unknown;
  scheduleIntervalHours?: unknown;
  documentMaxBytes?: unknown;
  documentPath?: unknown;
  extractionPath?: unknown;
  sha256?: unknown;
  fileSize?: unknown;
  pageCount?: unknown;
  canonicalUrl?: unknown;
  contentType?: unknown;
  failureReason?: unknown;
  retryable?: unknown;
  syllabusTopicId?: unknown;
  contentUseEligible?: unknown;
  questionNumber?: unknown;
  pageStart?: unknown;
  pageEnd?: unknown;
  classificationStatus?: unknown;
  validationStatus?: unknown;
  filters?: unknown;
  corrections?: unknown;
  syllabusTopic?: unknown;
  sourceUrl?: unknown;
  approvedPhrases?: unknown;
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

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (isRecord(error) && typeof error.message === 'string') {
    const code = typeof error.code === 'string' ? ` (${error.code})` : '';
    return `${error.message}${code}`;
  }
  return 'Past-paper pipeline request failed.';
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

function workerSecretMatches(actual: string | null, expected: string) {
  if (!actual || expected.length < 32 || actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function paperMetadata(title: string, source: Record<string, unknown>) {
  const years = [...title.matchAll(/\b(?:19|20)\d{2}\b/g)].map((match) => Number(match[0]));
  const year = [...new Set(years)].length === 1 ? years[0] : null;
  const monthTitle = title.toLowerCase();
  const sessionMatches = [
    ...( /\b(?:feb(?:ruary)?|mar(?:ch)?)\b/i.test(monthTitle) ? ['m'] : []),
    ...( /\b(?:may|jun(?:e)?)\b/i.test(monthTitle) ? ['s'] : []),
    ...( /\b(?:oct(?:ober)?|nov(?:ember)?)\b/i.test(monthTitle) ? ['w'] : []),
  ];
  const sessions = [...new Set(sessionMatches)];
  const paperMatches = [...title.matchAll(/\bpaper\s*[-:]?\s*(\d{1,2})\b/gi)].map((match) => match[1]);
  const variants = [...title.matchAll(/\bvariant\s*[-:]?\s*(\d{1,2})\b/gi)].map((match) => match[1]);
  return {
    curriculum: source.curriculum ?? null,
    subject_name: source.subject_name ?? null,
    syllabus_code: source.syllabus_code ?? null,
    syllabus_version: source.syllabus_version ?? null,
    examination_year: year,
    examination_session: sessions.length === 1 ? sessions[0] : null,
    paper_number: [...new Set(paperMatches)].length === 1 ? paperMatches[0] : null,
    variant: [...new Set(variants)].length === 1 ? variants[0] : null,
  };
}

function normalizeQuestionText(value: string) {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function validateExtractedQuestion(question: Record<string, unknown>, item: Record<string, unknown>) {
  const reasons: string[] = [];
  for (const [field, label] of [
    ['curriculum', 'Curriculum'],
    ['subject_name', 'Subject'],
    ['syllabus_code', 'Syllabus code'],
    ['examination_year', 'Examination year'],
    ['examination_session', 'Examination session'],
    ['paper_number', 'Paper number'],
    ['variant', 'Variant'],
  ] as const) {
    if (!item[field]) reasons.push(`${label} is missing or ambiguous.`);
  }
  if (!question.question_number) reasons.push('Question number could not be segmented.');
  if (!Number.isFinite(Number(question.marks)) || Number(question.marks) <= 0) reasons.push('Marks are missing or invalid.');
  if (question.extraction_status !== 'COMPLETE') reasons.push('Question extraction is incomplete.');
  if (question.classification_status !== 'CLASSIFIED' || !question.syllabus_topic_id) {
    reasons.push('Syllabus topic classification needs human review.');
  }
  return reasons;
}

async function sha256Bytes(value: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', value);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function handleWorkerAction(payload: PipelineRequest, service: any) {
  if (payload.action === 'scheduled-discover') {
    const hosts = allowedHosts();
    const { data: sources, error } = await service.from('past_paper_sources').select('*')
      .eq('status', 'active').eq('schedule_enabled', true).eq('metadata_discovery_allowed', true)
      .lte('next_discovery_at', new Date().toISOString()).order('next_discovery_at').limit(5);
    if (error) throw error;
    const results: Array<{ sourceId: string; discoveredCount: number; error?: string }> = [];
    for (const source of sources ?? []) {
      let scheduledJobId: string | null = null;
      try {
        const listingUrl = validateSourceUrl(source.listing_url, hosts);
        if (listingUrl.hostname !== source.canonical_host) throw new Error('Configured source host no longer matches.');
        const idempotencyKey = crypto.randomUUID();
        const correlationId = crypto.randomUUID();
        const { data: job, error: jobError } = await service.from('past_paper_discovery_jobs').insert({
          school_id: source.school_id,
          source_id: source.id,
          requested_by: source.created_by,
          correlation_id: correlationId,
          idempotency_key: idempotencyKey,
          status: 'running',
          started_at: new Date().toISOString(),
        }).select('id').single();
        if (jobError) throw jobError;
        scheduledJobId = job.id;
        const robotsUrl = new URL('/robots.txt', listingUrl);
        const { text: robotsText } = await fetchSameHost(robotsUrl, 256 * 1024, 'text/plain');
        if (!robotsAllows(robotsText, listingUrl)) throw new Error('robots.txt disallows the listing URL.');
        const { response, text: html } = await fetchSameHost(listingUrl, MAX_LISTING_BYTES, 'text/html', false);
        if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) {
          throw new Error('The configured listing did not return HTML.');
        }
        const links = parseListingLinks(html, listingUrl);
        let insertedCount = 0;
        for (const link of links) {
          const { data: existing, error: existingError } = await service.from('past_paper_discovery_items')
            .select('id,pipeline_status').eq('school_id', source.school_id).eq('source_id', source.id)
            .eq('canonical_url', link.url).maybeSingle();
          if (existingError) throw existingError;
          if (existing) {
            if (existing.pipeline_status === 'PERMISSION_BLOCKED' && source.document_download_allowed
              && source.document_storage_allowed && source.question_extraction_allowed) {
              const { error: requeueError } = await service.from('past_paper_discovery_items').update({
                pipeline_status: 'DISCOVERED', failure_reason: null, updated_at: new Date().toISOString(),
              }).eq('id', existing.id);
              if (requeueError) throw requeueError;
            }
            continue;
          }
          const { data: crossSourceMatch, error: crossSourceError } = await service.from('past_paper_discovery_items')
            .select('id').eq('school_id', source.school_id).eq('canonical_url', link.url)
            .neq('pipeline_status', 'DUPLICATE').limit(1).maybeSingle();
          if (crossSourceError) throw crossSourceError;
          const metadata = paperMetadata(link.title, source);
          const pipelineStatus = crossSourceMatch ? 'DUPLICATE'
            : !source.document_download_allowed || !source.document_storage_allowed
            || !source.question_extraction_allowed ? 'PERMISSION_BLOCKED' : 'DISCOVERED';
          const { error: insertError } = await service.from('past_paper_discovery_items').insert({
            school_id: source.school_id,
            source_id: source.id,
            job_id: job.id,
            canonical_url: link.url,
            original_url: link.url,
            title: link.title,
            link_text: link.linkText,
            ...metadata,
            pipeline_status: pipelineStatus,
            duplicate_item_id: crossSourceMatch?.id ?? null,
            failure_reason: crossSourceMatch
              ? 'Canonical source URL is already registered for another source in this school.'
              : pipelineStatus === 'PERMISSION_BLOCKED'
                ? 'The source permissions do not authorize download, private storage, and question extraction.' : null,
          });
          if (insertError) throw insertError;
          insertedCount += 1;
        }
        const completedAt = new Date().toISOString();
        const [{ error: jobUpdateError }, { error: sourceUpdateError }] = await Promise.all([
          service.from('past_paper_discovery_jobs').update({
            status: 'completed', discovered_count: insertedCount, completed_at: completedAt,
          }).eq('id', job.id),
          service.from('past_paper_sources').update({
            last_robots_check_at: completedAt,
            last_discovery_at: completedAt,
            next_discovery_at: new Date(Date.now() + source.schedule_interval_hours * 60 * 60 * 1000).toISOString(),
            updated_at: completedAt,
          }).eq('id', source.id),
        ]);
        if (jobUpdateError) throw jobUpdateError;
        if (sourceUpdateError) throw sourceUpdateError;
        results.push({ sourceId: source.id, discoveredCount: insertedCount });
      } catch (discoveryError) {
        const message = discoveryError instanceof Error ? discoveryError.message : 'Scheduled discovery failed.';
        const updateResults = await Promise.all([
          service.from('past_paper_sources').update({
            next_discovery_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            updated_at: new Date().toISOString(),
          }).eq('id', source.id),
          ...(scheduledJobId ? [service.from('past_paper_discovery_jobs').update({
            status: 'failed',
            failure_reason: message.slice(0, 1000),
            completed_at: new Date().toISOString(),
          }).eq('id', scheduledJobId)] : []),
        ]);
        for (const result of updateResults) if (result.error) throw result.error;
        results.push({ sourceId: source.id, discoveredCount: 0, error: message });
      }
    }
    return respond(200, { scheduledSources: results });
  }

  if (payload.action === 'worker-claim') {
    const { data: item, error } = await service.rpc('claim_past_paper_discovery_item');
    if (error) throw error;
    if (!item) return respond(200, { task: null });
    const itemRecord = item as Record<string, unknown>;
    const documentPath = itemRecord.document_path;
    const extractionPath = itemRecord.extraction_path;
    if (typeof documentPath !== 'string' || typeof extractionPath !== 'string') {
      throw new Error('The claimed document paths were not returned.');
    }
    const [{ data: pdfUpload, error: pdfError }, { data: extractionUpload, error: extractionError }] = await Promise.all([
      service.storage.from('past-paper-documents').createSignedUploadUrl(documentPath),
      service.storage.from('past-paper-documents').createSignedUploadUrl(extractionPath),
    ]);
    if (pdfError || extractionError) {
      const { error: releaseError } = await service.rpc('release_past_paper_discovery_item', {
        target_item: itemRecord.id, failure: pdfError?.message ?? extractionError?.message ?? 'Could not create secure upload URLs.',
        can_retry: true,
      });
      if (releaseError) throw new Error(`${pdfError?.message ?? extractionError?.message}; job release failed: ${releaseError.message}`);
      throw pdfError ?? extractionError;
    }
    const syllabusTopics: Record<string, unknown>[] = [];
    if (itemRecord.curriculum && itemRecord.subject_name && itemRecord.syllabus_code && itemRecord.syllabus_version) {
      const { data: topics, error: topicError } = await service.from('past_paper_syllabus_topics')
        .select('id,curriculum,subject_name,syllabus_code,syllabus_version,topic,subtopic,approved_phrases')
        .eq('curriculum', itemRecord.curriculum).eq('subject_name', itemRecord.subject_name)
        .eq('syllabus_code', itemRecord.syllabus_code).eq('syllabus_version', itemRecord.syllabus_version);
      if (topicError) throw topicError;
      syllabusTopics.push(...(topics ?? []));
    }
    return respond(200, {
      task: {
        item: itemRecord,
        source: itemRecord,
        documentPath,
        extractionPath,
        documentUploadUrl: pdfUpload.signedUrl,
        extractionUploadUrl: extractionUpload.signedUrl,
        syllabusTopics,
      },
    });
  }

  if (payload.action === 'worker-fail') {
    if (!isUuid(payload.itemId) || typeof payload.failureReason !== 'string'
      || typeof payload.documentPath !== 'string' || typeof payload.extractionPath !== 'string') {
      return respond(400, { error: 'Worker failure report is incomplete.' });
    }
    const { data: item, error: itemError } = await service.from('past_paper_discovery_items')
      .select('school_id,lease_document_path,lease_extraction_path,lease_expires_at')
      .eq('id', payload.itemId).maybeSingle();
    if (itemError) throw itemError;
    if (!item) return respond(404, { error: 'The claimed paper item was not found.' });
    if (item.lease_document_path !== payload.documentPath || item.lease_extraction_path !== payload.extractionPath
      || !item.lease_expires_at || new Date(item.lease_expires_at).getTime() <= Date.now()) {
      return respond(409, { error: 'The worker lease expired; stale failure reports cannot change the job.' });
    }
    const { error: deleteDocumentsError } = await service.from('past_paper_documents')
      .delete().eq('school_id', item.school_id).eq('discovery_item_id', payload.itemId)
      .eq('storage_path', payload.documentPath).eq('extraction_storage_path', payload.extractionPath);
    if (deleteDocumentsError) throw deleteDocumentsError;
    const { error: removeError } = await service.storage.from('past-paper-documents')
      .remove([payload.documentPath, payload.extractionPath]);
    if (removeError) {
      const { error: releaseError } = await service.rpc('release_past_paper_discovery_item', {
        target_item: payload.itemId, failure: `Could not remove partial private uploads: ${removeError.message}`,
        can_retry: true,
      });
      if (releaseError) throw releaseError;
      throw removeError;
    }
    const { error } = await service.rpc('release_past_paper_discovery_item', {
      target_item: payload.itemId,
      failure: payload.failureReason.slice(0, 1000),
      can_retry: payload.retryable !== false,
    });
    if (error) throw error;
    return respond(200, { success: true });
  }

  if (payload.action === 'worker-downloaded') {
    if (!isUuid(payload.itemId) || typeof payload.sha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(payload.sha256) || typeof payload.documentPath !== 'string'
      || typeof payload.canonicalUrl !== 'string' || !Number.isInteger(payload.fileSize)
      || Number(payload.fileSize) <= 0 || Number(payload.fileSize) > 50 * 1024 * 1024) {
      return respond(400, { error: 'Downloaded document metadata is invalid.' });
    }
    const { data: item, error: itemError } = await service.from('past_paper_discovery_items')
      .select('*,past_paper_sources(*)').eq('id', payload.itemId).maybeSingle();
    if (itemError) throw itemError;
    if (!item || !item.lease_expires_at || new Date(item.lease_expires_at).getTime() <= Date.now()) {
      return respond(409, { error: 'The worker lease expired or item was not found.' });
    }
    if (item.lease_document_path !== payload.documentPath
      || !payload.documentPath.startsWith(`${item.school_id}/${item.id}/`)) {
      return respond(403, { error: 'The uploaded path does not match the active item lease.' });
    }
    const source = item.past_paper_sources as Record<string, unknown>;
    if (!source || source.status !== 'active' || !source.document_download_allowed
      || !source.document_storage_allowed || !source.question_extraction_allowed
      || Number(payload.fileSize) > Number(source.document_max_bytes)) {
      return respond(403, { error: 'Current source permissions or file-size limit reject this document.' });
    }
    const { data: file, error: fileError } = await service.storage.from('past-paper-documents').download(payload.documentPath);
    if (fileError) throw fileError;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength !== Number(payload.fileSize)
      || !new TextDecoder().decode(bytes.slice(0, 5)).startsWith('%PDF-')
      || await sha256Bytes(bytes) !== payload.sha256) {
      await service.storage.from('past-paper-documents').remove([payload.documentPath]);
      return respond(400, { error: 'Stored PDF signature, size, or SHA-256 checksum did not validate.' });
    }
    const { data: duplicate, error: duplicateError } = await service.from('past_paper_documents')
      .select('id').eq('school_id', item.school_id).eq('sha256', payload.sha256).maybeSingle();
    if (duplicateError) throw duplicateError;
    if (duplicate) {
      await service.storage.from('past-paper-documents').remove([payload.documentPath]);
      const { error: duplicateUpdateError } = await service.from('past_paper_discovery_items').update({
        pipeline_status: 'DUPLICATE',
        duplicate_document_id: duplicate.id,
        document_sha256: payload.sha256,
        failure_reason: 'This document checksum already exists in this school.',
        lease_expires_at: null,
        lease_document_path: null,
        lease_extraction_path: null,
        next_retry_at: null,
        updated_at: new Date().toISOString(),
      }).eq('id', item.id);
      if (duplicateUpdateError) throw duplicateUpdateError;
      return respond(200, { status: 'DUPLICATE', duplicateDocumentId: duplicate.id });
    }
    const { error: statusError } = await service.from('past_paper_discovery_items').update({
      pipeline_status: 'DOWNLOADED',
      document_sha256: payload.sha256,
      failure_reason: null,
      updated_at: new Date().toISOString(),
    }).eq('id', item.id);
    if (statusError) throw statusError;
    return respond(200, { status: 'DOWNLOADED' });
  }

  if (payload.action === 'worker-complete') {
    if (!isUuid(payload.itemId) || typeof payload.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(payload.sha256)
      || typeof payload.documentPath !== 'string' || typeof payload.extractionPath !== 'string'
      || typeof payload.canonicalUrl !== 'string' || payload.contentType !== 'application/pdf'
      || !Number.isInteger(payload.fileSize) || !Number.isInteger(payload.pageCount)
      || Number(payload.fileSize) <= 0 || Number(payload.fileSize) > 50 * 1024 * 1024
      || Number(payload.pageCount) < 1 || Number(payload.pageCount) > 100) {
      return respond(400, { error: 'Worker document metadata is invalid.' });
    }
    const { data: item, error: itemError } = await service.from('past_paper_discovery_items')
      .select('*,past_paper_sources(*)').eq('id', payload.itemId).maybeSingle();
    if (itemError) throw itemError;
    if (!item || !item.lease_expires_at || new Date(item.lease_expires_at).getTime() <= Date.now()) {
      return respond(409, { error: 'The worker lease expired or item was not found.' });
    }
    if (item.lease_document_path !== payload.documentPath || item.lease_extraction_path !== payload.extractionPath
      || !payload.documentPath.startsWith(`${item.school_id}/${item.id}/`)
      || !payload.extractionPath.startsWith(`${item.school_id}/${item.id}/`)) {
      return respond(403, { error: 'The upload paths do not match the active item lease.' });
    }
    const source = item.past_paper_sources as Record<string, unknown>;
    if (!source || source.status !== 'active' || source.document_download_allowed !== true
      || source.document_storage_allowed !== true || source.question_extraction_allowed !== true) {
      return respond(403, { error: 'Current source permissions do not authorize processing this document.' });
    }
    const [{ data: pdf, error: pdfError }, { data: extraction, error: extractionError }] = await Promise.all([
      service.storage.from('past-paper-documents').download(payload.documentPath),
      service.storage.from('past-paper-documents').download(payload.extractionPath),
    ]);
    if (pdfError) throw pdfError;
    if (extractionError) throw extractionError;
    const pdfBytes = new Uint8Array(await pdf.arrayBuffer());
    if (!new TextDecoder().decode(pdfBytes.slice(0, 5)).startsWith('%PDF-')
      || pdfBytes.byteLength !== Number(payload.fileSize)
      || await sha256Bytes(pdfBytes) !== payload.sha256) {
      await service.storage.from('past-paper-documents').remove([payload.documentPath, payload.extractionPath]);
      return respond(400, { error: 'Stored PDF signature, size, or SHA-256 checksum did not validate.' });
    }
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(await extraction.text());
    } catch {
      return respond(400, { error: 'Worker extraction manifest is not valid JSON.' });
    }
    if (!Array.isArray(manifest.pages) || !Array.isArray(manifest.questions)
      || manifest.pages.length !== Number(payload.pageCount) || manifest.pages.length > 100
      || manifest.pages.some((page) => !isRecord(page) || !Number.isInteger(page.page_number)
        || !Array.isArray(page.tables) || !Array.isArray(page.diagram_references) || !Array.isArray(page.instructions)
        || typeof page.text_content !== 'string')) {
      return respond(400, { error: 'Worker extraction manifest has an invalid page structure.' });
    }
    const { data: duplicate, error: duplicateError } = await service.from('past_paper_documents')
      .select('id').eq('school_id', item.school_id).eq('sha256', payload.sha256).maybeSingle();
    if (duplicateError) throw duplicateError;
    if (duplicate) {
      await service.storage.from('past-paper-documents').remove([payload.documentPath, payload.extractionPath]);
      const { error: duplicateUpdateError } = await service.from('past_paper_discovery_items').update({
        pipeline_status: 'DUPLICATE',
        duplicate_document_id: duplicate.id,
        document_sha256: payload.sha256,
        failure_reason: 'This document checksum already exists in this school.',
        lease_expires_at: null,
        lease_document_path: null,
        lease_extraction_path: null,
        next_retry_at: null,
        updated_at: new Date().toISOString(),
      }).eq('id', item.id);
      if (duplicateUpdateError) throw duplicateUpdateError;
      return respond(200, { status: 'DUPLICATE', duplicateDocumentId: duplicate.id });
    }

    const documentId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const { error: documentError } = await service.from('past_paper_documents').insert({
      id: documentId,
      school_id: item.school_id,
      source_id: item.source_id,
      discovery_item_id: item.id,
      original_url: item.original_url ?? item.canonical_url,
      canonical_url: payload.canonicalUrl,
      storage_path: payload.documentPath,
      extraction_storage_path: payload.extractionPath,
      sha256: payload.sha256,
      file_size: payload.fileSize,
      content_type: 'application/pdf',
      page_count: payload.pageCount,
      extraction_status: 'completed',
    });
    if (documentError) throw documentError;

    const pages = manifest.pages as Record<string, unknown>[];
    const questionRows = manifest.questions as Record<string, unknown>[];
    const { error: pageError } = await service.from('past_paper_document_pages').insert(pages.map((page) => ({
      school_id: item.school_id,
      document_id: documentId,
      page_number: page.page_number,
      text_content: String(page.text_content).slice(0, 60_000),
      tables: page.tables,
      diagram_references: page.diagram_references,
      instructions: page.instructions.filter((instruction): instruction is string => typeof instruction === 'string').slice(0, 30),
      extraction_method: ['pdf-text', 'ocr', 'mixed', 'empty'].includes(String(page.extraction_method))
        ? page.extraction_method : 'empty',
      ocr_confidence: Number.isFinite(Number(page.ocr_confidence)) ? page.ocr_confidence : null,
      needs_review: page.needs_review === true,
    })));
    if (pageError) throw pageError;
    const { error: extractedStatusError } = await service.from('past_paper_discovery_items').update({
      pipeline_status: 'EXTRACTED',
      updated_at: new Date().toISOString(),
    }).eq('id', item.id);
    if (extractedStatusError) throw extractedStatusError;
    const { error: validatingStatusError } = await service.from('past_paper_discovery_items').update({
      pipeline_status: 'VALIDATING',
      updated_at: new Date().toISOString(),
    }).eq('id', item.id);
    if (validatingStatusError) throw validatingStatusError;

    const itemMetadata = {
      curriculum: item.curriculum,
      subject_name: item.subject_name,
      syllabus_code: item.syllabus_code,
      examination_year: item.examination_year,
      examination_session: item.examination_session,
      paper_number: item.paper_number,
      variant: item.variant,
    } as Record<string, unknown>;
    const parentQuestionIds = new Map<string, string>();
    let savedQuestionCount = 0;
    for (const rawQuestion of questionRows.slice(0, 1000)) {
      if (!isRecord(rawQuestion) || typeof rawQuestion.question_text !== 'string'
        || rawQuestion.question_text.trim().length < 10 || rawQuestion.question_text.length > 12000) continue;
      const questionText = rawQuestion.question_text.trim();
      const questionNumber = typeof rawQuestion.question_number === 'string' ? rawQuestion.question_number : null;
      const parentNumber = typeof rawQuestion.parent_number === 'string' ? rawQuestion.parent_number : null;
      const marks = Number.isFinite(Number(rawQuestion.marks)) && Number(rawQuestion.marks) > 0
        ? Number(rawQuestion.marks) : null;
      const classification = {
        syllabus_topic_id: isUuid(rawQuestion.syllabus_topic_id) ? rawQuestion.syllabus_topic_id : null,
        classification_status: rawQuestion.classification_status === 'CLASSIFIED'
          && isUuid(rawQuestion.syllabus_topic_id) ? 'CLASSIFIED' : 'NEEDS_REVIEW',
        classification_confidence: Number.isFinite(Number(rawQuestion.classification_confidence))
          ? Number(rawQuestion.classification_confidence) : null,
        topic: typeof rawQuestion.topic === 'string' ? rawQuestion.topic : null,
        subtopic: typeof rawQuestion.subtopic === 'string' ? rawQuestion.subtopic : '',
      };
      const candidate = {
        ...rawQuestion,
        ...classification,
        question_number: questionNumber,
        marks,
        extraction_status: ['COMPLETE', 'NEEDS_REVIEW', 'INCOMPLETE'].includes(String(rawQuestion.extraction_status))
          ? rawQuestion.extraction_status : 'INCOMPLETE',
      };
      const reasons = validateExtractedQuestion(candidate, itemMetadata);
      if (Array.isArray(rawQuestion.diagram_references)
        && rawQuestion.diagram_references.some((reference) => !String(reference).startsWith('page:'))) {
        reasons.push('Diagram references need review.');
      }
      const normalized = normalizeQuestionText(questionText);
      const fingerprint = await sha256(
        `${normalized}|${item.syllabus_code ?? ''}|${item.syllabus_version ?? ''}|${item.examination_year ?? ''}|${item.examination_session ?? ''}|${item.paper_number ?? ''}|${item.variant ?? ''}|${questionNumber ?? ''}|${marks ?? ''}`,
      );
      const { data: prior, error: priorError } = await service.from('past_paper_catalogue_questions')
        .select('id').eq('school_id', item.school_id).eq('content_fingerprint', fingerprint).limit(1).maybeSingle();
      if (priorError) throw priorError;
      const parentId = questionNumber !== parentNumber && parentNumber
        ? parentQuestionIds.get(parentNumber) ?? null : null;
      const validationStatus = prior ? 'DUPLICATE' : reasons.length ? 'NEEDS_REVIEW' : 'VALIDATING';
      const { data: saved, error: questionError } = await service.from('past_paper_catalogue_questions').insert({
        school_id: item.school_id,
        source_id: item.source_id,
        discovery_item_id: item.id,
        document_id: documentId,
        parent_question_id: parentId,
        created_by: source.created_by,
        question_text: questionText,
        topic: classification.topic,
        subtopic: classification.subtopic,
        syllabus_code: item.syllabus_code ?? '',
        marks,
        difficulty: 'Standard',
        mark_scheme: '',
        subject_name: item.subject_name,
        examination_year: item.examination_year,
        examination_session: item.examination_session,
        paper_number: item.paper_number,
        variant: item.variant,
        content_fingerprint: prior ? await sha256(`${fingerprint}|${item.id}`) : fingerprint,
        review_status: 'pending',
        question_number: questionNumber,
        page_start: Number.isInteger(rawQuestion.page_start) ? rawQuestion.page_start : null,
        page_end: Number.isInteger(rawQuestion.page_end) ? rawQuestion.page_end : null,
        curriculum: item.curriculum,
        syllabus_version: item.syllabus_version,
        syllabus_topic_id: classification.syllabus_topic_id,
        classification_confidence: classification.classification_confidence,
        classification_status: classification.classification_status,
        extraction_status: candidate.extraction_status,
        content_use_status: source.question_reuse_allowed === true ? 'NOT_REVIEWED' : 'BLOCKED',
        validation_status: validationStatus,
        question_structure: isRecord(rawQuestion.question_structure) ? rawQuestion.question_structure : {},
        duplicate_of: prior?.id ?? null,
        similarity_score: prior ? 100 : null,
        validation_reasons: prior ? ['Exact question text and paper metadata duplicate an existing question.'] : reasons,
        diagram_references: Array.isArray(rawQuestion.diagram_references) ? rawQuestion.diagram_references : [],
        validation_correlation_id: correlationId,
      }).select('id').single();
      if (questionError) throw questionError;
      if (questionNumber === parentNumber && parentNumber) parentQuestionIds.set(parentNumber, saved.id);
      const { error: eventError } = await service.from('past_paper_validation_events').insert({
        school_id: item.school_id,
        catalogue_question_id: saved.id,
        correlation_id: correlationId,
        status: validationStatus,
        reasons: prior ? ['Exact question text and paper metadata duplicate an existing question.'] : reasons,
        details: { document_id: documentId, page_start: rawQuestion.page_start, page_end: rawQuestion.page_end },
      });
      if (eventError) throw eventError;
      savedQuestionCount += 1;
    }
    const itemStatus = 'NEEDS_REVIEW';
    const { error: itemUpdateError } = await service.from('past_paper_discovery_items').update({
      pipeline_status: itemStatus,
      document_sha256: payload.sha256,
      failure_reason: savedQuestionCount ? null : 'No complete numbered questions could be extracted.',
      lease_expires_at: null,
      lease_document_path: null,
      lease_extraction_path: null,
      next_retry_at: null,
      updated_at: new Date().toISOString(),
    }).eq('id', item.id);
    if (itemUpdateError) throw itemUpdateError;
    return respond(200, { status: itemStatus, documentId, pageCount: pages.length, questionCount: savedQuestionCount, correlationId });
  }

  return respond(400, { error: 'Unknown worker action.' });
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
    if (url.origin !== listingUrl.origin || !/^https:$/.test(url.protocol)
      || [...url.searchParams.keys()].some((key) => /token|key|auth|secret|signature|session|password|credential/i.test(key))) continue;
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
      curriculum: correctedItem.curriculum,
      subject_name: correctedItem.subject_name,
      syllabus_version: correctedItem.syllabus_version,
      examination_year: correctedItem.examination_year,
      examination_session: correctedItem.examination_session,
      paper_number: correctedItem.paper_number,
      variant: correctedItem.variant,
      difficulty: String(difficulty),
      mark_scheme: markScheme,
    },
  };
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return respond(405, { error: 'Method not allowed.' });

  try {
    const bodyText = await request.text();
    if (bodyText.length > 2 * 1024 * 1024) return respond(413, { error: 'Pipeline request exceeds the 2 MB limit.' });
    const payload = JSON.parse(bodyText) as PipelineRequest;
    if (!isRecord(payload) || typeof payload.action !== 'string') {
      return respond(400, { error: 'Provide a pipeline action.' });
    }
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !anonKey || !serviceRoleKey) throw new Error('Past-paper pipeline configuration is incomplete.');
    const service = createClient<any>(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    if (request.headers.has('x-paper-worker-secret')) {
      const expectedSecret = Deno.env.get('PAPER_PIPELINE_WORKER_SECRET') ?? '';
      if (!workerSecretMatches(request.headers.get('x-paper-worker-secret'), expectedSecret)) {
        return respond(401, { error: 'Invalid pipeline worker credentials.' });
      }
      return await handleWorkerAction(payload, service);
    }
    const accessToken = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!accessToken) return respond(401, { error: 'Sign in to use the past-paper pipeline.' });
    const userClient = createClient<any>(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser(accessToken);
    if (authError || !user) return respond(401, { error: 'Your session is invalid. Sign in again.' });
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
      'list-syllabus': 'view',
      'upsert-syllabus-topic': 'edit',
      'preview-document': 'view',
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
      requireAdmin();
      const [sources, jobs, items, questions, syllabusTopics] = await Promise.all([
        service.from('past_paper_sources').select('*').eq('school_id', payload.schoolId).order('created_at', { ascending: false }),
        service.from('past_paper_discovery_jobs').select('*').eq('school_id', payload.schoolId).order('created_at', { ascending: false }).limit(50),
        service.from('past_paper_discovery_items').select('*').eq('school_id', payload.schoolId).order('created_at', { ascending: false }).limit(200),
        service.from('past_paper_catalogue_questions').select('*').eq('school_id', payload.schoolId)
          .order('created_at', { ascending: false }).limit(200),
        service.from('past_paper_syllabus_topics').select('*')
          .order('curriculum').order('subject_name').order('syllabus_code').order('topic').limit(1000),
      ]);
      for (const result of [sources, jobs, items, questions, syllabusTopics]) if (result.error) throw result.error;
      let restrictedQuestions: Array<Record<string, unknown>> = [];
      if (isAdmin) {
        const { data, error } = await service.from('past_paper_restricted_questions')
          .select('id,learning_question_id,question_text,source_name,registered_source_name,source_status,question_reuse_allowed,catalogue_review_status,item_review_status')
          .eq('school_id', payload.schoolId).order('source_name').limit(200);
        if (error) throw error;
        restrictedQuestions = data ?? [];
      }
      const activeContentSourceIds = new Set((sources.data ?? [])
        .filter((source) => source.status === 'active' && source.question_extraction_allowed)
        .map((source) => source.id));
      const approvedItemIds = new Set((items.data ?? [])
        .filter((item) => item.review_status === 'approved')
        .map((item) => item.id));
      return respond(200, {
        sources: sources.data ?? [],
        jobs: jobs.data ?? [],
        items: items.data ?? [],
        questions: (questions.data ?? []).filter((question) => isAdmin || (activeContentSourceIds.has(question.source_id)
          && approvedItemIds.has(question.discovery_item_id)
          && question.validation_status === 'APPROVED'
          && question.content_use_status === 'ELIGIBLE'
          && question.review_status === 'approved')),
        restrictedQuestions,
        syllabusTopics: syllabusTopics.data ?? [],
      });
    }

    if (payload.action === 'preview-document') {
      requireAdmin();
      if (!isUuid(payload.itemId)) return respond(400, { error: 'Select a valid discovered paper.' });
      const { data: document, error: documentError } = await service.from('past_paper_documents')
        .select('storage_path,source_id')
        .eq('school_id', payload.schoolId).eq('discovery_item_id', payload.itemId).maybeSingle();
      if (documentError) throw documentError;
      if (!document) return respond(404, { error: 'The private source document is not available.' });
      const { data: source, error: sourceError } = await service.from('past_paper_sources')
        .select('status,document_storage_allowed')
        .eq('school_id', payload.schoolId).eq('id', document.source_id).maybeSingle();
      if (sourceError) throw sourceError;
      if (!source || source.status !== 'active' || !source.document_storage_allowed) {
        return respond(403, { error: 'Current permissions do not authorize viewing this stored document.' });
      }
      const { data, error } = await service.storage.from('past-paper-documents')
        .createSignedUrl(document.storage_path, 60, { download: 'source-paper.pdf' });
      if (error) throw error;
      return respond(200, { url: data.signedUrl });
    }

    if (payload.action === 'list-syllabus') {
      const { data, error } = await service.from('past_paper_syllabus_topics')
        .select('*').order('curriculum').order('subject_name').order('syllabus_code').order('topic').limit(1000);
      if (error) throw error;
      return respond(200, { syllabusTopics: data ?? [] });
    }

    if (payload.action === 'upsert-syllabus-topic') {
      requireAdmin();
      const topic = isRecord(payload.syllabusTopic) ? payload.syllabusTopic : null;
      if (!topic || !['Cambridge Primary', 'Cambridge Lower Secondary', 'O Level', 'IGCSE', 'AS Level', 'A Level'].includes(String(topic.curriculum))
        || typeof topic.subjectName !== 'string' || !topic.subjectName.trim() || topic.subjectName.length > 160
        || typeof topic.syllabusCode !== 'string' || !topic.syllabusCode.trim() || topic.syllabusCode.length > 40
        || typeof topic.syllabusVersion !== 'string' || !topic.syllabusVersion.trim() || topic.syllabusVersion.length > 80
        || typeof topic.topic !== 'string' || !topic.topic.trim() || topic.topic.length > 200
        || typeof topic.subtopic !== 'string' || topic.subtopic.length > 200
        || typeof topic.sourceUrl !== 'string') {
        return respond(400, { error: 'Provide complete curriculum, subject, syllabus, topic, and verification-source metadata.' });
      }
      const sourceUrl = new URL(topic.sourceUrl);
      if (sourceUrl.protocol !== 'https:' || sourceUrl.username || sourceUrl.password || sourceUrl.port) {
        return respond(400, { error: 'Syllabus verification references must be public HTTPS URLs.' });
      }
      const approvedPhrases = Array.isArray(topic.approvedPhrases)
        ? topic.approvedPhrases.filter((phrase): phrase is string => typeof phrase === 'string')
          .map((phrase) => phrase.trim()).filter(Boolean).slice(0, 50)
        : [];
      if (Array.isArray(topic.approvedPhrases) && approvedPhrases.length !== topic.approvedPhrases.length) {
        return respond(400, { error: 'Approved classification phrases must all be non-empty text.' });
      }
      const values = {
        curriculum: topic.curriculum,
        subject_name: topic.subjectName.trim(),
        syllabus_code: topic.syllabusCode.trim(),
        syllabus_version: topic.syllabusVersion.trim(),
        topic: topic.topic.trim(),
        subtopic: topic.subtopic.trim(),
        approved_phrases: approvedPhrases,
        source_url: sourceUrl.href,
        verified_by: user.id,
        verified_at: new Date().toISOString(),
      };
      const result = isUuid(payload.syllabusTopicId)
        ? await service.from('past_paper_syllabus_topics').update(values).eq('id', payload.syllabusTopicId).select().single()
        : await service.from('past_paper_syllabus_topics').insert(values).select().single();
      if (result.error) throw result.error;
      await recordAudit(payload.schoolId, user.id, 'past_paper_syllabus_topic_verified', 'past_paper_syllabus_topics', result.data.id, crypto.randomUUID());
      return respond(200, { syllabusTopic: result.data });
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
        || typeof payload.documentDownloadAllowed !== 'boolean'
        || typeof payload.documentStorageAllowed !== 'boolean'
        || typeof payload.ocrAllowed !== 'boolean'
        || (payload.documentStorageAllowed && !payload.documentDownloadAllowed)
        || (payload.ocrAllowed && (!payload.documentDownloadAllowed || !payload.documentStorageAllowed || !payload.questionExtractionAllowed))
        || (payload.questionReuseAllowed && !payload.questionExtractionAllowed)
        || (payload.curriculum !== null && payload.curriculum !== undefined
          && !['Cambridge Primary', 'Cambridge Lower Secondary', 'O Level', 'IGCSE', 'AS Level', 'A Level'].includes(String(payload.curriculum)))
        || (payload.subjectName !== undefined && String(payload.subjectName).length > 160)
        || (payload.syllabusCode !== undefined && String(payload.syllabusCode).length > 40)
        || (payload.syllabusVersion !== undefined && String(payload.syllabusVersion).length > 80)
        || typeof payload.scheduleEnabled !== 'boolean'
        || !Number.isInteger(payload.scheduleIntervalHours)
        || Number(payload.scheduleIntervalHours) < 1 || Number(payload.scheduleIntervalHours) > 720
        || !Number.isInteger(payload.documentMaxBytes)
        || Number(payload.documentMaxBytes) < 1024 || Number(payload.documentMaxBytes) > 50 * 1024 * 1024) {
        return respond(400, { error: 'Provide an authorized source, explicit download/storage/extraction/reuse permissions, and valid source metadata and schedule settings.' });
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
        document_download_allowed: payload.documentDownloadAllowed,
        document_storage_allowed: payload.documentStorageAllowed,
        ocr_allowed: payload.ocrAllowed,
        curriculum: payload.curriculum ?? null,
        subject_name: typeof payload.subjectName === 'string' ? payload.subjectName.trim() : null,
        syllabus_code: typeof payload.syllabusCode === 'string' ? payload.syllabusCode.trim() : null,
        syllabus_version: typeof payload.syllabusVersion === 'string' ? payload.syllabusVersion.trim() : null,
        schedule_enabled: payload.scheduleEnabled,
        schedule_interval_hours: payload.scheduleIntervalHours,
        document_max_bytes: payload.documentMaxBytes,
        next_discovery_at: new Date().toISOString(),
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
        next_discovery_at: new Date(Date.now() + source.schedule_interval_hours * 60 * 60 * 1000).toISOString(),
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
            .select('id,pipeline_status').eq('school_id', payload.schoolId).eq('source_id', source.id)
            .eq('canonical_url', link.url).maybeSingle();
          if (lookupError) throw lookupError;
          if (existing) {
            if (existing.pipeline_status === 'PERMISSION_BLOCKED' && source.document_download_allowed
              && source.document_storage_allowed && source.question_extraction_allowed) {
              const { error: requeueError } = await service.from('past_paper_discovery_items').update({
                pipeline_status: 'DISCOVERED', failure_reason: null, updated_at: new Date().toISOString(),
              }).eq('id', existing.id);
              if (requeueError) throw requeueError;
            }
            continue;
          }
          const { data: crossSourceMatch, error: crossSourceError } = await service.from('past_paper_discovery_items')
            .select('id').eq('school_id', payload.schoolId).eq('canonical_url', link.url)
            .neq('pipeline_status', 'DUPLICATE').limit(1).maybeSingle();
          if (crossSourceError) throw crossSourceError;
          const pipelineStatus = crossSourceMatch ? 'DUPLICATE'
            : !source.document_download_allowed || !source.document_storage_allowed
              || !source.question_extraction_allowed ? 'PERMISSION_BLOCKED' : 'DISCOVERED';
          const { error: insertError } = await service.from('past_paper_discovery_items').insert({
            school_id: payload.schoolId,
            source_id: source.id,
            job_id: job.id,
            canonical_url: link.url,
            title: link.title,
            link_text: link.linkText,
            ...paperMetadata(link.title, source),
            pipeline_status: pipelineStatus,
            duplicate_item_id: crossSourceMatch?.id ?? null,
            failure_reason: crossSourceMatch
              ? 'Canonical source URL is already registered for another source in this school.'
              : pipelineStatus === 'PERMISSION_BLOCKED'
                ? 'The source permissions do not authorize download, private storage, and question extraction.' : null,
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
            last_robots_check_at: completedAt,
            last_discovery_at: completedAt,
            next_discovery_at: new Date(Date.now() + source.schedule_interval_hours * 60 * 60 * 1000).toISOString(),
            updated_at: completedAt,
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
        ...(payload.decision === 'rejected' ? {
          pipeline_status: 'REJECTED',
          failure_reason: 'School academic lead rejected this paper metadata.',
        } : {}),
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
        .select('*').eq('id', payload.itemId)
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
        curriculum: item.curriculum,
        subject_name: item.subject_name,
        syllabus_version: item.syllabus_version,
        examination_year: item.examination_year,
        examination_session: item.examination_session,
        paper_number: item.paper_number,
        variant: item.variant,
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
        .select('*')
        .eq('id', payload.questionId).eq('school_id', payload.schoolId).maybeSingle();
      if (questionError) throw questionError;
      if (!question) return respond(404, { error: 'Question was not found in this school.' });
      const [{ data: source, error: sourceError }, { data: item, error: itemError }] = await Promise.all([
        service.from('past_paper_sources').select('*').eq('id', question.source_id).eq('school_id', payload.schoolId).single(),
        service.from('past_paper_discovery_items').select('*').eq('id', question.discovery_item_id).eq('school_id', payload.schoolId).single(),
      ]);
      if (sourceError) throw sourceError;
      if (itemError) throw itemError;
      const corrections = isRecord(payload.corrections) ? payload.corrections : {};
      const metadataFields: Record<string, unknown> = {};
      const metadataMap: Record<string, string> = {
        curriculum: 'curriculum',
        subjectName: 'subject_name',
        syllabusCode: 'syllabus_code',
        syllabusVersion: 'syllabus_version',
        examinationYear: 'examination_year',
        examinationSession: 'examination_session',
        paperNumber: 'paper_number',
        variant: 'variant',
      };
      for (const [field, column] of Object.entries(metadataMap)) {
        if (!(field in corrections)) continue;
        const value = corrections[field];
        if (typeof value === 'string' && value.trim()) metadataFields[column] = value.trim();
        else if (field === 'examinationYear' && Number.isInteger(value) && Number(value) >= 1900 && Number(value) <= 2200) {
          metadataFields[column] = value;
        } else if (value !== null && value !== '') {
          return respond(400, { error: `Invalid correction for ${field}.` });
        }
      }
      const correctedItem = { ...item, ...metadataFields };
      if (Object.keys(metadataFields).length) {
        const { error: metadataError } = await service.from('past_paper_discovery_items')
          .update({ ...metadataFields, updated_at: new Date().toISOString() })
          .eq('id', item.id).eq('school_id', payload.schoolId);
        if (metadataError) throw metadataError;
      }
      const questionText = typeof corrections.questionText === 'string'
        ? corrections.questionText.trim() : question.question_text;
      const topic = typeof corrections.topic === 'string' ? corrections.topic.trim() : question.topic;
      const subtopic = typeof corrections.subtopic === 'string' ? corrections.subtopic.trim() : question.subtopic;
      const syllabusCode = typeof corrections.questionSyllabusCode === 'string'
        ? corrections.questionSyllabusCode.trim() : question.syllabus_code;
      const marks = corrections.marks === '' || corrections.marks === null
        ? null : corrections.marks === undefined ? question.marks : Number(corrections.marks);
      if (questionText.length > 12000 || (topic && topic.length > 160) || (subtopic && subtopic.length > 160)
        || (syllabusCode && syllabusCode.length > 40)
        || (marks !== null && (!Number.isFinite(marks) || marks <= 0 || marks > 1000))) {
        return respond(400, { error: 'Question corrections exceed allowed text or mark ranges.' });
      }
      const syllabusTopicId = isUuid(payload.syllabusTopicId) ? payload.syllabusTopicId : null;
      let syllabusTopic: Record<string, unknown> | null = null;
      if (syllabusTopicId) {
        const { data, error } = await service.from('past_paper_syllabus_topics').select('*')
          .eq('id', syllabusTopicId).maybeSingle();
        if (error) throw error;
        syllabusTopic = data;
        if (!syllabusTopic || syllabusTopic.curriculum !== correctedItem.curriculum
          || syllabusTopic.subject_name !== correctedItem.subject_name
          || syllabusTopic.syllabus_code !== correctedItem.syllabus_code
          || syllabusTopic.syllabus_version !== correctedItem.syllabus_version) {
          return respond(400, { error: 'Choose a verified syllabus topic matching the paper metadata.' });
        }
      }
      const candidate = {
        question_number: question.question_number,
        marks,
        extraction_status: question.document_id ? question.extraction_status : 'COMPLETE',
        syllabus_topic_id: syllabusTopicId ?? question.syllabus_topic_id,
        classification_status: syllabusTopicId ? 'CLASSIFIED' : question.classification_status,
      };
      const reasons = payload.decision !== 'approved' ? [] : question.document_id
        ? validateExtractedQuestion(candidate, correctedItem)
        : [
          ...(questionText.length >= 10 ? [] : ['Question text must contain at least 10 characters.']),
          ...(topic ? [] : ['A human-reviewed topic is required.']),
          ...(marks !== null && marks > 0 ? [] : ['Positive marks are required.']),
        ];
      if (payload.decision === 'approved' && question.validation_status === 'DUPLICATE') {
        reasons.push('Possible duplicate questions cannot be approved until reviewed separately.');
      }
      if (payload.decision === 'approved' && (source.status !== 'active' || !source.question_extraction_allowed
        || item.review_status !== 'approved')) {
        return respond(403, { error: 'Question approval requires an active authorized source and approved paper metadata.' });
      }
      if (payload.decision === 'approved' && reasons.length) {
        return respond(400, { error: 'Question validation needs corrections before approval.', validationErrors: reasons });
      }
      const contentUseEligible = payload.contentUseEligible === true;
      if (contentUseEligible && (payload.decision !== 'approved' || !source.question_reuse_allowed)) {
        return respond(403, { error: 'Content-use eligibility requires approval and explicit source reuse permission.' });
      }
      const correlationId = crypto.randomUUID();
      const nextStatus = payload.decision === 'approved' ? 'APPROVED' : 'REJECTED';
      const nextContentUseStatus = payload.decision === 'rejected' || !source.question_reuse_allowed
        ? 'BLOCKED' : contentUseEligible ? 'ELIGIBLE' : 'NOT_REVIEWED';
      const updatedValues: Record<string, unknown> = {
        review_status: payload.decision,
        question_text: questionText,
        topic: syllabusTopic?.topic ?? topic,
        subtopic: syllabusTopic?.subtopic ?? subtopic,
        syllabus_code: syllabusCode,
        marks,
        syllabus_topic_id: syllabusTopicId ?? question.syllabus_topic_id,
        classification_status: syllabusTopicId ? 'CLASSIFIED' : question.classification_status,
        classification_confidence: syllabusTopicId ? 100 : question.classification_confidence,
        validation_status: nextStatus,
        validation_reasons: reasons,
        content_use_status: nextContentUseStatus,
        validation_correlation_id: correlationId,
        validated_at: new Date().toISOString(),
        validated_by: user.id,
        reviewer_note: typeof payload.reviewerNote === 'string' ? payload.reviewerNote.trim().slice(0, 2000) : '',
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
      };
      const { error } = await service.from('past_paper_catalogue_questions').update(updatedValues)
        .eq('id', question.id).eq('school_id', payload.schoolId);
      if (error) throw error;
      const { error: eventError } = await service.from('past_paper_validation_events').insert({
        school_id: payload.schoolId,
        catalogue_question_id: question.id,
        actor_id: user.id,
        correlation_id: correlationId,
        status: nextStatus,
        reasons,
        details: { content_use_status: nextContentUseStatus },
      });
      if (eventError) throw eventError;
      await recordAudit(payload.schoolId, user.id, `past_paper_question_${payload.decision}`, 'past_paper_catalogue_questions', question.id, correlationId);
      if (Object.keys(metadataFields).length) {
        await recordAudit(payload.schoolId, user.id, 'past_paper_item_metadata_corrected', 'past_paper_discovery_items', item.id, correlationId);
      }
      return respond(200, { success: true, validationStatus: nextStatus, contentUseStatus: nextContentUseStatus });
    }

    if (payload.action === 'search-approved') {
      const query = typeof payload.query === 'string'
        ? payload.query.replace(/[^\p{L}\p{N}\s-]/gu, '').trim().slice(0, 100)
        : '';
      const filters = isRecord(payload.filters) ? payload.filters : {};
      let requestQuery = service.from('past_paper_catalogue_questions')
        .select('id,source_id,discovery_item_id,question_text,topic,subtopic,syllabus_code,marks,difficulty,mark_scheme,created_at,curriculum,syllabus_version,examination_year,examination_session,paper_number,variant,question_number,page_start,page_end')
        .eq('school_id', payload.schoolId)
        .eq('review_status', 'approved')
        .eq('validation_status', 'APPROVED')
        .eq('content_use_status', 'ELIGIBLE')
        .order('created_at', { ascending: false }).limit(100);
      const filterColumns: Record<string, string> = {
        curriculum: 'curriculum',
        subject: 'subject_name',
        year: 'examination_year',
        session: 'examination_session',
        topic: 'topic',
        subtopic: 'subtopic',
        paper: 'paper_number',
        variant: 'variant',
      };
      for (const [key, column] of Object.entries(filterColumns)) {
        const value = filters[key];
        if (typeof value !== 'string' || !value.trim()) continue;
        if (key === 'year') requestQuery = requestQuery.eq(column, Number(value));
        else requestQuery = requestQuery.eq(column, value.trim().slice(0, 160));
      }
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
        if (source.status === 'active' && source.question_extraction_allowed
          && source.question_reuse_allowed && item.review_status === 'approved') {
          eligible.push({
            ...question,
            subject_name: item.subject_name,
            source_name: source.name,
            paper_title: item.title,
            source_url: item.canonical_url,
          });
        }
      }
      return respond(200, { questions: eligible });
    }

    if (payload.action === 'import-question') {
      if (!isUuid(payload.questionId)) return respond(400, { error: 'Select a valid catalogue question.' });
      const [{ data: moduleSettings, error: moduleError }, { data: question, error: questionError }] = await Promise.all([
        service.from('school_module_settings').select('module_learning').eq('school_id', payload.schoolId).maybeSingle(),
        service.from('past_paper_catalogue_questions').select('*').eq('id', payload.questionId)
          .eq('school_id', payload.schoolId).eq('review_status', 'approved')
          .eq('validation_status', 'APPROVED').eq('content_use_status', 'ELIGIBLE').maybeSingle(),
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
      if (source.status !== 'active' || !source.question_extraction_allowed
        || !source.question_reuse_allowed || item.review_status !== 'approved') {
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
    return respond(500, { error: getErrorMessage(error) });
  }
});
