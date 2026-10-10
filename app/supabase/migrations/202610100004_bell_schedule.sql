alter table public.academic_calendar_weeks
  add column cycle_week smallint not null default 1
    check (cycle_week between 1 and 2);

create table public.academic_bell_schedules (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  calendar_id uuid not null,
  week_pattern_id uuid not null,
  name text not null check (char_length(trim(name)) between 2 and 100),
  cycle_weeks smallint not null default 1 check (cycle_weeks in (1, 2)),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, calendar_id, week_pattern_id, name),
  foreign key (school_id, calendar_id, week_pattern_id)
    references public.academic_calendar_week_patterns(school_id, calendar_id, id)
    on delete cascade
);

create table public.academic_bell_periods (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  bell_schedule_id uuid not null,
  cycle_week smallint not null default 1 check (cycle_week between 1 and 2),
  day_of_week smallint not null check (day_of_week between 1 and 7),
  period_number smallint not null check (period_number between 1 and 24),
  name text not null check (char_length(trim(name)) between 1 and 80),
  period_type text not null
    check (period_type in ('lesson', 'break', 'lunch', 'assembly', 'registration', 'other')),
  starts_at time not null,
  ends_at time not null,
  allows_double boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (bell_schedule_id, cycle_week, day_of_week, period_number),
  foreign key (school_id, bell_schedule_id)
    references public.academic_bell_schedules(school_id, id) on delete cascade,
  check (ends_at > starts_at),
  check (period_type = 'lesson' or not allows_double)
);

create table public.academic_bell_period_subjects (
  school_id uuid not null,
  period_id uuid not null,
  subject_id uuid not null,
  primary key (period_id, subject_id),
  foreign key (school_id, period_id)
    references public.academic_bell_periods(school_id, id) on delete cascade,
  foreign key (school_id, subject_id)
    references public.subjects(school_id, id) on delete cascade
);

alter table public.timetable_schedules
  add column bell_schedule_id uuid,
  add column cycle_weeks smallint not null default 1 check (cycle_weeks in (1, 2)),
  add constraint timetable_schedules_bell_schedule_fk
    foreign key (school_id, bell_schedule_id)
    references public.academic_bell_schedules(school_id, id) on delete restrict;

alter table public.timetable
  add column cycle_week smallint not null default 1 check (cycle_week between 1 and 2),
  add column bell_period_id uuid,
  add constraint timetable_bell_period_fk
    foreign key (school_id, bell_period_id)
    references public.academic_bell_periods(school_id, id) on delete restrict;

create index academic_bell_periods_lookup_idx
  on public.academic_bell_periods(school_id, bell_schedule_id, cycle_week, day_of_week, starts_at);
create index academic_bell_schedules_calendar_idx
  on public.academic_bell_schedules(school_id, calendar_id, week_pattern_id);

create or replace function public.validate_timetable_bell_schedule()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  bell_calendar uuid;
  bell_pattern uuid;
  bell_cycle_weeks smallint;
begin
  if new.bell_schedule_id is null then
    new.cycle_weeks := 1;
  else
    select bell.calendar_id, bell.week_pattern_id, bell.cycle_weeks
      into bell_calendar, bell_pattern, bell_cycle_weeks
      from public.academic_bell_schedules bell
      where bell.id = new.bell_schedule_id and bell.school_id = new.school_id;
    if not found then
      raise exception 'The bell schedule does not belong to this school.';
    end if;
    if new.calendar_id <> bell_calendar or new.week_pattern_id <> bell_pattern then
      raise exception 'The selected bell schedule must use the timetable calendar and week pattern.';
    end if;
    new.cycle_weeks := bell_cycle_weeks;
  end if;

  if tg_op = 'UPDATE' and new.bell_schedule_id is distinct from old.bell_schedule_id
      and exists (
        select 1 from public.timetable entry
        where entry.school_id = old.school_id and entry.schedule_id = old.id
      ) then
    raise exception 'Remove timetable entries before changing its bell schedule.';
  end if;
  if tg_op = 'UPDATE' and new.cycle_weeks < old.cycle_weeks and exists (
    select 1 from public.timetable entry
    where entry.school_id = old.school_id
      and entry.schedule_id = old.id
      and entry.cycle_week > new.cycle_weeks
  ) then
    raise exception 'Remove entries from the disabled cycle week before changing the timetable cycle.';
  end if;
  return new;
