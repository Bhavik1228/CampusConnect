create table public.academic_calendars (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 120),
  division_name text,
  is_default boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, name, division_name)
);

create unique index academic_calendars_one_default_per_school
  on public.academic_calendars(school_id) where is_default;

insert into public.academic_calendars (school_id, name, is_default)
select school.id, 'School calendar', true
from public.schools school
where not exists (
  select 1 from public.academic_calendars calendar
  where calendar.school_id = school.id and calendar.is_default
);

create or replace function public.create_default_academic_calendar()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.academic_calendars (school_id, name, is_default)
  values (new.id, 'School calendar', true);
  return new;
end;
$$;

create trigger create_default_academic_calendar
  after insert on public.schools
  for each row execute function public.create_default_academic_calendar();

revoke all on function public.create_default_academic_calendar() from public;

alter table public.academic_years add column calendar_id uuid;
update public.academic_years year
set calendar_id = calendar.id
from public.academic_calendars calendar
where calendar.school_id = year.school_id and calendar.is_default;
alter table public.academic_years alter column calendar_id set not null;
alter table public.academic_years
  add constraint academic_years_school_calendar_fk
    foreign key (school_id, calendar_id)
    references public.academic_calendars(school_id, id) on delete restrict,
  add constraint academic_years_school_calendar_id_key
    unique (school_id, calendar_id, id),
  add constraint academic_years_calendar_name_key
    unique (school_id, calendar_id, name);
drop index public.academic_years_one_current_per_school;
create unique index academic_years_one_current_per_calendar
  on public.academic_years(school_id, calendar_id) where is_current;

alter table public.terms add column calendar_id uuid;
update public.terms term
set calendar_id = year.calendar_id
from public.academic_years year
where year.school_id = term.school_id and year.id = term.academic_year_id;
alter table public.terms alter column calendar_id set not null;
alter table public.terms
  add constraint terms_school_calendar_fk
    foreign key (school_id, calendar_id)
    references public.academic_calendars(school_id, id) on delete restrict,
  add constraint terms_school_calendar_year_fk
    foreign key (school_id, calendar_id, academic_year_id)
    references public.academic_years(school_id, calendar_id, id) on delete cascade;

alter table public.school_classes add column calendar_id uuid;
update public.school_classes class_record
set calendar_id = coalesce(
  (
    select year.calendar_id
    from public.academic_years year
    where year.school_id = class_record.school_id and year.id = class_record.academic_year_id
  ),
  (
    select calendar.id
    from public.academic_calendars calendar
    where calendar.school_id = class_record.school_id and calendar.is_default
  )
);
alter table public.school_classes alter column calendar_id set not null;
alter table public.school_classes
  add constraint school_classes_school_calendar_fk
    foreign key (school_id, calendar_id)
    references public.academic_calendars(school_id, id) on delete restrict,
  add constraint school_classes_school_calendar_year_fk
    foreign key (school_id, calendar_id, academic_year_id)
    references public.academic_years(school_id, calendar_id, id)
    on delete set null (academic_year_id);

create or replace function public.assign_school_class_calendar()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  year_calendar uuid;
  default_calendar uuid;
begin
  if new.academic_year_id is not null then
    select year.calendar_id into year_calendar
    from public.academic_years year
    where year.school_id = new.school_id and year.id = new.academic_year_id;
    if not found then
      raise exception 'The selected academic year does not belong to this school.';
    end if;
    if new.calendar_id is null then
      new.calendar_id := year_calendar;
    elsif new.calendar_id <> year_calendar then
      raise exception 'The class calendar must match its academic year calendar.';
    end if;
  elsif new.calendar_id is null then
    select calendar.id into default_calendar
    from public.academic_calendars calendar
    where calendar.school_id = new.school_id and calendar.is_default;
    if not found then
      raise exception 'Create a default academic calendar before adding classes.';
    end if;
    new.calendar_id := default_calendar;
  end if;
  return new;
end;
$$;

create trigger assign_school_class_calendar
  before insert or update of school_id, calendar_id, academic_year_id on public.school_classes
  for each row execute function public.assign_school_class_calendar();

revoke all on function public.assign_school_class_calendar() from public;

alter table public.timetable_schedules
  add column calendar_id uuid,
  add column academic_year_id uuid;
