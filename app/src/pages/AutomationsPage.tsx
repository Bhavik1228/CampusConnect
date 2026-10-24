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
type Automation = {
  id: string;
  school_id: string;
  name: string;
  description: string;
  category: Category;
  status: AutomationStatus;
  trigger_type: 'schedule';
  trigger_config: { frequency: 'daily' | 'weekly'; time: string; weekday?: number };
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
  run_source: 'scheduled' | 'manual' | 'test';
  is_test: boolean;
  started_at: string;
  completed_at: string | null;
  summary: string;
  error_message: string | null;
  automation: { name: string } | { name: string }[] | null;
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

function relationName(value: Run['automation']) {
  return Array.isArray(value) ? value[0]?.name ?? 'Automation' : value?.name ?? 'Automation';
}

function formatDate(value: string | null, timeZone: string) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(value)) : 'Never';
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
          .select('id,automation_id,status,run_source,is_test,started_at,completed_at,summary,error_message,automation:school_automations(name)')
          .eq('school_id', schoolId).order('started_at', { ascending: false }).limit(250),
        client.from('school_memberships')
          .select('profile_id,role,profile:profiles(full_name,email)')
          .eq('school_id', schoolId).order('created_at'),
      ]);
      for (const result of [automationResult, runResult, memberResult]) {
        if (result.error) throw result.error;
      }
      setAutomations((automationResult.data ?? []) as Automation[]);
      setRuns((runResult.data ?? []) as unknown as Run[]);
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
    if (form.trigger_config.frequency === 'weekly' && form.trigger_config.weekday === undefined) return 'Choose a day of the week.';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.trigger_config.time)) return 'Choose a valid scheduled time.';
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
      && item.trigger_config.frequency === form.trigger_config.frequency
      && item.trigger_config.time === form.trigger_config.time
      && item.trigger_config.weekday === form.trigger_config.weekday
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
        trigger_config: {
          frequency: form.trigger_config.frequency,
          time: form.trigger_config.time,
          ...(form.trigger_config.frequency === 'weekly' ? { weekday: form.trigger_config.weekday } : {}),
        },
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
        && item.trigger_config.frequency === automation.trigger_config.frequency
        && item.trigger_config.time === automation.trigger_config.time
        && item.trigger_config.weekday === automation.trigger_config.weekday
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
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(automation.trigger_config.time)) return 'Set a valid schedule before activating.';
    if (automation.trigger_config.frequency === 'weekly' && automation.trigger_config.weekday === undefined) return 'Choose a schedule day before activating.';
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
              <label className="field"><span>Run frequency</span><select value={form.trigger_config.frequency} onChange={(event) => setForm((current) => ({ ...current, trigger_config: { ...current.trigger_config, frequency: event.target.value as 'daily' | 'weekly', weekday: event.target.value === 'weekly' ? (current.trigger_config.weekday ?? 1) : undefined } }))} disabled={saving}><option value="daily">Every day</option><option value="weekly">Every week</option></select></label>
              {form.trigger_config.frequency === 'weekly' && <label className="field"><span>Day</span><select value={form.trigger_config.weekday ?? 1} onChange={(event) => setForm((current) => ({ ...current, trigger_config: { ...current.trigger_config, weekday: Number(event.target.value) } }))} disabled={saving}>{weekdays.map((day) => <option key={day.value} value={day.value}>{day.label}</option>)}</select></label>}
              <label className="field"><span>School local time</span><input type="time" required value={form.trigger_config.time} onChange={(event) => setForm((current) => ({ ...current, trigger_config: { ...current.trigger_config, time: event.target.value } }))} disabled={saving} /></label>
            </div>
          </div>

          <div className="automation-builder-section">
            <h3><Check size={16} />Conditions</h3>
            <label className="automation-condition"><input type="checkbox" checked={Boolean(form.conditions.weekdays_only)} onChange={(event) => setForm((current) => ({ ...current, conditions: { ...current.conditions, weekdays_only: event.target.checked } }))} disabled={saving} /><span><strong>Only run on weekdays</strong><small>Weekend runs are recorded as skipped and rescheduled.</small></span></label>
          </div>

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
                <div className="automation-row-main"><div className="automation-row-title"><strong>{automation.name}</strong><span className={`automation-status automation-status-${automation.status}`}>{statusLabels[automation.status]}</span></div><p>{automation.description || 'No description added.'}</p><div className="automation-row-meta"><span>{categoryOptions.find((item) => item.value === automation.category)?.label}</span><span>{automation.trigger_config.frequency === 'daily' ? 'Daily' : `Weekly · ${weekdays.find((day) => day.value === automation.trigger_config.weekday)?.label ?? 'Day not set'}`} at {automation.trigger_config.time}</span><span>Owner: {members.find((member) => member.profile_id === automation.owner_id)?.profile?.full_name || `Member ${automation.owner_id.slice(0, 8)}`}</span><span>Last run: {formatDate(automation.last_run_at, activeMembership?.school.timezone ?? 'UTC')}</span><span>Next: {formatDate(automation.next_run_at, activeMembership?.school.timezone ?? 'UTC')}</span></div></div>
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
        {runs.length === 0 ? <EmptyState title="No runs recorded" detail="Successful, skipped, failed, scheduled, manual, and test runs will appear here." /> : <div className="table-scroll"><table className="automation-history-table"><thead><tr><th>Automation</th><th>Result</th><th>Run type</th><th>Started</th><th>Summary</th></tr></thead><tbody>{runs.map((run) => <tr key={run.id}><td>{relationName(run.automation)}</td><td><span className={`automation-run-status automation-run-${run.status}`}>{run.status}</span></td><td>{run.run_source}</td><td>{formatDate(run.started_at, activeMembership?.school.timezone ?? 'UTC')}</td><td>{run.error_message || run.summary}</td></tr>)}</tbody></table></div>}
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
