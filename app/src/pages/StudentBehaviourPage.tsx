import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { jsPDF } from 'jspdf';
import QRCode from 'qrcode';
import { AlertCircle, Award, Check, Download, FileText, Mail, Plus, RefreshCw, ShieldCheck, UsersRound } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState } from '../components/Feedback';
import { StudentBehaviourEmailSettings } from './StudentBehaviourEmailSettings';
import { StudentBehaviourRecordWorkflowPanel } from './StudentBehaviourRecordWorkflowPanel';
import { requireSupabase } from '../lib/supabase';

type BehaviourCategory = 'positive' | 'negative';
type BehaviourStudent = {
  id: string;
  student_number: string;
  first_name: string;
  last_name: string;
  class_name: string;
};
type BehaviourType = {
  id: string;
  name: string;
  category: BehaviourCategory;
  description: string;
  points: number | null;
  active: boolean;
};
type BehaviourAction = {
  id: string;
  name: string;
  description: string;
  active: boolean;
};
type BehaviourRecord = {
  id: string;
  student_id: string;
  student_name: string;
  student_number: string;
  class_name: string;
  school_name: string;
  behaviour_type_id: string;
  behaviour_type_name: string;
  category: BehaviourCategory;
  points_awarded: number | null;
  action_id: string | null;
  action_name: string | null;
  reported_by: string;
  reported_by_name: string;
  occurred_at: string;
  location: string;
  description: string;
  actions_taken: string;
  status: string;
  severity: string;
  context: string;
  student_perspective: string;
  guardian_visible: boolean;
  confidential: boolean;
  review_note: string;
  created_at: string;
  updated_at: string;
};
type RecordParticipant = { record_id: string; student_id: string };

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

async function functionErrorMessage(error: unknown, fallback: string) {
  if (typeof error === 'object' && error !== null && 'context' in error
    && error.context instanceof Response) {
    try {
      const body: unknown = await error.context.clone().json();
      if (typeof body === 'object' && body !== null && !Array.isArray(body)
        && 'error' in body && typeof body.error === 'string') {
        return body.error;
      }
    } catch {
      return messageOf(error, fallback);
    }
  }
  return messageOf(error, fallback);
}

function displayDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function inputDateTime(value = new Date()) {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function behaviourReportUrl(id: string) {
  return new URL(`/behaviour/report/${id}`, window.location.origin).toString();
}

function safeFilename(value: string) {
  return value.trim().replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'student';
}

export function StudentBehaviourPage() {
  const { activeMembership, user } = useAuth();
  const { recordId } = useParams<{ recordId: string }>();
  const role = activeMembership?.role;
  const schoolId = activeMembership?.school_id;
  const isFamilyReport = (role === 'parent' || role === 'student') && Boolean(recordId);
  const canUseBehaviour = ['school_admin', 'academic_coordinator', 'teacher', 'librarian', 'secretary', 'hr_staff_administrator', 'safeguarding_officer'].includes(role ?? '');
  const canConfigure = role === 'school_admin';
  const canReview = ['school_admin', 'academic_coordinator', 'safeguarding_officer'].includes(role ?? '');
  const [students, setStudents] = useState<BehaviourStudent[]>([]);
  const [types, setTypes] = useState<BehaviourType[]>([]);
  const [actions, setActions] = useState<BehaviourAction[]>([]);
  const [records, setRecords] = useState<BehaviourRecord[]>([]);
  const [participants, setParticipants] = useState<RecordParticipant[]>([]);
  const [pointsEnabled, setPointsEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [emailingReportId, setEmailingReportId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedRecord, setSelectedRecord] = useState<BehaviourRecord | null>(null);
  const [tab, setTab] = useState<'records' | 'review' | 'settings'>('records');
  const [typeName, setTypeName] = useState('');
  const [typeCategory, setTypeCategory] = useState<BehaviourCategory>('positive');
  const [typeDescription, setTypeDescription] = useState('');
  const [typePoints, setTypePoints] = useState('');
  const [actionName, setActionName] = useState('');
  const [actionDescription, setActionDescription] = useState('');
  const [studentId, setStudentId] = useState('');
  const [typeId, setTypeId] = useState('');
  const [actionId, setActionId] = useState('');
  const [involvedIds, setInvolvedIds] = useState<string[]>([]);
  const [occurredAt, setOccurredAt] = useState(inputDateTime());
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<'minor' | 'moderate' | 'serious'>('minor');
  const [context, setContext] = useState('');
  const [studentPerspective, setStudentPerspective] = useState('');
  const [confidential, setConfidential] = useState(false);
  const [reviewNote, setReviewNote] = useState('');
  const [actionsTaken, setActionsTaken] = useState('');
  const [search, setSearch] = useState('');
  const [parentRecord, setParentRecord] = useState<BehaviourRecord | null>(null);

  const studentById = useMemo(() => new Map(students.map((student) => [student.id, student])), [students]);
  const activeTypes = useMemo(() => types.filter((item) => item.active), [types]);
  const activeActions = useMemo(() => actions.filter((item) => item.active), [actions]);
  const filteredRecords = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return records.filter((record) =>
      !needle
      || `${record.student_name} ${record.student_number} ${record.behaviour_type_name} ${record.description} ${record.location}`
        .toLocaleLowerCase().includes(needle));
  }, [records, search]);

  const loadData = useCallback(async (background = false) => {
    if (!schoolId) return;
    if (background) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      if (recordId) {
        const { data, error: recordError } = await client.from('student_behaviour_records')
          .select('id,school_id,student_id,student_name,student_number,class_name,school_name,behaviour_type_id,behaviour_type_name,category,points_awarded,action_id,action_name,reported_by,reported_by_name,occurred_at,location,description,actions_taken,status,severity,context,student_perspective,guardian_visible,confidential,review_note,created_at,updated_at')
          .eq('id', recordId).maybeSingle();
        if (recordError) throw recordError;
        if (!data) throw new Error('This report is unavailable or you do not have permission to view it.');
        setParentRecord(data as BehaviourRecord);
        setSelectedRecord(data as BehaviourRecord);
        if (!isFamilyReport) {
          const { data: participantData, error: participantError } = await client
            .from('student_behaviour_record_participants')
            .select('record_id,student_id')
            .eq('record_id', recordId);
          if (participantError) throw participantError;
          setParticipants((participantData ?? []) as RecordParticipant[]);
        }
        return;
      }

      if (!canUseBehaviour) {
        throw new Error('Your school role cannot access student behaviour management.');
      }

      const [studentResult, typeResult, actionResult, settingResult, recordResult] = await Promise.all([
        client.rpc('list_student_behaviour_students', { target_school: schoolId }),
        client.from('student_behaviour_types').select('id,name,category,description,points,active')
          .eq('school_id', schoolId).order('category').order('name'),
        client.from('student_behaviour_actions').select('id,name,description,active')
          .eq('school_id', schoolId).order('name'),
        client.from('student_behaviour_settings').select('points_enabled')
          .eq('school_id', schoolId).maybeSingle(),
        client.from('student_behaviour_records')
          .select('id,student_id,student_name,student_number,class_name,school_name,behaviour_type_id,behaviour_type_name,category,points_awarded,action_id,action_name,reported_by,reported_by_name,occurred_at,location,description,actions_taken,status,severity,context,student_perspective,guardian_visible,confidential,review_note,created_at,updated_at')
          .eq('school_id', schoolId).order('occurred_at', { ascending: false }).limit(500),
      ]);
      if (studentResult.error) throw studentResult.error;
      if (typeResult.error) throw typeResult.error;
      if (actionResult.error) throw actionResult.error;
      if (settingResult.error) throw settingResult.error;
      if (recordResult.error) throw recordResult.error;
      const nextStudents = (studentResult.data ?? []) as BehaviourStudent[];
      const nextRecords = (recordResult.data ?? []) as BehaviourRecord[];
      setStudents(nextStudents);
      setTypes((typeResult.data ?? []) as BehaviourType[]);
      setActions((actionResult.data ?? []) as BehaviourAction[]);
      setPointsEnabled(settingResult.data?.points_enabled === true);
      setRecords(nextRecords);
      if (nextStudents.length) setStudentId((current) => current || nextStudents[0].id);
      const recordIds = nextRecords.map((record) => record.id);
      if (recordIds.length) {
        const { data: participantData, error: participantError } = await client
          .from('student_behaviour_record_participants')
          .select('record_id,student_id')
          .eq('school_id', schoolId).in('record_id', recordIds);
        if (participantError) throw participantError;
        setParticipants((participantData ?? []) as RecordParticipant[]);
      } else {
        setParticipants([]);
      }
      const defaultType = (typeResult.data ?? []).find((item) => item.active);
      if (defaultType) setTypeId((current) => current || defaultType.id);
    } catch (loadError) {
      setError(messageOf(loadError, 'Could not load student behaviour records.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [canUseBehaviour, isFamilyReport, recordId, schoolId]);

  useEffect(() => {
    setStudents([]);
    setTypes([]);
    setActions([]);
    setRecords([]);
    setParticipants([]);
    setParentRecord(null);
    setLoading(true);
    void loadData();
  }, [loadData]);

  async function saveRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !user?.id || saving) return;
    const occurred = new Date(occurredAt);
    if (!Number.isFinite(occurred.getTime())) {
      setError('Enter a valid date and time for when the behaviour occurred.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    let savedRecordId = '';
    try {
      const client = requireSupabase();
      const { data: recordId, error: insertError } = await client.rpc('create_student_behaviour_record', {
        target_school: schoolId,
        target_student: studentId,
        target_behaviour_type: typeId,
        target_action: actionId || null,
        target_occurred_at: occurred.toISOString(),
        target_location: location.trim(),
        target_description: description.trim(),
        target_actions_taken: actionsTaken.trim(),
        involved_student_ids: involvedIds.filter((id) => id !== studentId),
        target_severity: severity,
        target_context: context.trim(),
        target_student_perspective: studentPerspective.trim(),
        target_confidential: confidential,
      });
      if (insertError) throw insertError;
      if (typeof recordId !== 'string') throw new Error('The saved behaviour report did not return a valid report ID.');
      savedRecordId = recordId;
      const { data: record, error: recordError } = await client.from('student_behaviour_records')
        .select('id,student_id,student_name,student_number,class_name,school_name,behaviour_type_id,behaviour_type_name,category,points_awarded,action_id,action_name,reported_by,reported_by_name,occurred_at,location,description,actions_taken,status,severity,context,student_perspective,guardian_visible,confidential,review_note,created_at,updated_at')
        .eq('id', recordId).single();
      if (recordError) throw recordError;
      setDescription('');
      setActionsTaken('');
      setLocation('');
      setContext('');
      setStudentPerspective('');
      setSeverity('minor');
      setConfidential(false);
      setActionId('');
      setInvolvedIds([]);
      setOccurredAt(inputDateTime());
      setNotice('Behaviour report saved. Download the parent copy to share with the family.');
      await loadData(true);
      setSelectedRecord(record as BehaviourRecord);
    } catch (saveError) {
      if (savedRecordId) {
        setError(`Report ${savedRecordId.slice(0, 8).toUpperCase()} was saved, but its details could not be loaded. Refresh the list before trying again.`);
        void loadData(true);
      } else {
        setError(messageOf(saveError, 'Could not save this behaviour report.'));
      }
    } finally {
      setSaving(false);
    }
  }

  async function saveType(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !user?.id || saving) return;
    const pointsValue = typePoints.trim() ? Number(typePoints) : null;
    if (pointsValue !== null
      && (!Number.isInteger(pointsValue) || pointsValue < -1000 || pointsValue > 1000
        || (typeCategory === 'positive' && pointsValue < 0)
        || (typeCategory === 'negative' && pointsValue > 0))) {
      setError('Points must be an integer from -1,000 to 1,000, and must match the behaviour type.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: saveError } = await requireSupabase().from('student_behaviour_types').insert({
        school_id: schoolId,
        name: typeName.trim(),
        category: typeCategory,
        description: typeDescription.trim(),
        points: pointsValue,
        created_by: user.id,
      });
      if (saveError) throw saveError;
      setTypeName('');
      setTypeDescription('');
      setTypePoints('');
      setNotice('Behaviour type added.');
      await loadData(true);
    } catch (saveError) {
      setError(messageOf(saveError, 'Could not save this behaviour type.'));
    } finally {
      setSaving(false);
    }
  }

  async function saveAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !user?.id || saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: saveError } = await requireSupabase().from('student_behaviour_actions').insert({
        school_id: schoolId,
        name: actionName.trim(),
        description: actionDescription.trim(),
        created_by: user.id,
      });
      if (saveError) throw saveError;
      setActionName('');
      setActionDescription('');
      setNotice('Follow-up action added.');
      await loadData(true);
    } catch (saveError) {
      setError(messageOf(saveError, 'Could not save this follow-up action.'));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(table: 'student_behaviour_types' | 'student_behaviour_actions', item: BehaviourType | BehaviourAction) {
    if (!schoolId || !canConfigure || saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: updateError } = await requireSupabase().from(table)
        .update({ active: !item.active, updated_at: new Date().toISOString() })
        .eq('school_id', schoolId).eq('id', item.id);
      if (updateError) throw updateError;
      setNotice(`${item.name} ${item.active ? 'archived' : 'reactivated'}.`);
      await loadData(true);
    } catch (updateError) {
      setError(messageOf(updateError, 'Could not update this option.'));
    } finally {
      setSaving(false);
    }
  }

  async function changePointsEnabled(enabled: boolean) {
    if (!schoolId || !user?.id || !canConfigure) return;
    setError('');
    setNotice('');
    try {
      const { error: updateError } = await requireSupabase().from('student_behaviour_settings')
        .upsert({ school_id: schoolId, points_enabled: enabled, updated_by: user.id, updated_at: new Date().toISOString() });
      if (updateError) throw updateError;
      setPointsEnabled(enabled);
      setNotice(`Points ${enabled ? 'enabled' : 'disabled'}.`);
    } catch (updateError) {
      setError(messageOf(updateError, 'Could not update the points setting.'));
    }
  }

  async function downloadReport(record: BehaviourRecord, parentCopy = true) {
    if (parentCopy && (!['published', 'resolved', 'closed'].includes(record.status)
      || !record.guardian_visible || record.confidential)) {
      throw new Error('A parent report PDF is available only after the record is published for family access.');
    }
    const qr = await QRCode.toDataURL(behaviourReportUrl(record.id), {
      errorCorrectionLevel: 'Q',
      margin: 1,
      width: 280,
    });
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const margin = 16;
    const contentWidth = pageWidth - margin * 2;
    const schoolName = record.school_name || activeMembership?.school.name || 'School';
    let y = 16;

    const ensureSpace = (height: number) => {
      if (y + height > 267) {
        pdf.addPage();
        y = 18;
      }
    };
    const section = (title: string) => {
      ensureSpace(14);
      pdf.setFillColor(242, 241, 252);
      pdf.roundedRect(margin, y, contentWidth, 9, 2, 2, 'F');
      pdf.setTextColor(66, 54, 120);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(10);
      pdf.text(title.toUpperCase(), margin + 3, y + 6);
      y += 14;
    };
    const field = (label: string, value: string) => {
      if (!value.trim()) return;
      const lines = pdf.splitTextToSize(value.trim(), contentWidth - 42) as string[];
      const lineHeight = 4.2;
      const height = Math.max(6, lines.length * lineHeight + 2);
      ensureSpace(height);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(8);
      pdf.setTextColor(93, 98, 117);
      pdf.text(label, margin, y);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(40, 44, 59);
      pdf.text(lines, margin + 42, y);
      y += height;
    };

    pdf.setFillColor(54, 48, 104);
    pdf.roundedRect(margin, y, contentWidth, 29, 3, 3, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(15);
    pdf.text('Student Behaviour Report', margin + 6, y + 10);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.text(schoolName, margin + 6, y + 18);
    pdf.text(`Report ${record.id.slice(0, 8).toUpperCase()} · Generated ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date())}`, margin + 6, y + 24);
    y += 36;

    section('Student details');
    field('Student', record.student_name);
    field('Student ID', record.student_number);
    field('Class', record.class_name || 'Not assigned');

    section('Behaviour record');
    field('Record type', `${record.behaviour_type_name} (${record.category === 'positive' ? 'Positive' : 'Behaviour concern'})`);
    field('Occurred', displayDate(record.occurred_at));
    field('Reported by', record.reported_by_name || 'School staff');
    field('Location', record.location || 'Not recorded');
    field('Context', record.context);
    field('Severity', record.severity);
    field('What happened', record.description);
    field('Student perspective', record.student_perspective);
    field('Actions taken', record.actions_taken || 'No immediate action recorded.');
    field('Follow-up / consequence', record.action_name ?? 'No follow-up action selected.');
    if (record.points_awarded !== null) field('Points', String(record.points_awarded));
    const otherStudentsCount = participants.filter((participant) => participant.record_id === record.id
      && participant.student_id !== record.student_id).length;
    if (parentCopy) {
      field('Student privacy', 'Any other student identities are withheld to protect their privacy.');
    } else if (!parentCopy && otherStudentsCount) {
      const names = participants.filter((participant) => participant.record_id === record.id
        && participant.student_id !== record.student_id)
        .map((participant) => studentById.get(participant.student_id))
        .filter((student): student is BehaviourStudent => Boolean(student))
        .map((student) => `${student.first_name} ${student.last_name}`)
        .join(', ');
      field('Other students involved', names || `${otherStudentsCount} additional student(s)`);
    }

    ensureSpace(50);
    section('Secure report access');
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(65, 70, 88);
    pdf.text('Scan to sign in and open this protected report. Access is limited to this student’s linked parent or authorized school staff.', margin, y);
    y += 6;
    pdf.addImage(qr, 'PNG', margin, y, 34, 34);
    pdf.setFontSize(7);
    pdf.text('The QR code does not contain report details.', margin + 40, y + 9);
    pdf.text('Keep this document confidential.', margin + 40, y + 15);
    pdf.text(`Recorded ${displayDate(record.created_at)}`, margin + 40, y + 21);
    pdf.setTextColor(110, 114, 128);
    pdf.text('Confidential student information. Share and store securely.', margin, 286);
    pdf.save(`behaviour-report-${safeFilename(record.student_number)}-${record.id.slice(0, 8)}.pdf`);
  }

  async function handleDownloadReport(record: BehaviourRecord, parentCopy = true) {
    setError('');
    try {
      await downloadReport(record, parentCopy);
    } catch (downloadError) {
      setError(messageOf(downloadError, 'Could not create the behaviour report PDF.'));
    }
  }

  async function emailParentReport(record: BehaviourRecord) {
    if (emailingReportId) return;
    setError('');
    setNotice('');
    setEmailingReportId(record.id);
    try {
      const { data, error: invokeError } = await requireSupabase().functions.invoke('student-behaviour-email', {
        body: { action: 'email_report', recordId: record.id },
      });
      if (invokeError) throw invokeError;
      setNotice(data?.sent > 0
        ? 'Behaviour report PDF emailed to linked parent account(s).'
        : 'Behaviour report email queued. It may require staff approval or wait for the next delivery run.');
      setSelectedRecord(null);
    } catch (emailError) {
      setError(await functionErrorMessage(emailError, 'Could not email the behaviour report to the student’s parent.'));
    } finally {
      setEmailingReportId('');
    }
  }

  async function reviewRecord(record: BehaviourRecord, decision: 'under_review' | 'published' | 'returned' | 'resolved' | 'closed') {
    if (!canReview || saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: reviewError } = await requireSupabase().rpc('review_student_behaviour_record', {
        target_record: record.id,
        target_decision: decision,
        target_note: reviewNote.trim(),
        target_guardian_visible: decision === 'published' || decision === 'resolved',
      });
      if (reviewError) throw reviewError;
      setReviewNote('');
      setSelectedRecord(null);
      setNotice(decision === 'published'
        ? 'Record published. Guardian notifications are queued according to school email settings.'
        : `Record marked ${decision.replaceAll('_', ' ')}.`);
      await loadData(true);
    } catch (reviewError) {
      setError(messageOf(reviewError, 'Could not update the behaviour record review.'));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="page-stack"><LoadingState label="Loading behaviour records…" /></div>;

  if (recordId) {
    if (!parentRecord) return <div className="page-stack"><ErrorState message={error || 'This report is unavailable.'} /></div>;
    const isLinkedParent = role === 'parent' || role === 'student';
    const recordParticipants = participants.filter((participant) => participant.record_id === parentRecord.id
      && participant.student_id !== parentRecord.student_id);
    return <div className="page-stack student-behaviour-report">
      <header className="page-heading">
        <div><span className="eyebrow">Protected student record</span><h1>Behaviour report</h1><p>{parentRecord.school_name || activeMembership?.school.name}</p></div>
        {['published', 'resolved', 'closed'].includes(parentRecord.status) && parentRecord.guardian_visible && !parentRecord.confidential
          && <button className="button button-primary" type="button" onClick={() => void handleDownloadReport(parentRecord, true)}>
            <Download size={16} /> Download parent PDF
          </button>}
      </header>
      {error && <ErrorState message={error} />}
      <div className="content-card behaviour-report-card">
        <div className={`behaviour-report-category ${parentRecord.category}`}>
          {parentRecord.category === 'positive' ? <Award size={18} /> : <AlertCircle size={18} />}
          <span>{parentRecord.category === 'positive' ? 'Positive behaviour' : 'Behaviour concern'}</span>
        </div>
        <h2>{parentRecord.behaviour_type_name}</h2>
        <div className="behaviour-report-grid">
          <div><span>Student</span><strong>{parentRecord.student_name}</strong></div>
          <div><span>Student ID</span><strong>{parentRecord.student_number}</strong></div>
          <div><span>Class</span><strong>{parentRecord.class_name || 'Not assigned'}</strong></div>
          <div><span>When</span><strong>{displayDate(parentRecord.occurred_at)}</strong></div>
          <div><span>Reported by</span><strong>{parentRecord.reported_by_name || 'School staff'}</strong></div>
          {parentRecord.location && <div><span>Location</span><strong>{parentRecord.location}</strong></div>}
          {parentRecord.context && <div><span>Context</span><strong>{parentRecord.context}</strong></div>}
          <div><span>Status</span><strong>{parentRecord.status.replaceAll('_', ' ')}</strong></div>
          <div><span>Severity</span><strong>{parentRecord.severity}</strong></div>
          {parentRecord.points_awarded !== null && <div><span>Points</span><strong>{parentRecord.points_awarded}</strong></div>}
        </div>
        <section><h3>What happened</h3><p>{parentRecord.description}</p></section>
        {parentRecord.student_perspective && <section><h3>Student perspective</h3><p>{parentRecord.student_perspective}</p></section>}
        <section><h3>Actions taken</h3><p>{parentRecord.actions_taken || 'No immediate action was recorded.'}</p></section>
        <section><h3>Follow-up / consequence</h3><p>{parentRecord.action_name || 'No follow-up action was selected.'}</p></section>
        {!isLinkedParent && recordParticipants.length > 0 && <section>
          <h3>Other students involved</h3>
          <p>{recordParticipants.map((participant) => studentById.get(participant.student_id))
            .filter((student): student is BehaviourStudent => Boolean(student))
            .map((student) => `${student.first_name} ${student.last_name}`).join(', ') || `${recordParticipants.length} additional student(s)`}</p>
        </section>}
        {isLinkedParent && <p className="behaviour-privacy-note">Any other student identities are withheld to protect their privacy.</p>}
        <p className="behaviour-report-footnote"><ShieldCheck size={15} /> This secure report is visible only to linked parents and authorized school staff.</p>
      </div>
    </div>;
  }

  if (!canUseBehaviour) {
    return <div className="page-stack">
      <div className="page-heading"><div><span className="eyebrow">Student wellbeing</span><h1>Behaviour management</h1></div></div>
      <ErrorState message="Your school role cannot access student behaviour records." />
    </div>;
  }

  return <div className="page-stack student-behaviour-page">
    <header className="page-heading">
      <div><span className="eyebrow">Student wellbeing · Phase 1</span><h1>Behaviour management</h1>
        <p>Record positive behaviour and concerns, capture actions taken, and prepare a secure parent report.</p>
      </div>
      <button className="button button-quiet" type="button" onClick={() => void loadData(true)} disabled={refreshing}>
        <RefreshCw size={16} className={refreshing ? 'spin' : undefined} /> Refresh
      </button>
    </header>
    {error && <ErrorState message={error} />}
    {notice && <div className="behaviour-notice" role="status"><Check size={17} />{notice}</div>}
    {canConfigure && <div className="page-tabs" role="tablist" aria-label="Behaviour management sections">
      <button className={tab === 'records' ? 'active' : ''} type="button" role="tab" aria-selected={tab === 'records'} onClick={() => setTab('records')}>Records</button>
      {canReview && <button className={tab === 'review' ? 'active' : ''} type="button" role="tab" aria-selected={tab === 'review'} onClick={() => setTab('review')}>Review queue</button>}
      <button className={tab === 'settings' ? 'active' : ''} type="button" role="tab" aria-selected={tab === 'settings'} onClick={() => setTab('settings')}>Configure types & actions</button>
    </div>}
    {!canConfigure && canReview && <div className="page-tabs" role="tablist" aria-label="Behaviour management sections">
      <button className={tab === 'records' ? 'active' : ''} type="button" role="tab" aria-selected={tab === 'records'} onClick={() => setTab('records')}>Records</button>
      <button className={tab === 'review' ? 'active' : ''} type="button" role="tab" aria-selected={tab === 'review'} onClick={() => setTab('review')}>Review queue</button>
    </div>}

    {(tab === 'records' || tab === 'review') && <>
      {tab === 'records' && <>
      <form className="content-card student-behaviour-form" onSubmit={(event) => void saveRecord(event)}>
        <div className="behaviour-card-heading">
          <div className="behaviour-card-icon"><FileText size={19} /></div>
          <div><h2>Record behaviour</h2><p>Keep reports factual, specific, and respectful.</p></div>
        </div>
        {!activeTypes.length && <div className="behaviour-inline-warning"><AlertCircle size={17} />A school administrator must add or activate a behaviour type before reports can be recorded.</div>}
        <div className="behaviour-form-grid">
          <label className="field"><span>Student *</span>
            <select required value={studentId} onChange={(event) => setStudentId(event.target.value)} disabled={!students.length}>
              {students.map((student) => <option key={student.id} value={student.id}>{student.first_name} {student.last_name} · {student.student_number}</option>)}
            </select>
          </label>
          <label className="field"><span>Behaviour type *</span>
            <select required value={typeId} onChange={(event) => setTypeId(event.target.value)} disabled={!activeTypes.length}>
              {activeTypes.map((type) => <option key={type.id} value={type.id}>{type.category === 'positive' ? 'Positive' : 'Concern'} · {type.name}</option>)}
            </select>
          </label>
          <label className="field"><span>Date and time *</span><input type="datetime-local" required value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} /></label>
          <label className="field"><span>Location</span><input maxLength={200} value={location} onChange={(event) => setLocation(event.target.value)} placeholder="For example, library or classroom" /></label>
          <label className="field"><span>Context</span><input maxLength={200} value={context} onChange={(event) => setContext(event.target.value)} placeholder="Lesson, trip, library activity…" /></label>
          <label className="field"><span>Severity</span><select value={severity} onChange={(event) => setSeverity(event.target.value as 'minor' | 'moderate' | 'serious')}>
            <option value="minor">Minor</option><option value="moderate">Moderate</option><option value="serious">Serious · requires review</option>
          </select></label>
          <label className="field behaviour-full-field"><span>Other students involved</span>
            <select multiple value={involvedIds} onChange={(event) => setInvolvedIds(Array.from(event.currentTarget.selectedOptions, (option) => option.value))}
              aria-describedby="behaviour-involved-help">
              {students.filter((student) => student.id !== studentId).map((student) =>
                <option key={student.id} value={student.id}>{student.first_name} {student.last_name} · {student.student_number}</option>)}
            </select>
            <small id="behaviour-involved-help">Hold Ctrl (Windows) or Command (Mac) to select more than one. Names are hidden in parent copies.</small>
          </label>
          <label className="field behaviour-full-field"><span>What happened? *</span>
            <textarea required minLength={3} maxLength={5000} rows={4} value={description} onChange={(event) => setDescription(event.target.value)}
              placeholder="Describe observable facts, context, and impact. Avoid assumptions or labels." />
          </label>
          <label className="field"><span>Actions taken</span>
            <textarea maxLength={3000} rows={3} value={actionsTaken} onChange={(event) => setActionsTaken(event.target.value)}
              placeholder="Support offered, discussion held, or immediate response" />
          </label>
          <label className="field behaviour-full-field"><span>Student perspective (optional)</span>
            <textarea maxLength={3000} rows={3} value={studentPerspective} onChange={(event) => setStudentPerspective(event.target.value)}
              placeholder="Record the student’s account where appropriate." />
          </label>
          <label className="field"><span>Follow-up / consequence</span>
            <select value={actionId} onChange={(event) => setActionId(event.target.value)}>
              <option value="">No follow-up selected</option>
              {activeActions.map((action) => <option key={action.id} value={action.id}>{action.name}</option>)}
            </select>
          </label>
        </div>
        <label className="behaviour-workflow-check"><input type="checkbox" checked={confidential} onChange={(event) => setConfidential(event.target.checked)} />
          Restrict to school leads and safeguarding staff; do not show to students or guardians</label>
        <div className="behaviour-form-footer">
          <p>{pointsEnabled ? 'Points are enabled; the configured points will be applied when saved.' : 'Points are disabled for this school.'} New records are submitted for review and are not emailed until authorized.</p>
          <button className="button button-primary" type="submit" disabled={saving || !studentId || !typeId || !activeTypes.length}>
            <Plus size={16} />{saving ? 'Saving…' : 'Save behaviour report'}
          </button>
        </div>
      </form>
      </>}

      <section className="content-card behaviour-records-card">
        <div className="behaviour-list-heading">
          <div><h2>{tab === 'review' ? 'Records awaiting review' : 'Recent reports'}</h2><p>{tab === 'review' ? 'Publish, return, or review submitted reports before family access.' : 'Up to 500 most recent records for this school.'}</p></div>
          <label className="behaviour-search"><span className="sr-only">Search behaviour reports</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search reports" /></label>
        </div>
        {(tab === 'review' ? filteredRecords.filter((record) => ['submitted', 'under_review', 'returned'].includes(record.status)) : filteredRecords).length ? <div className="behaviour-record-list">
          {(tab === 'review' ? filteredRecords.filter((record) => ['submitted', 'under_review', 'returned'].includes(record.status)) : filteredRecords).map((record) => {
            const otherStudents = participants.filter((participant) => participant.record_id === record.id
              && participant.student_id !== record.student_id).length;
            return <article className="behaviour-record-row" key={record.id}>
              <div className={`behaviour-record-mark ${record.category}`}>
                {record.category === 'positive' ? <Award size={18} /> : <AlertCircle size={18} />}
              </div>
              <div className="behaviour-record-main">
                <div className="behaviour-record-title"><strong>{record.student_name}</strong><span>{record.behaviour_type_name}</span></div>
                <p>{record.description}</p>
                <small>{displayDate(record.occurred_at)}{record.class_name ? ` · ${record.class_name}` : ''} · {record.status.replaceAll('_', ' ')} · {record.severity}{otherStudents ? ` · ${otherStudents} other student(s) involved` : ''}</small>
              </div>
              <div className="behaviour-record-actions">
                {record.points_awarded !== null && <span className="behaviour-points">{record.points_awarded > 0 ? '+' : ''}{record.points_awarded} pts</span>}
                <button className="button button-quiet" type="button" onClick={() => setSelectedRecord(record)}>Report</button>
                <button className="button button-quiet" type="button"
                  disabled={!['published', 'resolved', 'closed'].includes(record.status) || !record.guardian_visible || record.confidential}
                  onClick={() => void handleDownloadReport(record, true)} aria-label={`Download parent report for ${record.student_name}`}><Download size={16} /></button>
              </div>
            </article>;
          })}
        </div> : <EmptyState title={tab === 'review' ? 'No reports awaiting review' : 'No behaviour reports yet'} detail={search ? 'Try another search.' : 'Submitted reports will appear here.'} />}
      </section>
    </>}

    {canConfigure && tab === 'settings' && <section className="student-behaviour-settings">
      <div className="content-card behaviour-points-setting">
        <div><span className="eyebrow">Optional tracking</span><h2>Points system</h2><p>Points are snapshotted on each report using its behaviour type. Changing this setting affects new reports only.</p></div>
        <label className="behaviour-toggle"><input type="checkbox" checked={pointsEnabled} onChange={(event) => void changePointsEnabled(event.target.checked)} /><span>{pointsEnabled ? 'Enabled' : 'Disabled'}</span></label>
      </div>
      <div className="behaviour-settings-grid">
        <section className="content-card">
          <div className="behaviour-card-heading"><div className="behaviour-card-icon"><Award size={19} /></div><div><h2>Behaviour types</h2><p>Set up positive behaviours and concerns for staff to select.</p></div></div>
          <form className="behaviour-settings-form" onSubmit={(event) => void saveType(event)}>
            <label className="field"><span>Type name *</span><input required minLength={2} maxLength={100} value={typeName} onChange={(event) => setTypeName(event.target.value)} /></label>
            <label className="field"><span>Category *</span><select value={typeCategory} onChange={(event) => setTypeCategory(event.target.value as BehaviourCategory)}><option value="positive">Positive</option><option value="negative">Behaviour concern</option></select></label>
            <label className="field"><span>Description</span><textarea rows={2} maxLength={500} value={typeDescription} onChange={(event) => setTypeDescription(event.target.value)} /></label>
            <label className="field"><span>Points {pointsEnabled ? '(optional)' : '(optional; takes effect only when enabled)'}</span><input type="number" min={typeCategory === 'positive' ? 0 : -1000} max={typeCategory === 'positive' ? 1000 : 0} step={1} value={typePoints} onChange={(event) => setTypePoints(event.target.value)} placeholder="Leave blank for no points" /></label>
            <button className="button button-primary" type="submit" disabled={saving}>Add behaviour type</button>
          </form>
          <div className="behaviour-config-list">{types.map((item) => <div key={item.id}>
            <span className={`behaviour-type-pill ${item.category}`}>{item.category === 'positive' ? 'Positive' : 'Concern'}</span>
            <strong>{item.name}</strong>{item.points !== null && <small>{item.points > 0 ? '+' : ''}{item.points} pts</small>}
            <button className="button button-quiet" type="button" disabled={saving} onClick={() => void toggleActive('student_behaviour_types', item)}>{item.active ? 'Archive' : 'Reactivate'}</button>
          </div>)}</div>
        </section>
        <section className="content-card">
          <div className="behaviour-card-heading"><div className="behaviour-card-icon"><UsersRound size={19} /></div><div><h2>Follow-up actions</h2><p>Add supportive actions or school-defined consequences.</p></div></div>
          <form className="behaviour-settings-form" onSubmit={(event) => void saveAction(event)}>
            <label className="field"><span>Action name *</span><input required minLength={2} maxLength={100} value={actionName} onChange={(event) => setActionName(event.target.value)} /></label>
            <label className="field"><span>Description</span><textarea rows={2} maxLength={500} value={actionDescription} onChange={(event) => setActionDescription(event.target.value)} /></label>
            <button className="button button-primary" type="submit" disabled={saving}>Add follow-up action</button>
          </form>
          <div className="behaviour-config-list">{actions.map((item) => <div key={item.id}>
            <strong>{item.name}</strong><small>{item.description}</small>
            <button className="button button-quiet" type="button" disabled={saving} onClick={() => void toggleActive('student_behaviour_actions', item)}>{item.active ? 'Archive' : 'Reactivate'}</button>
          </div>)}</div>
        </section>
      </div>
      {schoolId && user?.id && <StudentBehaviourEmailSettings schoolId={schoolId} userId={user.id} canConfigure />}
    </section>}
    {tab === 'review' && canReview && schoolId && user?.id && <StudentBehaviourEmailSettings
      schoolId={schoolId}
      userId={user.id}
      canConfigure={canConfigure}
    />}

    {selectedRecord && <div className="behaviour-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedRecord(null); }}>
      <section className="content-card behaviour-detail-modal" role="dialog" aria-modal="true" aria-labelledby="behaviour-detail-title">
        <div className="behaviour-list-heading"><div><span className="eyebrow">Report detail</span><h2 id="behaviour-detail-title">{selectedRecord.behaviour_type_name}</h2></div>
          <button className="button button-quiet" type="button" onClick={() => setSelectedRecord(null)}>Close</button></div>
        <div className="behaviour-report-grid">
          <div><span>Student</span><strong>{selectedRecord.student_name}</strong></div><div><span>Student ID</span><strong>{selectedRecord.student_number}</strong></div>
          <div><span>Class</span><strong>{selectedRecord.class_name || 'Not assigned'}</strong></div><div><span>When</span><strong>{displayDate(selectedRecord.occurred_at)}</strong></div>
        </div>
        <p><strong>What happened:</strong> {selectedRecord.description}</p>
        <p><strong>Actions taken:</strong> {selectedRecord.actions_taken || 'None recorded'}</p>
        <p><strong>Follow-up / consequence:</strong> {selectedRecord.action_name || 'None selected'}</p>
        <p><strong>Review status:</strong> {selectedRecord.status.replaceAll('_', ' ')} · {selectedRecord.severity}{selectedRecord.confidential ? ' · confidential' : ''}</p>
        {selectedRecord.student_perspective && <p><strong>Student perspective:</strong> {selectedRecord.student_perspective}</p>}
        {canReview && <div className="behaviour-review-actions">
          <label className="field"><span>Review note</span><textarea rows={2} maxLength={2000} value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} /></label>
          {['submitted', 'returned'].includes(selectedRecord.status) && <button className="button button-quiet" type="button" disabled={saving} onClick={() => void reviewRecord(selectedRecord, 'under_review')}>Start review</button>}
          {['submitted', 'under_review', 'returned'].includes(selectedRecord.status) && <>
            <button className="button button-primary" type="button" disabled={saving} onClick={() => void reviewRecord(selectedRecord, 'published')}>Publish to family</button>
            <button className="button button-quiet" type="button" disabled={saving || !reviewNote.trim()} onClick={() => void reviewRecord(selectedRecord, 'returned')}>Return for changes</button>
          </>}
          {selectedRecord.status === 'published' && <button className="button button-primary" type="button" disabled={saving} onClick={() => void reviewRecord(selectedRecord, 'resolved')}>Resolve case</button>}
          {selectedRecord.status === 'resolved' && <button className="button button-quiet" type="button" disabled={saving} onClick={() => void reviewRecord(selectedRecord, 'closed')}>Close case</button>}
        </div>}
        {schoolId && user?.id && canUseBehaviour && <StudentBehaviourRecordWorkflowPanel
          record={selectedRecord}
          schoolId={schoolId}
          userId={user.id}
          role={role ?? ''}
          onChange={() => void loadData(true)}
        />}
        <div className="behaviour-modal-actions"><button className="button button-primary" type="button"
          disabled={!['published', 'resolved', 'closed'].includes(selectedRecord.status) || !selectedRecord.guardian_visible || selectedRecord.confidential}
          onClick={() => void handleDownloadReport(selectedRecord, true)}><Download size={16} />Download parent PDF</button>
          <button className="button button-quiet" type="button" disabled={Boolean(emailingReportId) || selectedRecord.status !== 'published' || !selectedRecord.guardian_visible || selectedRecord.confidential} onClick={() => void emailParentReport(selectedRecord)}>
            <Mail size={16} />{emailingReportId === selectedRecord.id ? 'Sending…' : 'Email parent link'}
          </button>
          <a className="button button-quiet" href={behaviourReportUrl(selectedRecord.id)} target="_blank" rel="noreferrer">Open secure report</a></div>
      </section>
    </div>}
  </div>;
}