update public.timetable_schedules schedule
set calendar_id = calendar.id,
    academic_year_id = year.id
from public.academic_calendars calendar
left join public.academic_years year
  on year.school_id = calendar.school_id
  and year.calendar_id = calendar.id
  and year.is_current
where schedule.school_id = calendar.school_id and calendar.is_default;
alter table public.timetable_schedules alter column calendar_id set not null;
alter table public.timetable_schedules
  add constraint timetable_schedules_school_calendar_fk
    foreign key (school_id, calendar_id)
    references public.academic_calendars(school_id, id) on delete restrict,
  add constraint timetable_schedules_school_calendar_year_fk
    foreign key (school_id, calendar_id, academic_year_id)
    references public.academic_years(school_id, calendar_id, id)
    on delete set null (academic_year_id);

create table public.academic_calendar_week_patterns (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  calendar_id uuid not null,
  name text not null check (char_length(trim(name)) between 1 and 40),
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, calendar_id, id),
  unique (school_id, calendar_id, name),
  foreign key (school_id, calendar_id)
    references public.academic_calendars(school_id, id) on delete cascade
);

create table public.academic_calendar_pattern_days (
  school_id uuid not null,
  calendar_id uuid not null,
  pattern_id uuid not null,
  day_of_week smallint not null check (day_of_week between 1 and 7),
  is_open boolean not null default true,
  primary key (pattern_id, day_of_week),
  foreign key (school_id, calendar_id, pattern_id)
    references public.academic_calendar_week_patterns(school_id, calendar_id, id) on delete cascade
);

insert into public.academic_calendar_week_patterns (school_id, calendar_id, name)
select calendar.school_id, calendar.id, 'Standard'
from public.academic_calendars calendar;

insert into public.academic_calendar_pattern_days (school_id, calendar_id, pattern_id, day_of_week, is_open)
select pattern.school_id, pattern.calendar_id, pattern.id, day.day_of_week, day.day_of_week between 1 and 5
from public.academic_calendar_week_patterns pattern
cross join generate_series(1, 7) as day(day_of_week);

alter table public.timetable_schedules add column week_pattern_id uuid;
update public.timetable_schedules schedule
set week_pattern_id = pattern.id
from public.academic_calendar_week_patterns pattern
where pattern.school_id = schedule.school_id
  and pattern.calendar_id = schedule.calendar_id
  and pattern.name = 'Standard';
alter table public.timetable_schedules alter column week_pattern_id set not null;
alter table public.timetable_schedules
  add constraint timetable_schedules_school_calendar_pattern_fk
    foreign key (school_id, calendar_id, week_pattern_id)
    references public.academic_calendar_week_patterns(school_id, calendar_id, id)
    on delete restrict;

create table public.academic_calendar_weeks (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  calendar_id uuid not null,
  academic_year_id uuid not null,
  pattern_id uuid not null,
  week_number integer not null check (week_number between 1 and 80),
  starts_on date not null,
  ends_on date not null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, calendar_id, academic_year_id, week_number),
  foreign key (school_id, calendar_id, academic_year_id)
    references public.academic_years(school_id, calendar_id, id) on delete cascade,
  foreign key (school_id, calendar_id, pattern_id)
    references public.academic_calendar_week_patterns(school_id, calendar_id, id) on delete restrict,
  check (ends_on >= starts_on)
);

create table public.academic_calendar_dates (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  calendar_id uuid not null,
  academic_year_id uuid,
  event_date date not null,
  title text not null check (char_length(trim(title)) between 2 and 120),
  description text,
  date_type text not null check (date_type in ('public_holiday', 'closure', 'examination', 'activity', 'special')),
  lessons_allowed boolean not null default false,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, calendar_id, event_date, title),
  unique (school_id, id),
  foreign key (school_id, calendar_id)
    references public.academic_calendars(school_id, id) on delete cascade,
  foreign key (school_id, calendar_id, academic_year_id)
    references public.academic_years(school_id, calendar_id, id) on delete cascade
);

