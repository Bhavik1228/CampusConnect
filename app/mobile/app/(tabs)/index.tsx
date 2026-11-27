import { Link } from 'expo-router';
import { Image, Text, View } from 'react-native';
import { BodyText, Card, Heading, Page, colors } from '../../src/components/ui';
import { useCampusAuth } from '../../src/lib/auth-context';
import { canUseModule, canAccessScreen } from '../../src/lib/validation';

export default function HomeScreen() {
  const { selectedSchool, session } = useCampusAuth();
  if (!selectedSchool) return null;
  const name = session?.user.user_metadata.full_name || session?.user.email || 'Campus Connect user';
  const modules = [
    { id: 'visitors' as const, label: 'Visitor desk', description: 'Register visitors and manage entry badges.', path: '/visitors' as const },
    { id: 'library' as const, label: 'Library', description: 'Scan ISBNs, search books, and manage checkout tasks.', path: '/library' as const },
    { id: 'health' as const, label: 'Student health', description: 'Record clinic visits and review authorised history.', path: '/health' as const },
    { id: 'students' as const, label: 'Student directory', description: 'Search the school student directory.', path: '/students' as const },
    { id: 'teachers' as const, label: 'Teachers & staff', description: 'View the school staff directory.', path: '/teachers' as const },
    { id: 'attendance' as const, label: 'Attendance', description: 'Take and submit class registers.', path: '/attendance' as const },
    { id: 'timetable' as const, label: 'Timetable', description: 'View class and teacher timetables.', path: '/timetable' as const },
    { id: 'finance' as const, label: 'Finance', description: 'View fees and record payments.', path: '/finance' as const },
  ].filter((item) => {
    if (item.id === 'visitors' || item.id === 'library' || item.id === 'health') {
      return canUseModule(selectedSchool, item.id);
    }
    return canAccessScreen(selectedSchool, item.id);
  });

  return (
    <Page title={`Hello, ${name.split(' ')[0]}`} subtitle={`${selectedSchool.school_name} · ${selectedSchool.role.replaceAll('_', ' ')}`}>
      {selectedSchool.accessible_modules.length === 0
        ? <Card><Heading>No mobile modules enabled</Heading><BodyText muted>Ask a school administrator to enable mobile features for your role.</BodyText></Card>
        : null}
      <Card style={{ backgroundColor: colors.navy, borderColor: colors.navy }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          {selectedSchool.school_logo_path?.startsWith('https://')
            ? <Image source={{ uri: selectedSchool.school_logo_path }} accessibilityLabel={`${selectedSchool.school_name} logo`} style={{ width: 52, height: 52, borderRadius: 12, backgroundColor: colors.white }} />
            : <Text accessibilityLabel={`${selectedSchool.school_name} logo`} style={{ width: 52, height: 52, borderRadius: 12, overflow: 'hidden', backgroundColor: colors.white, color: colors.navy, textAlign: 'center', textAlignVertical: 'center', fontSize: 20, fontWeight: '800' }}>{selectedSchool.school_name.slice(0, 1).toUpperCase()}</Text>}
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={{ color: colors.accent, fontSize: 14, fontWeight: '700' }}>Campus Connect</Text>
            <Text style={{ color: colors.white, fontSize: 20, fontWeight: '800' }}>{selectedSchool.school_name}</Text>
          </View>
        </View>
        <Text style={{ color: colors.onDarkMuted }}>{selectedSchool.announcement ?? 'Your school workspace, on the move.'}</Text>
        <Link href="/scan" style={{ color: colors.white, backgroundColor: colors.violet, padding: 13, borderRadius: 11, textAlign: 'center', fontWeight: '700' }}>
          Open scanner
        </Link>
      </Card>
      <Heading>Quick access</Heading>
      <View style={{ gap: 10 }}>
        {modules.map((module) => (
          <Link key={module.id} href={module.path as any} asChild>
            <Card>
              <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}>{module.label}</Text>
              <BodyText muted>{module.description}</BodyText>
            </Card>
          </Link>
        ))}
      </View>
      <BodyText muted>Health records are limited to authorised healthcare staff. The app does not cache clinical records for offline use.</BodyText>
    </Page>
  );
}
