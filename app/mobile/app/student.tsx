import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Link, useLocalSearchParams } from 'expo-router';
import { BodyText, Button, Card, Heading, Loading, Message, Page, colors } from '../src/components/ui';
import { useCampusAuth } from '../src/lib/auth-context';
import { requireSupabase } from '../src/lib/supabase';
import type { Student } from '../src/lib/types';
import { canAccessScreen } from '../src/lib/validation';

export default function StudentScreen() {
  const { selectedSchool } = useCampusAuth();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const [student, setStudent] = useState<Student | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!selectedSchool || !id) return;
    setLoading(true);
    setError('');
    try {
      const { data, error: queryError } = await requireSupabase()
        .from('students')
        .select('id,student_number,first_name,last_name,email,date_of_birth,status,class_id,profile_id,school_classes(name)')
        .eq('school_id', selectedSchool.school_id)
        .eq('id', id)
        .maybeSingle();
      if (queryError) throw queryError;
      setStudent((data ?? null) as unknown as Student | null);
    } catch (queryError) {
      setError(queryError instanceof Error ? queryError.message : 'Could not load the student profile.');
    } finally {
      setLoading(false);
    }
  }, [selectedSchool, id]);

  useEffect(() => { void load(); }, [load]);

  if (!selectedSchool) return null;
  if (!canAccessScreen(selectedSchool, 'students')) {
    return (
      <Page title="Student" subtitle="Student profile.">
        <Message variant="error">Your role does not have access to student profiles on this device.</Message>
      </Page>
    );
  }

  return (
    <Page title="Student" subtitle="Authorized student information only.">
      {error ? <Message variant="error">{error}</Message> : null}
      {loading ? <Loading label="Loading student…" />
        : !student
          ? <Card><BodyText muted>No student found.</BodyText></Card>
          : <>
            <Card>
              <Text style={{ color: colors.text, fontSize: 20, fontWeight: '800' }}>{`${student.first_name} ${student.last_name}`}</Text>
              <BodyText>Student number: {student.student_number}</BodyText>
              {student.email ? <BodyText>Email: {student.email}</BodyText> : null}
              {student.date_of_birth ? <BodyText>Date of birth: {student.date_of_birth}</BodyText> : null}
              <BodyText>Class: {student.school_classes?.name ?? 'Not assigned'}</BodyText>
              <BodyText>Status: {student.status}</BodyText>
            </Card>
            <Link href={"/students" as any} style={{ color: colors.violet, fontWeight: '700' }}>
              Back to directory
            </Link>
          </>}
    </Page>
  );
}
