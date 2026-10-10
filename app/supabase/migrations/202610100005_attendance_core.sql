alter table public.attendance_sessions
  drop constraint attendance_sessions_school_id_class_id_attendance_date_key,
  add column academic_year_id uuid,
  add column term_id uuid,
  add column session_type text not null default 'daily'
    check (session_type in ('daily', 'morning', 'afternoon', 'lesson')),
  add column lesson_entry_id uuid,
  add column status text not null default 'open'
    check (status in ('open', 'submitted', 'closed')),
  add column submitted_by uuid references public.profiles(id),
  add column submitted_at timestamptz,
  add column closed_by uuid references public.profiles(id),
  add column closed_at timestamptz,
  add column non_school_day_override boolean not null default false,
  add column override_reason text,
  add constraint attendance_sessions_school_year_fk
    foreign key (school_id, academic_year_id)
    references public.academic_years(school_id, id) on delete restrict,
  add constraint attendance_sessions_school_term_fk
    foreign key (school_id, term_id)
    references public.terms(school_id, id) on delete restrict,
  add constraint attendance_sessions_lesson_entry_fk
    foreign key (lesson_entry_id)
    references public.timetable(id) on delete set null,
  add constraint attendance_sessions_type_lesson_fk
    check ((session_type = 'lesson') = (lesson_entry_id is not null)),
  add constraint attendance_sessions_override_reason_check
    check (not non_school_day_override or char_length(trim(coalesce(override_reason, ''))) between 3 and 300);

create unique index attendance_sessions_class_date_type_key
  on public.attendance_sessions(school_id, class_id, attendance_date, session_type)
  where lesson_entry_id is null;
create unique index attendance_sessions_lesson_key
  on public.attendance_sessions(school_id, lesson_entry_id, attendance_date)
  where lesson_entry_id is not null;
create index attendance_sessions_school_date_idx
  on public.attendance_sessions(school_id, attendance_date desc, status);

update public.attendance_sessions session
set academic_year_id = school_class.academic_year_id
from public.school_classes school_class
where school_class.school_id = session.school_id
  and school_class.id = session.class_id;

alter table public.attendance_records
  add column arrival_time time,
  add column departure_time time,
  add column absence_reason text,
  add column absence_category text not null default 'unexplained'
    check (absence_category in ('unexplained', 'medical', 'authorized', 'other')),
  add constraint attendance_records_absence_reason_check
    check (absence_reason is null or char_length(trim(absence_reason)) <= 500);

create table public.attendance_settings (
  school_id uuid primary key references public.schools(id) on delete cascade,
  default_session_type text not null default 'daily'
    check (default_session_type in ('daily', 'morning', 'afternoon')),
  late_after time,
  require_complete_register boolean not null default true,
  allow_parent_explanations boolean not null default true,
  notify_on_absence boolean not null default false,
  notify_on_late boolean not null default false,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.attendance_status_settings (
  school_id uuid not null references public.schools(id) on delete cascade,
  status public.attendance_status not null,
  label text not null check (char_length(trim(label)) between 2 and 30),
  enabled boolean not null default true,
  counts_as_present boolean not null default false,
  sort_order smallint not null default 0,
  primary key (school_id, status)
);

insert into public.attendance_status_settings (school_id, status, label, enabled, counts_as_present, sort_order)
select school.id, item.status::public.attendance_status, item.label, true, item.counts_as_present, item.sort_order
from public.schools school
cross join (values
  ('present', 'Present', true, 1),
  ('absent', 'Absent', false, 2),
  ('late', 'Late', true, 3),
  ('excused', 'Excused', false, 4)
) as item(status, label, counts_as_present, sort_order)
on conflict (school_id, status) do nothing;

insert into public.attendance_settings (school_id)
select school.id from public.schools school
on conflict (school_id) do nothing;

create table public.attendance_parent_explanations (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  student_id uuid not null,
  attendance_date date not null,
  session_id uuid,
  category text not null check (category in ('medical', 'authorized', 'other')),
  explanation text not null check (char_length(trim(explanation)) between 3 and 1000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  review_note text check (review_note is null or char_length(trim(review_note)) <= 500),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, student_id)
    references public.students(school_id, id) on delete cascade,
  foreign key (school_id, session_id)
    references public.attendance_sessions(school_id, id) on delete set null (session_id)
);

create index attendance_parent_explanations_school_status_idx
  on public.attendance_parent_explanations(school_id, status, attendance_date desc);

create or replace function public.validate_parent_attendance_explanation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_class uuid;
  target_date date;
begin
  if new.session_id is not null then
    select session.class_id, session.attendance_date into target_class, target_date
    from public.attendance_sessions session
    where session.school_id = new.school_id and session.id = new.session_id;
    if not found or target_date <> new.attendance_date or not exists (
      select 1 from public.class_students roster
      where roster.school_id = new.school_id
        and roster.class_id = target_class
        and roster.student_id = new.student_id
    ) then
      raise exception 'The linked attendance register does not match this student and absence date.';
    end if;
  end if;
  if tg_op = 'INSERT' and not exists (
    select 1 from public.attendance_settings setting
    where setting.school_id = new.school_id and setting.allow_parent_explanations
  ) then
    raise exception 'The school is not accepting parent absence explanations.';
  end if;
  return new;
end;
$$;

create trigger validate_parent_attendance_explanation
  before insert or update on public.attendance_parent_explanations
  for each row execute function public.validate_parent_attendance_explanation();

create table public.attendance_audit_log (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools(id) on delete cascade,
  session_id uuid,
  record_id uuid,
  actor_id uuid references public.profiles(id),
  action text not null,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, session_id)
    references public.attendance_sessions(school_id, id) on delete set null (session_id)
);

