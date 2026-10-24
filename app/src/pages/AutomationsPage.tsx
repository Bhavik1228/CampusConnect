import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  BellRing, CalendarClock, Check, CircleAlert, Copy, FlaskConical, Pencil,
  History, Megaphone, Pause, Play, Plus, Search, Sparkles, Trash2, Workflow,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';
import type { AppRole } from '../types/database';

type Category = 'academics' | 'attendance' | 'assignments' | 'finance' | 'communication' | 'health' | 'library' | 'events' | 'administration' | 'other';
type AutomationStatus = 'draft' | 'active' | 'paused' | 'failed' | 'disabled';
type ActionType = 'notification' | 'announcement';
type WorkflowTab = 'automations' | 'templates' | 'history';
type TriggerType = 'schedule' | 'record_created' | 'record_updated' | 'status_changed' | 'date_reached' | 'attendance_event' | 'assignment_deadline' | 'assessment_event' | 'fee_event' | 'admission_event' | 'staff_student_event';
type TriggerConfig = {
  frequency?: 'daily' | 'weekly' | 'monthly';
  time?: string;
  weekday?: number;
  day_of_month?: number;
  source_table?: string;
  source?: string;
  event?: string;
  status?: string;
  threshold?: number;
  window_days?: number;
};
type Automation = {
  id: string;
  school_id: string;
  name: string;
  description: string;
  category: Category;
  status: AutomationStatus;
  trigger_type: TriggerType;
  trigger_config: TriggerConfig;
  conditions: { weekdays_only?: boolean };
  action_type: ActionType;
  action_config: {
    title: string;
    body: string;
    recipient_roles?: AppRole[];
    target_path?: string;
    audience?: 'school' | 'staff' | 'students' | 'parents';
  };
  owner_id: string;
  permitted_user_ids: string[];
  permitted_roles: AppRole[];
  created_by: string;
  estimated_minutes_saved: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
};
type Member = { profile_id: string; role: AppRole; profile: { full_name: string; email: string | null } | null };
type Run = {
  id: string;
  automation_id: string;
  status: 'successful' | 'skipped' | 'failed';
  is_test: boolean;
  started_at: string;
  completed_at: string | null;
  summary: string;
  error_message: string | null;
  automation_name: string;
};
type WorkflowForm = Omit<Automation, 'id' | 'school_id' | 'created_at' | 'updated_at' | 'last_run_at' | 'next_run_at'>;

const roleOptions: { value: AppRole; label: string }[] = [
  { value: 'school_admin', label: 'School administrator' },
  { value: 'academic_coordinator', label: 'Academic coordinator' },
  { value: 'teacher', label: 'Teacher' },
  { value: 'student', label: 'Student' },
  { value: 'parent', label: 'Parent' },
  { value: 'finance_manager', label: 'Finance manager' },
  { value: 'accountant', label: 'Accountant' },
  { value: 'bursar', label: 'Bursar' },
  { value: 'cashier', label: 'Cashier' },
  { value: 'accounts_payable_officer', label: 'Accounts payable officer' },
  { value: 'auditor', label: 'Auditor / read-only reviewer' },
  { value: 'librarian', label: 'Librarian' },
  { value: 'website_editor', label: 'Website editor' },
  { value: 'website_publisher', label: 'Website publisher' },
  { value: 'admissions_officer', label: 'Admissions officer' },
  { value: 'hr_staff_administrator', label: 'HR / staff administrator' },
  { value: 'transport_manager', label: 'Transport manager' },
  { value: 'facilities_manager', label: 'Facilities manager' },
  { value: 'it_support_technician', label: 'IT support technician' },
  { value: 'safeguarding_officer', label: 'Safeguarding officer' },
  { value: 'procurement_officer', label: 'Procurement officer' },
  { value: 'compliance_audit_officer', label: 'Compliance / audit officer' },
  { value: 'nurse', label: 'School nurse' },
  { value: 'doctor', label: 'School doctor' },
  { value: 'secretary', label: 'Secretary' },
];
const categoryOptions: { value: Category; label: string }[] = [
  { value: 'academics', label: 'Academics' },
  { value: 'attendance', label: 'Attendance' },
  { value: 'assignments', label: 'Assignments' },
  { value: 'finance', label: 'Finance' },
  { value: 'communication', label: 'Communication' },
  { value: 'health', label: 'Health' },
  { value: 'library', label: 'Library' },
  { value: 'events', label: 'Events' },
  { value: 'administration', label: 'Administration' },
  { value: 'other', label: 'Other' },
];
const weekdays = [
  { value: 0, label: 'Sunday' }, { value: 1, label: 'Monday' }, { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' }, { value: 4, label: 'Thursday' }, { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
];
const triggerOptions: { value: TriggerType; label: string }[] = [
  { value: 'schedule', label: 'Scheduled time' },
  { value: 'record_created', label: 'Record created' },
  { value: 'record_updated', label: 'Record updated' },
  { value: 'status_changed', label: 'Status changed' },
  { value: 'date_reached', label: 'Date reached' },
  { value: 'attendance_event', label: 'Attendance event' },
  { value: 'assignment_deadline', label: 'Assignment deadline' },
  { value: 'assessment_event', label: 'Assessment event' },
  { value: 'fee_event', label: 'Fee event' },
  { value: 'admission_event', label: 'Admission event' },
  { value: 'staff_student_event', label: 'Staff or student event' },
];
const recordSources = [
  { value: 'students', label: 'Students' },
  { value: 'staff_profiles', label: 'Staff profiles' },
  { value: 'assignments', label: 'Assignments' },
  { value: 'assignment_submissions', label: 'Assignment submissions' },
  { value: 'attendance_records', label: 'Attendance records' },
  { value: 'exam_results', label: 'Exam results' },
  { value: 'learning_assessment_results', label: 'Learning assessment results' },
  { value: 'student_fee_invoices', label: 'Fee invoices' },
  { value: 'admission_applications', label: 'Admission applications' },
];
const statusSources = recordSources.filter((source) => source.value !== 'exam_results');
const statusLabels: Record<AutomationStatus, string> = {
  draft: 'Draft', active: 'Active', paused: 'Paused', failed: 'Failed', disabled: 'Disabled',
};
const templateItems: {
  id: string; name: string; description: string; category: Category;
  frequency: 'daily' | 'weekly'; time: string; weekday?: number;
  actionType: ActionType; actionConfig: WorkflowForm['action_config'];
  weekdaysOnly: boolean;
}[] = [
  {
    id: 'morning-staff-briefing',
    name: 'Morning staff briefing',
    description: 'Send a short daily reminder to school leaders and teachers.',
    category: 'communication',
    frequency: 'daily',
    time: '07:30',
    actionType: 'notification',
    actionConfig: {
      title: 'Good morning, {school_name}',
      body: 'Please review today’s school schedule and priorities. ({date})',
      recipient_roles: ['school_admin', 'academic_coordinator', 'teacher'],
      target_path: '/dashboard',
    },
    weekdaysOnly: true,
  },
  {
    id: 'weekly-family-update',
    name: 'Weekly family update',
    description: 'Publish a scheduled weekly reminder for parents.',
    category: 'communication',
    frequency: 'weekly',
    time: '15:00',
    weekday: 5,
    actionType: 'announcement',
    actionConfig: {
      title: 'Weekly update from {school_name}',
      body: 'Please check the school calendar and your student’s assignments for the coming week.',
      audience: 'parents',
    },
    weekdaysOnly: false,
  },
  {
    id: 'weekly-teaching-check-in',
    name: 'Weekly teaching check-in',
    description: 'Remind teaching staff to review attendance and pending assignments.',
    category: 'academics',
    frequency: 'weekly',
    time: '15:30',
    weekday: 5,
    actionType: 'notification',
    actionConfig: {
      title: 'Weekly teaching check-in',
      body: 'Review this week’s attendance registers and follow up on pending assignments.',
      recipient_roles: ['teacher', 'academic_coordinator'],
      target_path: '/attendance',
    },
    weekdaysOnly: false,
  },
  {
    id: 'daily-admin-priorities',
    name: 'Daily administration priorities',
    description: 'Give school administrators a daily in-app reminder to review school operations.',
    category: 'administration',
    frequency: 'daily',
    time: '08:00',
    actionType: 'notification',
    actionConfig: {
      title: 'Daily school operations',
      body: 'Review attendance follow-ups, upcoming events, and outstanding school tasks.',
      recipient_roles: ['school_admin'],
      target_path: '/dashboard',
    },
    weekdaysOnly: true,
  },
];

function newForm(ownerId: string): WorkflowForm {
  return {
    name: '',
    description: '',
    category: 'administration',
    status: 'draft',
    trigger_type: 'schedule',
    trigger_config: { frequency: 'daily', time: '08:00' },
    conditions: { weekdays_only: false },
    action_type: 'notification',
    action_config: {
      title: '',
      body: '',
      recipient_roles: ['school_admin'],
      target_path: '/dashboard',
    },
    owner_id: ownerId,
    permitted_user_ids: [],
    permitted_roles: [],
    created_by: ownerId,
    estimated_minutes_saved: 5,
  };
}

function formatDate(value: string | null, timeZone: string) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(value)) : 'Never';
}

