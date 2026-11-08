import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { CalendarClock, Check, Clock3, ExternalLink, RefreshCw, UserRoundCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type InterviewType = 'interview' | 'assessment' | 'interview_and_assessment';
type InterviewStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show';

interface Candidate {
  id: string;
  reference: string;
  student_name: string;
  status: string;
  applying_for: string;
}

interface Interviewer {
  profile_id: string;
  name: string;
  role: string;
}

interface Interview {
  id: string;
  application_id: string;
  application_reference: string;
  student_name: string;
  interviewer_profile_id: string | null;
  interviewer_name: string;
  interview_type: InterviewType;
  scheduled_at: string;
  duration_minutes: number;
  location: string;
  status: InterviewStatus;
}

interface InterviewHub {
  candidates: Candidate[];
  interviewers: Interviewer[];
  interviews: Interview[];
}

const emptyHub: InterviewHub = { candidates: [], interviewers: [], interviews: [] };
const interviewTypeLabels: Record<InterviewType, string> = {
  interview: 'Interview',
  assessment: 'Assessment',
  interview_and_assessment: 'Interview and assessment',
};

function formatScheduledAt(value: string, timeZone: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(value));
}

export function AdmissionInterviewSchedulingPage() {
  const { activeMembership } = useAuth();
  const schoolId = activeMembership?.school_id;
  const timeZone = activeMembership?.school.timezone ?? 'UTC';
  const canSchedule = activeMembership?.role === 'school_admin' || activeMembership?.role === 'admissions_officer';
  const [hub, setHub] = useState<InterviewHub>(emptyHub);
  const [applicationId, setApplicationId] = useState('');
  const [interviewerId, setInterviewerId] = useState('');
  const [interviewType, setInterviewType] = useState<InterviewType>('interview');
  const [scheduledAt, setScheduledAt] = useState('');
  const [duration, setDuration] = useState(30);
  const [location, setLocation] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [updatingId, setUpdatingId] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const loadHub = useCallback(async () => {
    if (!schoolId || !canSchedule) return;
    setError('');
    try {
      const { data, error: hubError } = await requireSupabase().rpc('get_admission_interview_hub', {
        target_school: schoolId,
      });
      if (hubError) throw hubError;
      if (!data || typeof data !== 'object') throw new Error('The interview hub returned no usable data.');
      const nextHub = data as InterviewHub;
      setHub(nextHub);
      setApplicationId((current) => nextHub.candidates.some((candidate) => candidate.id === current)
        ? current : (nextHub.candidates[0]?.id ?? ''));
      setInterviewerId((current) => nextHub.interviewers.some((interviewer) => interviewer.profile_id === current)
        ? current : (nextHub.interviewers[0]?.profile_id ?? ''));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load interview scheduling data.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [canSchedule, schoolId]);

  useEffect(() => {
    setLoading(true);
    setHub(emptyHub);
    void loadHub();
  }, [loadHub]);

  async function schedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !applicationId || !interviewerId || !scheduledAt || saving) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: scheduleError } = await requireSupabase().rpc('schedule_admission_interview', {
        target_school: schoolId,
        target_application: applicationId,
        target_interviewer: interviewerId,
        target_type: interviewType,
        target_start: new Date(scheduledAt).toISOString(),
        target_duration: duration,
        target_location: location,
      });
      if (scheduleError) throw scheduleError;
      setScheduledAt('');
      setLocation('');
      setSuccess('Interview or assessment scheduled. The appointment is saved and its time is conflict-checked.');
      await loadHub();
    } catch (scheduleError) {
      setError(scheduleError instanceof Error ? scheduleError.message : 'Could not schedule this interview.');
    } finally {
      setSaving(false);
    }
  }

  async function updateStatus(interview: Interview, status: Exclude<InterviewStatus, 'scheduled'>) {
    if (!schoolId || updatingId) return;
    setUpdatingId(interview.id);
    setError('');
    setSuccess('');
    try {
      const { error: updateError } = await requireSupabase().rpc('update_admission_interview_status', {
        target_school: schoolId,
        target_interview: interview.id,
        target_status: status,
      });
      if (updateError) throw updateError;
      setSuccess(`Appointment marked ${status.replace('_', ' ')}.`);
      await loadHub();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Could not update the appointment outcome.');
    } finally {
      setUpdatingId('');
    }
  }

  if (!canSchedule) {
    return <div className="page-stack">
      <div className="page-heading"><div><span className="eyebrow">Admissions</span><h1>Interview scheduling</h1></div></div>
      <ErrorState message="Your school role cannot schedule admissions interviews or assessments." />
    </div>;
  }

  const upcoming = hub.interviews.filter((interview) => interview.status === 'scheduled');
  const history = hub.interviews.filter((interview) => interview.status !== 'scheduled');

  return <div className="page-stack admission-interview-page">
    <div className="page-heading">
      <div><span className="eyebrow">Admissions &amp; enrolment</span><h1>Interview &amp; assessment scheduling</h1>
        <p>Schedule applicant appointments, assign a staff interviewer, and record outcomes.</p></div>
      <div className="admission-interview-heading-actions">
        <Link className="button button-quiet" to="/admissions"><ExternalLink size={15} /> Admissions</Link>
        <button className="button button-quiet" type="button" onClick={() => { setRefreshing(true); void loadHub(); }} disabled={loading || refreshing}>
          <RefreshCw size={15} className={refreshing ? 'spin' : undefined} /> Refresh
        </button>
      </div>
    </div>
    {error && <ErrorState message={error} />}
    {success && <p className="inline-success" role="status"><Check size={15} /> {success}</p>}

    <form className="content-card admission-interview-form" onSubmit={(event) => void schedule(event)}>
      <div className="section-heading"><div><span className="eyebrow">New appointment</span><h2>Schedule an applicant</h2></div><CalendarClock size={19} /></div>
      <div className="admission-interview-fields">
        <label className="field"><span>Applicant</span>
          <select value={applicationId} onChange={(event) => setApplicationId(event.target.value)} required disabled={loading || hub.candidates.length === 0}>
            {hub.candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.student_name} · {candidate.reference} · {candidate.status.replace('_', ' ')}</option>)}
          </select>
        </label>
        <label className="field"><span>Interviewer</span>
          <select value={interviewerId} onChange={(event) => setInterviewerId(event.target.value)} required disabled={loading || hub.interviewers.length === 0}>
            {hub.interviewers.map((interviewer) => <option key={interviewer.profile_id} value={interviewer.profile_id}>{interviewer.name} · {interviewer.role.replace('_', ' ')}</option>)}
          </select>
        </label>
        <label className="field"><span>Appointment type</span>
          <select value={interviewType} onChange={(event) => setInterviewType(event.target.value as InterviewType)}>
            {Object.entries(interviewTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="field"><span>Start time (your device’s local time)</span>
          <input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} required />
        </label>
        <label className="field"><span>Duration</span>
          <select value={duration} onChange={(event) => setDuration(Number(event.target.value))}>
            {[15, 30, 45, 60, 90, 120, 180].map((minutes) => <option key={minutes} value={minutes}>{minutes} minutes</option>)}
          </select>
        </label>
        <label className="field"><span>Location or meeting link</span>
          <input value={location} onChange={(event) => setLocation(event.target.value)} minLength={2} maxLength={200} required />
        </label>
      </div>
      <div className="admission-interview-form-footer">
        <p className="panel-footnote">Enter time in your device timezone; listed appointments use the school timezone ({timeZone}). Conflicts for the same applicant or interviewer are blocked.</p>
        <button className="button button-primary" type="submit" disabled={saving || loading || !hub.candidates.length || !hub.interviewers.length}>
          <CalendarClock size={16} />{saving ? 'Scheduling…' : 'Schedule appointment'}
        </button>
      </div>
    </form>

    <section className="content-card">
      <div className="section-heading"><div><span className="eyebrow">Appointments</span><h2>Upcoming &amp; scheduled</h2></div><Clock3 size={19} /></div>
      {loading ? <LoadingState label="Loading interview schedules…" />
        : upcoming.length ? <div className="admission-interview-list">
          {upcoming.map((interview) => <article className="admission-interview-item" key={interview.id}>
            <div className="admission-interview-item-main">
              <strong>{interview.student_name}</strong><span>{interview.application_reference} · {interviewTypeLabels[interview.interview_type]}</span>
              <small>{formatScheduledAt(interview.scheduled_at, timeZone)} · {interview.duration_minutes} min · {interview.location}</small>
              <small>Interviewer: {interview.interviewer_name || 'Former staff member'}</small>
            </div>
            <div className="admission-interview-item-actions">
              <span className="status-pill status-active">Scheduled</span>
              <button className="button button-quiet" type="button" disabled={updatingId === interview.id || Boolean(updatingId)} onClick={() => void updateStatus(interview, 'completed')}>Complete</button>
              <button className="button button-quiet" type="button" disabled={updatingId === interview.id || Boolean(updatingId)} onClick={() => void updateStatus(interview, 'no_show')}>No-show</button>
              <button className="button button-quiet" type="button" disabled={updatingId === interview.id || Boolean(updatingId)} onClick={() => void updateStatus(interview, 'cancelled')}>Cancel</button>
            </div>
          </article>)}
        </div> : <EmptyState title="No scheduled appointments" detail="New interviews and assessments will appear here after scheduling." />}
    </section>

    <section className="content-card">
      <div className="section-heading"><div><span className="eyebrow">Completed &amp; cancelled</span><h2>Appointment outcomes</h2></div><UserRoundCheck size={19} /></div>
      {loading ? <LoadingState label="Loading appointment outcomes…" />
        : history.length ? <div className="admission-interview-list">
          {history.map((interview) => <article className="admission-interview-item" key={interview.id}>
            <div className="admission-interview-item-main">
              <strong>{interview.student_name}</strong><span>{interview.application_reference} · {interviewTypeLabels[interview.interview_type]}</span>
              <small>{formatScheduledAt(interview.scheduled_at, timeZone)} · {interview.duration_minutes} min · {interview.location}</small>
              <small>Interviewer: {interview.interviewer_name || 'Former staff member'}</small>
            </div>
            <span className={`status-pill ${interview.status === 'completed' ? 'status-active' : 'status-muted'}`}>{interview.status.replace('_', ' ')}</span>
          </article>)}
        </div> : <EmptyState title="No outcomes recorded" detail="Completed, cancelled, and no-show appointments will be retained here for review." />}
    </section>
  </div>;
}
