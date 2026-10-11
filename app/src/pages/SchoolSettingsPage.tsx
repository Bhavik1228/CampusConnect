import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { BookOpen, Check, ClipboardCheck, LockKeyhole, MessageSquare, Puzzle, Save, School, ShieldCheck } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';
import type {
  SchoolAcademicPolicies,
  SchoolCommunicationSettings,
  SchoolModuleSettings,
  SchoolSecuritySettings,
} from '../types/database';

interface SchoolProfile {
  name: string;
  timezone: string;
  contact_email: string | null;
  contact_phone: string | null;
  address: string | null;
  website: string | null;
  logo_path: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  motto: string | null;
  established_year: number | null;
  school_type: string | null;
  accreditation: string | null;
  student_id_prefix: string | null;
  student_id_format: string;
  default_language: string;
}

interface AttendanceSettings {
  school_id: string;
  default_session_type: 'daily' | 'morning' | 'afternoon';
  late_after: string | null;
  require_complete_register: boolean;
  allow_parent_explanations: boolean;
  notify_on_absence: boolean;
  notify_on_late: boolean;
  attendance_target_percent: number;
  attendance_warning_percent: number;
  repeated_absence_threshold: number;
  consecutive_absence_threshold: number;
  auto_lock_after_days: number | null;
  late_to_absence_after_minutes: number | null;
  attendance_calculation_basis: 'daily' | 'lesson';
  excused_counts_as_present: boolean;
}

interface AttendanceStatus {
  status: string;
  label: string;
  enabled: boolean;
  counts_as_present: boolean;
  sort_order: number;
}

type SettingsTab = 'profile' | 'academics' | 'attendance' | 'portals' | 'modules' | 'security';
const tabs: { id: SettingsTab; label: string; icon: typeof School; description: string }[] = [
  { id: 'profile', label: 'School profile', icon: School, description: 'Identity, branding, contact details, and student records.' },
  { id: 'academics', label: 'Academics', icon: BookOpen, description: 'Grading scales, assessment, terms, reporting, and timetables.' },
  { id: 'attendance', label: 'Attendance', icon: ClipboardCheck, description: 'Registers, thresholds, absence rules, and family notifications.' },
  { id: 'portals', label: 'Portals & communication', icon: MessageSquare, description: 'Family and student portal access, email, and notifications.' },
  { id: 'modules', label: 'Modules & features', icon: Puzzle, description: 'Choose the tools and capabilities enabled for your school.' },
  { id: 'security', label: 'Security & privacy', icon: ShieldCheck, description: 'Account protection, password rules, retention, and exports.' },
];

const moduleGroups: { title: string; description: string; options: [keyof SchoolModuleSettings, string][] }[] = [
  { title: 'Workspace modules', description: 'Turn major areas of the school workspace on or off.', options: [
    ['module_attendance', 'Attendance'], ['module_timetable', 'Timetable'], ['module_learning', 'Learning resources'],
    ['module_assignments', 'Assignments'], ['module_announcements', 'Announcements'], ['module_events', 'Events'],
    ['module_messaging', 'Messaging'], ['module_directory', 'School directory'], ['module_calendar', 'Calendar'],
    ['module_reports', 'Reports'], ['module_settings', 'School settings'],
  ] },
  { title: 'Academic workflows', description: 'Enable additional teaching, assessment, and student-support tools.', options: [
    ['module_leave_management', 'Leave management'], ['module_parent_explanations', 'Parent absence explanations'],
    ['module_correction_requests', 'Grade correction requests'], ['module_followup_tasks', 'Follow-up tasks'],
    ['module_substitute_assignments', 'Substitute assignments'], ['module_notification_templates', 'Notification templates'],
    ['module_past_papers', 'Past papers'], ['module_assessment_results', 'Assessment results'],
  ] },
  { title: 'School services', description: 'Optional services for schools that need them.', options: [
    ['module_analytics', 'Analytics'], ['module_library', 'Library'], ['module_finance', 'Finance'],
    ['module_transport', 'Transport'], ['module_hostel', 'Hostel'], ['module_health', 'Health office'],
    ['module_canteen', 'Canteen'], ['module_uniform', 'Uniforms'],
  ] },
];

function TextField({ label, value, onChange, disabled, type = 'text', placeholder, maxLength }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  type?: string;
  placeholder?: string;
  maxLength?: number;
}) {
  return <label className="field"><span>{label}</span><input type={type} value={value} disabled={disabled} placeholder={placeholder} maxLength={maxLength} onChange={(event) => onChange(event.target.value)} /></label>;
}

function NumberField({ label, value, onChange, disabled, min, max, step = 1, suffix }: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  disabled: boolean;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  return <label className="field"><span>{label}</span><span className="settings-number-wrap"><input type="number" value={value ?? ''} disabled={disabled} min={min} max={max} step={step} onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))} />{suffix && <small>{suffix}</small>}</span></label>;
}

function SelectField({ label, value, onChange, disabled, options }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  options: [string, string][];
}) {
  return <label className="field"><span>{label}</span><select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{options.map(([option, text]) => <option key={option} value={option}>{text}</option>)}</select></label>;
}

function Toggle({ label, detail, checked, onChange, disabled }: {
  label: string;
  detail?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled: boolean;
}) {
  return <label className={`settings-toggle${disabled ? ' disabled' : ''}`}><span className="settings-toggle-copy"><strong>{label}</strong>{detail && <small>{detail}</small>}</span><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><span className="settings-switch" aria-hidden="true" /></label>;
}

