alter table public.students
  add column merged_into_student_id uuid;

alter table public.students
  add constraint students_merged_into_student_fk
  foreign key (school_id, merged_into_student_id)
  references public.students(school_id, id) on delete restrict,
  add constraint students_cannot_merge_into_self
  check (merged_into_student_id is null or merged_into_student_id <> id);

create index students_merged_into_idx
  on public.students(school_id, merged_into_student_id)
  where merged_into_student_id is not null;

create table public.student_academic_year_history (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null,
  academic_year_id uuid not null,
  class_id uuid not null,
  enrolled_at date not null default current_date,
  ended_at date,
  recorded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, student_id) references public.students(school_id, id) on delete cascade,
  foreign key (school_id, academic_year_id) references public.academic_years(school_id, id) on delete restrict,
  foreign key (school_id, class_id) references public.school_classes(school_id, id) on delete restrict,
  check (ended_at is null or ended_at >= enrolled_at)
);
create index student_academic_year_history_student_idx
  on public.student_academic_year_history(school_id, student_id, enrolled_at desc);

alter table public.student_emergency_contacts
  drop constraint if exists student_emergency_contacts_school_id_student_id_is_primary_key;
create unique index student_emergency_contacts_one_primary_idx
  on public.student_emergency_contacts(school_id, student_id)
  where is_primary;

with lifecycle_events as (
  select record.*,
    lead(record.event_date) over (
      partition by record.school_id, record.student_id
      order by record.event_date, record.created_at
    ) as next_event_date
  from public.student_lifecycle_records record
), class_enrolments as (
  select distinct on (record.school_id, record.student_id, record.new_class_id, record.event_date)
    record.school_id, record.student_id, school_class.academic_year_id,
    record.new_class_id as class_id, record.event_date as enrolled_at,
    case when record.next_event_date is null then null
      else greatest(record.event_date, record.next_event_date - 1) end as ended_at,
    record.recorded_by
  from lifecycle_events record
  join public.school_classes school_class
    on school_class.school_id = record.school_id and school_class.id = record.new_class_id
  where record.new_class_id is not null
    and school_class.academic_year_id is not null
    and record.event_type in ('enrollment', 'class_transfer')
  order by record.school_id, record.student_id, record.new_class_id, record.event_date, record.created_at
)
insert into public.student_academic_year_history (
  school_id, student_id, academic_year_id, class_id, enrolled_at, ended_at, recorded_by
)
select school_id, student_id, academic_year_id, class_id, enrolled_at, ended_at, recorded_by
from class_enrolments;

insert into public.student_academic_year_history (
  school_id, student_id, academic_year_id, class_id, enrolled_at
)
select roster.school_id, roster.student_id, school_class.academic_year_id, roster.class_id, roster.enrolled_at
from public.class_students roster
join public.school_classes school_class
  on school_class.school_id = roster.school_id and school_class.id = roster.class_id
where school_class.academic_year_id is not null
  and not exists (
    select 1 from public.student_academic_year_history existing
    where existing.school_id = roster.school_id and existing.student_id = roster.student_id
      and existing.academic_year_id = school_class.academic_year_id
      and existing.class_id = roster.class_id and existing.enrolled_at = roster.enrolled_at
  );

create table public.student_record_audit_events (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null,
  related_student_id uuid,
  event_type text not null check (event_type in ('correction', 'merge')),
  reason text not null check (char_length(trim(reason)) between 3 and 1000),
  before_data jsonb not null check (jsonb_typeof(before_data) = 'object'),
  after_data jsonb not null check (jsonb_typeof(after_data) = 'object'),
  actor_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, student_id) references public.students(school_id, id) on delete cascade,
  foreign key (school_id, related_student_id) references public.students(school_id, id) on delete set null (related_student_id)
);
create index student_record_audit_events_student_idx
  on public.student_record_audit_events(school_id, student_id, created_at desc);

alter table public.student_academic_year_history enable row level security;
alter table public.student_record_audit_events enable row level security;
revoke all on public.student_academic_year_history, public.student_record_audit_events from anon, authenticated;
grant select on public.student_academic_year_history, public.student_record_audit_events to authenticated;

create policy "School admins read student academic history"
  on public.student_academic_year_history for select to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "School admins read student record audit events"
  on public.student_record_audit_events for select to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "Hide merged student records from active workspace"
  on public.students as restrictive for all to authenticated
  using (
    merged_into_student_id is null
    or public.has_school_role(school_id, array['school_admin']::public.app_role[])
  )
  with check (
    merged_into_student_id is null
    or public.has_school_role(school_id, array['school_admin']::public.app_role[])
  );
