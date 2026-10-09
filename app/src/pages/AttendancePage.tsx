import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { CalendarDays, Check, ClipboardCheck, Save } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';
import type { SchoolClass } from '../types/database';

type Status = 'present' | 'absent' | 'late' | 'excused';
interface RosterStudent {
  id: string;
  first_name: string;
  last_name: string;
  student_number: string;
  status: Status;
}
interface AttendanceValue {
  student_id: string;
  status: Status;
}
const statusOptions: { value: Status; label: string }[] = [
  { value: 'present', label: 'Present' },
  { value: 'absent', label: 'Absent' },
  { value: 'late', label: 'Late' },
  { value: 'excused', label: 'Excused' },
];

function localDate() {
  const date = new Date();
  const timezoneOffset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - timezoneOffset).toISOString().slice(0, 10);
}

export function AttendancePage() {
  const { activeMembership, user } = useAuth();
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [classId, setClassId] = useState('');
  const [date, setDate] = useState(localDate);
  const [students, setStudents] = useState<RosterStudent[]>([]);
  const [loadingClasses, setLoadingClasses] = useState(true);
  const [loadingRoster, setLoadingRoster] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const canRecord = activeMembership?.role === 'school_admin' || activeMembership?.role === 'teacher';
  const schoolId = activeMembership?.school_id;

  useEffect(() => {
    if (!schoolId) return;
    let active = true;
    async function loadClasses() {
      setLoadingClasses(true);
      setError('');
      try {
        const client = requireSupabase();
        const { data: allClasses, error: classError } = await client
          .from('school_classes')
          .select('id, school_id, name, grade_level, academic_year_id, created_at')
          .eq('school_id', schoolId)
          .order('name');
        if (classError) throw classError;
        let visibleClasses = allClasses ?? [];
        if (activeMembership?.role === 'teacher') {
          const { data: teachers, error: teacherError } = await client
            .from('teacher_profiles')
            .select('id')
            .eq('school_id', schoolId)
            .eq('profile_id', user?.id ?? '');
          if (teacherError) throw teacherError;
          const teacherIds = (teachers ?? []).map((teacher) => teacher.id);
          if (teacherIds.length === 0) {
            visibleClasses = [];
          } else {
            const { data: assignments, error: assignmentError } = await client
              .from('teacher_class_assignments')
              .select('class_id')
              .eq('school_id', schoolId)
              .in('teacher_id', teacherIds);
            if (assignmentError) throw assignmentError;
            const assignedIds = new Set((assignments ?? []).map((assignment) => assignment.class_id));
            visibleClasses = visibleClasses.filter((schoolClass) => assignedIds.has(schoolClass.id));
          }
        }
        if (active) {
          setClasses(visibleClasses);
          setClassId((current) => visibleClasses.some((schoolClass) => schoolClass.id === current) ? current : visibleClasses[0]?.id ?? '');
        }
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Could not load classes.');
      } finally {
        if (active) setLoadingClasses(false);
      }
    }
    void loadClasses();
    return () => { active = false; };
  }, [schoolId, activeMembership?.role, user?.id, refreshKey]);

  const loadRoster = useCallback(async () => {
    if (!schoolId || !classId || !date || !canRecord) {
      setStudents([]);
      return;
    }
    setLoadingRoster(true);
    setError('');
    setNotice('');
    try {
      const client = requireSupabase();
      const [rosterResult, sessionResult] = await Promise.all([
        client.from('class_students').select('student_id, students(id, first_name, last_name, student_number)').eq('school_id', schoolId).eq('class_id', classId).order('student_id'),
        client.from('attendance_sessions').select('id').eq('school_id', schoolId).eq('class_id', classId).eq('attendance_date', date).maybeSingle(),
      ]);
      if (rosterResult.error) throw rosterResult.error;
      if (sessionResult.error) throw sessionResult.error;
      const roster = (rosterResult.data ?? []).map((entry) => {
        const student = entry.students as unknown as Omit<RosterStudent, 'status'> | null;
        return student ? { ...student, status: 'present' as Status } : null;
      }).filter((student): student is RosterStudent => student !== null);
      if (sessionResult.data) {
        const { data: attendance, error: attendanceError } = await client
          .from('attendance_records')
          .select('student_id,status')
          .eq('school_id', schoolId)
          .eq('session_id', sessionResult.data.id);
        if (attendanceError) throw attendanceError;
        const saved = new Map((attendance ?? []).map((record) => [record.student_id, record.status as Status]));
        roster.forEach((student) => { student.status = saved.get(student.id) ?? student.status; });
      }
      setStudents(roster);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load this class roster.');
      setStudents([]);
    } finally {
      setLoadingRoster(false);
    }
  }, [schoolId, classId, date, canRecord]);

  useEffect(() => { void loadRoster(); }, [loadRoster]);

  async function saveAttendance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !classId || !user || students.length === 0) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const client = requireSupabase();
      const { data: session, error: sessionError } = await client
        .from('attendance_sessions')
        .upsert({ school_id: schoolId, class_id: classId, attendance_date: date, recorded_by: user.id }, { onConflict: 'school_id,class_id,attendance_date' })
        .select('id')
        .single();
      if (sessionError) throw sessionError;
      const { error: saveError } = await client.from('attendance_records').upsert(
        students.map((student) => ({ school_id: schoolId, session_id: session.id, student_id: student.id, status: student.status })),
        { onConflict: 'session_id,student_id' },
      );
      if (saveError) throw saveError;
      setNotice('Attendance saved successfully.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save attendance.');
    } finally {
      setSaving(false);
    }
  }

  function setAll(status: Status) {
    setStudents((current) => current.map((student) => ({ ...student, status })));
  }

  const selectedClass = classes.find((schoolClass) => schoolClass.id === classId);
  const presentCount = students.filter((student) => student.status === 'present').length;

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div><span className="eyebrow">{activeMembership?.school.name}</span><h1>Attendance</h1><p>Record and review daily attendance for your assigned classes.</p></div>
        {canRecord && <span className="date-chip"><ClipboardCheck size={16} />{presentCount} of {students.length} present</span>}
      </div>
      {!canRecord && <section className="content-card"><EmptyState title="Attendance recording is for teachers and school administrators" detail="Your role does not have permission to record attendance here." /></section>}
      {canRecord && <>
        <section className="content-card attendance-controls">
          <div className="attendance-control-field"><label htmlFor="attendance-class">Class</label><select id="attendance-class" value={classId} onChange={(event) => setClassId(event.target.value)} disabled={loadingClasses || classes.length === 0}><option value="">{loadingClasses ? 'Loading classes…' : classes.length ? 'Select a class' : 'No classes assigned'}</option>{classes.map((schoolClass) => <option key={schoolClass.id} value={schoolClass.id}>{schoolClass.name}</option>)}</select></div>
          <div className="attendance-control-field"><label htmlFor="attendance-date">Date</label><span className="date-input-wrap"><CalendarDays size={16} /><input id="attendance-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} /></span></div>
          {students.length > 0 && <button className="button button-quiet mark-all-button" type="button" onClick={() => setAll('present')}><Check size={15} /> Mark all present</button>}
        </section>
        {error && <ErrorState message={error} />}
        {notice && <SuccessMessage message={notice} />}
        {loadingRoster ? <LoadingState label="Loading class roster and saved attendance…" /> : !classId ? <section className="content-card"><EmptyState title={classes.length ? 'Choose a class' : 'No classes available'} detail={classes.length ? 'Select a class and date to record attendance.' : 'Create a class and assign your account to it before recording attendance.'} /></section> : students.length === 0 ? <section className="content-card"><EmptyState title="No students in this class" detail="Add students and assign them to this class before taking attendance." /></section> : <form className="content-card attendance-table-card" onSubmit={saveAttendance}>
          <div className="attendance-table-heading"><div><span className="eyebrow">{selectedClass?.name}</span><h2>Class register</h2></div><span className="attendance-date-label">{new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</span></div>
          <div className="table-scroll"><table><thead><tr><th>Student</th><th>Student ID</th><th>Attendance status</th></tr></thead><tbody>{students.map((student) => <tr key={student.id}><td><strong>{student.first_name} {student.last_name}</strong></td><td className="mono-cell">{student.student_number}</td><td><div className="status-selector">{statusOptions.map((option) => <button key={option.value} type="button" className={`status-option status-${option.value}${student.status === option.value ? ' selected' : ''}`} aria-pressed={student.status === option.value} onClick={() => setStudents((current) => current.map((item) => item.id === student.id ? { ...item, status: option.value } : item))}>{option.label}</button>)}</div></td></tr>)}</tbody></table></div>
          <div className="attendance-form-footer"><span>{students.length} students in register</span><button className="button button-primary" type="submit" disabled={saving || loadingRoster}><Save size={15} />{saving ? 'Saving…' : 'Save attendance'}</button></div>
        </form>}
      </>}
    </div>
  );
}