end;
$$;

create trigger validate_timetable_bell_schedule
  before insert or update of bell_schedule_id, calendar_id, week_pattern_id, cycle_weeks on public.timetable_schedules
  for each row execute function public.validate_timetable_bell_schedule();

create or replace function public.validate_bell_schedule_cycle_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.cycle_weeks = 1 and exists (
    select 1 from public.academic_bell_periods period
    where period.school_id = new.school_id
      and period.bell_schedule_id = new.id
      and period.cycle_week = 2
  ) then
    raise exception 'Remove Week B periods before switching this bell schedule to a one-week cycle.';
  end if;
  if exists (
    select 1 from public.timetable_schedules schedule
    where schedule.school_id = new.school_id
      and schedule.bell_schedule_id = new.id
      and schedule.status = 'published'
      and schedule.cycle_weeks <> new.cycle_weeks
  ) then
    raise exception 'A published timetable uses this bell schedule cycle and must be updated first.';
  end if;
  return new;
end;
$$;

create trigger validate_bell_schedule_cycle_change
  before update of cycle_weeks on public.academic_bell_schedules
  for each row execute function public.validate_bell_schedule_cycle_change();

create or replace function public.sync_timetable_bell_cycle()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update public.timetable_schedules
  set cycle_weeks = new.cycle_weeks
  where school_id = new.school_id
    and bell_schedule_id = new.id
    and status = 'draft';
  return new;
end;
$$;

create trigger sync_timetable_bell_cycle
  after update of cycle_weeks on public.academic_bell_schedules
  for each row execute function public.sync_timetable_bell_cycle();

create or replace function public.prevent_bell_schedule_pattern_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (new.calendar_id, new.week_pattern_id) is distinct from (old.calendar_id, old.week_pattern_id)
      and exists (
        select 1 from public.timetable_schedules schedule
        where schedule.school_id = old.school_id
          and schedule.bell_schedule_id = old.id
      ) then
    raise exception 'Detach this bell schedule from timetables before changing its calendar or week pattern.';
  end if;
  return new;
end;
$$;

create trigger prevent_bell_schedule_pattern_change
  before update of calendar_id, week_pattern_id on public.academic_bell_schedules
  for each row execute function public.prevent_bell_schedule_pattern_change();

create or replace function public.prevent_closing_bell_schedule_day()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.is_open and not new.is_open and exists (
    select 1
    from public.academic_bell_schedules bell
    join public.academic_bell_periods period
      on period.school_id = bell.school_id and period.bell_schedule_id = bell.id
    where bell.school_id = old.school_id
      and bell.calendar_id = old.calendar_id
      and bell.week_pattern_id = old.pattern_id
      and period.day_of_week = old.day_of_week
  ) then
    raise exception 'Remove bell periods configured for this day before marking it closed.';
  end if;
  if old.is_open and not new.is_open and exists (
    select 1
    from public.timetable_schedules schedule
    join public.timetable entry
      on entry.school_id = schedule.school_id and entry.schedule_id = schedule.id
    where schedule.school_id = old.school_id
      and schedule.calendar_id = old.calendar_id
      and schedule.week_pattern_id = old.pattern_id
      and entry.day_of_week = old.day_of_week
  ) then
    raise exception 'Remove timetable periods configured for this day before marking it closed.';
  end if;
  return new;
end;
$$;

create trigger prevent_closing_bell_schedule_day
  before update of is_open on public.academic_calendar_pattern_days
  for each row execute function public.prevent_closing_bell_schedule_day();

