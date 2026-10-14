alter table public.schools
  add column platform_status text not null default 'active'
    check (platform_status in ('active', 'suspended')),
  add column managed_storage_enabled boolean not null default false;

create or replace function public.protect_system_owned_school_settings()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if auth.role() is distinct from 'service_role'
    and (
      new.platform_status is distinct from old.platform_status
      or new.managed_storage_enabled is distinct from old.managed_storage_enabled
    ) then
    raise exception 'Platform owner authorization is required to change platform school settings.';
  end if;
  return new;
end;
$$;

create trigger protect_system_owned_school_settings
  before update on public.schools
  for each row execute function public.protect_system_owned_school_settings();

create table public.managed_storage_requests (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  requested_by uuid not null references public.profiles(id),
  message text not null default '' check (char_length(message) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id)
);
create unique index managed_storage_requests_one_pending_per_school_idx
  on public.managed_storage_requests(school_id)
  where status = 'pending';

create table public.platform_activity (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  target_type text not null,
  target_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);
create index platform_activity_created_idx on public.platform_activity(created_at desc);

alter table public.managed_storage_requests enable row level security;
alter table public.platform_activity enable row level security;
revoke all on public.managed_storage_requests from anon, authenticated;
revoke all on public.platform_activity from anon, authenticated;
grant all on public.managed_storage_requests to service_role;
grant all on public.platform_activity to service_role;

create or replace function public.is_school_member(target_school uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.school_memberships membership
    join public.schools school on school.id = membership.school_id
    where membership.school_id = target_school
      and membership.profile_id = auth.uid()
      and school.platform_status = 'active'
  );
$$;

create or replace function public.has_school_role(target_school uuid, allowed_roles public.app_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.school_memberships membership
    join public.schools school on school.id = membership.school_id
    where membership.school_id = target_school
      and membership.profile_id = auth.uid()
      and membership.role = any(allowed_roles)
      and school.platform_status = 'active'
  );
$$;

create or replace function public.is_teacher_for_class(target_school uuid, target_class uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.teacher_class_assignments assignment
    join public.teacher_profiles teacher on teacher.id = assignment.teacher_id
    join public.schools school on school.id = assignment.school_id
    where assignment.school_id = target_school
      and assignment.class_id = target_class
      and teacher.profile_id = auth.uid()
      and school.platform_status = 'active'
  );
$$;

create or replace function public.is_teacher_record_for_class(target_school uuid, target_class uuid, target_teacher uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.teacher_class_assignments assignment
    join public.teacher_profiles teacher on teacher.id = assignment.teacher_id
    join public.schools school on school.id = assignment.school_id
    where assignment.school_id = target_school
      and assignment.class_id = target_class
      and assignment.teacher_id = target_teacher
      and teacher.profile_id = auth.uid()
      and school.platform_status = 'active'
  );
$$;

create or replace function public.is_parent_of_student(target_school uuid, target_student uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.parent_students relationship
    join public.parent_profiles parent on parent.id = relationship.parent_id
    join public.schools school on school.id = relationship.school_id
    where relationship.school_id = target_school
      and relationship.student_id = target_student
      and parent.profile_id = auth.uid()
      and school.platform_status = 'active'
  );
$$;

create or replace function public.is_student_in_class(target_school uuid, target_class uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.class_students roster
    join public.students student on student.id = roster.student_id
    join public.schools school on school.id = roster.school_id
    where roster.school_id = target_school
      and roster.class_id = target_class
      and student.profile_id = auth.uid()
      and school.platform_status = 'active'
  );
$$;

create or replace function public.is_parent_of_class_student(target_school uuid, target_class uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.class_students roster
    join public.schools school on school.id = roster.school_id
    where roster.school_id = target_school
      and roster.class_id = target_class
      and school.platform_status = 'active'
      and public.is_parent_of_student(target_school, roster.student_id)
  );
$$;

create or replace function public.can_manage_timetable(target_school uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_school_role(target_school, array['school_admin']::public.app_role[])
    or exists (
      select 1
      from public.school_memberships membership
      join public.schools school on school.id = membership.school_id
      where membership.school_id = target_school
        and membership.profile_id = auth.uid()
        and membership.role::text = 'academic_coordinator'
        and school.platform_status = 'active'
    );
$$;

create or replace function public.platform_owner_dashboard()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'stats', jsonb_build_object(
      'schools', (select count(*) from public.schools),
      'activeSchools', (select count(*) from public.schools where platform_status = 'active'),
      'suspendedSchools', (select count(*) from public.schools where platform_status = 'suspended'),
      'users', (select count(*) from public.profiles),
      'students', (select count(*) from public.students),
      'teachers', (select count(*) from public.teacher_profiles),
      'pendingStorageRequests', (select count(*) from public.managed_storage_requests where status = 'pending')
    ),
    'roles', coalesce((
      select jsonb_agg(jsonb_build_object('role', role_name, 'users', user_count) order by role_name)
      from (
        select membership.role::text as role_name, count(distinct membership.profile_id) as user_count
        from public.school_memberships membership
        group by membership.role
      ) role_counts
    ), '[]'::jsonb),
    'recentSchools', coalesce((
      select jsonb_agg(to_jsonb(recent_school) order by recent_school.created_at desc)
      from (
        select id, name, platform_status, managed_storage_enabled, created_at
        from public.schools
        order by created_at desc
        limit 10
      ) recent_school
    ), '[]'::jsonb),
    'recentActivity', coalesce((
      select jsonb_agg(to_jsonb(recent_event) order by recent_event.created_at desc)
      from (
        select * from (
          select
            activity.id,
            activity.action,
            activity.target_type,
            activity.target_id,
            activity.details,
            activity.created_at,
            actor.full_name as actor_name
          from public.platform_activity activity
          left join public.profiles actor on actor.id = activity.actor_id
          union all
          select
            school_log.id,
            school_log.action,
            school_log.target_table as target_type,
            school_log.target_id,
            jsonb_build_object('school_name', school.name) || school_log.metadata as details,
            school_log.created_at,
            actor.full_name as actor_name
          from public.audit_logs school_log
          join public.schools school on school.id = school_log.school_id
          left join public.profiles actor on actor.id = school_log.actor_id
        ) activity_feed
        order by created_at desc
        limit 10
      ) recent_event
    ), '[]'::jsonb),
    'storageRequests', coalesce((
      select jsonb_agg(to_jsonb(recent_request) order by recent_request.created_at desc)
      from (
        select
          request.id,
          request.school_id,
          school.name as school_name,
          request.requested_by,
          requester.full_name as requester_name,
          requester.email as requester_email,
          request.message,
          request.status,
          request.created_at
        from public.managed_storage_requests request
        join public.schools school on school.id = request.school_id
        left join public.profiles requester on requester.id = request.requested_by
        where request.status = 'pending'
        order by request.created_at desc
        limit 20
      ) recent_request
    ), '[]'::jsonb),
    'alerts', jsonb_build_object(
      'schoolsWithoutAdmin', (
        select count(*)
        from public.schools school
        where not exists (
          select 1 from public.school_memberships membership
          where membership.school_id = school.id and membership.role = 'school_admin'
        )
      ),
      'suspendedSchools', (select count(*) from public.schools where platform_status = 'suspended')
    )
  );
$$;

revoke all on function public.platform_owner_dashboard() from public, anon, authenticated;
grant execute on function public.platform_owner_dashboard() to service_role;
