import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { BodyText, Button, Card, Field, Heading, Loading, Message, Page, colors } from '../src/components/ui';
import { useCampusAuth } from '../src/lib/auth-context';
import { requireSupabase } from '../src/lib/supabase';
import type { StaffMember } from '../src/lib/types';
import { canAccessScreen } from '../src/lib/validation';

export default function TeachersScreen() {
  const { selectedSchool } = useCampusAuth();
  const [staff, setStaff] = useState<StaffMember[]>([]);
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
        .from('staff_profiles')
        .select('id,employee_number,first_name,last_name,email,phone,job_title,employment_status,department_id,school_departments(name)')
        .eq('school_id', selectedSchool.school_id)
        .order('last_name', { ascending: true })
        .limit(100);
      if (search.trim()) {
        const term = `%${search.trim()}%`;
        query = query.or(`employee_number.ilike.${term},first_name.ilike.${term},last_name.ilike.${term},job_title.ilike.${term}`);
      }
      const { data, error: queryError } = await query;
      if (queryError) throw queryError;
      setStaff((data ?? []) as unknown as StaffMember[]);
      if (!data?.length) setNotice('No staff members matched that search.');
    } catch (queryError) {
      setError(queryError instanceof Error ? queryError.message : 'Could not load the staff directory.');
    } finally {
      setLoading(false);
    }
  }, [selectedSchool, search]);

  useEffect(() => { void load(); }, [load]);

  if (!selectedSchool) return null;
  if (!canAccessScreen(selectedSchool, 'teachers')) {
    return (
      <Page title="Teachers" subtitle="Staff directory for your school.">
        <Message variant="error">Your role does not have access to the staff directory on this device.</Message>
      </Page>
    );
  }

  return (
    <Page title="Teachers" subtitle="Search the school staff directory.">
      {error ? <Message variant="error">{error}</Message> : null}
      {notice ? <Message variant="success">{notice}</Message> : null}
      <Field label="Search by name, employee number, or title" value={search} onChangeText={setSearch} autoCapitalize="none" />
      {loading ? <Loading label="Loading staff…" />
        : staff.length === 0
          ? <Card><BodyText muted>No staff members are registered at this school.</BodyText></Card>
          : <View style={{ gap: 9 }}>{staff.map((member) => (
            <Card key={member.id}>
              <Text style={{ color: colors.text, fontWeight: '700' }}>{`${member.first_name} ${member.last_name}`}</Text>
              <BodyText muted>{member.employee_number}</BodyText>
              <BodyText muted>{member.job_title}</BodyText>
              <View style={{ gap: 4 }}>
                {member.school_departments?.name ? <BodyText muted>Department: {member.school_departments.name}</BodyText> : null}
                <BodyText muted>Employment: {member.employment_status}</BodyText>
              </View>
            </Card>
          ))}</View>}
    </Page>
  );
}
