import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider } from '../src/lib/auth-context';
import { colors } from '../src/components/ui';

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="light" />
      <Stack screenOptions={{
        headerStyle: { backgroundColor: colors.navy },
        headerTintColor: colors.white,
        headerTitleStyle: { fontWeight: '700' },
        contentStyle: { backgroundColor: colors.canvas },
      }}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ title: 'Campus Connect' }} />
        <Stack.Screen name="select-school" options={{ title: 'Choose your school' }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="visitors" options={{ title: 'Visitor management' }} />
        <Stack.Screen name="library" options={{ title: 'Library' }} />
        <Stack.Screen name="health" options={{ title: 'Student health' }} />
      </Stack>
    </AuthProvider>
  );
}
