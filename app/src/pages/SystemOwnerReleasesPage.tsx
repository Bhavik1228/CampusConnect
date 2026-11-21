import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ExternalLink, GitBranch, History, RefreshCw, Save } from 'lucide-react';
import { ErrorState, LoadingState } from '../components/Feedback';
import { useAuth } from '../contexts/AuthContext';
import { invokeSystemOwnerAction } from '../lib/system-owner-actions';

type ReleaseDeployment = {
  id: string;
  name: string;
  url: string;
  inspectorUrl: string;
  state: string;
  createdAt: number;
  readyAt: number | null;
  commit: {
    message: string;
    sha: string;
    branch: string;
  };
  knownIssues: string;
  knownIssuesUpdatedAt: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDeployment(value: unknown): value is ReleaseDeployment {
  if (!isRecord(value) || !isRecord(value.commit)) return false;
  return typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.url === 'string'
    && typeof value.inspectorUrl === 'string'
    && typeof value.state === 'string'
    && typeof value.createdAt === 'number'
    && (value.readyAt === null || typeof value.readyAt === 'number')
    && typeof value.commit.message === 'string'
    && typeof value.commit.sha === 'string'
    && typeof value.commit.branch === 'string'
    && typeof value.knownIssues === 'string'
    && (value.knownIssuesUpdatedAt === null || typeof value.knownIssuesUpdatedAt === 'string');
}

function formatDate(value: number | string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString();
}

export function SystemOwnerReleasesPage() {
  const { user } = useAuth();
  const [deployments, setDeployments] = useState<ReleaseDeployment[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [savingId, setSavingId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadReleases = useCallback(async (cursor: string | null = null, background = false) => {
    if (!user) return;
    if (cursor) setLoadingOlder(true);
    else if (background) setRefreshing(true);
    else setLoading(true);
    setError('');
    if (!cursor) setNotice('');
    try {
      const { data, error: requestError } = await invokeSystemOwnerAction({
        body: { action: 'release-history', cursor },
      });
      if (requestError) throw requestError;
      if (!data || !Array.isArray(data.deployments) || !data.deployments.every(isDeployment)
        || (data.nextCursor !== null && typeof data.nextCursor !== 'string')) {
        throw new Error('The system owner service returned invalid release history data.');
      }
      const fetched = data.deployments as ReleaseDeployment[];
      setDeployments((current) => cursor
        ? [...current, ...fetched.filter((item) => !current.some((existing) => existing.id === item.id))]
        : fetched);
      setDrafts((current) => ({
        ...Object.fromEntries(fetched.map((deployment) => [deployment.id, deployment.knownIssues])),
        ...(cursor ? current : {}),
      }));
      setNextCursor(data.nextCursor);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load Vercel release history.');
    } finally {
      if (cursor) setLoadingOlder(false);
      else {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [user]);

  useEffect(() => { void loadReleases(null); }, [loadReleases]);

  async function saveKnownIssues(event: FormEvent<HTMLFormElement>, deployment: ReleaseDeployment) {
    event.preventDefault();
    setSavingId(deployment.id);
    setError('');
    setNotice('');
    try {
      const knownIssues = drafts[deployment.id] ?? '';
      const { data, error: requestError } = await invokeSystemOwnerAction({
        body: {
          action: 'save-release-known-issues',
          vercelDeploymentId: deployment.id,
          knownIssues,
        },
      });
      if (requestError) throw requestError;
      if (data?.vercelDeploymentId !== deployment.id
        || typeof data.knownIssues !== 'string'
        || (data.updatedAt !== null && typeof data.updatedAt !== 'string')) {
        throw new Error('The system owner service returned an invalid known-issues update.');
      }
      setDeployments((current) => current.map((item) => item.id === deployment.id
        ? { ...item, knownIssues: data.knownIssues, knownIssuesUpdatedAt: data.updatedAt }
        : item));
      setDrafts((current) => ({ ...current, [deployment.id]: data.knownIssues }));
      setNotice(`Known issues saved for ${deployment.commit.sha.slice(0, 7) || deployment.id}.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save known issues.');
    } finally {
      setSavingId('');
    }
  }

  return <main className="system-owner-page">
    <header className="system-owner-header">
      <div>
        <span className="eyebrow">Operations · production deployments</span>
        <h1>Release history</h1>
        <p>Recent successful production deployments, linked commit changes, and owner-maintained known issues.</p>
      </div>
      <div className="system-owner-header-actions">
        <button className="button button-secondary" type="button" onClick={() => void loadReleases(null, true)} disabled={loading || refreshing}>
          <RefreshCw size={15} className={refreshing ? 'spin' : undefined} /> Refresh
        </button>
      </div>
    </header>

    {error && <ErrorState message={error} />}
    {notice && <p className="system-owner-release-notice" role="status">{notice}</p>}
    {loading && <LoadingState label="Loading production release history…" />}
    {!loading && !error && !deployments.length && <section className="content-card system-owner-panel">
      <div className="system-owner-release-empty">
        <History size={22} />
        <strong>No successful production deployments found</strong>
        <span>Check that VERCEL_PROJECT_ID and the Vercel token are configured for the system-owner-admin function.</span>
      </div>
    </section>}
    {!!deployments.length && <section className="system-owner-release-list" aria-label="Vercel production deployments">
      {deployments.map((deployment) => {
        const draft = drafts[deployment.id] ?? '';
        const saved = deployment.knownIssues;
        const changed = draft.trim() !== saved;
        return <article className="content-card system-owner-release-card" key={deployment.id}>
          <header className="system-owner-release-heading">
            <div className="system-owner-release-version">
              <span className="system-owner-release-status">{deployment.state}</span>
              <h2>{deployment.commit.sha ? deployment.commit.sha.slice(0, 7) : deployment.id.slice(0, 12)}</h2>
              <span>{deployment.name}</span>
            </div>
            <div className="system-owner-release-links">
              <a href={deployment.url} target="_blank" rel="noreferrer">Live deployment <ExternalLink size={13} /></a>
              <a href={deployment.inspectorUrl} target="_blank" rel="noreferrer">Vercel details <ExternalLink size={13} /></a>
            </div>
          </header>

          <div className="system-owner-release-meta">
            <span><History size={14} /> Deployed {formatDate(deployment.readyAt ?? deployment.createdAt)}</span>
            {deployment.commit.branch && <span><GitBranch size={14} /> {deployment.commit.branch}</span>}
            {deployment.commit.sha && <code>{deployment.commit.sha}</code>}
          </div>

          <section className="system-owner-release-changes">
            <h3>Changes</h3>
            <p>{deployment.commit.message || 'Vercel did not provide a linked commit message for this deployment.'}</p>
          </section>

          <form className="system-owner-release-issues" onSubmit={(event) => void saveKnownIssues(event, deployment)}>
            <label htmlFor={`release-issues-${deployment.id}`}>Known issues</label>
            {saved && <p className="system-owner-release-saved">{saved}</p>}
            {!saved && <p className="system-owner-release-none">No known issues have been recorded for this deployment.</p>}
            <textarea
              id={`release-issues-${deployment.id}`}
              value={draft}
              maxLength={3000}
              rows={3}
              placeholder="Record verified known issues, workarounds, or write “None known”."
              onChange={(event) => setDrafts((current) => ({ ...current, [deployment.id]: event.target.value }))}
            />
            <div className="system-owner-release-issue-footer">
              <small>{deployment.knownIssuesUpdatedAt ? `Updated ${formatDate(deployment.knownIssuesUpdatedAt)}` : 'Owner-maintained · up to 3,000 characters'}</small>
              <button className="button button-secondary" type="submit" disabled={!changed || savingId === deployment.id}>
                <Save size={14} /> {savingId === deployment.id ? 'Saving…' : 'Save issues'}
              </button>
            </div>
          </form>
        </article>;
      })}
    </section>}
    {!loading && nextCursor && <button className="button button-secondary system-owner-release-more" type="button" disabled={loadingOlder} onClick={() => void loadReleases(nextCursor)}>
      <RefreshCw size={14} className={loadingOlder ? 'spin' : undefined} /> {loadingOlder ? 'Loading older releases…' : 'Load older releases'}
    </button>}
    <p className="system-owner-muted">Loads production deployments from Vercel in pages of 100; use “Load older releases” to continue through the available history. Commit messages are the available change summary; known issues are maintained here by the system owner.</p>
  </main>;
}
