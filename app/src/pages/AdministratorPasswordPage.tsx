import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ArrowRight, ShieldAlert } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { ErrorState, LoadingState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

export function AdministratorPasswordPage() {
  const { user, loading, signOut } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  if (loading) return <div className="full-screen-loading"><LoadingState label="Checking your account…" /></div>;
  if (!user) return <Navigate to="/login" replace />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (password.length < 12) {
      setError('Choose a password with at least 12 characters.');
      return;
    }
    if (password !== confirmation) {
      setError('The passwords do not match.');
      return;
    }
    setSaving(true);
    try {
      const { error: updateError } = await requireSupabase().auth.updateUser({ password });
      if (updateError) throw updateError;
      const { error: setupError } = await requireSupabase().functions.invoke('system-owner-admin', {
        body: { action: 'complete-password-setup' },
      });
      if (setupError) throw setupError;
      navigate('/system-owner', { replace: true });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not update your password.');
    } finally {
      setSaving(false);
    }
  }

  async function logout() {
    try {
      await signOut();
    } catch (signOutError) {
      setError(signOutError instanceof Error ? signOutError.message : 'Could not sign out.');
    }
  }

  return <main className="config-page">
    <form className="config-card" onSubmit={(event) => void submit(event)}>
      <span className="brand-mark"><ShieldAlert size={19} /></span>
      <span className="eyebrow">Administrator account setup</span>
      <h1>Choose your password</h1>
      <p>Your temporary password must be replaced before you can access platform administration.</p>
      <label className="field"><span>New password</span>
        <input type="password" autoComplete="new-password" minLength={12} required value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>
      <label className="field"><span>Confirm new password</span>
        <input type="password" autoComplete="new-password" minLength={12} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
      </label>
      {error && <ErrorState message={error} />}
      <button className="button button-primary full-width" type="submit" disabled={saving}>{saving ? 'Updating…' : 'Set password'}{!saving && <ArrowRight size={16} />}</button>
      <button className="text-button" type="button" onClick={() => void logout()} disabled={saving}>Sign out</button>
    </form>
  </main>;
}
