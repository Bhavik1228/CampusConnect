import { Link, Stack } from 'expo-router';
import { BodyText, Card, Page, colors } from '../src/components/ui';

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Page not found' }} />
      <Page title="Page not found" subtitle="This screen is not available.">
        <Card>
          <BodyText muted>The address may be outdated, or the page may have moved.</BodyText>
          <Link href="/" style={{ color: colors.violet, fontSize: 16, fontWeight: '700', paddingVertical: 12 }}>
            Return to home
          </Link>
        </Card>
      </Page>
    </>
  );
}
