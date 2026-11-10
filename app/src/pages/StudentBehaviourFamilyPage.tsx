import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { jsPDF } from 'jspdf';
import { Award, Check, Download, Mail, MessageSquareText, RefreshCw, ShieldCheck } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type FamilyStudent = {
  student_id: string;
  student_number: string;
  first_name: string;
  last_name: string;
  class_name: string;
};
type FamilyRecord = {
  id: string;
  student_id: string;
  student_name: string;
  student_number: string;
  school_name: string;
  behaviour_type_name: string;
  category: 'positive' | 'negative';
  occurred_at: string;
  description: string;
  actions_taken: string;
  action_name: string | null;
  status: string;
  points_awarded: number | null;
};
type FamilyMeeting = {
  id: string;
  student_id: string;
  title: string;
  agenda: string;
  scheduled_at: string;
  location: string;
  status: string;
};
type MeetingResponse = { meeting_id: string; response: string; response_note: string };
type FamilyPlan = { id: string; student_id: string; title: string; guardian_goals: string; review_due_at: string | null };
type FamilyAward = { id: string; student_id: string; title: string; description: string; award_type: 'badge' | 'certificate'; created_at: string };
type EmailPreference = { event_type: string; email_enabled: boolean };
type EmailDelivery = { id: string; event_type: string; status: string; created_at: string; delivered_at: string | null };

