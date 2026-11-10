create table public.student_behaviour_settings (
  school_id uuid primary key references public.schools(id) on delete cascade,
  points_enabled boolean not null default false,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.student_behaviour_types (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 100),
  category text not null check (category in ('positive', 'negative')),
  description text not null default '' check (char_length(description) <= 500),
  points integer,
  active boolean not null default true,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, name),
  check (points is null or points between -1000 and 1000),
  check (category <> 'positive' or points is null or points >= 0),
  check (category <> 'negative' or points is null or points <= 0)
);

create table public.student_behaviour_actions (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 100),
  description text not null default '' check (char_length(description) <= 500),
  active boolean not null default true,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, name)
);

create table public.student_behaviour_records (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null,
  behaviour_type_id uuid not null,
  action_id uuid,
  reported_by uuid not null references public.profiles(id),
  reported_by_name text not null default '',
  occurred_at timestamptz not null,
  location text not null default '' check (char_length(location) <= 200),
  description text not null check (char_length(trim(description)) between 3 and 5000),
  actions_taken text not null default '' check (char_length(actions_taken) <= 3000),
  student_name text not null default '',
  student_number text not null default '',
  class_name text not null default '',
  school_name text not null default '',
  behaviour_type_name text not null default '',
  category text not null default 'negative' check (category in ('positive', 'negative')),
  points_awarded integer,
  action_name text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, student_id) references public.students(school_id, id) on delete cascade,
  foreign key (school_id, behaviour_type_id) references public.student_behaviour_types(school_id, id),
  foreign key (school_id, action_id) references public.student_behaviour_actions(school_id, id),
  check (points_awarded is null or points_awarded between -1000 and 1000)
);

create table public.student_behaviour_record_participants (
  school_id uuid not null references public.schools(id) on delete cascade,
  record_id uuid not null,
  student_id uuid not null,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (record_id, student_id),
  foreign key (school_id, record_id) references public.student_behaviour_records(school_id, id) on delete cascade,
  foreign key (school_id, student_id) references public.students(school_id, id) on delete cascade
);

create index student_behaviour_records_school_occurred_idx
  on public.student_behaviour_records(school_id, occurred_at desc);
create index student_behaviour_records_student_occurred_idx
  on public.student_behaviour_records(school_id, student_id, occurred_at desc);
create index student_behaviour_record_participants_student_idx
  on public.student_behaviour_record_participants(school_id, student_id);

create or replace function public.initialize_student_behaviour_defaults()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.student_behaviour_settings (school_id)
  values (new.id)
  on conflict (school_id) do nothing;
  insert into public.student_behaviour_types (school_id, name, category, description, created_by)
  values
    (new.id, 'Positive contribution', 'positive', 'A positive behaviour, contribution, or act of responsibility.', new.created_by),
    (new.id, 'Behaviour concern', 'negative', 'A behaviour concern requiring a clear factual record.', new.created_by)
  on conflict (school_id, name) do nothing;
  return new;
end;
$$;

create trigger initialize_student_behaviour_defaults_after_school_insert
  after insert on public.schools
  for each row execute function public.initialize_student_behaviour_defaults();

insert into public.student_behaviour_settings (school_id)
select id from public.schools
on conflict (school_id) do nothing;

insert into public.student_behaviour_types (school_id, name, category, description, created_by)
select school.id, defaults.name, defaults.category, defaults.description, school.created_by
from public.schools school
cross join (values
  ('Positive contribution', 'positive', 'A positive behaviour, contribution, or act of responsibility.'),
  ('Behaviour concern', 'negative', 'A behaviour concern requiring a clear factual record.')
) as defaults(name, category, description)
on conflict (school_id, name) do nothing;

create or replace function public.can_access_student_behaviour(target_school uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.school_memberships membership
    where membership.school_id = target_school
      and membership.profile_id = auth.uid()
      and membership.role::text in (
        'school_admin', 'academic_coordinator', 'teacher', 'librarian',
        'secretary', 'hr_staff_administrator', 'safeguarding_officer'
      )
  );
$$;

