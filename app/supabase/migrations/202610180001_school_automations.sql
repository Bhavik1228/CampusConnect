create table public.school_automations (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  category text not null check (category in (
    'academics', 'attendance', 'assignments', 'finance', 'communication',
    'health', 'library', 'events', 'administration', 'other'
  )),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'failed', 'disabled')),
  trigger_type text not null default 'schedule' check (trigger_type = 'schedule'),
  trigger_config jsonb not null default '{"frequency":"daily","time":"08:00"}'::jsonb
    check (
      jsonb_typeof(trigger_config) = 'object'
      and trigger_config ->> 'frequency' in ('daily', 'weekly')
      and trigger_config ->> 'time' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      and (trigger_config ->> 'frequency' <> 'weekly'
        or coalesce((trigger_config ->> 'weekday')::integer between 0 and 6, false))
    ),
  conditions jsonb not null default '{"weekdays_only":false}'::jsonb
    check (jsonb_typeof(conditions) = 'object'),
  action_type text not null check (action_type in ('notification', 'announcement')),
  action_config jsonb not null check (jsonb_typeof(action_config) = 'object'),
  owner_id uuid not null references public.profiles(id),
  permitted_user_ids uuid[] not null default '{}',
  permitted_roles public.app_role[] not null default '{}',
  created_by uuid not null references public.profiles(id),
  estimated_minutes_saved smallint not null default 5 check (estimated_minutes_saved between 1 and 240),
  last_run_at timestamptz,
  next_run_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  check (not ('system_admin'::public.app_role = any(permitted_roles)))
);

create index school_automations_due_idx
  on public.school_automations(next_run_at)
  where status = 'active' and next_run_at is not null;
create index school_automations_school_updated_idx
  on public.school_automations(school_id, updated_at desc);

create table public.school_automation_runs (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  automation_id uuid not null,
  status text not null check (status in ('successful', 'skipped', 'failed')),
  run_source text not null default 'scheduled' check (run_source in ('scheduled', 'manual', 'test')),
  is_test boolean not null default false,
  started_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz,
  initiated_by uuid references public.profiles(id) on delete set null,
  summary text not null default '',
  details jsonb not null default '{}'::jsonb,
  error_message text,
  foreign key (school_id, automation_id)
    references public.school_automations(school_id, id) on delete cascade
);

create index school_automation_runs_history_idx
  on public.school_automation_runs(school_id, started_at desc);
create index school_automation_runs_workflow_idx
  on public.school_automation_runs(school_id, automation_id, started_at desc);

alter table public.school_module_settings
  add column module_automations boolean not null default true;