function triggerDescription(automation: Automation) {
  const { trigger_type: type, trigger_config: config } = automation;
  if (type === 'schedule') {
    if (config.frequency === 'weekly') return `Weekly · ${weekdays.find((day) => day.value === config.weekday)?.label ?? 'Day not set'} at ${config.time}`;
    if (config.frequency === 'monthly') return `Monthly · day ${config.day_of_month ?? 'not set'} at ${config.time}`;
    return `Daily at ${config.time}`;
  }
  if (type === 'record_created' || type === 'record_updated' || type === 'status_changed') {
    return `${triggerOptions.find((item) => item.value === type)?.label} · ${recordSources.find((item) => item.value === config.source_table)?.label ?? 'Record'}`;
  }
  const eventLabels: Record<string, string> = {
    assignment_deadline: 'Assignment deadline',
    exam_date: 'Exam date',
    invoice_due_date: 'Fee invoice due date',
    recorded: 'Attendance recorded',
    absence_threshold: `${config.threshold ?? 3} absences in ${config.window_days ?? 7} days`,
    marks_submitted: 'Marks submitted',
    assessment_published: 'Assessment completed (results published)',
    submission_graded: 'Assignment submission graded',
    payment_recorded: 'Fee payment recorded',
    invoice_overdue: 'Invoice overdue',
    submitted: 'Admission submitted',
    student_created: 'Student profile created',
    student_status_changed: 'Student status changed',
    student_enrolled: 'Student enrolled in a class',
    staff_created: 'Staff profile created',
    staff_status_changed: 'Staff employment status changed',
  };
  if (type === 'date_reached') return eventLabels[config.source ?? ''] ?? 'Date reached';
  if (type === 'assignment_deadline') return eventLabels.assignment_deadline;
  return `${triggerOptions.find((item) => item.value === type)?.label} · ${eventLabels[config.event ?? ''] ?? ''}`.trim();
}