create policy "Require school MFA for student history and corrections"
  on public.student_academic_year_history as restrictive for all to authenticated
  using (public.school_mfa_satisfied(school_id))
  with check (public.school_mfa_satisfied(school_id));
create policy "Require school MFA for student record audit"
  on public.student_record_audit_events as restrictive for all to authenticated
  using (public.school_mfa_satisfied(school_id))
  with check (public.school_mfa_satisfied(school_id));

create or replace function public.record_student_academic_year_history()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  next_academic_year uuid;
begin
  if current_setting('app.student_merge', true) = 'on' then return new; end if;

  if tg_op = 'INSERT' then
    if new.class_id is null or new.status <> 'active' then return new; end if;
  else
    if old.class_id is not distinct from new.class_id and old.status is not distinct from new.status then
      return new;
    end if;
    if old.class_id is not null then
      update public.student_academic_year_history
      set ended_at = greatest(enrolled_at, current_date)
      where school_id = old.school_id and student_id = old.id and class_id = old.class_id
        and ended_at is null;
    end if;
    if new.class_id is null or new.status <> 'active' then return new; end if;
  end if;

  if new.class_id is not null then
    select academic_year_id into next_academic_year
    from public.school_classes
    where school_id = new.school_id and id = new.class_id;
    if next_academic_year is not null then
      insert into public.student_academic_year_history (
        school_id, student_id, academic_year_id, class_id, recorded_by
      ) values (new.school_id, new.id, next_academic_year, new.class_id, auth.uid());
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.record_student_academic_year_history() from public, anon, authenticated;
create trigger record_student_academic_year_history
  after insert or update of class_id, status on public.students
  for each row execute function public.record_student_academic_year_history();

create or replace function public.record_student_lifecycle_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  event_kind text;
begin
  if current_setting('app.student_merge', true) = 'on' then return new; end if;
  if tg_op = 'INSERT' then
    insert into public.student_lifecycle_records (
      school_id, student_id, event_type, new_status, new_class_id, recorded_by
    ) values (
      new.school_id, new.id, 'enrollment', new.status, new.class_id, auth.uid()
    );
    return new;
  end if;
  if old.status is distinct from new.status then
    event_kind := case new.status
      when 'transferred' then 'school_transfer'
      when 'withdrawn' then 'withdrawal'
      else 'status_change'
    end;
  elsif old.class_id is distinct from new.class_id then
    event_kind := case when old.class_id is null then 'enrollment' else 'class_transfer' end;
  else
    return new;
  end if;
  insert into public.student_lifecycle_records (
    school_id, student_id, event_type, previous_status, new_status,
    previous_class_id, new_class_id, destination_school, reason, recorded_by
  ) values (
    new.school_id, new.id, event_kind, old.status, new.status,
    old.class_id, new.class_id,
    nullif(current_setting('app.student_destination_school', true), ''),
    nullif(current_setting('app.student_movement_reason', true), ''),
    auth.uid()
  );
  return new;
end;
$$;
revoke all on function public.record_student_lifecycle_change() from public, anon, authenticated;