create or replace function public.is_school_automation_manager(target_school uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_school_role(
    target_school,
    array['school_admin', 'academic_coordinator']::public.app_role[]
  );
$$;

create or replace function public.can_manage_school_automation(target_automation uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.school_automations automation
    join public.school_memberships membership
      on membership.school_id = automation.school_id
      and membership.profile_id = auth.uid()
    where automation.id = target_automation
      and (
        public.is_school_automation_manager(automation.school_id)
        or automation.owner_id = auth.uid()
        or auth.uid() = any(automation.permitted_user_ids)
        or membership.role = any(automation.permitted_roles)
      )
  );
$$;

create or replace function public.next_school_automation_run(
  target_school uuid,
  target_config jsonb,
  after_time timestamptz default now()
)
returns timestamptz
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  school_timezone text;
  frequency text;
  run_time time;
  target_weekday integer;
  local_candidate timestamp;
  candidate timestamptz;
  day_offset integer;
begin
  select timezone into school_timezone from public.schools where id = target_school;
  if not found then
    raise exception 'Automation school was not found.';
  end if;
  frequency := target_config ->> 'frequency';
  run_time := (target_config ->> 'time')::time;
  target_weekday := case when frequency = 'weekly' then (target_config ->> 'weekday')::integer else null end;
  if frequency not in ('daily', 'weekly') then
    raise exception 'Choose a daily or weekly schedule.';
  end if;
  for day_offset in 0..8 loop
    local_candidate := ((after_time at time zone school_timezone)::date + day_offset) + run_time;
    candidate := local_candidate at time zone school_timezone;
    if candidate <= after_time then continue; end if;
    if frequency = 'weekly' and extract(dow from local_candidate)::integer <> target_weekday then continue; end if;
    return candidate;
  end loop;
  raise exception 'Could not calculate the next automation run.';
end;
$$;

create or replace function public.set_school_automation_schedule()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'active' then
    if length(trim(coalesce(new.action_config ->> 'title', ''))) not between 2 and 160 then
      raise exception 'Action title must be between 2 and 160 characters before activation.';
    end if;
    if length(trim(coalesce(new.action_config ->> 'body', ''))) not between 3 and 5000 then
      raise exception 'Action message must be between 3 and 5000 characters before activation.';
    end if;
    if jsonb_typeof(new.conditions -> 'weekdays_only') not in ('boolean', 'null') then
      raise exception 'Automation conditions are invalid.';
    end if;
    if new.action_type = 'notification' then
      if jsonb_typeof(new.action_config -> 'recipient_roles') <> 'array'
        or jsonb_array_length(new.action_config -> 'recipient_roles') = 0 then
        raise exception 'Choose at least one notification recipient role before activation.';
      end if;
      if exists (
        select 1 from jsonb_array_elements_text(new.action_config -> 'recipient_roles') recipient(role)
        where recipient.role not in (
          'school_admin', 'academic_coordinator', 'teacher', 'student', 'parent',
          'finance_manager', 'accountant', 'bursar', 'cashier', 'nurse', 'doctor', 'secretary'
        )
      ) then
        raise exception 'Notification recipient roles contain an unsupported role.';
      end if;
      if nullif(new.action_config ->> 'target_path', '') is not null
        and (new.action_config ->> 'target_path' !~ '^/' or new.action_config ->> 'target_path' ~ '^//') then
        raise exception 'Notification destination must be a safe in-app path.';
      end if;
    elsif new.action_type = 'announcement'
      and coalesce(new.action_config ->> 'audience', '') not in ('school', 'staff', 'students', 'parents') then
      raise exception 'Choose a valid announcement audience before activation.';
    end if;
    if tg_op = 'INSERT' then
      new.next_run_at := public.next_school_automation_run(new.school_id, new.trigger_config, now());
    elsif new.status is distinct from old.status
      or new.trigger_config is distinct from old.trigger_config then
      new.next_run_at := public.next_school_automation_run(new.school_id, new.trigger_config, now());
    else
      new.next_run_at := old.next_run_at;
    end if;
  else
    new.next_run_at := null;
  end if;
  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

create trigger school_automations_schedule_update
  before insert or update of status, trigger_config, action_type, action_config, conditions on public.school_automations
  for each row execute function public.set_school_automation_schedule();

create trigger school_automations_updated_at
  before update on public.school_automations
  for each row execute function public.set_updated_at();

alter table public.school_automations enable row level security;
alter table public.school_automation_runs enable row level security;

create policy "School members read permitted automations"
  on public.school_automations for select to authenticated
  using (
    public.is_school_member(school_id)
    and (
      public.is_school_automation_manager(school_id)
      or owner_id = auth.uid()
      or auth.uid() = any(permitted_user_ids)
      or exists (
        select 1 from public.school_memberships membership
        where membership.school_id = school_automations.school_id
          and membership.profile_id = auth.uid()
          and membership.role = any(school_automations.permitted_roles)
      )
    )
  );

create policy "Automation managers create school automations"
  on public.school_automations for insert to authenticated
  with check (
    public.is_school_automation_manager(school_id)
    and created_by = auth.uid()
    and exists (
      select 1 from public.school_memberships membership
      where membership.school_id = school_automations.school_id
        and membership.profile_id = owner_id
    )
    and permitted_user_ids <@ array(
      select membership.profile_id from public.school_memberships membership
      where membership.school_id = school_automations.school_id
    )
  );

create policy "Permitted users manage school automations"
  on public.school_automations for update to authenticated
  using (public.can_manage_school_automation(id))
  with check (
    public.can_manage_school_automation(id)
    and exists (
      select 1 from public.school_memberships membership
      where membership.school_id = school_automations.school_id
        and membership.profile_id = owner_id
    )
    and permitted_user_ids <@ array(
      select membership.profile_id from public.school_memberships membership
      where membership.school_id = school_automations.school_id
    )
  );

create policy "Automation managers and owners delete automations"
  on public.school_automations for delete to authenticated
  using (
    public.is_school_automation_manager(school_id)
    or (owner_id = auth.uid() and public.is_school_member(school_id))
  );

create policy "Permitted users read automation run history"
  on public.school_automation_runs for select to authenticated
  using (public.can_manage_school_automation(automation_id));

create or replace function public.execute_school_automation(
  target_automation uuid,
  test_only boolean,
  actor_id uuid,
  run_source text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  workflow public.school_automations%rowtype;
  school_name text;
  recipient_count integer := 0;
  announcement_id uuid;
  run_id uuid;
  rendered_title text;
  rendered_body text;
  weekday_number integer;
begin
  select * into workflow from public.school_automations
  where id = target_automation for update;
  if not found then raise exception 'Automation not found.'; end if;
  if not test_only and workflow.status <> 'active' then
    raise exception 'Only active automations can run.';
  end if;

  insert into public.school_automation_runs (
    school_id, automation_id, status, run_source, is_test, initiated_by, summary, details
  ) values (
    workflow.school_id, workflow.id, 'successful', run_source, test_only, actor_id,
    case when test_only then 'Configuration validated. No action was sent.' else 'Automation action completed.' end,
    jsonb_build_object('test_only', test_only, 'action_type', workflow.action_type)
  ) returning id into run_id;

  if test_only then
    update public.school_automation_runs set completed_at = now() where id = run_id;
    update public.school_automations set last_run_at = now() where id = workflow.id;
    return run_id;
  end if;

  begin
  select name into school_name from public.schools where id = workflow.school_id;
  rendered_title := replace(coalesce(workflow.action_config ->> 'title', ''), '{school_name}', school_name);
  rendered_title := replace(rendered_title, '{date}', (now() at time zone (select timezone from public.schools where id = workflow.school_id))::date::text);
  rendered_body := replace(coalesce(workflow.action_config ->> 'body', ''), '{school_name}', school_name);
  rendered_body := replace(rendered_body, '{date}', (now() at time zone (select timezone from public.schools where id = workflow.school_id))::date::text);

  if length(trim(rendered_title)) < 2 or length(trim(rendered_title)) > 160 then
    raise exception 'Action title must be between 2 and 160 characters.';
  end if;
  if length(trim(rendered_body)) < 3 or length(rendered_body) > 5000 then
    raise exception 'Action message must be between 3 and 5000 characters.';
  end if;

  if workflow.conditions @> '{"weekdays_only":true}'::jsonb then
    weekday_number := extract(isodow from now() at time zone (select timezone from public.schools where id = workflow.school_id))::integer;
    if weekday_number > 5 then
      update public.school_automation_runs
      set status = 'skipped', summary = 'Skipped because the condition allows weekdays only.',
          completed_at = now(), details = details || '{"condition":"weekdays_only"}'::jsonb
      where id = run_id;
      update public.school_automations set last_run_at = now() where id = workflow.id;
      return run_id;
    end if;
  end if;

  if workflow.action_type = 'notification' then
    if jsonb_typeof(workflow.action_config -> 'recipient_roles') <> 'array'
      or jsonb_array_length(workflow.action_config -> 'recipient_roles') = 0 then
      raise exception 'Choose at least one recipient role for the notification.';
    end if;
    insert into public.notifications (school_id, profile_id, title, body, target_path)
    select workflow.school_id, membership.profile_id, rendered_title, rendered_body,
      nullif(workflow.action_config ->> 'target_path', '')
    from public.school_memberships membership
    where membership.school_id = workflow.school_id
      and membership.role::text in (
        select jsonb_array_elements_text(workflow.action_config -> 'recipient_roles')
      );
    get diagnostics recipient_count = row_count;
    if recipient_count = 0 then
      update public.school_automation_runs
      set status = 'skipped', summary = 'No active school members match the selected recipient roles.',
          completed_at = now(), details = details || jsonb_build_object('recipient_count', 0)
      where id = run_id;
    else
      update public.school_automation_runs
      set summary = format('In-app notification sent to %s school member(s).', recipient_count),
          completed_at = now(), details = details || jsonb_build_object('recipient_count', recipient_count)
      where id = run_id;
    end if;
  elsif workflow.action_type = 'announcement' then
    if workflow.action_config ->> 'audience' not in ('school', 'staff', 'students', 'parents') then
      raise exception 'Choose a valid school announcement audience.';
    end if;
    insert into public.announcements (school_id, author_id, title, content, audience, published_at)
    values (workflow.school_id, workflow.owner_id, rendered_title, rendered_body,
      (workflow.action_config ->> 'audience')::public.audience_type, now())
    returning id into announcement_id;
    update public.school_automation_runs
    set summary = 'School announcement published.',
        completed_at = now(), details = details || jsonb_build_object('announcement_id', announcement_id)
    where id = run_id;
  else
    raise exception 'This automation action is not supported.';
  end if;

  update public.school_automations set last_run_at = now() where id = workflow.id;
  return run_id;
  exception when others then
  if run_id is not null then
    update public.school_automation_runs
    set status = 'failed', summary = 'Automation action failed.',
        error_message = left(sqlerrm, 1000), completed_at = now()
    where id = run_id;
    update public.school_automations set status = 'failed' where id = workflow.id;
  end if;
  return run_id;
  end;
end;
$$;

create or replace function public.run_school_automation(target_automation uuid, test_only boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  workflow public.school_automations%rowtype;
  run_id uuid;
  run_record public.school_automation_runs%rowtype;
begin
  select * into workflow from public.school_automations where id = target_automation;
  if not found then raise exception 'Automation not found.'; end if;
  if not public.can_manage_school_automation(target_automation) then
    raise exception 'You are not permitted to run this automation.';
  end if;
  if not test_only and not public.is_school_automation_manager(workflow.school_id) then
    raise exception 'Only a school administrator or academic coordinator can run an automation immediately.';
  end if;
  run_id := public.execute_school_automation(
    target_automation,
    test_only,
    auth.uid(),
    case when test_only then 'test' else 'manual' end
  );
  if run_id is null then raise exception 'The automation run could not be recorded.'; end if;
  select * into run_record from public.school_automation_runs where id = run_id;
  return jsonb_build_object(
    'status', run_record.status,
    'summary', run_record.summary,
    'error_message', run_record.error_message
  );
end;
$$;

create or replace function public.run_due_school_automations()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  workflow public.school_automations%rowtype;
  execution_count integer := 0;
  next_run timestamptz;
  current_status text;
begin
  for workflow in
    select * from public.school_automations
    where status = 'active' and next_run_at <= now()
    order by next_run_at
    limit 100
    for update skip locked
  loop
    perform public.execute_school_automation(workflow.id, false, workflow.owner_id, 'scheduled');
    select status into current_status from public.school_automations where id = workflow.id;
    if current_status = 'active' then
      next_run := public.next_school_automation_run(workflow.school_id, workflow.trigger_config, now());
      update public.school_automations set next_run_at = next_run where id = workflow.id;
    end if;
    execution_count := execution_count + 1;
  end loop;
  return execution_count;
end;
$$;

revoke all on function public.is_school_automation_manager(uuid) from public, anon;
revoke all on function public.can_manage_school_automation(uuid) from public, anon;
revoke all on function public.next_school_automation_run(uuid, jsonb, timestamptz) from public, anon;
grant execute on function public.is_school_automation_manager(uuid) to authenticated;
grant execute on function public.can_manage_school_automation(uuid) to authenticated;
revoke all on function public.execute_school_automation(uuid, boolean, uuid, text) from public, anon, authenticated;
revoke all on function public.run_due_school_automations() from public, anon, authenticated;
revoke all on function public.run_school_automation(uuid, boolean) from public, anon;
grant execute on function public.run_school_automation(uuid, boolean) to authenticated;

grant select, insert, update, delete on public.school_automations to authenticated;
grant select on public.school_automation_runs to authenticated;

select cron.unschedule(jobid)
from cron.job
where jobname = 'campus-connect-school-automations';

select cron.schedule(
  'campus-connect-school-automations',
  '* * * * *',
  'select public.run_due_school_automations()'
);