create or replace function public.list_student_behaviour_students(target_school uuid)
returns table (
  id uuid,
  student_number text,
  first_name text,
  last_name text,
  class_name text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.can_access_student_behaviour(target_school) then
    raise exception 'Your school role cannot access student behaviour records.';
  end if;

  return query
  select student.id, student.student_number, student.first_name, student.last_name,
    coalesce(class.name, '')
  from public.students student
  left join public.school_classes class
    on class.school_id = student.school_id and class.id = student.class_id
  where student.school_id = target_school
    and student.status = 'active'
    and student.merged_into_student_id is null
  order by student.last_name, student.first_name;
end;
$$;

create or replace function public.snapshot_student_behaviour_record()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  school_name_snapshot text;
  student_row public.students%rowtype;
  type_row public.student_behaviour_types%rowtype;
  action_row public.student_behaviour_actions%rowtype;
  reporter_name text;
  points_enabled boolean;
begin
  if not public.can_access_student_behaviour(new.school_id) then
    raise exception 'Your school role cannot record student behaviour.';
  end if;

  if tg_op = 'UPDATE' then
    if new.school_id is distinct from old.school_id
      or new.student_id is distinct from old.student_id
      or new.behaviour_type_id is distinct from old.behaviour_type_id
      or new.reported_by is distinct from old.reported_by then
      raise exception 'The school, student, behaviour type, and reporter cannot be changed after recording.';
    end if;

    if new.action_id is distinct from old.action_id then
      if new.action_id is not null then
        select * into action_row
        from public.student_behaviour_actions
        where school_id = new.school_id and id = new.action_id and active;
        if not found then raise exception 'Choose an active follow-up action.'; end if;
        new.action_name := action_row.name;
      else
        new.action_name := null;
      end if;
    else
      new.action_name := old.action_name;
    end if;
    new.student_name := old.student_name;
    new.student_number := old.student_number;
    new.class_name := old.class_name;
    new.school_name := old.school_name;
    new.behaviour_type_name := old.behaviour_type_name;
    new.reported_by_name := old.reported_by_name;
    new.category := old.category;
    new.points_awarded := old.points_awarded;
    new.updated_at := timezone('utc', now());
    return new;
  end if;

  select * into student_row
  from public.students
  where school_id = new.school_id and id = new.student_id
    and status = 'active' and merged_into_student_id is null;
  if not found then raise exception 'Choose an active student in this school.'; end if;

  select * into type_row
  from public.student_behaviour_types
  where school_id = new.school_id and id = new.behaviour_type_id and active;
  if not found then raise exception 'Choose an active behaviour record type.'; end if;

  if new.action_id is not null then
    select * into action_row
    from public.student_behaviour_actions
    where school_id = new.school_id and id = new.action_id and active;
    if not found then raise exception 'Choose an active follow-up action.'; end if;
    new.action_name := action_row.name;
  else
    new.action_name := null;
  end if;

  select settings.points_enabled into points_enabled
  from public.student_behaviour_settings settings
  where settings.school_id = new.school_id;
  select nullif(trim(profile.full_name), '') into reporter_name
  from public.profiles profile
  where profile.id = auth.uid();
  select school.name into school_name_snapshot
  from public.schools school
  where school.id = new.school_id;

  new.student_name := concat_ws(' ', student_row.first_name, student_row.last_name);
  new.student_number := student_row.student_number;
  select coalesce(class.name, '') into new.class_name
  from public.school_classes class
  where class.school_id = student_row.school_id and class.id = student_row.class_id;
  new.class_name := coalesce(new.class_name, '');
  new.school_name := coalesce(school_name_snapshot, 'School');
  new.behaviour_type_name := type_row.name;
  new.reported_by_name := coalesce(reporter_name, 'School staff');
  new.category := type_row.category;
  new.points_awarded := case when coalesce(points_enabled, false) then type_row.points else null end;
  new.updated_at := timezone('utc', now());
  new.reported_by := auth.uid();
  return new;
end;
$$;

create trigger snapshot_student_behaviour_record_before_write
  before insert or update on public.student_behaviour_records
  for each row execute function public.snapshot_student_behaviour_record();

create trigger set_student_behaviour_settings_updated_at
  before update on public.student_behaviour_settings
  for each row execute function public.set_updated_at();
create trigger set_student_behaviour_types_updated_at
  before update on public.student_behaviour_types
  for each row execute function public.set_updated_at();
create trigger set_student_behaviour_actions_updated_at
  before update on public.student_behaviour_actions
  for each row execute function public.set_updated_at();

create or replace function public.create_student_behaviour_record(
  target_school uuid,
  target_student uuid,
  target_behaviour_type uuid,
  target_action uuid,
  target_occurred_at timestamptz,
  target_location text,
  target_description text,
  target_actions_taken text,
  involved_student_ids uuid[] default '{}'::uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  created_record_id uuid;
  participant_ids uuid[] := coalesce(involved_student_ids, '{}'::uuid[]);
begin
  if auth.uid() is null or not public.can_access_student_behaviour(target_school) then
    raise exception 'Your school role cannot record student behaviour.';
  end if;
  if cardinality(participant_ids) > 100 then
    raise exception 'A behaviour report cannot include more than 100 additional students.';
  end if;
  if exists (
    select 1
    from unnest(participant_ids) as participants(student_id)
    where participants.student_id is null
      or participants.student_id = target_student
      or not exists (
        select 1 from public.students student
        where student.school_id = target_school and student.id = participants.student_id
          and student.status = 'active' and student.merged_into_student_id is null
      )
  ) then
    raise exception 'Choose only active students from this school as additional participants.';
  end if;

  insert into public.student_behaviour_records (
    school_id, student_id, behaviour_type_id, action_id, reported_by,
    occurred_at, location, description, actions_taken
  ) values (
    target_school, target_student, target_behaviour_type, target_action, auth.uid(),
    target_occurred_at, coalesce(target_location, ''), target_description, coalesce(target_actions_taken, '')
  ) returning id into created_record_id;

  insert into public.student_behaviour_record_participants (school_id, record_id, student_id)
  select target_school, created_record_id, participant_id
  from (select distinct unnest(array_remove(participant_ids, target_student)) as participant_id) participants;
  return created_record_id;
end;
$$;

alter table public.student_behaviour_settings enable row level security;
alter table public.student_behaviour_types enable row level security;
alter table public.student_behaviour_actions enable row level security;
alter table public.student_behaviour_records enable row level security;
alter table public.student_behaviour_record_participants enable row level security;

revoke all on public.student_behaviour_settings, public.student_behaviour_types,
  public.student_behaviour_actions, public.student_behaviour_records,
  public.student_behaviour_record_participants from anon, authenticated;
grant select on public.student_behaviour_settings, public.student_behaviour_types,
  public.student_behaviour_actions, public.student_behaviour_records,
  public.student_behaviour_record_participants to authenticated;
grant insert, update on public.student_behaviour_settings,
  public.student_behaviour_types, public.student_behaviour_actions to authenticated;
grant update on public.student_behaviour_records to authenticated;

create policy "Behaviour staff read settings"
  on public.student_behaviour_settings for select to authenticated
  using (public.can_access_student_behaviour(school_id));
create policy "School admins manage behaviour settings"
  on public.student_behaviour_settings for all to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));

