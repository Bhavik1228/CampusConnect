import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Search, ShieldCheck, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type ContactChannel = 'email' | 'phone';
type ContactStatus = 'unverified' | 'verified' | 'invalid';
type VerificationMethod = 'phone_call' | 'email_reply' | 'in_person' | 'document_review';
type ParentContact = { id: string; first_name: string; last_name: string; email: string | null; phone: string | null };
type ParentStudentLink = { parent_id: string; student_id: string; relationship: string | null };
type StudentContactRecord = { id: string; first_name: string; last_name: string; student_number: string };
type VerificationRecord = {
  id: string;
  parent_id: string;
  contact_channel: ContactChannel;
  status: ContactStatus;
  checked_value: string | null;
  verification_method: VerificationMethod | null;
  verified_at: string | null;
  note: string;
  updated_at: string;
};
type GuardianRecord = ParentContact & {
  students: string[];
  emailVerification: VerificationRecord | null;
  phoneVerification: VerificationRecord | null;
};

const methodLabels: Record<VerificationMethod, string> = {
  phone_call: 'Confirmed by phone call',
  email_reply: 'Confirmed by email reply',
  in_person: 'Confirmed in person',
  document_review: 'Confirmed from documentation',
};

function normalizedContact(channel: ContactChannel, value: string | null) {
  if (!value) return '';
  return channel === 'email' ? value.trim().toLowerCase() : value.trim().replace(/\s+/g, '');
}

