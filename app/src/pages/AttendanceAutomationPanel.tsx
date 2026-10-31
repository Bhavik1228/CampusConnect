import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle, CalendarClock, Check, Download, FileText,
  RefreshCw, Send, ShieldCheck, UserRoundCog,
} from 'lucide-react';
import { EmptyState, ErrorState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';
import type { AppRole } from '../types/database';

type Role = AppRole;
type AttendanceStatus = 'present' | 'absent' | 'late' | 'excused';
type PanelTab = 'automation' | 'leave' | 'analytics' | 'operations';

interface Props {
  schoolId: string;
  userId: string;
  role: Role;
  active: boolean;
  classes: { id: string; name: string }[];
}

interface StudentOption {
  id: string;
  first_name: string;
  last_name: string;
  student_number: string;
  class_id: string | null;
}

interface LeaveRow {
  id: string;
  student_id: string;
  start_date: string;
  end_date: string;
  category: string;
  reason: string;
  supporting_document_path: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  created_at: string;
  students: StudentOption | StudentOption[] | null;
}

interface FollowupTask {
  id: string;
  student_id: string;
  task_type: string;
  title: string;
  details: string;
  status: 'open' | 'in_progress' | 'resolved';
  created_at: string;
  students: StudentOption | StudentOption[] | null;
}

interface SessionChoice {
  id: string;
  class_id: string;
  attendance_date: string;
  session_type: string;
  lesson_entry_id: string | null;
  status: 'open' | 'submitted' | 'closed';
  assigned_teacher_id: string | null;
  school_class: { name: string } | { name: string }[] | null;
}

interface TeacherOption { id: string; first_name: string; last_name: string }
interface CorrectionRow {
  id: string;
  student_id: string;
  requested_by: string;
  requested_status: AttendanceStatus | null;
  reason: string;
  status: string;
  created_at: string;
  session: { attendance_date: string; session_type: string } | { attendance_date: string; session_type: string }[] | null;
  students: StudentOption | StudentOption[] | null;
}
interface AnalyticsRecord {
  session_id: string;
  student_id: string;
  status: AttendanceStatus;
  absence_category: string;
  attendance_sessions: { id: string; attendance_date: string; class_id: string; session_type: string } | { id: string; attendance_date: string; class_id: string; session_type: string }[] | null;
  students: StudentOption | StudentOption[] | null;
}
interface NotificationTemplate {
  event_type: 'absent' | 'late' | 'repeated_absence' | 'leave_reminder';
  channel: 'in_app' | 'email' | 'sms' | 'push';
  enabled: boolean;
  title_template: string;
  body_template: string;
}
interface DeliveryRow {
  id: number;
  event_type: string;
  channel: string;
  status: string;
  error_message: string | null;
  created_at: string;
}
interface ExpectedLesson {
  id: string;
  class_id: string;
  day_of_week: number;
  school_class: { name: string } | { name: string }[] | null;
}

function related<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function dateToday() {
  const date = new Date();
  return isoDate(new Date(date.getTime() - date.getTimezoneOffset() * 60000));
}

function statusLabel(status: string) {
  return status.replaceAll('_', ' ');
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('The CSV contains an unclosed quoted field.');
  row.push(field);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

function isManageRole(role: Role) {
  return role === 'school_admin' || role === 'academic_coordinator';
}

export function AttendanceAutomationPanel({ schoolId, userId, role, active, classes }: Props) {
  const manager = isManageRole(role);
  const family = role === 'parent' || role === 'student';
  const [tab, setTab] = useState<PanelTab>('automation');
  const [students, setStudents] = useState<StudentOption[]>([]);
  const [leaveRows, setLeaveRows] = useState<LeaveRow[]>([]);
  const [tasks, setTasks] = useState<FollowupTask[]>([]);
  const [sessions, setSessions] = useState<SessionChoice[]>([]);
  const [expectedLessons, setExpectedLessons] = useState<ExpectedLesson[]>([]);
  const [teachers, setTeachers] = useState<TeacherOption[]>([]);
  const [corrections, setCorrections] = useState<CorrectionRow[]>([]);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [selectedCorrectionIds, setSelectedCorrectionIds] = useState<string[]>([]);
  const [notificationTemplates, setNotificationTemplates] = useState<NotificationTemplate[]>([]);
  const [deliveryHistory, setDeliveryHistory] = useState<DeliveryRow[]>([]);
  const [analyticsRecords, setAnalyticsRecords] = useState<AnalyticsRecord[]>([]);
  const [dateFrom, setDateFrom] = useState(dateToday);
  const [dateTo, setDateTo] = useState(dateToday);
  const [selectedClass, setSelectedClass] = useState('');
  const [selectedStudent, setSelectedStudent] = useState('');
  const [leaveStart, setLeaveStart] = useState(dateToday);
  const [leaveEnd, setLeaveEnd] = useState(dateToday);
  const [leaveCategory, setLeaveCategory] = useState('medical');
  const [leaveReason, setLeaveReason] = useState('');
  const [leaveFile, setLeaveFile] = useState<File | null>(null);
  const [substituteSession, setSubstituteSession] = useState('');
  const [substituteTeacher, setSubstituteTeacher] = useState('');
  const [substituteReason, setSubstituteReason] = useState('');
  const [selectedCorrectionStatus, setSelectedCorrectionStatus] = useState<AttendanceStatus>('excused');
  const [correctionSessionId, setCorrectionSessionId] = useState('');
  const [correctionReason, setCorrectionReason] = useState('');
  const [correctionArrivalTime, setCorrectionArrivalTime] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadPanel = useCallback(async () => {
    if (!schoolId || !active) return;
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      if (manager || role === 'teacher') {
        const [sessionResult, taskResult, teacherResult, correctionResult, lessonsResult, templateResult, deliveryResult] = await Promise.all([
          client.from('attendance_sessions')
            .select('id,class_id,attendance_date,session_type,lesson_entry_id,status,assigned_teacher_id,school_class:school_classes(name)')
            .eq('school_id', schoolId).gte('attendance_date', dateFrom).lte('attendance_date', dateTo).order('attendance_date', { ascending: false }).limit(250),
          client.from('attendance_followup_tasks')
            .select('id,student_id,task_type,title,details,status,created_at,students(first_name,last_name,student_number,class_id)')
            .eq('school_id', schoolId).neq('status', 'resolved').order('created_at', { ascending: false }).limit(100),
          manager
            ? client.from('teacher_profiles').select('id,first_name,last_name').eq('school_id', schoolId).order('last_name')
            : Promise.resolve({ data: [], error: null }),
          manager
            ? client.from('attendance_correction_requests')
              .select('id,student_id,requested_by,requested_status,reason,status,created_at,session:attendance_sessions(attendance_date,session_type),students(first_name,last_name,student_number,class_id)')
              .eq('school_id', schoolId).eq('status', 'pending').order('created_at', { ascending: false }).limit(100)
            : Promise.resolve({ data: [], error: null }),
          manager || role === 'teacher'
            ? client.from('timetable').select('id,class_id,day_of_week,school_class:school_classes(name),timetable_schedules!inner(status)')
              .eq('school_id', schoolId).eq('entry_type', 'lesson').eq('timetable_schedules.status', 'published')
            : Promise.resolve({ data: [], error: null }),
          manager
            ? client.from('attendance_notification_templates')
              .select('event_type,channel,enabled,title_template,body_template').eq('school_id', schoolId).order('event_type')
            : Promise.resolve({ data: [], error: null }),
          manager
            ? client.from('attendance_notification_deliveries')
              .select('id,event_type,channel,status,error_message,created_at').eq('school_id', schoolId).order('created_at', { ascending: false }).limit(100)
            : Promise.resolve({ data: [], error: null }),
        ]);
        const firstError = [sessionResult.error, taskResult.error, teacherResult.error, correctionResult.error, lessonsResult.error, templateResult.error, deliveryResult.error].find(Boolean);
        if (firstError) throw firstError;
        setSessions((sessionResult.data ?? []) as unknown as SessionChoice[]);
        setTasks((taskResult.data ?? []) as unknown as FollowupTask[]);
        setTeachers((teacherResult.data ?? []) as TeacherOption[]);
        setCorrections((correctionResult.data ?? []) as unknown as CorrectionRow[]);
        setExpectedLessons((lessonsResult.data ?? []) as unknown as ExpectedLesson[]);
        setNotificationTemplates((templateResult.data ?? []) as NotificationTemplate[]);
        setDeliveryHistory((deliveryResult.data ?? []) as DeliveryRow[]);
      }
      if (family || manager) {
        const { data: leaveData, error: leaveError } = await client.from('attendance_leave_requests')
          .select('id,student_id,start_date,end_date,category,reason,supporting_document_path,status,created_at,students(first_name,last_name,student_number,class_id)')
          .eq('school_id', schoolId).order('created_at', { ascending: false }).limit(150);
        if (leaveError) throw leaveError;
        setLeaveRows((leaveData ?? []) as unknown as LeaveRow[]);
      }
      if (family) {
        let linkedStudents: StudentOption[] = [];
        if (role === 'parent') {
          const { data: parents, error: parentError } = await client.from('parent_profiles')
            .select('id').eq('school_id', schoolId).eq('profile_id', userId);
          if (parentError) throw parentError;
          const parentIds = (parents ?? []).map((parent) => parent.id);
          const { data: linked, error: linkedError } = parentIds.length
            ? await client.from('parent_students')
              .select('student:students(id,first_name,last_name,student_number,class_id)')
              .eq('school_id', schoolId).in('parent_id', parentIds)
            : { data: [], error: null };
          if (linkedError) throw linkedError;
          linkedStudents = (linked ?? []).flatMap((entry) => {
            const student = related(entry.student as StudentOption | StudentOption[] | null);
            return student ? [student] : [];
          });
        } else {
          const { data: ownStudents, error: studentError } = await client.from('students')
            .select('id,first_name,last_name,student_number,class_id')
            .eq('school_id', schoolId).eq('profile_id', userId);
          if (studentError) throw studentError;
          linkedStudents = (ownStudents ?? []) as StudentOption[];
        }
        setStudents(linkedStudents);
        setSelectedStudent((current) => linkedStudents.some((student) => student.id === current)
          ? current : linkedStudents[0]?.id ?? '');
        const { data: personalRecords, error: personalRecordsError } = linkedStudents.length
          ? await client.from('attendance_records')
            .select('session_id,student_id,status,absence_category,attendance_sessions!inner(id,attendance_date,class_id,session_type),students(id,first_name,last_name,student_number,class_id)')
            .eq('school_id', schoolId).in('student_id', linkedStudents.map((student) => student.id))
            .gte('attendance_sessions.attendance_date', dateFrom)
            .lte('attendance_sessions.attendance_date', dateTo)
            .limit(1500)
          : { data: [], error: null };
        if (personalRecordsError) throw personalRecordsError;
        setAnalyticsRecords((personalRecords ?? []) as unknown as AnalyticsRecord[]);
        const { data: correctionHistory, error: correctionHistoryError } = linkedStudents.length
          ? await client.from('attendance_correction_requests')
            .select('id,student_id,requested_by,requested_status,reason,status,created_at,session:attendance_sessions(attendance_date,session_type),students(first_name,last_name,student_number,class_id)')
            .eq('school_id', schoolId).in('student_id', linkedStudents.map((student) => student.id))
            .order('created_at', { ascending: false }).limit(100)
          : { data: [], error: null };
        if (correctionHistoryError) throw correctionHistoryError;
        setCorrections((correctionHistory ?? []) as unknown as CorrectionRow[]);
      }
      if (manager || role === 'teacher') {
        const { data: trendData, error: trendError } = await client.from('attendance_records')
          .select('session_id,student_id,status,absence_category,attendance_sessions!inner(id,attendance_date,class_id,session_type),students(id,first_name,last_name,student_number,class_id)')
          .eq('school_id', schoolId)
          .gte('attendance_sessions.attendance_date', dateFrom)
          .lte('attendance_sessions.attendance_date', dateTo)
          .limit(5000);
        if (trendError) throw trendError;
        setAnalyticsRecords((trendData ?? []) as unknown as AnalyticsRecord[]);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load advanced attendance tools.');
    } finally {
      setLoading(false);
    }
  }, [schoolId, userId, role, active, manager, family, dateFrom, dateTo]);

  useEffect(() => { void loadPanel(); }, [loadPanel]);

  const missingLessons = useMemo(() => {
    const dayOfWeek = new Date(`${dateToday()}T12:00:00`).getDay();
    const todayIsodow = dayOfWeek === 0 ? 7 : dayOfWeek;
    const generatedLessonIds = new Set(sessions.filter((session) =>
      session.attendance_date === dateToday() && session.session_type === 'lesson').map((session) => session.lesson_entry_id));
    return expectedLessons.filter((lesson) => lesson.day_of_week === todayIsodow && !generatedLessonIds.has(lesson.id));
  }, [sessions, expectedLessons]);

  async function runRegisterGeneration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { data, error: rpcError } = await requireSupabase().rpc('generate_scheduled_attendance_registers', {
        target_school: schoolId,
        date_from: dateFrom,
        date_to: dateTo,
        target_class: selectedClass || null,
      });
      if (rpcError) throw rpcError;
      setNotice(`${data ?? 0} lesson register${data === 1 ? '' : 's'} generated from published timetable entries.`);
      await loadPanel();
    } catch (rpcError) {
      setError(rpcError instanceof Error ? rpcError.message : 'Could not generate attendance registers.');
    } finally {
      setSaving(false);
    }
  }

  async function runFollowups() {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const client = requireSupabase();
      const [taskResult, reminderResult] = await Promise.all([
        client.rpc('run_attendance_followup_scan', { target_school: schoolId }),
        client.rpc('apply_attendance_leave_reminder_scan', { target_school: schoolId }),
      ]);
      if (taskResult.error) throw taskResult.error;
      if (reminderResult.error) throw reminderResult.error;
      setNotice(`${taskResult.data ?? 0} new follow-up task(s) created; ${reminderResult.data ?? 0} unexplained-absence reminder(s) sent in-app.`);
      await loadPanel();
    } catch (rpcError) {
      setError(rpcError instanceof Error ? rpcError.message : 'Could not run attendance follow-up.');
    } finally {
      setSaving(false);
    }
  }

  async function updateTask(task: FollowupTask, status: FollowupTask['status']) {
    setSaving(true);
    setError('');
    try {
      const { error: rpcError } = await requireSupabase().rpc('update_attendance_followup_task', {
        target_task: task.id,
        next_status: status,
        assignee: null,
      });
      if (rpcError) throw rpcError;
      setNotice(`Follow-up task marked ${statusLabel(status)}.`);
      await loadPanel();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Could not update the follow-up task.');
    } finally {
      setSaving(false);
    }
  }

  async function bulkTransitionSessions(status: 'submitted' | 'closed') {
    const selected = sessions.filter((session) => selectedSessionIds.includes(session.id)
      && (status === 'submitted' ? session.status === 'open' : session.status === 'submitted'));
    if (!selected.length) return;
    setSaving(true);
    setError('');
    setNotice('');
    let completed = 0;
    const failures: string[] = [];
    try {
      const client = requireSupabase();
      for (const session of selected) {
        const { error: transitionError } = await client.rpc('transition_attendance_session', {
          target_session: session.id,
          target_status: status,
        });
        if (transitionError) {
          failures.push(`${session.attendance_date} · ${related(session.school_class)?.name ?? 'Class'}: ${transitionError.message}`);
        } else {
          completed += 1;
        }
      }
      setSelectedSessionIds([]);
      await loadPanel();
      if (failures.length) {
        setError(`${completed} register(s) updated; ${failures.length} failed. ${failures.slice(0, 3).join(' ')}`);
      } else {
        setNotice(`${completed} register(s) ${status}.`);
      }
    } catch (transitionError) {
      setError(transitionError instanceof Error ? transitionError.message : 'Could not update selected registers.');
    } finally {
      setSaving(false);
    }
  }

  async function submitLeave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedStudent || !leaveReason.trim()) return;
    setSaving(true);
    setError('');
    setNotice('');
    let uploadedPath: string | null = null;
    try {
      const client = requireSupabase();
      if (leaveFile) {
        const extension = leaveFile.name.split('.').pop()?.toLowerCase() ?? 'file';
        uploadedPath = `${schoolId}/${selectedStudent}/${crypto.randomUUID()}.${extension}`;
        const { error: uploadError } = await client.storage.from('attendance-leave-documents')
          .upload(uploadedPath, leaveFile, { contentType: leaveFile.type, upsert: false });
        if (uploadError) throw uploadError;
      }
      const { error: insertError } = await client.from('attendance_leave_requests').insert({
        school_id: schoolId,
        student_id: selectedStudent,
        requested_by: userId,
        start_date: leaveStart,
        end_date: leaveEnd,
        category: leaveCategory,
        reason: leaveReason.trim(),
        supporting_document_path: uploadedPath,
      });
      if (insertError) throw insertError;
      setLeaveReason('');
      setLeaveFile(null);
      setNotice('Leave request sent to the school.');
      await loadPanel();
    } catch (submitError) {
      if (uploadedPath) {
        const { error: removeError } = await requireSupabase().storage.from('attendance-leave-documents').remove([uploadedPath]);
        if (removeError) setError(`Request failed and its uploaded document could not be removed: ${removeError.message}`);
      }
      setError(submitError instanceof Error ? submitError.message : 'Could not submit this leave request.');
    } finally {
      setSaving(false);
    }
  }

  async function reviewLeave(id: string, decision: 'approved' | 'rejected') {
    setSaving(true);
    setError('');
    try {
      const { error: rpcError } = await requireSupabase().rpc('review_attendance_leave_request', {
        target_request: id,
        decision,
        note: null,
      });
      if (rpcError) throw rpcError;
      setNotice(`Leave request ${decision}.`);
      await loadPanel();
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Could not review this leave request.');
    } finally {
      setSaving(false);
    }
  }

  async function withdrawLeave(id: string) {
    setSaving(true);
    setError('');
    try {
      const { error: updateError } = await requireSupabase().from('attendance_leave_requests')
        .update({ status: 'withdrawn' }).eq('school_id', schoolId).eq('id', id);
      if (updateError) throw updateError;
      setNotice('Leave request withdrawn.');
      await loadPanel();
    } catch (withdrawError) {
      setError(withdrawError instanceof Error ? withdrawError.message : 'Could not withdraw this leave request.');
    } finally {
      setSaving(false);
    }
  }

  async function viewDocument(path: string) {
    const { data, error: linkError } = await requireSupabase().storage.from('attendance-leave-documents')
      .createSignedUrl(path, 60);
    if (linkError) setError(linkError.message);
    else if (data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  }

  async function submitCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const candidate = analyticsRecords.find((record) => record.session_id === correctionSessionId
      && related(record.students)?.id === selectedStudent);
    const sessionInfo = related(candidate?.attendance_sessions);
    if (!candidate || !sessionInfo) {
      setError('Choose an attendance record to request a correction.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const { error: insertError } = await requireSupabase().from('attendance_correction_requests').insert({
        school_id: schoolId,
        session_id: candidate.session_id,
        student_id: selectedStudent,
        requested_by: userId,
        requested_status: selectedCorrectionStatus,
        requested_arrival_time: selectedCorrectionStatus === 'late' ? correctionArrivalTime || null : null,
        reason: correctionReason.trim(),
      });
      if (insertError) throw insertError;
      setCorrectionReason('');
      setCorrectionArrivalTime('');
      setNotice('Correction request submitted for staff review.');
      await loadPanel();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not request this correction.');
    } finally {
      setSaving(false);
    }
  }

  async function reviewCorrection(item: CorrectionRow, decision: 'approved' | 'rejected') {
    setSaving(true);
    setError('');
    try {
      const { error: rpcError } = await requireSupabase().rpc('review_attendance_correction_request', {
        target_request: item.id,
        decision,
        note: null,
      });
      if (rpcError) throw rpcError;
      setNotice(`Correction request ${decision}.`);
      await loadPanel();
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Could not review this correction request.');
    } finally {
      setSaving(false);
    }
  }

  async function bulkReviewCorrections(decision: 'approved' | 'rejected') {
    const selected = corrections.filter((item) => selectedCorrectionIds.includes(item.id) && item.status === 'pending');
    if (!selected.length) return;
    setSaving(true);
    setError('');
    setNotice('');
    let completed = 0;
    const failures: string[] = [];
    try {
      const client = requireSupabase();
      for (const item of selected) {
        const { error: reviewError } = await client.rpc('review_attendance_correction_request', {
          target_request: item.id,
          decision,
          note: null,
        });
        if (reviewError) failures.push(`${item.id}: ${reviewError.message}`);
        else completed += 1;
      }
      setSelectedCorrectionIds([]);
      await loadPanel();
      if (failures.length) {
        setError(`${completed} correction request(s) reviewed; ${failures.length} failed. ${failures.slice(0, 3).join(' ')}`);
      } else {
        setNotice(`${completed} correction request(s) ${decision}.`);
      }
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Could not review selected correction requests.');
    } finally {
      setSaving(false);
    }
  }

  async function withdrawCorrection(id: string) {
    setSaving(true);
    setError('');
    try {
      const { error: updateError } = await requireSupabase().from('attendance_correction_requests')
        .update({ status: 'withdrawn' }).eq('school_id', schoolId).eq('id', id);
      if (updateError) throw updateError;
      setNotice('Correction request withdrawn.');
      await loadPanel();
    } catch (withdrawError) {
      setError(withdrawError instanceof Error ? withdrawError.message : 'Could not withdraw this correction request.');
    } finally {
      setSaving(false);
    }
  }

  async function importAttendanceCsv(file: File) {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const rows = parseCsv(await file.text());
      if (!rows.length) throw new Error('The CSV file is empty.');
      const headers = rows[0].map((header, index) =>
        header.replace(/^\uFEFF/, '').trim().toLowerCase() || `column_${index}`);
      const requiredHeaders = ['session_id', 'student_id', 'status'];
      const missingHeaders = requiredHeaders.filter((header) => !headers.includes(header));
      if (missingHeaders.length) throw new Error(`Required CSV columns: ${requiredHeaders.join(', ')}.`);
      const indexOf = (header: string) => headers.indexOf(header);
      const rowsToInsert = rows.slice(1).map((cells, rowIndex) => {
        const value = (header: string) => {
          const columnIndex = indexOf(header);
          return columnIndex < 0 ? '' : (cells[columnIndex] ?? '').trim();
        };
        const status = value('status').toLowerCase();
        if (!value('session_id') || !value('student_id')
            || !['present', 'absent', 'late', 'excused'].includes(status)) {
          throw new Error(`Invalid session_id, student_id, or status on CSV row ${rowIndex + 2}.`);
        }
        return {
          school_id: schoolId,
          session_id: value('session_id'),
          student_id: value('student_id'),
          status,
          note: value('note') || null,
          arrival_time: value('arrival_time') || null,
          departure_time: value('departure_time') || null,
          absence_reason: value('absence_reason') || null,
          absence_category: value('absence_category') || null,
        };
      });
      if (!rowsToInsert.length) throw new Error('The CSV has no attendance rows to import.');
      const { error: insertError } = await requireSupabase().from('attendance_records').insert(rowsToInsert);
      if (insertError) throw insertError;
      setNotice(`${rowsToInsert.length} attendance record(s) imported. Existing records are not overwritten.`);
      await loadPanel();
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Could not import attendance data.');
    } finally {
      setSaving(false);
    }
  }

  async function assignSubstitute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!substituteSession || !substituteTeacher || !substituteReason.trim()) return;
    setSaving(true);
    setError('');
    try {
      const { error: insertError } = await requireSupabase().from('attendance_substitute_assignments').upsert({
        school_id: schoolId,
        session_id: substituteSession,
        substitute_teacher_id: substituteTeacher,
        assigned_by: userId,
        reason: substituteReason.trim(),
      }, { onConflict: 'school_id,session_id' });
      if (insertError) throw insertError;
      setNotice('Substitute teacher assigned to the register.');
      setSubstituteReason('');
      await loadPanel();
    } catch (assignError) {
      setError(assignError instanceof Error ? assignError.message : 'Could not assign the substitute teacher.');
    } finally {
      setSaving(false);
    }
  }

  async function saveNotificationTemplate(template: NotificationTemplate) {
    setSaving(true);
    setError('');
    try {
      const { error: saveError } = await requireSupabase().from('attendance_notification_templates').upsert({
        school_id: schoolId,
        ...template,
        updated_by: userId,
      }, { onConflict: 'school_id,event_type,channel' });
      if (saveError) throw saveError;
      setNotice(`${statusLabel(template.channel)} notification template saved.`);
      await loadPanel();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save this notification template.');
    } finally {
      setSaving(false);
    }
  }

  const visibleAnalyticsRecords = useMemo(() => analyticsRecords.filter((record) => {
    const session = related(record.attendance_sessions);
    return !selectedClass || session?.class_id === selectedClass;
  }), [analyticsRecords, selectedClass]);

  const classCounts = useMemo(() => {
    const totals = new Map<string, { present: number; count: number }>();
    for (const record of visibleAnalyticsRecords) {
      const session = related(record.attendance_sessions);
      if (!session) continue;
      const item = totals.get(session.class_id) ?? { present: 0, count: 0 };
      item.count += 1;
      if (record.status === 'present' || record.status === 'late') item.present += 1;
      totals.set(session.class_id, item);
    }
    return classes.map((classItem) => ({
      ...classItem,
      ...(totals.get(classItem.id) ?? { present: 0, count: 0 }),
    })).filter((item) => !selectedClass || item.id === selectedClass);
  }, [visibleAnalyticsRecords, classes, selectedClass]);

  const dailyCounts = useMemo(() => {
    const daily = new Map<string, { present: number; count: number }>();
    for (const record of visibleAnalyticsRecords) {
      const session = related(record.attendance_sessions);
      if (!session) continue;
      const day = session.attendance_date;
      if (!day) continue;
      const current = daily.get(day) ?? { present: 0, count: 0 };
      current.count += 1;
      if (record.status === 'present' || record.status === 'late') current.present += 1;
      daily.set(day, current);
    }
    return [...daily.entries()].sort(([left], [right]) => right.localeCompare(left)).slice(0, 31);
  }, [visibleAnalyticsRecords]);

  const completedCount = sessions.filter((session) => session.status !== 'open').length;
  const assignedSessions = sessions.filter((session) => session.assigned_teacher_id);
  const todaySessions = sessions.filter((session) => session.attendance_date === dateToday());
  const unsubmittedToday = todaySessions.filter((session) => session.status === 'open').length;

  const panelTabs: { id: PanelTab; label: string }[] = manager || role === 'teacher'
    ? [
      { id: 'automation', label: 'Automation & follow-up' },
      { id: 'leave', label: 'Leave requests' },
      { id: 'analytics', label: 'Analytics' },
      { id: 'operations', label: 'Operations' },
    ]
    : [{ id: 'leave', label: 'Leave & corrections' }];

  if (!active) return null;

  return (
    <section className="attendance-advanced-workspace">
      <div className="attendance-tabs" role="tablist" aria-label="Advanced attendance tools">
        {panelTabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id}
          className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}</button>)}
      </div>
      {error && <ErrorState message={error} />}
      {notice && <div className="attendance-advanced-message success" role="status">{notice}</div>}

      {tab === 'automation' && (manager || role === 'teacher') && <>
        <div className="attendance-report-summary">
          <div><strong>{todaySessions.length}</strong><span>Registers today</span></div>
          <div><strong>{unsubmittedToday}</strong><span>Not submitted</span></div>
          <div><strong>{missingLessons.length}</strong><span>Missing lesson registers</span></div>
          <div><strong>{tasks.length}</strong><span>Open follow-ups</span></div>
          <div><strong>{assignedSessions.length}</strong><span>Teacher-assigned registers</span></div>
        </div>
        {missingLessons.length > 0 && <section className="attendance-override"><AlertTriangle size={15} /><strong>Missed register alerts:</strong>
          {missingLessons.slice(0, 8).map((lesson) => <span key={lesson.id}>{related(lesson.school_class)?.name ?? 'Class'}</span>)}
          <span>·</span><span>Generate registers above, or ask a coordinator to review the published timetable.</span>
        </section>}
        {manager && <form className="content-card attendance-automation-form" onSubmit={(event) => void runRegisterGeneration(event)}>
          <div><span className="eyebrow"><CalendarClock size={14} /> Timetable integration</span><h2>Generate lesson registers</h2>
            <p>Create registers from published lesson periods and assign each to its scheduled teacher. Holidays and closed calendar days are skipped.</p></div>
          <div className="attendance-automation-fields">
            <label>From<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} required /></label>
            <label>To<input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} required /></label>
            <label>Class<select value={selectedClass} onChange={(event) => setSelectedClass(event.target.value)}><option value="">All classes</option>{classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <button type="submit" className="button button-primary" disabled={saving}><CalendarClock size={15} />Generate registers</button>
          </div>
        </form>}
        {manager && <section className="content-card attendance-automation-form">
          <div><span className="eyebrow"><AlertTriangle size={14} /> Attendance intervention</span><h2>Follow-up and reminders</h2>
            <p>Find repeated and consecutive absences, below-threshold attendance, and send in-app reminders for unexplained absences older than two days.</p></div>
          <button type="button" className="button button-quiet" onClick={() => void runFollowups()} disabled={saving}><RefreshCw size={15} />Run follow-up scan</button>
        </section>}
        {manager && <form className="content-card attendance-automation-form" onSubmit={(event) => void assignSubstitute(event)}>
          <div><span className="eyebrow"><UserRoundCog size={14} /> Teacher assignment</span><h2>Assign a substitute teacher</h2>
            <p>Substitutes can complete and submit only the register assigned to them.</p></div>
          <div className="attendance-automation-fields">
            <label>Lesson register<select value={substituteSession} onChange={(event) => setSubstituteSession(event.target.value)} required><option value="">Choose a register</option>{sessions.filter((session) => session.session_type === 'lesson' && session.status !== 'closed').map((session) => <option key={session.id} value={session.id}>{session.attendance_date} · {related(session.school_class)?.name ?? 'Class'} · {session.status}</option>)}</select></label>
            <label>Substitute<select value={substituteTeacher} onChange={(event) => setSubstituteTeacher(event.target.value)} required><option value="">Choose a teacher</option>{teachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.first_name} {teacher.last_name}</option>)}</select></label>
            <label>Reason<input value={substituteReason} onChange={(event) => setSubstituteReason(event.target.value)} minLength={3} maxLength={500} required /></label>
            <button type="submit" className="button button-quiet" disabled={saving}><UserRoundCog size={15} />Assign substitute</button>
          </div>
        </form>}
        {manager && <>
        <section className="content-card attendance-operations-card">
          <div className="attendance-table-heading"><div><span className="eyebrow">Templates and channels</span><h2>Notification templates</h2></div></div>
          <p className="attendance-automation-copy">In-app notifications are sent immediately. Email and SMS templates are queued when enabled; push delivery requires device subscriptions. External queue items require a configured delivery worker.</p>
          {notificationTemplates.length ? <div className="attendance-template-grid">{notificationTemplates.map((template) => <article key={`${template.event_type}:${template.channel}`}>
            <label className="attendance-setting-check"><input type="checkbox" checked={template.enabled} onChange={(event) => setNotificationTemplates((current) => current.map((item) => item.event_type === template.event_type && item.channel === template.channel ? { ...item, enabled: event.target.checked } : item))} />{statusLabel(template.event_type)} · {statusLabel(template.channel)}</label>
            <input aria-label="Notification title template" value={template.title_template} maxLength={160} onChange={(event) => setNotificationTemplates((current) => current.map((item) => item.event_type === template.event_type && item.channel === template.channel ? { ...item, title_template: event.target.value } : item))} />
            <textarea aria-label="Notification body template" value={template.body_template} maxLength={2000} onChange={(event) => setNotificationTemplates((current) => current.map((item) => item.event_type === template.event_type && item.channel === template.channel ? { ...item, body_template: event.target.value } : item))} />
            <button type="button" className="button button-quiet" onClick={() => void saveNotificationTemplate(template)} disabled={saving}>Save template</button>
          </article>)}</div> : <EmptyState title="No notification templates configured" detail="In-app templates are created for each school by the attendance migration." />}
        </section>
        <section className="content-card attendance-operations-card">
          <div className="attendance-table-heading"><div><span className="eyebrow">Delivery outcomes</span><h2>Notification history</h2></div></div>
          {deliveryHistory.length ? <div className="table-scroll"><table><thead><tr><th>Event</th><th>Channel</th><th>Delivery</th><th>Details</th><th>Created</th></tr></thead><tbody>{deliveryHistory.map((delivery) => <tr key={delivery.id}><td>{statusLabel(delivery.event_type)}</td><td>{statusLabel(delivery.channel)}</td><td>{statusLabel(delivery.status)}</td><td>{delivery.error_message ?? '—'}</td><td>{new Date(delivery.created_at).toLocaleString()}</td></tr>)}</tbody></table></div> : <EmptyState title="No notification deliveries yet" detail="Attendance notification delivery outcomes will appear here." />}
        </section>
        </>}
        <section className="content-card attendance-operations-card">
          <div className="attendance-table-heading"><div><span className="eyebrow">Completion tracking</span><h2>Register completion</h2></div>
            <span>{completedCount} submitted or closed of {sessions.length} shown</span></div>
          {sessions.length > 0 && <div className="attendance-session-actions">
            <span>{selectedSessionIds.length} selected</span>
            <button type="button" className="button button-primary" onClick={() => void bulkTransitionSessions('submitted')}
              disabled={saving || !sessions.some((session) => selectedSessionIds.includes(session.id) && session.status === 'open')}>Submit selected open registers</button>
            {manager && <button type="button" className="button button-quiet" onClick={() => void bulkTransitionSessions('closed')}
              disabled={saving || !sessions.some((session) => selectedSessionIds.includes(session.id) && session.status === 'submitted')}>Close selected submitted registers</button>}
          </div>}
          {loading ? <p className="settings-readonly">Loading registers…</p> : sessions.length ? <div className="table-scroll"><table><thead><tr><th>Select</th><th>Date</th><th>Class</th><th>Type</th><th>Teacher assignment</th><th>State</th></tr></thead><tbody>{sessions.slice(0, 50).map((session) => <tr key={session.id}><td><input type="checkbox" aria-label={`Select register for ${related(session.school_class)?.name ?? 'class'} on ${session.attendance_date}`} checked={selectedSessionIds.includes(session.id)} onChange={(event) => setSelectedSessionIds((current) => event.target.checked ? [...current, session.id] : current.filter((id) => id !== session.id))} /></td><td>{session.attendance_date}</td><td>{related(session.school_class)?.name ?? 'Class'}</td><td>{statusLabel(session.session_type)}</td><td>{session.assigned_teacher_id ? teachers.find((teacher) => teacher.id === session.assigned_teacher_id)?.first_name ?? 'Assigned' : 'Class teacher'}</td><td><span className={`attendance-state-chip state-${session.status}`}>{session.status}</span></td></tr>)}</tbody></table></div> : <EmptyState title="No registers found" detail="Generate lesson registers from a published timetable or take attendance manually." />}
        </section>
        <section className="content-card attendance-operations-card">
          <div className="attendance-table-heading"><div><span className="eyebrow">Staff follow-up tasks</span><h2>Attendance tasks</h2></div></div>
          {tasks.length ? <div className="table-scroll"><table><thead><tr><th>Student</th><th>Follow-up</th><th>Details</th><th>Status</th><th>Action</th></tr></thead><tbody>{tasks.map((task) => {
            const student = related(task.students);
            return <tr key={task.id}><td>{student ? `${student.first_name} ${student.last_name}` : 'Student'}</td><td>{task.title}</td><td>{task.details}</td><td>{statusLabel(task.status)}</td><td><button className="button button-quiet" type="button" onClick={() => void updateTask(task, task.status === 'open' ? 'in_progress' : 'resolved')} disabled={saving}>{task.status === 'open' ? 'Start follow-up' : 'Resolve'}</button></td></tr>;
          })}</tbody></table></div> : <EmptyState title="No open follow-up tasks" detail="Run the follow-up scan to check configured absence and attendance thresholds." />}
        </section>
      </>}

      {tab === 'leave' && <>
        {family && <form className="content-card attendance-automation-form" onSubmit={(event) => void submitLeave(event)}>
          <div><span className="eyebrow"><FileText size={14} /> Planned absence</span><h2>Request student leave</h2>
            <p>Submit planned absences for review. Approved leave marks matching absent registers as excused.</p></div>
          <div className="attendance-automation-fields">
            <label>Student<select value={selectedStudent} onChange={(event) => setSelectedStudent(event.target.value)} required><option value="">Choose student</option>{students.map((student) => <option key={student.id} value={student.id}>{student.first_name} {student.last_name} · {student.student_number}</option>)}</select></label>
            <label>First day<input type="date" value={leaveStart} onChange={(event) => setLeaveStart(event.target.value)} required /></label>
            <label>Last day<input type="date" value={leaveEnd} min={leaveStart} onChange={(event) => setLeaveEnd(event.target.value)} required /></label>
            <label>Category<select value={leaveCategory} onChange={(event) => setLeaveCategory(event.target.value)}><option value="medical">Medical</option><option value="authorized">Authorized</option><option value="other">Other</option></select></label>
            <label>Reason<textarea value={leaveReason} onChange={(event) => setLeaveReason(event.target.value)} minLength={3} maxLength={1000} required /></label>
            <label>Supporting document (PDF, JPEG, PNG; max 10 MB)<input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(event) => setLeaveFile(event.target.files?.[0] ?? null)} /></label>
            <button type="submit" className="button button-primary" disabled={saving || !selectedStudent}><Send size={15} />Submit request</button>
          </div>
        </form>}
        <section className="content-card attendance-operations-card">
          <div className="attendance-table-heading"><div><span className="eyebrow">Request history</span><h2>{manager ? 'Student leave requests' : 'Your leave requests'}</h2></div></div>
          {leaveRows.length ? <div className="table-scroll"><table><thead><tr><th>Student</th><th>Dates</th><th>Category / reason</th><th>Document</th><th>Status</th><th>Action</th></tr></thead><tbody>{leaveRows.map((item) => {
            const student = related(item.students);
            return <tr key={item.id}><td>{student ? `${student.first_name} ${student.last_name}` : 'Student'}</td><td>{item.start_date} – {item.end_date}</td><td>{item.category} · {item.reason}</td><td>{item.supporting_document_path ? <button type="button" className="button button-quiet" onClick={() => void viewDocument(item.supporting_document_path!)}>View file</button> : '—'}</td><td><span className={`attendance-state-chip state-${item.status}`}>{item.status}</span></td><td>{manager && item.status === 'pending' ? <div className="attendance-session-actions"><button type="button" className="button button-primary" onClick={() => void reviewLeave(item.id, 'approved')} disabled={saving}><Check size={14} />Approve</button><button type="button" className="button button-quiet" onClick={() => void reviewLeave(item.id, 'rejected')} disabled={saving}>Reject</button></div> : family && item.status === 'pending' ? <button type="button" className="button button-quiet" onClick={() => void withdrawLeave(item.id)} disabled={saving}>Withdraw</button> : '—'}</td></tr>;
          })}</tbody></table></div> : <EmptyState title="No leave requests" detail="Leave requests and their decisions will appear here." />}
        </section>
        {family && corrections.filter((item) => item.requested_by === userId).length > 0 && <section className="content-card attendance-operations-card">
          <div className="attendance-table-heading"><div><span className="eyebrow">Correction history</span><h2>Your correction requests</h2></div></div>
          <div className="table-scroll"><table><thead><tr><th>Student</th><th>Date / session</th><th>Requested status</th><th>Reason</th><th>Status</th><th>Action</th></tr></thead><tbody>{corrections.filter((item) => item.requested_by === userId).map((item) => {
            const student = related(item.students);
            const session = related(item.session);
            return <tr key={item.id}><td>{student ? `${student.first_name} ${student.last_name}` : 'Student'}</td><td>{session ? `${session.attendance_date} · ${statusLabel(session.session_type)}` : '—'}</td><td>{item.requested_status ?? '—'}</td><td>{item.reason}</td><td>{statusLabel(item.status)}</td><td>{item.status === 'pending' && <button type="button" className="button button-quiet" onClick={() => void withdrawCorrection(item.id)} disabled={saving}>Withdraw</button>}</td></tr>;
          })}</tbody></table></div>
        </section>}
        {family && <section className="content-card attendance-automation-form">
          <div><span className="eyebrow"><ShieldCheck size={14} /> Correction request</span><h2>Request an attendance correction</h2><p>Select a saved attendance record and provide a reason for the requested change.</p></div>
          <form className="attendance-automation-fields" onSubmit={(event) => void submitCorrection(event)}>
            <label>Student<select value={selectedStudent} onChange={(event) => setSelectedStudent(event.target.value)}><option value="">Choose student</option>{students.map((student) => <option key={student.id} value={student.id}>{student.first_name} {student.last_name}</option>)}</select></label>
            <label>Record date<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label>
            <label>Attendance record<select value={correctionSessionId} onChange={(event) => setCorrectionSessionId(event.target.value)}><option value="">Choose record</option>{analyticsRecords.filter((record) => related(record.students)?.id === selectedStudent).map((record) => {
              const session = related(record.attendance_sessions);
              return session ? <option key={`${record.session_id}:${record.student_id}`} value={record.session_id}>{session.attendance_date} · {statusLabel(session.session_type)} · {record.status}</option> : null;
            })}</select></label>
            <label>Requested status<select value={selectedCorrectionStatus} onChange={(event) => setSelectedCorrectionStatus(event.target.value as AttendanceStatus)}><option value="present">Present</option><option value="absent">Absent</option><option value="late">Late</option><option value="excused">Excused</option></select></label>
            {selectedCorrectionStatus === 'late' && <label>Arrival time<input type="time" value={correctionArrivalTime} onChange={(event) => setCorrectionArrivalTime(event.target.value)} required /></label>}
            <label>Reason<textarea value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} minLength={3} maxLength={1000} required /></label>
            <button className="button button-quiet" type="submit" disabled={saving || !selectedStudent}>Submit correction request</button>
          </form>
        </section>}
      </>}

      {tab === 'analytics' && (manager || role === 'teacher') && <>
        <section className="content-card attendance-report-filters">
          <label>From<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label>
          <label>To<input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label>
          <label>Class<select value={selectedClass} onChange={(event) => setSelectedClass(event.target.value)}><option value="">All assigned classes</option>{classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <button type="button" className="button button-quiet" onClick={() => void loadPanel()} disabled={loading}><RefreshCw size={14} />Refresh</button>
        </section>
        <div className="attendance-report-summary">
          <div><strong>{visibleAnalyticsRecords.length ? Math.round(visibleAnalyticsRecords.filter((record) => record.status === 'present' || record.status === 'late').length / visibleAnalyticsRecords.length * 100) : 0}%</strong><span>Attendance rate</span></div>
          <div><strong>{visibleAnalyticsRecords.length}</strong><span>Records in range</span></div>
          <div><strong>{visibleAnalyticsRecords.filter((record) => record.status === 'late').length}</strong><span>Late arrivals</span></div>
          <div><strong>{visibleAnalyticsRecords.filter((record) => record.status === 'absent').length}</strong><span>Absences</span></div>
        </div>
        <section className="content-card attendance-operations-card">
          <div className="attendance-table-heading"><div><span className="eyebrow">Class comparison</span><h2>Attendance by class</h2></div></div>
          <div className="table-scroll"><table><thead><tr><th>Class</th><th>Present / late</th><th>Records</th><th>Rate</th></tr></thead><tbody>{classCounts.map((item) => <tr key={item.id}><td>{item.name}</td><td>{item.present}</td><td>{item.count}</td><td>{item.count ? `${Math.round(item.present / item.count * 100)}%` : '—'}</td></tr>)}</tbody></table></div>
        </section>
        <section className="content-card attendance-operations-card">
          <div className="attendance-table-heading"><div><span className="eyebrow">Daily trend</span><h2>Attendance by date</h2></div></div>
          {dailyCounts.length ? <div className="table-scroll"><table><thead><tr><th>Date</th><th>Present / late</th><th>Records</th><th>Rate</th></tr></thead><tbody>{dailyCounts.map(([day, item]) => <tr key={day}><td>{day}</td><td>{item.present}</td><td>{item.count}</td><td>{item.count ? `${Math.round(item.present / item.count * 100)}%` : '—'}</td></tr>)}</tbody></table></div> : <EmptyState title="No attendance trends yet" detail="Choose a date range containing saved registers." />}
        </section>
      </>}

      {tab === 'operations' && (manager || role === 'teacher') && <>
        <section className="content-card attendance-operations-card">
          <div className="attendance-table-heading"><div><span className="eyebrow">Operational import</span><h2>Import attendance CSV</h2></div></div>
          <p className="attendance-automation-copy">Use columns session_id, student_id, and status. Optional columns: note, arrival_time, departure_time, absence_reason, absence_category. Imports only add records; existing records are never overwritten.</p>
          <label className="attendance-file-input">Choose attendance CSV<input type="file" accept=".csv,text/csv" disabled={saving}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importAttendanceCsv(file);
              event.currentTarget.value = '';
            }} /></label>
        </section>
        <section className="content-card attendance-operations-card">
          <div className="attendance-table-heading"><div><span className="eyebrow"><ShieldCheck size={14} /> Correction approval</span><h2>Requests awaiting review</h2></div></div>
          {corrections.length > 0 && <div className="attendance-session-actions">
            <span>{selectedCorrectionIds.length} selected</span>
            <button type="button" className="button button-primary" onClick={() => void bulkReviewCorrections('approved')}
              disabled={saving || !selectedCorrectionIds.length}>Approve selected</button>
            <button type="button" className="button button-quiet" onClick={() => void bulkReviewCorrections('rejected')}
              disabled={saving || !selectedCorrectionIds.length}>Reject selected</button>
          </div>}
          {corrections.length ? <div className="table-scroll"><table><thead><tr><th>Select</th><th>Student</th><th>Requested status</th><th>Reason</th><th>Submitted</th><th>Decision</th></tr></thead><tbody>{corrections.map((item) => {
            const student = related(item.students);
            return <tr key={item.id}><td><input type="checkbox" aria-label={`Select correction request for ${student?.first_name ?? 'student'} ${student?.last_name ?? ''}`} checked={selectedCorrectionIds.includes(item.id)} onChange={(event) => setSelectedCorrectionIds((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /></td><td>{student ? `${student.first_name} ${student.last_name}` : 'Student'}</td><td>{item.requested_status ?? 'No replacement specified'}</td><td>{item.reason}</td><td>{new Date(item.created_at).toLocaleDateString()}</td><td><div className="attendance-session-actions"><button type="button" className="button button-primary" onClick={() => void reviewCorrection(item, 'approved')} disabled={saving}><Check size={14} />Approve</button><button type="button" className="button button-quiet" onClick={() => void reviewCorrection(item, 'rejected')} disabled={saving}>Reject</button></div></td></tr>;
          })}</tbody></table></div> : <EmptyState title="No correction requests" detail="Family correction requests will appear here for authorized review." />}
        </section>
        <section className="content-card attendance-operations-card">
          <div className="attendance-table-heading"><div><span className="eyebrow">Export</span><h2>Attendance analytics data</h2></div>
            <button type="button" className="button button-quiet" onClick={() => {
              const rows = [
                ['Student ID', 'Student', 'Date', 'Class ID', 'Status', 'Absence category'],
                ...visibleAnalyticsRecords.map((record) => {
                  const student = related(record.students);
                  const session = related(record.attendance_sessions);
                  return [student?.student_number ?? '', student ? `${student.first_name} ${student.last_name}` : '', session?.attendance_date ?? '', session?.class_id ?? '', record.status, record.absence_category];
                }),
              ];
              const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\r\n');
              const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
              const anchor = document.createElement('a');
              anchor.href = url;
              anchor.download = 'attendance-analytics.csv';
              anchor.click();
              URL.revokeObjectURL(url);
            }}><Download size={15} />Export CSV</button>
          </div>
          <p className="attendance-automation-copy">Analytics are restricted by attendance row-level security and the selected reporting window.</p>
        </section>
      </>}
      {loading && <p className="settings-readonly">Refreshing attendance tools…</p>}
    </section>
  );
}