create policy "Behaviour staff read record types"
  on public.student_behaviour_types for select to authenticated
  using (public.can_access_student_behaviour(school_id));
create policy "School admins manage record types"
  on public.student_behaviour_types for all to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));

create policy "Behaviour staff read follow-up actions"
  on public.student_behaviour_actions for select to authenticated
  using (public.can_access_student_behaviour(school_id));
create policy "School admins manage follow-up actions"
  on public.student_behaviour_actions for all to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));

create policy "Behaviour staff and linked parents read reports"
  on public.student_behaviour_records for select to authenticated
  using (
    public.can_access_student_behaviour(school_id)
    or public.is_parent_of_student(school_id, student_id)
  );
create policy "Behaviour staff create reports"
  on public.student_behaviour_records for insert to authenticated
  with check (
    reported_by = auth.uid()
    and public.can_access_student_behaviour(school_id)
  );
create policy "Authors and admins update reports"
  on public.student_behaviour_records for update to authenticated
  using (
    public.can_access_student_behaviour(school_id)
    and (reported_by = auth.uid() or public.has_school_role(school_id, array['school_admin']::public.app_role[]))
  )
  with check (
    public.can_access_student_behaviour(school_id)
    and (reported_by = auth.uid() or public.has_school_role(school_id, array['school_admin']::public.app_role[]))
  );
create policy "Behaviour staff manage report participants"
  on public.student_behaviour_record_participants for all to authenticated
  using (public.can_access_student_behaviour(school_id))
  with check (
    public.can_access_student_behaviour(school_id)
    and exists (
      select 1 from public.student_behaviour_records report
      where report.school_id = student_behaviour_record_participants.school_id
        and report.id = student_behaviour_record_participants.record_id
    )
  );

revoke all on function public.can_access_student_behaviour(uuid) from public, anon;
revoke all on function public.list_student_behaviour_students(uuid) from public, anon;
revoke all on function public.create_student_behaviour_record(uuid, uuid, uuid, uuid, timestamptz, text, text, text, uuid[]) from public, anon;
revoke all on function public.initialize_student_behaviour_defaults() from public, anon, authenticated;
revoke all on function public.snapshot_student_behaviour_record() from public, anon, authenticated;
grant execute on function public.can_access_student_behaviour(uuid) to authenticated;
grant execute on function public.list_student_behaviour_students(uuid) to authenticated;
grant execute on function public.create_student_behaviour_record(uuid, uuid, uuid, uuid, timestamptz, text, text, text, uuid[]) to authenticated;

notify pgrst, 'reload schema';
