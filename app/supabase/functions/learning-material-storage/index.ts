import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from 'npm:@aws-sdk/client-s3';
import { getSignedUrl } from 'npm:@aws-sdk/s3-request-presigner';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-api-version, range',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin, Access-Control-Request-Headers',
};
const MAX_FILE_SIZE = 524288000;
const SIGNED_URL_SECONDS = 300;
const allowedMimeTypes = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);

type StorageRequest = {
  action?: unknown;
  materialId?: unknown;
  disposition?: unknown;
  schoolId?: unknown;
  connectionId?: unknown;
  label?: unknown;
  accountId?: unknown;
  bucketName?: unknown;
  accessKeyId?: unknown;
  secretAccessKey?: unknown;
};
type Material = {
  id: string;
  school_id: string;
  class_id: string;
  uploaded_by: string;
  storage_path: string;
  storage_provider: 'r2' | 'supabase';
  mime_type: string | null;
  file_size: number | null;
  file_name?: string | null;
  is_uploaded: boolean;
  storage_connection_id: string | null;
};
type R2Credentials = {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
};
type StoredConnection = {
  id: string;
  school_id: string;
  credentials_ciphertext: string;
  credentials_nonce: string;
};
type SchoolStorageAccess = { managed_storage_enabled: boolean };

function respond(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function makeR2Client(credentials?: R2Credentials) {
  if (credentials) {
    return new S3Client({
      region: 'auto',
      endpoint: `https://${credentials.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey },
    });
  }
  const accountId = Deno.env.get('R2_ACCOUNT_ID');
  const accessKeyId = Deno.env.get('R2_ACCESS_KEY_ID');
  const secretAccessKey = Deno.env.get('R2_SECRET_ACCESS_KEY');
  if (!accountId || !accessKeyId || !secretAccessKey || !Deno.env.get('R2_BUCKET_NAME')) {
    throw new Error('Cloudflare R2 storage configuration is incomplete.');
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function getManagedCredentials(): R2Credentials | null {
  const accountId = Deno.env.get('R2_ACCOUNT_ID');
  const bucketName = Deno.env.get('R2_BUCKET_NAME');
  const accessKeyId = Deno.env.get('R2_ACCESS_KEY_ID');
  const secretAccessKey = Deno.env.get('R2_SECRET_ACCESS_KEY');
  if (!accountId || !bucketName || !accessKeyId || !secretAccessKey) return null;
  return { accountId, bucketName, accessKeyId, secretAccessKey };
}

function encodeBase64(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function encryptionKey() {
  const secret = Deno.env.get('R2_CREDENTIAL_ENCRYPTION_KEY');
  if (!secret || secret.length < 32) {
    throw new Error('School R2 credentials are not enabled. Configure R2_CREDENTIAL_ENCRYPTION_KEY in Supabase secrets.');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptCredentials(credentials: R2Credentials) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    await encryptionKey(),
    new TextEncoder().encode(JSON.stringify(credentials)),
  );
  return { credentials_nonce: encodeBase64(nonce), credentials_ciphertext: encodeBase64(new Uint8Array(ciphertext)) };
}

async function decryptCredentials(connection: StoredConnection): Promise<R2Credentials> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decodeBase64(connection.credentials_nonce) },
    await encryptionKey(),
    decodeBase64(connection.credentials_ciphertext),
  );
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<R2Credentials>;
  if (!parsed.accountId || !parsed.bucketName || !parsed.accessKeyId || !parsed.secretAccessKey) {
    throw new Error('The saved R2 connection credentials are incomplete.');
  }
  return parsed as R2Credentials;
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
    if (!accessToken) return respond(401, { error: 'Sign in to access learning materials.' });

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!supabaseUrl || !anonKey) throw new Error('Supabase function configuration is incomplete.');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!serviceRoleKey) throw new Error('Learning materials storage configuration is incomplete.');
    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const userClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser(accessToken);
    if (authError || !user) return respond(401, { error: 'Your session is invalid. Sign in again.' });

    const payload = await request.json() as StorageRequest;
    const action = typeof payload.action === 'string' ? payload.action : '';

    if (action === 'list-connections' || action === 'add-connection' || action === 'delete-connection' || action === 'request-managed-storage') {
      if (!isUuid(payload.schoolId)) return respond(400, { error: 'Choose a valid school.' });
      const { data: memberships, error: membershipError } = await userClient
        .from('school_memberships')
        .select('role')
        .eq('school_id', payload.schoolId)
        .eq('profile_id', user.id);
      if (membershipError) throw membershipError;
      const roles = memberships?.map((membership) => membership.role) ?? [];
      if (!roles.length) return respond(403, { error: 'You cannot configure storage for this school.' });
      const { data: schoolAccess, error: schoolAccessError } = await serviceClient
        .from('schools')
        .select('platform_status')
        .eq('id', payload.schoolId)
        .maybeSingle();
      if (schoolAccessError) throw schoolAccessError;
      if (!schoolAccess || schoolAccess.platform_status !== 'active') {
        return respond(403, { error: 'This school is suspended. Contact Campus Connect support for assistance.' });
      }

      if (action === 'list-connections') {
        if (!roles.some((role) => ['school_admin', 'academic_coordinator', 'teacher'].includes(role))) {
          return respond(403, { error: 'School staff access is required to view storage options.' });
        }
        const { data: connections, error: listError } = await serviceClient
          .from('school_storage_connections')
          .select('id,label,created_at')
          .eq('school_id', payload.schoolId)
          .order('created_at');
        if (listError) throw listError;
        const { data: managedRequest, error: requestError } = await serviceClient
          .from('managed_storage_requests')
          .select('id,status,message,created_at')
          .eq('school_id', payload.schoolId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (requestError) throw requestError;
        const { data: school, error: schoolError } = await serviceClient
          .from('schools')
          .select('managed_storage_enabled')
          .eq('id', payload.schoolId)
          .single();
        if (schoolError) throw schoolError;
        return respond(200, {
          connections: connections ?? [],
          managedStorageAvailable: Boolean(school.managed_storage_enabled && getManagedCredentials()),
          managedStorageEnabled: school.managed_storage_enabled,
          managedRequest,
        });
      }

      if (action === 'request-managed-storage') {
        if (!roles.includes('school_admin')) return respond(403, { error: 'Only a school administrator can request managed storage.' });
        const { data: school, error: schoolError } = await serviceClient
          .from('schools')
          .select('managed_storage_enabled')
          .eq('id', payload.schoolId)
          .single();
        if (schoolError) throw schoolError;
        if (school.managed_storage_enabled) return respond(409, { error: 'Campus Connect managed storage is already enabled for this school.' });
        const message = typeof payload.message === 'string' ? payload.message.trim().slice(0, 1000) : '';
        const { data: existing, error: existingError } = await serviceClient
          .from('managed_storage_requests')
          .select('id,status')
          .eq('school_id', payload.schoolId)
          .eq('status', 'pending')
          .maybeSingle();
        if (existingError) throw existingError;
        if (existing) return respond(409, { error: 'Your school already has a pending managed-storage request.' });
        const { data: storageRequest, error: requestError } = await serviceClient
          .from('managed_storage_requests')
          .insert({ school_id: payload.schoolId, requested_by: user.id, message })
          .select('id,status,created_at')
          .single();
        if (requestError) throw requestError;
        return respond(201, { request: storageRequest });
      }

      if (!roles.includes('school_admin')) {
        return respond(403, { error: 'Only a school administrator can change storage connections.' });
      }

      if (action === 'delete-connection') {
        if (!isUuid(payload.connectionId)) return respond(400, { error: 'Choose a valid storage connection.' });
        const { count, error: usageError } = await serviceClient
          .from('learning_materials')
          .select('id', { count: 'exact', head: true })
          .eq('school_id', payload.schoolId)
          .eq('storage_connection_id', payload.connectionId);
        if (usageError) throw usageError;
        if ((count ?? 0) > 0) return respond(409, { error: 'This connection is in use by learning materials. Move or remove those files before deleting it.' });
        const { data: deleted, error: deleteError } = await serviceClient
          .from('school_storage_connections')
          .delete()
          .eq('id', payload.connectionId)
          .eq('school_id', payload.schoolId)
          .select('id')
          .maybeSingle();
        if (deleteError) throw deleteError;
        if (!deleted) return respond(404, { error: 'The storage connection was not found.' });
        return respond(200, { status: 'deleted' });
      }

      const label = typeof payload.label === 'string' ? payload.label.trim() : '';
      const accountId = typeof payload.accountId === 'string' ? payload.accountId.trim() : '';
      const bucketName = typeof payload.bucketName === 'string' ? payload.bucketName.trim() : '';
      const accessKeyId = typeof payload.accessKeyId === 'string' ? payload.accessKeyId.trim() : '';
      const secretAccessKey = typeof payload.secretAccessKey === 'string' ? payload.secretAccessKey : '';
      if (label.length < 2 || label.length > 80
        || !/^[a-f0-9]{32}$/i.test(accountId)
        || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucketName)
        || accessKeyId.length < 8 || accessKeyId.length > 256
        || secretAccessKey.length < 16 || secretAccessKey.length > 512) {
        return respond(400, { error: 'Check the connection name and R2 account, bucket, and API token details.' });
      }
      const credentials = { accountId, bucketName, accessKeyId, secretAccessKey };
      try {
        await makeR2Client(credentials).send(new HeadBucketCommand({ Bucket: bucketName }));
      } catch (verificationError) {
        console.error(
          'Cloudflare R2 bucket verification failed.',
          verificationError instanceof Error ? verificationError.name : 'Unknown error',
        );
        return respond(400, { error: 'Could not verify this R2 bucket. Confirm the account, bucket, and token permissions.' });
      }
      const encrypted = await encryptCredentials(credentials);
      const { data: connection, error: insertError } = await serviceClient
        .from('school_storage_connections')
        .insert({
          school_id: payload.schoolId,
          label,
          ...encrypted,
          created_by: user.id,
        })
        .select('id,label,created_at')
        .single();
      if (insertError) throw insertError;
      return respond(201, { connection });
    }

    if (!isUuid(payload.materialId)) return respond(400, { error: 'Choose a valid learning resource.' });
    const { data: material, error: materialError } = await userClient
      .from('learning_materials')
      .select('id,school_id,class_id,uploaded_by,storage_path,storage_provider,mime_type,file_size,file_name,is_uploaded,storage_connection_id')
      .eq('id', payload.materialId)
      .maybeSingle();
    if (materialError) throw materialError;
    if (!material) return respond(404, { error: 'The learning resource is unavailable or you do not have access.' });
    const record = material as Material;
    let r2Credentials: R2Credentials | undefined;
    if (record.storage_provider === 'r2') {
      if (record.storage_connection_id) {
        const { data: connection, error: connectionError } = await serviceClient
          .from('school_storage_connections')
          .select('id,school_id,credentials_ciphertext,credentials_nonce')
          .eq('id', record.storage_connection_id)
          .eq('school_id', record.school_id)
          .maybeSingle();
        if (connectionError) throw connectionError;
        if (!connection) return respond(409, { error: 'This resource’s school R2 connection is missing.' });
        r2Credentials = await decryptCredentials(connection as StoredConnection);
      } else {
        r2Credentials = getManagedCredentials() ?? undefined;
        if (!r2Credentials) return respond(409, { error: 'No R2 storage is configured for this school. Ask the school administrator to add a bucket or contact Campus Connect to request managed storage.' });
        if (action === 'create-upload-url') {
          const { data: school, error: schoolError } = await serviceClient
            .from('schools')
            .select('managed_storage_enabled')
            .eq('id', record.school_id)
            .maybeSingle();
          if (schoolError) throw schoolError;
          if (!(school as SchoolStorageAccess | null)?.managed_storage_enabled) {
            return respond(403, { error: 'Campus Connect managed storage is not enabled for this school. Request access in Settings → File storage.' });
          }
        }
      }
    }

    if (record.storage_provider === 'supabase' && action !== 'delete-resource') {
      return respond(400, { error: 'This is a legacy Supabase file. Open or delete it from the learning materials page.' });
    }

    if (action === 'create-upload-url') {
      if (record.uploaded_by !== user.id) return respond(403, { error: 'Only the person who started this upload can finish it.' });
      if (record.is_uploaded) return respond(409, { error: 'This resource has already been uploaded.' });
      if (!record.file_size || record.file_size > MAX_FILE_SIZE || record.file_size < 1) {
        return respond(400, { error: 'The file must be between 1 byte and 500 MB.' });
      }
      if (!record.mime_type || !allowedMimeTypes.has(record.mime_type)) {
        return respond(400, { error: 'This file type is not supported.' });
      }
      const command = new PutObjectCommand({
        Bucket: r2Credentials!.bucketName,
        Key: record.storage_path,
        ContentType: record.mime_type,
      });
      const uploadUrl = await getSignedUrl(makeR2Client(r2Credentials), command, { expiresIn: SIGNED_URL_SECONDS });
      return respond(200, { uploadUrl, expiresIn: SIGNED_URL_SECONDS });
    }

    if (action === 'finalize-upload') {
      if (record.uploaded_by !== user.id) return respond(403, { error: 'Only the person who started this upload can finish it.' });
      if (record.is_uploaded) return respond(200, { status: 'uploaded' });
      if (!record.file_size || !record.mime_type) return respond(400, { error: 'The resource is missing its file details.' });

      const r2 = makeR2Client(r2Credentials);
      const head = await r2.send(new HeadObjectCommand({
        Bucket: r2Credentials!.bucketName,
        Key: record.storage_path,
      }));
      if (head.ContentLength !== record.file_size || head.ContentType !== record.mime_type) {
        await r2.send(new DeleteObjectCommand({ Bucket: r2Credentials!.bucketName, Key: record.storage_path }));
        return respond(422, { error: 'The uploaded file did not match the recorded size and type. Please upload it again.' });
      }

      const { data: finalized, error: finalizeError } = await serviceClient
        .from('learning_materials')
        .update({ is_uploaded: true })
        .eq('id', record.id)
        .eq('school_id', record.school_id)
        .eq('uploaded_by', user.id)
        .eq('is_uploaded', false)
        .select('id')
        .maybeSingle();
      if (finalizeError) throw finalizeError;
      if (!finalized) return respond(409, { error: 'This upload is no longer pending verification.' });
      return respond(200, { status: 'uploaded' });
    }

    if (action === 'create-download-url') {
      if (!record.is_uploaded) return respond(409, { error: 'This resource is not available yet.' });
      const download = payload.disposition === 'attachment';
      const command = new GetObjectCommand({
        Bucket: r2Credentials!.bucketName,
        Key: record.storage_path,
        ResponseContentType: record.mime_type ?? 'application/octet-stream',
        ResponseContentDisposition: download ? 'attachment' : 'inline',
      });
      const url = await getSignedUrl(makeR2Client(r2Credentials), command, { expiresIn: SIGNED_URL_SECONDS });
      return respond(200, { url, expiresIn: SIGNED_URL_SECONDS });
    }

    if (action === 'delete-resource') {
      const { data: memberships, error: membershipError } = await userClient
        .from('school_memberships')
        .select('role')
        .eq('school_id', record.school_id)
        .eq('profile_id', user.id);
      if (membershipError) throw membershipError;
      const isManager = memberships?.some((membership) =>
        membership.role === 'school_admin' || membership.role === 'academic_coordinator'
      ) ?? false;
      const { data: teacherProfiles, error: teacherError } = await userClient
        .from('teacher_profiles')
        .select('id')
        .eq('school_id', record.school_id)
        .eq('profile_id', user.id);
      if (teacherError) throw teacherError;
      const teacherIds = (teacherProfiles ?? []).map((teacher) => teacher.id);
      let assignedTeacher = false;
      if (teacherIds.length) {
        const { data: assignment, error: assignmentError } = await userClient
          .from('teacher_class_assignments')
          .select('teacher_id')
          .eq('school_id', record.school_id)
          .eq('class_id', record.class_id)
          .in('teacher_id', teacherIds)
          .limit(1);
        if (assignmentError) throw assignmentError;
        assignedTeacher = Boolean(assignment?.length);
      }
      const mayDelete = isManager || (record.uploaded_by === user.id && assignedTeacher);
      if (!mayDelete) {
        return respond(403, { error: 'Only the uploader or a school academic manager can delete this resource.' });
      }
      if (record.storage_provider === 'supabase') {
        const { error: fileDeleteError } = await serviceClient.storage.from('learning-materials').remove([record.storage_path]);
        if (fileDeleteError) throw fileDeleteError;
      } else {
        const r2 = makeR2Client(r2Credentials);
        await r2.send(new DeleteObjectCommand({ Bucket: r2Credentials!.bucketName, Key: record.storage_path }));
      }
      const { data: deleted, error: deleteError } = await serviceClient
        .from('learning_materials')
        .delete()
        .eq('id', record.id)
        .select('id')
        .maybeSingle();
      if (deleteError) throw deleteError;
      if (!deleted) return respond(403, { error: 'You are no longer authorized to delete this resource.' });
      return respond(200, { status: 'deleted' });
    }

    return respond(400, { error: 'Unsupported learning-material storage action.' });
  } catch (error) {
    console.error('Campus Connect learning material storage request failed.', error);
    return respond(500, {
      error: error instanceof Error ? error.message : 'The learning material request could not be completed.',
    });
  }
});
