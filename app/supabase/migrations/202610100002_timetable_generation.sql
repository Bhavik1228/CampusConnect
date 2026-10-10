create table public.timetable_schedule_changes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  schedule_id uuid not null,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null check (action in ('created', 'updated', 'published', 'lesson_added', 'lesson_updated', 'lesson_removed', 'generated')),
  summary text not null,
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, schedule_id) references public.timetable_schedules(school_id, id) on delete cascade
);

create index timetable_schedule_changes_recent_idx
  on public.timetable_schedule_changes(school_id, schedule_id, created_at desc);

alter table public.timetable_schedule_changes enable row level security;

create policy "Members read timetable change history"
  on public.timetable_schedule_changes for select to authenticated
  using (
    public.can_manage_timetable(school_id)
    or (
      exists (
        select 1 from public.timetable_schedules schedule
        where schedule.id = timetable_schedule_changes.schedule_id
          and schedule.school_id = timetable_schedule_changes.school_id
          and schedule.status = 'published'
      )
      and public.is_school_member(school_id)
    )
  );

grant select on public.timetable_schedule_changes to authenticated;

create or replace function public.record_timetable_schedule_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  change_action text;
  change_summary text;
begin
  if tg_table_name = 'timetable_schedules' then
    change_action := case
      when tg_op = 'INSERT' then 'created'
      when new.status = 'published' and old.status is distinct from 'published' then 'published'
      else 'updated'
    end;
    change_summary := case change_action
      when 'created' then 'Created timetable "' || new.name || '".'
      when 'published' then 'Published timetable "' || new.name || '".'
      else 'Updated timetable "' || new.name || '".'
    end;
    insert into public.timetable_schedule_changes (school_id, schedule_id, actor_id, action, summary)
    values (new.school_id, new.id, auth.uid(), change_action, change_summary);
    return new;
  end if;

  change_action := case tg_op
    when 'INSERT' then 'lesson_added'
    when 'UPDATE' then 'lesson_updated'
    else 'lesson_removed'
  end;
  change_summary := case tg_op
    when 'INSERT' then 'Added a timetable period.'
    when 'UPDATE' then 'Updated a timetable period.'
    else 'Removed a timetable period.'
  end;

  if tg_op = 'DELETE' then
    if old.schedule_id is not null then
      insert into public.timetable_schedule_changes (school_id, schedule_id, actor_id, action, summary)
      values (old.school_id, old.schedule_id, auth.uid(), change_action, change_summary);
    end if;
    return old;
  end if;

  if new.schedule_id is not null then
    insert into public.timetable_schedule_changes (school_id, schedule_id, actor_id, action, summary)
    values (new.school_id, new.schedule_id, auth.uid(), change_action, change_summary);
  end if;
  return new;
end;
$$;

create trigger audit_timetable_schedule_changes
  after insert or update on public.timetable_schedules
  for each row execute function public.record_timetable_schedule_change();

create trigger audit_timetable_entry_changes
  after insert or update or delete on public.timetable
  for each row execute function public.record_timetable_schedule_change();

create or replace function public.validate_timetable_schedule_entry()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  schedule_status text;
begin
  if new.schedule_id is null then
    return new;
  end if;

  select schedule.status into schedule_status
  from public.timetable_schedules schedule
  where schedule.id = new.schedule_id and schedule.school_id = new.school_id;

  if schedule_status is distinct from 'draft' then
    raise exception 'Only draft timetable periods can be edited.';
  end if;

  if new.entry_type = 'lesson' and new.teacher_id is not null and not exists (
    select 1 from public.teacher_subjects assignment
    where assignment.school_id = new.school_id
      and assignment.teacher_id = new.teacher_id
      and assignment.subject_id = new.subject_id
  ) then
    raise exception 'The selected teacher is not assigned to this subject.';
  end if;

  return new;
end;
$$;

create trigger validate_timetable_schedule_entry
  before insert or update on public.timetable
  for each row execute function public.validate_timetable_schedule_entry();