function sameTriggerConfig(left: TriggerConfig, right: TriggerConfig) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)] as (keyof TriggerConfig)[]);
  return [...keys].every((key) => left[key] === right[key]);
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function AutomationsPage() {
  const { activeMembership, user } = useAuth();
  const schoolId = activeMembership?.school_id;
  const currentRole = activeMembership?.role;
  const userId = user?.id ?? '';
  const isManager = currentRole === 'school_admin' || currentRole === 'academic_coordinator';
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [tab, setTab] = useState<WorkflowTab>('automations');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<AutomationStatus | 'all'>('all');
  const [categoryFilter, setCategoryFilter] = useState<Category | 'all'>('all');
  const [editingId, setEditingId] = useState('');
  const [form, setForm] = useState<WorkflowForm>(() => newForm(userId));
  const [showForm, setShowForm] = useState(false);
  const [actingId, setActingId] = useState('');

  const load = useCallback(async () => {
    if (!schoolId) return;
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [automationResult, runResult, memberResult] = await Promise.all([
        client.from('school_automations').select('*').eq('school_id', schoolId).order('updated_at', { ascending: false }),
        client.from('school_automation_runs')
          .select('id,automation_id,status,is_test,started_at,completed_at,summary,error_message')
          .eq('school_id', schoolId).order('started_at', { ascending: false }).limit(250),
        client.from('school_memberships')
          .select('profile_id,role,profile:profiles(full_name,email)')
          .eq('school_id', schoolId).order('created_at'),
      ]);
      for (const result of [automationResult, runResult, memberResult]) {
        if (result.error) throw result.error;
      }
      const loadedAutomations = (automationResult.data ?? []) as Automation[];
      const automationNames = new Map(loadedAutomations.map((automation) => [automation.id, automation.name]));
      setAutomations(loadedAutomations);
      setRuns(((runResult.data ?? []) as Omit<Run, 'automation_name'>[]).map((run) => ({
        ...run,
        automation_name: automationNames.get(run.automation_id) ?? 'Deleted automation',
      })));
      setMembers((memberResult.data ?? []) as unknown as Member[]);
    } catch (loadError) {
      setError(errorText(loadError, 'Could not load school automations.'));
    } finally {
      setLoading(false);
    }
  }, [schoolId]);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return automations.filter((automation) => (
      (statusFilter === 'all' || automation.status === statusFilter)
      && (categoryFilter === 'all' || automation.category === categoryFilter)
      && (!needle || `${automation.name} ${automation.description} ${automation.category}`.toLowerCase().includes(needle))
    ));
  }, [automations, search, statusFilter, categoryFilter]);

  const todayRuns = useMemo(() => {
    const timeZone = activeMembership?.school.timezone ?? 'UTC';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
    return runs.filter((run) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(run.started_at)) === today);
  }, [runs, activeMembership?.school.timezone]);
  const needsAttention = automations.filter((automation) => automation.status === 'failed').length;
  const savedMinutes = todayRuns
    .filter((run) => run.status === 'successful' && !run.is_test)
    .reduce((total, run) => total + (automations.find((item) => item.id === run.automation_id)?.estimated_minutes_saved ?? 0), 0);

  function startCreate() {
    setEditingId('');
    setForm(newForm(userId));
    setShowForm(true);
    setError('');
    setSuccess('');
  }

  function startEdit(automation: Automation) {
    setEditingId(automation.id);
    setForm({
      name: automation.name,
      description: automation.description,
      category: automation.category,
      status: automation.status,
      trigger_type: automation.trigger_type,
      trigger_config: automation.trigger_config,
      conditions: automation.conditions,
      action_type: automation.action_type,
      action_config: automation.action_config,
      owner_id: automation.owner_id,
      permitted_user_ids: automation.permitted_user_ids,
      permitted_roles: automation.permitted_roles,
      created_by: automation.created_by,
      estimated_minutes_saved: automation.estimated_minutes_saved,
    });
    setShowForm(true);
    setError('');
    setSuccess('');
  }

  function useTemplate(template: typeof templateItems[number]) {
    const draft = newForm(userId);
    setForm({
      ...draft,
      name: template.name,
      description: template.description,
      category: template.category,
      trigger_config: {
        frequency: template.frequency,
        time: template.time,
        ...(template.weekday === undefined ? {} : { weekday: template.weekday }),
      },
      conditions: { weekdays_only: template.weekdaysOnly },
      action_type: template.actionType,
      action_config: template.actionConfig,
    });
    setEditingId('');
    setShowForm(true);
    setTab('automations');
    setError('');
    setSuccess(`“${template.name}” template loaded. Review and save it to create your automation.`);
  }

  function validateForm() {
    if (form.name.trim().length < 2 || form.name.trim().length > 120) return 'Name must be between 2 and 120 characters.';
    if (form.description.length > 1000) return 'Description must be 1,000 characters or fewer.';
    if (!form.owner_id) return 'Choose an automation owner.';
    if (!members.some((member) => member.profile_id === form.owner_id)) return 'The owner must be a member of this school.';
    if (form.trigger_type === 'schedule') {
      if (!form.trigger_config.frequency || !['daily', 'weekly', 'monthly'].includes(form.trigger_config.frequency)) return 'Choose a supported schedule frequency.';
      if (form.trigger_config.frequency === 'weekly' && form.trigger_config.weekday === undefined) return 'Choose a day of the week.';
      if (form.trigger_config.frequency === 'monthly' && !form.trigger_config.day_of_month) return 'Choose a day of the month.';
      if (!form.trigger_config.time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(form.trigger_config.time)) return 'Choose a valid scheduled time.';
    } else if (['record_created', 'record_updated', 'status_changed'].includes(form.trigger_type)) {
      const sources = form.trigger_type === 'status_changed' ? statusSources : recordSources;
      if (!sources.some((source) => source.value === form.trigger_config.source_table)) return 'Choose a supported record type.';
    } else if (form.trigger_type === 'date_reached' && !['assignment_deadline', 'exam_date', 'invoice_due_date'].includes(form.trigger_config.source ?? '')) {
      return 'Choose a supported date source.';
    } else if (form.trigger_type === 'attendance_event') {
      if (!['recorded', 'absence_threshold'].includes(form.trigger_config.event ?? '')) return 'Choose a supported attendance event.';
      if (form.trigger_config.event === 'absence_threshold' && (!form.trigger_config.threshold || form.trigger_config.threshold < 1 || form.trigger_config.threshold > 30 || !form.trigger_config.window_days || form.trigger_config.window_days < 1 || form.trigger_config.window_days > 90)) return 'Set an absence threshold from 1–30 and a window from 1–90 days.';
    } else if (form.trigger_type === 'assessment_event' && !['marks_submitted', 'assessment_published', 'submission_graded'].includes(form.trigger_config.event ?? '')) {
      return 'Choose a supported assessment event.';
    } else if (form.trigger_type === 'fee_event' && !['payment_recorded', 'invoice_overdue'].includes(form.trigger_config.event ?? '')) {
      return 'Choose a supported fee event.';
    } else if (form.trigger_type === 'admission_event' && !['submitted', 'status_changed'].includes(form.trigger_config.event ?? '')) {
      return 'Choose a supported admission event.';
    } else if (form.trigger_type === 'staff_student_event' && !['student_created', 'student_status_changed', 'staff_created', 'staff_status_changed'].includes(form.trigger_config.event ?? '')) {
      return 'Choose a supported staff or student event.';
    }
    if (form.estimated_minutes_saved < 1 || form.estimated_minutes_saved > 240) return 'Time saved must be between 1 and 240 minutes per run.';
    if (form.action_config.title.trim().length < 2 || form.action_config.title.length > 160) return 'Action title must be between 2 and 160 characters.';
    if (form.action_config.body.trim().length < 3 || form.action_config.body.length > 5000) return 'Action message must be between 3 and 5,000 characters.';
    if (form.action_type === 'notification') {
      if (!form.action_config.recipient_roles?.length) return 'Choose at least one notification recipient role.';
      if (form.action_config.target_path && (!form.action_config.target_path.startsWith('/') || form.action_config.target_path.startsWith('//'))) {
        return 'Notification destination must be a safe, in-app path beginning with a single slash.';
      }
    }
    if (form.action_type === 'announcement' && !form.action_config.audience) return 'Choose an announcement audience.';
    if (form.permitted_user_ids.some((id) => !members.some((member) => member.profile_id === id))) return 'Permitted users must be members of this school.';
    return '';
  }

  function matchingAutomation() {
    return automations.find((item) => item.id !== editingId
      && item.status === 'active'
      && item.trigger_type === form.trigger_type
      && sameTriggerConfig(item.trigger_config, form.trigger_config)
      && item.action_type === form.action_type
      && JSON.stringify(item.action_config) === JSON.stringify(form.action_config));
  }

  async function saveAutomation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const problem = validateForm();
    if (problem) { setError(problem); return; }
    const conflict = form.status === 'active' ? matchingAutomation() : undefined;
    if (conflict && !window.confirm(`“${conflict.name}” is already active with the same schedule and action. Activate this possible duplicate anyway?`)) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const client = requireSupabase();
      const payload = {
        ...form,
        name: form.name.trim(),
        description: form.description.trim(),
        trigger_config: form.trigger_config,
      };
      const result = editingId
        ? await client.from('school_automations').update(payload).eq('id', editingId).eq('school_id', schoolId)
        : await client.from('school_automations').insert({ ...payload, school_id: schoolId });
      if (result.error) throw result.error;
      setShowForm(false);
      setSuccess(editingId ? 'Automation updated.' : 'Automation created.');
      await load();
    } catch (saveError) {
      setError(errorText(saveError, 'Could not save the automation.'));
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(automation: Automation, nextStatus: AutomationStatus) {
    if (nextStatus === 'active') {
      const problem = validateAutomation(automation);
      if (problem) { setError(problem); return; }
      const conflict = automations.find((item) => item.id !== automation.id && item.status === 'active'
        && item.trigger_type === automation.trigger_type
      && sameTriggerConfig(item.trigger_config, automation.trigger_config)
        && item.action_type === automation.action_type
        && JSON.stringify(item.action_config) === JSON.stringify(automation.action_config));
      if (conflict && !window.confirm(`“${conflict.name}” may do the same work at the same time. Resume this workflow anyway?`)) return;
    }
    setActingId(automation.id);
    setError('');
    try {
      const { error: updateError } = await requireSupabase().from('school_automations')
        .update({ status: nextStatus }).eq('id', automation.id).eq('school_id', schoolId);
      if (updateError) throw updateError;
      setSuccess(`Automation ${statusLabels[nextStatus].toLowerCase()}.`);
      await load();
    } catch (statusError) {
      setError(errorText(statusError, 'Could not update automation status.'));
    } finally {
      setActingId('');
    }
  }

  function validateAutomation(automation: Automation) {
    if (automation.name.trim().length < 2) return 'Add a name before activating this automation.';
    if (automation.trigger_type === 'schedule') {
      if (!automation.trigger_config.time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(automation.trigger_config.time)) return 'Set a valid schedule before activating.';
      if (automation.trigger_config.frequency === 'weekly' && automation.trigger_config.weekday === undefined) return 'Choose a schedule day before activating.';
      if (automation.trigger_config.frequency === 'monthly' && !automation.trigger_config.day_of_month) return 'Choose a schedule day of the month before activating.';
    }
    if (automation.action_config.title.trim().length < 2 || automation.action_config.body.trim().length < 3) return 'Complete the action title and message before activating.';
    if (automation.action_type === 'notification' && !automation.action_config.recipient_roles?.length) return 'Choose notification recipient roles before activating.';
    if (automation.action_type === 'announcement' && !automation.action_config.audience) return 'Choose an announcement audience before activating.';
    return '';
  }

  async function runAutomation(automation: Automation, testOnly: boolean) {
    if (testOnly) {
      const problem = validateAutomation(automation);
      if (problem) { setError(problem); return; }
    }
    if (!testOnly && !window.confirm(`Run “${automation.name}” now? This sends notifications or publishes an announcement.`)) return;
    setActingId(automation.id);
    setError('');
    setSuccess('');
    try {
      const { data, error: runError } = await requireSupabase().rpc('run_school_automation', {
        target_automation: automation.id,
        test_only: testOnly,
      });
      if (runError) throw runError;
      if (data?.status === 'failed') {
        await load();
        setError(data.error_message || data.summary || 'The automation run failed.');
        return;
      }
      setSuccess(data?.status === 'skipped'
        ? `“${automation.name}” was skipped by its configured conditions.`
        : testOnly ? `Test completed for “${automation.name}”. No message was sent.` : `“${automation.name}” was run.`);
      await load();
    } catch (runError) {
      setError(errorText(runError, 'Could not run the automation.'));
    } finally {
      setActingId('');
    }
  }

  async function duplicateAutomation(automation: Automation) {
    setActingId(automation.id);
    setError('');
    try {
      const { error: duplicateError } = await requireSupabase().from('school_automations').insert({
        school_id: schoolId,
        name: `${automation.name} (copy)`.slice(0, 120),
        description: automation.description,
        category: automation.category,
        status: 'draft',
        trigger_type: automation.trigger_type,
        trigger_config: automation.trigger_config,
        conditions: automation.conditions,
        action_type: automation.action_type,
        action_config: automation.action_config,
        owner_id: userId,
        permitted_user_ids: [],
        permitted_roles: [],
        created_by: userId,
        estimated_minutes_saved: automation.estimated_minutes_saved,
      });
      if (duplicateError) throw duplicateError;
      setSuccess(`“${automation.name}” duplicated as a draft.`);
      await load();
    } catch (duplicateError) {
      setError(errorText(duplicateError, 'Could not duplicate the automation.'));
    } finally {
      setActingId('');
    }
  }

  async function deleteAutomation(automation: Automation) {
    if (!window.confirm(`Delete “${automation.name}” and its run history? This cannot be undone.`)) return;
    setActingId(automation.id);
    setError('');
    try {
      const { error: deleteError } = await requireSupabase().from('school_automations')
        .delete().eq('id', automation.id).eq('school_id', schoolId);
      if (deleteError) throw deleteError;
      setSuccess('Automation and its run history deleted.');
      await load();
    } catch (deleteError) {
      setError(errorText(deleteError, 'Could not delete the automation.'));
    } finally {
      setActingId('');
    }
  }

  function setActionType(actionType: ActionType) {
    setForm((current) => ({
      ...current,
      action_type: actionType,
      action_config: actionType === 'notification'
        ? { title: '', body: '', recipient_roles: ['school_admin'], target_path: '/dashboard' }
        : { title: '', body: '', audience: 'school' },
    }));
  }

  function toggleValue<T extends string>(values: T[], value: T, checked: boolean): T[] {
    return checked ? [...new Set([...values, value])] : values.filter((item) => item !== value);
  }

  if (loading) return <LoadingState label="Loading automations…" />;

  return (
    <div className="page-stack automations-page">
      <header className="page-heading">
        <div><span className="eyebrow">School operations</span><h1>Automations</h1><p>Manage your school’s automated workflows.</p></div>
        {isManager && <button className="button button-primary" onClick={startCreate}><Plus size={16} />Create automation</button>}
      </header>
      {error && <ErrorState message={error} />}
      {success && <SuccessMessage message={success} />}

      <section className="automation-metrics" aria-label="Automation overview">
        <article><span>Active automations</span><strong>{automations.filter((item) => item.status === 'active').length}</strong><small>Currently scheduled</small></article>
        <article><span>Runs today</span><strong>{todayRuns.length}</strong><small>From recorded run history</small></article>
        <article className={needsAttention ? 'attention' : ''}><span>Needs attention</span><strong>{needsAttention}</strong><small>Failed workflows</small></article>
        <article><span>Time saved today</span><strong>{savedMinutes >= 60 ? `${(savedMinutes / 60).toFixed(1)} h` : `${savedMinutes} min`}</strong><small>Estimated from successful runs</small></article>
      </section>

      <nav className="automation-tabs" aria-label="Automation sections">
        <button className={tab === 'automations' ? 'active' : ''} onClick={() => setTab('automations')}><Workflow size={16} />My automations</button>
        <button className={tab === 'templates' ? 'active' : ''} onClick={() => setTab('templates')}><Sparkles size={16} />Preset templates</button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}><History size={16} />Run history</button>
      </nav>

      {showForm && <section className="content-card automation-editor">
        <div className="section-heading"><div><span className="eyebrow">{editingId ? 'Workflow settings' : 'New workflow'}</span><h2>{editingId ? 'Edit automation' : 'Create automation'}</h2></div><button className="button button-quiet" type="button" onClick={() => setShowForm(false)}>Close</button></div>
        <form onSubmit={(event) => void saveAutomation(event)}>
          <div className="automation-form-grid">
            <label className="field"><span>Name</span><input required minLength={2} maxLength={120} value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="e.g. Weekly attendance review" disabled={saving} /></label>
            <label className="field"><span>Category</span><select value={form.category} onChange={(event) => setForm((current) => ({ ...current, category: event.target.value as Category }))} disabled={saving}>{categoryOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            <label className="field automation-description"><span>Description</span><textarea rows={2} maxLength={1000} value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} placeholder="What repetitive task does this workflow handle?" disabled={saving} /></label>
          </div>

          <div className="automation-builder-section">
            <h3><CalendarClock size={16} />Trigger</h3>
            <div className="automation-form-grid">
              <label className="field"><span>When should it run?</span><select value={form.trigger_type} onChange={(event) => {
                const triggerType = event.target.value as TriggerType;
                const config: TriggerConfig = triggerType === 'schedule' ? { frequency: 'daily', time: '08:00' }
                  : triggerType === 'record_created' || triggerType === 'record_updated' || triggerType === 'status_changed' ? { source_table: 'students' }
                    : triggerType === 'date_reached' ? { source: 'assignment_deadline' }
                      : triggerType === 'attendance_event' ? { event: 'recorded' }
                        : triggerType === 'assessment_event' ? { event: 'marks_submitted' }
                          : triggerType === 'fee_event' ? { event: 'payment_recorded' }
                            : triggerType === 'admission_event' ? { event: 'submitted' }
                              : triggerType === 'staff_student_event' ? { event: 'student_created' } : {};
                setForm((current) => ({
                  ...current,
                  trigger_type: triggerType,
                  trigger_config: config,
                  conditions: triggerType === 'schedule' ? current.conditions : { weekdays_only: false },
                }));
              }} disabled={saving}>{triggerOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              {form.trigger_type === 'schedule' && <>
                <label className="field"><span>Repeat</span><select value={form.trigger_config.frequency ?? 'daily'} onChange={(event) => setForm((current) => ({ ...current, trigger_config: { ...current.trigger_config, frequency: event.target.value as 'daily' | 'weekly' | 'monthly', weekday: event.target.value === 'weekly' ? (current.trigger_config.weekday ?? 1) : undefined, day_of_month: event.target.value === 'monthly' ? (current.trigger_config.day_of_month ?? 1) : undefined } }))} disabled={saving}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
                {form.trigger_config.frequency === 'weekly' && <label className="field"><span>Day</span><select value={form.trigger_config.weekday ?? 1} onChange={(event) => setForm((current) => ({ ...current, trigger_config: { ...current.trigger_config, weekday: Number(event.target.value) } }))} disabled={saving}>{weekdays.map((day) => <option key={day.value} value={day.value}>{day.label}</option>)}</select></label>}
                {form.trigger_config.frequency === 'monthly' && <label className="field"><span>Day of month</span><select value={form.trigger_config.day_of_month ?? 1} onChange={(event) => setForm((current) => ({ ...current, trigger_config: { ...current.trigger_config, day_of_month: Number(event.target.value) } }))} disabled={saving}>{Array.from({ length: 31 }, (_, index) => index + 1).map((day) => <option key={day} value={day}>{day}</option>)}</select></label>}
                <label className="field"><span>School local time</span><input type="time" required value={form.trigger_config.time ?? '08:00'} onChange={(event) => setForm((current) => ({ ...current, trigger_config: { ...current.trigger_config, time: event.target.value } }))} disabled={saving} /></label>
              </>}
              {['record_created', 'record_updated', 'status_changed'].includes(form.trigger_type) && <label className="field"><span>Record type</span><select value={form.trigger_config.source_table ?? 'students'} onChange={(event) => setForm((current) => ({ ...current, trigger_config: { source_table: event.target.value } }))} disabled={saving}>{(form.trigger_type === 'status_changed' ? statusSources : recordSources).map((source) => <option key={source.value} value={source.value}>{source.label}</option>)}</select></label>}
              {form.trigger_type === 'status_changed' && <label className="field"><span>Only when new status is (optional)</span><input maxLength={40} value={form.trigger_config.status ?? ''} onChange={(event) => setForm((current) => ({ ...current, trigger_config: { ...current.trigger_config, status: event.target.value.trim() || undefined } }))} placeholder="e.g. active, published, accepted" disabled={saving} /></label>}
              {form.trigger_type === 'date_reached' && <label className="field"><span>Date to watch</span><select value={form.trigger_config.source ?? 'assignment_deadline'} onChange={(event) => setForm((current) => ({ ...current, trigger_config: { source: event.target.value } }))} disabled={saving}><option value="assignment_deadline">Assignment deadline</option><option value="exam_date">Exam date</option><option value="invoice_due_date">Fee invoice due date</option></select></label>}
              {form.trigger_type === 'attendance_event' && <>
                <label className="field"><span>Event</span><select value={form.trigger_config.event ?? 'recorded'} onChange={(event) => setForm((current) => ({ ...current, trigger_config: { event: event.target.value, ...(event.target.value === 'absence_threshold' ? { threshold: current.trigger_config.threshold ?? 3, window_days: current.trigger_config.window_days ?? 7 } : {}) } }))} disabled={saving}><option value="recorded">Attendance recorded</option><option value="absence_threshold">Absence threshold reached</option></select></label>
                {form.trigger_config.event === 'absence_threshold' && <><label className="field"><span>Absent records</span><input type="number" min={1} max={30} value={form.trigger_config.threshold ?? 3} onChange={(event) => setForm((current) => ({ ...current, trigger_config: { ...current.trigger_config, threshold: Number(event.target.value) } }))} disabled={saving} /></label><label className="field"><span>Within how many days?</span><input type="number" min={1} max={90} value={form.trigger_config.window_days ?? 7} onChange={(event) => setForm((current) => ({ ...current, trigger_config: { ...current.trigger_config, window_days: Number(event.target.value) } }))} disabled={saving} /></label></>}
              </>}
              {form.trigger_type === 'assignment_deadline' && <p className="automation-token-help">Runs when a published assignment reaches its due date.</p>}
              {form.trigger_type === 'assessment_event' && <label className="field"><span>Event</span><select value={form.trigger_config.event ?? 'marks_submitted'} onChange={(event) => setForm((current) => ({ ...current, trigger_config: { event: event.target.value } }))} disabled={saving}><option value="marks_submitted">Marks submitted</option><option value="assessment_published">Assessment completed (results published)</option><option value="submission_graded">Assignment submission graded</option></select></label>}
              {form.trigger_type === 'fee_event' && <label className="field"><span>Event</span><select value={form.trigger_config.event ?? 'payment_recorded'} onChange={(event) => setForm((current) => ({ ...current, trigger_config: { event: event.target.value } }))} disabled={saving}><option value="payment_recorded">Fee payment recorded</option><option value="invoice_overdue">Invoice becomes overdue</option></select></label>}
              {form.trigger_type === 'admission_event' && <label className="field"><span>Event</span><select value={form.trigger_config.event ?? 'submitted'} onChange={(event) => setForm((current) => ({ ...current, trigger_config: { event: event.target.value } }))} disabled={saving}><option value="submitted">Application submitted</option><option value="status_changed">Application status changed</option></select></label>}
              {form.trigger_type === 'staff_student_event' && <label className="field"><span>Event</span><select value={form.trigger_config.event ?? 'student_created'} onChange={(event) => setForm((current) => ({ ...current, trigger_config: { event: event.target.value } }))} disabled={saving}><option value="student_created">Student profile created</option><option value="student_status_changed">Student status changed</option><option value="student_enrolled">Student enrolled in a class</option><option value="staff_created">Staff profile created</option><option value="staff_status_changed">Staff employment status changed</option></select></label>}
            </div>
          </div>

          {form.trigger_type === 'schedule' && <div className="automation-builder-section">
            <h3><Check size={16} />Conditions</h3>
            <label className="automation-condition"><input type="checkbox" checked={Boolean(form.conditions.weekdays_only)} onChange={(event) => setForm((current) => ({ ...current, conditions: { ...current.conditions, weekdays_only: event.target.checked } }))} disabled={saving} /><span><strong>Only run on weekdays</strong><small>Weekend runs are recorded as skipped and rescheduled.</small></span></label>
          </div>}

          <div className="automation-builder-section">
            <h3><BellRing size={16} />Action</h3>
            <div className="automation-form-grid">
              <label className="field"><span>Action type</span><select value={form.action_type} onChange={(event) => setActionType(event.target.value as ActionType)} disabled={saving}><option value="notification">Send in-app notification</option><option value="announcement">Publish announcement</option></select></label>
              <label className="field"><span>Action title</span><input required minLength={2} maxLength={160} value={form.action_config.title} onChange={(event) => setForm((current) => ({ ...current, action_config: { ...current.action_config, title: event.target.value } }))} placeholder="A useful subject for the message" disabled={saving} /></label>
              <label className="field automation-description"><span>Message</span><textarea required rows={3} minLength={3} maxLength={5000} value={form.action_config.body} onChange={(event) => setForm((current) => ({ ...current, action_config: { ...current.action_config, body: event.target.value } }))} placeholder="Write the reminder or announcement" disabled={saving} /></label>
              {form.action_type === 'notification' ? <>
                <label className="field"><span>In-app destination</span><input maxLength={200} value={form.action_config.target_path ?? ''} onChange={(event) => setForm((current) => ({ ...current, action_config: { ...current.action_config, target_path: event.target.value } }))} placeholder="/dashboard" disabled={saving} /></label>
                <fieldset className="automation-check-list"><legend>Notification recipients</legend>{roleOptions.map((role) => <label key={role.value}><input type="checkbox" checked={Boolean(form.action_config.recipient_roles?.includes(role.value))} onChange={(event) => setForm((current) => ({ ...current, action_config: { ...current.action_config, recipient_roles: toggleValue(current.action_config.recipient_roles ?? [], role.value, event.target.checked) } }))} disabled={saving} />{role.label}</label>)}</fieldset>
              </> : <label className="field"><span>Announcement audience</span><select value={form.action_config.audience ?? 'school'} onChange={(event) => setForm((current) => ({ ...current, action_config: { ...current.action_config, audience: event.target.value as 'school' | 'staff' | 'students' | 'parents' } }))} disabled={saving}><option value="school">Entire school</option><option value="staff">Staff</option><option value="students">Students</option><option value="parents">Parents</option></select></label>}
              <p className="automation-token-help">Message placeholders supported: <code>{'{school_name}'}</code> and <code>{'{date}'}</code>.</p>
            </div>
          </div>

          <div className="automation-builder-section">
            <h3><UserRoundIcon />Ownership and access</h3>
            <div className="automation-form-grid">
              <label className="field"><span>Owner</span><select value={form.owner_id} onChange={(event) => setForm((current) => ({ ...current, owner_id: event.target.value }))} disabled={saving || !isManager}>{members.map((member) => <option key={member.profile_id} value={member.profile_id}>{member.profile?.full_name || member.profile?.email || `Member ${member.profile_id.slice(0, 8)}`} · {roleOptions.find((option) => option.value === member.role)?.label ?? member.role}</option>)}</select></label>
              <label className="field"><span>Estimated time saved per run (minutes)</span><input type="number" min={1} max={240} value={form.estimated_minutes_saved} onChange={(event) => setForm((current) => ({ ...current, estimated_minutes_saved: Number(event.target.value) }))} disabled={saving} /></label>
              <fieldset className="automation-check-list"><legend>Permitted roles (can view, edit, and test)</legend>{roleOptions.filter((role) => role.value !== 'school_admin').map((role) => <label key={role.value}><input type="checkbox" checked={form.permitted_roles.includes(role.value)} onChange={(event) => setForm((current) => ({ ...current, permitted_roles: toggleValue(current.permitted_roles, role.value, event.target.checked) }))} disabled={saving || !isManager} />{role.label}</label>)}</fieldset>
              <fieldset className="automation-check-list"><legend>Permitted individual users</legend>{members.map((member) => <label key={member.profile_id}><input type="checkbox" checked={form.permitted_user_ids.includes(member.profile_id)} onChange={(event) => setForm((current) => ({ ...current, permitted_user_ids: toggleValue(current.permitted_user_ids, member.profile_id, event.target.checked) }))} disabled={saving || !isManager || member.profile_id === userId} />{member.profile?.full_name || member.profile?.email || `Member ${member.profile_id.slice(0, 8)}`}</label>)}</fieldset>
              <label className="field"><span>Save status</span><select value={form.status} onChange={(event) => setForm((current) => ({ ...current, status: event.target.value as AutomationStatus }))} disabled={saving}><option value="draft">Draft</option><option value="active">Active</option><option value="paused">Paused</option><option value="disabled">Disabled</option></select></label>
            </div>
          </div>
          <div className="automation-form-actions">
            <button className="button button-primary" type="submit" disabled={saving}><Check size={15} />{saving ? 'Saving…' : editingId ? 'Save changes' : 'Create automation'}</button>
            <button className="button button-quiet" type="button" onClick={() => void runAutomationPreview()} disabled={saving}><FlaskConical size={15} />Validate configuration</button>
            <button className="button button-quiet" type="button" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </form>
      </section>}

      {tab === 'automations' && <>
        {!showForm && isManager && automations.length === 0 && <section className="content-card automation-empty-prompt"><Workflow size={26} /><div><strong>Make the routine automatic</strong><p>Start from a preset or build a scheduled workflow from scratch.</p></div><button className="button button-primary" onClick={startCreate}><Plus size={15} />Create automation</button></section>}
        <section className="content-card automation-list-card">
          <div className="section-heading"><div><span className="eyebrow">My automations</span><h2>Workflows</h2></div><span className="table-count">{filtered.length} shown</span></div>
          <div className="automation-filters">
            <label className="table-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search automations" /></label>
            <select aria-label="Filter by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as AutomationStatus | 'all')}><option value="all">All statuses</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            <select aria-label="Filter by category" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value as Category | 'all')}><option value="all">All categories</option>{categoryOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          </div>
          {filtered.length === 0 ? <EmptyState title={automations.length ? 'No matching automations' : 'No automations yet'} detail={automations.length ? 'Change the search or filters to find a workflow.' : 'Create a workflow or start with a preset template.'} /> : <div className="automation-list">
            {filtered.map((automation) => {
              const editable = isManager || automation.owner_id === userId || automation.permitted_user_ids.includes(userId) || Boolean(currentRole && automation.permitted_roles.includes(currentRole));
              const canDelete = isManager || automation.owner_id === userId;
              const busy = actingId === automation.id;
              return <article className="automation-row" key={automation.id}>
                <div className="automation-row-icon">{automation.action_type === 'announcement' ? <Megaphone size={19} /> : <BellRing size={19} />}</div>
                <div className="automation-row-main"><div className="automation-row-title"><strong>{automation.name}</strong><span className={`automation-status automation-status-${automation.status}`}>{statusLabels[automation.status]}</span></div><p>{automation.description || 'No description added.'}</p><div className="automation-row-meta"><span>{categoryOptions.find((item) => item.value === automation.category)?.label}</span><span>{triggerDescription(automation)}</span><span>Owner: {members.find((member) => member.profile_id === automation.owner_id)?.profile?.full_name || `Member ${automation.owner_id.slice(0, 8)}`}</span><span>Last run: {formatDate(automation.last_run_at, activeMembership?.school.timezone ?? 'UTC')}</span><span>Next: {automation.trigger_type === 'schedule' ? formatDate(automation.next_run_at, activeMembership?.school.timezone ?? 'UTC') : 'When the event occurs'}</span></div></div>
                <div className="automation-row-actions">
                  {editable && <button className="icon-button" title="Edit automation" aria-label={`Edit ${automation.name}`} onClick={() => startEdit(automation)}><Pencil size={16} /></button>}
                  {editable && <button className="icon-button" title="Test configuration" aria-label={`Test ${automation.name}`} disabled={busy} onClick={() => void runAutomation(automation, true)}><FlaskConical size={16} /></button>}
                  {isManager && editable && <button className="icon-button" title="Run now" aria-label={`Run ${automation.name} now`} disabled={busy || automation.status !== 'active'} onClick={() => void runAutomation(automation, false)}><Play size={16} /></button>}
                  {editable && automation.status === 'active' && <button className="icon-button" title="Pause workflow" aria-label={`Pause ${automation.name}`} disabled={busy} onClick={() => void changeStatus(automation, 'paused')}><Pause size={16} /></button>}
                  {editable && (automation.status === 'paused' || automation.status === 'disabled' || automation.status === 'failed') && <button className="icon-button" title="Resume workflow" aria-label={`Resume ${automation.name}`} disabled={busy} onClick={() => void changeStatus(automation, 'active')}><Play size={16} /></button>}
                  {isManager && editable && automation.status !== 'disabled' && automation.status !== 'draft' && <button className="icon-button" title="Disable workflow" aria-label={`Disable ${automation.name}`} disabled={busy} onClick={() => void changeStatus(automation, 'disabled')}><CircleAlert size={16} /></button>}
                  {editable && isManager && <button className="icon-button" title="Duplicate workflow" aria-label={`Duplicate ${automation.name}`} disabled={busy} onClick={() => void duplicateAutomation(automation)}><Copy size={16} /></button>}
                  {canDelete && <button className="icon-button automation-delete-button" title="Delete workflow" aria-label={`Delete ${automation.name}`} disabled={busy} onClick={() => void deleteAutomation(automation)}><Trash2 size={16} /></button>}
                </div>
              </article>;
            })}
          </div>}
        </section>
      </>}

      {tab === 'templates' && <section className="automation-template-grid" aria-label="Preset templates">{templateItems.map((template) => <article className="content-card automation-template-card" key={template.id}>
        <span className="automation-template-icon"><Sparkles size={18} /></span><span className="eyebrow">{categoryOptions.find((item) => item.value === template.category)?.label}</span><h2>{template.name}</h2><p>{template.description}</p><div className="automation-template-meta"><span>{template.frequency === 'daily' ? 'Every day' : `Every ${weekdays.find((day) => day.value === template.weekday)?.label}`}</span><span>{template.time}</span><span>{template.actionType === 'announcement' ? 'Announcement' : 'Notification'}</span></div><button className="button button-primary" onClick={() => useTemplate(template)} disabled={!isManager}><Plus size={15} />Use template</button>
      </article>)}</section>}

      {tab === 'history' && <section className="content-card automation-history-card">
        <div className="section-heading"><div><span className="eyebrow">Run history</span><h2>Recent activity</h2></div><History size={19} className="muted-icon" /></div>
        {runs.length === 0 ? <EmptyState title="No runs recorded" detail="Successful, skipped, failed, scheduled, manual, and test runs will appear here." /> : <div className="table-scroll"><table className="automation-history-table"><thead><tr><th>Automation</th><th>Result</th><th>Run type</th><th>Started</th><th>Summary</th></tr></thead><tbody>{runs.map((run) => <tr key={run.id}><td>{run.automation_name}</td><td><span className={`automation-run-status automation-run-${run.status}`}>{run.status}</span></td><td>{run.is_test ? 'Test' : 'Scheduled / manual'}</td><td>{formatDate(run.started_at, activeMembership?.school.timezone ?? 'UTC')}</td><td>{run.error_message || run.summary}</td></tr>)}</tbody></table></div>}
      </section>}
    </div>
  );

  function runAutomationPreview() {
    const problem = validateForm();
    setError(problem);
    setSuccess(problem ? '' : 'Configuration is valid. Save as Active to schedule it, or save as Draft to finish later.');
  }
}

function UserRoundIcon() {
  return <Workflow size={16} />;
}
