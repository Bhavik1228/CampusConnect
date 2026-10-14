create table public.platform_maintenance (
  id smallint primary key default 1 check (id = 1),
  global_enabled boolean not null default false,
  global_read_only boolean not null default false,
  emergency_enabled boolean not null default false,
  notice text not null default '' check (char_length(notice) <= 2000),
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default timezone('utc', now())
);
insert into public.platform_maintenance (id) values (1) on conflict (id) do nothing;
alter table public.platform_maintenance enable row level security;
revoke all on public.platform_maintenance from anon, authenticated;
grant all on public.platform_maintenance to service_role;

create table public.platform_maintenance_windows (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('global', 'school', 'module')),
  school_id uuid references public.schools(id) on delete cascade,
  module_key text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  read_only boolean not null default false,
  notice text not null default '' check (char_length(notice) <= 2000),
  cancelled_at timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  check ((scope = 'global' and school_id is null and module_key is null)
    or (scope = 'school' and school_id is not null and module_key is null)
    or (scope = 'module' and school_id is not null and module_key is not null)),
  check (ends_at is null or ends_at > starts_at)
);
create index platform_maintenance_windows_schedule_idx
  on public.platform_maintenance_windows(starts_at, ends_at)
  where cancelled_at is null;
create index platform_maintenance_windows_school_idx
  on public.platform_maintenance_windows(school_id, starts_at)
  where cancelled_at is null;
alter table public.platform_maintenance_windows enable row level security;
revoke all on public.platform_maintenance_windows from anon, authenticated;
grant all on public.platform_maintenance_windows to service_role;

create or replace function public.platform_maintenance_status(target_school uuid default null, target_module text default null)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with candidates as (
    select
      'global'::text as scope,
      maintenance.global_read_only as read_only,
      maintenance.notice,
      null::timestamptz as ends_at,
      maintenance.emergency_enabled as emergency,
      0 as priority
    from public.platform_maintenance maintenance
    where maintenance.id = 1 and maintenance.global_enabled
    union all
    select
      'global'::text,
      schedule.read_only,
      schedule.notice,
      schedule.ends_at,
      false,
      0
    from public.platform_maintenance_windows schedule
    where schedule.scope = 'global'
      and schedule.cancelled_at is null
      and schedule.starts_at <= now()
      and (schedule.ends_at is null or schedule.ends_at > now())
    union all
    select
      'school'::text,
      schedule.read_only,
      schedule.notice,
      schedule.ends_at,
      false,
      1
    from public.platform_maintenance_windows schedule
    where schedule.scope = 'school'
      and target_school is not null
      and schedule.school_id = target_school
      and schedule.cancelled_at is null
      and schedule.starts_at <= now()
      and (schedule.ends_at is null or schedule.ends_at > now())
    union all
    select
      'module'::text,
      schedule.read_only,
      schedule.notice,
      schedule.ends_at,
      false,
      2
    from public.platform_maintenance_windows schedule
    where schedule.scope = 'module'
      and target_school is not null
      and schedule.school_id = target_school
      and schedule.module_key = target_module
      and schedule.cancelled_at is null
      and schedule.starts_at <= now()
      and (schedule.ends_at is null or schedule.ends_at > now())
  )
  select jsonb_build_object(
    'active', exists (select 1 from candidates),
    'scope', (select scope from candidates order by priority, read_only asc limit 1),
    'read_only', coalesce((select bool_and(read_only) from candidates), false),
    'notice', coalesce((select notice from candidates order by priority, read_only asc limit 1), ''),
    'ends_at', (select ends_at from candidates order by priority, read_only asc limit 1),
    'emergency', coalesce((select emergency from candidates order by priority, read_only asc limit 1), false)
  );
$$;
revoke all on function public.platform_maintenance_status(uuid, text) from public;
grant execute on function public.platform_maintenance_status(uuid, text) to anon, authenticated, service_role;

create or replace function public.platform_public_branding()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'platform_name', settings.platform_name,
    'logo_url', settings.logo_url,
    'favicon_url', settings.favicon_url,
    'maintenance_notice', coalesce(nullif(status ->> 'notice', ''), settings.maintenance_notice),
    'maintenance_active', coalesce((status ->> 'active')::boolean, false),
    'maintenance_read_only', coalesce((status ->> 'read_only')::boolean, false)
  )
  from public.platform_settings settings
  cross join lateral public.platform_maintenance_status() status
  where settings.id = 1;
$$;
revoke all on function public.platform_public_branding() from public;
grant execute on function public.platform_public_branding() to anon, authenticated;

