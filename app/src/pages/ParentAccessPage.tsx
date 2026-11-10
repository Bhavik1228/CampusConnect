import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link2, MailPlus, RefreshCw, ShieldCheck, UsersRound } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type Student = { id: string; first_name: string; last_name: string; student_number: string; status: string; school_class: { name: string } | { name: string }[] | null };
type ParentProfile = { id: string; profile_id: string | null; first_name: string; last_name: string; email: string | null; phone: string | null; created_at: string };
type ParentStudentLink = { parent_id: string; student_id: string; relationship: string | null };
type ParentRow = ParentProfile & { children: string[] };

function messageFromError(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    const code = 'code' in error && typeof error.code === 'string' ? ` [${error.code}]` : '';
    return `${error.message}${code}`;
  }
  return fallback;
}

export function ParentAccessPage() {
  const { activeMembership } = useAuth();
  const schoolId = activeMembership?.school_id;
  const canManage = activeMembership?.role === 'school_admin';
  const [students, setStudents] = useState<Student[]>([]);
  const [parents, setParents] = useState<ParentRow[]>([]);
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([]);
  const [studentSearch, setStudentSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [success, setSuccess] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const loadRecords = useCallback(async () => {
    if (!schoolId || !canManage) {
      setStudents([]);
      setParents([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [studentsResult, parentsResult, linksResult] = await Promise.all([
        client.from('students').select('id,first_name,last_name,student_number,status,school_class:school_classes(name)')
          .eq('school_id', schoolId).order('last_name').order('first_name').limit(2000),
        client.from('parent_profiles').select('id,profile_id,first_name,last_name,email,phone,created_at')
          .eq('school_id', schoolId).order('last_name').order('first_name'),
        client.from('parent_students').select('parent_id,student_id,relationship').eq('school_id', schoolId),
      ]);
      if (studentsResult.error) throw studentsResult.error;
      if (parentsResult.error) throw parentsResult.error;
      if (linksResult.error) throw linksResult.error;
      const allStudents = (studentsResult.data ?? []) as unknown as Student[];
      const currentStudents = allStudents.filter((student) => student.status === 'active');
      const studentsById = new Map(allStudents.map((student) => [student.id, student]));
      const links = (linksResult.data ?? []) as ParentStudentLink[];
      const currentParents = ((parentsResult.data ?? []) as ParentProfile[]).map((parent) => ({
        ...parent,
        children: links.filter((link) => link.parent_id === parent.id)
          .flatMap((link) => {
            const student = studentsById.get(link.student_id);
            return student ? [`${student.first_name} ${student.last_name} · ${student.student_number}${student.status !== 'active' ? ' · Inactive' : ''}`] : [];
          }),
      }));
      setStudents(currentStudents);
      setParents(currentParents);
    } catch (loadError) {
      setError(messageFromError(loadError, 'Could not load parents and students.'));
    } finally {
      setLoading(false);
    }
  }, [canManage, schoolId]);

  useEffect(() => { void loadRecords(); }, [loadRecords, refreshKey]);

  const filteredStudents = useMemo(() => {
    const search = studentSearch.trim().toLowerCase();
    return search ? students.filter((student) =>
      `${student.first_name} ${student.last_name} ${student.student_number}`.toLowerCase().includes(search)) : students;
  }, [studentSearch, students]);

  function toggleStudent(studentId: string) {
    setSelectedStudentIds((current) => current.includes(studentId)
      ? current.filter((id) => id !== studentId)
      : current.length < 25 ? [...current, studentId] : current);
  }

  async function inviteParent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId) return;
    const formElement = event.currentTarget;
    setSaving(true);
    setFormError('');
    setSuccess('');
    try {
      const form = new FormData(event.currentTarget);
      const { data, error: inviteError } = await requireSupabase().functions.invoke('parent-invite', {
        body: {
          schoolId,
          firstName: String(form.get('first_name') ?? '').trim(),
          lastName: String(form.get('last_name') ?? '').trim(),
          email: String(form.get('email') ?? '').trim(),
          phone: String(form.get('phone') ?? '').trim(),
          relationship: String(form.get('relationship') ?? '').trim(),
          studentIds: selectedStudentIds,
        },
      });
      if (inviteError) {
        const response = inviteError.context instanceof Response
          ? await inviteError.context.json() as { error?: string }
          : null;
        throw new Error(response?.error ?? inviteError.message);
      }
      if (data?.error) throw new Error(data.error);
      setSuccess(data?.message ?? 'Parent access saved.');
      setSelectedStudentIds([]);
      formElement.reset();
      setRefreshKey((key) => key + 1);
    } catch (inviteError) {
      setFormError(messageFromError(inviteError, 'Could not invite or link this parent.'));
    } finally {
      setSaving(false);
    }
  }

  if (!canManage) return <div className="page-stack"><ErrorState message="Parent invitations and student links are available to school administrators only." /></div>;

  return <div className="page-stack parent-access-page">
    <div className="page-heading">
      <div><span className="eyebrow">{activeMembership?.school.name}</span><h1>Parent access</h1><p>Invite a guardian or link an existing account to their student. Only active students in this school can be selected.</p></div>
      <button className="button button-quiet" type="button" onClick={() => setRefreshKey((key) => key + 1)} disabled={loading}><RefreshCw size={15} /> Refresh</button>
    </div>
    {error && <ErrorState message={error} />}
    {success && <SuccessMessage message={success} />}

    <section className="parent-access-layout">
      <article className="content-card parent-access-form-card">
        <div className="section-heading"><div><span className="eyebrow">Guardian account</span><h2>Invite and link a parent</h2></div><MailPlus size={19} className="muted-icon" /></div>
        <p className="parent-access-help">A new guardian receives a secure account setup invitation. If the email already belongs to a Campus Connect account, that account is linked instead; its role at this school must be new or already be Parent.</p>
        {formError && <ErrorState message={formError} />}
        <form className="parent-access-form" onSubmit={(event) => void inviteParent(event)}>
          <div className="parent-access-name-grid">
            <label className="field"><span>First name</span><input name="first_name" required maxLength={80} autoComplete="given-name" disabled={saving} /></label>
            <label className="field"><span>Last name</span><input name="last_name" required maxLength={80} autoComplete="family-name" disabled={saving} /></label>
          </div>
          <label className="field"><span>Guardian email</span><input name="email" type="email" required maxLength={254} autoComplete="email" disabled={saving} /></label>
          <label className="field"><span>Phone (optional)</span><input name="phone" type="tel" maxLength={40} autoComplete="tel" disabled={saving} /></label>
          <label className="field"><span>Relationship to student</span><select name="relationship" defaultValue="" required disabled={saving}>
            <option value="" disabled>Select relationship</option><option>Parent</option><option>Mother</option><option>Father</option><option>Guardian</option><option>Other caregiver</option>
          </select></label>
          <fieldset className="parent-access-student-picker" disabled={saving || loading}>
            <legend>Link students <span>{selectedStudentIds.length}/25 selected</span></legend>
            <input aria-label="Search active students" type="search" value={studentSearch} onChange={(event) => setStudentSearch(event.target.value)} placeholder="Search name or student number" />
            {loading ? <LoadingState label="Loading active students…" /> : students.length === 0
              ? <EmptyState title="No active students found" detail="Add or activate a student before linking a guardian account." />
              : filteredStudents.length === 0 ? <p className="parent-access-empty-hint">No students match that search.</p>
                : <div className="parent-access-student-list">{filteredStudents.map((student) => {
                  const schoolClass = Array.isArray(student.school_class) ? student.school_class[0] : student.school_class;
                  return <label key={student.id} className="parent-access-student-option">
                    <input type="checkbox" checked={selectedStudentIds.includes(student.id)} onChange={() => toggleStudent(student.id)} disabled={!selectedStudentIds.includes(student.id) && selectedStudentIds.length >= 25} />
                    <span><strong>{student.first_name} {student.last_name}</strong><small>{student.student_number}{schoolClass?.name ? ` · ${schoolClass.name}` : ''}</small></span>
                  </label>;
                })}</div>}
          </fieldset>
          <button className="button button-primary" type="submit" disabled={saving || loading || selectedStudentIds.length === 0}>
            <MailPlus size={16} />{saving ? 'Saving parent access…' : 'Invite and link parent'}
          </button>
        </form>
      </article>

      <article className="content-card parent-access-directory">
        <div className="section-heading"><div><span className="eyebrow">Approved relationships</span><h2>Parents linked to students</h2></div><UsersRound size={19} className="muted-icon" /></div>
        {loading ? <LoadingState label="Loading parent links…" /> : parents.length === 0
          ? <EmptyState title="No parent accounts linked" detail="Invited and linked parents will appear here." />
          : <div className="parent-access-list">{parents.map((parent) => <article key={parent.id}>
            <div className="parent-access-list-heading"><span className="parent-access-avatar"><ShieldCheck size={16} /></span><div><strong>{parent.first_name} {parent.last_name}</strong><small>{parent.email || 'No email recorded'}{parent.profile_id ? ' · Account linked' : ' · No login account'}</small></div></div>
            <div className="parent-access-child-list"><strong><Link2 size={14} /> Linked students</strong>
              {parent.children.length ? <ul>{parent.children.map((child) => <li key={child}>{child}</li>)}</ul> : <p>No active student links.</p>}
            </div>
          </article>)}</div>}
      </article>
    </section>
  </div>;
}
