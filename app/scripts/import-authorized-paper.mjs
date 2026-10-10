import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { createClient } from '@supabase/supabase-js';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const DOCUMENT_TYPES = new Set(['qp', 'ms', 'er', 'specimen']);
const SESSIONS = new Set(['m', 's', 'w']);

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith('--') || index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      fail(`Invalid argument near "${name}". Supply named options as --name value.`);
    }
    values.set(name.slice(2), argv[++index]);
  }
  return values;
}

function requiredOption(options, name) {
  const value = options.get(name)?.trim();
  if (!value) fail(`Missing required option --${name}.`);
  return value;
}

function validateUuid(value, name) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    fail(`--${name} must be a valid UUID.`);
  }
}

function safeSegment(value, name) {
  const segment = value.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (!segment) fail(`--${name} must contain letters or numbers.`);
  return segment;
}

function allowedHostsFromEnvironment() {
  const hosts = (process.env.PAPER_SOURCE_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (!hosts.length) fail('Set PAPER_SOURCE_HOSTS to a comma-separated allowlist of authorized HTTPS source hosts.');
  return new Set(hosts);
}

function validateSourceUrl(value, allowedHosts) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('The source URL is invalid.');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    fail('Paper source URLs must use HTTPS and cannot include credentials or a custom port.');
  }
  if (!allowedHosts.has(hostname)) fail(`Source host "${hostname}" is not on PAPER_SOURCE_HOSTS.`);
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || isIP(hostname)) {
    fail('Local and IP-address source URLs are not accepted.');
  }
  return url;
}