create or replace function public.save_student_record_controlled(
  target_school uuid,
  target_student uuid,
  student_data jsonb
)
returns table (student_id uuid, student_number text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  before_snapshot jsonb;
  saved record;
  after_snapshot jsonb;
  correction_reason text := nullif(trim(student_data ->> 'correction_reason'), '');
begin
  if not public.has_school_role(target_school, array['school_admin']::public.app_role[])
    or not public.school_mfa_satisfied(target_school) then
    raise exception 'A school administrator who satisfies the school MFA policy is required.';
  end if;
  if target_student is not null then
    if correction_reason is null or char_length(correction_reason) not between 3 and 1000 then
      raise exception 'Enter a correction reason between 3 and 1000 characters.';
    end if;
    select jsonb_build_object(
      'student', to_jsonb(student),
      'private_profile', coalesce(to_jsonb(private_profile), '{}'::jsonb),
      'emergency_contacts', coalesce((
        select jsonb_agg(to_jsonb(contact) order by contact.is_primary desc, contact.created_at)
        from public.student_emergency_contacts contact
        where contact.school_id = target_school and contact.student_id = target_student
      ), '[]'::jsonb)
    ) into before_snapshot
    from public.students student
    left join public.student_private_profiles private_profile
      on private_profile.school_id = student.school_id and private_profile.student_id = student.id
    where student.school_id = target_school and student.id = target_student
      and student.merged_into_student_id is null;
    if before_snapshot is null then raise exception 'Student not found or already merged.'; end if;
  end if;

  select * into saved
  from public.save_student_record(target_school, target_student, student_data);

  if target_student is not null then
    select jsonb_build_object(
      'student', to_jsonb(student),
      'private_profile', coalesce(to_jsonb(private_profile), '{}'::jsonb),
      'emergency_contacts', coalesce((
        select jsonb_agg(to_jsonb(contact) order by contact.is_primary desc, contact.created_at)
        from public.student_emergency_contacts contact
        where contact.school_id = target_school and contact.student_id = saved.student_id
      ), '[]'::jsonb)
    ) into after_snapshot
    from public.students student
    left join public.student_private_profiles private_profile
      on private_profile.school_id = student.school_id and private_profile.student_id = student.id
    where student.school_id = target_school and student.id = saved.student_id;

    insert into public.student_record_audit_events (
      school_id, student_id, event_type, reason, before_data, after_data, actor_id
    ) values (
      target_school, saved.student_id, 'correction', correction_reason,
      before_snapshot, after_snapshot, auth.uid()
    );
  end if;
  return query select saved.student_id, saved.student_number;
end;
$$;
revoke all on function public.save_student_record_controlled(uuid, uuid, jsonb) from public, anon;
grant execute on function public.save_student_record_controlled(uuid, uuid, jsonb) to authenticated;
revoke all on function public.save_student_record(uuid, uuid, jsonb) from public, anon, authenticated;

create or replace function public.merge_student_records(
  target_school uuid,
  survivor_student uuid,
  duplicate_student uuid,
  merge_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  survivor public.students%rowtype;
  duplicate public.students%rowtype;
  table_row record;
  before_snapshot jsonb;
begin
  if not public.has_school_role(target_school, array['school_admin']::public.app_role[])
    or not public.school_mfa_satisfied(target_school) then
    raise exception 'A school administrator who satisfies the school MFA policy is required.';
  end if;
  if survivor_student = duplicate_student then raise exception 'Choose two different student records.'; end if;
  if char_length(trim(coalesce(merge_reason, ''))) not between 3 and 1000 then
    raise exception 'Enter a merge reason between 3 and 1000 characters.';
  end if;

  select * into survivor from public.students
  where school_id = target_school and id = survivor_student and merged_into_student_id is null
  for update;
  if not found then raise exception 'The surviving student record was not found or is already merged.'; end if;
  select * into duplicate from public.students
  where school_id = target_school and id = duplicate_student and merged_into_student_id is null
  for update;
  if not found then raise exception 'The duplicate student record was not found or is already merged.'; end if;
  if survivor.profile_id is not null and duplicate.profile_id is not null
    and survivor.profile_id <> duplicate.profile_id then
    raise exception 'These records are linked to different student accounts. Resolve the account links before merging.';
  end if;

  before_snapshot := jsonb_build_object(
    'survivor', to_jsonb(survivor),
    'duplicate', to_jsonb(duplicate)
  );

  update public.student_private_profiles survivor_profile
  set phone = coalesce(survivor_profile.phone, duplicate_profile.phone),
      address = coalesce(survivor_profile.address, duplicate_profile.address),
      city = coalesce(survivor_profile.city, duplicate_profile.city),
      region = coalesce(survivor_profile.region, duplicate_profile.region),
      postal_code = coalesce(survivor_profile.postal_code, duplicate_profile.postal_code),
      country = coalesce(survivor_profile.country, duplicate_profile.country),
      gender = coalesce(survivor_profile.gender, duplicate_profile.gender),
      nationality = coalesce(survivor_profile.nationality, duplicate_profile.nationality),
      admission_date = least(survivor_profile.admission_date, duplicate_profile.admission_date),
      updated_at = timezone('utc', now())
  from public.student_private_profiles duplicate_profile
  where survivor_profile.school_id = target_school and survivor_profile.student_id = survivor_student
    and duplicate_profile.school_id = target_school and duplicate_profile.student_id = duplicate_student;
  insert into public.student_private_profiles (
    school_id, student_id, phone, address, city, region, postal_code, country,
    gender, nationality, admission_date, updated_at
  )
  select target_school, survivor_student, duplicate_profile.phone, duplicate_profile.address,
    duplicate_profile.city, duplicate_profile.region, duplicate_profile.postal_code,
    duplicate_profile.country, duplicate_profile.gender, duplicate_profile.nationality,
    duplicate_profile.admission_date, timezone('utc', now())
  from public.student_private_profiles duplicate_profile
  where duplicate_profile.school_id = target_school and duplicate_profile.student_id = duplicate_student
    and not exists (
      select 1 from public.student_private_profiles survivor_profile
      where survivor_profile.school_id = target_school and survivor_profile.student_id = survivor_student
    );
  delete from public.student_private_profiles
  where school_id = target_school and student_id = duplicate_student;

  update public.student_emergency_contacts
  set is_primary = false
  where school_id = target_school and student_id = duplicate_student;
  delete from public.class_students duplicate_roster
  where duplicate_roster.school_id = target_school and duplicate_roster.student_id = duplicate_student
    and exists (
      select 1 from public.class_students survivor_roster
      where survivor_roster.school_id = target_school
        and survivor_roster.student_id = survivor_student
        and survivor_roster.class_id = duplicate_roster.class_id
    );
  delete from public.parent_students duplicate_guardian
  where duplicate_guardian.school_id = target_school and duplicate_guardian.student_id = duplicate_student
    and exists (
      select 1 from public.parent_students survivor_guardian
      where survivor_guardian.school_id = target_school
        and survivor_guardian.student_id = survivor_student
        and survivor_guardian.parent_id = duplicate_guardian.parent_id
    );

  update public.student_academic_year_history
  set ended_at = greatest(enrolled_at, current_date)
  where school_id = target_school and student_id = duplicate_student and ended_at is null;

  for table_row in
    select distinct relation.relname as table_name
    from pg_class relation
    join pg_namespace schema_info on schema_info.oid = relation.relnamespace
    join information_schema.columns student_column
      on student_column.table_schema = schema_info.nspname
      and student_column.table_name = relation.relname and student_column.column_name = 'student_id'
    join information_schema.columns school_column
      on school_column.table_schema = schema_info.nspname
      and school_column.table_name = relation.relname and school_column.column_name = 'school_id'
    where schema_info.nspname = 'public' and relation.relkind in ('r', 'p')
      and relation.relname not in ('student_private_profiles', 'class_students', 'parent_students')
  loop
    execute format(
      'update public.%I set student_id = $1 where school_id = $2 and student_id = $3',
      table_row.table_name
    ) using survivor_student, target_school, duplicate_student;
  end loop;

  update public.admission_applications
  set registered_student_id = survivor_student
  where school_id = target_school and registered_student_id = duplicate_student;

  update public.students set
    class_id = coalesce(survivor.class_id, duplicate.class_id),
    first_name = coalesce(nullif(trim(survivor.first_name), ''), duplicate.first_name),
    last_name = coalesce(nullif(trim(survivor.last_name), ''), duplicate.last_name),
    email = coalesce(survivor.email, duplicate.email),
    date_of_birth = coalesce(survivor.date_of_birth, duplicate.date_of_birth),
    profile_id = coalesce(survivor.profile_id, duplicate.profile_id),
    updated_at = timezone('utc', now())
  where school_id = target_school and id = survivor_student;

  perform set_config('app.student_merge', 'on', true);
  update public.students set class_id = null, status = 'inactive',
    profile_id = null, merged_into_student_id = survivor_student, updated_at = timezone('utc', now())
  where school_id = target_school and id = duplicate_student;

  insert into public.student_record_audit_events (
    school_id, student_id, related_student_id, event_type, reason, before_data, after_data, actor_id
  ) values (
    target_school, survivor_student, duplicate_student, 'merge', trim(merge_reason),
    before_snapshot,
    jsonb_build_object(
      'survivor', to_jsonb((select student from public.students student
        where student.school_id = target_school and student.id = survivor_student)),
      'merged_record_id', duplicate_student
    ),
    auth.uid()
  );
exception
  when unique_violation then
    raise exception 'These records cannot be merged because they contain conflicting linked records. Resolve duplicate attendance, submissions, assessment, or other unique records before retrying.';
end;
$$;
revoke all on function public.merge_student_records(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.merge_student_records(uuid, uuid, uuid, text) to authenticated;
