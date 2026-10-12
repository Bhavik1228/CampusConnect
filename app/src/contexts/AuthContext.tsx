import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { notifyLoginAlert } from '../lib/auth-alerts';
import { requireSupabase, supabase } from '../lib/supabase';
import type { SchoolMembership } from '../types/database';

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  memberships: SchoolMembership[];
  activeMembership: SchoolMembership | null;
  loading: boolean;
  error: string | null;
  recoveryMode: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  createSchool: (name: string) => Promise<void>;
  selectSchool: (schoolId: string) => void;
  refreshMemberships: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const selectedSchoolKey = 'campus-connect-active-school';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [memberships, setMemberships] = useState<SchoolMembership[]>([]);
  const [activeSchoolId, setActiveSchoolId] = useState(
    () => localStorage.getItem(selectedSchoolKey) ?? '',
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recoveryMode, setRecoveryMode] = useState(false);

  const refreshMemberships = useCallback(async () => {
    const client = requireSupabase();
    const { data, error: queryError } = await client
      .from('school_memberships')
      .select('school_id, role, school:schools(id, name, timezone, address, contact_email, contact_phone, website)')
      .order('created_at');
    if (queryError) throw queryError;
    setMemberships((data ?? []) as unknown as SchoolMembership[]);
  }, []);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    let alive = true;
    const client = supabase;
    const initialize = async () => {
      const { data, error: sessionError } = await client.auth.getSession();
      if (!alive) return;
      if (sessionError) setError(sessionError.message);
      setSession(data.session);
      if (data.session) {
        try {
          await refreshMemberships();
        } catch (membershipError) {
          if (alive) setError(membershipError instanceof Error ? membershipError.message : 'Could not load school access.');
        }
      }
      if (alive) setLoading(false);
    };
    void initialize();
    const { data: listener } = client.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession);
      if (!nextSession) {
        setMemberships([]);
        setRecoveryMode(false);
        setLoading(false);
        return;
      }
      if (event === 'PASSWORD_RECOVERY') setRecoveryMode(true);
      if (event === 'USER_UPDATED') setRecoveryMode(false);
      if (event === 'SIGNED_IN') {
        setLoading(true);
        window.setTimeout(() => {
          void refreshMemberships()
            .catch((membershipError: unknown) => {
              setError(membershipError instanceof Error ? membershipError.message : 'Could not load school access.');
            })
            .finally(() => setLoading(false));
        }, 0);
      }
    });
    return () => {
      alive = false;
      listener.subscription.unsubscribe();
    };
  }, [refreshMemberships]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error: authError } = await requireSupabase().auth.signInWithPassword({ email, password });
    if (authError) {
      if (
        authError.code === 'invalid_credentials' ||
        authError.code === 'email_not_confirmed'
      ) {
        notifyLoginAlert('login_failed', email);
      }
      throw authError;
    }
    notifyLoginAlert('login_succeeded');
  }, []);

  const signUp = useCallback(async (name: string, email: string, password: string) => {
    const { data, error: authError } = await requireSupabase().auth.signUp({
      email,
      password,
      options: {
        data: { full_name: name.trim() },
        emailRedirectTo: `${window.location.origin}/login`,
      },
    });
    if (authError) throw authError;
    return Boolean(data.session);
  }, []);

  const signOut = useCallback(async () => {
    const { error: authError } = await requireSupabase().auth.signOut();
    if (authError) throw authError;
    setSession(null);
    setMemberships([]);
  }, []);

  const createSchool = useCallback(async (name: string) => {
    const { error: createError } = await requireSupabase().rpc('create_initial_school', {
      school_name: name.trim(),
    });
    if (createError) throw createError;
    await refreshMemberships();
  }, [refreshMemberships]);

  const selectSchool = useCallback((schoolId: string) => {
    localStorage.setItem(selectedSchoolKey, schoolId);
    setActiveSchoolId(schoolId);
  }, []);

  const activeMembership = memberships.find((item) => item.school_id === activeSchoolId) ?? memberships[0] ?? null;
  useEffect(() => {
    if (activeMembership && activeMembership.school_id !== activeSchoolId) {
      setActiveSchoolId(activeMembership.school_id);
      localStorage.setItem(selectedSchoolKey, activeMembership.school_id);
    }
  }, [activeMembership, activeSchoolId]);

  const value = useMemo<AuthContextValue>(() => ({
    session,
    user: session?.user ?? null,
    memberships,
    activeMembership,
    loading,
    error,
    recoveryMode,
    signIn,
    signUp,
    signOut,
    createSchool,
    selectSchool,
    refreshMemberships,
  }), [session, memberships, activeMembership, loading, error, recoveryMode, signIn, signUp, signOut, createSchool, selectSchool, refreshMemberships]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