create table public.timetable_date_overrides (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  calendar_id uuid not null,
  schedule_id uuid not null,
  event_date date not null,
  action text not null check (action in ('add', 'replace', 'cancel')),
  original_entry_id uuid references public.timetable(id) on delete cascade,
  entry_type text not null default 'lesson'
    check (entry_type in ('lesson', 'registration', 'break', 'lunch', 'other')),
  class_id uuid,
  subject_id uuid,
  teacher_id uuid,
  starts_at time,
  ends_at time,
  room text,
  label text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, calendar_id)
    references public.academic_calendars(school_id, id) on delete cascade,
  foreign key (school_id, schedule_id)
    references public.timetable_schedules(school_id, id) on delete cascade,
  foreign key (school_id, class_id)
    references public.school_classes(school_id, id) on delete cascade,
  foreign key (school_id, subject_id)
    references public.subjects(school_id, id) on delete cascade,
  foreign key (school_id, teacher_id)
    references public.teacher_profiles(school_id, id) on delete set null (teacher_id),
  check (
    (action = 'cancel' and original_entry_id is not null)
    or (action = 'replace' and original_entry_id is not null and starts_at is not null and ends_at > starts_at)
    or (action = 'add' and original_entry_id is null and starts_at is not null and ends_at > starts_at)
  ),
  check (
    action = 'cancel'
    or (entry_type = 'lesson' and class_id is not null and subject_id is not null)
    or (entry_type <> 'lesson' and label is not null and char_length(trim(label)) > 0)
  )
);

create index academic_calendar_dates_date_idx
  on public.academic_calendar_dates(school_id, calendar_id, event_date);
create index academic_calendar_weeks_date_idx
  on public.academic_calendar_weeks(school_id, calendar_id, starts_on, ends_on);
create index timetable_date_overrides_lookup_idx
  on public.timetable_date_overrides(school_id, schedule_id, event_date);

create or replace function public.validate_academic_term_dates()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  year_start date;
  year_end date;
begin
  select year.start_date, year.end_date into year_start, year_end
  from public.academic_years year
  where year.school_id = new.school_id
    and year.calendar_id = new.calendar_id
    and year.id = new.academic_year_id;
  if not found or new.start_date < year_start or new.end_date > year_end then
    raise exception 'Term dates must fall within their academic year.';
  end if;
  if exists (
    select 1 from public.terms term
    where term.school_id = new.school_id
      and term.academic_year_id = new.academic_year_id
      and term.id <> new.id
      and daterange(term.start_date, term.end_date, '[]')
          && daterange(new.start_date, new.end_date, '[]')
  ) then
    raise exception 'Terms cannot overlap within an academic year.';
  end if;
  return new;
end;
$$;

create trigger validate_academic_term_dates
  before insert or update on public.terms
  for each row execute function public.validate_academic_term_dates();

alter table public.timetable_schedule_changes
  drop constraint timetable_schedule_changes_action_check,
  add constraint timetable_schedule_changes_action_check
    check (action in (
      'created', 'updated', 'published', 'lesson_added', 'lesson_updated',
      'lesson_removed', 'generated', 'exception_added', 'exception_updated',
      'exception_removed'
    ));

create or replace function public.validate_academic_calendar_week()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  year_start date;
  year_end date;
begin
  select year.start_date, year.end_date into year_start, year_end
  from public.academic_years year
  where year.school_id = new.school_id
    and year.calendar_id = new.calendar_id
    and year.id = new.academic_year_id;
  if not found or new.starts_on < year_start or new.ends_on > year_end then
    raise exception 'Teaching weeks must fall within their academic year.';
  end if;
  if exists (
    select 1 from public.academic_calendar_weeks week
    where week.school_id = new.school_id
      and week.calendar_id = new.calendar_id
      and week.academic_year_id = new.academic_year_id
      and week.id <> coalesce(new.id, gen_random_uuid())
      and daterange(week.starts_on, week.ends_on, '[]')
          && daterange(new.starts_on, new.ends_on, '[]')
  ) then
    raise exception 'Teaching weeks cannot overlap.';
  end if;
  return new;
end;
$$;

create trigger validate_academic_calendar_week
  before insert or update on public.academic_calendar_weeks
  for each row execute function public.validate_academic_calendar_week();

create or replace function public.validate_academic_calendar_date()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  year_start date;
  year_end date;
