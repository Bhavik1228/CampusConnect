import { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { Link } from 'expo-router';
import { BodyText, Button, Card, Field, Heading, Loading, Message, Page, colors } from '../src/components/ui';
import { useCampusAuth } from '../src/lib/auth-context';
import { requireSupabase } from '../src/lib/supabase';
import { canAccessScreen } from '../src/lib/validation';

type AttendanceStatus = 'present' | 'absent' | 'late' | 'excused';

const STATUS_LABEL: Record<AttendanceStatus, string> = {
  present: 'Present',
  absent: 'Absent',
  late: 'Late',
  excused: 'Excused',
};

const STATUSES: AttendanceStatus[] = ['present', 'absent', 'late', 'excused'];

interface ClassChoice {
  id: string;
  name: string;
  grade_level: string | null;
}

interface RosterStudent {
  id: string;
  student_number: string;
  first_name: string;
  last_name: string;
  status: AttendanceStatus | null;
}

export default function AttendanceScreen() {
  const { session, selectedSchool } = useCampusAuth();
  const [classes, setClasses] = useState<ClassChoice[]>([]);
  const [selectedClass, setSelectedClass] = useState<ClassChoice | null>(null);
  const [roster, setRoster] = useState<RosterStudent[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<'open' | 'submitted' | 'closed' | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const today = new Date().toISOString().slice(0, 10);

  const loadClasses = useCallback(async () => {
    if (!selectedSchool) return;
    try {
      const { data, error: queryError } = await requireSupabase()
        .from('school_classes')
        .select('id,name,grade_level')
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

  const loadRegister = useCallback(async () => {
    if (!selectedSchool || !selectedClass) return;
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const { data: sessions, error: sessionError } = await client
        .from('attendance_sessions')
        .select('id,status')
        .eq('school_id', selectedSchool.school_id)
        .eq('class_id', selectedClass.id)
        .eq('attendance_date', today)
        .maybeSingle();
      if (sessionError) throw sessionError;

      let sid = (sessions as { id: string; status: string } | null)?.id ?? null;
      let status = (sessions as { id: string; status: string } | null)?.status ?? null;

      if (!sid) {
        const { data: created, error: createError } = await client
          .from('attendance_sessions')
          .insert({
            school_id: selectedSchool.school_id,
            class_id: selectedClass.id,
            attendance_date: today,
            recorded_by: session?.user.id ?? '',
            session_type: 'daily',
            status: 'open',
          })
          .select('id,status')
          .maybeSingle();
        if (createError) throw createError;
        if (!created) throw new Error('Could not create attendance session.');
        sid = created.id;
        status = created.status;
      }

      setSessionId(sid);
      setSessionStatus((status ?? 'open') as 'open' | 'submitted' | 'closed');

      const [rosterResult, recordsResult] = await Promise.all([
        client
          .from('class_students')
          .select('student_id,students(id,student_number,first_name,last_name)')
          .eq('school_id', selectedSchool.school_id)
          .eq('class_id', selectedClass.id)
          .order('students(last_name)', { ascending: true }),
        client
          .from('attendance_records')
          .select('student_id,status')
          .eq('school_id', selectedSchool.school_id)
          .eq('session_id', sid),
      ]);
      if (rosterResult.error) throw rosterResult.error;
      if (recordsResult.error) throw recordsResult.error;

      const marked = new Map<string, string>();
      (recordsResult.data ?? []).forEach((r: { student_id: string; status: string }) => {
        marked.set(r.student_id, r.status);
      });

      const rosterStudents: RosterStudent[] = (rosterResult.data ?? []).map((row: { student_id: string; students: { id: string; student_number: string; first_name: string; last_name: string }[] | null }) => ({
        id: row.student_id,
        student_number: row.students?.[0]?.student_number ?? '',
        first_name: row.students?.[0]?.first_name ?? '',
        last_name: row.students?.[0]?.last_name ?? '',
        status: (marked.get(row.student_id) as AttendanceStatus | null) ?? null,
      }));
      setRoster(rosterStudents);
    } catch (queryError) {
      setError(queryError instanceof Error ? queryError.message : 'Could not load the register.');
    } finally {
      setLoading(false);
    }
  }, [selectedSchool, selectedClass, session?.user.id, today]);

  useEffect(() => {
    if (selectedClass) void loadRegister();
  }, [selectedClass, loadRegister]);

  const setStudentStatus = (studentId: string, status: AttendanceStatus) => {
    setRoster((current) => current.map((s) => (s.id === studentId ? { ...s, status } : s)));
  };

  const saveRegister = useCallback(async () => {
    if (!selectedSchool || !sessionId) return;
    setSaving(true);
    setError('');
    try {
      const client = requireSupabase();
      const upsertRows = roster.map((student) => ({
        school_id: selectedSchool.school_id,
        session_id: sessionId,
        student_id: student.id,
        status: student.status ?? 'absent',
      }));
      const { error: upsertError } = await client.from('attendance_records').upsert(upsertRows, { onConflict: 'session_id,student_id' });
      if (upsertError) throw upsertError;

      const { error: transitionError } = await client.rpc('transition_attendance_session', {
        target_session: sessionId,
        target_status: 'submitted',
      });
      if (transitionError) throw transitionError;

      setSessionStatus('submitted');
      setNotice('Register submitted.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The register could not be saved.');
    } finally {
      setSaving(false);
    }
  }, [selectedSchool, sessionId, roster]);

  if (!selectedSchool) return null;
  if (!canAccessScreen(selectedSchool, 'attendance')) {
    return (
      <Page title="Attendance" subtitle="Take and submit class registers.">
        <Message variant="error">Your role does not have mobile attendance access on this device.</Message>
      </Page>
    );
  }

  return (
    <Page title="Attendance" subtitle="Mark attendance for a class.">
      {error ? <Message variant="error">{error}</Message> : null}
      {notice ? <Message variant="success">{notice}</Message> : null}
      {loading ? <Loading label="Loading classes…" />
        : classes.length === 0
          ? <Card><BodyText muted>No classes are registered at this school.</BodyText></Card>
          : selectedClass === null
            ? <>
              <Heading>Choose a class</Heading>
              <View style={{ gap: 8 }}>{classes.map((cls) => (
                <Button key={cls.id} title={cls.name} variant="secondary" onPress={() => setSelectedClass(cls)} />
              ))}</View>
              <Link href={"/timetable" as any} style={{ color: colors.violet, fontWeight: '700' }}>
                View timetable
              </Link>
            </>
            : <>
              <Heading>{selectedClass.name}</Heading>
              <BodyText muted>{today} · {sessionStatus === 'submitted' ? 'Register submitted' : sessionStatus === 'closed' ? 'Register closed' : 'Open register'}</BodyText>
              {sessionStatus === 'submitted' || sessionStatus === 'closed' ? (
                <Card><BodyText muted>This register has already been {sessionStatus}. Reopen it from the web workspace to make changes.</BodyText></Card>
              ) : null}
              <Card>
                {roster.length === 0 ? (
                  <BodyText muted>No enrolled students for this class.</BodyText>
                ) : (
                  <View style={{ gap: 10 }}>{roster.map((student) => (
                    <View key={student.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                      <View>
                        <Text style={{ color: colors.text, fontWeight: '600' }}>{`${student.first_name} ${student.last_name}`}</Text>
                        <BodyText muted>{student.student_number}</BodyText>
                      </View>
                      <View style={{ flexDirection: 'row', gap: 6 }}>
                        {STATUSES.map((status) => (
                          <Button
                            key={status}
                            title={STATUS_LABEL[status]}
                            variant={student.status === status ? 'primary' : 'secondary'}
                            disabled={saving}
                            onPress={() => setStudentStatus(student.id, status)}
                          />
                        ))}
                      </View>
                    </View>
                  ))}</View>
                )}
              </Card>
              <Button
                title={saving ? 'Submitting…' : 'Save and submit register'}
                disabled={saving || sessionStatus !== 'open'}
                onPress={() => void saveRegister()}
              />
              <Link href={"/students" as any} style={{ color: colors.violet, fontWeight: '700' }}>
                Student directory
              </Link>
            </>}
    </Page>
  );
}