create or replace function public.save_academic_week_pattern(
  target_calendar uuid,
  pattern_name text,
  operating_days smallint[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_school uuid;
  saved_pattern uuid;
begin
  select calendar.school_id into target_school
  from public.academic_calendars calendar where calendar.id = target_calendar;
  if not found or not public.can_manage_timetable(target_school) then
    raise exception 'You are not authorized to manage this academic calendar.';
  end if;
  if char_length(trim(pattern_name)) not between 1 and 40
      or coalesce(array_length(operating_days, 1), 0) = 0
      or exists (select 1 from unnest(operating_days) day where day not between 1 and 7) then
    raise exception 'Enter a pattern name and at least one valid teaching day.';
  end if;

  insert into public.academic_calendar_week_patterns (school_id, calendar_id, name)
  values (target_school, target_calendar, trim(pattern_name))
  on conflict (school_id, calendar_id, name) do update set name = excluded.name
  returning id into saved_pattern;

  insert into public.academic_calendar_pattern_days (school_id, calendar_id, pattern_id, day_of_week, is_open)
  select target_school, target_calendar, saved_pattern, day, day = any(operating_days)
  from generate_series(1, 7) as day
  on conflict (pattern_id, day_of_week) do update set is_open = excluded.is_open;
  return saved_pattern;
end;
$$;

revoke all on function public.save_academic_week_pattern(uuid, text, smallint[]) from public;
grant execute on function public.save_academic_week_pattern(uuid, text, smallint[]) to authenticated;

create or replace function public.validate_academic_bell_period()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  schedule_calendar uuid;
  schedule_pattern uuid;
  schedule_cycle_weeks smallint;
begin
  select bell.calendar_id, bell.week_pattern_id, bell.cycle_weeks
    into schedule_calendar, schedule_pattern, schedule_cycle_weeks
    from public.academic_bell_schedules bell
    where bell.id = new.bell_schedule_id and bell.school_id = new.school_id;

  if not found then
    raise exception 'The bell schedule does not belong to this school.';
  end if;
  if new.cycle_week > schedule_cycle_weeks then
    raise exception 'This bell schedule does not include the selected cycle week.';
  end if;
  if not exists (
    select 1 from public.academic_calendar_pattern_days pattern_day
    where pattern_day.school_id = new.school_id
      and pattern_day.calendar_id = schedule_calendar
      and pattern_day.pattern_id = schedule_pattern
      and pattern_day.day_of_week = new.day_of_week
      and pattern_day.is_open
  ) then
    raise exception 'Bell periods can only be added on operating days.';
  end if;
  if exists (
    select 1 from public.academic_bell_periods period
    where period.school_id = new.school_id
      and period.bell_schedule_id = new.bell_schedule_id
      and period.cycle_week = new.cycle_week
      and period.day_of_week = new.day_of_week
      and period.id <> new.id
      and period.starts_at < new.ends_at
      and new.starts_at < period.ends_at
  ) then
    raise exception 'Bell periods on the same day and cycle cannot overlap.';
  end if;
  return new;
end;
$$;

create trigger validate_academic_bell_period
  before insert or update on public.academic_bell_periods
  for each row execute function public.validate_academic_bell_period();

create or replace function public.prevent_used_bell_period_changes()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if exists (
      select 1 from public.timetable entry
      where entry.school_id = old.school_id and entry.bell_period_id = old.id
    ) then
      raise exception 'Remove timetable entries using this bell period before deleting it.';
    end if;
    return old;
  end if;

  if (
    new.bell_schedule_id, new.cycle_week, new.day_of_week, new.period_number,
    new.period_type, new.starts_at, new.ends_at, new.allows_double
  ) is distinct from (
    old.bell_schedule_id, old.cycle_week, old.day_of_week, old.period_number,
    old.period_type, old.starts_at, old.ends_at, old.allows_double
  ) and exists (
    select 1 from public.timetable entry
    where entry.school_id = old.school_id and entry.bell_period_id = old.id
  ) then
    raise exception 'Remove timetable entries using this bell period before changing its timing or availability.';
  end if;
  return new;
end;
$$;

create trigger prevent_used_bell_period_changes
  before update or delete on public.academic_bell_periods
  for each row execute function public.prevent_used_bell_period_changes();

create or replace function public.validate_timetable_bell_period()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  schedule_bell uuid;
  schedule_cycle_weeks smallint;
  schedule_calendar uuid;
  schedule_pattern uuid;
  bell_calendar uuid;
  bell_pattern uuid;
  configured_period public.academic_bell_periods%rowtype;
begin
  if new.schedule_id is null then
    return new;
  end if;

  select schedule.bell_schedule_id, schedule.cycle_weeks, schedule.calendar_id, schedule.week_pattern_id
    into schedule_bell, schedule_cycle_weeks, schedule_calendar, schedule_pattern
    from public.timetable_schedules schedule
    where schedule.id = new.schedule_id and schedule.school_id = new.school_id;

  if new.cycle_week > schedule_cycle_weeks then
    raise exception 'The selected timetable does not include this cycle week.';
  end if;

  if schedule_bell is null then
    if new.bell_period_id is not null then
      raise exception 'A bell period cannot be used without an assigned bell schedule.';
    end if;
    return new;
  end if;

  select bell.calendar_id, bell.week_pattern_id into bell_calendar, bell_pattern
  from public.academic_bell_schedules bell
  where bell.id = schedule_bell and bell.school_id = new.school_id;
  if bell_calendar is distinct from schedule_calendar or bell_pattern is distinct from schedule_pattern then
    raise exception 'The timetable bell schedule does not match its calendar and week pattern.';
  end if;

  if new.bell_period_id is null then
    raise exception 'Choose a configured bell period for this timetable entry.';
  end if;

  select period.* into configured_period
  from public.academic_bell_periods period
  where period.school_id = new.school_id
    and period.bell_schedule_id = schedule_bell
    and period.id = new.bell_period_id
    and period.cycle_week = new.cycle_week
    and period.day_of_week = new.day_of_week;
  if not found then
    raise exception 'The selected bell period does not match this timetable day and cycle.';
  end if;

  if new.entry_type = 'lesson' then
    if configured_period.period_type <> 'lesson' then
      raise exception 'Lessons can only be assigned to lesson periods.';
    end if;
    if not exists (
      select 1 from public.academic_bell_period_subjects restriction
      where restriction.school_id = new.school_id and restriction.period_id = configured_period.id
    ) then
      null;
    elsif not exists (
      select 1 from public.academic_bell_period_subjects restriction
      where restriction.school_id = new.school_id
        and restriction.period_id = configured_period.id
        and restriction.subject_id = new.subject_id
    ) then
      raise exception 'This subject is not available in the selected lesson period.';
    end if;

    if new.starts_at = configured_period.starts_at and new.ends_at = configured_period.ends_at then
      return new;
    end if;
    if not configured_period.allows_double or new.starts_at <> configured_period.starts_at
        or not exists (
          select 1
          from public.academic_bell_periods next_period
          where next_period.school_id = new.school_id
            and next_period.bell_schedule_id = schedule_bell
            and next_period.cycle_week = new.cycle_week
            and next_period.day_of_week = new.day_of_week
            and next_period.period_type = 'lesson'
            and next_period.period_number = configured_period.period_number + 1
            and next_period.starts_at = configured_period.ends_at
            and next_period.ends_at = new.ends_at
            and (
              not exists (
                select 1 from public.academic_bell_period_subjects restriction
                where restriction.school_id = new.school_id
                  and restriction.period_id = next_period.id
              )
              or exists (
                select 1 from public.academic_bell_period_subjects restriction
                where restriction.school_id = new.school_id
                  and restriction.period_id = next_period.id
                  and restriction.subject_id = new.subject_id
              )
            )
        ) then
      raise exception 'This lesson does not match the selected period or an allowed consecutive double period.';
    end if;
  else
    if not (configured_period.period_type = new.entry_type
        or (new.entry_type = 'other' and configured_period.period_type = 'assembly'))
        or new.starts_at <> configured_period.starts_at
        or new.ends_at <> configured_period.ends_at then
      raise exception 'This activity must match a configured bell period.';
    end if;
  end if;
  return new;
end;
$$;

create trigger validate_timetable_bell_period
  before insert or update on public.timetable
  for each row execute function public.validate_timetable_bell_period();

create or replace function public.validate_bell_period_subject_rule()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.academic_bell_periods period
    where period.school_id = new.school_id
      and period.id = new.period_id
      and period.period_type = 'lesson'
  ) then
    raise exception 'Subject availability can only be configured for lesson periods.';
  end if;
  return new;
end;
$$;

create trigger validate_bell_period_subject_rule
  before insert or update on public.academic_bell_period_subjects
  for each row execute function public.validate_bell_period_subject_rule();

create or replace function public.prevent_used_bell_subject_rule_changes()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  referenced_period uuid;
  referenced_school uuid;
begin
  if tg_op = 'DELETE' then
    referenced_period := old.period_id;
    referenced_school := old.school_id;
  else
    referenced_period := new.period_id;
    referenced_school := new.school_id;
  end if;
  if exists (
    select 1 from public.timetable entry
    where entry.school_id = referenced_school and entry.bell_period_id = referenced_period
  ) then
    raise exception 'Remove timetable entries using this period before changing its subject availability.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger prevent_used_bell_subject_rule_changes
  before insert or update or delete on public.academic_bell_period_subjects
  for each row execute function public.prevent_used_bell_subject_rule_changes();

alter table public.academic_bell_schedules enable row level security;
alter table public.academic_bell_periods enable row level security;
alter table public.academic_bell_period_subjects enable row level security;

create policy "Members read bell schedules"
  on public.academic_bell_schedules for select to authenticated
  using (public.is_school_member(school_id));
create policy "Coordinators manage bell schedules"
  on public.academic_bell_schedules for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));

