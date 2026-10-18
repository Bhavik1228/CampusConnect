import { useState } from 'react';
import { Link, Redirect, useLocalSearchParams } from 'expo-router';
import { KeyboardAvoidingView, Platform, Text, View, StyleSheet } from 'react-native';
import { Button, Card, Field, Loading, Message, colors } from '../src/components/ui';
import { useCampusAuth } from '../src/lib/auth-context';
import { requireSupabase, supabase } from '../src/lib/supabase';

export default function LoginScreen() {
  const { school } = useLocalSearchParams<{ school?: string }>();
  const { session, loading, accessError, signIn } = useCampusAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  if (loading) return <Loading label="Restoring your secure session…" />;
  if (session) return <Redirect href={school ? { pathname: '/select-school', params: { school } } : '/select-school'} />;

  async function submit() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await signIn(email, password);
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword() {
    if (!supabase) {
      setError('Mobile app configuration is missing.');
      return;
    }
    if (!email.trim()) {
      setError('Enter your email address first to request a password reset.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { error: resetError } = await requireSupabase().auth.resetPasswordForEmail(email.trim());
      if (resetError) throw resetError;
      setNotice('If the account exists, a password reset message will be sent to the address.');
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : 'The password reset request failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.hero}>
        <Text style={styles.brand}>CAMPUS CONNECT</Text>
        <Text style={styles.tagline}>School tools, ready when you are.</Text>
      </View>
      <Card>
        <Text style={styles.heading}>Sign in</Text>
        <Text style={styles.description}>Use your existing Campus Connect account.</Text>
        {accessError ? <Message variant="error">{accessError}</Message> : null}
        {error ? <Message variant="error">{error}</Message> : null}
        {notice ? <Message variant="success">{notice}</Message> : null}
        <Field label="Email address" autoCapitalize="none" keyboardType="email-address" textContentType="emailAddress" autoComplete="email" value={email} onChangeText={setEmail} editable={!busy} />
        <Field label="Password" secureTextEntry textContentType="password" autoComplete="password" value={password} onChangeText={setPassword} editable={!busy} onSubmitEditing={() => void submit()} />
        <Button title={busy ? 'Signing in…' : 'Sign in'} disabled={busy || !email.trim() || !password} onPress={() => void submit()} />
        <Button title="Forgot password?" variant="secondary" disabled={busy} onPress={() => void resetPassword()} />
        <Link href="https://campusconnect-khaki-nine.vercel.app/login" style={styles.webLink}>Need an account? Contact your school administrator.</Link>
      </Card>
      <Text style={styles.footer}>Your school must enable Android access before you can use the mobile app.</Text>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.navy, padding: 20, justifyContent: 'center', gap: 22 },
  hero: { gap: 5 },
  brand: { color: '#C7BDFF', fontSize: 14, fontWeight: '800', letterSpacing: 2 },
  tagline: { color: colors.white, fontSize: 23, fontWeight: '700' },
  heading: { color: colors.text, fontSize: 22, fontWeight: '800' },
  description: { color: colors.muted, fontSize: 14 },
  webLink: { color: '#5842CC', fontSize: 13, lineHeight: 19 },
  footer: { color: '#D0D5E8', textAlign: 'center', fontSize: 12, lineHeight: 18 },
});
