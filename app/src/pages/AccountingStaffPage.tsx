import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { MailPlus, ShieldCheck, Users } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';
import type { AppRole } from '../types/database';

type AccountingRole = Extract<AppRole, 'finance_manager' | 'accountant' | 'bursar' | 'cashier'>;

interface StaffMember {
  profile_id: string;
  role: AppRole;
  created_at: string;
  profile: { full_name: string; email: string | null } | null;
}

const roleDetails: Record<AccountingRole, string> = {
  finance_manager: 'Manage fee structures, invoices, discounts, adjustments, and payments.',
  accountant: 'Manage fee structures, invoices, discounts, adjustments, and payments.',
  bursar: 'Manage fee structures, invoices, discounts, adjustments, and payments.',
  cashier: 'View student fee accounts and record payments and receipts.',
};

const roleLabels: Record<AppRole, string> = {
  system_admin: 'System admin',
  school_admin: 'School admin',
  academic_coordinator: 'Academic coordinator',
  teacher: 'Teacher',
  student: 'Student',
  parent: 'Parent',
  finance_manager: 'Finance manager',
  accountant: 'Accountant',
  bursar: 'Bursar',
  cashier: 'Cashier',
  nurse: 'School nurse',
  doctor: 'School doctor',
  secretary: 'School secretary',
};

export function AccountingStaffPage() {
  const { activeMembership } = useAuth();
  const schoolId = activeMembership?.school_id;
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [success, setSuccess] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedRole, setSelectedRole] = useState<AccountingRole>('accountant');
  const canManage = activeMembership?.role === 'school_admin';

  const loadStaff = useCallback(async () => {
    if (!schoolId) return;
    setLoading(true);
    setError('');
    try {
      const { data, error: queryError } = await requireSupabase()
        .from('school_memberships')
        .select('profile_id, role, created_at, profile:profiles(full_name, email)')
        .eq('school_id', schoolId)
        .order('created_at', { ascending: false });
      if (queryError) throw queryError;
      setStaff((data ?? []) as unknown as StaffMember[]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load school staff.');
    } finally {
      setLoading(false);
    }
  }, [schoolId]);

  useEffect(() => { void loadStaff(); }, [loadStaff, refreshKey]);

  async function inviteStaff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId) return;
    const formElement = event.currentTarget;
    setSaving(true);
    setFormError('');
    setSuccess('');
    try {
      const form = new FormData(event.currentTarget);
      const { data, error: inviteError } = await requireSupabase().functions.invoke('staff-invite', {
        body: {
          schoolId,
          fullName: String(form.get('full_name') ?? '').trim(),
          email: String(form.get('email') ?? '').trim(),
          role: selectedRole,
        },
      });
      if (inviteError) {
        const response = inviteError.context instanceof Response
          ? await inviteError.context.json() as { error?: string }
          : null;
        throw new Error(response?.error ?? inviteError.message);
      }
      if (data?.error) throw new Error(data.error);
      formElement.reset();
      setSuccess('Invitation sent. The new staff member can use the secure email link to accept the invite and sign in.');
      setRefreshKey((key) => key + 1);
    } catch (inviteError) {
      setFormError(inviteError instanceof Error ? inviteError.message : 'The staff invitation could not be sent.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div><span className="eyebrow">School administration</span><h1>Accounting staff</h1><p>Invite finance team members and assign the access they need.</p></div>
      </div>
      {!canManage && <ErrorState message="Only a school administrator can invite accounting staff." />}
      {error && <ErrorState message={error} />}
      {success && <SuccessMessage message={success} />}
      <section className="accounting-staff-grid">
        <article className="content-card">
          <div className="section-heading"><div><span className="eyebrow">New team member</span><h2>Send an invitation</h2></div><MailPlus size={19} className="muted-icon" /></div>
          <p className="accounting-help">We’ll email a secure, one-time account setup link. Passwords are never sent by email.</p>
          {formError && <ErrorState message={formError} />}
          <form className="accounting-form" onSubmit={(event) => void inviteStaff(event)}>
            <label className="field"><span>Full name</span><input name="full_name" required minLength={2} maxLength={120} autoComplete="name" disabled={!canManage || saving} /></label>
            <label className="field"><span>Work email</span><input name="email" type="email" required maxLength={320} autoComplete="email" disabled={!canManage || saving} /></label>
            <label className="field"><span>Accounting role</span><select name="role" value={selectedRole} disabled={!canManage || saving} onChange={(event) => setSelectedRole(event.target.value as AccountingRole)}>{(['finance_manager', 'accountant', 'bursar', 'cashier'] as AccountingRole[]).map((role) => <option key={role} value={role}>{roleLabels[role]}</option>)}</select></label>
            <p className="accounting-role-detail">{roleDetails[selectedRole]}</p>
            <button className="button button-primary" type="submit" disabled={!canManage || saving}><MailPlus size={16} />{saving ? 'Sending invitation…' : 'Invite staff member'}</button>
          </form>
        </article>
        <article className="content-card accounting-roles-card">
          <div className="section-heading"><div><span className="eyebrow">Least-privilege access</span><h2>Role permissions</h2></div><ShieldCheck size={19} className="muted-icon" /></div>
          {(Object.keys(roleDetails) as AccountingRole[]).map((role) => <div className="accounting-role-row" key={role}><strong>{roleLabels[role]}</strong><span>{roleDetails[role]}</span></div>)}
          <p className="accounting-help">Accounting roles cannot manage school users or change school settings.</p>
        </article>
      </section>
      <section className="content-card">
        <div className="section-heading"><div><span className="eyebrow">School workspace</span><h2>Members</h2></div><Users size={19} className="muted-icon" /></div>
        {loading ? <LoadingState label="Loading school members…" /> : staff.length === 0
          ? <p className="accounting-help">No school members have been added yet.</p>
          : <div className="accounting-table-wrap"><table className="accounting-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Joined</th></tr></thead><tbody>{staff.map((member) => <tr key={member.profile_id}><td>{member.profile?.full_name || 'Name not set'}</td><td>{member.profile?.email || '—'}</td><td><span className="accounting-status">{roleLabels[member.role] ?? member.role}</span></td><td>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(member.created_at))}</td></tr>)}</tbody></table></div>}
      </section>
    </div>
  );
}