begin
  if new.academic_year_id is null then
    return new;
  end if;
  select year.start_date, year.end_date into year_start, year_end
  from public.academic_years year
  where year.school_id = new.school_id
    and year.calendar_id = new.calendar_id
    and year.id = new.academic_year_id;
  if not found or new.event_date < year_start or new.event_date > year_end then
    raise exception 'Academic calendar dates must fall within their academic year.';
  end if;
  return new;
end;
$$;

create trigger validate_academic_calendar_date
  before insert or update on public.academic_calendar_dates
  for each row execute function public.validate_academic_calendar_date();

create or replace function public.validate_timetable_date_override()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  schedule_calendar uuid;
  schedule_pattern uuid;
  base_entry public.timetable%rowtype;
  normal_lessons_allowed boolean;
begin
  select schedule.calendar_id, schedule.week_pattern_id into schedule_calendar, schedule_pattern
  from public.timetable_schedules schedule
  where schedule.id = new.schedule_id and schedule.school_id = new.school_id;
  if schedule_calendar is distinct from new.calendar_id then
    raise exception 'The selected timetable does not belong to this academic calendar.';
  end if;
  if not exists (
    select 1 from public.timetable_schedules schedule
    where schedule.id = new.schedule_id
      and schedule.school_id = new.school_id
      and schedule.status = 'published'
  ) then
    raise exception 'Date exceptions can only be added to a published timetable.';
  end if;

  select coalesce(bool_and(calendar_date.lessons_allowed), true)
    into normal_lessons_allowed
    from public.academic_calendar_dates calendar_date
    where calendar_date.school_id = new.school_id
      and calendar_date.calendar_id = new.calendar_id
      and calendar_date.event_date = new.event_date;

  if new.action in ('cancel', 'replace') then
    select entry.* into base_entry
    from public.timetable entry
    where entry.id = new.original_entry_id
      and entry.school_id = new.school_id
      and entry.schedule_id = new.schedule_id;
    if not found then
      raise exception 'The selected timetable period does not belong to this schedule.';
    end if;
  end if;

  if new.action in ('add', 'replace')
      and new.entry_type = 'lesson'
      and not normal_lessons_allowed then
    raise exception 'Lessons cannot be added on this calendar date unless it explicitly allows lessons.';
  end if;

  if new.action in ('add', 'replace')
      and new.entry_type = 'lesson'
      and not exists (
        select 1
        from public.academic_calendar_pattern_days pattern_day
        where pattern_day.school_id = new.school_id
          and pattern_day.calendar_id = new.calendar_id
          and pattern_day.pattern_id = schedule_pattern
          and pattern_day.day_of_week = extract(isodow from new.event_date)::smallint
          and pattern_day.is_open
      ) then
    raise exception 'Lessons cannot be added on a non-operating school day.';
  end if;

  if new.action in ('add', 'replace') and new.entry_type = 'lesson'
      and new.teacher_id is not null and not exists (
        select 1 from public.teacher_subjects assignment
        where assignment.school_id = new.school_id
          and assignment.teacher_id = new.teacher_id
          and assignment.subject_id = new.subject_id
      ) then
    raise exception 'The selected teacher is not assigned to this subject.';
  end if;
  if new.action in ('add', 'replace') and new.entry_type = 'lesson' and exists (
    select 1 from public.teacher_class_assignments assignment
    where assignment.school_id = new.school_id and assignment.class_id = new.class_id
  ) and not exists (
    select 1 from public.teacher_class_assignments assignment
    where assignment.school_id = new.school_id
      and assignment.class_id = new.class_id
      and assignment.teacher_id = new.teacher_id
  ) then
    raise exception 'The selected teacher is not assigned to this class.';
  end if;
  if new.action in ('add', 'replace') and new.entry_type = 'lesson' and exists (
    select 1 from public.class_subjects assignment
    where assignment.school_id = new.school_id and assignment.class_id = new.class_id
  ) and not exists (
    select 1 from public.class_subjects assignment
    where assignment.school_id = new.school_id
      and assignment.class_id = new.class_id
      and assignment.subject_id = new.subject_id
  ) then
    raise exception 'The selected subject is not offered to this class.';
  end if;

  return new;
end;
$$;

create trigger validate_timetable_date_override
  before insert or update on public.timetable_date_overrides
  for each row execute function public.validate_timetable_date_override();

create or replace function public.validate_timetable_schedule_entry()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  schedule_status text;
  schedule_pattern uuid;
  schedule_calendar uuid;
  schedule_year uuid;
