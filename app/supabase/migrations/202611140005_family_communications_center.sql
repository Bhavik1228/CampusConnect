create table public.family_communications (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 2 and 160),
  body text not null check (char_length(trim(body)) between 2 and 10000),
  class_id uuid,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, class_id)
    references public.school_classes(school_id, id) on delete restrict
);

create index family_communications_school_created_idx
  on public.family_communications(school_id, created_at desc);

create table public.family_communication_deliveries (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  communication_id uuid not null,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  delivered_at timestamptz not null default timezone('utc', now()),
  read_at timestamptz,
  unique (school_id, communication_id, profile_id),
  foreign key (school_id, communication_id)
    references public.family_communications(school_id, id) on delete cascade
);

create index family_communication_deliveries_inbox_idx
  on public.family_communication_deliveries(school_id, profile_id, delivered_at desc);

alter table public.family_communications enable row level security;
alter table public.family_communication_deliveries enable row level security;
revoke all on public.family_communications, public.family_communication_deliveries
  from public, anon, authenticated;

create or replace function public.send_family_communication(
  target_school uuid,
  communication_title text,
  communication_body text,
  target_class uuid default null
)
returns table (communication_id uuid, delivered_count integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_communication_id uuid;
  new_delivery_count integer;
begin
  if not public.has_school_role(
    target_school,
    array['school_admin', 'academic_coordinator']::public.app_role[]
  ) then
    raise exception 'School administrator access is required to send family communications.';
  end if;
  if not public.messaging_is_enabled(target_school) then
    raise exception 'Family communications are disabled for this school.';
  end if;
  if char_length(trim(coalesce(communication_title, ''))) not between 2 and 160
    or char_length(trim(coalesce(communication_body, ''))) not between 2 and 10000 then
    raise exception 'Enter a communication title and message within the permitted length.';
  end if;
  if target_class is not null and not exists (
    select 1 from public.school_classes school_class
    where school_class.school_id = target_school and school_class.id = target_class
  ) then
    raise exception 'The selected class is not part of this school.';
  end if;

  insert into public.family_communications (
    school_id, title, body, class_id, created_by
  ) values (
    target_school, trim(communication_title), trim(communication_body),
    target_class, auth.uid()
  ) returning id into new_communication_id;

  insert into public.family_communication_deliveries (
    school_id, communication_id, profile_id
  )
  select distinct target_school, new_communication_id, parent.profile_id
  from public.parent_profiles parent
  join public.parent_students family_link
    on family_link.school_id = parent.school_id
    and family_link.parent_id = parent.id
  join public.students student
    on student.school_id = family_link.school_id
    and student.id = family_link.student_id
  join public.school_memberships membership
    on membership.school_id = parent.school_id
    and membership.profile_id = parent.profile_id
    and membership.role = 'parent'
  where parent.school_id = target_school
    and parent.profile_id is not null
    and student.status = 'active'
    and (
      target_class is null
      or student.class_id = target_class
      or exists (
        select 1 from public.class_students class_link
        where class_link.school_id = target_school
          and class_link.student_id = student.id
          and class_link.class_id = target_class
      )
    );

  get diagnostics new_delivery_count = row_count;
  if new_delivery_count = 0 then
    raise exception 'No linked parent accounts were found for the selected family audience.';
  end if;

  return query select new_communication_id, new_delivery_count;
end;
$$;

create or replace function public.list_family_communications(target_school uuid)
returns table (
  communication_id uuid,
  title text,
  body text,
  class_name text,
  created_at timestamptz,
  delivery_id uuid,
  delivered_at timestamptz,
  read_at timestamptz,
  recipient_count bigint,
  read_count bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_school_member(target_school) then
    raise exception 'You do not have access to this school.';
  end if;
  if not public.messaging_is_enabled(target_school) then
    raise exception 'Family communications are disabled for this school.';
  end if;

  if public.has_school_role(
    target_school,
    array['school_admin', 'academic_coordinator']::public.app_role[]
  ) then
    return query
    select
      communication.id,
      communication.title,
      communication.body,
      school_class.name,
      communication.created_at,
      null::uuid,
      null::timestamptz,
      null::timestamptz,
      count(delivery.id),
      count(delivery.id) filter (where delivery.read_at is not null)
    from public.family_communications communication
    left join public.school_classes school_class
      on school_class.school_id = communication.school_id
      and school_class.id = communication.class_id
    left join public.family_communication_deliveries delivery
      on delivery.school_id = communication.school_id
      and delivery.communication_id = communication.id
    where communication.school_id = target_school
    group by communication.id, school_class.name
    order by communication.created_at desc;
    return;
  end if;

  if public.has_school_role(target_school, array['parent']::public.app_role[]) then
    return query
    select
      communication.id,
      communication.title,
      communication.body,
      school_class.name,
      communication.created_at,
      delivery.id,
      delivery.delivered_at,
      delivery.read_at,
      0::bigint,
      0::bigint
    from public.family_communication_deliveries delivery
    join public.family_communications communication
      on communication.school_id = delivery.school_id
      and communication.id = delivery.communication_id
    left join public.school_classes school_class
      on school_class.school_id = communication.school_id
      and school_class.id = communication.class_id
    where delivery.school_id = target_school
      and delivery.profile_id = auth.uid()
    order by communication.created_at desc;
    return;
  end if;

  return;
end;
$$;

create or replace function public.mark_family_communication_read(target_delivery uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.family_communication_deliveries delivery
  set read_at = coalesce(delivery.read_at, timezone('utc', now()))
  where delivery.id = target_delivery
    and delivery.profile_id = auth.uid()
    and public.has_school_role(delivery.school_id, array['parent']::public.app_role[])
    and public.messaging_is_enabled(delivery.school_id);

  if not found then
    raise exception 'The family communication is unavailable or your access has changed.';
  end if;
end;
$$;

revoke all on function public.send_family_communication(uuid, text, text, uuid) from public;
revoke all on function public.list_family_communications(uuid) from public;
revoke all on function public.mark_family_communication_read(uuid) from public;
grant execute on function public.send_family_communication(uuid, text, text, uuid) to authenticated;
grant execute on function public.list_family_communications(uuid) to authenticated;
grant execute on function public.mark_family_communication_read(uuid) to authenticated;
