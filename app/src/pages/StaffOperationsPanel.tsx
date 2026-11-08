import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, Download, FileBadge2, Save, UserCheck } from 'lucide-react';
import { EmptyState, ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type StaffRecord = { id: string; employee_number: string; first_name: string; last_name: string; email: string | null; job_title: string; department_id: string | null; employment_status: string; department?: { name: string } | { name: string }[] | null };
type AttendanceRecord = { id: string; staff_id: string; attendance_date: string; status: 'present' | 'late' | 'absent' | 'on_leave'; check_in: string | null; check_out: string | null; note: string };
type LeaveRequest = { id: string; staff_id: string; leave_type: string; start_date: string; end_date: string; reason: string; status: string; review_note: string; staff?: { first_name: string; last_name: string; employee_number: string } | { first_name: string; last_name: string; employee_number: string }[] | null; coverage?: { substitute_staff_id: string; status: string } | { substitute_staff_id: string; status: string }[] | null };
type Credential = { id: string; staff_id: string; qualification_name: string; issuer: string; credential_number: string; issued_on: string | null; expires_on: string | null; status: 'active' | 'expired' | 'revoked'; notes: string };
type StaffDocument = { id: string; staff_id: string; file_name: string; expires_on: string | null; document_type: string };
type PayrollProfile = { staff_id: string; payroll_identifier: string; pay_frequency: 'weekly' | 'biweekly' | 'monthly' | 'four_weekly'; contracted_weekly_hours: number };
type Props = { schoolId: string; section: 'credentials' | 'attendance' | 'leave' | 'payroll'; canManage: boolean };
type AttendanceEdit = { status: AttendanceRecord['status']; check_in: string; check_out: string; note: string };

function localDateValue(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function relation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function csvCell(value: unknown) {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function expiryLabel(value: string | null) {
  if (!value) return 'No expiry date';
  const days = Math.ceil((new Date(`${value}T00:00:00`).getTime() - new Date(`${localDateValue(new Date())}T00:00:00`).getTime()) / 86400000);
  if (days < 0) return `Expired ${Math.abs(days)} day(s) ago`;
  if (days === 0) return 'Expires today';
  return `Expires in ${days} day(s)`;
}

export function StaffOperationsPanel({ schoolId, section, canManage }: Props) {
  const [staff, setStaff] = useState<StaffRecord[]>([]);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
  const [attendanceEdits, setAttendanceEdits] = useState<Record<string, AttendanceEdit>>({});
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequest[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [documents, setDocuments] = useState<StaffDocument[]>([]);
  const [teachers, setTeachers] = useState<StaffRecord[]>([]);
  const [payrollProfiles, setPayrollProfiles] = useState<Record<string, PayrollProfile>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [attendanceDate, setAttendanceDate] = useState(localDateValue(new Date()));
  const [selectedStaff, setSelectedStaff] = useState('');
  const [leaveType, setLeaveType] = useState('annual');
  const [leaveStart, setLeaveStart] = useState(localDateValue(new Date()));
  const [leaveEnd, setLeaveEnd] = useState(localDateValue(new Date()));
  const [leaveReason, setLeaveReason] = useState('');
  const [leaveFilter, setLeaveFilter] = useState<'all' | 'pending' | 'approved' | 'needs_coverage' | 'rejected'>('all');
  const [substituteByLeave, setSubstituteByLeave] = useState<Record<string, string>>({});
  const [credentialStaff, setCredentialStaff] = useState('');
  const [credentialDocument, setCredentialDocument] = useState('');
  const [payrollStart, setPayrollStart] = useState(localDateValue(new Date(new Date().getFullYear(), new Date().getMonth(), 1)));
  const [payrollEnd, setPayrollEnd] = useState(localDateValue(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0)));

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const staffResult = await client.from('staff_profiles')
        .select('id,employee_number,first_name,last_name,email,job_title,department_id,employment_status,department:school_departments(name)')
        .eq('school_id', schoolId).neq('employment_status', 'terminated').order('last_name');
      if (staffResult.error) throw staffResult.error;
      const employees = (staffResult.data ?? []) as StaffRecord[];
      setStaff(employees);
      if (!credentialStaff && employees.length) setCredentialStaff(employees[0].id);
      if (!selectedStaff && employees.length) setSelectedStaff(employees[0].id);

      if (section === 'attendance') {
        const { data, error: attendanceError } = await client.from('staff_attendance_records')
          .select('id,staff_id,attendance_date,status,check_in,check_out,note')
          .eq('school_id', schoolId).eq('attendance_date', attendanceDate);
        if (attendanceError) throw attendanceError;
        const rows = (data ?? []) as AttendanceRecord[];
        setAttendance(rows);
        setAttendanceEdits(Object.fromEntries(employees.map((person) => {
          const record = rows.find((item) => item.staff_id === person.id);
          return [person.id, {
            status: record?.status ?? 'present',
            check_in: record?.check_in?.slice(0, 5) ?? '',
            check_out: record?.check_out?.slice(0, 5) ?? '',
            note: record?.note ?? '',
          }];
        })));
      } else if (section === 'leave') {
        const [requestResult, teacherResult] = await Promise.all([
          client.from('staff_leave_requests')
            .select('id,staff_id,leave_type,start_date,end_date,reason,status,review_note,staff:staff_profiles(first_name,last_name,employee_number),coverage:staff_leave_coverage(substitute_staff_id,status)')
            .eq('school_id', schoolId).order('created_at', { ascending: false }).limit(300),
          client.from('teacher_profiles').select('staff_profile_id,staff:staff_profiles(id,employee_number,first_name,last_name,email,job_title,department_id,employment_status)')
            .eq('school_id', schoolId).eq('employment_status', 'active').not('staff_profile_id', 'is', null),
        ]);
        if (requestResult.error) throw requestResult.error;
        if (teacherResult.error) throw teacherResult.error;
        setLeaveRequests((requestResult.data ?? []) as unknown as LeaveRequest[]);
        setTeachers((teacherResult.data ?? []).map((teacher) => relation(teacher.staff)).filter((person): person is StaffRecord => Boolean(person)));
      } else if (section === 'credentials') {
        const [credentialResult, documentResult] = await Promise.all([
          client.from('staff_qualifications').select('id,staff_id,qualification_name,issuer,credential_number,issued_on,expires_on,status,notes').eq('school_id', schoolId).order('expires_on'),
          client.from('staff_documents').select('id,staff_id,file_name,expires_on,document_type').eq('school_id', schoolId).order('created_at', { ascending: false }),
        ]);
        if (credentialResult.error) throw credentialResult.error;
        if (documentResult.error) throw documentResult.error;
        setCredentials((credentialResult.data ?? []) as Credential[]);
        setDocuments((documentResult.data ?? []) as StaffDocument[]);
      } else {
        const { data, error: payrollError } = await client.from('staff_payroll_profiles')
          .select('staff_id,payroll_identifier,pay_frequency,contracted_weekly_hours').eq('school_id', schoolId);
        if (payrollError) throw payrollError;
        setPayrollProfiles(Object.fromEntries(((data ?? []) as PayrollProfile[]).map((profile) => [profile.staff_id, profile])));
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load staff operations.');
    } finally {
      setLoading(false);
    }
  }, [attendanceDate, credentialStaff, schoolId, section, selectedStaff]);

  useEffect(() => { void load(); }, [load]);

  const expiringItems = useMemo(() => {
    const now = new Date(`${localDateValue(new Date())}T00:00:00`).getTime();
    const horizon = now + 60 * 86400000;
    const credentialItems = credentials.filter((item) => item.status === 'active' && item.expires_on && new Date(`${item.expires_on}T00:00:00`).getTime() <= horizon)
      .map((item) => ({ id: item.id, staffId: item.staff_id, title: item.qualification_name, expires: item.expires_on }));
    const documentItems = documents.filter((item) => item.expires_on && new Date(`${item.expires_on}T00:00:00`).getTime() <= horizon)
      .map((item) => ({ id: item.id, staffId: item.staff_id, title: item.file_name, expires: item.expires_on }));
    return [...credentialItems, ...documentItems].sort((a, b) => (a.expires ?? '').localeCompare(b.expires ?? ''));
  }, [credentials, documents]);

  async function saveAttendance(staffId: string) {
    if (!canManage) return;
    const entry = attendanceEdits[staffId];
    if (!entry) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: saveError } = await requireSupabase().rpc('record_staff_attendance', {
        target_school: schoolId,
        target_staff: staffId,
        target_date: attendanceDate,
        next_status: entry.status,
        check_in_time: entry.check_in || null,
        check_out_time: entry.check_out || null,
        attendance_note: entry.note,
      });
      if (saveError) throw saveError;
      setSuccess(`Attendance saved for ${staff.find((person) => person.id === staffId)?.first_name ?? 'staff member'}.`);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save staff attendance.');
    } finally {
      setSaving(false);
    }
  }

  async function createLeave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: leaveError } = await requireSupabase().rpc('create_staff_leave_request', {
        target_school: schoolId,
        target_staff: selectedStaff,
        leave_type: leaveType,
        leave_start: leaveStart,
        leave_end: leaveEnd,
        leave_reason: leaveReason.trim(),
      });
      if (leaveError) throw leaveError;
      setLeaveReason('');
      formElement.reset();
      setSuccess('Staff leave request recorded.');
      await load();
    } catch (leaveError) {
      setError(leaveError instanceof Error ? leaveError.message : 'Could not record staff leave.');
    } finally {
      setSaving(false);
    }
  }

  async function reviewLeave(request: LeaveRequest, status: 'approved' | 'rejected') {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: reviewError } = await requireSupabase().rpc('review_staff_leave_request', {
        target_request: request.id,
        decision: status,
        decision_note: '',
      });
      if (reviewError) throw reviewError;
      setSuccess(`Leave ${status}.`);
      await load();
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Could not update the leave request.');
    } finally {
      setSaving(false);
    }
  }

  async function assignCoverage(requestId: string) {
    const substituteId = substituteByLeave[requestId];
    if (!substituteId) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: assignError } = await requireSupabase().rpc('assign_staff_leave_coverage', {
        target_request: requestId,
        target_substitute: substituteId,
        coverage_note: '',
      });
      if (assignError) throw assignError;
      setSuccess('Substitute coverage planned.');
      await load();
    } catch (assignError) {
      setError(assignError instanceof Error ? assignError.message : 'Could not assign substitute coverage.');
    } finally {
      setSaving(false);
    }
  }

  function getCoverConflict(candidate: StaffRecord, request: LeaveRequest) {
    const conflictingRequest = leaveRequests.find((other) => {
      if (other.id === request.id || other.status !== 'approved'
          || other.start_date > request.end_date || other.end_date < request.start_date) return false;
      const coverage = relation(other.coverage);
      return other.staff_id === candidate.id
        || (coverage?.status === 'planned' && coverage.substitute_staff_id === candidate.id);
    });
    if (!conflictingRequest) return '';
    return conflictingRequest.staff_id === candidate.id
      ? 'Has approved leave during this period'
      : 'Already covering an overlapping leave';
  }

  function hasCoverage(request: LeaveRequest) {
    const coverage = relation(request.coverage);
    return coverage !== null && coverage.status !== 'cancelled';
  }

  function availableCoverCandidates(request: LeaveRequest) {
    return teachers.filter((candidate) => candidate.employment_status === 'active'
      && candidate.id !== request.staff_id
      && !getCoverConflict(candidate, request));
  }

  async function saveCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: saveError } = await requireSupabase().from('staff_qualifications').insert({
        school_id: schoolId,
        staff_id: credentialStaff,
        qualification_name: String(form.get('qualification_name') ?? '').trim(),
        issuer: String(form.get('issuer') ?? '').trim(),
        credential_number: String(form.get('credential_number') ?? '').trim(),
        issued_on: String(form.get('issued_on') ?? '') || null,
        expires_on: String(form.get('expires_on') ?? '') || null,
        staff_document_id: credentialDocument || null,
        notes: String(form.get('notes') ?? '').trim(),
      });
      if (saveError) throw saveError;
      formElement.reset();
      setCredentialDocument('');
      setSuccess('Qualification or certification added.');
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save the qualification.');
    } finally {
      setSaving(false);
    }
  }

  async function savePayrollProfile(event: FormEvent<HTMLFormElement>, person: StaffRecord) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const client = requireSupabase();
      const { data: authData, error: authError } = await client.auth.getUser();
      if (authError) throw authError;
      if (!authData.user) throw new Error('Sign in again before updating payroll settings.');
      const { error: payrollError } = await client.from('staff_payroll_profiles').upsert({
        school_id: schoolId,
        staff_id: person.id,
        payroll_identifier: String(form.get('payroll_identifier') ?? '').trim(),
        pay_frequency: form.get('pay_frequency'),
        contracted_weekly_hours: Number(form.get('contracted_weekly_hours')),
        updated_by: authData.user.id,
      }, { onConflict: 'school_id,staff_id' });
      if (payrollError) throw payrollError;
      setSuccess(`Payroll mapping saved for ${person.first_name} ${person.last_name}.`);
      await load();
    } catch (payrollError) {
      setError(payrollError instanceof Error ? payrollError.message : 'Could not save payroll mapping.');
    } finally {
      setSaving(false);
    }
  }

  async function exportPayroll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { data, error: exportError } = await requireSupabase().rpc('get_staff_payroll_export', {
        target_school: schoolId,
        period_start: payrollStart,
        period_end: payrollEnd,
      });
      if (exportError) throw exportError;
      const rows = (data ?? []) as Record<string, unknown>[];
      if (!rows.length) throw new Error('There are no staff payroll rows for this period.');
      const headers = Object.keys(rows[0]);
      const csv = [headers.map(csvCell).join(','), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(','))].join('\r\n');
      const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `staff-payroll-${payrollStart}-${payrollEnd}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      setSuccess(`Payroll-ready CSV exported for ${rows.length} employees. Map payroll identifiers before sending to your payroll provider.`);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : 'Could not export payroll data.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingState label="Loading staff operations..." />;
  const pendingLeaveCount = leaveRequests.filter((request) => request.status === 'pending').length;
  const approvedLeaveCount = leaveRequests.filter((request) => request.status === 'approved').length;
  const coverageNeededCount = leaveRequests.filter((request) =>
    request.status === 'approved' && !hasCoverage(request)).length;
  const filteredLeaveRequests = leaveRequests.filter((request) => {
    if (leaveFilter === 'pending' || leaveFilter === 'approved' || leaveFilter === 'rejected') return request.status === leaveFilter;
    if (leaveFilter === 'needs_coverage') return request.status === 'approved' && !hasCoverage(request);
    return true;
  });

  return <section className="staff-operations">
    {error && <ErrorState message={error} />}
    {success && <SuccessMessage message={success} />}
    {!canManage && <ErrorState message="School or HR administrator access is required for this workspace." />}
    {section === 'credentials' && <>
      {expiringItems.length > 0 && <section className="staff-expiry-alert"><h3><AlertTriangle size={16} />Credentials and documents needing attention</h3>{expiringItems.map((item) => <p key={`${item.id}-${item.staffId}`}><strong>{staff.find((person) => person.id === item.staffId)?.first_name} {staff.find((person) => person.id === item.staffId)?.last_name}</strong> · {item.title} · {expiryLabel(item.expires)}</p>)}</section>}
      <div className="staff-hr-grid">
        <form className="content-card staff-hr-card" onSubmit={(event) => void saveCredential(event)}>
          <div className="section-heading"><div><span className="eyebrow">Professional records</span><h2>Qualifications &amp; certifications</h2></div><FileBadge2 size={17} /></div>
          <label className="field"><span>Staff member</span><select value={credentialStaff} onChange={(event) => setCredentialStaff(event.target.value)} required>{staff.map((person) => <option key={person.id} value={person.id}>{person.first_name} {person.last_name} · {person.employee_number}</option>)}</select></label>
          <label className="field"><span>Qualification or certificate *</span><input name="qualification_name" required minLength={2} maxLength={160} /></label>
          <label className="field"><span>Issuing organization</span><input name="issuer" maxLength={160} /></label>
          <label className="field"><span>Credential number</span><input name="credential_number" maxLength={100} /></label>
          <div className="staff-hr-date-grid"><label className="field"><span>Issue date</span><input name="issued_on" type="date" /></label><label className="field"><span>Expiry date</span><input name="expires_on" type="date" /></label></div>
          <label className="field"><span>Supporting staff document</span><select value={credentialDocument} onChange={(event) => setCredentialDocument(event.target.value)}><option value="">No linked document</option>{documents.filter((document) => document.staff_id === credentialStaff).map((document) => <option key={document.id} value={document.id}>{document.file_name}</option>)}</select></label>
          <label className="field"><span>Notes</span><textarea name="notes" rows={2} maxLength={1000} /></label>
          <button className="button button-primary" type="submit" disabled={saving || !canManage}><Save size={14} />Add credential</button>
        </form>
        <section className="content-card staff-hr-card"><div className="section-heading"><div><span className="eyebrow">Credential register</span><h2>Recorded qualifications</h2></div></div>
          {credentials.length ? <div className="staff-hr-list">{credentials.map((credential) => <article key={credential.id}><div><strong>{credential.qualification_name}</strong><small>{staff.find((person) => person.id === credential.staff_id)?.first_name} {staff.find((person) => person.id === credential.staff_id)?.last_name} · {credential.issuer || 'Issuer not recorded'}</small><small>{credential.credential_number || 'No credential number'} · {credential.expires_on ? expiryLabel(credential.expires_on) : 'No expiry recorded'}</small></div><span className={`staff-status staff-status-${credential.status === 'active' ? 'active' : 'inactive'}`}>{credential.status}</span></article>)}</div> : <EmptyState title="No credentials recorded" detail="Add staff qualifications and certificates to start expiry tracking." />}
        </section>
      </div>
    </>}

    {section === 'attendance' && <>
      <div className="staff-operations-toolbar"><label className="field"><span>Attendance date</span><input type="date" max={localDateValue(new Date())} min={localDateValue(new Date(Date.now() - 366 * 86400000))} value={attendanceDate} onChange={(event) => setAttendanceDate(event.target.value)} /></label><span>Attendance marks are restricted to HR and school administrators.</span></div>
      {staff.length ? <div className="staff-attendance-table-wrap"><table className="staff-attendance-table"><thead><tr><th>Employee</th><th>Status</th><th>Check in</th><th>Check out</th><th>Note</th><th /></tr></thead><tbody>{staff.map((person) => {
        const edit = attendanceEdits[person.id] ?? { status: 'present', check_in: '', check_out: '', note: '' };
        return <tr key={person.id}><td><strong>{person.first_name} {person.last_name}</strong><small>{person.employee_number}</small></td>
          <td><select value={edit.status} disabled={!canManage} onChange={(event) => setAttendanceEdits((current) => ({ ...current, [person.id]: { ...edit, status: event.target.value as AttendanceEdit['status'] } }))}>{['present', 'late', 'absent', 'on_leave'].map((status) => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}</select></td>
          <td><input type="time" value={edit.check_in} disabled={!canManage || !['present', 'late'].includes(edit.status)} onChange={(event) => setAttendanceEdits((current) => ({ ...current, [person.id]: { ...edit, check_in: event.target.value } }))} /></td>
          <td><input type="time" value={edit.check_out} disabled={!canManage || !['present', 'late'].includes(edit.status)} onChange={(event) => setAttendanceEdits((current) => ({ ...current, [person.id]: { ...edit, check_out: event.target.value } }))} /></td>
          <td><input value={edit.note} maxLength={500} disabled={!canManage} onChange={(event) => setAttendanceEdits((current) => ({ ...current, [person.id]: { ...edit, note: event.target.value } }))} /></td>
          <td><button className="button button-quiet" type="button" onClick={() => void saveAttendance(person.id)} disabled={saving || !canManage}>Save</button></td>
        </tr>;
      })}</tbody></table></div> : <EmptyState title="No active staff" detail="Add staff profiles before recording attendance." />}
      <p className="staff-hr-footnote">Recorded attendance: {attendance.length} of {staff.length} staff for this date.</p>
    </>}

    {section === 'leave' && <>
      <form className="content-card staff-leave-form" onSubmit={(event) => void createLeave(event)}>
        <div className="section-heading"><div><span className="eyebrow">HR operations</span><h2>Record staff leave</h2></div></div>
        <label className="field"><span>Employee</span><select value={selectedStaff} onChange={(event) => setSelectedStaff(event.target.value)} required>{staff.map((person) => <option key={person.id} value={person.id}>{person.first_name} {person.last_name} · {person.employee_number}</option>)}</select></label>
        <label className="field"><span>Leave type</span><select value={leaveType} onChange={(event) => setLeaveType(event.target.value)}>{['annual', 'sick', 'personal', 'family', 'unpaid', 'other'].map((type) => <option key={type} value={type}>{type.replace(/_/g, ' ')}</option>)}</select></label>
        <label className="field"><span>Start date</span><input required type="date" value={leaveStart} onChange={(event) => setLeaveStart(event.target.value)} /></label>
        <label className="field"><span>End date</span><input required type="date" min={leaveStart} value={leaveEnd} onChange={(event) => setLeaveEnd(event.target.value)} /></label>
        <label className="field staff-leave-reason"><span>Reason / HR note</span><textarea required minLength={3} maxLength={1000} rows={2} value={leaveReason} onChange={(event) => setLeaveReason(event.target.value)} /></label>
        <button className="button button-primary" type="submit" disabled={saving || !canManage}>Record leave</button>
      </form>
      <div className="staff-leave-summary">
        <div><strong>{pendingLeaveCount}</strong><span>Pending review</span></div>
        <div><strong>{approvedLeaveCount}</strong><span>Approved requests</span></div>
        <div className={coverageNeededCount ? 'needs-attention' : ''}><strong>{coverageNeededCount}</strong><span>Need cover</span></div>
        <label><span>Show</span><select value={leaveFilter} onChange={(event) => setLeaveFilter(event.target.value as typeof leaveFilter)}><option value="all">All requests</option><option value="pending">Pending review</option><option value="approved">Approved</option><option value="needs_coverage">Approved, cover needed</option><option value="rejected">Declined</option></select></label>
      </div>
      {filteredLeaveRequests.length ? <div className="staff-hr-list">{filteredLeaveRequests.map((request) => {
        const person = relation(request.staff);
        const coverage = relation(request.coverage);
        const needsCoverage = request.status === 'approved' && !hasCoverage(request);
        const availableCandidates = needsCoverage ? availableCoverCandidates(request) : [];
        const selectedCoverAvailable = availableCandidates.some((candidate) => candidate.id === substituteByLeave[request.id]);
        return <article className="content-card" key={request.id}><div><strong>{person?.first_name} {person?.last_name} · {request.leave_type.replace(/_/g, ' ')}</strong><small>{person?.employee_number} · {request.start_date} to {request.end_date}</small><p>{request.reason}</p>{request.review_note && <small>{request.review_note}</small>}
          {coverage && <small>Substitute: {staff.find((item) => item.id === coverage.substitute_staff_id)?.first_name} {staff.find((item) => item.id === coverage.substitute_staff_id)?.last_name} · {coverage.status}</small>}
        </div><span className={`staff-status staff-status-${request.status === 'approved' ? 'active' : request.status === 'pending' ? 'on_leave' : 'inactive'}`}>{request.status}</span>
          {request.status === 'pending' && <div className="staff-operation-actions"><button className="button button-primary" type="button" onClick={() => void reviewLeave(request, 'approved')} disabled={saving || !canManage}>Approve</button><button className="button button-quiet" type="button" onClick={() => void reviewLeave(request, 'rejected')} disabled={saving || !canManage}>Reject</button></div>}
          {needsCoverage && <div className="staff-coverage-actions"><select aria-label="Available substitute teacher" value={substituteByLeave[request.id] ?? ''} onChange={(event) => setSubstituteByLeave((current) => ({ ...current, [request.id]: event.target.value }))}><option value="">{availableCandidates.length ? 'Select available teacher' : 'No available teacher for these dates'}</option>{availableCandidates.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.first_name} {teacher.last_name} · {teacher.employee_number}</option>)}</select><button className="button button-quiet" type="button" onClick={() => void assignCoverage(request.id)} disabled={!selectedCoverAvailable || saving || !canManage}><UserCheck size={14} />Plan coverage</button></div>}
        </article>;
      })}</div> : <EmptyState title={leaveRequests.length ? 'No matching leave requests' : 'No leave requests'} detail={leaveRequests.length ? 'Choose a different leave status filter to see other requests.' : 'Record employee leave to track approvals and plan substitute coverage.' />}
    </>}

    {section === 'payroll' && <>
      <section className="content-card staff-hr-card"><div className="section-heading"><div><span className="eyebrow">Provider-neutral export</span><h2>Payroll integration</h2></div><Download size={17} /></div><p className="staff-hr-footnote">Maintain employee identifiers and pay-period settings, then export a CSV with attendance hours and approved leave. No salary or bank-account information is stored here.</p>
        <form className="staff-payroll-period" onSubmit={(event) => void exportPayroll(event)}><label className="field"><span>Period start</span><input type="date" required value={payrollStart} onChange={(event) => setPayrollStart(event.target.value)} /></label><label className="field"><span>Period end</span><input type="date" required value={payrollEnd} onChange={(event) => setPayrollEnd(event.target.value)} /></label><button className="button button-primary" type="submit" disabled={saving || !canManage}><Download size={14} />{saving ? 'Preparing…' : 'Export payroll CSV'}</button></form>
      </section>
      {staff.length ? <div className="staff-payroll-mappings">{staff.map((person) => {
        const profile = payrollProfiles[person.id];
        return <form className="content-card staff-payroll-row" key={person.id} onSubmit={(event) => void savePayrollProfile(event, person)}>
          <div><strong>{person.first_name} {person.last_name}</strong><small>{person.employee_number} · {person.job_title}</small></div>
          <label><span>Payroll ID</span><input name="payroll_identifier" required minLength={1} maxLength={80} defaultValue={profile?.payroll_identifier ?? person.employee_number} /></label>
          <label><span>Pay cycle</span><select name="pay_frequency" defaultValue={profile?.pay_frequency ?? 'monthly'}>{['weekly', 'biweekly', 'monthly', 'four_weekly'].map((cycle) => <option key={cycle} value={cycle}>{cycle}</option>)}</select></label>
          <label><span>Contract hours / week</span><input name="contracted_weekly_hours" type="number" min={0} max={168} step={0.25} defaultValue={profile?.contracted_weekly_hours ?? 0} required /></label>
          <button className="button button-quiet" type="submit" disabled={saving || !canManage}><Save size={13} />Save</button>
        </form>;
      })}</div> : <EmptyState title="No active staff" detail="Add staff profiles to configure payroll export identifiers." />}
    </>}
  </section>;
}
