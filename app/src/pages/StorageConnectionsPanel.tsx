import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Cloud, Plus, Trash2 } from 'lucide-react';
import { ErrorState, LoadingState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

type StorageConnection = { id: string; label: string; created_at: string };
type PastPaperStorage = { configured: boolean; bucketName: string | null; createdAt: string | null };
type ManagedRequest = { id: string; status: 'pending' | 'approved' | 'denied'; message: string; created_at: string } | null;
type ConnectionForm = {
  label: string;
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
};
const emptyForm: ConnectionForm = { label: '', accountId: '', bucketName: '', accessKeyId: '', secretAccessKey: '' };
const emptyPaperForm = { accountId: '', bucketName: '', accessKeyId: '', secretAccessKey: '' };

export function StorageConnectionsPanel() {
  const { activeMembership } = useAuth();
  const schoolId = activeMembership?.school_id;
  const canManage = activeMembership?.role === 'school_admin';
  const [connections, setConnections] = useState<StorageConnection[]>([]);
  const [paperStorage, setPaperStorage] = useState<PastPaperStorage>({ configured: false, bucketName: null, createdAt: null });
  const [paperForm, setPaperForm] = useState(emptyPaperForm);
  const [managedAvailable, setManagedAvailable] = useState(false);
  const [managedRequest, setManagedRequest] = useState<ManagedRequest>(null);
  const [managedMessage, setManagedMessage] = useState('');
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
      const [connectionsResult, paperStorageResult] = await Promise.all([
        requireSupabase().functions.invoke('learning-material-storage', {
          body: { action: 'list-connections', schoolId },
        }),
        requireSupabase().functions.invoke('learning-material-storage', {
          body: { action: 'list-paper-storage', schoolId },
        }),
      ]);
      if (connectionsResult.error) throw connectionsResult.error;
      if (paperStorageResult.error) throw paperStorageResult.error;
      const data = connectionsResult.data;
      if (!Array.isArray(data?.connections)) throw new Error('The storage service returned an invalid connection list.');
      setConnections(data.connections as StorageConnection[]);
      setManagedAvailable(data.managedStorageAvailable === true);
      setManagedRequest((data.managedRequest ?? null) as ManagedRequest);
      setPaperStorage(paperStorageResult.data as PastPaperStorage);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load school storage connections.');
    } finally {
      setLoading(false);
    }
  }, [schoolId]);

  useEffect(() => { void loadConnections(); }, [loadConnections]);

  async function requestManagedStorage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: invokeError } = await requireSupabase().functions.invoke('learning-material-storage', {
        body: { action: 'request-managed-storage', schoolId, message: managedMessage },
      });
      if (invokeError) throw invokeError;
      setManagedMessage('');
      setNotice('Your request was sent to Campus Connect for review.');
      await loadConnections();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not submit the managed-storage request.');
    } finally {
      setSaving(false);
    }
  }

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

  async function savePaperStorage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: invokeError } = await requireSupabase().functions.invoke('learning-material-storage', {
        body: { action: 'save-paper-storage', schoolId, ...paperForm },
      });
      if (invokeError) throw invokeError;
      setPaperForm(emptyPaperForm);
      setNotice('Past-paper R2 bucket verified and securely saved. The credentials will not be shown again.');
      await loadConnections();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save the past-paper R2 connection.');
    } finally {
      setSaving(false);
    }
  }

  async function removePaperStorage() {
    if (!schoolId || !window.confirm('Disconnect the past-paper R2 bucket? Stored documents must be removed or moved first.')) return;
    setError('');
    setNotice('');
    try {
      const { error: invokeError } = await requireSupabase().functions.invoke('learning-material-storage', {
        body: { action: 'delete-paper-storage', schoolId },
      });
      if (invokeError) throw invokeError;
      setNotice('Past-paper R2 bucket disconnected.');
      await loadConnections();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Could not disconnect the past-paper R2 bucket.');
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
        {!managedAvailable && canManage && <section className="storage-managed-request">
          <div className="settings-subheading"><h3>Request Campus Connect storage</h3><p>Your request goes to the Campus Connect system owner. Approval enables the managed bucket for your school.</p></div>
          {managedRequest?.status === 'pending'
            ? <p className="storage-request-status"><span className="status-pill status-muted">Pending review</span> Request sent {new Date(managedRequest.created_at).toLocaleDateString()}.</p>
            : <form className="storage-connection-form" onSubmit={(event) => void requestManagedStorage(event)}>
              <label className="field"><span>Note <small>(optional)</small></span><textarea rows={2} maxLength={1000} value={managedMessage} onChange={(event) => setManagedMessage(event.target.value)} placeholder="Tell us about your expected storage needs." /></label>
              {managedRequest?.status === 'denied' && <p className="quiet-note">Your previous request was not approved. You may submit a new request with more information.</p>}
              <button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Sending request…' : 'Request managed storage'}</button>
            </form>}
        </section>}
        <section className="settings-subsection">
          <div className="settings-subheading"><h3>Your R2 buckets</h3><p>Add multiple buckets. Each resource can select which connected bucket stores its file.</p></div>
          {connections.length === 0 ? <p className="storage-empty">No school-owned R2 buckets connected yet.</p> : <div className="storage-connection-list">{connections.map((connection) => <article key={connection.id} className="storage-connection">
            <span className="storage-option-icon"><Cloud size={16} /></span>
            <div><strong>{connection.label}</strong><small>Cloudflare R2, credentials encrypted, added {new Date(connection.created_at).toLocaleDateString()}</small></div>
            {canManage && <button type="button" className="icon-button danger" aria-label={`Remove ${connection.label}`} title="Remove storage connection" onClick={() => void removeConnection(connection)}><Trash2 size={15} /></button>}
          </article>)}</div>}
        </section>
        <section className="settings-subsection">
          <div className="settings-subheading"><h3>Past-paper R2 storage</h3><p>This dedicated private bucket is used automatically for past-paper documents and extraction files. When it is not configured, the pipeline uses its default private storage.</p></div>
          {paperStorage.configured
            ? <div className="storage-connection">
              <span className="storage-option-icon"><Cloud size={16} /></span>
              <div><strong>{paperStorage.bucketName}</strong><small>Cloudflare R2, past papers only, credentials encrypted</small></div>
              {canManage && <button type="button" className="icon-button danger" aria-label="Disconnect past-paper R2 bucket" title="Disconnect past-paper R2 bucket" onClick={() => void removePaperStorage()}><Trash2 size={15} /></button>}
            </div>
            : <p className="storage-empty">No dedicated past-paper R2 bucket configured.</p>}
          {canManage ? <form className="storage-connection-form" onSubmit={(event) => void savePaperStorage(event)}>
            <div className="settings-subheading"><h3>{paperStorage.configured ? 'Replace past-paper bucket keys' : 'Add past-paper bucket keys'}</h3><p>Use an R2 token scoped to the dedicated bucket with object read and write access.</p></div>
            <div className="settings-fields">
              <label className="field"><span>R2 account ID</span><input required minLength={32} maxLength={32} pattern="[a-fA-F0-9]{32}" autoComplete="off" value={paperForm.accountId} onChange={(event) => setPaperForm({ ...paperForm, accountId: event.target.value })} /></label>
              <label className="field"><span>Past-paper bucket name</span><input required minLength={3} maxLength={63} pattern="[a-z0-9][a-z0-9-]{1,61}[a-z0-9]" autoComplete="off" value={paperForm.bucketName} onChange={(event) => setPaperForm({ ...paperForm, bucketName: event.target.value })} /></label>
              <label className="field"><span>R2 access key ID</span><input required maxLength={256} autoComplete="off" value={paperForm.accessKeyId} onChange={(event) => setPaperForm({ ...paperForm, accessKeyId: event.target.value })} /></label>
              <label className="field"><span>R2 secret access key</span><input required type="password" minLength={16} maxLength={512} autoComplete="new-password" value={paperForm.secretAccessKey} onChange={(event) => setPaperForm({ ...paperForm, secretAccessKey: event.target.value })} /></label>
            </div>
            <p className="quiet-note">Credentials are sent only to the storage Edge Function, verified against this bucket, encrypted before database storage, and never returned to the browser.</p>
            <button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Verifying bucket…' : 'Verify and save past-paper bucket'}</button>
          </form> : <p className="settings-readonly">Only the school administrator can configure past-paper storage.</p>}
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
