create table public.school_custom_roles (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 80),
  description text not null default '' check (char_length(description) <= 500),
  base_role public.app_role not null check (base_role not in ('system_admin', 'school_admin')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, name)
);

alter table public.school_memberships
  add column custom_role_id uuid,
  add constraint school_memberships_custom_role_fk
    foreign key (school_id, custom_role_id)
    references public.school_custom_roles(school_id, id) on delete set null (custom_role_id);

create table public.school_role_permission_overrides (
  school_id uuid not null references public.schools(id) on delete cascade,
  role public.app_role not null check (role not in ('system_admin', 'school_admin')),
  module_key text not null check (module_key in (
    'students', 'academics', 'attendance', 'timetable', 'learning', 'assignments',
    'assessment_results', 'finance', 'library', 'health', 'visitors', 'staff',
    'admissions', 'website', 'messaging', 'audit', 'administrative_workflows'
  )),
  action_key text not null check (action_key in ('access', 'create', 'view', 'edit', 'delete', 'approve')),
  allowed boolean not null,
  updated_by uuid not null references public.profiles(id),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (school_id, role, module_key, action_key)
);

create table public.school_custom_role_permissions (
  school_id uuid not null,
  custom_role_id uuid not null,
  module_key text not null check (module_key in (
    'students', 'academics', 'attendance', 'timetable', 'learning', 'assignments',
    'assessment_results', 'finance', 'library', 'health', 'visitors', 'staff',
    'admissions', 'website', 'messaging', 'audit', 'administrative_workflows'
  )),
  action_key text not null check (action_key in ('access', 'create', 'view', 'edit', 'delete', 'approve')),
  allowed boolean not null,
  updated_by uuid not null references public.profiles(id),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (school_id, custom_role_id, module_key, action_key),
  foreign key (school_id, custom_role_id)
    references public.school_custom_roles(school_id, id) on delete cascade
);

create table public.school_membership_scopes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  membership_id uuid not null,
  scope_type text not null check (scope_type in ('class', 'department')),
  scope_id uuid not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, membership_id, scope_type, scope_id),
  foreign key (school_id, membership_id)
    references public.school_memberships(school_id, id) on delete cascade
);

create table public.school_permission_delegations (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  membership_id uuid not null,
  module_key text not null check (module_key in (
    'students', 'academics', 'attendance', 'timetable', 'learning', 'assignments',
    'assessment_results', 'finance', 'library', 'health', 'visitors', 'staff',
    'admissions', 'website', 'messaging', 'audit', 'administrative_workflows'
  )),
  action_key text not null check (action_key in ('access', 'create', 'view', 'edit', 'delete', 'approve')),
  allowed boolean not null,
  starts_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz,
  paused_at timestamptz,
  assigned_by uuid not null references public.profiles(id),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, membership_id)
    references public.school_memberships(school_id, id) on delete cascade,
  check (expires_at is null or expires_at > starts_at)
);
create index school_permission_delegations_active_idx
  on public.school_permission_delegations(school_id, membership_id, starts_at, expires_at)
  where paused_at is null;
create unique index school_permission_delegations_one_rule_idx
  on public.school_permission_delegations(school_id, membership_id, module_key, action_key);

create table public.school_permission_audit_events (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  target_membership_id uuid,
  action text not null,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, target_membership_id)
    references public.school_memberships(school_id, id) on delete set null (target_membership_id)
);
create index school_permission_audit_events_school_created_idx
  on public.school_permission_audit_events(school_id, created_at desc);

alter table public.school_custom_roles enable row level security;
alter table public.school_role_permission_overrides enable row level security;
alter table public.school_custom_role_permissions enable row level security;
alter table public.school_membership_scopes enable row level security;
alter table public.school_permission_delegations enable row level security;
alter table public.school_permission_audit_events enable row level security;

revoke all on public.school_custom_roles, public.school_role_permission_overrides,
  public.school_custom_role_permissions, public.school_membership_scopes,
  public.school_permission_delegations, public.school_permission_audit_events
  from anon, authenticated;
grant select on public.school_custom_roles, public.school_role_permission_overrides,
  public.school_custom_role_permissions, public.school_membership_scopes,
  public.school_permission_delegations, public.school_permission_audit_events
  to authenticated;