function formatCheckedAt(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function GuardianContactVerificationPage() {
  const { activeMembership } = useAuth();
  const schoolId = activeMembership?.school_id;
  const canManage = activeMembership?.role === 'school_admin';
  const [guardians, setGuardians] = useState<GuardianRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState('');
  const [query, setQuery] = useState('');
  const [methodByContact, setMethodByContact] = useState<Record<string, VerificationMethod>>({});
  const [noteByContact, setNoteByContact] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    if (!schoolId || !canManage) {
      setGuardians([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [parentResult, linksResult, verificationsResult] = await Promise.all([
        client.from('parent_profiles').select('id,first_name,last_name,email,phone')
          .eq('school_id', schoolId).order('last_name').order('first_name'),
        client.from('parent_students').select('parent_id,student_id,relationship').eq('school_id', schoolId),
        client.from('guardian_contact_verifications')
          .select('id,parent_id,contact_channel,status,checked_value,verification_method,verified_at,note,updated_at')
          .eq('school_id', schoolId),
      ]);
      if (parentResult.error) throw parentResult.error;
      if (linksResult.error) throw linksResult.error;
      if (verificationsResult.error) throw verificationsResult.error;
      const parents = (parentResult.data ?? []) as ParentContact[];
      const links = (linksResult.data ?? []) as ParentStudentLink[];
      const studentIds = [...new Set(links.map((link) => link.student_id))];
      const studentsResult = studentIds.length
        ? await client.from('students').select('id,first_name,last_name,student_number')
          .eq('school_id', schoolId).in('id', studentIds)
        : { data: [], error: null };
      if (studentsResult.error) throw studentsResult.error;
      const studentsById = new Map(((studentsResult.data ?? []) as StudentContactRecord[]).map((student) => [student.id, student]));
      const verifications = (verificationsResult.data ?? []) as VerificationRecord[];
      const records = parents.map((parent): GuardianRecord => {
        const linkedStudents = links.filter((link) => link.parent_id === parent.id)
          .flatMap((link) => {
            const student = studentsById.get(link.student_id);
            return student ? [`${student.first_name} ${student.last_name} (${student.student_number})`] : [];
          });
        return {
          ...parent,
          students: linkedStudents,
          emailVerification: verifications.find((item) => item.parent_id === parent.id && item.contact_channel === 'email') ?? null,
          phoneVerification: verifications.find((item) => item.parent_id === parent.id && item.contact_channel === 'phone') ?? null,
        };
      });
      setGuardians(records);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load guardian contact verification records.');
    } finally {
      setLoading(false);
    }
  }, [canManage, schoolId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const contactRows = useMemo(() => guardians.flatMap((guardian) => ([
    { guardian, channel: 'email' as const, value: guardian.email, verification: guardian.emailVerification },
    { guardian, channel: 'phone' as const, value: guardian.phone, verification: guardian.phoneVerification },
  ]).filter((contact) => Boolean(contact.value?.trim()))), [guardians]);
  const verifiedCount = contactRows.filter(({ channel, value, verification }) =>
    verification?.status === 'verified'
    && verification.checked_value === normalizedContact(channel, value)).length;
  const invalidCount = contactRows.filter(({ channel, value, verification }) =>
    verification?.status === 'invalid'
    && verification.checked_value === normalizedContact(channel, value)).length;
  const needsReviewCount = contactRows.length - verifiedCount;
  const filteredGuardians = guardians.filter((guardian) =>
    `${guardian.first_name} ${guardian.last_name} ${guardian.email ?? ''} ${guardian.phone ?? ''} ${guardian.students.join(' ')}`
      .toLowerCase().includes(query.trim().toLowerCase()));

  async function recordVerification(
    guardian: GuardianRecord,
    channel: ContactChannel,
    status: ContactStatus,
  ) {
    const key = `${guardian.id}:${channel}`;
    setSavingKey(key);
    setError('');
    setSuccess('');
    try {
      const { error: saveError } = await requireSupabase().rpc('record_guardian_contact_verification', {
        target_parent: guardian.id,
        contact_channel: channel,
        next_status: status,
        verification_method: status === 'unverified' ? null : methodByContact[key] ?? (channel === 'email' ? 'email_reply' : 'phone_call'),
        verification_note: noteByContact[key] ?? '',
      });
      if (saveError) throw saveError;
      setSuccess(`${guardian.first_name} ${guardian.last_name} ${channel} marked ${status}.`);
      setRefreshKey((current) => current + 1);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save this contact verification.');
    } finally {
      setSavingKey('');
    }
  }

  if (!canManage) return <div className="page-stack"><ErrorState message="Guardian contact verification is available to school administrators only." /></div>;

  return <div className="page-stack">
    <div className="page-heading">
      <div><span className="eyebrow">{activeMembership?.school.name}</span><h1>Guardian contact verification</h1><p>Review and record the verification state of guardian email addresses and phone numbers linked to students.</p></div>
      <span className="guardian-verification-heading-icon"><ShieldCheck size={20} />Manual verification</span>
    </div>
    <p className="guardian-verification-notice">No email or text message is sent automatically. Mark a contact verified only after an actual reply, call, in-person confirmation, or document review.</p>
    {success && <p className="inline-success" role="status">{success}</p>}
    {error && <ErrorState message={error} />}
    <section className="guardian-verification-metrics">
      <article><span>Guardian contacts</span><strong>{contactRows.length.toLocaleString()}</strong><small>Email and phone values on file</small></article>
      <article><span>Verified and current</span><strong>{verifiedCount.toLocaleString()}</strong><small>Verified value still matches current record</small></article>
      <article><span>Needs review</span><strong>{needsReviewCount.toLocaleString()}</strong><small>Unverified, changed, or invalid contacts</small></article>
      <article><span>Marked invalid</span><strong>{invalidCount.toLocaleString()}</strong><small>Requires correction by school staff</small></article>
    </section>
    <section className="content-card guardian-verification-list">
      <div className="section-heading"><div><span className="eyebrow">Family contact records</span><h2>Verification queue</h2></div></div>
      <label className="table-search guardian-verification-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search guardian, contact, or student" aria-label="Search guardian contacts" /></label>
      {loading ? <LoadingState label="Loading guardian contacts…" /> : filteredGuardians.length === 0
        ? <EmptyState title={query ? 'No matching guardians' : 'No guardian records found'} detail={query ? 'Adjust your search and try again.' : 'Guardian records linked to students will appear here.'} />
        : <div className="guardian-verification-records">{filteredGuardians.map((guardian) => <article key={guardian.id}>
          <header><div><strong>{guardian.first_name} {guardian.last_name}</strong><small>{guardian.students.length ? guardian.students.join(' · ') : 'No student link recorded'}</small></div></header>
          <div className="guardian-contact-grid">
            {(['email', 'phone'] as const).map((channel) => {
              const value = guardian[channel];
              const verification = channel === 'email' ? guardian.emailVerification : guardian.phoneVerification;
              const key = `${guardian.id}:${channel}`;
              const matchesVerifiedValue = Boolean(value && verification?.checked_value === normalizedContact(channel, value));
              const effectiveStatus = matchesVerifiedValue ? verification?.status ?? 'unverified' : 'unverified';
              const statusLabel = !value ? 'Not provided' : effectiveStatus === 'verified' ? 'Verified' : effectiveStatus === 'invalid' ? 'Invalid' : verification?.status === 'verified' || verification?.status === 'invalid' ? 'Changed · reverify' : 'Unverified';
              return <section key={channel} className="guardian-contact-card">
                <div className="guardian-contact-heading"><span>{channel === 'email' ? 'Email address' : 'Phone number'}</span><strong className={`guardian-contact-status ${effectiveStatus}`}>{statusLabel}</strong></div>
                <strong className="guardian-contact-value">{value || 'No contact value on file'}</strong>
                {verification?.verification_method && matchesVerifiedValue && <small className="guardian-contact-method">{methodLabels[verification.verification_method]} · {formatCheckedAt(verification.updated_at)}</small>}
                {verification?.note && matchesVerifiedValue && <small className="guardian-contact-note">{verification.note}</small>}
                {value && <div className="guardian-contact-actions">
                  <select aria-label={`Verification method for ${guardian.first_name} ${guardian.last_name} ${channel}`} value={methodByContact[key] ?? (channel === 'email' ? 'email_reply' : 'phone_call')} disabled={savingKey === key} onChange={(event) => setMethodByContact((current) => ({ ...current, [key]: event.target.value as VerificationMethod }))}>
                    {Object.entries(methodLabels).map(([method, label]) => <option key={method} value={method}>{label}</option>)}
                  </select>
                  <input aria-label={`Verification note for ${guardian.first_name} ${guardian.last_name} ${channel}`} value={noteByContact[key] ?? ''} maxLength={500} placeholder="Optional verification note" disabled={savingKey === key} onChange={(event) => setNoteByContact((current) => ({ ...current, [key]: event.target.value }))} />
                  <div>
                    <button className="button button-primary" type="button" disabled={savingKey === key} onClick={() => void recordVerification(guardian, channel, 'verified')}><Check size={13} />Verify</button>
                    <button className="button button-secondary" type="button" disabled={savingKey === key} onClick={() => void recordVerification(guardian, channel, 'invalid')}><X size={13} />Mark invalid</button>
                    {verification && <button className="button button-quiet" type="button" disabled={savingKey === key} onClick={() => void recordVerification(guardian, channel, 'unverified')}>Reset</button>}
                  </div>
                </div>}
              </section>;
            })}
          </div>
        </article>)}</div>}
    </section>
  </div>;
}
