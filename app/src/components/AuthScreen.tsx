import { useState, type FormEvent } from 'react';
import { ArrowRight, BookOpenCheck, Building2, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getAuthErrorMessage } from '../lib/auth-errors';
import { requireSupabase } from '../lib/supabase';

export function AuthScreen() {
  const { signIn, signUp, recoveryMode, finishPasswordRecovery } = useAuth();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (recoveryMode) {
        const { error: updateError } = await requireSupabase().auth.updateUser({ password });
        if (updateError) throw updateError;
        const { error: setupError } = await requireSupabase().functions.invoke('system-owner-admin', {
          body: { action: 'complete-password-setup' },
        });
        if (setupError) throw setupError;
        finishPasswordRecovery();
        setMessage('Your password has been updated.');
      } else if (mode === 'login') {
        await signIn(email.trim(), password);
      } else {
        const hasSession = await signUp(name, email.trim(), password);
        if (!hasSession) setMessage('Check your email to confirm your account, then sign in to continue.');
      }
    } catch (submitError) {
      setError(getAuthErrorMessage(submitError));
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword() {
    setError('');
    setMessage('');
    if (!email.trim()) {
      setError('Enter your account email first.');
      return;
    }
    setBusy(true);
    try {
      const { error: resetError } = await requireSupabase().auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/login`,
      });
      if (resetError) throw resetError;
      setMessage('If this address has an account, a password reset link will be sent.');
    } catch (resetError) {
      setError(getAuthErrorMessage(resetError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-aside">
        <div className="brand brand-light"><span className="brand-mark"><BookOpenCheck size={20} /></span><span>Campus Connect</span></div>
        <div className="auth-aside-copy">
          <span className="eyebrow">School information + learning management</span>
          <h1>Everything your school needs, connected.</h1>
          <p>Manage people, classes, attendance, and learning from a workspace organized for your school community.</p>
          <div className="auth-aside-note"><Building2 size={18} />Secure, school-scoped access for every role.</div>
        </div>
        <span className="auth-footer-note">Your school data stays within your authorized workspace.</span>
      </section>
      <section className="auth-panel">
        <form className="auth-card" onSubmit={submit}>
          <div className="mobile-brand brand"><span className="brand-mark"><BookOpenCheck size={20} /></span><span>Campus Connect</span></div>
          <div className="auth-heading">
            <span className="eyebrow">{recoveryMode ? 'Account recovery' : mode === 'login' ? 'Welcome back' : 'Get started'}</span>
            <h2>{recoveryMode ? 'Choose a new password' : mode === 'login' ? 'Sign in to your workspace' : 'Create your account'}</h2>
            <p>{recoveryMode ? 'Use a new password to secure your account.' : mode === 'login' ? 'Use your school account to continue.' : 'Create your account, then set up your school workspace.'}</p>
          </div>
          {!recoveryMode && mode === 'signup' && <label className="field"><span>Full name</span><input autoComplete="name" required value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" /></label>}
          {!recoveryMode && <label className="field"><span>Email address</span><input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@school.edu" /></label>}
          <label className="field">
            <span>Password</span>
            <span className="password-wrap">
              <input type={showPassword ? 'text' : 'password'} autoComplete={mode === 'login' && !recoveryMode ? 'current-password' : 'new-password'} minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters" />
              <button className="icon-button password-toggle" type="button" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button>
            </span>
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          {message && <p className="form-success" role="status">{message}</p>}
          <button className="button button-primary full-width" disabled={busy} type="submit">{busy ? 'Please wait…' : recoveryMode ? 'Update password' : mode === 'login' ? 'Sign in' : 'Create account'}{!busy && <ArrowRight size={17} />}</button>
          {!recoveryMode && mode === 'login' && <button className="text-button forgot-button" type="button" onClick={() => void resetPassword()} disabled={busy}>Forgot password?</button>}
          {!recoveryMode && <p className="auth-switch">{mode === 'login' ? 'New to Campus Connect?' : 'Already have an account?'} <button className="text-button" type="button" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); setMessage(''); }}>{mode === 'login' ? 'Create account' : 'Sign in'}</button></p>}
        </form>
      </section>
    </main>
  );
}