const optionalEmailTypes = [
  ['positive_recognition', 'Positive recognitions'],
  ['recognition_award', 'Awards and certificates'],
  ['improvement_update', 'Improvement updates'],
  ['weekly_positive_summary', 'Weekly positive summaries'],
  ['library_recognition', 'Library recognitions'],
] as const;

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function when(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function StudentBehaviourFamilyPage() {
  const { activeMembership, user } = useAuth();
  const schoolId = activeMembership?.school_id;
  const profileId = user?.id;
  const [students, setStudents] = useState<FamilyStudent[]>([]);
  const [selectedStudentId, setSelectedStudentId] = useState('');
  const [records, setRecords] = useState<FamilyRecord[]>([]);
  const [meetings, setMeetings] = useState<FamilyMeeting[]>([]);
  const [responses, setResponses] = useState<MeetingResponse[]>([]);
  const [plans, setPlans] = useState<FamilyPlan[]>([]);
  const [awards, setAwards] = useState<FamilyAward[]>([]);
  const [preferences, setPreferences] = useState<EmailPreference[]>([]);
  const [deliveries, setDeliveries] = useState<EmailDelivery[]>([]);
  const [correctionRecord, setCorrectionRecord] = useState('');
  const [correctionText, setCorrectionText] = useState('');
  const [responseNotes, setResponseNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const role = activeMembership?.role;
  const isParent = role === 'parent';
  const selectedStudent = useMemo(() => students.find((student) => student.student_id === selectedStudentId), [students, selectedStudentId]);

  const load = useCallback(async () => {
    if (!schoolId || !profileId || (role !== 'parent' && role !== 'student')) return;
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const { data: family, error: familyError } = await client.rpc('list_student_behaviour_family', { target_school: schoolId });
      if (familyError) throw familyError;
      const nextStudents = (family ?? []) as FamilyStudent[];
      setStudents(nextStudents);
      const selectedId = nextStudents.some((student) => student.student_id === selectedStudentId)
        ? selectedStudentId
        : nextStudents[0]?.student_id ?? '';
      setSelectedStudentId(selectedId);
      if (!selectedId) {
        setRecords([]);
        setMeetings([]);
        setPlans([]);
        setAwards([]);
      } else {
        const [recordResult, meetingResult, planResult, awardResult, responseResult] = await Promise.all([
          client.from('student_behaviour_records')
            .select('id,student_id,student_name,student_number,school_name,behaviour_type_name,category,occurred_at,description,actions_taken,action_name,status,points_awarded')
            .eq('school_id', schoolId).eq('student_id', selectedId)
            .in('status', ['published', 'resolved', 'closed']).eq('guardian_visible', true)
            .order('occurred_at', { ascending: false }).limit(200),
          client.from('student_behaviour_meetings')
            .select('id,student_id,title,agenda,scheduled_at,location,status')
            .eq('school_id', schoolId).eq('student_id', selectedId).eq('status', 'scheduled')
            .order('scheduled_at'),
          client.from('student_behaviour_support_plans')
            .select('id,student_id,title,guardian_goals,review_due_at')
            .eq('school_id', schoolId).eq('student_id', selectedId).eq('status', 'active').eq('guardian_visible', true),
          client.from('student_behaviour_awards')
            .select('id,student_id,title,description,award_type,created_at')
            .eq('school_id', schoolId).eq('student_id', selectedId).eq('status', 'approved').eq('guardian_visible', true)
            .order('created_at', { ascending: false }),
          client.from('student_behaviour_meeting_responses')
            .select('meeting_id,response,response_note').eq('school_id', schoolId).eq('profile_id', profileId),
        ]);
        if (recordResult.error) throw recordResult.error;
        if (meetingResult.error) throw meetingResult.error;
        if (planResult.error) throw planResult.error;
        if (awardResult.error) throw awardResult.error;
        if (responseResult.error) throw responseResult.error;
        setRecords((recordResult.data ?? []) as FamilyRecord[]);
        setMeetings((meetingResult.data ?? []) as FamilyMeeting[]);
        setPlans((planResult.data ?? []) as FamilyPlan[]);
        setAwards((awardResult.data ?? []) as FamilyAward[]);
        setResponses((responseResult.data ?? []) as MeetingResponse[]);
      }

      const [preferenceResult, deliveryResult] = await Promise.all([
        client.from('student_behaviour_email_preferences')
          .select('event_type,email_enabled').eq('school_id', schoolId).eq('profile_id', profileId),
        client.from('student_behaviour_email_deliveries')
          .select('id,event_type,status,created_at,delivered_at')
          .eq('school_id', schoolId).eq('recipient_profile_id', profileId)
          .order('created_at', { ascending: false }).limit(30),
      ]);
      if (preferenceResult.error) throw preferenceResult.error;
      if (deliveryResult.error) throw deliveryResult.error;
      setPreferences((preferenceResult.data ?? []) as EmailPreference[]);
      setDeliveries((deliveryResult.data ?? []) as EmailDelivery[]);
    } catch (loadError) {
      setError(messageOf(loadError, 'Could not load your behaviour overview.'));
    } finally {
      setLoading(false);
    }
  }, [profileId, role, schoolId, selectedStudentId]);

  useEffect(() => { void load(); }, [load]);

  async function saveCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!correctionRecord || !correctionText.trim() || saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: requestError } = await requireSupabase().rpc('create_student_behaviour_correction_request', {
        target_record: correctionRecord,
        target_text: correctionText.trim(),
      });
      if (requestError) throw requestError;
      setCorrectionRecord('');
      setCorrectionText('');
      setNotice('Your correction request was sent to authorized school staff.');
    } catch (requestError) {
      setError(messageOf(requestError, 'Could not submit the correction request.'));
    } finally {
      setSaving(false);
    }
  }

  async function updateMeeting(meetingId: string, response: MeetingResponse['response']) {
    if (!schoolId || !profileId || saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: updateError } = await requireSupabase().from('student_behaviour_meeting_responses')
        .update({
          response,
          response_note: responseNotes[meetingId]?.trim() ?? '',
          responded_at: new Date().toISOString(),
        })
        .eq('school_id', schoolId).eq('meeting_id', meetingId).eq('profile_id', profileId);
      if (updateError) throw updateError;
      setNotice('Your meeting response was sent to the school.');
      await load();
    } catch (updateError) {
      setError(messageOf(updateError, 'Could not send your meeting response.'));
    } finally {
      setSaving(false);
    }
  }

  async function updatePreference(eventType: string, enabled: boolean) {
    if (!schoolId || !profileId || saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: updateError } = await requireSupabase().from('student_behaviour_email_preferences')
        .upsert({ school_id: schoolId, profile_id: profileId, event_type: eventType, email_enabled: enabled });
      if (updateError) throw updateError;
      setPreferences((current) => [...current.filter((item) => item.event_type !== eventType), { event_type: eventType, email_enabled: enabled }]);
      setNotice('Your email preference was saved.');
    } catch (updateError) {
      setError(messageOf(updateError, 'Could not update your email preference.'));
    } finally {
      setSaving(false);
    }
  }

  function downloadCertificate(award: FamilyAward) {
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const studentName = selectedStudent ? `${selectedStudent.first_name} ${selectedStudent.last_name}` : 'Student';
    pdf.setDrawColor(66, 54, 120);
    pdf.setLineWidth(1.2);
    pdf.rect(12, 12, 273, 186);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(28);
    pdf.text('Certificate of Recognition', 148.5, 58, { align: 'center' });
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(16);
    pdf.text('Awarded to', 148.5, 82, { align: 'center' });
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(23);
    pdf.text(studentName, 148.5, 102, { align: 'center' });
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(14);
    pdf.text(award.title, 148.5, 123, { align: 'center' });
    const lines = pdf.splitTextToSize(award.description || 'In recognition of a positive contribution to the school community.', 210) as string[];
    pdf.text(lines, 148.5, 140, { align: 'center' });
    pdf.setFontSize(11);
    pdf.text(selectedStudent ? `Issued by ${activeMembership?.school.name ?? 'your school'} · ${when(award.created_at)}` : when(award.created_at), 148.5, 182, { align: 'center' });
    pdf.save(`behaviour-certificate-${award.id.slice(0, 8)}.pdf`);
  }

  if (loading) return <div className="page-stack"><LoadingState label="Loading your behaviour overview…" /></div>;

  return <div className="page-stack student-behaviour-family">
    <header className="page-heading">
      <div><span className="eyebrow">Student wellbeing</span><h1>{isParent ? 'My child’s behaviour overview' : 'My behaviour overview'}</h1>
        <p>Approved positive recognition, school updates, and agreed next steps.</p></div>
      <button className="button button-quiet" type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={16} /> Refresh</button>
    </header>
    {error && <ErrorState message={error} />}
    {notice && <div className="behaviour-notice" role="status"><Check size={17} />{notice}</div>}
    {students.length > 1 && <label className="field behaviour-family-child"><span>Child</span><select value={selectedStudentId} onChange={(event) => setSelectedStudentId(event.target.value)}>
      {students.map((student) => <option key={student.student_id} value={student.student_id}>{student.first_name} {student.last_name} · {student.student_number}</option>)}
    </select></label>}
    {!students.length ? <EmptyState title="No linked student profile" detail="Your school has not linked a student profile to this account yet." /> : <>
      {meetings.length > 0 && <section className="content-card behaviour-family-section">
        <div className="behaviour-card-heading"><div className="behaviour-card-icon"><MessageSquareText size={19} /></div><div><h2>Meeting invitations</h2><p>Review an invitation and send your response to the school.</p></div></div>
        {meetings.map((meeting) => <article className="behaviour-family-item" key={meeting.id}>
          <div><strong>{meeting.title}</strong><p>{when(meeting.scheduled_at)}{meeting.location ? ` · ${meeting.location}` : ''}</p>
            {meeting.agenda && <small>{meeting.agenda}</small>}</div>
          <label className="field"><span>Response note (optional)</span><input maxLength={1000} value={responseNotes[meeting.id] ?? ''}
            onChange={(event) => setResponseNotes((current) => ({ ...current, [meeting.id]: event.target.value }))} /></label>
          <div className="behaviour-family-actions">
            <button className="button button-primary" type="button" disabled={saving} onClick={() => void updateMeeting(meeting.id, 'accepted')}>Accept</button>
            <button className="button button-quiet" type="button" disabled={saving} onClick={() => void updateMeeting(meeting.id, 'request_change')}>Request a change</button>
            <button className="button button-quiet" type="button" disabled={saving} onClick={() => void updateMeeting(meeting.id, 'declined')}>Decline</button>
          </div>
          <small>Current response: {responses.find((item) => item.meeting_id === meeting.id)?.response ?? 'pending'}</small>
        </article>)}
      </section>}

      {plans.length > 0 && <section className="content-card behaviour-family-section">
        <h2>Support goals</h2>{plans.map((plan) => <article className="behaviour-family-item" key={plan.id}>
          <strong>{plan.title}</strong><p>{plan.guardian_goals}</p>
          {plan.review_due_at && <small>Review due {when(plan.review_due_at)}</small>}
        </article>)}
      </section>}

      {awards.length > 0 && <section className="content-card behaviour-family-section">
        <h2>Achievements</h2>{awards.map((award) => <article className="behaviour-family-item" key={award.id}>
          <div className="behaviour-family-achievement"><Award size={18} /><div><strong>{award.title}</strong><p>{award.description}</p><small>{when(award.created_at)}</small></div></div>
          {award.award_type === 'certificate' && <button className="button button-quiet" type="button" onClick={() => downloadCertificate(award)}><Download size={15} /> Download certificate</button>}
        </article>)}
      </section>}

      <section className="content-card behaviour-family-section">
        <div className="behaviour-card-heading"><div className="behaviour-card-icon"><ShieldCheck size={19} /></div><div><h2>Approved behaviour records</h2><p>Only records the school approved for family access appear here.</p></div></div>
        {records.length ? <div className="behaviour-family-records">{records.map((record) => <article key={record.id}>
          <div className={`behaviour-record-mark ${record.category}`}><Award size={17} /></div>
          <div><strong>{record.behaviour_type_name}</strong><p>{record.description}</p>
            <small>{when(record.occurred_at)} · {record.status}{record.points_awarded !== null ? ` · ${record.points_awarded} pts` : ''}</small>
            {record.actions_taken && <p><b>School response:</b> {record.actions_taken}</p>}
            {record.action_name && <p><b>Next step:</b> {record.action_name}</p>}
          </div>
          <a className="button button-quiet" href={`/behaviour/report/${record.id}`}>Open report</a>
          <button className="button button-quiet" type="button" onClick={() => { setCorrectionRecord(record.id); setCorrectionText(''); }}>Request correction</button>
        </article>)}</div> : <EmptyState title="No approved records" detail="Approved recognitions and reports will appear here." />}
      </section>

      {correctionRecord && <form className="content-card behaviour-correction-form" onSubmit={(event) => void saveCorrection(event)}>
        <h2>Request a correction</h2><p>Explain what you believe is inaccurate. The request will be reviewed by authorized school staff.</p>
        <label className="field"><span>Correction request *</span><textarea required minLength={5} maxLength={2000} rows={4} value={correctionText}
          onChange={(event) => setCorrectionText(event.target.value)} /></label>
        <div className="behaviour-family-actions"><button className="button button-primary" type="submit" disabled={saving}>Send request</button>
          <button className="button button-quiet" type="button" onClick={() => setCorrectionRecord('')}>Cancel</button></div>
      </form>}

      <section className="content-card behaviour-family-section">
        <div className="behaviour-card-heading"><div className="behaviour-card-icon"><Mail size={19} /></div><div><h2>Email preferences</h2><p>Choose optional positive-recognition emails. Important school communications remain enabled.</p></div></div>
        <div className="behaviour-family-preferences">{optionalEmailTypes.map(([eventType, label]) => {
          const current = preferences.find((item) => item.event_type === eventType)?.email_enabled ?? true;
          return <label key={eventType}><span>{label}</span><input type="checkbox" checked={current} disabled={saving}
            onChange={(event) => void updatePreference(eventType, event.target.checked)} /></label>;
        })}</div>
      </section>

      <section className="content-card behaviour-family-section">
        <h2>Email notification history</h2>
        {deliveries.length ? <div className="behaviour-email-delivery-list">{deliveries.map((delivery) => <article key={delivery.id}>
          <div><strong>{delivery.event_type.replaceAll('_', ' ')}</strong><span>{when(delivery.created_at)}</span></div>
          <span className={`behaviour-email-status ${delivery.status}`}>{delivery.status.replaceAll('_', ' ')}</span>
        </article>)}</div> : <p>No behaviour email notifications have been recorded.</p>}
      </section>
    </>}
  </div>;
}
