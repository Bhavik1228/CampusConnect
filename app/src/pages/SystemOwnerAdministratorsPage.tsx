import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Check, Mail, RefreshCw, ShieldCheck, UserRoundPlus, X } from 'lucide-react';
import { useOutletContext } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type Administrator = {
  profile_id: string;
  email: string;
  created_at: string;
  revoked_at: string | null;
  password_setup_pending: boolean;
};

type ChangeRequest = {
  id: string;
  requested_by_email: string;
  action: string;
  request_payload: Record<string, unknown>;
  status: 'pending' | 'processing' | 'applied' | 'denied' | 'failed' | 'execution_unknown';
  reviewed_at: string | null;
  result_message: string | null;
  created_at: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dateLabel(value: string) {
  return new Date(value).toLocaleString();
}

function actionLabel(action: string) {
  return action.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function SystemOwnerAdministratorsPage() {
  const { administrator: isAdministrator } = useOutletContext<{ administrator: boolean }>();
  const [administrators, setAdministrators] = useState<Administrator[]>([]);
  const [requests, setRequests] = useState<ChangeRequest[]>([]);
  const [email, setEmail] = useState('');
  const [temporaryPassword, setTemporaryPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const results = await Promise.all([
        isAdministrator ? Promise.resolve(null) : client.functions.invoke('system-owner-admin', { body: { action: 'list-administrators' } }),
        client.functions.invoke('system-owner-admin', { body: { action: 'list-change-requests' } }),
      ]);
      const [administratorResult, requestResult] = results;
      if (administratorResult?.error) throw administratorResult.error;
      if (requestResult.error) throw requestResult.error;
      if (!isRecord(requestResult.data) || !Array.isArray(requestResult.data.requests)
        || (administratorResult && (!isRecord(administratorResult.data) || !Array.isArray(administratorResult.data.administrators)))) {
        throw new Error('The system owner service returned invalid administrator data.');
      }
      setAdministrators(administratorResult
        ? administratorResult.data.administrators as Administrator[]
        : []);
      setRequests(requestResult.data.requests as ChangeRequest[]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load administrators and approval requests.');
    } finally {
      setLoading(false);
    }
  }, [isAdministrator]);

  useEffect(() => { void load(); }, [load]);

  async function addAdministrator(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWorking(true);
    setError('');
    setNotice('');
    try {
      const { error: createError } = await requireSupabase().functions.invoke('system-owner-admin', {
        body: { action: 'create-administrator', email: email.trim(), password: temporaryPassword },
      });
      if (createError) throw createError;
      setEmail('');
      setTemporaryPassword('');
      setNotice('Administrator added. The welcome email contains a secure password setup link.');
      await load();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not add the administrator.');
    } finally {
      setWorking(false);
    }
  }

  async function setAdministratorStatus(account: Administrator, enabled: boolean) {
    setWorking(true);
    setError('');
    setNotice('');
    try {
      const { error: statusError } = await requireSupabase().functions.invoke('system-owner-admin', {
        body: { action: 'set-administrator-status', administratorId: account.profile_id, enabled },
      });
      if (statusError) throw statusError;
      setNotice(`${account.email} ${enabled ? 'enabled' : 'disabled'}.`);
      await load();
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : 'Could not update administrator access.');
    } finally {
      setWorking(false);
    }
  }

  async function reviewRequest(request: ChangeRequest, decision: 'approved' | 'denied') {
    setWorking(true);
    setError('');
    setNotice('');
    try {
      const { data, error: reviewError } = await requireSupabase().functions.invoke('system-owner-admin', {
        body: { action: 'review-change-request', requestId: request.id, decision },
      });
      if (reviewError) throw reviewError;
      if (decision === 'approved' && data?.request?.status !== 'applied') {
        throw new Error(data?.request?.result_message ?? 'The approved change could not be applied.');
      }
      setNotice(decision === 'approved' ? 'Request approved and the change was applied.' : 'Request denied.');
      await load();
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Could not review the change request.');
      await load();
    } finally {
      setWorking(false);
    }
  }

  return <main className="system-owner-page">
    <header className="system-owner-header">
      <div>
        <span className="eyebrow">{isAdministrator ? 'Read-only platform access' : 'Platform administration'}</span>
        <h1>{isAdministrator ? 'My approval requests' : 'Administrators & approvals'}</h1>
        <p>{isAdministrator
          ? 'Review the status of platform changes you have submitted for owner approval.'
          : 'Manage administrator accounts and review requested platform changes.'}</p>
      </div>
      <button className="button button-secondary" type="button" onClick={() => void load()} disabled={loading || working}>
        <RefreshCw size={15} /> Refresh
      </button>
    </header>

    {error && <ErrorState message={error} />}
    {notice && <p className="inline-success" role="status">{notice}</p>}
    {loading ? <LoadingState label="Loading administrator data…" /> : <>
      {!isAdministrator && <>
        <section className="content-card system-owner-panel">
          <div className="system-owner-panel-heading">
            <div><span className="eyebrow">Account access</span><h2>Add an administrator</h2>
              <p>They can view System Owner features. Changes require your approval. The temporary password is never included in email; give it to the administrator securely.</p>
            </div><UserRoundPlus size={18} />
          </div>
          <form className="system-owner-admin-form" onSubmit={(event) => void addAdministrator(event)}>
            <label className="field"><span>Email address</span><input type="email" autoComplete="email" required maxLength={320} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <label className="field"><span>Temporary password</span><input type="password" autoComplete="new-password" required minLength={12} maxLength={72} value={temporaryPassword} onChange={(event) => setTemporaryPassword(event.target.value)} /></label>
            <button className="button button-primary" type="submit" disabled={working}><Mail size={15} />{working ? 'Adding…' : 'Add administrator'}</button>
          </form>
        </section>

        <section className="content-card system-owner-panel">
          <div className="system-owner-panel-heading"><div><span className="eyebrow">Current access</span><h2>Administrator accounts</h2></div><ShieldCheck size={18} /></div>
          {administrators.length ? <div className="system-owner-administrator-list">{administrators.map((account) => <article key={account.profile_id}>
            <div><strong>{account.email}</strong><small>Added {dateLabel(account.created_at)}{account.password_setup_pending ? ' · password setup required' : ''}</small></div>
            <span className={`system-owner-status ${account.revoked_at ? 'inactive' : 'active'}`}>{account.revoked_at ? 'Disabled' : 'Active'}</span>
            <button className="button button-quiet" type="button" onClick={() => void setAdministratorStatus(account, Boolean(account.revoked_at))} disabled={working}>
              {account.revoked_at ? 'Enable' : 'Disable'}
            </button>
          </article>)}</div> : <p className="system-owner-empty">No administrators have been added.</p>}
        </section>
      </>}

      <section className="content-card system-owner-panel">
        <div className="system-owner-panel-heading">
          <div><span className="eyebrow">{isAdministrator ? 'Change history' : 'Approval inbox'}</span><h2>{isAdministrator ? 'Submitted requests' : 'Administrator change requests'}</h2>
            <p>{isAdministrator ? 'Changes are applied only after the system owner approves them.' : 'Approved requests are applied automatically and recorded here.'}</p>
          </div><ShieldCheck size={18} />
        </div>
        {requests.length ? <div className="system-owner-change-list">{requests.map((request) => <article key={request.id}>
          <div className="system-owner-change-heading">
            <div><strong>{actionLabel(request.action)}</strong><small>{request.requested_by_email} · {dateLabel(request.created_at)}</small></div>
            <span className={`system-owner-status ${request.status}`}>{request.status.replace(/_/g, ' ')}</span>
          </div>
          <details><summary>Review requested change</summary><pre>{JSON.stringify(request.request_payload, null, 2)}</pre></details>
          {request.result_message && <p className="system-owner-change-result">{request.result_message}</p>}
          {!isAdministrator && request.status === 'pending' && <div className="system-owner-actions">
            <button className="button button-primary" type="button" onClick={() => void reviewRequest(request, 'approved')} disabled={working}><Check size={15} />Approve & apply</button>
            <button className="button button-quiet" type="button" onClick={() => void reviewRequest(request, 'denied')} disabled={working}><X size={15} />Deny</button>
          </div>}
        </article>)}</div> : <p className="system-owner-empty">{isAdministrator ? 'You have not submitted any change requests.' : 'No administrator changes are waiting for approval.'}</p>}
      </section>
    </>}
  </main>;
}
