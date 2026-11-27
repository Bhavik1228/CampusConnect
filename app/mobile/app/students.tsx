import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Link } from 'expo-router';
import { BodyText, Button, Card, Field, Heading, Loading, Message, Page, colors } from '../src/components/ui';
import { useCampusAuth } from '../src/lib/auth-context';
import { requireSupabase } from '../src/lib/supabase';
import type { Student } from '../src/lib/types';
import { canAccessScreen } from '../src/lib/validation';

export default function StudentsScreen() {
  const { selectedSchool } = useCampusAuth();
  const [students, setStudents] = useState<Student[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    if (!selectedSchool) return;
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      let query = client
        .from('students')
        .select('id,student_number,first_name,last_name,email,date_of_birth,status,class_id,profile_id,school_classes(name)')
        .eq('school_id', selectedSchool.school_id)
        .order('last_name', { ascending: true })
        .limit(100);
      if (search.trim()) {
        const term = `%${search.trim()}%`;
        query = query.or(`student_number.ilike.${term},first_name.ilike.${term},last_name.ilike.${term}`);
      }
      const { data, error: queryError } = await query;
      if (queryError) throw queryError;
      setStudents((data ?? []) as unknown as Student[]);
      if (!data?.length) setNotice('No students matched that search.');
    } catch (queryError) {
      setError(queryError instanceof Error ? queryError.message : 'Could not load the student directory.');
    } finally {
      setLoading(false);
    }
  }, [selectedSchool, search]);

  useEffect(() => { void load(); }, [load]);

  if (!selectedSchool) return null;
  if (!canAccessScreen(selectedSchool, 'students')) {
    return (
      <Page title="Students" subtitle="Student directory for your school.">
        <Message variant="error">Your role does not have access to the student directory on this device.</Message>
      </Page>
    );
  }

  return (
    <Page title="Students" subtitle="Search the school student directory.">
      {error ? <Message variant="error">{error}</Message> : null}
      {notice ? <Message variant="success">{notice}</Message> : null}
      <Field label="Search by name or student number" value={search} onChangeText={setSearch} autoCapitalize="none" />
      {loading ? <Loading label="Loading students…" />
        : students.length === 0
          ? <Card><BodyText muted>No students are registered at this school.</BodyText></Card>
          : <View style={{ gap: 9 }}>{students.map((student) => (
            <Link key={student.id} href={`/student?id=${encodeURIComponent(student.id)}` as any} asChild>
              <Card>
                <Text style={{ color: colors.text, fontWeight: '700' }}>{`${student.first_name} ${student.last_name}`}</Text>
                <BodyText muted>{student.student_number}</BodyText>
                <BodyText muted>{student.school_classes?.name ?? 'Class not assigned'} · {student.status}</BodyText>
              </Card>
            </Link>
          ))}</View>}
    </Page>
  );
}
