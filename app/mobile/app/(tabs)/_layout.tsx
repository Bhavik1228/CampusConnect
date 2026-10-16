import { Redirect, Tabs } from 'expo-router';
import { Text } from 'react-native';
import { Loading, colors } from '../../src/components/ui';
import { useCampusAuth } from '../../src/lib/auth-context';
import { canUseModule } from '../../src/lib/validation';

export default function TabsLayout() {
  const { session, selectedSchool, loading, accessLoading } = useCampusAuth();
  if (loading || accessLoading) return <Loading label="Verifying access…" />;
  if (!session) return <Redirect href="/login" />;
  if (!selectedSchool) return <Redirect href="/select-school" />;

  return (
    <Tabs screenOptions={{
      headerStyle: { backgroundColor: colors.navy },
      headerTintColor: colors.white,
      headerTitleStyle: { fontWeight: '700' },
      tabBarActiveTintColor: colors.violet,
      tabBarInactiveTintColor: '#737B8D',
      tabBarStyle: { height: 64, paddingTop: 6, paddingBottom: 8, borderTopColor: colors.border },
      tabBarLabelStyle: { fontSize: 10, fontWeight: '600' },
    }}>
      <Tabs.Screen name="index" options={{ title: selectedSchool.school_name, tabBarLabel: 'Home', tabBarIcon: ({ color }) => <Text style={{ color }}>Home</Text> }} />
      <Tabs.Screen name="scan" options={{ title: 'Scan', tabBarLabel: 'Scan', tabBarIcon: ({ color }) => <Text style={{ color }}>Scan</Text> }} />
      <Tabs.Screen name="modules" options={{ title: 'Modules', tabBarLabel: 'Modules', tabBarIcon: ({ color }) => <Text style={{ color }}>Tools</Text> }} />
      <Tabs.Screen name="notifications" options={{
        title: 'Notifications', tabBarLabel: 'Alerts',
        href: canUseModule(selectedSchool, 'notifications') ? undefined : null,
        tabBarIcon: ({ color }) => <Text style={{ color }}>Alerts</Text>,
      }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarLabel: 'Profile', tabBarIcon: ({ color }) => <Text style={{ color }}>Me</Text> }} />
    </Tabs>
  );
}
