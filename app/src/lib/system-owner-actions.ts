import { requireSupabase } from './supabase';

export async function invokeSystemOwnerAction(body: Record<string, unknown>) {
  const result = await requireSupabase().functions.invoke('system-owner-admin', { body });
  if (result.error) return result;
  const data = result.data;
  if (typeof data === 'object' && data !== null
    && 'approvalRequired' in data && data.approvalRequired === true) {
    const message = 'message' in data && typeof data.message === 'string'
      ? data.message
      : 'This change was submitted for system owner approval.';
    return { ...result, error: new Error(message) };
  }
  return result;
}
