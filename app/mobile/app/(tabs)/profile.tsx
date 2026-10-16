import { useState } from 'react';
import { Redirect } from 'expo-router';
import { Text, View } from 'react-native';
import { Button, Card, Message, Page, colors } from '../../src/components/ui';
import { useCampusAuth } from '../../src/lib/auth-context';
import * as Notifications from 'expo-notifications';

export default function ProfileScreen() {
  const { session, selectedSchool, refreshAccess, signOut } = useCampusAuth();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  if (!session) return <Redirect href="/login" />;

  async function refresh() {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await refreshAccess();
      setNotice('Access refreshed. Disabled school or platform access is enforced on backend requests.');
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Could not refresh mobile access.');
    } finally {
      setBusy(false);
    }
  }

  async function requestNotifications() {
    setError('');
    setNotice('');
    try {
      const permission = await Notifications.getPermissionsAsync();
      const result = permission.granted ? permission : await Notifications.requestPermissionsAsync();
      setNotice(result.granted
        ? 'Device notification permission is enabled. Push delivery is not configured for this project yet; in-app notifications remain available.'
        : 'Device notification permission was not granted. In-app notifications are unaffected.');
    } catch (notificationError) {
      setError(notificationError instanceof Error ? notificationError.message : 'Could not check notification permission.');
    }
  }

  return (
    <Page title="Profile" subtitle="Account and mobile access">
      <Card>
        <Text style={{ color: colors.text, fontSize: 18, fontWeight: '800' }}>{session.user.user_metadata.full_name || 'Campus Connect user'}</Text>
        <Text style={{ color: colors.muted }}>{session.user.email}</Text>
        {selectedSchool && <View style={{ marginTop: 8, gap: 3 }}>
          <Text style={{ color: colors.text, fontWeight: '700' }}>{selectedSchool.school_name}</Text>
          <Text style={{ color: colors.muted, textTransform: 'capitalize' }}>{selectedSchool.role.replaceAll('_', ' ')}</Text>
        </View>}
      </Card>
      <Card>
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}>Connection and permissions</Text>
        <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 19 }}>Camera permission is requested only when you open the scanner. Sensitive health records are not stored offline.</Text>
        <Button title="Refresh school access" variant="secondary" disabled={busy} onPress={() => void refresh()} />
        <Button title="Configure device notification permission" variant="secondary" onPress={() => void requestNotifications()} />
      </Card>
      {error ? <Message variant="error">{error}</Message> : null}
      {notice ? <Message variant="success">{notice}</Message> : null}
      <Button title="Sign out" variant="danger" onPress={() => {
        void signOut().catch((signOutError: unknown) =>
          setError(signOutError instanceof Error ? signOutError.message : 'Could not sign out.'));
      }} />
    </Page>
  );
}