create index attendance_audit_log_school_date_idx
  on public.attendance_audit_log(school_id, created_at desc);

create table public.attendance_notification_history (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools(id) on delete cascade,
  session_id uuid not null,
  student_id uuid not null,
  recipient_profile_id uuid not null references public.profiles(id) on delete cascade,
  notification_type text not null check (notification_type in ('absent', 'late')),
  notification_id uuid references public.notifications(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (session_id, student_id, recipient_profile_id, notification_type),
  foreign key (school_id, session_id)
    references public.attendance_sessions(school_id, id) on delete cascade,
  foreign key (school_id, student_id)
    references public.students(school_id, id) on delete cascade
);

create index attendance_notification_history_school_idx
  on public.attendance_notification_history(school_id, created_at desc);

create or replace function public.create_attendance_notifications()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  settings public.attendance_settings%rowtype;
  target_type text;
  recipient uuid;
  history_id bigint;
  student_name text;
  sent_notification_id uuid;
  target_date date;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;
  if new.status = 'absent' then
    target_type := 'absent';
  elsif new.status = 'late' then
    target_type := 'late';
  else
    return new;
  end if;

  select * into settings
  from public.attendance_settings
  where school_id = new.school_id;
  if (target_type = 'absent' and not coalesce(settings.notify_on_absence, false))
      or (target_type = 'late' and not coalesce(settings.notify_on_late, false)) then
    return new;
  end if;

  select student.first_name || ' ' || student.last_name into student_name
  from public.students student
  where student.school_id = new.school_id and student.id = new.student_id;
  select session.attendance_date into target_date
  from public.attendance_sessions session
  where session.school_id = new.school_id and session.id = new.session_id;

  for recipient in
    select parent.profile_id
    from public.parent_students relation
    join public.parent_profiles parent
      on parent.school_id = relation.school_id and parent.id = relation.parent_id
    where relation.school_id = new.school_id
      and relation.student_id = new.student_id
      and parent.profile_id is not null
    union
    select student.profile_id
    from public.students student
    where student.school_id = new.school_id
      and student.id = new.student_id
      and student.profile_id is not null
  loop
    insert into public.attendance_notification_history (
      school_id, session_id, student_id, recipient_profile_id, notification_type
    ) values (
      new.school_id, new.session_id, new.student_id, recipient, target_type
    )
    on conflict (session_id, student_id, recipient_profile_id, notification_type) do nothing
    returning id into history_id;
    if history_id is not null then
      insert into public.notifications (school_id, profile_id, title, body, target_path)
      values (
        new.school_id,
        recipient,
        case target_type when 'absent' then 'Student marked absent' else 'Late arrival recorded' end,
        coalesce(student_name, 'A student') || case target_type
          when 'absent' then ' was marked absent on ' || target_date::text || '.'
          else ' was marked late on ' || target_date::text || '.' end,
        '/attendance'
      )
      returning id into sent_notification_id;
      update public.attendance_notification_history
      set notification_id = sent_notification_id
      where school_id = new.school_id
        and session_id = new.session_id
        and student_id = new.student_id
        and recipient_profile_id = recipient
        and notification_type = target_type;
    end if;
    history_id := null;
  end loop;
  return new;
end;
$$;

create trigger create_attendance_notifications
  after insert or update on public.attendance_records
  for each row execute function public.create_attendance_notifications();

create or replace function public.initialize_attendance_school_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.attendance_settings (school_id) values (new.id);
  insert into public.attendance_status_settings (school_id, status, label, enabled, counts_as_present, sort_order)
  values
    (new.id, 'present', 'Present', true, true, 1),
    (new.id, 'absent', 'Absent', true, false, 2),
    (new.id, 'late', 'Late', true, true, 3),
    (new.id, 'excused', 'Excused', true, false, 4);
  return new;
end;
$$;

create trigger initialize_attendance_school_defaults
  after insert on public.schools
  for each row execute function public.initialize_attendance_school_defaults();

create or replace function public.validate_attendance_session()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  class_year uuid;
  class_calendar uuid;
  default_year uuid;
  year_start date;
  year_end date;
  academic_calendar uuid;
  term_year uuid;
  term_calendar uuid;
  lesson_class uuid;
  lesson_day smallint;
  operating_pattern uuid;
  existing_record_count integer;
begin
  select school_class.academic_year_id, school_class.calendar_id
    into class_year, class_calendar
    from public.school_classes school_class
    where school_class.school_id = new.school_id and school_class.id = new.class_id;
  if not found then
    raise exception 'The selected class does not belong to this school.';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'open' then
      raise exception 'New attendance sessions must start open.';
    end if;
    new.submitted_by := null;
    new.submitted_at := null;
    new.closed_by := null;
    new.closed_at := null;
  end if;

  if new.academic_year_id is null then
    new.academic_year_id := class_year;
    if new.academic_year_id is null then
      select year.id into default_year
      from public.academic_years year
      where year.school_id = new.school_id
        and year.calendar_id = class_calendar
        and new.attendance_date between year.start_date and year.end_date
      order by year.is_current desc
      limit 1;
      new.academic_year_id := default_year;
    end if;
  elsif class_year is not null and new.academic_year_id <> class_year then
    raise exception 'Attendance must use the academic year assigned to this class.';
  end if;
  if new.academic_year_id is not null then
    select year.start_date, year.end_date, year.calendar_id
      into year_start, year_end, academic_calendar
    from public.academic_years year
    where year.school_id = new.school_id and year.id = new.academic_year_id;
    if academic_calendar <> class_calendar then
      raise exception 'The selected academic year does not belong to this class calendar.';
    end if;
    if new.attendance_date < year_start or new.attendance_date > year_end then
      raise exception 'The attendance date is outside the class academic year.';
    end if;
  end if;

  if new.term_id is not null then
    select term.academic_year_id, term.calendar_id into term_year, term_calendar
    from public.terms term
    where term.school_id = new.school_id and term.id = new.term_id
      and new.attendance_date between term.start_date and term.end_date;
    if not found then
      raise exception 'Choose a term for this class academic year and attendance date.';
    end if;
    if new.academic_year_id is null then
      new.academic_year_id := term_year;
    end if;
    if term_calendar <> class_calendar or term_year <> new.academic_year_id then
      raise exception 'Choose a term for this class academic year and attendance date.';
    end if;
  elsif new.academic_year_id is not null then
    select term.id into new.term_id
    from public.terms term
    where term.school_id = new.school_id
      and term.academic_year_id = new.academic_year_id
      and new.attendance_date between term.start_date and term.end_date
    order by term.start_date
    limit 1;
  end if;

  if new.academic_year_id is not null and academic_calendar is null then
    select year.start_date, year.end_date, year.calendar_id
      into year_start, year_end, academic_calendar
    from public.academic_years year
    where year.school_id = new.school_id and year.id = new.academic_year_id;
    if academic_calendar <> class_calendar
        or new.attendance_date < year_start
        or new.attendance_date > year_end then
      raise exception 'The academic year must belong to this class calendar and include the attendance date.';
    end if;
  end if;

  if new.session_type = 'lesson' then
    select entry.class_id, entry.day_of_week into lesson_class, lesson_day
    from public.timetable entry
    where entry.school_id = new.school_id and entry.id = new.lesson_entry_id;
    if not found or lesson_class <> new.class_id or lesson_day <> extract(isodow from new.attendance_date)::smallint then
      raise exception 'The selected timetable lesson does not match this class and date.';
    end if;
  end if;

  if new.non_school_day_override and not public.can_manage_timetable(new.school_id) then
    raise exception 'Only school administrators and academic coordinators can override a non-school day.';
  end if;

  if not new.non_school_day_override then
    if exists (
      select 1
      from public.academic_calendar_dates calendar_date
      where calendar_date.school_id = new.school_id
        and calendar_date.calendar_id = class_calendar
        and calendar_date.event_date = new.attendance_date
        and not calendar_date.lessons_allowed
    ) then
      raise exception 'Attendance cannot be recorded on a school holiday or closure without an authorized override.';
    end if;
    select schedule.week_pattern_id into operating_pattern
    from public.timetable_schedules schedule
    where schedule.school_id = new.school_id
      and schedule.calendar_id = class_calendar
      and schedule.academic_year_id is not distinct from new.academic_year_id
      and schedule.status = 'published'
    order by schedule.updated_at desc
    limit 1;
    if operating_pattern is null then
      select pattern.id into operating_pattern
      from public.academic_calendar_week_patterns pattern
      where pattern.school_id = new.school_id
        and pattern.calendar_id = class_calendar
      order by (pattern.name = 'Standard') desc, pattern.created_at
      limit 1;
    end if;
    if operating_pattern is not null and not exists (
      select 1 from public.academic_calendar_pattern_days pattern_day
      where pattern_day.school_id = new.school_id
        and pattern_day.calendar_id = class_calendar
        and pattern_day.pattern_id = operating_pattern
        and pattern_day.day_of_week = extract(isodow from new.attendance_date)::smallint
        and pattern_day.is_open
    ) then
      raise exception 'Attendance cannot be recorded on a configured non-school day without an authorized override.';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if (
      new.submitted_by, new.submitted_at, new.closed_by, new.closed_at
    ) is distinct from (
      old.submitted_by, old.submitted_at, old.closed_by, old.closed_at
    ) and current_setting('app.attendance_transition', true) is distinct from old.id::text then
      raise exception 'Update attendance submission details using the authorized transition action.';
    end if;
    if new.status is distinct from old.status
        and current_setting('app.attendance_transition', true) is distinct from old.id::text then
      raise exception 'Change attendance session status using the authorized transition action.';
    end if;
    if old.status = 'closed' then
      raise exception 'Closed attendance sessions cannot be changed.';
    end if;
    if old.status = 'submitted' and not public.can_manage_timetable(new.school_id) then
      raise exception 'Submitted attendance is locked. Ask a school administrator or academic coordinator to correct it.';
    end if;
    select count(*) into existing_record_count
    from public.attendance_records attendance_row
    where attendance_row.school_id = old.school_id and attendance_row.session_id = old.id;
    if existing_record_count > 0 and (
      new.class_id is distinct from old.class_id
      or new.attendance_date is distinct from old.attendance_date
      or new.session_type is distinct from old.session_type
      or new.lesson_entry_id is distinct from old.lesson_entry_id
      or new.academic_year_id is distinct from old.academic_year_id
      or new.term_id is distinct from old.term_id
    ) then
      raise exception 'Remove attendance records before changing the session class, date, type, or academic period.';
    end if;
  end if;

  if tg_op = 'INSERT' then
    new.recorded_by := auth.uid();
  else
    new.recorded_by := old.recorded_by;
  end if;
  return new;
end;
$$;

create trigger validate_attendance_session
  before insert or update on public.attendance_sessions
  for each row execute function public.validate_attendance_session();

create or replace function public.guard_attendance_record()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_session public.attendance_sessions%rowtype;
  target_late_after time;
  approved_category text;
  approved_reason text;
  target_school uuid;
  target_session_id uuid;
begin
  if tg_op = 'DELETE' then
    target_school := old.school_id;
    target_session_id := old.session_id;
  else
    target_school := new.school_id;
    target_session_id := new.session_id;
  end if;
  select session.* into target_session
  from public.attendance_sessions session
  where session.school_id = target_school
    and session.id = target_session_id
  for update;
  if not found then
    raise exception 'The attendance session no longer exists.';
  end if;
  if tg_op = 'UPDATE' then
    if new.school_id is distinct from old.school_id
        or new.session_id is distinct from old.session_id
        or new.student_id is distinct from old.student_id then
      raise exception 'Attendance records cannot be moved to another school, session, or student.';
    end if;
  end if;
  if target_session.status = 'closed' and not public.can_manage_timetable(target_session.school_id) then
    raise exception 'This attendance register is closed.';
  end if;
  if target_session.status = 'submitted' and not public.can_manage_timetable(target_session.school_id) then
    if current_setting('app.attendance_review', true) is distinct from target_session.id::text then
      raise exception 'Submitted attendance is locked for corrections by staff.';
    end if;
  end if;
  if tg_op <> 'DELETE' then
    if new.status = 'absent' then
      select explanation.category, explanation.explanation
        into approved_category, approved_reason
      from public.attendance_parent_explanations explanation
      where explanation.school_id = new.school_id
        and explanation.student_id = new.student_id
        and explanation.attendance_date = target_session.attendance_date
        and explanation.status = 'approved'
        and (explanation.session_id is null or explanation.session_id = target_session.id)
      order by explanation.created_at desc
      limit 1;
      if found then
        new.status := 'excused';
        new.absence_category := approved_category;
        new.absence_reason := approved_reason;
      end if;
    end if;
    if not exists (
      select 1 from public.attendance_status_settings setting
      where setting.school_id = new.school_id and setting.status = new.status and setting.enabled
    ) then
      raise exception 'This attendance status is not enabled by the school.';
    end if;
    if new.status = 'late' and new.arrival_time is null then
      raise exception 'Record an arrival time when marking a student late.';
    end if;
    select setting.late_after into target_late_after
    from public.attendance_settings setting
    where setting.school_id = new.school_id;
    if target_late_after is not null
        and new.arrival_time is not null
        and new.arrival_time > target_late_after
        and new.status = 'present' then
      raise exception 'This arrival is after the school late threshold. Mark the student late.';
    end if;
    if new.status in ('absent', 'excused') and new.absence_category = 'unexplained'
        and new.absence_reason is not null and char_length(trim(new.absence_reason)) > 0 then
      new.absence_category := 'other';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger guard_attendance_record
  before insert or update or delete on public.attendance_records
  for each row execute function public.guard_attendance_record();

create or replace function public.log_attendance_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_session uuid;
  target_school uuid;
  target_record uuid;
  target_before jsonb;
  target_after jsonb;
begin
  if tg_op = 'DELETE' then
    target_session := old.session_id;
    target_school := old.school_id;
    target_record := old.id;
    target_before := to_jsonb(old);
  elsif tg_op = 'INSERT' then
    target_session := new.session_id;
    target_school := new.school_id;
    target_record := new.id;
    target_after := to_jsonb(new);
  else
    target_session := new.session_id;
    target_school := new.school_id;
    target_record := new.id;
    target_before := to_jsonb(old);
    target_after := to_jsonb(new);
  end if;
  insert into public.attendance_audit_log (
    school_id, session_id, record_id, actor_id, action, before_data, after_data
  ) values (
    target_school,
    target_session,
    target_record,
    auth.uid(),
    lower(tg_op),
    target_before,
    target_after
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger log_attendance_record_change
  after insert or update or delete on public.attendance_records
  for each row execute function public.log_attendance_change();

create or replace function public.log_attendance_session_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_school uuid;
  target_session uuid;
  target_action text;
  before_state jsonb;
  after_state jsonb;
begin
  if tg_op = 'DELETE' then
    target_school := old.school_id;
    target_session := old.id;
    target_action := 'session_deleted';
    before_state := to_jsonb(old);
  elsif tg_op = 'INSERT' then
    target_school := new.school_id;
    target_session := new.id;
    target_action := 'session_opened';
    after_state := to_jsonb(new);
  else
    target_school := new.school_id;
    target_session := new.id;
    target_action := case when new.status is distinct from old.status then 'session_' || new.status else 'session_updated' end;
    before_state := to_jsonb(old);
    after_state := to_jsonb(new);
  end if;
  insert into public.attendance_audit_log (
    school_id, session_id, actor_id, action, before_data, after_data
  ) values (
    target_school,
    target_session,
    auth.uid(),
    target_action,
    before_state,
    after_state
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger log_attendance_session_change
  after insert or update or delete on public.attendance_sessions
  for each row execute function public.log_attendance_session_change();

create or replace function public.log_parent_attendance_explanation_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.attendance_audit_log (
    school_id, session_id, actor_id, action, before_data, after_data
  ) values (
    new.school_id,
    new.session_id,
    auth.uid(),
    case when tg_op = 'INSERT' then 'explanation_submitted' else 'explanation_' || new.status end,
    case when tg_op = 'UPDATE' then to_jsonb(old) else null end,
    to_jsonb(new)
  );
  return new;
end;
$$;

create trigger log_parent_attendance_explanation_change
  after insert or update on public.attendance_parent_explanations
  for each row execute function public.log_parent_attendance_explanation_change();

create or replace function public.transition_attendance_session(
  target_session uuid,
  target_status text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.attendance_sessions%rowtype;
  roster_count integer;
  marked_count integer;
  require_complete boolean;
begin
  if target_status is null or target_status not in ('submitted', 'closed', 'open') then
    raise exception 'Choose a valid attendance session status.';
  end if;
  select session.* into target
  from public.attendance_sessions session
  where session.id = target_session
  for update;
  if not found then
    raise exception 'Attendance session not found.';
  end if;
  if not (
    public.can_manage_timetable(target.school_id)
    or (target_status = 'submitted' and public.is_teacher_for_class(target.school_id, target.class_id))
  ) then
    raise exception 'You are not authorized to change this attendance session.';
  end if;
  if target.status = 'closed' then
    raise exception 'Closed attendance sessions cannot be reopened.';
  end if;
  if target_status = 'closed' and target.status <> 'submitted' then
    raise exception 'Submit the register before closing it.';
  end if;
  if target_status = 'open' and target.status <> 'submitted' then
    raise exception 'Only submitted registers can be reopened.';
  end if;
  if target_status = 'open' and not public.can_manage_timetable(target.school_id) then
    raise exception 'Only a school administrator or academic coordinator can reopen a submitted register.';
  end if;
  if target_status = 'submitted' then
    select coalesce(setting.require_complete_register, true)
      into require_complete
      from public.attendance_settings setting
      where setting.school_id = target.school_id;
    require_complete := coalesce(require_complete, true);
    select count(*) into roster_count
    from public.class_students roster
    where roster.school_id = target.school_id and roster.class_id = target.class_id;
    select count(*) into marked_count
    from public.attendance_records attendance_row
    join public.class_students roster
      on roster.school_id = attendance_row.school_id
      and roster.class_id = target.class_id
      and roster.student_id = attendance_row.student_id
    where attendance_row.school_id = target.school_id and attendance_row.session_id = target.id;
    if require_complete and marked_count <> roster_count then
      raise exception 'Mark every enrolled student before submitting this register (% of % marked).', marked_count, roster_count;
    end if;
  end if;
  perform set_config('app.attendance_transition', target.id::text, true);
  update public.attendance_sessions
  set status = target_status,
      submitted_by = case when target_status = 'submitted' then auth.uid() else submitted_by end,
      submitted_at = case when target_status = 'submitted' then now() else submitted_at end,
      closed_by = case when target_status = 'closed' then auth.uid() else closed_by end,
      closed_at = case when target_status = 'closed' then now() else closed_at end
  where id = target.id;
end;
$$;

revoke all on function public.transition_attendance_session(uuid, text) from public;
grant execute on function public.transition_attendance_session(uuid, text) to authenticated;

create or replace function public.review_attendance_explanation(
  target_explanation uuid,
  decision text,
  note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  explanation public.attendance_parent_explanations%rowtype;
begin
  if decision is null or decision not in ('approved', 'rejected') then
    raise exception 'Choose approve or reject.';
  end if;
  select item.* into explanation
  from public.attendance_parent_explanations item
  where item.id = target_explanation
  for update;
  if not found or not (
    public.can_manage_timetable(explanation.school_id)
    or exists (
      select 1 from public.students student
      where student.school_id = explanation.school_id
        and student.id = explanation.student_id
        and student.class_id is not null
        and public.is_teacher_for_class(student.school_id, student.class_id)
    )
  ) then
    raise exception 'You are not authorized to review this absence explanation.';
  end if;
  if explanation.status <> 'pending' then
    raise exception 'This explanation has already been reviewed.';
  end if;
  update public.attendance_parent_explanations
  set status = decision, reviewed_by = auth.uid(), reviewed_at = now(),
      review_note = nullif(trim(note), '')
  where id = explanation.id;

  if decision = 'approved' and explanation.session_id is not null then
    perform set_config('app.attendance_review', explanation.session_id::text, true);
    update public.attendance_records
    set status = 'excused',
        absence_category = explanation.category,
        absence_reason = explanation.explanation
    where school_id = explanation.school_id
      and session_id = explanation.session_id
      and student_id = explanation.student_id
      and status in ('absent', 'excused');
  end if;
end;
$$;

revoke all on function public.review_attendance_explanation(uuid, text, text) from public;
grant execute on function public.review_attendance_explanation(uuid, text, text) to authenticated;

alter table public.attendance_settings enable row level security;
alter table public.attendance_status_settings enable row level security;
alter table public.attendance_parent_explanations enable row level security;
alter table public.attendance_audit_log enable row level security;
alter table public.attendance_notification_history enable row level security;

drop policy if exists "Authorized users read students" on public.students;
create policy "Authorized users read students"
  on public.students for select to authenticated
  using (
    public.can_manage_timetable(school_id)
    or profile_id = auth.uid()
    or public.is_parent_of_student(school_id, id)
    or (class_id is not null and public.is_teacher_for_class(school_id, class_id))
  );

drop policy if exists "Members read class rosters" on public.class_students;
create policy "Members read class rosters"
  on public.class_students for select to authenticated
  using (
    public.can_manage_timetable(school_id)
    or public.is_teacher_for_class(school_id, class_id)
    or exists (
      select 1 from public.students student
      where student.school_id = class_students.school_id
        and student.id = class_students.student_id
        and student.profile_id = auth.uid()
    )
    or public.is_parent_of_student(school_id, student_id)
  );

create policy "Members read attendance settings"
  on public.attendance_settings for select to authenticated
  using (public.is_school_member(school_id));
create policy "Coordinators manage attendance settings"
  on public.attendance_settings for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));

create policy "Members read attendance status settings"
  on public.attendance_status_settings for select to authenticated
  using (public.is_school_member(school_id));
create policy "Coordinators manage attendance status settings"
  on public.attendance_status_settings for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));

create policy "Parents and staff read attendance explanations"
  on public.attendance_parent_explanations for select to authenticated
  using (
    public.can_manage_timetable(school_id)
    or public.is_parent_of_student(school_id, student_id)
    or exists (
      select 1 from public.students student
      where student.school_id = attendance_parent_explanations.school_id
        and student.id = attendance_parent_explanations.student_id
        and student.class_id is not null
        and public.is_teacher_for_class(student.school_id, student.class_id)
    )
  );
create policy "Parents submit child absence explanations"
  on public.attendance_parent_explanations for insert to authenticated
  with check (
    created_by = auth.uid()
    and status = 'pending'
    and reviewed_by is null
    and public.is_parent_of_student(school_id, student_id)
    and exists (
      select 1 from public.attendance_settings setting
      where setting.school_id = attendance_parent_explanations.school_id
        and setting.allow_parent_explanations
    )
  );

create policy "Attendance managers read audit log"
  on public.attendance_audit_log for select to authenticated
  using (
    public.can_manage_timetable(school_id)
    or exists (
      select 1 from public.attendance_sessions session
      where session.school_id = attendance_audit_log.school_id
        and session.id = attendance_audit_log.session_id
        and public.is_teacher_for_class(session.school_id, session.class_id)
    )
  );

create policy "Attendance notification history is visible to recipients and staff"
  on public.attendance_notification_history for select to authenticated
  using (
    recipient_profile_id = auth.uid()
    or public.can_manage_timetable(school_id)
    or exists (
      select 1 from public.attendance_sessions session
      where session.school_id = attendance_notification_history.school_id
        and session.id = attendance_notification_history.session_id
        and public.is_teacher_for_class(session.school_id, session.class_id)
    )
  );

drop policy if exists "Teachers and admins record attendance" on public.attendance_sessions;
drop policy if exists "Teachers and admins update attendance" on public.attendance_sessions;
drop policy if exists "Authorized users read attendance sessions" on public.attendance_sessions;
drop policy if exists "Authorized users read attendance records" on public.attendance_records;
drop policy if exists "Teachers and admins manage attendance records" on public.attendance_records;

create policy "Authorized users read attendance sessions"
  on public.attendance_sessions for select to authenticated
  using (
    public.can_manage_timetable(school_id)
    or public.is_teacher_for_class(school_id, class_id)
    or exists (
      select 1 from public.class_students roster
      join public.students student
        on student.school_id = roster.school_id and student.id = roster.student_id
      where roster.school_id = attendance_sessions.school_id
        and roster.class_id = attendance_sessions.class_id
        and student.profile_id = auth.uid()
    )
    or exists (
      select 1 from public.class_students roster
      where roster.school_id = attendance_sessions.school_id
        and roster.class_id = attendance_sessions.class_id
        and public.is_parent_of_student(attendance_sessions.school_id, roster.student_id)
    )
  );
create policy "Authorized staff open attendance sessions"
  on public.attendance_sessions for insert to authenticated
  with check (
    public.can_manage_timetable(school_id)
    or public.is_teacher_for_class(school_id, class_id)
  );
create policy "Authorized staff update attendance sessions"
  on public.attendance_sessions for update to authenticated
  using (
    public.can_manage_timetable(school_id)
    or public.is_teacher_for_class(school_id, class_id)
  )
  with check (
    public.can_manage_timetable(school_id)
    or public.is_teacher_for_class(school_id, class_id)
  );

create policy "Authorized users read attendance records"
  on public.attendance_records for select to authenticated
  using (
    public.can_manage_timetable(school_id)
    or exists (select 1 from public.students student where student.id = attendance_records.student_id and student.profile_id = auth.uid())
    or public.is_parent_of_student(school_id, student_id)
    or exists (
      select 1 from public.attendance_sessions session
      where session.school_id = attendance_records.school_id
        and session.id = attendance_records.session_id
        and public.is_teacher_for_class(session.school_id, session.class_id)
    )
  );
create policy "Authorized staff manage attendance records"
  on public.attendance_records for all to authenticated
  using (
    public.can_manage_timetable(school_id)
    or exists (
      select 1 from public.attendance_sessions session
      where session.school_id = attendance_records.school_id
        and session.id = attendance_records.session_id
        and public.is_teacher_for_class(session.school_id, session.class_id)
    )
  )
  with check (
    public.can_manage_timetable(school_id)
    or exists (
      select 1 from public.attendance_sessions session
      join public.class_students roster
        on roster.school_id = session.school_id
        and roster.class_id = session.class_id
        and roster.student_id = attendance_records.student_id
      where session.school_id = attendance_records.school_id
        and session.id = attendance_records.session_id
        and public.is_teacher_for_class(session.school_id, session.class_id)
    )
  );

grant select, insert, update, delete on public.attendance_settings to authenticated;
grant select, insert, update, delete on public.attendance_status_settings to authenticated;
grant select, insert, update, delete on public.attendance_parent_explanations to authenticated;
grant select on public.attendance_audit_log to authenticated;
grant usage, select on sequence public.attendance_audit_log_id_seq to authenticated;
grant select on public.attendance_notification_history to authenticated;

create trigger set_updated_at
  before update on public.attendance_settings
  for each row execute function public.set_updated_at();
create trigger set_updated_at
  before update on public.attendance_parent_explanations
  for each row execute function public.set_updated_at();
