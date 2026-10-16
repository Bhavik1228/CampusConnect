import { useEffect } from 'react';
import { Redirect, useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { Button, Card, Loading, Message, Page, colors } from '../src/components/ui';
import { useCampusAuth } from '../src/lib/auth-context';

export default function SelectSchoolScreen() {
  const router = useRouter();
  const { session, memberships, selectedSchool, loading, accessLoading, accessError, selectSchool, refreshAccess, signOut } = useCampusAuth();
  useEffect(() => {
    if (selectedSchool) router.replace('/(tabs)');
  }, [selectedSchool, router]);

  if (loading || accessLoading) return <Loading label="Checking which schools allow mobile access…" />;
  if (!session) return <Redirect href="/login" />;

  const enabledMemberships = memberships.filter((membership) => membership.eligible);
  return (
    <Page title="Your schools" subtitle="Choose an enabled school workspace. Web access is not affected by a school's mobile setting.">
      {accessError ? <Message variant="error">{accessError}</Message> : null}
      {enabledMemberships.length === 0
        ? <Message variant="info">
          {memberships.length === 0
            ? 'This account is not linked to a school yet. Ask your school administrator to add your account.'
            : 'No school has enabled mobile access for your role, or the System Owner has suspended mobile access platform-wide.'}
        </Message>
        : enabledMemberships.map((membership) => (
          <Pressable key={membership.school_id} onPress={() => {
            selectSchool(membership.school_id);
            router.replace('/(tabs)');
          }}>
            <Card style={{ borderColor: colors.violet }}>
              <Text style={{ color: colors.text, fontSize: 18, fontWeight: '800' }}>{membership.school_name}</Text>
              <Text style={{ color: colors.muted, textTransform: 'capitalize' }}>{membership.role.replaceAll('_', ' ')}</Text>
              <Text style={{ color: colors.violet, fontWeight: '700' }}>{membership.accessible_modules.length} mobile modules available</Text>
            </Card>
          </Pressable>
        ))}
      {memberships.filter((item) => !item.eligible).map((membership) => (
        <Card key={membership.school_id}>
          <Text style={{ color: colors.text, fontWeight: '700' }}>{membership.school_name}</Text>
          <Text style={{ color: colors.muted, fontSize: 13 }}>
            {!membership.school_active ? 'School access is currently suspended.'
              : !membership.platform_enabled ? 'Mobile access is suspended platform-wide.'
              : !membership.mobile_enabled ? 'Your school has not enabled Android access.'
                : 'Android access has not been granted to your school role.'}
          </Text>
        </Card>
      ))}
      <View style={{ gap: 10 }}>
        <Button title="Refresh access" variant="secondary" onPress={() => void refreshAccess()} />
        <Button title="Sign out" variant="secondary" onPress={() => void signOut()} />
      </View>
    </Page>
  );
}