begin
  if new.schedule_id is null then
    return new;
  end if;

  select schedule.status, schedule.week_pattern_id, schedule.calendar_id, schedule.academic_year_id
    into schedule_status, schedule_pattern, schedule_calendar, schedule_year
    from public.timetable_schedules schedule
    where schedule.id = new.schedule_id and schedule.school_id = new.school_id;

  if schedule_status is distinct from 'draft' then
    raise exception 'Only draft timetable periods can be edited.';
  end if;

  if not exists (
    select 1
    from public.academic_calendar_pattern_days pattern_day
    where pattern_day.school_id = new.school_id
      and pattern_day.pattern_id = schedule_pattern
      and pattern_day.day_of_week = new.day_of_week
      and pattern_day.is_open
  ) then
    raise exception 'This day is not an operating day in the timetable week pattern.';
  end if;

  if new.entry_type = 'lesson' and new.teacher_id is not null and not exists (
    select 1 from public.teacher_subjects assignment
    where assignment.school_id = new.school_id
      and assignment.teacher_id = new.teacher_id
      and assignment.subject_id = new.subject_id
  ) then
    raise exception 'The selected teacher is not assigned to this subject.';
  end if;

  if new.entry_type = 'lesson' and exists (
    select 1 from public.teacher_class_assignments assignment
    where assignment.school_id = new.school_id and assignment.class_id = new.class_id
  ) and not exists (
    select 1 from public.teacher_class_assignments assignment
    where assignment.school_id = new.school_id
      and assignment.class_id = new.class_id
      and assignment.teacher_id = new.teacher_id
  ) then
    raise exception 'The selected teacher is not assigned to this class.';
  end if;

  if new.entry_type = 'lesson' and exists (
    select 1 from public.class_subjects assignment
    where assignment.school_id = new.school_id and assignment.class_id = new.class_id
  ) and not exists (
    select 1 from public.class_subjects assignment
    where assignment.school_id = new.school_id
      and assignment.class_id = new.class_id
      and assignment.subject_id = new.subject_id
  ) then
    raise exception 'The selected subject is not offered to this class.';
  end if;

  if new.entry_type = 'lesson' and exists (
    select 1
    from public.school_classes class_record
    where class_record.school_id = new.school_id
      and class_record.id = new.class_id
      and (
        class_record.calendar_id <> schedule_calendar
        or (
          schedule_year is not null
          and class_record.academic_year_id is not null
          and class_record.academic_year_id <> schedule_year
        )
      )
  ) then
    raise exception 'The class must belong to the timetable calendar and academic year.';
  end if;

  if new.entry_type = 'lesson' and exists (
    select 1
    from public.timetable existing
    where existing.school_id = new.school_id
      and existing.schedule_id = new.schedule_id
      and existing.id is distinct from new.id
      and existing.entry_type = 'lesson'
      and existing.day_of_week = new.day_of_week
      and existing.starts_at < new.ends_at
      and new.starts_at < existing.ends_at
      and (
        existing.class_id = new.class_id
        or (new.teacher_id is not null and existing.teacher_id = new.teacher_id)
        or (
          nullif(trim(new.room), '') is not null
          and lower(trim(existing.room)) = lower(trim(new.room))
        )
      )
  ) then
    raise exception 'This period conflicts with another class, teacher, or room assignment.';
  end if;

  return new;
end;
$$;

create or replace function public.record_timetable_date_exception()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  change_action text;
  affected public.timetable_date_overrides%rowtype;
