import { useCallback, useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { ErrorState, LoadingState } from './Feedback';
import { MfaAuthenticator } from './MfaAuthenticator';
import { useAuth } from '../contexts/AuthContext';
import { requireSupabase } from '../lib/supabase';

interface MfaPolicy {
  require_mfa: boolean;
  mfa_methods: string[];
}

type GateState = 'loading' | 'allowed' | 'required' | 'unsupported' | 'error';

export function MfaGate() {
  const { activeMembership } = useAuth();
  const location = useLocation();
  const [state, setState] = useState<GateState>('loading');
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const allowWorkspace = useCallback(() => setState('allowed'), []);
  const schoolId = activeMembership?.school_id;

  useEffect(() => {
    let active = true;
    if (!schoolId) {
      setState('allowed');
      return () => { active = false; };
    }
    setState('loading');
    setError('');
    void (async () => {
      try {
        const { data, error: policyError } = await requireSupabase().rpc('get_school_mfa_policy', {
          target_school: schoolId,
        });
        if (policyError) throw policyError;
        const policy = data as MfaPolicy | null;
        if (!policy || typeof policy.require_mfa !== 'boolean' || !Array.isArray(policy.mfa_methods)) {
          throw new Error('The school multi-factor policy returned an invalid response.');
        }
        const { data: assurance, error: assuranceError } = await requireSupabase().auth.mfa.getAuthenticatorAssuranceLevel();
        if (assuranceError) throw assuranceError;
        if (assurance.currentLevel === 'aal2') {
          if (active) setState('allowed');
          return;
        }
        if (!policy.require_mfa && assurance.nextLevel !== 'aal2') {
          if (active) setState('allowed');
          return;
        }
        if (!policy.require_mfa) {
          const { data: factors, error: factorsError } = await requireSupabase().auth.mfa.listFactors();
          if (factorsError) throw factorsError;
          const hasTotp = factors.totp.some((factor) => factor.status === 'verified');
          if (!hasTotp) {
            if (active) setState('allowed');
            return;
          }
        }
        if (active) {
          setState(!policy.require_mfa || policy.mfa_methods.includes('totp') ? 'required' : 'unsupported');
        }
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : 'Could not verify the school MFA requirement.');
          setState('error');
        }
      }
    })();
    return () => { active = false; };
  }, [location.pathname, schoolId, retryKey]);

  if (location.pathname === '/account-security') return <Outlet />;
  if (state === 'loading') return <div className="page-content"><LoadingState label="Checking your school’s sign-in security requirement…" /></div>;
  if (state === 'allowed') return <Outlet />;
  if (state === 'required') return <main className="mfa-gate">
    <MfaAuthenticator required onSatisfied={allowWorkspace} />
  </main>;
  if (state === 'unsupported') return <main className="mfa-gate"><div className="content-card">
    <ErrorState message="This school requires an MFA method that is not currently supported. Set up an authenticator app and ask the administrator to allow TOTP." />
    <Link className="button button-primary" to="/account-security">Set up an authenticator app</Link>
  </div></main>;
  return <main className="mfa-gate"><div className="content-card">
    <ErrorState message={error || 'Could not verify your school’s security policy. Access is paused until verification succeeds.'} />
    <button className="button button-primary" type="button" onClick={() => setRetryKey((key) => key + 1)}>Retry</button>
  </div></main>;
}