create policy "School admins manage custom roles"
  on public.school_custom_roles for all to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "School admins manage built in role permissions"
  on public.school_role_permission_overrides for all to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "School admins manage custom role permissions"
  on public.school_custom_role_permissions for all to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "School admins manage member scopes"
  on public.school_membership_scopes for all to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "School admins manage permission delegations"
  on public.school_permission_delegations for all to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "School admins read permission audit history"
  on public.school_permission_audit_events for select to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]));

create policy "School members read permitted member profiles"
  on public.profiles for select to authenticated
  using (
    id = auth.uid()
    or exists (
      select 1 from public.school_memberships target
      where target.profile_id = profiles.id
        and public.has_school_role(target.school_id, array['school_admin']::public.app_role[])
        and public.school_mfa_satisfied(target.school_id)
    )
  );

create or replace function public.school_permission_module_for_table(target_table text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when target_table in ('students', 'student_private_profiles', 'student_emergency_contacts',
      'student_lifecycle_records', 'student_guardians') then 'students'
    when target_table in ('academic_years', 'terms', 'school_classes', 'school_grade_levels',
      'subjects', 'class_subjects', 'school_departments', 'school_campuses') then 'academics'
    when target_table like 'attendance_%' or target_table in ('attendance_records', 'attendance_sessions') then 'attendance'
    when target_table like 'timetable_%' or target_table in ('teacher_class_assignments', 'teacher_subjects') then 'timetable'
    when target_table like 'learning_%' or target_table in ('learning_assessments', 'learning_assessment_results') then 'learning'
    when target_table like 'assignment_%' or target_table = 'assignments' then 'assignments'
    when target_table in ('exams', 'exam_results', 'grades', 'assessment_grades') then 'assessment_results'
    when target_table like 'fee_%' or target_table in ('payments', 'invoices', 'discounts', 'financial_adjustments') then 'finance'
    when target_table like 'library_%' or target_table in ('books', 'book_copies', 'book_requests', 'library_checkouts') then 'library'
    when target_table like 'health_%' or target_table in ('health_visits', 'health_records') then 'health'
    when target_table like 'visitor_%' or target_table = 'visitors' then 'visitors'
    when target_table like 'staff_%' or target_table in ('teacher_profiles', 'teacher_responsibilities') then 'staff'
    when target_table like 'admission_%' then 'admissions'
    when target_table like 'school_website%' then 'website'
    when target_table in ('messages', 'conversations', 'conversation_members') then 'messaging'
    when target_table = 'audit_logs' then 'audit'
    when target_table like 'school_administrative_work_item%' then 'administrative_workflows'
    else null
  end;
$$;

create or replace function public.school_permission_allowed(
  target_school uuid,
  target_module text,
  target_action text
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  member public.school_memberships%rowtype;
  configured_permission boolean;
  custom_permission boolean;
  delegated_permission boolean;
begin
  if target_module not in (
    'students', 'academics', 'attendance', 'timetable', 'learning', 'assignments',
    'assessment_results', 'finance', 'library', 'health', 'visitors', 'staff',
    'admissions', 'website', 'messaging', 'audit', 'administrative_workflows'
  ) or target_action not in ('access', 'create', 'view', 'edit', 'delete', 'approve') then
    return false;
  end if;
  select * into member
  from public.school_memberships
  where school_id = target_school and profile_id = auth.uid();
  if not found then return false; end if;
  if member.role = 'school_admin' then return true; end if;

  if member.custom_role_id is not null then
    select allowed into custom_permission
    from public.school_custom_role_permissions
    where school_id = target_school and custom_role_id = member.custom_role_id
      and module_key = target_module and action_key = target_action;
  end if;

  select allowed into configured_permission
  from public.school_role_permission_overrides
  where school_id = target_school and role = member.role
    and module_key = target_module and action_key = target_action;

  select allowed into delegated_permission
  from public.school_permission_delegations delegation
  where delegation.school_id = target_school
    and delegation.membership_id = member.id
    and delegation.module_key = target_module
    and delegation.action_key = target_action
    and delegation.paused_at is null
    and delegation.starts_at <= timezone('utc', now())
    and (delegation.expires_at is null or delegation.expires_at > timezone('utc', now()))
  order by delegation.updated_at desc
  limit 1;
  if delegated_permission is not null then return delegated_permission; end if;
  return coalesce(custom_permission, true) and coalesce(configured_permission, true);
end;
$$;
revoke all on function public.school_permission_allowed(uuid, text, text) from public, anon;
grant execute on function public.school_permission_allowed(uuid, text, text) to authenticated;

create or replace function public.school_record_scope_allowed(
  target_school uuid,
  target_table text,
  target_row jsonb
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  membership_id uuid;
  has_scope boolean;
  row_class uuid;
  row_department uuid;
  row_student uuid;
begin
  select membership.id into membership_id
  from public.school_memberships membership
  where membership.school_id = target_school and membership.profile_id = auth.uid();
  if membership_id is null then return false; end if;
  if public.has_school_role(target_school, array['school_admin']::public.app_role[]) then return true; end if;
  select exists (
    select 1 from public.school_membership_scopes scope
    where scope.school_id = target_school and scope.membership_id = membership_id
  ) into has_scope;
  if not has_scope then return true; end if;

  if target_row ? 'class_id' and nullif(target_row ->> 'class_id', '') is not null then
    row_class := (target_row ->> 'class_id')::uuid;
  elsif target_table in ('student_private_profiles', 'student_emergency_contacts', 'student_lifecycle_records') then
    row_student := nullif(target_row ->> 'student_id', '')::uuid;
    select student.class_id into row_class from public.students student
    where student.school_id = target_school and student.id = row_student;
  elsif target_table = 'attendance_records' then
    select session.class_id into row_class
    from public.attendance_sessions session
    where session.school_id = target_school
      and session.id = nullif(target_row ->> 'session_id', '')::uuid;
  elsif target_table = 'school_classes' then
    row_class := nullif(target_row ->> 'id', '')::uuid;
  end if;

  if row_class is not null and exists (
    select 1 from public.school_membership_scopes scope
    where scope.school_id = target_school and scope.membership_id = membership_id
      and scope.scope_type = 'class' and scope.scope_id = row_class
  ) then return true; end if;

  if target_row ? 'department_id' and nullif(target_row ->> 'department_id', '') is not null then
    row_department := (target_row ->> 'department_id')::uuid;
  elsif target_table = 'school_departments' then
    row_department := nullif(target_row ->> 'id', '')::uuid;
  elsif target_table = 'teacher_profiles' then
    select staff.department_id into row_department
    from public.staff_profiles staff
    where staff.school_id = target_school
      and staff.id = nullif(target_row ->> 'staff_profile_id', '')::uuid;
  end if;
  return row_department is not null and exists (
    select 1 from public.school_membership_scopes scope
    where scope.school_id = target_school and scope.membership_id = membership_id
      and scope.scope_type = 'department' and scope.scope_id = row_department
  );
end;
$$;
revoke all on function public.school_record_scope_allowed(uuid, text, jsonb) from public, anon;
grant execute on function public.school_record_scope_allowed(uuid, text, jsonb) to authenticated;

create or replace function public.get_school_permission_summary(target_school uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  result jsonb := '{}'::jsonb;
  module_name text;
  action_name text;
  action_result jsonb;
begin
  if not public.is_school_member(target_school) then
    raise exception 'School membership is required to read permissions.';
  end if;
  if not public.school_mfa_satisfied(target_school) then
    raise exception 'Complete the school MFA requirement before reading permissions.';
  end if;
  for module_name in select unnest(array[
    'students', 'academics', 'attendance', 'timetable', 'learning', 'assignments',
    'assessment_results', 'finance', 'library', 'health', 'visitors', 'staff',
    'admissions', 'website', 'messaging', 'audit', 'administrative_workflows'
  ]) loop
    action_result := '{}'::jsonb;
    for action_name in select unnest(array['access', 'create', 'view', 'edit', 'delete', 'approve']) loop
      action_result := action_result || jsonb_build_object(
        action_name, public.school_permission_allowed(target_school, module_name, action_name)
      );
    end loop;
    result := result || jsonb_build_object(module_name, action_result);
  end loop;
  return result;
end;
$$;
revoke all on function public.get_school_permission_summary(uuid) from public, anon;
grant execute on function public.get_school_permission_summary(uuid) to authenticated;

create or replace function public.log_school_permission_change(
  target_school uuid,
  target_membership uuid,
  event_action text,
  event_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_school_role(target_school, array['school_admin']::public.app_role[]) then
    raise exception 'Only a school administrator can change permissions.';
  end if;
  if not public.school_mfa_satisfied(target_school) then
    raise exception 'Complete the school MFA requirement before changing permissions.';
  end if;
  insert into public.school_permission_audit_events (
    school_id, actor_id, target_membership_id, action, details
  ) values (
    target_school, auth.uid(), target_membership, event_action, coalesce(event_details, '{}'::jsonb)
  );
end;
$$;
revoke all on function public.log_school_permission_change(uuid, uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.assign_school_member_role(
  target_membership uuid,
  next_role public.app_role,
  next_custom_role uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.school_memberships%rowtype;
begin
  select * into target from public.school_memberships where id = target_membership for update;
  if not found or not public.has_school_role(target.school_id, array['school_admin']::public.app_role[]) then
    raise exception 'Membership not found or not authorized.';
  end if;
  if target.profile_id = auth.uid() then
    raise exception 'Administrators cannot change their own role.';
  end if;
  if next_role in ('system_admin', 'school_admin') then
    raise exception 'School administrators cannot assign platform-level or administrator privileges through this role manager.';
  end if;
  if next_custom_role is not null and not exists (
    select 1 from public.school_custom_roles custom_role
    where custom_role.school_id = target.school_id
      and custom_role.id = next_custom_role
      and custom_role.base_role = next_role
  ) then
    raise exception 'Choose a custom role based on the selected built-in role.';
  end if;
  update public.school_memberships
  set role = next_role, custom_role_id = next_custom_role
  where id = target_membership;
  perform public.log_school_permission_change(
    target.school_id, target_membership, 'role_assigned',
    jsonb_build_object('previous_role', target.role::text, 'role', next_role::text, 'custom_role_id', next_custom_role)
  );
end;
$$;
revoke all on function public.assign_school_member_role(uuid, public.app_role, uuid) from public, anon;
grant execute on function public.assign_school_member_role(uuid, public.app_role, uuid) to authenticated;

create or replace function public.preview_school_member_permissions(
  target_membership uuid,
  target_role public.app_role,
  target_custom_role uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  target_school uuid;
  module_name text;
  action_name text;
  result jsonb := '{}'::jsonb;
  module_result jsonb;
  role_allowed boolean;
  custom_allowed boolean;
begin
  select school_id into target_school from public.school_memberships where id = target_membership;
  if target_school is null or not public.has_school_role(target_school, array['school_admin']::public.app_role[]) then
    raise exception 'Membership not found or not authorized.';
  end if;
  if not public.school_mfa_satisfied(target_school) then
    raise exception 'Complete the school MFA requirement before previewing permissions.';
  end if;
  if target_role in ('system_admin', 'school_admin') then
    raise exception 'School-level role previews cannot include platform or administrator privileges.';
  end if;
  if target_custom_role is not null and not exists (
    select 1 from public.school_custom_roles custom_role
    where custom_role.school_id = target_school and custom_role.id = target_custom_role
      and custom_role.base_role = target_role
  ) then
    raise exception 'Custom role and base role do not match.';
  end if;
  for module_name in select unnest(array[
    'students', 'academics', 'attendance', 'timetable', 'learning', 'assignments',
    'assessment_results', 'finance', 'library', 'health', 'visitors', 'staff',
    'admissions', 'website', 'messaging', 'audit', 'administrative_workflows'
  ]) loop
    module_result := '{}'::jsonb;
    for action_name in select unnest(array['access', 'create', 'view', 'edit', 'delete', 'approve']) loop
      select allowed into role_allowed from public.school_role_permission_overrides
      where school_id = target_school and role = target_role
        and module_key = module_name and action_key = action_name;
      custom_allowed := true;
      if target_custom_role is not null then
        select allowed into custom_allowed from public.school_custom_role_permissions
        where school_id = target_school and custom_role_id = target_custom_role
          and module_key = module_name and action_key = action_name;
      end if;
      module_result := module_result || jsonb_build_object(
        action_name, coalesce(custom_allowed, true) and coalesce(role_allowed, true)
      );
    end loop;
    result := result || jsonb_build_object(module_name, module_result);
  end loop;
  return result;
end;
$$;
revoke all on function public.preview_school_member_permissions(uuid, public.app_role, uuid) from public, anon;
grant execute on function public.preview_school_member_permissions(uuid, public.app_role, uuid) to authenticated;

create or replace function public.save_school_role_permission(
  target_school uuid,
  target_role public.app_role,
  target_module text,
  target_action text,
  target_allowed boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_school_role(target_school, array['school_admin']::public.app_role[]) then
    raise exception 'Only a school administrator can configure role permissions.';
  end if;
  if target_role in ('system_admin', 'school_admin') then
    raise exception 'Platform and school administrator roles cannot be edited here.';
  end if;
  if target_module not in (
    'students', 'academics', 'attendance', 'timetable', 'learning', 'assignments',
    'assessment_results', 'finance', 'library', 'health', 'visitors', 'staff',
    'admissions', 'website', 'messaging', 'audit', 'administrative_workflows'
  ) or target_action not in ('access', 'create', 'view', 'edit', 'delete', 'approve') then
    raise exception 'Choose a supported module and permission action.';
  end if;
  if target_allowed is null then
    delete from public.school_role_permission_overrides
    where school_id = target_school and role = target_role
      and module_key = target_module and action_key = target_action;
    perform public.log_school_permission_change(
      target_school, null, 'role_permission_reset',
      jsonb_build_object('role', target_role::text, 'module', target_module, 'action', target_action)
    );
    return;
  end if;
  insert into public.school_role_permission_overrides (
    school_id, role, module_key, action_key, allowed, updated_by
  ) values (target_school, target_role, target_module, target_action, target_allowed, auth.uid())
  on conflict (school_id, role, module_key, action_key) do update
  set allowed = excluded.allowed, updated_by = excluded.updated_by, updated_at = timezone('utc', now());
  perform public.log_school_permission_change(
    target_school, null, 'role_permission_changed',
    jsonb_build_object('role', target_role::text, 'module', target_module, 'action', target_action, 'allowed', target_allowed)
  );
end;
$$;
revoke all on function public.save_school_role_permission(uuid, public.app_role, text, text, boolean) from public, anon;
grant execute on function public.save_school_role_permission(uuid, public.app_role, text, text, boolean) to authenticated;

create or replace function public.save_school_custom_role(
  target_school uuid,
  target_custom_role uuid,
  role_name text,
  role_description text,
  base_role public.app_role,
  permissions jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_id uuid;
  permission_row record;
begin
  if not public.has_school_role(target_school, array['school_admin']::public.app_role[]) then
    raise exception 'Only a school administrator can configure custom roles.';
  end if;
  if base_role in ('system_admin', 'school_admin') then
    raise exception 'Custom roles cannot be based on platform or school administrator privileges.';
  end if;
  if char_length(trim(role_name)) not between 2 and 80 or char_length(coalesce(role_description, '')) > 500 then
    raise exception 'Enter a role name between 2 and 80 characters and a description of at most 500 characters.';
  end if;
  if permissions is null or jsonb_typeof(permissions) <> 'array' or jsonb_array_length(permissions) > 102 then
    raise exception 'Custom role permissions must be an array of at most 102 module/action choices.';
  end if;
  if target_custom_role is null then
    insert into public.school_custom_roles (school_id, name, description, base_role, created_by)
    values (target_school, trim(role_name), coalesce(role_description, ''), base_role, auth.uid())
    returning id into saved_id;
  else
    update public.school_custom_roles
    set name = trim(role_name), description = coalesce(role_description, ''),
        base_role = save_school_custom_role.base_role, updated_at = timezone('utc', now())
    where school_id = target_school and id = target_custom_role
    returning id into saved_id;
    if saved_id is null then raise exception 'Custom role not found.'; end if;
    if exists (select 1 from public.school_memberships where school_id = target_school and custom_role_id = saved_id and role <> base_role) then
      raise exception 'A custom role assigned to members must retain its current base role.';
    end if;
  end if;
  delete from public.school_custom_role_permissions where school_id = target_school and custom_role_id = saved_id;
  for permission_row in
    select entry ->> 'module' as module_key, entry ->> 'action' as action_key,
      (entry ->> 'allowed')::boolean as allowed
    from jsonb_array_elements(permissions) entry
  loop
    if permission_row.module_key not in (
      'students', 'academics', 'attendance', 'timetable', 'learning', 'assignments',
      'assessment_results', 'finance', 'library', 'health', 'visitors', 'staff',
      'admissions', 'website', 'messaging', 'audit', 'administrative_workflows'
    ) or permission_row.action_key not in ('access', 'create', 'view', 'edit', 'delete', 'approve') then
      raise exception 'Custom role permission contains an unsupported module or action.';
    end if;
    if permission_row.allowed is false then
      insert into public.school_custom_role_permissions (
        school_id, custom_role_id, module_key, action_key, allowed, updated_by
      ) values (
        target_school, saved_id, permission_row.module_key, permission_row.action_key, false, auth.uid()
      );
    end if;
  end loop;
  perform public.log_school_permission_change(
    target_school, null, case when target_custom_role is null then 'custom_role_created' else 'custom_role_updated' end,
    jsonb_build_object('custom_role_id', saved_id, 'name', trim(role_name), 'base_role', base_role::text)
  );
  return saved_id;
end;
$$;
revoke all on function public.save_school_custom_role(uuid, uuid, text, text, public.app_role, jsonb) from public, anon;
grant execute on function public.save_school_custom_role(uuid, uuid, text, text, public.app_role, jsonb) to authenticated;

create or replace function public.set_school_member_scopes(
  target_membership uuid,
  scopes jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.school_memberships%rowtype;
  scope_row record;
begin
  select * into target from public.school_memberships where id = target_membership;
  if not found or not public.has_school_role(target.school_id, array['school_admin']::public.app_role[]) then
    raise exception 'Membership not found or not authorized.';
  end if;
  if target.profile_id = auth.uid() then raise exception 'Administrators cannot change their own scope.'; end if;
  if scopes is null or jsonb_typeof(scopes) <> 'array' or jsonb_array_length(scopes) > 200 then
    raise exception 'Provide at most 200 class or department scopes.';
  end if;
  delete from public.school_membership_scopes where school_id = target.school_id and membership_id = target_membership;
  for scope_row in select entry ->> 'type' as scope_type, (entry ->> 'id')::uuid as scope_id
    from jsonb_array_elements(scopes) entry
  loop
    if scope_row.scope_type = 'class' and exists (
      select 1 from public.school_classes where school_id = target.school_id and id = scope_row.scope_id
    ) then
      insert into public.school_membership_scopes(school_id, membership_id, scope_type, scope_id, created_by)
      values (target.school_id, target_membership, 'class', scope_row.scope_id, auth.uid());
    elsif scope_row.scope_type = 'department' and exists (
      select 1 from public.school_departments where school_id = target.school_id and id = scope_row.scope_id
    ) then
      insert into public.school_membership_scopes(school_id, membership_id, scope_type, scope_id, created_by)
      values (target.school_id, target_membership, 'department', scope_row.scope_id, auth.uid());
    else
      raise exception 'Every scope must reference a class or department in this school.';
    end if;
  end loop;
  perform public.log_school_permission_change(
    target.school_id, target_membership, 'member_scopes_changed', jsonb_build_object('scopes', scopes)
  );
end;
$$;
revoke all on function public.set_school_member_scopes(uuid, jsonb) from public, anon;
grant execute on function public.set_school_member_scopes(uuid, jsonb) to authenticated;

create or replace function public.save_school_permission_delegation(
  target_delegation uuid,
  target_membership uuid,
  target_module text,
  target_action text,
  target_allowed boolean,
  target_starts_at timestamptz,
  target_expires_at timestamptz,
  target_paused boolean
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  member public.school_memberships%rowtype;
  saved_id uuid;
begin
  select * into member from public.school_memberships where id = target_membership;
  if not found or not public.has_school_role(member.school_id, array['school_admin']::public.app_role[]) then
    raise exception 'Membership not found or not authorized.';
  end if;
  if member.profile_id = auth.uid() then raise exception 'Administrators cannot delegate permissions to themselves.'; end if;
  if target_module not in (
    'students', 'academics', 'attendance', 'timetable', 'learning', 'assignments',
    'assessment_results', 'finance', 'library', 'health', 'visitors', 'staff',
    'admissions', 'website', 'messaging', 'audit', 'administrative_workflows'
  ) or target_action not in ('access', 'create', 'view', 'edit', 'delete', 'approve') then
    raise exception 'Choose a supported module and action.';
  end if;
  if target_starts_at is null or (target_expires_at is not null and target_expires_at <= target_starts_at) then
    raise exception 'A delegation must have a start time and an optional expiry after the start time.';
  end if;
  if target_delegation is null then
    insert into public.school_permission_delegations (
      school_id, membership_id, module_key, action_key, allowed, starts_at, expires_at, paused_at, assigned_by
    ) values (
      member.school_id, target_membership, target_module, target_action, target_allowed,
      target_starts_at, target_expires_at,
      case when target_paused then timezone('utc', now()) else null end, auth.uid()
    ) returning id into saved_id;
  else
    update public.school_permission_delegations
    set module_key = target_module, action_key = target_action, allowed = target_allowed,
        starts_at = target_starts_at, expires_at = target_expires_at,
        paused_at = case when target_paused then coalesce(paused_at, timezone('utc', now())) else null end,
        updated_at = timezone('utc', now())
    where id = target_delegation and school_id = member.school_id and membership_id = target_membership
    returning id into saved_id;
    if saved_id is null then raise exception 'Delegation not found.'; end if;
  end if;
  perform public.log_school_permission_change(
    member.school_id, target_membership, 'delegation_changed',
    jsonb_build_object('delegation_id', saved_id, 'module', target_module, 'action', target_action,
      'allowed', target_allowed, 'starts_at', target_starts_at, 'expires_at', target_expires_at, 'paused', target_paused)
  );
  return saved_id;
end;
$$;
revoke all on function public.save_school_permission_delegation(uuid, uuid, text, text, boolean, timestamptz, timestamptz, boolean) from public, anon;
grant execute on function public.save_school_permission_delegation(uuid, uuid, text, text, boolean, timestamptz, timestamptz, boolean) to authenticated;

create or replace function public.delete_school_custom_role(target_school uuid, target_custom_role uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_school_role(target_school, array['school_admin']::public.app_role[]) then
    raise exception 'Only a school administrator can delete custom roles.';
  end if;
  if exists (select 1 from public.school_memberships where school_id = target_school and custom_role_id = target_custom_role) then
    raise exception 'Reassign members using this custom role before deleting it.';
  end if;
  delete from public.school_custom_roles where school_id = target_school and id = target_custom_role;
  if not found then raise exception 'Custom role not found.'; end if;
  perform public.log_school_permission_change(
    target_school, null, 'custom_role_deleted', jsonb_build_object('custom_role_id', target_custom_role)
  );
end;
$$;
revoke all on function public.delete_school_custom_role(uuid, uuid) from public, anon;
grant execute on function public.delete_school_custom_role(uuid, uuid) to authenticated;

create or replace function public.audit_school_permission_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_school uuid;
  target_membership uuid;
begin
  target_school := case when tg_op = 'DELETE' then old.school_id else new.school_id end;
  if tg_table_name = 'school_membership_scopes' then
    target_membership := case when tg_op = 'DELETE' then old.membership_id else new.membership_id end;
  elsif tg_table_name = 'school_permission_delegations' then
    target_membership := case when tg_op = 'DELETE' then old.membership_id else new.membership_id end;
  end if;
  insert into public.school_permission_audit_events(school_id, actor_id, target_membership_id, action, details)
  values (
    target_school, auth.uid(), target_membership,
    lower(tg_op) || ':' || tg_table_name,
    jsonb_build_object(
      'old', case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
      'new', case when tg_op in ('UPDATE', 'INSERT') then to_jsonb(new) else null end
    )
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.audit_school_permission_mutation() from public, anon, authenticated;
create trigger audit_school_custom_roles after insert or update or delete on public.school_custom_roles
  for each row execute function public.audit_school_permission_mutation();
create trigger audit_school_role_permissions after insert or update or delete on public.school_role_permission_overrides
  for each row execute function public.audit_school_permission_mutation();
create trigger audit_school_custom_role_permissions after insert or update or delete on public.school_custom_role_permissions
  for each row execute function public.audit_school_permission_mutation();
create trigger audit_school_membership_scopes after insert or update or delete on public.school_membership_scopes
  for each row execute function public.audit_school_permission_mutation();
create trigger audit_school_permission_delegations after insert or update or delete on public.school_permission_delegations
  for each row execute function public.audit_school_permission_mutation();

create or replace function public.school_permission_restrictive_gate(
  target_school uuid,
  target_table text,
  target_action text,
  target_row jsonb
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  module_name text := public.school_permission_module_for_table(target_table);
begin
  if module_name is null then return true; end if;
  return public.school_permission_allowed(target_school, module_name, 'access')
    and public.school_permission_allowed(target_school, module_name, target_action)
    and public.school_record_scope_allowed(target_school, target_table, target_row);
end;
$$;
revoke all on function public.school_permission_restrictive_gate(uuid, text, text, jsonb) from public, anon;
grant execute on function public.school_permission_restrictive_gate(uuid, text, text, jsonb) to authenticated;

create or replace function public.enforce_permission_approval()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  module_name text;
begin
  if new.status is distinct from old.status
    and new.status in ('accepted', 'rejected', 'waitlisted', 'registered', 'published', 'approved') then
    module_name := public.school_permission_module_for_table(tg_table_name);
    if module_name is not null
      and not public.school_permission_allowed(new.school_id, module_name, 'approve') then
      raise exception 'You do not have permission to approve records in this module.';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_permission_approval() from public, anon, authenticated;
create trigger enforce_admission_approval_permission
  before update on public.admission_applications
  for each row execute function public.enforce_permission_approval();
create trigger enforce_website_approval_permission
  before update on public.school_website_content_versions
  for each row execute function public.enforce_permission_approval();
create trigger enforce_workflow_approval_permission
  before update on public.school_administrative_work_items
  for each row execute function public.enforce_permission_approval();

do $$
declare
  target_table record;
  table_name text;
begin
  for target_table in
    select distinct relation.relname as table_name
    from pg_class relation
    join pg_namespace schema_info on schema_info.oid = relation.relnamespace
    join information_schema.columns column_info
      on column_info.table_schema = schema_info.nspname and column_info.table_name = relation.relname
    where schema_info.nspname = 'public'
      and relation.relkind in ('r', 'p')
      and relation.relrowsecurity
      and column_info.column_name = 'school_id'
      and public.school_permission_module_for_table(relation.relname) is not null
  loop
    table_name := target_table.table_name;
    execute format(
      'drop policy if exists "School permission view gate" on public.%I', table_name
    );
    execute format(
      'drop policy if exists "School permission create gate" on public.%I', table_name
    );
    execute format(
      'drop policy if exists "School permission edit gate" on public.%I', table_name
    );
    execute format(
      'drop policy if exists "School permission delete gate" on public.%I', table_name
    );
    execute format(
      'create policy "School permission view gate" on public.%I as restrictive for select to authenticated using (school_id is null or public.school_permission_restrictive_gate(school_id, %L, ''view'', to_jsonb(%I)))',
      table_name, table_name, table_name
    );
    execute format(
      'create policy "School permission create gate" on public.%I as restrictive for insert to authenticated with check (school_id is null or public.school_permission_restrictive_gate(school_id, %L, ''create'', to_jsonb(%I)))',
      table_name, table_name, table_name
    );
    execute format(
      'create policy "School permission edit gate" on public.%I as restrictive for update to authenticated using (school_id is null or public.school_permission_restrictive_gate(school_id, %L, ''edit'', to_jsonb(%I))) with check (school_id is null or public.school_permission_restrictive_gate(school_id, %L, ''edit'', to_jsonb(%I)))',
      table_name, table_name, table_name, table_name, table_name
    );
    execute format(
      'create policy "School permission delete gate" on public.%I as restrictive for delete to authenticated using (school_id is null or public.school_permission_restrictive_gate(school_id, %L, ''delete'', to_jsonb(%I)))',
      table_name, table_name, table_name
    );
  end loop;
end;
$$;

create policy "Require school MFA for permission tables"
  on public.school_custom_roles as restrictive for all to authenticated
  using (public.school_mfa_satisfied(school_id))
  with check (public.school_mfa_satisfied(school_id));
create policy "Require school MFA for role permission overrides"
  on public.school_role_permission_overrides as restrictive for all to authenticated
  using (public.school_mfa_satisfied(school_id))
  with check (public.school_mfa_satisfied(school_id));
create policy "Require school MFA for custom role permissions"
  on public.school_custom_role_permissions as restrictive for all to authenticated
  using (public.school_mfa_satisfied(school_id))
  with check (public.school_mfa_satisfied(school_id));
create policy "Require school MFA for member scopes"
  on public.school_membership_scopes as restrictive for all to authenticated
  using (public.school_mfa_satisfied(school_id))
  with check (public.school_mfa_satisfied(school_id));
create policy "Require school MFA for permission delegations"
  on public.school_permission_delegations as restrictive for all to authenticated
  using (public.school_mfa_satisfied(school_id))
  with check (public.school_mfa_satisfied(school_id));
create policy "Require school MFA for permission history"
  on public.school_permission_audit_events as restrictive for all to authenticated
  using (public.school_mfa_satisfied(school_id))
  with check (public.school_mfa_satisfied(school_id));
