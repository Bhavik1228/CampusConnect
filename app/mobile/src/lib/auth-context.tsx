import Constants from 'expo-constants';
import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { requireSupabase } from './supabase';
import { supabase } from './supabase';
import type { MobileMembership } from './types';

interface AuthContextValue {
  session: Session | null;
  memberships: MobileMembership[];
  selectedSchool: MobileMembership | null;
  loading: boolean;
  accessLoading: boolean;
  accessError: string;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  selectSchool: (schoolId: string) => void;
  refreshAccess: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [memberships, setMemberships] = useState<MobileMembership[]>([]);
  const [selectedSchoolId, setSelectedSchoolId] = useState('');
  const [loading, setLoading] = useState(true);
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessError, setAccessError] = useState('');
  const loadingToken = useRef('');

  const registerSession = useCallback(async (currentSession: Session, force = false) => {
    if (!force && loadingToken.current === currentSession.access_token) return;
    loadingToken.current = currentSession.access_token;
    setAccessLoading(true);
    setAccessError('');
    try {
      const client = requireSupabase();
      const { data, error } = await client.rpc('register_mobile_app_session', {
        requested_platform: 'android',
        requested_app_version: Constants.expoConfig?.version ?? 'dev',
      });
      if (error) throw error;
      const nextMemberships = (data?.memberships ?? []) as MobileMembership[];
      setMemberships(nextMemberships);
      setSelectedSchoolId((selected) =>
        nextMemberships.some((item) => item.school_id === selected && item.eligible) ? selected : '');
    } catch (error) {
      loadingToken.current = '';
      setMemberships([]);
      setAccessError(error instanceof Error ? error.message : 'Mobile access could not be verified.');
      throw error;
    } finally {
      setAccessLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    if (!supabase) {
      setAccessError('Set the Supabase URL and anon key in the mobile app .env file.');
      setLoading(false);
      return () => { mounted = false; };
    }
    const client = supabase;
    const { data: authListener } = client.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return;
      setSession(nextSession);
      if (nextSession) {
        void Promise.resolve().then(() => registerSession(nextSession)).catch((error: unknown) => {
          console.error('Campus Connect could not verify mobile school access.', error);
        });
      } else {
        loadingToken.current = '';
        setMemberships([]);
        setSelectedSchoolId('');
      }
    });
    void client.auth.getSession().then(({ data, error }) => {
      if (!mounted) return;
      if (error) {
        setLoading(false);
        return;
      }
      const restoredSession = data.session;
      setSession(restoredSession);
      if (restoredSession) {
        void registerSession(restoredSession).catch((loadError: unknown) => {
          console.error('Campus Connect could not verify mobile school access.', loadError);
        }).finally(() => setLoading(false));
      } else {
        setLoading(false);
      }
    }).catch((error: unknown) => {
      console.error('Campus Connect could not restore the saved session.', error);
      if (mounted) setLoading(false);
    });
    return () => {
      mounted = false;
      authListener.subscription.unsubscribe();
    };
  }, [registerSession]);

  const signIn = useCallback(async (email: string, password: string) => {
    const client = requireSupabase();
    const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    if (error) throw error;
    if (!data.session) throw new Error('Sign-in did not create an active session.');
    setSession(data.session);
    await registerSession(data.session, true);
  }, [registerSession]);

  const signOut = useCallback(async () => {
    const client = requireSupabase();
    const { error: unregisterError } = await client.rpc('unregister_mobile_app_session');
    if (unregisterError) console.warn('The mobile session will expire normally; it could not be unregistered.', unregisterError.message);
    const { error } = await client.auth.signOut();
    if (error) throw error;
    loadingToken.current = '';
    setSession(null);
    setMemberships([]);
    setSelectedSchoolId('');
  }, []);

  const refreshAccess = useCallback(async () => {
    const currentSession = (await requireSupabase().auth.getSession()).data.session;
    if (!currentSession) throw new Error('Your session expired. Sign in again.');
    setSession(currentSession);
    await registerSession(currentSession, true);
  }, [registerSession]);

  const selectedSchool = memberships.find((item) => item.school_id === selectedSchoolId && item.eligible) ?? null;
  const value = useMemo<AuthContextValue>(() => ({
    session,
    memberships,
    selectedSchool,
    loading,
    accessLoading,
    accessError,
    signIn,
    signOut,
    selectSchool: (schoolId) => {
      const membership = memberships.find((item) => item.school_id === schoolId && item.eligible);
      if (!membership) throw new Error('This school has not enabled mobile access for your account.');
      setSelectedSchoolId(schoolId);
    },
    refreshAccess,
  }), [session, memberships, selectedSchool, loading, accessLoading, accessError, signIn, signOut, refreshAccess]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useCampusAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useCampusAuth must be used inside AuthProvider.');
  return value;
}
