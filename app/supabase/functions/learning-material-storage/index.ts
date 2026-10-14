import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from 'npm:@aws-sdk/client-s3';
import { getSignedUrl } from 'npm:@aws-sdk/s3-request-presigner';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
};

function respond(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function makeR2Client() {
  const accountId = Deno.env.get('R2_ACCOUNT_ID');
  const accessKeyId = Deno.env.get('R2_ACCESS_KEY_ID');
  const secretAccessKey = Deno.env.get('R2_SECRET_ACCESS_KEY');
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('Cloudflare R2 storage configuration is incomplete.');
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function getBucketName() {
  const bucketName = Deno.env.get('R2_BUCKET_NAME');
  if (!bucketName) throw new Error('Cloudflare R2 bucket configuration is incomplete.');
  return bucketName;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return respond(405, { error: 'Method not allowed.' });

  try {
    const accessToken = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!accessToken) return respond(401, { error: 'Sign in to access learning materials.' });

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!supabaseUrl || !anonKey) throw new Error('Supabase function configuration is incomplete.');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!serviceRoleKey) throw new Error('Learning materials storage configuration is incomplete.');

    const userClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser(accessToken);
    if (authError || !user) return respond(401, { error: 'Your session is invalid. Sign in again.' });

    const payload = await request.json() as StorageRequest;
    if (!isUuid(payload.materialId)) return respond(400, { error: 'Choose a valid learning resource.' });
    const action = typeof payload.action === 'string' ? payload.action : '';
    const { data: material, error: materialError } = await userClient
      .from('learning_materials')
      .select('id,school_id,class_id,uploaded_by,storage_path,storage_provider,mime_type,file_size,file_name,is_uploaded')
      .eq('id', payload.materialId)
      .maybeSingle();
    if (materialError) throw materialError;
    if (!material) return respond(404, { error: 'The learning resource is unavailable or you do not have access.' });
    const record = material as Material;

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
        Bucket: getBucketName(),
        Key: record.storage_path,
        ContentType: record.mime_type,
      });
      const uploadUrl = await getSignedUrl(makeR2Client(), command, { expiresIn: SIGNED_URL_SECONDS });
      return respond(200, { uploadUrl, expiresIn: SIGNED_URL_SECONDS });
    }

    if (action === 'finalize-upload') {
      if (record.uploaded_by !== user.id) return respond(403, { error: 'Only the person who started this upload can finish it.' });
      if (record.is_uploaded) return respond(200, { status: 'uploaded' });
      if (!record.file_size || !record.mime_type) return respond(400, { error: 'The resource is missing its file details.' });

      const r2 = makeR2Client();
      const head = await r2.send(new HeadObjectCommand({
        Bucket: getBucketName(),
        Key: record.storage_path,
      }));
      if (head.ContentLength !== record.file_size || head.ContentType !== record.mime_type) {
        await r2.send(new DeleteObjectCommand({ Bucket: getBucketName(), Key: record.storage_path }));
        return respond(422, { error: 'The uploaded file did not match the recorded size and type. Please upload it again.' });
      }

      const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
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
        Bucket: getBucketName(),
        Key: record.storage_path,
        ResponseContentType: record.mime_type ?? 'application/octet-stream',
        ResponseContentDisposition: download ? 'attachment' : 'inline',
      });
      const url = await getSignedUrl(makeR2Client(), command, { expiresIn: SIGNED_URL_SECONDS });
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
      const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      if (record.storage_provider === 'supabase') {
        const { error: fileDeleteError } = await serviceClient.storage.from('learning-materials').remove([record.storage_path]);
        if (fileDeleteError) throw fileDeleteError;
      } else {
        const r2 = makeR2Client();
        await r2.send(new DeleteObjectCommand({ Bucket: getBucketName(), Key: record.storage_path }));
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
