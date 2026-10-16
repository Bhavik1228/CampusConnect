import { Link } from 'expo-router';
import { Text, View } from 'react-native';
import { BodyText, Card, Heading, Page, colors } from '../../src/components/ui';
import { useCampusAuth } from '../../src/lib/auth-context';
import { canUseModule } from '../../src/lib/validation';

export default function ModulesScreen() {
  const { selectedSchool } = useCampusAuth();
  if (!selectedSchool) return null;
  const modules = [
    { id: 'visitors' as const, title: 'Visitor management', description: 'Register visits, check badges, and process check-in/out.', href: '/visitors' as const },
    { id: 'library' as const, title: 'Library', description: 'Search the catalogue, scan ISBNs, and print book labels.', href: '/library' as const },
    { id: 'health' as const, title: 'Student health', description: 'Record clinic visits and view protected health history.', href: '/health' as const },
  ].filter((module) => canUseModule(selectedSchool, module.id));

  return (
    <Page title="Modules" subtitle="Only features authorised for your school role are shown.">
      {modules.length === 0
        ? <Card><Heading>No modules available</Heading><BodyText muted>Ask your school administrator to enable mobile modules for your role.</BodyText></Card>
        : <View style={{ gap: 10 }}>{modules.map((module) => (
          <Link key={module.id} href={module.href} asChild>
            <Card>
              <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}>{module.title}</Text>
              <BodyText muted>{module.description}</BodyText>
            </Card>
          </Link>
        ))}</View>}
    </Page>
  );
}
