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

  const signInLabel = recoveryMode ? 'Update password' : mode === 'login' ? 'Sign in' : 'Create account';

  return (
    <main className="cc-auth-layout">
      <section className="cc-auth-aside">
        <div className="cc-brand"><span className="cc-brand-mark"><BookOpenCheck size={20} /></span><span>Campus Connect</span></div>
        <div className="cc-auth-aside-copy">
          <h1>Welcome to your school workspace.</h1>
          <p>Manage people, classes, attendance, and learning from a workspace organized for your school community.</p>
          <div className="cc-auth-aside-note"><Building2 size={18} />Secure, school-scoped access for every role.</div>
        </div>
        <span className="cc-auth-footer-note">Your school data stays within your authorized workspace.</span>
      </section>
      <section className="cc-auth-panel">
        <form className="cc-auth-card" onSubmit={submit}>
          <div className="cc-brand cc-brand-mobile"><span className="cc-brand-mark"><BookOpenCheck size={20} /></span><span>Campus Connect</span></div>
          <div className="cc-auth-heading">
            <span className="eyebrow">{recoveryMode ? 'Account recovery' : mode === 'login' ? 'Welcome back' : 'Get started'}</span>
            <h2>{recoveryMode ? 'Choose a new password' : mode === 'login' ? 'Sign in to your workspace' : 'Create your account'}</h2>
            <p>{recoveryMode ? 'Use a new password to secure your account.' : mode === 'login' ? "Sign in to access your school's classes, records, learning and updates." : 'Create your account, then set up your school workspace.'}</p>
          </div>
          {!recoveryMode && mode === 'signup' && <label className="cc-field"><span>Full name</span><input autoComplete="name" required value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" /></label>}
          {!recoveryMode && <label className="cc-field"><span>Email address</span><input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@school.edu" /></label>}
          <label className="cc-field">
            <span>Password</span>
            <span className="cc-password-wrap">
              <input type={showPassword ? 'text' : 'password'} autoComplete={mode === 'login' && !recoveryMode ? 'current-password' : 'new-password'} minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters" />
              <button className="cc-icon-btn" type="button" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button>
            </span>
          </label>
          {!recoveryMode && mode === 'login' && <button className="cc-link-btn cc-forgot-btn" type="button" onClick={() => void resetPassword()} disabled={busy}>Forgot password?</button>}
          {error && <p className="cc-form-error" role="alert">{error}</p>}
          {message && <p className="cc-form-success" role="status">{message}</p>}
          <button className="cc-btn cc-btn-primary cc-btn-full" disabled={busy} type="submit">{busy ? 'Please wait…' : signInLabel}{!busy && <ArrowRight size={17} />}</button>
          {!recoveryMode && <p className="cc-auth-switch">{mode === 'login' ? 'New to Campus Connect?' : 'Already have an account?'} <button className="cc-link-btn" type="button" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); setMessage(''); }}>{mode === 'login' ? 'Create account' : 'Sign in'}</button></p>}
        </form>
      </section>
    </main>
  );
}
