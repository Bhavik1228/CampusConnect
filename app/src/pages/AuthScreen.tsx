import { useState, type FormEvent } from 'react';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getAuthErrorMessage } from '../lib/auth-errors';
import { requireSupabase } from '../lib/supabase';
import { Card, CardContent, Input } from '../components/ui';
import { Button } from '../components/ui/Button';

export function AuthScreen() {
  const { signIn, signUp, recoveryMode, finishPasswordRecovery } = useAuth();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function performSubmit() {
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

  function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void performSubmit();
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

  const heading = recoveryMode
    ? { eyebrow: 'Account recovery', title: 'Choose a new password', detail: 'Use a new password to secure your account.' }
    : mode === 'login'
      ? { eyebrow: 'Welcome back', title: 'Sign in to your workspace', detail: "Sign in to access your school's classes, records, learning and updates." }
      : { eyebrow: 'Get started', title: 'Create your account', detail: 'Create your account, then set up your school workspace.' };

  return (
    <main className="auth-layout min-h-screen bg-surface cc-flex-col md:cc-flex">
      {/* Aside: brand + copy (desktop) */}
      <section className="auth-aside hidden md:flex cc-flex-col items-start justify-center gap-6 px-8 py-20">
        <div className="brand cc-flex items-center gap-3">
          <ShieldCheck size={20} />
          <span className="font-bold text-lg cc-text-ink">Campus Connect</span>
        </div>
        <div className="auth-aside-copy max-w-xs">
          <h1 className="cc-text-3xl cc-font-bold cc-leading-tight cc-text-ink">
            Welcome to your school workspace.
          </h1>
          <p className="cc-text-lg cc-leading-relaxed cc-text-text mt-3">
            Manage people, classes, attendance, and learning from a workspace organized for your school community.
          </p>
          <div className="auth-aside-note mt-6 cc-flex items-start gap-3 cc-text-sm cc-text-muted">
            <ShieldCheck size={16} className="mt-0.5" />
            <span>Secure, school-scoped access for every role.</span>
          </div>
        </div>
        <span className="auth-footer-note cc-text-xs cc-text-muted">
          Your school data stays within your authorized workspace.
        </span>
      </section>

      {/* Panel: sign-in / sign-up form */}
      <section className="auth-panel cc-flex-1 cc-flex items-center justify-center px-6 py-12 md:px-0">
        <Card className="auth-card w-full max-w-md">
          <CardContent className="pt-8 pb-12 px-8">
            <form onSubmit={handleFormSubmit}>
              <div className="mb-2">
                <span className="eyebrow cc-text-primary font-semibold tracking-wide">{heading.eyebrow}</span>
                <h2 className="cc-text-2xl cc-font-bold cc-leading-tight cc-text-ink mt-1">{heading.title}</h2>
                <p className="cc-text-sm cc-text-muted mt-3 leading-relaxed">{heading.detail}</p>
              </div>

              {!recoveryMode && mode === 'signup' && (
                <Input label="Full name" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
              )}
              {!recoveryMode && (
                <Input label="Email address" type="email" placeholder="you@school.edu" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
              )}
              <Input
                label="Password"
                type="password"
                placeholder="At least 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete={mode === 'login' && !recoveryMode ? 'current-password' : 'new-password'}
              />

              {!recoveryMode && mode === 'login' && (
                <button type="button" className="text-sm cc-text-primary font-semibold hover:underline cc-block mt-1" onClick={() => void resetPassword()} disabled={busy}>
                  Forgot password?
                </button>
              )}

              {error && <p className="cc-text-sm cc-text-danger" role="alert">{error}</p>}
              {message && <p className="cc-text-sm cc-text-success" role="status">{message}</p>}

              <Button variant="primary" size="large" disabled={busy} type="submit" className="mt-4 w-full">
                {busy ? 'Please wait…' : recoveryMode ? 'Update password' : mode === 'login' ? 'Sign in' : 'Create account'} <ArrowRight size={17} />
              </Button>
            </form>

            {!recoveryMode && (
              <p className="mt-6 cc-text-sm cc-text-text">
                {mode === 'login' ? 'New to Campus Connect?' : 'Already have an account?'}
                <button
                  className="ml-1 cc-text-primary font-semibold hover:underline"
                  type="button"
                  onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); setMessage(''); }}
                >
                  {mode === 'login' ? 'Create account' : 'Sign in'}
                </button>
              </p>
            )}
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
