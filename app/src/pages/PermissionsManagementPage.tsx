import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Eye, KeyRound, Plus, Save, ShieldCheck, Users } from 'lucide-react';
import { ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { useAuth } from '../contexts/AuthContext';
import { requireSupabase } from '../lib/supabase';
import type { AppRole } from '../types/database';

type AssignableRole = Exclude<AppRole, 'system_admin' | 'school_admin'>;
type PermissionAction = 'access' | 'create' | 'view' | 'edit' | 'delete' | 'approve';
type PermissionOverride = boolean | null;
type ScopeType = 'class' | 'department';
type PermissionTab = 'members' | 'roles' | 'custom' | 'history';

interface Member {
  id: string;
  profile_id: string;
  role: AppRole;
  custom_role_id: string | null;
  created_at: string;
  profile?: { full_name: string | null; email: string | null } | null;
}
interface CustomRole {
  id: string;
  name: string;
  description: string;
  base_role: AssignableRole;
}
interface Scope {
  id: string;
  scope_type: ScopeType;
  scope_id: string;
}
interface ScopeChoice {
  id: string;
  name: string;
}
interface Delegation {
  id: string;
  membership_id: string;
  module_key: string;
  action_key: PermissionAction;
  allowed: boolean;
  starts_at: string;
  expires_at: string | null;
  paused_at: string | null;
}
interface AuditEvent {
  id: number;
  actor_id: string | null;
  target_membership_id: string | null;
  action: string;
  details: Record<string, unknown>;
  created_at: string;
}
interface Preview {
  [module: string]: Partial<Record<PermissionAction, boolean>>;
}

const modules = [
  ['students', 'Students'],
  ['academics', 'Academic structure'],
  ['attendance', 'Attendance'],
  ['timetable', 'Timetable'],
  ['learning', 'Learning'],
  ['assignments', 'Assignments'],
  ['assessment_results', 'Assessment results'],
  ['finance', 'Finance'],
  ['library', 'Library'],
  ['health', 'Health'],
  ['visitors', 'Visitors'],
  ['staff', 'Staff'],
  ['admissions', 'Admissions'],
  ['website', 'Website'],
  ['messaging', 'Messaging'],
  ['audit', 'Audit log'],
  ['administrative_workflows', 'Administrative workflows'],
] as const;
const actions: { value: PermissionAction; label: string }[] = [
  { value: 'access', label: 'Module access' },
  { value: 'view', label: 'View' },
  { value: 'create', label: 'Create' },
  { value: 'edit', label: 'Edit' },
  { value: 'delete', label: 'Delete' },
  { value: 'approve', label: 'Approve' },
];
const roles: { value: AssignableRole; label: string }[] = [
  { value: 'academic_coordinator', label: 'Academic coordinator' },
  { value: 'teacher', label: 'Teacher' },
  { value: 'student', label: 'Student' },
  { value: 'parent', label: 'Parent / guardian' },
  { value: 'finance_manager', label: 'Finance manager' },
  { value: 'accountant', label: 'Accountant' },
  { value: 'bursar', label: 'Bursar / fees officer' },
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
const moduleName = (key: string) => modules.find(([value]) => value === key)?.[1] ?? key;
const actionLabel = (key: string) => actions.find((item) => item.value === key)?.label ?? key;
const roleName = (key: string) => roles.find((item) => item.value === key)?.label ?? key.replace(/_/g, ' ');
const inputDateTime = (value: string | null) => value ? new Date(value).toISOString().slice(0, 16) : '';

export function PermissionsManagementPage() {
  const { activeMembership, user } = useAuth();
  const schoolId = activeMembership?.school_id;
  const [members, setMembers] = useState<Member[]>([]);
  const [customRoles, setCustomRoles] = useState<CustomRole[]>([]);
  const [classes, setClasses] = useState<ScopeChoice[]>([]);
  const [departments, setDepartments] = useState<ScopeChoice[]>([]);
  const [overrides, setOverrides] = useState<Record<string, PermissionOverride>>({});
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [delegations, setDelegations] = useState<Delegation[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [selectedMemberId, setSelectedMemberId] = useState('');
  const [selectedRole, setSelectedRole] = useState<AssignableRole>('teacher');
  const [assignedCustomRole, setAssignedCustomRole] = useState('');
  const [selectedModule, setSelectedModule] = useState<string>(modules[0][0]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [tab, setTab] = useState<PermissionTab>('members');
  const [customRoleId, setCustomRoleId] = useState('');
  const [customRoleName, setCustomRoleName] = useState('');
  const [customRoleDescription, setCustomRoleDescription] = useState('');
  const [customRoleBase, setCustomRoleBase] = useState<AssignableRole>('teacher');
  const [customDenied, setCustomDenied] = useState<Set<string>>(new Set());
  const [scopeSelection, setScopeSelection] = useState<Set<string>>(new Set());
  const [delegationId, setDelegationId] = useState('');
  const [delegationModule, setDelegationModule] = useState<string>(modules[0][0]);
  const [delegationAction, setDelegationAction] = useState<PermissionAction>('view');
  const [delegationAllowed, setDelegationAllowed] = useState(true);
  const [delegationStart, setDelegationStart] = useState(() => inputDateTime(new Date().toISOString()));
  const [delegationExpiry, setDelegationExpiry] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const selectedMember = members.find((item) => item.id === selectedMemberId) ?? null;
  const memberCustomRoles = useMemo(
    () => customRoles.filter((item) => item.base_role === selectedRole),
    [customRoles, selectedRole],
  );
  const selectedDelegations = delegations.filter((item) => item.membership_id === selectedMemberId);
  const load = useCallback(async () => {
    if (!schoolId) return;
    if (activeMembership?.role !== 'school_admin') {
      setError('Only a school administrator can manage school permissions.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [memberResult, customResult, classResult, departmentResult, rolePermissionResult, scopeResult, delegationResult, auditResult] = await Promise.all([
        client.from('school_memberships')
          .select('id,profile_id,role,custom_role_id,created_at')
          .eq('school_id', schoolId).order('created_at'),
        client.from('school_custom_roles')
          .select('id,name,description,base_role').eq('school_id', schoolId).order('name'),
        client.from('school_classes').select('id,name').eq('school_id', schoolId).order('name'),
        client.from('school_departments').select('id,name').eq('school_id', schoolId).order('name'),
        client.from('school_role_permission_overrides')
          .select('role,module_key,action_key,allowed').eq('school_id', schoolId),
        client.from('school_membership_scopes')
          .select('id,membership_id,scope_type,scope_id').eq('school_id', schoolId),
        client.from('school_permission_delegations')
          .select('id,membership_id,module_key,action_key,allowed,starts_at,expires_at,paused_at')
          .eq('school_id', schoolId).order('updated_at', { ascending: false }),
        client.from('school_permission_audit_events')
          .select('id,actor_id,target_membership_id,action,details,created_at')
          .eq('school_id', schoolId).order('created_at', { ascending: false }).limit(100),
      ]);
      for (const result of [memberResult, customResult, classResult, departmentResult, rolePermissionResult, scopeResult, delegationResult, auditResult]) {
        if (result.error) throw result.error;
      }
      const memberRows = (memberResult.data ?? []) as Member[];
      const profileIds = memberRows.map((item) => item.profile_id);
      const profilesResult = profileIds.length
        ? await client.from('profiles').select('id,full_name,email').in('id', profileIds)
        : { data: [], error: null };
      if (profilesResult.error) throw profilesResult.error;
      const profiles = new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile]));
      setMembers(memberRows.map((member) => ({ ...member, profile: profiles.get(member.profile_id) ?? null })));
      setCustomRoles((customResult.data ?? []) as CustomRole[]);
      setClasses((classResult.data ?? []) as ScopeChoice[]);
      setDepartments((departmentResult.data ?? []) as ScopeChoice[]);
      const permissionMap: Record<string, PermissionOverride> = {};
      for (const item of rolePermissionResult.data ?? []) {
        const permission = item as { role: string; module_key: string; action_key: string; allowed: boolean };
        permissionMap[`${permission.role}:${permission.module_key}:${permission.action_key}`] = permission.allowed;
      }
      setOverrides(permissionMap);
      const memberScopes = (scopeResult.data ?? []) as (Scope & { membership_id: string })[];
      setScopes(memberScopes.map((scope) => ({ ...scope, id: `${scope.membership_id}:${scope.scope_type}:${scope.scope_id}` })));
      setDelegations((delegationResult.data ?? []) as Delegation[]);
      setAuditEvents((auditResult.data ?? []) as AuditEvent[]);
      setSelectedMemberId((current) => current && memberRows.some((item) => item.id === current) ? current : memberRows.find((item) => item.role !== 'school_admin')?.id ?? '');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load school permissions.');
    } finally {
      setLoading(false);
    }
  }, [activeMembership?.role, schoolId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  useEffect(() => {
    if (selectedMember && selectedMember.role !== 'system_admin' && selectedMember.role !== 'school_admin') {
      setSelectedRole(selectedMember.role);
      setAssignedCustomRole(selectedMember.custom_role_id ?? '');
    }
  }, [selectedMember]);

  useEffect(() => {
    const existing = customRoles.find((item) => item.id === customRoleId);
    if (!existing) return;
    setCustomRoleName(existing.name);
    setCustomRoleDescription(existing.description);
    setCustomRoleBase(existing.base_role);
    void (async () => {
      try {
        const { data, error: queryError } = await requireSupabase().from('school_custom_role_permissions')
          .select('module_key,action_key,allowed').eq('school_id', schoolId).eq('custom_role_id', existing.id);
        if (queryError) throw queryError;
        setCustomDenied(new Set((data ?? [])
          .filter((item) => item.allowed === false)
          .map((item) => `${item.module_key}:${item.action_key}`)));
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Could not load custom role permissions.');
      }
    })();
  }, [customRoleId, customRoles, schoolId]);

  useEffect(() => {
    const memberScopeKeys = scopes.filter((scope) => scope.id.startsWith(`${selectedMemberId}:`))
      .map((scope) => `${scope.id.split(':')[1]}:${scope.scope_id}`);
    setScopeSelection(new Set(memberScopeKeys));
    setPreview(null);
  }, [scopes, selectedMemberId]);

  function setOverride(action: PermissionAction, value: PermissionOverride) {
    setOverrides((current) => ({ ...current, [`${selectedRole}:${selectedModule}:${action}`]: value }));
  }

  async function saveRolePermissions(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      for (const permission of actions) {
        const value = overrides[`${selectedRole}:${selectedModule}:${permission.value}`];
        const { error: saveError } = await requireSupabase().rpc('save_school_role_permission', {
          target_school: schoolId,
          target_role: selectedRole,
          target_module: selectedModule,
          target_action: permission.value,
          target_allowed: value,
        });
        if (saveError) throw saveError;
      }
      setSuccess(`Permissions saved for ${roleName(selectedRole)} · ${moduleName(selectedModule)}.`);
      setRefreshKey((current) => current + 1);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save role permissions.');
    } finally {
      setSaving(false);
    }
  }

  async function assignRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedMember) return;
    const form = new FormData(event.currentTarget);
    const role = String(form.get('role')) as AssignableRole;
    const customId = String(form.get('custom_role') ?? '') || null;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: assignError } = await requireSupabase().rpc('assign_school_member_role', {
        target_membership: selectedMember.id,
        next_role: role,
        next_custom_role: customId,
      });
      if (assignError) throw assignError;
      setSelectedRole(role);
      setSuccess('Member role updated. Permission changes are recorded in the audit history.');
      setRefreshKey((current) => current + 1);
    } catch (assignError) {
      setError(assignError instanceof Error ? assignError.message : 'Could not update this member role.');
    } finally {
      setSaving(false);
    }
  }

  async function saveScopes(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedMember) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const values = [...scopeSelection].map((key) => {
        const [type, id] = key.split(':');
        return { type, id };
      });
      const { error: scopeError } = await requireSupabase().rpc('set_school_member_scopes', {
        target_membership: selectedMember.id,
        scopes: values,
      });
      if (scopeError) throw scopeError;
      setSuccess(values.length ? 'Class and department restrictions saved.' : 'Scope restrictions cleared; the member is limited by their school role only.');
      setRefreshKey((current) => current + 1);
    } catch (scopeError) {
      setError(scopeError instanceof Error ? scopeError.message : 'Could not save member scopes.');
    } finally {
      setSaving(false);
    }
  }

  async function previewPermissions() {
    if (!selectedMember) return;
    setSaving(true);
    setError('');
    try {
      const { data, error: previewError } = await requireSupabase().rpc('preview_school_member_permissions', {
        target_membership: selectedMember.id,
        target_role: selectedRole,
        target_custom_role: assignedCustomRole || null,
      });
      if (previewError) throw previewError;
      setPreview(data as Preview);
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : 'Could not preview member permissions.');
    } finally {
      setSaving(false);
    }
  }

  async function saveCustomRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const permissions = [...customDenied].map((value) => {
        const [module, action] = value.split(':');
        return { module, action, allowed: false };
      });
      const { data, error: saveError } = await requireSupabase().rpc('save_school_custom_role', {
        target_school: schoolId,
        target_custom_role: customRoleId || null,
        role_name: customRoleName.trim(),
        role_description: customRoleDescription.trim(),
        base_role: customRoleBase,
        permissions,
      });
      if (saveError) throw saveError;
      setCustomRoleId(data as string);
      setSuccess('Custom role saved. It can only reduce permissions from its selected built-in role.');
      setRefreshKey((current) => current + 1);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save this custom role.');
    } finally {
      setSaving(false);
    }
  }

  function editDelegation(item: Delegation) {
    setDelegationId(item.id);
    setDelegationModule(item.module_key);
    setDelegationAction(item.action_key);
    setDelegationAllowed(item.allowed);
    setDelegationStart(inputDateTime(item.starts_at));
    setDelegationExpiry(inputDateTime(item.expires_at));
  }

  function resetDelegation() {
    setDelegationId('');
    setDelegationModule(modules[0][0]);
    setDelegationAction('view');
    setDelegationAllowed(true);
    setDelegationStart(inputDateTime(new Date().toISOString()));
    setDelegationExpiry('');
  }

  async function saveDelegation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedMember) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: saveError } = await requireSupabase().rpc('save_school_permission_delegation', {
        target_delegation: delegationId || null,
        target_membership: selectedMember.id,
        target_module: delegationModule,
        target_action: delegationAction,
        target_allowed: delegationAllowed,
        target_starts_at: new Date(delegationStart).toISOString(),
        target_expires_at: delegationExpiry ? new Date(delegationExpiry).toISOString() : null,
        target_paused: false,
      });
      if (saveError) throw saveError;
      setSuccess(delegationAllowed ? 'Temporary permission grant saved.' : 'Temporary permission restriction saved.');
      resetDelegation();
      setRefreshKey((current) => current + 1);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save this temporary permission.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleDelegation(item: Delegation) {
    if (!selectedMember) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: saveError } = await requireSupabase().rpc('save_school_permission_delegation', {
        target_delegation: item.id,
        target_membership: selectedMember.id,
        target_module: item.module_key,
        target_action: item.action_key,
        target_allowed: item.allowed,
        target_starts_at: item.starts_at,
        target_expires_at: item.expires_at,
        target_paused: item.paused_at === null,
      });
      if (saveError) throw saveError;
      setSuccess(item.paused_at ? 'Delegated permission resumed.' : 'Delegated permission paused.');
      setRefreshKey((current) => current + 1);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not change delegation status.');
    } finally {
      setSaving(false);
    }
  }

  if (!schoolId) return <div className="page-stack"><ErrorState message="Select a school before managing permissions." /></div>;
  if (activeMembership?.role !== 'school_admin') {
    return <div className="page-stack"><ErrorState message="Only a school administrator can manage school permissions." /></div>;
  }

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div><span className="eyebrow">School administration</span><h1>Roles &amp; permissions</h1><p>Assign school roles, narrow access, scope records, and manage temporary delegated permissions.</p></div>
        <button className="button button-quiet" type="button" onClick={() => setRefreshKey((key) => key + 1)} disabled={loading}><ShieldCheck size={15} />Refresh</button>
      </div>
      {error && <ErrorState message={error} />}
      {success && <SuccessMessage message={success} />}
      {loading ? <LoadingState label="Loading school permissions…" /> : <>
        <section className="content-card permission-member-select">
          <label className="field"><span>School member</span><select value={selectedMemberId} onChange={(event) => setSelectedMemberId(event.target.value)}>
            {members.map((member) => <option key={member.id} value={member.id}>{member.profile?.full_name || member.profile?.email || member.profile_id} · {roleName(member.role)}</option>)}
          </select></label>
          {selectedMember && <p className="settings-readonly">{selectedMember.profile?.email || selectedMember.profile_id} · membership in this school only</p>}
        </section>
        <nav className="permission-tabs" aria-label="Permission management sections">
          {([
            ['members', 'Member access', Users],
            ['roles', 'Role permissions', ShieldCheck],
            ['custom', 'Custom roles', KeyRound],
            ['history', 'Audit history', Eye],
          ] as const).map(([value, label, Icon]) => <button key={value} type="button" className={tab === value ? 'active' : ''} onClick={() => setTab(value)}><Icon size={15} />{label}</button>)}
        </nav>

        {tab === 'members' && selectedMember && <>
          <section className="content-card">
            <div className="section-heading"><div><span className="eyebrow">Role assignment</span><h2>School role</h2></div></div>
            {selectedMember.role === 'school_admin' || selectedMember.profile_id === user?.id
              ? <p className="settings-readonly">School and platform administrator privileges cannot be assigned or changed here. Administrators cannot change their own roles.</p>
              : <form className="permission-form-row" onSubmit={(event) => void assignRole(event)}>
                <label className="field"><span>Built-in role</span><select name="role" value={selectedRole} onChange={(event) => { setSelectedRole(event.target.value as AssignableRole); setAssignedCustomRole(''); }} disabled={saving}>
                  {roles.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
                </select></label>
                <label className="field"><span>Custom restriction profile</span><select name="custom_role" value={assignedCustomRole} onChange={(event) => setAssignedCustomRole(event.target.value)} disabled={saving || memberCustomRoles.length === 0}>
                  <option value="">Built-in role only</option>
                  {memberCustomRoles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
                </select></label>
                <button className="button button-primary" type="submit" disabled={saving}><Save size={14} />Apply role</button>
              </form>}
            <p className="settings-readonly">School admins can assign school roles but cannot grant system-owner/platform privileges. Role changes are audited.</p>
            <div className="settings-actions">
              <button className="button button-quiet" type="button" onClick={() => void previewPermissions()} disabled={saving}><Eye size={14} />Preview before applying</button>
            </div>
            {preview && <div className="permission-preview"><h3>Effective permission preview</h3><p>Shows configured restrictions for this member’s role; existing row-level policies remain the final access ceiling.</p>
              <div className="permission-preview-grid">{modules.map(([key, label]) => <article key={key}><strong>{label}</strong><div>{actions.map((action) => <span key={action.value} className={preview[key]?.[action.value] === false ? 'denied' : 'allowed'}>{action.label}: {preview[key]?.[action.value] === false ? 'Restricted' : 'Available'}</span>)}</div></article>)}</div>
            </div>}
          </section>
          <section className="content-card">
            <div className="section-heading"><div><span className="eyebrow">Data boundaries</span><h2>Class and department scope</h2></div></div>
            <p className="settings-readonly">Leave all scopes unselected for the member’s existing role-based access. Selecting one or more scopes limits supported class and department records to those assignments.</p>
            <form onSubmit={(event) => void saveScopes(event)}>
              <div className="permission-scope-grid">
                {([['class', 'Classes', classes], ['department', 'Departments', departments]] as const).map(([type, label, choices]) => <fieldset key={type}>
                  <legend>{label}</legend>
                  {choices.length ? choices.map((choice) => {
                    const key = `${type}:${choice.id}`;
                    return <label key={choice.id}><input type="checkbox" checked={scopeSelection.has(key)} disabled={saving} onChange={(event) => setScopeSelection((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(key); else next.delete(key);
                      return next;
                    })} /><span>{choice.name}</span></label>;
                  }) : <p>No {label.toLowerCase()} configured.</p>}
                </fieldset>)}
              </div>
              <button className="button button-primary" type="submit" disabled={saving}><Save size={14} />Save scopes</button>
            </form>
          </section>
          <section className="content-card">
            <div className="section-heading"><div><span className="eyebrow">Time-limited administration</span><h2>Temporary delegated permissions</h2></div></div>
            <p className="settings-readonly">Delegations can allow or restrict one module action. Set an optional expiry; administrators can edit, pause, resume, or let a delegation expire. A delegation cannot bypass the assigned role’s existing database policies.</p>
            <form className="permission-form-row" onSubmit={(event) => void saveDelegation(event)}>
              <label className="field"><span>Module</span><select value={delegationModule} onChange={(event) => setDelegationModule(event.target.value)}>{modules.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="field"><span>Action</span><select value={delegationAction} onChange={(event) => setDelegationAction(event.target.value as PermissionAction)}>{actions.map((action) => <option key={action.value} value={action.value}>{action.label}</option>)}</select></label>
              <label className="field"><span>Delegated effect</span><select value={delegationAllowed ? 'allow' : 'deny'} onChange={(event) => setDelegationAllowed(event.target.value === 'allow')}><option value="allow">Allow within built-in role</option><option value="deny">Temporarily restrict</option></select></label>
              <label className="field"><span>Starts</span><input type="datetime-local" value={delegationStart} required onChange={(event) => setDelegationStart(event.target.value)} /></label>
              <label className="field"><span>Expires (optional)</span><input type="datetime-local" value={delegationExpiry} onChange={(event) => setDelegationExpiry(event.target.value)} /></label>
              <button className="button button-primary" type="submit" disabled={saving}><Plus size={14} />{delegationId ? 'Save delegation' : 'Add delegation'}</button>
              {delegationId && <button className="button button-quiet" type="button" onClick={resetDelegation}>Cancel edit</button>}
            </form>
            <div className="permission-delegation-list">{selectedDelegations.map((item) => <article key={item.id}>
              <div><strong>{moduleName(item.module_key)} · {actionLabel(item.action_key)}</strong><small>{item.allowed ? 'Allow within assigned role' : 'Temporary restriction'} · starts {new Date(item.starts_at).toLocaleString()} · {item.expires_at ? `expires ${new Date(item.expires_at).toLocaleString()}` : 'no expiry'}</small><small>{item.paused_at ? 'Paused' : 'Active'}</small></div>
              <div><button className="button button-quiet" type="button" onClick={() => editDelegation(item)} disabled={saving}>Edit</button><button className="button button-quiet" type="button" onClick={() => void toggleDelegation(item)} disabled={saving}>{item.paused_at ? 'Resume' : 'Pause'}</button></div>
            </article>)}</div>
          </section>
        </>}

        {tab === 'roles' && <section className="content-card">
          <div className="section-heading"><div><span className="eyebrow">Least privilege</span><h2>Built-in role restrictions</h2></div></div>
          <p className="settings-readonly">Set an explicit allow/deny override for a role and module. “Inherit” preserves existing role policies; an allow does not expand the underlying row-level security policy.</p>
          <form className="permission-role-editor" onSubmit={(event) => void saveRolePermissions(event)}>
            <label className="field"><span>Role</span><select value={selectedRole} onChange={(event) => setSelectedRole(event.target.value as AssignableRole)}>{roles.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}</select></label>
            <label className="field"><span>Module</span><select value={selectedModule} onChange={(event) => setSelectedModule(event.target.value)}>{modules.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <div className="permission-action-list">{actions.map((action) => {
              const value = overrides[`${selectedRole}:${selectedModule}:${action.value}`] ?? null;
              return <label key={action.value}><span>{action.label}</span><select value={value === null ? 'inherit' : value ? 'allow' : 'deny'} disabled={saving} onChange={(event) => setOverride(action.value, event.target.value === 'inherit' ? null : event.target.value === 'allow')}><option value="inherit">Inherit role policies</option><option value="allow">Allow (within base policy)</option><option value="deny">Deny</option></select></label>;
            })}</div>
            <button className="button button-primary" type="submit" disabled={saving}><Save size={14} />Save role permissions</button>
          </form>
        </section>}

        {tab === 'custom' && <section className="content-card">
          <div className="section-heading"><div><span className="eyebrow">Custom roles</span><h2>{customRoleId ? 'Edit custom role' : 'Create custom role'}</h2></div>
            <button className="button button-quiet" type="button" onClick={() => { setCustomRoleId(''); setCustomRoleName(''); setCustomRoleDescription(''); setCustomRoleBase('teacher'); setCustomDenied(new Set()); }}>New role</button>
          </div>
          <label className="field"><span>Existing custom role</span><select value={customRoleId} onChange={(event) => setCustomRoleId(event.target.value)}><option value="">Create a new role</option>{customRoles.map((role) => <option key={role.id} value={role.id}>{role.name} · {roleName(role.base_role)}</option>)}</select></label>
          <form className="permission-custom-form" onSubmit={(event) => void saveCustomRole(event)}>
            <label className="field"><span>Role name</span><input value={customRoleName} required minLength={2} maxLength={80} onChange={(event) => setCustomRoleName(event.target.value)} /></label>
            <label className="field"><span>Based on built-in role</span><select value={customRoleBase} disabled={Boolean(customRoleId)} onChange={(event) => setCustomRoleBase(event.target.value as AssignableRole)}>{roles.filter((role) => !['student', 'parent'].includes(role.value)).map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}</select></label>
            <label className="field"><span>Description</span><textarea rows={2} maxLength={500} value={customRoleDescription} onChange={(event) => setCustomRoleDescription(event.target.value)} /></label>
            <p className="settings-readonly">Select permissions to remove from the base role. Custom roles cannot add permissions beyond the built-in role or grant school/platform administrator access.</p>
            <div className="permission-custom-grid">{modules.map(([module, label]) => <fieldset key={module}>
              <legend>{label}</legend>
              {actions.map((action) => {
                const key = `${module}:${action.value}`;
                return <label key={key}><input type="checkbox" checked={customDenied.has(key)} onChange={(event) => setCustomDenied((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(key); else next.delete(key);
                  return next;
                })} /><span>Restrict {action.label.toLowerCase()}</span></label>;
              })}
            </fieldset>)}</div>
            <button className="button button-primary" type="submit" disabled={saving}><Save size={14} />Save custom role</button>
          </form>
        </section>}

        {tab === 'history' && <section className="content-card">
          <div className="section-heading"><div><span className="eyebrow">Audit trail</span><h2>Permission changes</h2></div></div>
          {auditEvents.length ? <div className="permission-audit-list">{auditEvents.map((event) => <article key={event.id}>
            <strong>{event.action.replace(/_/g, ' ')}</strong><span>{JSON.stringify(event.details)}</span><small>{new Date(event.created_at).toLocaleString()}</small>
          </article>)}</div> : <p className="settings-readonly">No permission changes have been recorded.</p>}
        </section>}
      </>}
    </div>
  );
}