begin
  if tg_op = 'DELETE' then
    affected := old;
    change_action := 'exception_removed';
  else
    affected := new;
    change_action := case when tg_op = 'INSERT' then 'exception_added' else 'exception_updated' end;
  end if;

  insert into public.timetable_schedule_changes (school_id, schedule_id, actor_id, action, summary)
  values (
    affected.school_id,
    affected.schedule_id,
    auth.uid(),
    change_action,
    initcap(affected.action) || ' timetable exception for ' || affected.event_date::text || '.'
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger audit_timetable_date_exceptions
  after insert or update or delete on public.timetable_date_overrides
  for each row execute function public.record_timetable_date_exception();

create or replace function public.set_current_academic_year(target_year uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_school uuid;
  target_calendar uuid;
begin
  select year.school_id, year.calendar_id into target_school, target_calendar
  from public.academic_years year where year.id = target_year;
  if not found or not public.can_manage_timetable(target_school) then
    raise exception 'You are not authorized to update this academic year.';
  end if;
  update public.academic_years
  set is_current = false
  where school_id = target_school and calendar_id = target_calendar and is_current;
  update public.academic_years
  set is_current = true
  where id = target_year and school_id = target_school and calendar_id = target_calendar;
end;
$$;

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

  delete from public.academic_calendar_pattern_days
  where pattern_id = saved_pattern;
  insert into public.academic_calendar_pattern_days (school_id, calendar_id, pattern_id, day_of_week, is_open)
  select target_school, target_calendar, saved_pattern, day, day = any(operating_days)
  from generate_series(1, 7) as day;
  return saved_pattern;
end;
$$;

revoke all on function public.set_current_academic_year(uuid) from public;
revoke all on function public.save_academic_week_pattern(uuid, text, smallint[]) from public;
grant execute on function public.set_current_academic_year(uuid) to authenticated;
grant execute on function public.save_academic_week_pattern(uuid, text, smallint[]) to authenticated;

alter table public.academic_calendars enable row level security;
alter table public.academic_calendar_week_patterns enable row level security;
alter table public.academic_calendar_pattern_days enable row level security;
alter table public.academic_calendar_weeks enable row level security;
alter table public.academic_calendar_dates enable row level security;
alter table public.timetable_date_overrides enable row level security;

create policy "Members read academic calendars"
  on public.academic_calendars for select to authenticated
  using (public.is_school_member(school_id));
create policy "Coordinators manage academic calendars"
  on public.academic_calendars for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));

drop policy if exists "Admins manage academic years" on public.academic_years;
create policy "Coordinators manage academic years"
  on public.academic_years for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));
drop policy if exists "Admins manage terms" on public.terms;
create policy "Coordinators manage terms"
  on public.terms for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));

create policy "Members read academic week patterns"
  on public.academic_calendar_week_patterns for select to authenticated
  using (public.is_school_member(school_id));
create policy "Coordinators manage academic week patterns"
  on public.academic_calendar_week_patterns for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));
create policy "Members read academic pattern days"
  on public.academic_calendar_pattern_days for select to authenticated
  using (public.is_school_member(school_id));
create policy "Coordinators manage academic pattern days"
  on public.academic_calendar_pattern_days for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));

create policy "Members read academic calendar weeks"
  on public.academic_calendar_weeks for select to authenticated
  using (public.is_school_member(school_id));
create policy "Coordinators manage academic calendar weeks"
  on public.academic_calendar_weeks for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));
create policy "Members read academic calendar dates"
  on public.academic_calendar_dates for select to authenticated
  using (public.is_school_member(school_id));
create policy "Coordinators manage academic calendar dates"
  on public.academic_calendar_dates for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));

create policy "Members read timetable date exceptions"
  on public.timetable_date_overrides for select to authenticated
  using (
    public.can_manage_timetable(school_id)
    or (
      public.is_school_member(school_id)
      and exists (
        select 1 from public.timetable_schedules schedule
        where schedule.id = timetable_date_overrides.schedule_id
          and schedule.school_id = timetable_date_overrides.school_id
          and schedule.status = 'published'
      )
    )
  );
create policy "Coordinators manage timetable date exceptions"
  on public.timetable_date_overrides for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));

create trigger set_updated_at
  before update on public.academic_calendars
  for each row execute function public.set_updated_at();
create trigger set_updated_at
  before update on public.academic_calendar_dates
  for each row execute function public.set_updated_at();

grant select, insert, update, delete on public.academic_calendars to authenticated;
grant select, insert, update, delete on public.academic_years to authenticated;
grant select, insert, update, delete on public.terms to authenticated;
grant select on public.academic_calendar_week_patterns to authenticated;
grant select, insert, update, delete on public.academic_calendar_pattern_days to authenticated;
grant select, insert, update, delete on public.academic_calendar_weeks to authenticated;
grant select, insert, update, delete on public.academic_calendar_dates to authenticated;
grant select, insert, update, delete on public.timetable_date_overrides to authenticated;

grant select, insert, update on public.timetable_schedules to authenticated;
