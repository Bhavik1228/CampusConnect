import { useEffect, useState, type FormEvent } from 'react';
import { Save } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

interface SchoolSettings {
  name: string;
  timezone: string;
  contact_email: string | null;
  contact_phone: string | null;
  address: string | null;
  website: string | null;
}

export function SchoolSettingsPage() {
  const { activeMembership, refreshMemberships } = useAuth();
  const [settings, setSettings] = useState<SchoolSettings | null>(null);
  const [draft, setDraft] = useState<SchoolSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const canEdit = activeMembership?.role === 'school_admin' || activeMembership?.role === 'system_admin';
  const schoolId = activeMembership?.school_id;

  useEffect(() => {
    if (!schoolId) return;
    let active = true;
    async function loadSettings() {
      setLoading(true);
      setError('');
      try {
        const { data, error: queryError } = await requireSupabase()
          .from('schools')
          .select('name, timezone, contact_email, contact_phone, address, website')
          .eq('id', schoolId)
          .single();
        if (queryError) throw queryError;
        if (active) {
          setSettings(data);
          setDraft(data);
        }
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Could not load school settings.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadSettings();
    return () => { active = false; };
  }, [schoolId]);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !draft) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { data, error: updateError } = await requireSupabase()
        .from('schools')
        .update({
          name: draft.name.trim(),
          timezone: draft.timezone.trim(),
          contact_email: draft.contact_email?.trim() || null,
          contact_phone: draft.contact_phone?.trim() || null,
          address: draft.address?.trim() || null,
          website: draft.website?.trim() || null,
        })
        .eq('id', schoolId)
        .select('name, timezone, contact_email, contact_phone, address, website')
        .single();
      if (updateError) throw updateError;
      setSettings(data);
      setDraft(data);
      setSuccess('School information saved.');
      try {
        await refreshMemberships();
      } catch (refreshError) {
        setError(`School information was saved, but the workspace list could not refresh: ${refreshError instanceof Error ? refreshError.message : 'Refresh failed.'}`);
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save school settings.');
    } finally {
      setSaving(false);
    }
  }

  function update(field: keyof SchoolSettings, value: string) {
    setDraft((current) => current ? { ...current, [field]: value } : current);
    setSuccess('');
  }

  return (
    <div className="page-stack">
      <div className="page-heading"><div><span className="eyebrow">Workspace administration</span><h1>School settings</h1><p>Manage the basic information associated with this school workspace.</p></div></div>
      {error && <ErrorState message={error} />}
      {success && <SuccessMessage message={success} />}
      {loading ? <LoadingState label="Loading school settings…" /> : settings && draft && <form className="content-card settings-form" onSubmit={saveSettings}>
        <div className="settings-section-heading"><span className="eyebrow">School profile</span><h2>School information</h2><p>These details help identify this workspace across the system.</p></div>
        <div className="settings-fields">
          <label className="field"><span>School name</span><input required minLength={2} maxLength={120} disabled={!canEdit} value={draft.name} onChange={(event) => update('name', event.target.value)} /></label>
          <label className="field"><span>Timezone</span><input required maxLength={64} disabled={!canEdit} value={draft.timezone} onChange={(event) => update('timezone', event.target.value)} placeholder="e.g. Africa/Nairobi" /></label>
          <label className="field"><span>Contact email</span><input type="email" maxLength={254} disabled={!canEdit} value={draft.contact_email ?? ''} onChange={(event) => update('contact_email', event.target.value)} /></label>
          <label className="field"><span>Contact phone</span><input type="tel" maxLength={40} disabled={!canEdit} value={draft.contact_phone ?? ''} onChange={(event) => update('contact_phone', event.target.value)} /></label>
          <label className="field"><span>Website</span><input type="url" maxLength={255} disabled={!canEdit} value={draft.website ?? ''} onChange={(event) => update('website', event.target.value)} placeholder="https://" /></label>
          <label className="field"><span>Address</span><input maxLength={255} disabled={!canEdit} value={draft.address ?? ''} onChange={(event) => update('address', event.target.value)} /></label>
        </div>
        {canEdit && <div className="settings-actions"><button className="button button-primary" type="submit" disabled={saving}><Save size={15} />{saving ? 'Saving…' : 'Save changes'}</button></div>}
        {!canEdit && <p className="settings-readonly">Only a school administrator can update these details.</p>}
      </form>}
    </div>
  );
}