create or replace function public.enforce_maintenance_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  old_school uuid;
  new_school uuid;
  module_key text;
  maintenance_state jsonb;
begin
  if auth.role() = 'service_role' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op <> 'INSERT' then
    old_school := nullif(to_jsonb(old) ->> 'school_id', '')::uuid;
  end if;
  if tg_op <> 'DELETE' then
    new_school := nullif(to_jsonb(new) ->> 'school_id', '')::uuid;
  end if;
  module_key := case
    when tg_table_name like 'attendance%' then 'attendance'
    when tg_table_name like 'timetable%' or tg_table_name like 'bell_schedule%' or tg_table_name like 'academic_bell%' then 'timetable'
    when tg_table_name like 'assignment%' or tg_table_name like 'submission%' then 'assignments'
    when tg_table_name like 'assessment%' or tg_table_name like 'grade%' or tg_table_name like 'report_card%' or tg_table_name like 'school_report%' or tg_table_name = 'learning_assessment_results' then 'grades'
    when tg_table_name like 'learning_material%' or tg_table_name like 'learning_assessment%' or tg_table_name like 'course%' or tg_table_name like 'lesson%' or tg_table_name = 'past_papers' then 'learning'
    when tg_table_name like 'fee%' or tg_table_name like 'student_fee%' or tg_table_name like 'payment%' or tg_table_name like 'finance%' or tg_table_name like 'accounting%' then 'finance'
    when tg_table_name like '%message%' or tg_table_name like '%conversation%' or tg_table_name like 'managed_storage%' then 'messaging'
    when tg_table_name like 'admission%' then 'admissions'
    when tg_table_name like 'staff%' or tg_table_name like 'teacher%' or tg_table_name like 'department%' or tg_table_name like 'school_department%' then 'staff'
    when tg_table_name like 'student%' or tg_table_name like 'parent%' or tg_table_name like 'emergency_contact%' then 'students'
    when tg_table_name like '%calendar%' or tg_table_name like 'term%' then 'calendar'
    when tg_table_name like 'academic%' or tg_table_name like 'school_class%' or tg_table_name like 'class_%' or tg_table_name like 'subject%' then 'academics'
    when tg_table_name like 'announcement%' or tg_table_name like 'event%' or tg_table_name like 'notification%' then 'communication'
    else null
  end;

  if old_school is not null then
    maintenance_state := public.platform_maintenance_status(old_school, module_key);
    if coalesce((maintenance_state ->> 'active')::boolean, false) then
      raise exception 'This school or feature is under maintenance. Changes are temporarily disabled.';
    end if;
  end if;
  if new_school is not null and new_school is distinct from old_school then
    maintenance_state := public.platform_maintenance_status(new_school, module_key);
    if coalesce((maintenance_state ->> 'active')::boolean, false) then
      raise exception 'This school or feature is under maintenance. Changes are temporarily disabled.';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.enforce_maintenance_write() from public, anon, authenticated;

create or replace function public.enforce_school_registry_maintenance_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  school_key uuid;
  maintenance_state jsonb;
begin
  if auth.role() = 'service_role' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op <> 'INSERT' then
    school_key := old.id;
  else
    school_key := new.id;
  end if;
  maintenance_state := public.platform_maintenance_status(school_key, null);
  if coalesce((maintenance_state ->> 'active')::boolean, false) then
    raise exception 'This school or the platform is under maintenance. School changes are temporarily disabled.';
  end if;

  if tg_op = 'UPDATE' and new.id is distinct from old.id then
    maintenance_state := public.platform_maintenance_status(new.id, null);
    if coalesce((maintenance_state ->> 'active')::boolean, false) then
      raise exception 'This school or the platform is under maintenance. School changes are temporarily disabled.';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.enforce_school_registry_maintenance_write() from public, anon, authenticated;
create trigger enforce_school_registry_maintenance_write
  before insert or update or delete on public.schools
  for each row execute function public.enforce_school_registry_maintenance_write();

do $$
declare
  scoped_table record;
begin
  for scoped_table in
    select column_record.table_name
    from information_schema.columns column_record
    join information_schema.tables table_record
      on table_record.table_schema = column_record.table_schema
      and table_record.table_name = column_record.table_name
    where column_record.table_schema = 'public'
      and column_record.column_name = 'school_id'
      and table_record.table_type = 'BASE TABLE'
      and column_record.table_name not in ('platform_maintenance_windows')
  loop
    execute format(
      'create trigger enforce_maintenance_write before insert or update or delete on public.%I for each row execute function public.enforce_maintenance_write()',
      scoped_table.table_name
    );
  end loop;
end;
$$;
