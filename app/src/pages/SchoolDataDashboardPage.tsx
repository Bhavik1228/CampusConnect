import { useCallback, useEffect, useState } from 'react';
import { Activity, BookOpenCheck, CalendarDays, ClipboardCheck, GraduationCap, RefreshCw, Users, UsersRound } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';
import { resolveTimeZone } from '../lib/timezone';

interface DashboardData {
  period_start: string;
  period_end: string;
  active_students: number;
  new_student_records: number;
  active_teachers: number;
  active_non_teaching_staff: number;
  classes: number;
  attendance: {
    total_marks: number;
    present: number;
    late: number;
    absent: number;
    excused: number;
  };
  assessment: {
    result_count: number;
    average_percentage: number | null;
  };
  admissions: {
    total: number;
    submitted: number;
    under_review: number;
    accepted: number;
    registered: number;
    waitlisted: number;
    rejected: number;
    withdrawn: number;
  };
  monthly_enrolment: { month: string; count: number }[];
}

function schoolDate(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);
}

function periodDates(days: number, timeZone: string) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - days + 1);
  return { start: schoolDate(start, timeZone), end: schoolDate(end, timeZone) };
}

function formatMonth(month: string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' })
    .format(new Date(`${month}-01T12:00:00`));
}

export function SchoolDataDashboardPage() {
  const { activeMembership } = useAuth();
  const schoolId = activeMembership?.school_id;
  const timeZone = resolveTimeZone(activeMembership?.school.timezone);
  const [periodDays, setPeriodDays] = useState(90);
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const loadDashboard = useCallback(async () => {
    if (!schoolId) return;
    setError('');
    try {
      const period = periodDates(periodDays, timeZone);
      const { data: dashboard, error: dashboardError } = await requireSupabase().rpc('get_school_leadership_dashboard', {
        target_school: schoolId,
        period_start: period.start,
        period_end: period.end,
      });
      if (dashboardError) throw dashboardError;
      if (!dashboard || typeof dashboard !== 'object') throw new Error('The school data dashboard returned no usable data.');
      setData(dashboard as DashboardData);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load the school data dashboard.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [periodDays, schoolId, timeZone]);

  useEffect(() => {
    setLoading(true);
    setData(null);
    void loadDashboard();
  }, [loadDashboard]);

  const attendanceRate = data?.attendance.total_marks
    ? Math.round(((data.attendance.present + data.attendance.late) / data.attendance.total_marks) * 100)
    : null;
  const maxMonthlyEnrolment = Math.max(1, ...(data?.monthly_enrolment.map((item) => item.count) ?? []));
  const cards = data ? [
    { label: 'Active students', value: data.active_students, detail: `${data.new_student_records.toLocaleString()} new records in period`, icon: GraduationCap },
    { label: 'Active teachers', value: data.active_teachers, detail: 'Teaching workforce', icon: Users },
    { label: 'Other active staff', value: data.active_non_teaching_staff, detail: 'Non-teaching workforce', icon: UsersRound },
    { label: 'Class groups', value: data.classes, detail: 'School class groups', icon: CalendarDays },
  ] : [];

  return <div className="page-stack school-data-dashboard">
    <div className="page-heading">
      <div>
        <span className="eyebrow">Leadership &amp; governors</span>
        <h1>School data dashboard</h1>
        <p>Read-only indicators calculated from this school’s live records.</p>
      </div>
      <div className="school-data-dashboard-actions">
        <label className="field">
          <span>Reporting period</span>
          <select value={periodDays} onChange={(event) => setPeriodDays(Number(event.target.value))} disabled={loading}>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={180}>Last 180 days</option>
            <option value={365}>Last 365 days</option>
          </select>
        </label>
        <button className="button button-quiet" type="button" onClick={() => { setRefreshing(true); void loadDashboard(); }} disabled={loading || refreshing}>
          <RefreshCw size={16} className={refreshing ? 'spin' : undefined} /> Refresh
        </button>
      </div>
    </div>

    {error && <ErrorState message={error} />}
    {loading ? <LoadingState label="Loading live leadership data…" /> : data && <>
      <p className="school-data-period">Reporting window: {data.period_start} to {data.period_end}</p>
      <section className="stat-grid" aria-label="School overview">
        {cards.map(({ label, value, detail, icon: Icon }) => <article className="stat-card" key={label}>
          <div className="stat-card-top"><span>{label}</span><span className="stat-icon purple"><Icon size={19} /></span></div>
          <strong>{value.toLocaleString()}</strong>
          <span className="stat-caption">{detail}</span>
        </article>)}
      </section>

      <div className="school-data-dashboard-grid">
        <section className="content-card">
          <div className="section-heading"><div><span className="eyebrow">Daily operations</span><h2>Attendance</h2></div><ClipboardCheck size={19} /></div>
          {attendanceRate === null
            ? <EmptyState title="No attendance marks" detail="No attendance records were submitted in this reporting period." />
            : <>
              <div className="school-data-primary-metric"><strong>{attendanceRate}%</strong><span>Present or late among all recorded marks</span></div>
              <div className="school-data-breakdown">
                <span>Present <strong>{data.attendance.present.toLocaleString()}</strong></span>
                <span>Late <strong>{data.attendance.late.toLocaleString()}</strong></span>
                <span>Absent <strong>{data.attendance.absent.toLocaleString()}</strong></span>
                <span>Excused <strong>{data.attendance.excused.toLocaleString()}</strong></span>
              </div>
              <p className="panel-footnote">{data.attendance.total_marks.toLocaleString()} total attendance marks.</p>
            </>}
        </section>

        <section className="content-card">
          <div className="section-heading"><div><span className="eyebrow">Assessment</span><h2>Assessment results</h2></div><BookOpenCheck size={19} /></div>
          {data.assessment.result_count
            ? <>
              <div className="school-data-primary-metric"><strong>{data.assessment.average_percentage === null ? '—' : `${data.assessment.average_percentage}%`}</strong><span>Average recorded assessment percentage</span></div>
              <p className="panel-footnote">Across {data.assessment.result_count.toLocaleString()} assessment results dated in the reporting period.</p>
            </>
            : <EmptyState title="No assessment results" detail="No assessment results have been recorded in this reporting period." />}
        </section>
      </div>

      <div className="school-data-dashboard-grid">
        <section className="content-card">
          <div className="section-heading"><div><span className="eyebrow">Admissions</span><h2>Application pipeline</h2></div><UsersRound size={19} /></div>
          {data.admissions.total
            ? <div className="school-data-breakdown">
              <span>Submitted <strong>{data.admissions.submitted}</strong></span>
              <span>Under review <strong>{data.admissions.under_review}</strong></span>
              <span>Accepted <strong>{data.admissions.accepted}</strong></span>
              <span>Registered <strong>{data.admissions.registered}</strong></span>
              <span>Waitlisted <strong>{data.admissions.waitlisted}</strong></span>
              <span>Rejected <strong>{data.admissions.rejected}</strong></span>
              <span>Withdrawn <strong>{data.admissions.withdrawn}</strong></span>
            </div>
            : <EmptyState title="No applications submitted" detail="No admission applications were submitted in this reporting period." />}
          <p className="panel-footnote">{data.admissions.total.toLocaleString()} applications submitted in the reporting period.</p>
        </section>

        <section className="content-card">
          <div className="section-heading"><div><span className="eyebrow">Enrolment records</span><h2>New student records by month</h2></div><Activity size={19} /></div>
          {data.monthly_enrolment.length
            ? <div className="school-data-monthly-list">
              {data.monthly_enrolment.map((item) => <div className="school-data-month-row" key={item.month}>
                <span>{formatMonth(item.month)}</span>
                <div className="school-data-month-track" aria-label={`${item.count} records`}><span style={{ width: `${Math.max(3, (item.count / maxMonthlyEnrolment) * 100)}%` }} /></div>
                <strong>{item.count.toLocaleString()}</strong>
              </div>)}
            </div>
            : <EmptyState title="No new records" detail="No student records were created in this reporting period." />}
        </section>
      </div>
      <p className="panel-footnote school-data-dashboard-disclaimer">Counts are sourced from this school’s records. Attendance rate counts present and late marks as attendance; assessment average includes recorded results and is not a grade-level comparison.</p>
    </>}
  </div>;
}