function Section({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  return <section className="settings-subsection"><div className="settings-subheading"><h3>{title}</h3>{detail && <p>{detail}</p>}</div>{children}</section>;
}

export function SchoolSettingsPage() {
  const { activeMembership, refreshMemberships, user } = useAuth();
  const schoolId = activeMembership?.school_id;
  const canEdit = activeMembership?.role === 'school_admin';
  const [tab, setTab] = useState<SettingsTab>('profile');
  const [profile, setProfile] = useState<SchoolProfile | null>(null);
  const [academics, setAcademics] = useState<SchoolAcademicPolicies | null>(null);
  const [attendance, setAttendance] = useState<AttendanceSettings | null>(null);
  const [attendanceStatuses, setAttendanceStatuses] = useState<AttendanceStatus[]>([]);
  const [communication, setCommunication] = useState<SchoolCommunicationSettings | null>(null);
  const [modules, setModules] = useState<SchoolModuleSettings | null>(null);
  const [security, setSecurity] = useState<SchoolSecuritySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<SettingsTab | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    if (!schoolId) return;
    let active = true;
    async function loadSettings() {
      setLoading(true);
      setError('');
      try {
        const client = requireSupabase();
        const [schoolResult, academicResult, attendanceResult, statusResult, communicationResult, moduleResult, securityResult] = await Promise.all([
          client.from('schools').select('name, timezone, contact_email, contact_phone, address, website, logo_path, primary_color, secondary_color, motto, established_year, school_type, accreditation, student_id_prefix, student_id_format, default_language').eq('id', schoolId).single(),
          client.from('school_academic_policies').select('*').eq('school_id', schoolId).single(),
          client.from('attendance_settings').select('school_id, default_session_type, late_after, require_complete_register, allow_parent_explanations, notify_on_absence, notify_on_late, attendance_target_percent, attendance_warning_percent, repeated_absence_threshold, consecutive_absence_threshold, auto_lock_after_days, late_to_absence_after_minutes, attendance_calculation_basis, excused_counts_as_present').eq('school_id', schoolId).single(),
          client.from('attendance_status_settings').select('status, label, enabled, counts_as_present, sort_order').eq('school_id', schoolId).order('sort_order'),
          client.from('school_communication_settings').select('school_id, email_from_name, email_from_address, email_reply_to, email_footer, sms_enabled, sms_provider, sms_from_number, push_enabled, notification_retention_days, notification_categories, parent_portal_enabled, parent_portal_features, student_portal_enabled, student_portal_features').eq('school_id', schoolId).single(),
          client.from('school_module_settings').select('*').eq('school_id', schoolId).single(),
          client.from('school_security_settings').select('*').eq('school_id', schoolId).single(),
        ]);
        const resultError = [schoolResult, academicResult, attendanceResult, statusResult, communicationResult, moduleResult, securityResult].find((result) => result.error)?.error;
        if (resultError) throw resultError;
        if (active) {
          setProfile(schoolResult.data as SchoolProfile);
          setAcademics(academicResult.data as SchoolAcademicPolicies);
          setAttendance(attendanceResult.data as AttendanceSettings);
          setAttendanceStatuses((statusResult.data ?? []) as AttendanceStatus[]);
          setCommunication(communicationResult.data as SchoolCommunicationSettings);
          setModules(moduleResult.data as SchoolModuleSettings);
          setSecurity(securityResult.data as SchoolSecuritySettings);
        }
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Could not load school settings.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadSettings();
    return () => { active = false; };
  }, [schoolId]);

  async function persist(table: string, values: object) {
    if (!schoolId) throw new Error('No active school is selected.');
    const { error: saveError } = await requireSupabase().from(table).upsert({
      ...values,
      school_id: schoolId,
      updated_by: user?.id ?? null,
    }, { onConflict: 'school_id' });
    if (saveError) throw saveError;
  }

  async function saveSection(event: FormEvent<HTMLFormElement>, section: SettingsTab) {
    event.preventDefault();
    if (section === 'security' && security?.require_mfa && security.mfa_methods.length === 0) {
      setError('Select at least one multi-factor authentication method or disable the MFA requirement.');
      setSuccess('');
      return;
    }
    if (section === 'attendance' && !attendanceStatuses.some((status) => status.enabled)) {
      setError('Enable at least one attendance status before saving.');
      setSuccess('');
      return;
    }
    setSaving(section);
    setError('');
    setSuccess('');
    try {
      if (section === 'profile' && profile) {
        const { data, error: saveError } = await requireSupabase().from('schools').update({
          ...profile,
          name: profile.name.trim(),
          timezone: profile.timezone.trim(),
          contact_email: profile.contact_email?.trim() || null,
          contact_phone: profile.contact_phone?.trim() || null,
          address: profile.address?.trim() || null,
          website: profile.website?.trim() || null,
          motto: profile.motto?.trim() || null,
          accreditation: profile.accreditation?.trim() || null,
          student_id_prefix: profile.student_id_prefix?.trim() || null,
        }).eq('id', schoolId).select('name, timezone, contact_email, contact_phone, address, website, logo_path, primary_color, secondary_color, motto, established_year, school_type, accreditation, student_id_prefix, student_id_format, default_language').single();
        if (saveError) throw saveError;
        setProfile(data as SchoolProfile);
        try {
          await refreshMemberships();
        } catch (refreshError) {
          setError(`School profile was saved, but the workspace list could not refresh: ${refreshError instanceof Error ? refreshError.message : 'Refresh failed.'}`);
        }
      } else if (section === 'academics' && academics) {
        await persist('school_academic_policies', academics);
      } else if (section === 'attendance' && attendance) {
        await persist('attendance_settings', attendance);
        const client = requireSupabase();
        const { error: statusError } = await client.from('attendance_status_settings').upsert(
          attendanceStatuses.map((status) => ({ ...status, school_id: schoolId })),
          { onConflict: 'school_id,status' },
        );
        if (statusError) throw new Error(`Attendance rules were saved, but attendance statuses could not be saved: ${statusError.message}`);
      } else if (section === 'portals' && communication) {
        await persist('school_communication_settings', communication);
      } else if (section === 'modules' && modules) {
        await persist('school_module_settings', modules);
      } else if (section === 'security' && security) {
        await persist('school_security_settings', security);
      }
      setSuccess(`${tabs.find((item) => item.id === section)?.label ?? 'Settings'} saved.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save school settings.');
    } finally {
      setSaving(null);
    }
  }

  function updateProfile(field: keyof SchoolProfile, value: string | number | null) {
    setProfile((current) => current ? { ...current, [field]: value } : current);
    setSuccess('');
  }

  function changeTab(nextTab: SettingsTab) {
    setTab(nextTab);
    setSuccess('');
    setError('');
  }

  function saveButton(section: SettingsTab) {
    return <div className="settings-actions">{canEdit
      ? <button className="button button-primary" type="submit" disabled={saving !== null}><Save size={15} />{saving === section ? 'Saving…' : 'Save changes'}</button>
      : <p className="settings-readonly"><LockKeyhole size={14} />Only a school administrator can update these settings.</p>}</div>;
  }

  if (loading) return <div className="page-stack"><LoadingState label="Loading school settings…" /></div>;

  return (
    <div className="page-stack">
      <div className="page-heading"><div><span className="eyebrow">Workspace administration</span><h1>School settings</h1><p>Configure your school's identity, academic rules, operations, and access.</p></div></div>
      {error && <ErrorState message={error} />}
      {success && <SuccessMessage message={success} />}
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="School settings categories">
          {tabs.map(({ id, label, icon: Icon }) => <button key={id} type="button" className={`settings-nav-item${tab === id ? ' active' : ''}`} aria-current={tab === id ? 'page' : undefined} onClick={() => changeTab(id)}><Icon size={17} /><span>{label}</span>{tab === id && <Check size={14} className="settings-nav-check" />}</button>)}
          <p className="settings-nav-description">{tabs.find((item) => item.id === tab)?.description}</p>
        </nav>
        <div className="settings-main">
          {tab === 'profile' && profile && <form className="content-card settings-form" onSubmit={(event) => void saveSection(event, 'profile')}>
            <div className="settings-section-heading"><span className="eyebrow">School identity</span><h2>Profile & branding</h2><p>Set the details and visual identity shown across your school workspace.</p></div>
            <Section title="Identity" detail="Names and records used across the school.">
              <div className="settings-fields">
                <TextField label="School name" value={profile.name} disabled={!canEdit} maxLength={120} onChange={(value) => updateProfile('name', value)} />
                <SelectField label="School type" value={profile.school_type ?? ''} disabled={!canEdit} onChange={(value) => updateProfile('school_type', value || null)} options={[['', 'Select school type'], ['primary', 'Primary'], ['secondary', 'Secondary'], ['k12', 'K–12'], ['university', 'University'], ['other', 'Other']]} />
                <NumberField label="Year established" value={profile.established_year} disabled={!canEdit} min={1000} max={2100} onChange={(value) => updateProfile('established_year', value)} />
                <TextField label="School motto" value={profile.motto ?? ''} disabled={!canEdit} maxLength={200} onChange={(value) => updateProfile('motto', value)} />
                <TextField label="Accreditation" value={profile.accreditation ?? ''} disabled={!canEdit} maxLength={500} onChange={(value) => updateProfile('accreditation', value)} />
                <TextField label="Default language code" value={profile.default_language} disabled={!canEdit} maxLength={10} placeholder="en" onChange={(value) => updateProfile('default_language', value)} />
              </div>
            </Section>
            <Section title="Branding" detail="Choose school colors and an optional logo location.">
              <div className="settings-fields">
                <TextField label="Logo path or URL" value={profile.logo_path ?? ''} disabled={!canEdit} maxLength={500} placeholder="https://… or storage path" onChange={(value) => updateProfile('logo_path', value || null)} />
                <TextField label="Primary brand color" type="color" value={profile.primary_color ?? '#6555d9'} disabled={!canEdit} onChange={(value) => updateProfile('primary_color', value)} />
                <TextField label="Secondary brand color" type="color" value={profile.secondary_color ?? '#20243a'} disabled={!canEdit} onChange={(value) => updateProfile('secondary_color', value)} />
              </div>
            </Section>
            <Section title="Contact & location" detail="Contact details for families and school staff.">
              <div className="settings-fields">
                <TextField label="Contact email" type="email" value={profile.contact_email ?? ''} disabled={!canEdit} maxLength={254} onChange={(value) => updateProfile('contact_email', value)} />
                <TextField label="Contact phone" type="tel" value={profile.contact_phone ?? ''} disabled={!canEdit} maxLength={40} onChange={(value) => updateProfile('contact_phone', value)} />
                <TextField label="Website" type="url" value={profile.website ?? ''} disabled={!canEdit} maxLength={255} placeholder="https://" onChange={(value) => updateProfile('website', value)} />
                <TextField label="School address" value={profile.address ?? ''} disabled={!canEdit} maxLength={255} onChange={(value) => updateProfile('address', value)} />
                <TextField label="School timezone" value={profile.timezone} disabled={!canEdit} maxLength={64} placeholder="Africa/Nairobi" onChange={(value) => updateProfile('timezone', value)} />
              </div>
            </Section>
            <Section title="Student identification" detail="Control the student number prefix and generated identifier format.">
              <div className="settings-fields">
                <TextField label="Student ID prefix" value={profile.student_id_prefix ?? ''} disabled={!canEdit} maxLength={10} placeholder="e.g. SCH" onChange={(value) => updateProfile('student_id_prefix', value || null)} />
                <TextField label="Student ID format" value={profile.student_id_format} disabled={!canEdit} maxLength={50} placeholder="{prefix}{sequence:04d}" onChange={(value) => updateProfile('student_id_format', value)} />
              </div>
            </Section>
            {saveButton('profile')}
          </form>}

          {tab === 'academics' && academics && <form className="content-card settings-form" onSubmit={(event) => void saveSection(event, 'academics')}>
            <div className="settings-section-heading"><span className="eyebrow">Academic configuration</span><h2>Grading, calendar & teaching</h2><p>Set school-wide grading rules, academic-year defaults, assessment policies, and reporting.</p></div>
            <Section title="Grading & assessment" detail="Defaults teachers use when creating assessments and recording results.">
              <div className="settings-fields">
                <SelectField label="Grading scale" value={academics.grading_scale} disabled={!canEdit} onChange={(value) => setAcademics({ ...academics, grading_scale: value as SchoolAcademicPolicies['grading_scale'] })} options={[[ 'percentage', 'Percentage'], ['letter', 'Letter grades'], ['gpa', 'GPA'], ['custom', 'Custom']]} />
                <NumberField label="Passing threshold" value={academics.passing_percentage} disabled={!canEdit} min={0} max={100} step={0.5} suffix="%" onChange={(value) => value !== null && setAcademics({ ...academics, passing_percentage: value })} />
                <NumberField label="Distinction threshold" value={academics.distinction_percentage} disabled={!canEdit} min={0} max={100} step={0.5} suffix="%" onChange={(value) => value !== null && setAcademics({ ...academics, distinction_percentage: value })} />
                <NumberField label="Default terms per year" value={academics.default_term_count} disabled={!canEdit} min={1} max={6} onChange={(value) => value !== null && setAcademics({ ...academics, default_term_count: value })} />
                <TextField label="Term name pattern" value={academics.term_naming_convention} disabled={!canEdit} maxLength={50} placeholder="Term {n}" onChange={(value) => setAcademics({ ...academics, term_naming_convention: value })} />
                <SelectField label="Report card frequency" value={academics.report_frequency} disabled={!canEdit} onChange={(value) => setAcademics({ ...academics, report_frequency: value as SchoolAcademicPolicies['report_frequency'] })} options={[[ 'monthly', 'Monthly'], ['termly', 'Termly'], ['semester', 'Each semester'], ['yearly', 'Yearly']]} />
                <TextField label="Report card template" value={academics.report_card_template ?? ''} disabled={!canEdit} maxLength={255} onChange={(value) => setAcademics({ ...academics, report_card_template: value || null })} />
              </div>
              <div className="settings-fields">
                {Object.entries(academics.grade_boundaries).map(([grade, boundary]) => <NumberField key={`grade-${grade}`} label={`${grade} grade boundary`} value={boundary} disabled={!canEdit} min={0} max={100} suffix="%" onChange={(value) => value !== null && setAcademics({ ...academics, grade_boundaries: { ...academics.grade_boundaries, [grade]: value } })} />)}
                {Object.entries(academics.default_assessment_weighting).map(([name, weight]) => <NumberField key={`weight-${name}`} label={`${name.replace(/_/g, ' ')} assessment weight`} value={weight} disabled={!canEdit} min={0} max={100} suffix="%" onChange={(value) => value !== null && setAcademics({ ...academics, default_assessment_weighting: { ...academics.default_assessment_weighting, [name]: value } })} />)}
              </div>
              <Toggle label="Allow assessment retakes" checked={academics.allow_retakes} disabled={!canEdit} onChange={(checked) => setAcademics({ ...academics, allow_retakes: checked })} />
              {academics.allow_retakes && <div className="settings-fields settings-fields-spaced">
                <NumberField label="Maximum retakes" value={academics.max_retakes} disabled={!canEdit} min={0} max={10} onChange={(value) => value !== null && setAcademics({ ...academics, max_retakes: value })} />
                <NumberField label="Retake grade cap" value={academics.retake_grade_cap} disabled={!canEdit} min={0} max={100} suffix="%" onChange={(value) => setAcademics({ ...academics, retake_grade_cap: value })} />
              </div>}
            </Section>
            <Section title="Academic calendar" detail="These values provide defaults when setting up school years and terms.">
              <div className="settings-fields">
                <NumberField label="Academic year starts in month" value={academics.academic_year_start_month} disabled={!canEdit} min={1} max={12} onChange={(value) => value !== null && setAcademics({ ...academics, academic_year_start_month: value })} />
                <NumberField label="Academic year start day" value={academics.academic_year_start_day} disabled={!canEdit} min={1} max={28} onChange={(value) => value !== null && setAcademics({ ...academics, academic_year_start_day: value })} />
              </div>
            </Section>
            <Section title="Promotion & learning policies" detail="Optional thresholds that guide promotion decisions and homework expectations.">
              <div className="settings-fields">
                <NumberField label="Minimum attendance to promote" value={Number(academics.promotion_criteria.min_attendance_percent ?? 85)} disabled={!canEdit} min={0} max={100} suffix="%" onChange={(value) => value !== null && setAcademics({ ...academics, promotion_criteria: { ...academics.promotion_criteria, min_attendance_percent: value } })} />
                <NumberField label="Minimum subjects passed" value={Number(academics.promotion_criteria.min_subjects_passed ?? 5)} disabled={!canEdit} min={0} max={50} onChange={(value) => value !== null && setAcademics({ ...academics, promotion_criteria: { ...academics.promotion_criteria, min_subjects_passed: value } })} />
                <NumberField label="Homework limit per night" value={Number(academics.homework_policy.max_per_night_minutes ?? 120)} disabled={!canEdit} min={0} max={600} suffix="minutes" onChange={(value) => value !== null && setAcademics({ ...academics, homework_policy: { ...academics.homework_policy, max_per_night_minutes: value } })} />
                <NumberField label="Exam reading time" value={Number(academics.exam_policy.reading_time_minutes ?? 10)} disabled={!canEdit} min={0} max={120} suffix="minutes" onChange={(value) => value !== null && setAcademics({ ...academics, exam_policy: { ...academics.exam_policy, reading_time_minutes: value } })} />
              </div>
              <Toggle label="Enable homework" checked={Boolean(academics.homework_policy.enabled ?? true)} disabled={!canEdit} onChange={(checked) => setAcademics({ ...academics, homework_policy: { ...academics.homework_policy, enabled: checked } })} />
              <Toggle label="Allow homework on weekends" checked={Boolean(academics.homework_policy.weekend_allowed ?? true)} disabled={!canEdit} onChange={(checked) => setAcademics({ ...academics, homework_policy: { ...academics.homework_policy, weekend_allowed: checked } })} />
              <Toggle label="Allow calculators in exams by default" checked={Boolean(academics.exam_policy.allow_calculators ?? false)} disabled={!canEdit} onChange={(checked) => setAcademics({ ...academics, exam_policy: { ...academics.exam_policy, allow_calculators: checked } })} />
              {Boolean(academics.exam_policy.allow_calculators) && <div className="settings-feature-grid">{['basic', 'scientific', 'graphing'].map((calculator) => {
                const calculatorTypes = Array.isArray(academics.exam_policy.calculator_types) ? academics.exam_policy.calculator_types as string[] : [];
                return <Toggle key={calculator} label={`${calculator} calculators`} checked={calculatorTypes.includes(calculator)} disabled={!canEdit} onChange={(checked) => setAcademics({ ...academics, exam_policy: { ...academics.exam_policy, calculator_types: checked ? [...calculatorTypes, calculator] : calculatorTypes.filter((item) => item !== calculator) } })} />;
              })}</div>}
            </Section>
            <Section title="Timetable defaults" detail="Default lesson lengths and timetable rotation for new schedules.">
              <div className="settings-fields">
                <SelectField label="Timetable cycle" value={String(academics.timetable_cycle_weeks)} disabled={!canEdit} onChange={(value) => setAcademics({ ...academics, timetable_cycle_weeks: Number(value) as 1 | 2 })} options={[[ '1', '1 week'], ['2', '2 weeks']]} />
                <NumberField label="Lesson duration" value={academics.lesson_duration_minutes} disabled={!canEdit} min={20} max={120} suffix="minutes" onChange={(value) => value !== null && setAcademics({ ...academics, lesson_duration_minutes: value })} />
                <NumberField label="Maximum lessons per day" value={academics.max_lessons_per_day} disabled={!canEdit} min={1} max={15} onChange={(value) => value !== null && setAcademics({ ...academics, max_lessons_per_day: value })} />
              </div>
            </Section>
            {saveButton('academics')}
          </form>}

          {tab === 'attendance' && attendance && <form className="content-card settings-form" onSubmit={(event) => void saveSection(event, 'attendance')}>
            <div className="settings-section-heading"><span className="eyebrow">Attendance operations</span><h2>Attendance policies</h2><p>Set register defaults, attendance goals, alert thresholds, and how attendance is calculated.</p></div>
            <Section title="Register rules" detail="Configure the daily register and attendance-taking expectations.">
              <div className="settings-fields">
                <SelectField label="Default register type" value={attendance.default_session_type} disabled={!canEdit} onChange={(value) => setAttendance({ ...attendance, default_session_type: value as AttendanceSettings['default_session_type'] })} options={[[ 'daily', 'Daily'], ['morning', 'Morning'], ['afternoon', 'Afternoon']]} />
                <TextField label="Late arrival threshold" type="time" value={attendance.late_after?.slice(0, 5) ?? ''} disabled={!canEdit} onChange={(value) => setAttendance({ ...attendance, late_after: value || null })} />
                <SelectField label="Attendance calculation basis" value={attendance.attendance_calculation_basis} disabled={!canEdit} onChange={(value) => setAttendance({ ...attendance, attendance_calculation_basis: value as AttendanceSettings['attendance_calculation_basis'] })} options={[[ 'daily', 'Daily registers'], ['lesson', 'Individual lessons']]} />
                <NumberField label="Late arrival becomes absence after" value={attendance.late_to_absence_after_minutes} disabled={!canEdit} min={30} max={360} suffix="minutes (optional)" onChange={(value) => setAttendance({ ...attendance, late_to_absence_after_minutes: value })} />
                <NumberField label="Auto-lock register after" value={attendance.auto_lock_after_days} disabled={!canEdit} min={1} max={90} suffix="days (optional)" onChange={(value) => setAttendance({ ...attendance, auto_lock_after_days: value })} />
              </div>
              <Toggle label="Require completed registers" detail="Require all students to have an attendance status before submission." checked={attendance.require_complete_register} disabled={!canEdit} onChange={(checked) => setAttendance({ ...attendance, require_complete_register: checked })} />
              <Toggle label="Count excused absences as present" checked={attendance.excused_counts_as_present} disabled={!canEdit} onChange={(checked) => setAttendance({ ...attendance, excused_counts_as_present: checked })} />
              <Toggle label="Allow parent absence explanations" checked={attendance.allow_parent_explanations} disabled={!canEdit} onChange={(checked) => setAttendance({ ...attendance, allow_parent_explanations: checked })} />
            </Section>
            <Section title="Targets & follow-up" detail="Thresholds used to surface attendance concerns and create follow-up tasks.">
              <div className="settings-fields">
                <NumberField label="Attendance target" value={attendance.attendance_target_percent} disabled={!canEdit} min={0} max={100} step={0.5} suffix="%" onChange={(value) => value !== null && setAttendance({ ...attendance, attendance_target_percent: value })} />
                <NumberField label="Warning threshold" value={attendance.attendance_warning_percent} disabled={!canEdit} min={0} max={attendance.attendance_target_percent} step={0.5} suffix="%" onChange={(value) => value !== null && setAttendance({ ...attendance, attendance_warning_percent: value })} />
                <NumberField label="Repeated absences before follow-up" value={attendance.repeated_absence_threshold} disabled={!canEdit} min={2} max={30} onChange={(value) => value !== null && setAttendance({ ...attendance, repeated_absence_threshold: value })} />
                <NumberField label="Consecutive absences before follow-up" value={attendance.consecutive_absence_threshold} disabled={!canEdit} min={2} max={30} onChange={(value) => value !== null && setAttendance({ ...attendance, consecutive_absence_threshold: value })} />
              </div>
              <Toggle label="Notify families about absences" checked={attendance.notify_on_absence} disabled={!canEdit} onChange={(checked) => setAttendance({ ...attendance, notify_on_absence: checked })} />
              <Toggle label="Notify families about late arrivals" checked={attendance.notify_on_late} disabled={!canEdit} onChange={(checked) => setAttendance({ ...attendance, notify_on_late: checked })} />
            </Section>
            <Section title="Attendance statuses" detail="Choose which statuses staff can use and whether each one counts toward attendance.">
              <div className="settings-status-list">{attendanceStatuses.map((status, index) => <div className="settings-status-row" key={status.status}>
                <label className="settings-status-label"><span>{status.status.replace(/_/g, ' ')}</span><input required minLength={2} value={status.label} disabled={!canEdit} maxLength={30} onChange={(event) => setAttendanceStatuses((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))} /></label>
                <Toggle label="Enabled" checked={status.enabled} disabled={!canEdit} onChange={(checked) => setAttendanceStatuses((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, enabled: checked } : item))} />
                <Toggle label="Counts as present" checked={status.counts_as_present} disabled={!canEdit} onChange={(checked) => setAttendanceStatuses((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, counts_as_present: checked } : item))} />
              </div>)}</div>
            </Section>
            {saveButton('attendance')}
          </form>}

          {tab === 'portals' && communication && <form className="content-card settings-form" onSubmit={(event) => void saveSection(event, 'portals')}>
            <div className="settings-section-heading"><span className="eyebrow">School communications</span><h2>Portals & notifications</h2><p>Manage family and student access, delivery channels, and notification preferences.</p></div>
            <Section title="Parent portal" detail="Enable the family experience and select the information parents can access.">
              <Toggle label="Enable parent portal" checked={communication.parent_portal_enabled} disabled={!canEdit} onChange={(checked) => setCommunication({ ...communication, parent_portal_enabled: checked })} />
              <div className="settings-feature-grid">{Object.entries(communication.parent_portal_features).map(([key, checked]) => <Toggle key={key} label={key.replace(/_/g, ' ')} checked={Boolean(checked)} disabled={!canEdit || !communication.parent_portal_enabled} onChange={(value) => setCommunication({ ...communication, parent_portal_features: { ...communication.parent_portal_features, [key]: value } })} />)}</div>
            </Section>
            <Section title="Student portal" detail="Choose what students can view and do in their portal.">
              <Toggle label="Enable student portal" checked={communication.student_portal_enabled} disabled={!canEdit} onChange={(checked) => setCommunication({ ...communication, student_portal_enabled: checked })} />
              <div className="settings-feature-grid">{Object.entries(communication.student_portal_features).map(([key, checked]) => <Toggle key={key} label={key.replace(/_/g, ' ')} checked={Boolean(checked)} disabled={!canEdit || !communication.student_portal_enabled} onChange={(value) => setCommunication({ ...communication, student_portal_features: { ...communication.student_portal_features, [key]: value } })} />)}</div>
            </Section>
            <Section title="Email identity" detail="Customize the sender details and footer used in school emails.">
              <div className="settings-fields">
                <TextField label="Sender name" value={communication.email_from_name} disabled={!canEdit} maxLength={100} onChange={(value) => setCommunication({ ...communication, email_from_name: value })} />
                <TextField label="Sender email address" type="email" value={communication.email_from_address ?? ''} disabled={!canEdit} onChange={(value) => setCommunication({ ...communication, email_from_address: value || null })} />
                <TextField label="Reply-to email address" type="email" value={communication.email_reply_to ?? ''} disabled={!canEdit} onChange={(value) => setCommunication({ ...communication, email_reply_to: value || null })} />
                <NumberField label="Notification retention" value={communication.notification_retention_days} disabled={!canEdit} min={7} max={365} suffix="days" onChange={(value) => value !== null && setCommunication({ ...communication, notification_retention_days: value })} />
              </div>
              <label className="field"><span>Email footer</span><textarea rows={3} maxLength={1000} disabled={!canEdit} value={communication.email_footer ?? ''} onChange={(event) => setCommunication({ ...communication, email_footer: event.target.value || null })} /></label>
            </Section>
            <Section title="Delivery channels & notification categories" detail="Configure optional delivery channels and the types of updates families receive.">
              <Toggle label="Enable SMS notifications" checked={communication.sms_enabled} disabled={!canEdit} onChange={(checked) => setCommunication({ ...communication, sms_enabled: checked })} />
              {communication.sms_enabled && <div className="settings-fields settings-fields-spaced">
                <SelectField label="SMS provider" value={communication.sms_provider ?? ''} disabled={!canEdit} onChange={(value) => setCommunication({ ...communication, sms_provider: value || null })} options={[[ '', 'Select provider'], ['twilio', 'Twilio'], ['vonage', 'Vonage'], ['plivo', 'Plivo'], ['custom', 'Custom']]} />
                <TextField label="SMS sender number" type="tel" value={communication.sms_from_number ?? ''} disabled={!canEdit} onChange={(value) => setCommunication({ ...communication, sms_from_number: value || null })} />
              </div>}
              <Toggle label="Enable push notifications" checked={communication.push_enabled} disabled={!canEdit} onChange={(checked) => setCommunication({ ...communication, push_enabled: checked })} />
              <div className="settings-feature-grid">{Object.entries(communication.notification_categories).map(([key, checked]) => <Toggle key={key} label={key.replace(/_/g, ' ')} checked={Boolean(checked)} disabled={!canEdit} onChange={(value) => setCommunication({ ...communication, notification_categories: { ...communication.notification_categories, [key]: value } })} />)}</div>
            </Section>
            {saveButton('portals')}
          </form>}

          {tab === 'modules' && modules && <form className="content-card settings-form" onSubmit={(event) => void saveSection(event, 'modules')}>
            <div className="settings-section-heading"><span className="eyebrow">Workspace configuration</span><h2>Modules & feature controls</h2><p>Enable the school services, teaching workflows, and optional capabilities your community uses.</p></div>
            {moduleGroups.map((group) => <Section key={group.title} title={group.title} detail={group.description}>
              <div className="settings-feature-grid">{group.options.map(([key, label]) => <Toggle key={key} label={label} checked={Boolean(modules[key])} disabled={!canEdit} onChange={(checked) => setModules({ ...modules, [key]: checked })} />)}</div>
            </Section>)}
            <Section title="Feature-level controls" detail="Fine-tune features within the enabled modules.">
              <div className="settings-feature-grid">{([
                ['attendance_lesson_registers', 'Lesson attendance registers'], ['attendance_auto_generation', 'Automatic attendance registers'],
                ['attendance_parent_notifications', 'Attendance notifications to families'], ['timetable_auto_generation', 'Automatic timetable generation'],
                ['timetable_bell_schedules', 'Bell schedules'], ['learning_question_library', 'Question library'],
                ['learning_past_papers', 'Past papers in learning'], ['learning_ai_generation', 'AI learning content generation'],
                ['assignments_online_submission', 'Online assignment submissions'], ['assignments_plagiarism_check', 'Assignment plagiarism checks'],
                ['announcements_email_digest', 'Announcement email digests'], ['events_rsvp', 'Event RSVPs'],
                ['messaging_threads', 'Message threads'], ['messaging_attachments', 'Message attachments'],
                ['directory_parent_access', 'Family directory access'], ['calendar_academic', 'Academic calendar'],
                ['calendar_personal', 'Personal calendars'], ['reports_scheduled', 'Scheduled reports'],
                ['reports_custom', 'Custom reports'],
              ] as [keyof SchoolModuleSettings, string][]).map(([key, label]) => <Toggle key={key} label={label} checked={Boolean(modules[key])} disabled={!canEdit} onChange={(checked) => setModules({ ...modules, [key]: checked })} />)}</div>
            </Section>
            {saveButton('modules')}
          </form>}

          {tab === 'security' && security && <form className="content-card settings-form" onSubmit={(event) => void saveSection(event, 'security')}>
            <div className="settings-section-heading"><span className="eyebrow">Protection & governance</span><h2>Security & privacy</h2><p>Set account security standards and school-wide data handling defaults.</p></div>
            <Section title="Account protection" detail="Session timeouts, password requirements, and account lockout rules.">
              <div className="settings-fields">
                <NumberField label="Session timeout" value={security.session_timeout_minutes} disabled={!canEdit} min={15} max={10080} suffix="minutes" onChange={(value) => value !== null && setSecurity({ ...security, session_timeout_minutes: value })} />
                <NumberField label="Minimum password length" value={security.password_min_length} disabled={!canEdit} min={6} max={64} suffix="characters" onChange={(value) => value !== null && setSecurity({ ...security, password_min_length: value })} />
                <NumberField label="Password expiry" value={security.password_max_age_days} disabled={!canEdit} min={30} max={365} suffix="days (optional)" onChange={(value) => setSecurity({ ...security, password_max_age_days: value })} />
                <NumberField label="Password history" value={security.password_history_count} disabled={!canEdit} min={0} max={24} suffix="previous passwords" onChange={(value) => value !== null && setSecurity({ ...security, password_history_count: value })} />
                <NumberField label="Failed sign-ins before lockout" value={security.lockout_after_failed_attempts} disabled={!canEdit} min={3} max={20} onChange={(value) => value !== null && setSecurity({ ...security, lockout_after_failed_attempts: value })} />
                <NumberField label="Account lockout duration" value={security.lockout_duration_minutes} disabled={!canEdit} min={5} max={1440} suffix="minutes" onChange={(value) => value !== null && setSecurity({ ...security, lockout_duration_minutes: value })} />
              </div>
              <div className="settings-feature-grid">
                <Toggle label="Require multi-factor authentication" checked={security.require_mfa} disabled={!canEdit} onChange={(checked) => setSecurity({ ...security, require_mfa: checked })} />
                <Toggle label="Require uppercase letters" checked={security.password_require_uppercase} disabled={!canEdit} onChange={(checked) => setSecurity({ ...security, password_require_uppercase: checked })} />
                <Toggle label="Require lowercase letters" checked={security.password_require_lowercase} disabled={!canEdit} onChange={(checked) => setSecurity({ ...security, password_require_lowercase: checked })} />
                <Toggle label="Require numbers" checked={security.password_require_numbers} disabled={!canEdit} onChange={(checked) => setSecurity({ ...security, password_require_numbers: checked })} />
                <Toggle label="Require symbols" checked={security.password_require_symbols} disabled={!canEdit} onChange={(checked) => setSecurity({ ...security, password_require_symbols: checked })} />
              </div>
              {security.require_mfa && <div className="settings-feature-grid">{(['totp', 'sms', 'email', 'webauthn'] as const).map((method) => <Toggle key={method} label={`Allow ${method.toUpperCase()}`} checked={security.mfa_methods.includes(method)} disabled={!canEdit} onChange={(checked) => setSecurity({ ...security, mfa_methods: checked ? [...security.mfa_methods, method] : security.mfa_methods.filter((item) => item !== method) })} />)}</div>}
            </Section>
            <Section title="Privacy & data lifecycle" detail="Set data retention, exports, graduation anonymization, and privacy mode.">
              <div className="settings-fields">
                <NumberField label="Data retention period" value={security.data_retention_years} disabled={!canEdit} min={1} max={20} suffix="years" onChange={(value) => value !== null && setSecurity({ ...security, data_retention_years: value })} />
                <NumberField label="Audit log retention" value={security.audit_log_retention_days} disabled={!canEdit} min={30} max={2555} suffix="days" onChange={(value) => value !== null && setSecurity({ ...security, audit_log_retention_days: value })} />
              </div>
              <Toggle label="Anonymize student data on graduation" checked={security.anonymize_on_graduation} disabled={!canEdit} onChange={(checked) => setSecurity({ ...security, anonymize_on_graduation: checked })} />
              <Toggle label="Allow school data exports" checked={security.allow_data_export} disabled={!canEdit} onChange={(checked) => setSecurity({ ...security, allow_data_export: checked })} />
              <Toggle label="Enable GDPR compliance mode" checked={security.gdpr_compliance_mode} disabled={!canEdit} onChange={(checked) => setSecurity({ ...security, gdpr_compliance_mode: checked })} />
              <div className="settings-subheading settings-audit-heading"><h3>Audit sensitive actions</h3><p>Choose which sensitive activity types should be included in the school audit record.</p></div>
              <div className="settings-feature-grid">{(['login', 'password_change', 'role_change', 'data_export', 'bulk_delete'] as const).map((action) => <Toggle key={action} label={action.replace(/_/g, ' ')} checked={security.audit_sensitive_actions.includes(action)} disabled={!canEdit} onChange={(checked) => setSecurity({ ...security, audit_sensitive_actions: checked ? [...security.audit_sensitive_actions, action] : security.audit_sensitive_actions.filter((item) => item !== action) })} />)}</div>
              <label className="field settings-array-field"><span>Allowed IP ranges (one per line; optional)</span><textarea rows={3} disabled={!canEdit} value={security.allowed_ip_ranges.join('\n')} placeholder="203.0.113.0/24" onChange={(event) => setSecurity({ ...security, allowed_ip_ranges: event.target.value.split('\n').map((value) => value.trim()).filter(Boolean) })} /><small>Restricting IP ranges can lock out staff. Review entries carefully before saving.</small></label>
            </Section>
            {saveButton('security')}
          </form>}

        </div>
      </div>
    </div>
  );
}
