import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, Award, CalendarClock, Check, RefreshCw, ShieldCheck } from 'lucide-react';
import { ErrorState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type WorkflowRecord = {
  id: string;
  student_id: string;
  status: string;
  category: 'positive' | 'negative';
  severity: string;
  guardian_visible: boolean;
};
type Followup = { id: string; title: string; description: string; due_at: string | null; status: string };
type Plan = { id: string; title: string; guardian_goals: string; review_due_at: string | null; guardian_visible: boolean };
type Meeting = { id: string; title: string; scheduled_at: string; location: string; status: string; guardian_visible: boolean };
type AwardNomination = { id: string; title: string; description: string; award_type: string; status: string };
type Correction = { id: string; request_text: string; status: string; resolution_note: string };
type Escalation = { id: string; reason: string; status: string };

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function localDateTime(value = new Date()) {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function StudentBehaviourRecordWorkflowPanel({
  record,
  schoolId,
  userId,
  role,
  onChange,
}: {
  record: WorkflowRecord;
  schoolId: string;
  userId: string;
  role: string;
  onChange: () => void;
}) {
  const isManager = ['school_admin', 'academic_coordinator', 'safeguarding_officer'].includes(role);
  const canCreateCasework = ['school_admin', 'academic_coordinator', 'teacher', 'librarian', 'secretary', 'hr_staff_administrator', 'safeguarding_officer'].includes(role);
  const [followups, setFollowups] = useState<Followup[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [awards, setAwards] = useState<AwardNomination[]>([]);
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [escalations, setEscalations] = useState<Escalation[]>([]);
  const [followupTitle, setFollowupTitle] = useState('');
  const [followupDescription, setFollowupDescription] = useState('');
  const [followupDue, setFollowupDue] = useState('');
  const [planTitle, setPlanTitle] = useState('');
  const [planGoals, setPlanGoals] = useState('');
  const [planStaffNote, setPlanStaffNote] = useState('');
  const [planReviewDue, setPlanReviewDue] = useState('');
  const [planGuardianVisible, setPlanGuardianVisible] = useState(false);
  const [meetingTitle, setMeetingTitle] = useState('');
  const [meetingAgenda, setMeetingAgenda] = useState('');
  const [meetingDate, setMeetingDate] = useState(localDateTime(new Date(Date.now() + 86_400_000)));
  const [meetingLocation, setMeetingLocation] = useState('');
  const [meetingGuardianVisible, setMeetingGuardianVisible] = useState(true);
  const [awardTitle, setAwardTitle] = useState('');
  const [awardDescription, setAwardDescription] = useState('');
  const [awardType, setAwardType] = useState<'badge' | 'certificate'>('badge');
  const [escalationReason, setEscalationReason] = useState('');
  const [correctionNotes, setCorrectionNotes] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const client = requireSupabase();
      const results = await Promise.all([
        client.from('student_behaviour_followups')
          .select('id,title,description,due_at,status').eq('school_id', schoolId).eq('record_id', record.id).order('created_at', { ascending: false }),
        client.from('student_behaviour_support_plans')
          .select('id,title,guardian_goals,review_due_at,guardian_visible').eq('school_id', schoolId).eq('record_id', record.id).order('created_at', { ascending: false }),
        client.from('student_behaviour_meetings')
          .select('id,title,scheduled_at,location,status,guardian_visible').eq('school_id', schoolId).eq('record_id', record.id).order('scheduled_at'),
        client.from('student_behaviour_awards')
          .select('id,title,description,award_type,status').eq('school_id', schoolId).eq('record_id', record.id).order('created_at', { ascending: false }),
      ]);
      for (const result of results) if (result.error) throw result.error;
      setFollowups((results[0].data ?? []) as Followup[]);
      setPlans((results[1].data ?? []) as Plan[]);
      setMeetings((results[2].data ?? []) as Meeting[]);
      setAwards((results[3].data ?? []) as AwardNomination[]);
      if (isManager) {
        const [correctionResult, escalationResult] = await Promise.all([
          client.from('student_behaviour_correction_requests')
            .select('id,request_text,status,resolution_note').eq('school_id', schoolId).eq('record_id', record.id).order('created_at', { ascending: false }),
          client.from('student_behaviour_escalations')
            .select('id,reason,status').eq('school_id', schoolId).eq('record_id', record.id).order('created_at', { ascending: false }),
        ]);
        if (correctionResult.error) throw correctionResult.error;
        if (escalationResult.error) throw escalationResult.error;
        setCorrections((correctionResult.data ?? []) as Correction[]);
        setEscalations((escalationResult.data ?? []) as Escalation[]);
      }
    } catch (loadError) {
      setError(messageOf(loadError, 'Could not load this report’s follow-up workflows.'));
    }
  }, [isManager, record.id, schoolId]);

  useEffect(() => { void load(); }, [load]);

  async function submit(event: FormEvent<HTMLFormElement>, action: () => Promise<void>, success: string) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(success);
      await load();
      onChange();
    } catch (submitError) {
      setError(messageOf(submitError, 'Could not save this behaviour workflow.'));
    } finally {
      setSaving(false);
    }
  }

  async function createFollowup(event: FormEvent<HTMLFormElement>) {
    await submit(event, async () => {
      const { error: saveError } = await requireSupabase().from('student_behaviour_followups').insert({
        school_id: schoolId,
        record_id: record.id,
        title: followupTitle.trim(),
        description: followupDescription.trim(),
        assigned_to: userId,
        due_at: followupDue ? new Date(followupDue).toISOString() : null,
        created_by: userId,
      });
      if (saveError) throw saveError;
      setFollowupTitle('');
      setFollowupDescription('');
      setFollowupDue('');
    }, 'Follow-up task assigned to you.');
  }

  async function createPlan(event: FormEvent<HTMLFormElement>) {
    await submit(event, async () => {
      const { error: saveError } = await requireSupabase().rpc('create_student_behaviour_support_plan', {
        target_school: schoolId,
        target_student: record.student_id,
        target_record: record.id,
        target_title: planTitle.trim(),
        target_goals: planGoals.trim(),
        target_staff_note: planStaffNote.trim(),
        target_review_due: planReviewDue ? new Date(planReviewDue).toISOString() : null,
        target_guardian_visible: planGuardianVisible,
      });
      if (saveError) throw saveError;
      setPlanTitle('');
      setPlanGoals('');
      setPlanStaffNote('');
      setPlanReviewDue('');
      setPlanGuardianVisible(false);
    }, 'Support plan saved.');
  }

  async function createMeeting(event: FormEvent<HTMLFormElement>) {
    await submit(event, async () => {
      const { error: saveError } = await requireSupabase().from('student_behaviour_meetings').insert({
        school_id: schoolId,
        student_id: record.student_id,
        record_id: record.id,
        title: meetingTitle.trim(),
        agenda: meetingAgenda.trim(),
        scheduled_at: new Date(meetingDate).toISOString(),
        location: meetingLocation.trim(),
        guardian_visible: meetingGuardianVisible,
        created_by: userId,
      });
      if (saveError) throw saveError;
      setMeetingTitle('');
      setMeetingAgenda('');
      setMeetingLocation('');
    }, meetingGuardianVisible ? 'Meeting scheduled; eligible guardians have been invited by email.' : 'Staff-only meeting scheduled.');
  }

  async function createAward(event: FormEvent<HTMLFormElement>) {
    await submit(event, async () => {
      if (record.category !== 'positive' || record.status !== 'published') {
        throw new Error('Awards can only be nominated for published positive recognitions.');
      }
      const { error: saveError } = await requireSupabase().from('student_behaviour_awards').insert({
        school_id: schoolId,
        student_id: record.student_id,
        record_id: record.id,
        title: awardTitle.trim(),
        description: awardDescription.trim(),
        award_type: awardType,
        created_by: userId,
      });
      if (saveError) throw saveError;
      setAwardTitle('');
      setAwardDescription('');
    }, 'Recognition nomination sent for school review.');
  }

  async function createEscalation(event: FormEvent<HTMLFormElement>) {
    await submit(event, async () => {
      const { error: saveError } = await requireSupabase().rpc('create_student_behaviour_escalation', {
        target_record: record.id,
        target_reason: escalationReason.trim(),
        target_assignee: null,
      });
      if (saveError) throw saveError;
      setEscalationReason('');
    }, 'Escalation sent to authorized school leads.');
  }

  async function reviewCorrection(request: Correction, status: 'accepted' | 'declined' | 'clarification_requested') {
    if (saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: reviewError } = await requireSupabase().rpc('review_student_behaviour_correction', {
        target_request: request.id,
        target_status: status,
        target_note: correctionNotes[request.id]?.trim() ?? '',
      });
      if (reviewError) throw reviewError;
      setNotice('Correction request review saved; the requester will receive a secure update when email is enabled.');
      await load();
    } catch (reviewError) {
      setError(messageOf(reviewError, 'Could not review this correction request.'));
    } finally {
      setSaving(false);
    }
  }

  async function reviewAward(award: AwardNomination, status: 'approved' | 'rejected') {
    if (saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: reviewError } = await requireSupabase().rpc('review_student_behaviour_award', {
        target_award: award.id,
        target_status: status,
        target_guardian_visible: status === 'approved',
      });
      if (reviewError) throw reviewError;
      setNotice(status === 'approved' ? 'Recognition approved and eligible family email queued.' : 'Recognition nomination declined.');
      await load();
    } catch (reviewError) {
      setError(messageOf(reviewError, 'Could not review this recognition.'));
    } finally {
      setSaving(false);
    }
  }

  async function completeFollowup(item: Followup) {
    setSaving(true);
    setError('');
    try {
      const { error: updateError } = await requireSupabase().from('student_behaviour_followups')
        .update({ status: 'done', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('school_id', schoolId).eq('id', item.id);
      if (updateError) throw updateError;
      setNotice('Follow-up marked complete.');
      await load();
    } catch (updateError) {
      setError(messageOf(updateError, 'Could not complete the follow-up.'));
    } finally {
      setSaving(false);
    }
  }

  return <section className="behaviour-record-workflows">
    {error && <ErrorState message={error} />}
    {notice && <div className="behaviour-notice" role="status"><Check size={16} />{notice}</div>}
    <header className="behaviour-list-heading"><div><h3>Follow-up and family workflows</h3><p>Only guardian-visible information is included in messages; private staff notes remain staff-only.</p></div>
      <button className="button button-quiet" type="button" onClick={() => void load()}><RefreshCw size={14} /> Refresh</button></header>

    {canCreateCasework && <div className="behaviour-workflow-grid">
      <form className="content-card behaviour-workflow-form" onSubmit={(event) => void createFollowup(event)}>
        <h4>Assign follow-up</h4>
        <label className="field"><span>Task *</span><input required minLength={2} maxLength={120} value={followupTitle} onChange={(event) => setFollowupTitle(event.target.value)} /></label>
        <label className="field"><span>Details</span><textarea rows={2} maxLength={1500} value={followupDescription} onChange={(event) => setFollowupDescription(event.target.value)} /></label>
        <label className="field"><span>Due date</span><input type="datetime-local" value={followupDue} onChange={(event) => setFollowupDue(event.target.value)} /></label>
        <button className="button button-quiet" type="submit" disabled={saving}>Assign to me</button>
      </form>

      {isManager && <form className="content-card behaviour-workflow-form" onSubmit={(event) => void createPlan(event)}>
        <h4>Support plan</h4>
        <label className="field"><span>Plan title *</span><input required minLength={2} maxLength={120} value={planTitle} onChange={(event) => setPlanTitle(event.target.value)} /></label>
        <label className="field"><span>Guardian-visible goals</span><textarea rows={2} maxLength={3000} value={planGoals} onChange={(event) => setPlanGoals(event.target.value)} /></label>
        <label className="field"><span>Restricted staff note</span><textarea rows={2} maxLength={3000} value={planStaffNote} onChange={(event) => setPlanStaffNote(event.target.value)} /></label>
        <label className="field"><span>Review due</span><input type="datetime-local" value={planReviewDue} onChange={(event) => setPlanReviewDue(event.target.value)} /></label>
        <label className="behaviour-workflow-check"><input type="checkbox" checked={planGuardianVisible} onChange={(event) => setPlanGuardianVisible(event.target.checked)} /> Share goals with linked guardians</label>
        <button className="button button-quiet" type="submit" disabled={saving}>Save support plan</button>
      </form>}

      <form className="content-card behaviour-workflow-form" onSubmit={(event) => void createMeeting(event)}>
        <h4>Schedule meeting</h4>
        <label className="field"><span>Meeting title *</span><input required minLength={2} maxLength={120} value={meetingTitle} onChange={(event) => setMeetingTitle(event.target.value)} /></label>
        <label className="field"><span>Agenda</span><textarea rows={2} maxLength={2000} value={meetingAgenda} onChange={(event) => setMeetingAgenda(event.target.value)} /></label>
        <label className="field"><span>Date and time *</span><input type="datetime-local" required value={meetingDate} onChange={(event) => setMeetingDate(event.target.value)} /></label>
        <label className="field"><span>Location</span><input maxLength={200} value={meetingLocation} onChange={(event) => setMeetingLocation(event.target.value)} /></label>
        <label className="behaviour-workflow-check"><input type="checkbox" checked={meetingGuardianVisible} onChange={(event) => setMeetingGuardianVisible(event.target.checked)} /> Invite linked guardians</label>
        <button className="button button-quiet" type="submit" disabled={saving}>Schedule meeting</button>
      </form>

      {record.category === 'positive' && record.status === 'published' && <form className="content-card behaviour-workflow-form" onSubmit={(event) => void createAward(event)}>
        <h4><Award size={16} /> Nominate an achievement</h4>
        <label className="field"><span>Award title *</span><input required minLength={2} maxLength={120} value={awardTitle} onChange={(event) => setAwardTitle(event.target.value)} /></label>
        <label className="field"><span>Reason</span><textarea rows={2} maxLength={1000} value={awardDescription} onChange={(event) => setAwardDescription(event.target.value)} /></label>
        <label className="field"><span>Format</span><select value={awardType} onChange={(event) => setAwardType(event.target.value as 'badge' | 'certificate')}><option value="badge">Badge</option><option value="certificate">Certificate</option></select></label>
        <button className="button button-quiet" type="submit" disabled={saving}>Submit nomination</button>
      </form>}

      <form className="content-card behaviour-workflow-form" onSubmit={(event) => void createEscalation(event)}>
        <h4><AlertTriangle size={16} /> Escalate for human review</h4>
        <p>Notifies authorized school leads; it does not apply an automatic sanction.</p>
        <label className="field"><span>Reason *</span><textarea required minLength={5} maxLength={1500} rows={3} value={escalationReason} onChange={(event) => setEscalationReason(event.target.value)} /></label>
        <button className="button button-quiet" type="submit" disabled={saving}>Send staff escalation</button>
      </form>
    </div>}

    {followups.length > 0 && <div className="behaviour-workflow-items"><h4>Follow-ups</h4>{followups.map((item) => <article key={item.id}>
      <div><strong>{item.title}</strong><p>{item.description}</p><small>{item.due_at ? `Due ${new Date(item.due_at).toLocaleString()}` : 'No due date'} · {item.status}</small></div>
      {item.status !== 'done' && item.status !== 'cancelled' && <button className="button button-quiet" type="button" disabled={saving} onClick={() => void completeFollowup(item)}>Mark complete</button>}
    </article>)}</div>}
    {plans.length > 0 && <div className="behaviour-workflow-items"><h4>Support plans</h4>{plans.map((item) => <article key={item.id}>
      <div><strong>{item.title}</strong><p>{item.guardian_goals || 'No guardian-visible goals.'}</p><small>{item.review_due_at ? `Review ${new Date(item.review_due_at).toLocaleDateString()}` : 'No review date'}{item.guardian_visible ? ' · Family-visible' : ' · Staff-only'}</small></div>
    </article>)}</div>}
    {meetings.length > 0 && <div className="behaviour-workflow-items"><h4><CalendarClock size={15} /> Meetings</h4>{meetings.map((item) => <article key={item.id}>
      <div><strong>{item.title}</strong><small>{new Date(item.scheduled_at).toLocaleString()} · {item.location || 'Location not set'}{item.guardian_visible ? ' · Guardian invited' : ' · Staff only'}</small></div>
    </article>)}</div>}
    {awards.length > 0 && <div className="behaviour-workflow-items"><h4>Award nominations</h4>{awards.map((item) => <article key={item.id}>
      <div><strong>{item.title}</strong><p>{item.description}</p><small>{item.award_type} · {item.status}</small></div>
      {isManager && item.status === 'pending' && <div className="behaviour-family-actions">
        <button className="button button-primary" type="button" disabled={saving} onClick={() => void reviewAward(item, 'approved')}>Approve & notify</button>
        <button className="button button-quiet" type="button" disabled={saving} onClick={() => void reviewAward(item, 'rejected')}>Decline</button>
      </div>}
    </article>)}</div>}

    {isManager && corrections.length > 0 && <div className="behaviour-workflow-items"><h4>Correction requests</h4>{corrections.map((item) => <article key={item.id}>
      <div><strong>{item.status.replaceAll('_', ' ')}</strong><p>{item.request_text}</p>{item.resolution_note && <small>{item.resolution_note}</small>}</div>
      {item.status === 'pending' && <div>
        <label className="field"><span>Response note</span><textarea rows={2} maxLength={2000} value={correctionNotes[item.id] ?? ''}
          onChange={(event) => setCorrectionNotes((current) => ({ ...current, [item.id]: event.target.value }))} /></label>
        <div className="behaviour-family-actions">
          <button className="button button-primary" type="button" disabled={saving} onClick={() => void reviewCorrection(item, 'accepted')}>Accept</button>
          <button className="button button-quiet" type="button" disabled={saving} onClick={() => void reviewCorrection(item, 'clarification_requested')}>Request clarification</button>
          <button className="button button-quiet" type="button" disabled={saving} onClick={() => void reviewCorrection(item, 'declined')}>Decline</button>
        </div>
      </div>}
    </article>)}</div>}
    {isManager && escalations.length > 0 && <div className="behaviour-workflow-items"><h4><ShieldCheck size={15} /> Staff escalations</h4>{escalations.map((item) => <article key={item.id}>
      <div><strong>{item.status}</strong><p>{item.reason}</p></div>
    </article>)}</div>}
  </section>;
}