create or replace function public.generate_timetable_schedule(
  target_schedule uuid,
  generated_entries jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  target_school uuid;
  current_status text;
  inserted_count integer;
begin
  if jsonb_typeof(generated_entries) <> 'array' or jsonb_array_length(generated_entries) > 2000 then
    raise exception 'Generated timetable entries must be an array with at most 2000 periods.';
  end if;

  select schedule.school_id, schedule.status
    into target_school, current_status
    from public.timetable_schedules schedule
    where schedule.id = target_schedule
    for update;

  if not found or not public.can_manage_timetable(target_school) then
    raise exception 'You are not authorized to generate this timetable.';
  end if;
  if current_status <> 'draft' then
    raise exception 'Only draft timetables can be regenerated.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(generated_entries) as entry(
      entry_type text, class_id uuid, subject_id uuid, teacher_id uuid,
      day_of_week smallint, starts_at time, ends_at time, room text, label text
    )
    where entry.entry_type not in ('lesson', 'registration', 'break', 'lunch', 'other')
      or entry.day_of_week not between 1 and 7
      or entry.starts_at is null
      or entry.ends_at is null
      or entry.ends_at <= entry.starts_at
      or (
        (entry.entry_type = 'lesson' and (entry.class_id is null or entry.subject_id is null))
        or (entry.entry_type <> 'lesson' and (entry.label is null or char_length(trim(entry.label)) = 0))
      )
  ) then
    raise exception 'The generated timetable contains an invalid period.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(generated_entries) as entry(
      class_id uuid, subject_id uuid, teacher_id uuid
    )
    left join public.school_classes class_record
      on class_record.school_id = target_school and class_record.id = entry.class_id
    left join public.subjects subject_record
      on subject_record.school_id = target_school and subject_record.id = entry.subject_id
    left join public.teacher_profiles teacher_record
      on teacher_record.school_id = target_school and teacher_record.id = entry.teacher_id
    where (entry.class_id is not null and class_record.id is null)
       or (entry.subject_id is not null and subject_record.id is null)
       or (entry.teacher_id is not null and teacher_record.id is null)
  ) then
    raise exception 'A generated period references a class, subject, or teacher outside this school.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(generated_entries) as entry(
      subject_id uuid, teacher_id uuid
    )
    where entry.teacher_id is not null
      and not exists (
        select 1 from public.teacher_subjects assignment
        where assignment.school_id = target_school
          and assignment.teacher_id = entry.teacher_id
          and assignment.subject_id = entry.subject_id
      )
  ) then
    raise exception 'A generated lesson assigns a teacher who is not assigned to that subject.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(generated_entries) as entry(
      entry_type text, day_of_week smallint, starts_at time, ends_at time,
      class_id uuid, teacher_id uuid, room text
    )
    join jsonb_to_recordset(generated_entries) as other(
      entry_type text, day_of_week smallint, starts_at time, ends_at time,
      class_id uuid, teacher_id uuid, room text
    ) on (entry.day_of_week, entry.starts_at, entry.class_id::text) < (other.day_of_week, other.starts_at, other.class_id::text)
    where entry.entry_type = 'lesson'
      and other.entry_type = 'lesson'
      and entry.day_of_week = other.day_of_week
      and entry.starts_at < other.ends_at and other.starts_at < entry.ends_at
      and (
        (entry.class_id is not null and entry.class_id = other.class_id)
        or (entry.teacher_id is not null and entry.teacher_id = other.teacher_id)
        or (entry.room is not null and entry.room <> '' and lower(trim(entry.room)) = lower(trim(other.room)))
      )
  ) then
    raise exception 'The generated timetable contains overlapping class, teacher, or room assignments.';
  end if;

  delete from public.timetable
  where school_id = target_school and schedule_id = target_schedule;

  insert into public.timetable (
    school_id, schedule_id, class_id, subject_id, teacher_id,
    day_of_week, starts_at, ends_at, room, entry_type, label
  )
  select
    target_school, target_schedule, entry.class_id, entry.subject_id, entry.teacher_id,
    entry.day_of_week, entry.starts_at, entry.ends_at, nullif(trim(entry.room), ''),
    entry.entry_type, nullif(trim(entry.label), '')
  from jsonb_to_recordset(generated_entries) as entry(
    entry_type text, class_id uuid, subject_id uuid, teacher_id uuid,
    day_of_week smallint, starts_at time, ends_at time, room text, label text
  );

  get diagnostics inserted_count = row_count;
  insert into public.timetable_schedule_changes (school_id, schedule_id, actor_id, action, summary)
  values (target_school, target_schedule, auth.uid(), 'generated', 'Generated ' || inserted_count || ' timetable periods.');
  return inserted_count;
end;
$$;

revoke all on function public.generate_timetable_schedule(uuid, jsonb) from public;
grant execute on function public.generate_timetable_schedule(uuid, jsonb) to authenticated;
