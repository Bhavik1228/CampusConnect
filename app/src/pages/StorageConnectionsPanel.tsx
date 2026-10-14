import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Cloud, Plus, Trash2 } from 'lucide-react';
import { ErrorState, LoadingState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

type StorageConnection = { id: string; label: string; created_at: string };
type ConnectionForm = {
  label: string;
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
};
const emptyForm: ConnectionForm = { label: '', accountId: '', bucketName: '', accessKeyId: '', secretAccessKey: '' };

export function StorageConnectionsPanel() {
  const { activeMembership } = useAuth();
  const schoolId = activeMembership?.school_id;
  const canManage = activeMembership?.role === 'school_admin';
  const [connections, setConnections] = useState<StorageConnection[]>([]);
  const [managedAvailable, setManagedAvailable] = useState(false);
  const [form, setForm] = useState<ConnectionForm>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadConnections = useCallback(async () => {
    if (!schoolId) return;
    setLoading(true);
    setError('');
    try {
      const { data, error: invokeError } = await requireSupabase().functions.invoke('learning-material-storage', {
        body: { action: 'list-connections', schoolId },
      });
      if (invokeError) throw invokeError;
      if (!Array.isArray(data?.connections)) throw new Error('The storage service returned an invalid connection list.');
      setConnections(data.connections as StorageConnection[]);
      setManagedAvailable(data.managedStorageAvailable === true);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load school storage connections.');
    } finally {
      setLoading(false);
    }
  }, [schoolId]);

  useEffect(() => { void loadConnections(); }, [loadConnections]);

  async function addConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: invokeError } = await requireSupabase().functions.invoke('learning-material-storage', {
        body: { action: 'add-connection', schoolId, ...form },
      });
      if (invokeError) throw invokeError;
      setForm(emptyForm);
      setNotice('R2 bucket verified and securely added. Its credentials will not be shown again.');
      await loadConnections();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not add this R2 connection.');
    } finally {
      setSaving(false);
    }
  }

  async function removeConnection(connection: StorageConnection) {
    if (!schoolId || !window.confirm(`Remove “${connection.label}” from this school? Stored files are not deleted. Connections in use must be moved first.`)) return;
    setError('');
    setNotice('');
    try {
      const { error: invokeError } = await requireSupabase().functions.invoke('learning-material-storage', {
        body: { action: 'delete-connection', schoolId, connectionId: connection.id },
      });
      if (invokeError) throw invokeError;
      setNotice('Storage connection removed.');
      await loadConnections();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Could not remove this R2 connection.');
    }
  }

  return (
    <div className="content-card settings-form storage-connections-panel">
      <div className="settings-section-heading"><span className="eyebrow">Private file storage</span><h2>R2 storage connections</h2><p>Use Campus Connect managed storage when enabled, or connect multiple private Cloudflare R2 buckets owned by your school.</p></div>
      {error && <ErrorState message={error} />}
      {notice && <p className="inline-success" role="status">{notice}</p>}
      {loading ? <LoadingState label="Loading storage connections…" /> : <>
        <section className="storage-option">
          <span className="storage-option-icon"><Cloud size={18} /></span>
          <div><strong>Campus Connect managed storage</strong><p>{managedAvailable ? 'Available for this school. Select the managed option when uploading a resource.' : 'Not enabled for this school. Contact Campus Connect to request access; once enabled, it will appear as an upload option.'}</p></div>
          <span className={`status-pill ${managedAvailable ? 'status-active' : 'status-muted'}`}>{managedAvailable ? 'Available' : 'Not enabled'}</span>
        </section>
        <section className="settings-subsection">
          <div className="settings-subheading"><h3>Your R2 buckets</h3><p>Add multiple buckets. Each resource can select which connected bucket stores its file.</p></div>
          {connections.length === 0 ? <p className="storage-empty">No school-owned R2 buckets connected yet.</p> : <div className="storage-connection-list">{connections.map((connection) => <article key={connection.id} className="storage-connection">
            <span className="storage-option-icon"><Cloud size={16} /></span>
            <div><strong>{connection.label}</strong><small>Cloudflare R2 · Credentials encrypted · Added {new Date(connection.created_at).toLocaleDateString()}</small></div>
            {canManage && <button type="button" className="icon-button danger" aria-label={`Remove ${connection.label}`} title="Remove storage connection" onClick={() => void removeConnection(connection)}><Trash2 size={15} /></button>}
          </article>)}</div>}
        </section>
        {canManage ? <form className="storage-connection-form" onSubmit={(event) => void addConnection(event)}>
          <div className="settings-subheading"><h3>Connect a school-owned bucket</h3><p>Use a Cloudflare R2 API token scoped to the bucket. The token must allow object read and write access.</p></div>
          <div className="settings-fields">
            <label className="field"><span>Connection name</span><input required minLength={2} maxLength={80} value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} placeholder="e.g. Main learning library" /></label>
            <label className="field"><span>R2 account ID</span><input required minLength={32} maxLength={32} pattern="[a-fA-F0-9]{32}" autoComplete="off" value={form.accountId} onChange={(event) => setForm({ ...form, accountId: event.target.value })} /></label>
            <label className="field"><span>Bucket name</span><input required minLength={3} maxLength={63} pattern="[a-z0-9][a-z0-9-]{1,61}[a-z0-9]" autoComplete="off" value={form.bucketName} onChange={(event) => setForm({ ...form, bucketName: event.target.value })} /></label>
            <label className="field"><span>R2 access key ID</span><input required maxLength={256} autoComplete="off" value={form.accessKeyId} onChange={(event) => setForm({ ...form, accessKeyId: event.target.value })} /></label>
            <label className="field"><span>R2 secret access key</span><input required type="password" minLength={16} maxLength={512} autoComplete="new-password" value={form.secretAccessKey} onChange={(event) => setForm({ ...form, secretAccessKey: event.target.value })} /></label>
          </div>
          <p className="quiet-note">Credentials are sent only to the storage Edge Function, verified against the bucket, encrypted before database storage, and never returned to the browser. They are not stored in school settings or source code.</p>
          <button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Verifying bucket…' : <><Plus size={15} /> Verify and add bucket</>}</button>
        </form> : <p className="settings-readonly">Only the school administrator can add or remove R2 connections.</p>}
      </>}
    </div>
  );
}