async function fetchPdf(sourceUrl, allowedHosts) {
  let url = validateSourceUrl(sourceUrl, allowedHosts);
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, {
        redirect: 'manual',
        signal,
        headers: { Accept: 'application/pdf' },
      });
    } catch (error) {
      if (signal.aborted) fail(`Timed out while fetching the authorized paper from ${url.hostname}.`);
      fail(`Could not fetch the authorized paper: ${error instanceof Error ? error.message : 'network error'}`);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) fail(`Source returned redirect status ${response.status} without a Location header.`);
      if (redirectCount === MAX_REDIRECTS) fail(`Source exceeded the ${MAX_REDIRECTS}-redirect limit.`);
      url = validateSourceUrl(new URL(location, url).href, allowedHosts);
      continue;
    }
    if (!response.ok) fail(`Paper source returned HTTP ${response.status}. Check the URL and your authorization to access it.`);
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.includes('application/pdf') && !contentType.includes('application/octet-stream')) {
      fail('Paper source did not identify the response as a PDF or binary file.');
    }
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_FILE_SIZE) fail(`PDF exceeds the ${MAX_FILE_SIZE / 1024 / 1024} MB size limit.`);
    if (!response.body) fail('Paper source returned an empty response body.');

    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_FILE_SIZE) {
          await reader.cancel();
          fail(`PDF exceeds the ${MAX_FILE_SIZE / 1024 / 1024} MB size limit.`);
        }
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      if (signal.aborted) fail(`Timed out while reading the PDF from ${url.hostname}.`);
      throw error;
    } finally {
      reader.releaseLock();
    }
    const buffer = Buffer.concat(chunks, size);
    if (buffer.length < 5 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
      fail('Downloaded content is not a valid PDF file.');
    }
    return { buffer, finalUrl: url.href };
  }
  fail('Could not resolve the paper source URL.');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.get('rights-confirmed') !== 'true') {
    fail('Pass --rights-confirmed true only after verifying you have permission to copy this document to your school storage.');
  }
  const rightsBasis = requiredOption(options, 'rights-basis');
  if (rightsBasis.length < 8) fail('--rights-basis must briefly identify the license, permission, or other lawful basis for storing this paper.');

  const metadata = {
    school_id: requiredOption(options, 'school-id'),
    created_by: requiredOption(options, 'created-by'),
    subject_name: requiredOption(options, 'subject-name'),
    subject_code: requiredOption(options, 'subject-code').toUpperCase(),
    year: Number(requiredOption(options, 'year')),
    session: requiredOption(options, 'session').toLowerCase(),
    paper_number: safeSegment(requiredOption(options, 'paper-number'), 'paper-number'),
    document_type: requiredOption(options, 'document-type').toLowerCase(),
    source_url: requiredOption(options, 'source-url'),
    rights_basis: rightsBasis,
  };
  validateUuid(metadata.school_id, 'school-id');
  validateUuid(metadata.created_by, 'created-by');
  if (!Number.isInteger(metadata.year) || metadata.year < 1900 || metadata.year > new Date().getUTCFullYear() + 1) {
    fail('--year must be a valid four-digit year.');
  }
  if (!SESSIONS.has(metadata.session)) fail('--session must be m (March), s (June), or w (November).');
  if (!DOCUMENT_TYPES.has(metadata.document_type)) fail('--document-type must be qp, ms, er, or specimen.');
  metadata.subject_name = metadata.subject_name.trim();
  if (!metadata.subject_name || metadata.subject_name.length > 160) fail('--subject-name must be 1 to 160 characters.');
  metadata.subject_code = safeSegment(metadata.subject_code, 'subject-code');

  const allowedHosts = allowedHostsFromEnvironment();
  validateSourceUrl(metadata.source_url, allowedHosts);
  const requiredEnvironment = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'FIREBASE_SERVICE_ACCOUNT', 'FIREBASE_STORAGE_BUCKET'];
  for (const name of requiredEnvironment) if (!process.env[name]) fail(`Missing required environment variable ${name}.`);

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch {
    fail('FIREBASE_SERVICE_ACCOUNT must be a valid JSON service-account object.');
  }
  if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
    fail('Firebase service-account JSON must include project_id, client_email, and private_key.');
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: membership, error: membershipError } = await supabase
    .from('school_memberships')
    .select('role')
    .eq('school_id', metadata.school_id)
    .eq('profile_id', metadata.created_by)
    .maybeSingle();
  if (membershipError) fail(`Could not verify the school membership: ${membershipError.message}`);
  if (!membership || !['teacher', 'school_admin'].includes(membership.role)) {
    fail('The specified profile must be a teacher or school administrator at the target school.');
  }

  const fileName = `${metadata.subject_code}_${metadata.year}_${metadata.session}_${metadata.paper_number}_${metadata.document_type}.pdf`;
  const storagePath = `authorized-papers/${metadata.school_id}/${metadata.subject_code}/${metadata.year}/${fileName}`;
  const { data: existing, error: existingError } = await supabase
    .from('past_papers')
    .select('id')
    .eq('school_id', metadata.school_id)
    .eq('file_name', fileName)
    .maybeSingle();
  if (existingError) fail(`Could not check for duplicate papers: ${existingError.message}`);
  if (existing) fail(`A paper named ${fileName} is already registered for this school; refusing to overwrite it.`);

  const { buffer, finalUrl } = await fetchPdf(metadata.source_url, allowedHosts);
  const checksum = createHash('sha256').update(buffer).digest('hex');
  const firebaseApp = getApps()[0] ?? initializeApp({
    credential: cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
  const file = getStorage(firebaseApp).bucket(process.env.FIREBASE_STORAGE_BUCKET).file(storagePath);

  await file.save(buffer, {
    resumable: false,
    metadata: {
      contentType: 'application/pdf',
      cacheControl: 'private, no-store',
      metadata: {
        schoolId: metadata.school_id,
        sha256: checksum,
        rightsBasis: metadata.rights_basis,
      },
    },
  });

  const { error: insertError } = await supabase.from('past_papers').insert({
    ...metadata,
    file_name: fileName,
    firebase_path: storagePath,
    source_url: finalUrl,
    file_size: buffer.length,
    sha256: checksum,
  });
  if (insertError) {
    try {
      await file.delete();
    } catch (cleanupError) {
      fail(`Paper metadata insert failed (${insertError.message}) and Firebase cleanup also failed (${cleanupError instanceof Error ? cleanupError.message : 'unknown cleanup error'}). Remove the orphaned object ${storagePath} manually.`);
    }
    fail(`Paper metadata insert failed: ${insertError.message}. The uploaded Firebase object was removed.`);
  }

  console.log(`Stored ${fileName} privately in Firebase Storage.`);
  console.log(`School: ${metadata.school_id}`);
  console.log(`File size: ${buffer.length} bytes; SHA-256: ${checksum}`);
  console.log('Paper metadata was registered in Supabase. No public URL was created.');
}

main().catch((error) => {
  console.error(`Paper import failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
