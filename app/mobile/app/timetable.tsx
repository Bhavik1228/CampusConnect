import { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { BodyText, Button, Card, Heading, Loading, Message, Page, colors } from '../src/components/ui';
import { useCampusAuth } from '../src/lib/auth-context';
import { requireSupabase } from '../src/lib/supabase';
import { canAccessScreen } from '../src/lib/validation';

interface ClassChoice {
  id: string;
  name: string;
}

interface TimetableEntry {
  id: string;
  day_of_week: number;
  starts_at: string;
  ends_at: string;
  subjects: { name: string } | null;
  room: string | null;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function TimetableScreen() {
  const { selectedSchool } = useCampusAuth();
  const [classes, setClasses] = useState<ClassChoice[]>([]);
  const [selectedClass, setSelectedClass] = useState<ClassChoice | null>(null);
  const [entries, setEntries] = useState<TimetableEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadClasses = useCallback(async () => {
    if (!selectedSchool) return;
    try {
      const { data, error: queryError } = await requireSupabase()
        .from('school_classes')
        .select('id,name')
        .eq('school_id', selectedSchool.school_id)
        .order('name', { ascending: true })
        .limit(100);
      if (queryError) throw queryError;
      setClasses((data ?? []) as unknown as ClassChoice[]);
    } catch (queryError) {
      setError(queryError instanceof Error ? queryError.message : 'Could not load classes.');
    }
  }, [selectedSchool]);

  useEffect(() => { void loadClasses(); }, [loadClasses]);

  const loadEntries = useCallback(async () => {
    if (!selectedSchool || !selectedClass) return;
    setLoading(true);
    setError('');
    try {
      const { data, error: queryError } = await requireSupabase()
        .from('timetable')
        .select('id,day_of_week,starts_at,ends_at,room,subjects(name)')
        .eq('school_id', selectedSchool.school_id)
        .eq('class_id', selectedClass.id)
        .order('day_of_week', { ascending: true })
        .order('starts_at', { ascending: true })
        .limit(200);
      if (queryError) throw queryError;
      setEntries((data ?? []) as unknown as TimetableEntry[]);
    } catch (queryError) {
      setError(queryError instanceof Error ? queryError.message : 'Could not load the timetable.');
    } finally {
      setLoading(false);
    }
  }, [selectedSchool, selectedClass]);

  useEffect(() => {
    if (selectedClass) void loadEntries();
  }, [selectedClass, loadEntries]);

  const byDay = useMemo(() => {
    const map: Record<number, TimetableEntry[]> = {};
    entries.forEach((entry) => {
      if (!map[entry.day_of_week]) map[entry.day_of_week] = [];
      map[entry.day_of_week].push(entry);
    });
    return map;
  }, [entries]);

  if (!selectedSchool) return null;
  if (!canAccessScreen(selectedSchool, 'timetable')) {
    return (
      <Page title="Timetable" subtitle="View class timetables.">
        <Message variant="error">Your role does not have mobile timetable access on this device.</Message>
      </Page>
    );
  }

  return (
    <Page title="Timetable" subtitle="Published class timetable.">
      {error ? <Message variant="error">{error}</Message> : null}
      {loading ? <Loading label="Loading classes…" />
        : classes.length === 0
          ? <Card><BodyText muted>No classes are registered at this school.</BodyText></Card>
          : selectedClass === null
            ? <>
              <Heading>Choose a class</Heading>
              <View style={{ gap: 8 }}>{classes.map((cls) => (
                <Button key={cls.id} title={cls.name} variant="secondary" onPress={() => setSelectedClass(cls)} />
              ))}</View>
            </>
            : <>
              <Heading>{selectedClass.name}</Heading>
              {entries.length === 0 ? (
                <Card><BodyText muted>No timetable entries are published for this class yet.</BodyText></Card>
              ) : (
                <View style={{ gap: 10 }}>
                  {[1, 2, 3, 4, 5].map((day) => {
                    const dayEntries = byDay[day] ?? [];
                    if (dayEntries.length === 0) return null;
                    return (
                      <Card key={day}>
                        <Heading>{DAYS[day]}</Heading>
                        <View style={{ gap: 8 }}>
                          {dayEntries.map((entry) => (
                            <View key={entry.id} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
                              <View>
                                <Text style={{ color: colors.text, fontWeight: '600' }}>{entry.subjects?.name ?? 'Subject'}</Text>
                                <BodyText muted>{entry.starts_at.slice(0, 5)} – {entry.ends_at.slice(0, 5)}</BodyText>
                              </View>
                              <Text style={{ color: colors.muted, fontSize: 14 }}>{entry.room ?? '—'}</Text>
                            </View>
                          ))}
                        </View>
                      </Card>
                    );
                  })}
                </View>
              )}
              <BodyText muted>Days with no published lessons are omitted.</BodyText>
            </>}
    </Page>
  );
}
