import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { BodyText, Button, Card, Heading, Loading, Message, Page, colors } from '../../src/components/ui';
import { useCampusAuth } from '../../src/lib/auth-context';
import { requireSupabase } from '../../src/lib/supabase';

interface Notice {
  id: string;
  title: string;
  body: string | null;
  target_path: string | null;
  read_at: string | null;
  created_at: string;
}

export default function NotificationsScreen() {
  const { session, selectedSchool } = useCampusAuth();
  const [items, setItems] = useState<Notice[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!session || !selectedSchool) return;
    setBusy(true);
    setError('');
    try {
      const { data, error: queryError } = await requireSupabase().from('notifications')
        .select('id,title,body,target_path,read_at,created_at')
        .eq('school_id', selectedSchool.school_id)
        .eq('profile_id', session.user.id)
        .order('created_at', { ascending: false })
        .limit(50);
      if (queryError) throw queryError;
      setItems((data ?? []) as Notice[]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load notifications.');
    } finally {
      setBusy(false);
    }
  }, [session, selectedSchool]);

  useEffect(() => { void load(); }, [load]);

  async function markRead(notification: Notice) {
    if (notification.read_at) return;
    const { error: updateError } = await requireSupabase().from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', notification.id)
      .eq('profile_id', session?.user.id ?? '');
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setItems((current) => current.map((item) =>
      item.id === notification.id ? { ...item, read_at: new Date().toISOString() } : item));
  }

  if (!selectedSchool) return null;
  return (
    <Page title="Notifications" subtitle="In-app notices for your selected school.">
      {error ? <Message variant="error">{error}</Message> : null}
      <Button title="Refresh" variant="secondary" onPress={() => void load()} />
      {busy ? <Loading label="Loading notifications…" />
        : items.length === 0
          ? <Card><Heading>All caught up</Heading><BodyText muted>There are no notifications for this school.</BodyText></Card>
          : <View style={{ gap: 10 }}>{items.map((item) => (
            <Pressable key={item.id} onPress={() => void markRead(item)}>
              <Card style={{ borderColor: item.read_at ? colors.border : colors.violetLight }}>
                <Text style={{ color: colors.text, fontWeight: '700' }}>{item.title}</Text>
                {item.body ? <BodyText>{item.body}</BodyText> : null}
                <Text style={{ color: colors.muted, fontSize: 14 }}>{new Date(item.created_at).toLocaleString()}</Text>
                {!item.read_at ? <Text style={{ color: colors.violet, fontSize: 14, fontWeight: '700' }}>Tap to mark as read</Text> : null}
              </Card>
            </Pressable>
          ))}</View>}
    </Page>
  );
}
