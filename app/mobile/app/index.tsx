import { Redirect } from 'expo-router';
import { Loading } from '../src/components/ui';
import { useCampusAuth } from '../src/lib/auth-context';

export default function IndexScreen() {
  const { session, selectedSchool, loading, accessLoading } = useCampusAuth();
  if (loading || accessLoading) return <Loading label="Checking your school access…" />;
  if (!session) return <Redirect href="/login" />;
  if (!selectedSchool) return <Redirect href="/select-school" />;
  return <Redirect href="/(tabs)" />;
}
