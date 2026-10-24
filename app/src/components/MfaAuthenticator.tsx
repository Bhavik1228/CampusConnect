import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { KeyRound, ShieldCheck, Trash2 } from 'lucide-react';
import QRCode from 'qrcode';
import { ErrorState, LoadingState, SuccessMessage } from './Feedback';
import { requireSupabase } from '../lib/supabase';

interface TotpFactor {
  id: string;
  factor_type: 'totp';
  status: 'verified' | 'unverified';
  friendly_name?: string;
  created_at: string;
}

interface ActiveChallenge {
  factorId: string;
  challengeId: string;
}

interface PendingEnrollment {
  id: string;
  secret: string;
  qrCode: string;
}

export function MfaAuthenticator({
  required = false,
  onSatisfied,
}: {
  required?: boolean;
  onSatisfied?: () => void;
}) {
  const [factors, setFactors] = useState<TotpFactor[]>([]);
  const [challenge, setChallenge] = useState<ActiveChallenge | null>(null);
  const [pendingEnrollment, setPendingEnrollment] = useState<PendingEnrollment | null>(null);
  const [removingFactorId, setRemovingFactorId] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const loadFactors = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [{ data: factorData, error: factorError }, { data: assurance, error: assuranceError }] = await Promise.all([
        client.auth.mfa.listFactors(),
        client.auth.mfa.getAuthenticatorAssuranceLevel(),
      ]);
      if (factorError) throw factorError;
      if (assuranceError) throw assuranceError;
      const verified = factorData.totp as TotpFactor[];
      setFactors(verified);
      if (required) {
        if (assurance.currentLevel === 'aal2') {
          onSatisfied?.();
        } else if (verified[0]) {
          const { data, error: challengeError } = await client.auth.mfa.challenge({ factorId: verified[0].id });
          if (challengeError) throw challengeError;
          setChallenge({ factorId: verified[0].id, challengeId: data.id });
        }
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load authenticator settings.');
    } finally {
      setLoading(false);
    }
  }, [onSatisfied, required]);

  useEffect(() => { void loadFactors(); }, [loadFactors]);

  async function addAuthenticator() {
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const { data, error: enrollError } = await requireSupabase().auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'Campus Connect authenticator',
        issuer: 'Campus Connect',
      });
      if (enrollError) throw enrollError;
      const qrCode = await QRCode.toDataURL(data.totp.uri, { errorCorrectionLevel: 'Q', margin: 2, width: 280 });
      setPendingEnrollment({ id: data.id, secret: data.totp.secret, qrCode });
      const { data: challengeData, error: challengeError } = await requireSupabase().auth.mfa.challenge({ factorId: data.id });
      if (challengeError) throw challengeError;
      setChallenge({ factorId: data.id, challengeId: challengeData.id });
      setSuccess('Scan the QR code with your authenticator app, then enter its current six-digit code.');
    } catch (enrollError) {
      setError(enrollError instanceof Error ? enrollError.message : 'Could not start authenticator setup.');
    } finally {
      setBusy(false);
    }
  }

  async function requestChallenge(factorId: string) {
    setBusy(true);
    setError('');
    try {
      const { data, error: challengeError } = await requireSupabase().auth.mfa.challenge({ factorId });
      if (challengeError) throw challengeError;
      setChallenge({ factorId, challengeId: data.id });
    } catch (challengeError) {
      setError(challengeError instanceof Error ? challengeError.message : 'Could not start authenticator verification.');
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!challenge || !/^\d{6,8}$/.test(code.trim())) {
      setError('Enter the current 6–8 digit code from your authenticator app.');
      return;
    }
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const { error: verifyError } = await requireSupabase().auth.mfa.verify({
        factorId: challenge.factorId,
        challengeId: challenge.challengeId,
        code: code.trim(),
      });
      if (verifyError) throw verifyError;
      if (removingFactorId) {
        const { error: removeError } = await requireSupabase().auth.mfa.unenroll({ factorId: removingFactorId });
        if (removeError) throw removeError;
        setRemovingFactorId('');
        setSuccess('Authenticator app removed from your account.');
      } else {
        setSuccess(pendingEnrollment ? 'Authenticator app verified and enabled.' : 'Identity verified.');
      }
      setChallenge(null);
      setPendingEnrollment(null);
      setCode('');
      await loadFactors();
      onSatisfied?.();
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : 'The authenticator code could not be verified.');
    } finally {
      setBusy(false);
    }
  }

  async function removeAuthenticator(factorId: string) {
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const { data: assurance, error: assuranceError } = await requireSupabase().auth.mfa.getAuthenticatorAssuranceLevel();
      if (assuranceError) throw assuranceError;
      if (assurance.currentLevel !== 'aal2') {
        const { data, error: challengeError } = await requireSupabase().auth.mfa.challenge({ factorId });
        if (challengeError) throw challengeError;
        setRemovingFactorId(factorId);
        setChallenge({ factorId, challengeId: data.id });
        setSuccess('Verify with this authenticator before removing it.');
        return;
      }
      const { error: removeError } = await requireSupabase().auth.mfa.unenroll({ factorId });
      if (removeError) throw removeError;
      setSuccess('Authenticator app removed from your account.');
      await loadFactors();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'Could not remove this authenticator.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingState label="Loading authenticator settings…" />;

  return (
    <section className="content-card mfa-card">
      <div className="section-heading">
        <div><span className="eyebrow">Account protection</span><h2>{required ? 'Multi-factor authentication required' : 'Authenticator apps'}</h2></div>
        <ShieldCheck size={19} className="muted-icon" />
      </div>
      <p>{required
        ? 'Verify your identity with an authenticator app to continue to this school workspace.'
        : 'Use an authenticator app such as Google Authenticator, Microsoft Authenticator, 1Password, or Authy to generate sign-in codes.'}</p>
      {error && <ErrorState message={error} />}
      {success && <SuccessMessage message={success} />}
      {pendingEnrollment && <div className="mfa-enrollment">
        <img src={pendingEnrollment.qrCode} alt="QR code for authenticator app setup" width="220" height="220" />
        <p>Scan this code in your authenticator app. If you cannot scan it, enter this setup key manually:</p>
        <code className="mfa-secret">{pendingEnrollment.secret}</code>
      </div>}
      {challenge && <form className="mfa-code-form" onSubmit={(event) => void submitCode(event)}>
        <label className="field"><span>{pendingEnrollment ? 'Authenticator verification code' : removingFactorId ? 'Code to confirm removal' : 'Sign-in verification code'}</span>
          <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6,8}" minLength={6} maxLength={8} required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 8))} disabled={busy} />
        </label>
        <button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Verifying…' : pendingEnrollment ? 'Verify and enable' : removingFactorId ? 'Verify and remove' : 'Verify and continue'}</button>
      </form>}
      {!challenge && pendingEnrollment && <button className="button button-primary" type="button" onClick={() => void requestChallenge(pendingEnrollment.id)} disabled={busy}>Retry authenticator verification</button>}
      {!challenge && required && factors[0] && !pendingEnrollment && <button className="button button-primary" type="button" onClick={() => void requestChallenge(factors[0].id)} disabled={busy}>Try verification again</button>}
      {!required && <div className="mfa-factor-list">
        {factors.length ? factors.map((factor) => <div className="mfa-factor" key={factor.id}>
          <span><KeyRound size={16} /><strong>{factor.friendly_name || 'Authenticator app'}</strong></span>
          <button className="button button-quiet" type="button" onClick={() => void removeAuthenticator(factor.id)} disabled={busy}><Trash2 size={14} />Remove</button>
        </div>) : <p>No authenticator app is currently enabled.</p>}
        {!pendingEnrollment && !challenge && <button className="button button-primary" type="button" onClick={() => void addAuthenticator()} disabled={busy}>Set up authenticator app</button>}
      </div>}
      {required && factors.length === 0 && !pendingEnrollment && !challenge && <div className="mfa-factor-list">
        <p>No verified authenticator app is linked to your account. Set one up to meet your school’s sign-in requirement.</p>
        <button className="button button-primary" type="button" onClick={() => void addAuthenticator()} disabled={busy}>Set up authenticator app</button>
      </div>}
      {required && <p className="settings-readonly">Need help? Contact your school administrator. Your school workspace remains locked until verification succeeds.</p>}
    </section>
  );
}