create policy "Members read bell periods"
  on public.academic_bell_periods for select to authenticated
  using (public.is_school_member(school_id));
create policy "Coordinators manage bell periods"
  on public.academic_bell_periods for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));

create policy "Members read bell period subject rules"
  on public.academic_bell_period_subjects for select to authenticated
  using (public.is_school_member(school_id));
create policy "Coordinators manage bell period subject rules"
  on public.academic_bell_period_subjects for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));

grant select, insert, update, delete on public.academic_bell_schedules to authenticated;
grant select, insert, update, delete on public.academic_bell_periods to authenticated;
grant select, insert, update, delete on public.academic_bell_period_subjects to authenticated;

create trigger set_updated_at
  before update on public.academic_bell_schedules
  for each row execute function public.set_updated_at();
create trigger set_updated_at
  before update on public.academic_bell_periods
  for each row execute function public.set_updated_at();

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
  schedule_cycle_weeks smallint;
  inserted_count integer;
begin
  if generated_entries is null or jsonb_typeof(generated_entries) <> 'array'
      or jsonb_array_length(generated_entries) > 2000 then
    raise exception 'Generated timetable entries must be an array with at most 2000 periods.';
  end if;

  select schedule.school_id, schedule.status, schedule.cycle_weeks
    into target_school, current_status, schedule_cycle_weeks
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
      day_of_week smallint, starts_at time, ends_at time, room text, label text,
      cycle_week smallint, bell_period_id uuid
    )
    where entry.entry_type not in ('lesson', 'registration', 'break', 'lunch', 'other')
      or entry.day_of_week not between 1 and 7
      or coalesce(entry.cycle_week, 1) not between 1 and schedule_cycle_weeks
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
      class_id uuid, teacher_id uuid, room text, cycle_week smallint
    )
    join jsonb_to_recordset(generated_entries) as other(
      entry_type text, day_of_week smallint, starts_at time, ends_at time,
      class_id uuid, teacher_id uuid, room text, cycle_week smallint
    ) on (entry.cycle_week, entry.day_of_week, entry.starts_at, entry.class_id::text)
      < (other.cycle_week, other.day_of_week, other.starts_at, other.class_id::text)
    where entry.entry_type = 'lesson'
      and other.entry_type = 'lesson'
      and entry.cycle_week = other.cycle_week
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
    day_of_week, starts_at, ends_at, room, entry_type, label,
    cycle_week, bell_period_id
  )
  select
    target_school, target_schedule, entry.class_id, entry.subject_id, entry.teacher_id,
    entry.day_of_week, entry.starts_at, entry.ends_at, nullif(trim(entry.room), ''),
    entry.entry_type, nullif(trim(entry.label), ''), coalesce(entry.cycle_week, 1), entry.bell_period_id
  from jsonb_to_recordset(generated_entries) as entry(
    entry_type text, class_id uuid, subject_id uuid, teacher_id uuid,
    day_of_week smallint, starts_at time, ends_at time, room text, label text,
    cycle_week smallint, bell_period_id uuid
  );

  get diagnostics inserted_count = row_count;
  insert into public.timetable_schedule_changes (school_id, schedule_id, actor_id, action, summary)
  values (target_school, target_schedule, auth.uid(), 'generated', 'Generated ' || inserted_count || ' timetable periods.');
  return inserted_count;
end;
$$;

revoke all on function public.generate_timetable_schedule(uuid, jsonb) from public;
grant execute on function public.generate_timetable_schedule(uuid, jsonb) to authenticated;
