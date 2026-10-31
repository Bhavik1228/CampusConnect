import { requireSupabase } from './supabase';

export type OfficialDocumentType = 'academic_report' | 'invoice' | 'receipt' | 'statement';

export interface PreparedOfficialDocument {
  id: string;
  reference: string;
  version: number;
  token: string;
  object_path: string;
}

function isPreparedDocument(value: unknown): value is PreparedOfficialDocument {
  return typeof value === 'object' && value !== null
    && 'id' in value && typeof value.id === 'string'
    && 'reference' in value && typeof value.reference === 'string'
    && 'version' in value && typeof value.version === 'number'
    && 'token' in value && typeof value.token === 'string' && /^[0-9a-f]{64}$/.test(value.token)
    && 'object_path' in value && typeof value.object_path === 'string';
}

export function documentVerificationUrl(token: string) {
  if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    throw new Error('Document verification requires a secure HTTPS connection.');
  }
  return `${window.location.origin}/verify/document/${encodeURIComponent(token)}`;
}

export async function prepareOfficialDocument(
  schoolId: string,
  documentType: OfficialDocumentType,
  sourceId: string,
): Promise<PreparedOfficialDocument> {
  const { data, error } = await requireSupabase().rpc('prepare_school_document', {
    target_school: schoolId,
    target_type: documentType,
    target_source: sourceId,
  });
  if (error) throw error;
  if (!isPreparedDocument(data)) throw new Error('The server returned an invalid official document reference.');
  return data;
}

export async function storeOfficialDocument(document: PreparedOfficialDocument, pdf: Blob) {
  const client = requireSupabase();
  const { error: uploadError } = await client.storage
    .from('school-official-documents')
    .upload(document.object_path, pdf, { contentType: 'application/pdf', upsert: false });
  if (uploadError) throw uploadError;

  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await pdf.arrayBuffer()));
  const hexDigest = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const { error: finalizeError } = await client.rpc('finalize_school_document', {
    target_document: document.id,
    target_sha256: `\\x${hexDigest}`,
  });
  if (finalizeError) throw finalizeError;

  const { error: auditError } = await client.rpc('record_school_document_download', {
    target_document: document.id,
  });
  if (auditError) throw auditError;
}

export function savePdfBlob(pdf: Blob, filename: string) {
  const url = URL.createObjectURL(pdf);
  const link = window.document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
