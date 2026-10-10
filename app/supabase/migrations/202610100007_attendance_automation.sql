alter table public.attendance_settings
  add column attendance_target_percent numeric(5, 2) not null default 95
    check (attendance_target_percent between 0 and 100),
  add column attendance_warning_percent numeric(5, 2) not null default 90
    check (attendance_warning_percent between 0 and 100),
  add column repeated_absence_threshold smallint not null default 3
    check (repeated_absence_threshold between 2 and 30),
  add column consecutive_absence_threshold smallint not null default 3
    check (consecutive_absence_threshold between 2 and 30),
  add column auto_lock_after_days smallint
    check (auto_lock_after_days is null or auto_lock_after_days between 1 and 90),
  add column late_to_absence_after_minutes smallint
    check (late_to_absence_after_minutes is null or late_to_absence_after_minutes between 30 and 360),
  add column attendance_calculation_basis text not null default 'daily'
    check (attendance_calculation_basis in ('daily', 'lesson')),
  add column excused_counts_as_present boolean not null default false;

alter table public.attendance_settings
  add constraint attendance_warning_target_check
    check (attendance_warning_percent <= attendance_target_percent);

alter table public.attendance_sessions
  add column assigned_teacher_id uuid,
  add constraint attendance_sessions_assigned_teacher_fk
    foreign key (school_id, assigned_teacher_id)
    references public.teacher_profiles(school_id, id) on delete set null (assigned_teacher_id);

alter table public.attendance_sessions
  add column date_override_id uuid,
  add constraint attendance_sessions_date_override_fk
    foreign key (school_id, date_override_id)
    references public.timetable_date_overrides(school_id, id) on delete restrict;

alter table public.attendance_sessions
  drop constraint attendance_sessions_type_lesson_fk,
  add constraint attendance_sessions_type_lesson_fk check (
    (session_type = 'lesson' and num_nonnulls(lesson_entry_id, date_override_id) = 1)
    or (session_type <> 'lesson' and lesson_entry_id is null and date_override_id is null)
  );

drop index public.attendance_sessions_class_date_type_key;
create unique index attendance_sessions_class_date_type_key
  on public.attendance_sessions(school_id, class_id, attendance_date, session_type)
  where lesson_entry_id is null and date_override_id is null;
create unique index attendance_sessions_date_override_key
  on public.attendance_sessions(school_id, date_override_id, attendance_date)
  where date_override_id is not null;

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
  override_date date;
  override_action text;
  override_entry_type text;
  operating_pattern uuid;
  existing_record_count integer;
  validate_school_day boolean;
  resolve_academic_period boolean;
begin
  if tg_op = 'INSERT' then
    validate_school_day := true;
    resolve_academic_period := true;
  else
    validate_school_day := new.attendance_date is distinct from old.attendance_date
      or new.class_id is distinct from old.class_id
      or new.date_override_id is distinct from old.date_override_id
      or (new.non_school_day_override is distinct from old.non_school_day_override and not new.non_school_day_override);
    resolve_academic_period := new.attendance_date is distinct from old.attendance_date
      or new.class_id is distinct from old.class_id
      or new.academic_year_id is distinct from old.academic_year_id
      or new.term_id is distinct from old.term_id;
  end if;

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

  if resolve_academic_period then
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
  end if;

  if new.session_type = 'lesson' then
    if new.date_override_id is not null then
      select date_override.class_id, date_override.event_date,
        date_override.action, date_override.entry_type
        into lesson_class, override_date, override_action, override_entry_type
      from public.timetable_date_overrides date_override
      where date_override.school_id = new.school_id and date_override.id = new.date_override_id;
      if not found or lesson_class <> new.class_id
          or override_date <> new.attendance_date
          or override_action = 'cancel'
          or override_entry_type <> 'lesson' then
        raise exception 'The selected timetable date override does not match this class and date.';
      end if;
    else
      select entry.class_id, entry.day_of_week into lesson_class, lesson_day
      from public.timetable entry
      where entry.school_id = new.school_id and entry.id = new.lesson_entry_id;
      if not found or lesson_class <> new.class_id
          or lesson_day <> extract(isodow from new.attendance_date)::smallint then
        raise exception 'The selected timetable lesson does not match this class and date.';
      end if;
    end if;
  end if;

  if new.non_school_day_override and not public.can_manage_timetable(new.school_id) then
    raise exception 'Only school administrators and academic coordinators can override a non-school day.';
  end if;

  if validate_school_day and not new.non_school_day_override then
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
      or new.date_override_id is distinct from old.date_override_id
    ) then
      raise exception 'Remove attendance records before changing the session class, date, type, or lesson.';
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

create index attendance_sessions_teacher_date_idx
  on public.attendance_sessions(school_id, assigned_teacher_id, attendance_date desc);

create table public.attendance_substitute_assignments (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  session_id uuid not null,
  substitute_teacher_id uuid not null,
  assigned_by uuid not null references public.profiles(id),
  reason text not null check (char_length(trim(reason)) between 3 and 500),
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, session_id),
  foreign key (school_id, session_id)
    references public.attendance_sessions(school_id, id) on delete cascade,
  foreign key (school_id, substitute_teacher_id)
    references public.teacher_profiles(school_id, id) on delete cascade
);

create table public.attendance_leave_requests (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  student_id uuid not null,
  requested_by uuid not null references public.profiles(id),
  start_date date not null,
  end_date date not null,
  category text not null check (category in ('medical', 'authorized', 'other')),
  reason text not null check (char_length(trim(reason)) between 3 and 1000),
  supporting_document_path text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  review_note text check (review_note is null or char_length(trim(review_note)) <= 500),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, student_id)
    references public.students(school_id, id) on delete cascade,
  check (end_date >= start_date)
);

create index attendance_leave_requests_school_status_idx
  on public.attendance_leave_requests(school_id, status, start_date);

create table public.attendance_followup_tasks (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  student_id uuid not null,
  task_type text not null
    check (task_type in ('repeated_absence', 'consecutive_absence', 'below_threshold', 'unexplained_absence')),
  title text not null check (char_length(trim(title)) between 3 and 160),
  details text not null check (char_length(trim(details)) between 3 and 1000),
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved')),
  assigned_to uuid references public.profiles(id),
  created_by uuid references public.profiles(id),
  resolved_by uuid references public.profiles(id),
  resolved_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, student_id)
    references public.students(school_id, id) on delete cascade
);

create unique index attendance_followup_one_open_task
  on public.attendance_followup_tasks(school_id, student_id, task_type)
  where status <> 'resolved';
create index attendance_followup_school_status_idx
  on public.attendance_followup_tasks(school_id, status, created_at desc);

create table public.attendance_correction_requests (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  session_id uuid not null,
  student_id uuid not null,
  requested_by uuid not null references public.profiles(id),
  requested_status public.attendance_status,
  requested_arrival_time time,
  reason text not null check (char_length(trim(reason)) between 3 and 1000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  review_note text check (review_note is null or char_length(trim(review_note)) <= 500),
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, session_id)
    references public.attendance_sessions(school_id, id) on delete cascade,
  foreign key (school_id, student_id)
    references public.students(school_id, id) on delete cascade
);

create index attendance_correction_requests_school_status_idx
  on public.attendance_correction_requests(school_id, status, created_at desc);

create table public.attendance_notification_templates (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  event_type text not null check (event_type in ('absent', 'late', 'repeated_absence', 'leave_reminder')),
  channel text not null check (channel in ('in_app', 'email', 'sms', 'push')),
  enabled boolean not null default false,
  title_template text not null check (char_length(trim(title_template)) between 2 and 160),
  body_template text not null check (char_length(trim(body_template)) between 3 and 2000),
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, event_type, channel)
);

create table public.attendance_notification_deliveries (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools(id) on delete cascade,
  session_id uuid,
  student_id uuid,
  recipient_profile_id uuid references public.profiles(id) on delete set null,
  event_type text not null check (event_type in ('absent', 'late', 'repeated_absence', 'leave_reminder')),
  channel text not null check (channel in ('in_app', 'email', 'sms', 'push')),
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'unsupported')),
  provider_reference text,
  error_message text,
  created_at timestamptz not null default timezone('utc', now()),
  delivered_at timestamptz,
  foreign key (school_id, session_id)
    references public.attendance_sessions(school_id, id) on delete set null (session_id),
  foreign key (school_id, student_id)
    references public.students(school_id, id) on delete set null (student_id)
);

create index attendance_notification_deliveries_school_idx
  on public.attendance_notification_deliveries(school_id, created_at desc);
create unique index attendance_notification_deliveries_event_key
  on public.attendance_notification_deliveries(session_id, student_id, recipient_profile_id, event_type, channel)
  where session_id is not null and student_id is not null and recipient_profile_id is not null;

insert into public.attendance_notification_templates (
  school_id, event_type, channel, enabled, title_template, body_template
)
select school.id, template.event_type, 'in_app', true, template.title_template, template.body_template
from public.schools school
cross join (values
  ('absent', 'Student marked absent', '{student} was marked absent on {date}.'),
  ('late', 'Late arrival recorded', '{student} was marked late on {date}.'),
  ('repeated_absence', 'Attendance follow-up required', 'Please contact the school about {student}''s recent attendance.'),
  ('leave_reminder', 'Absence explanation needed', 'Please submit an explanation for {student}''s absence on {date}.')
) as template(event_type, title_template, body_template)
on conflict (school_id, event_type, channel) do nothing;

insert into public.attendance_notification_templates (
  school_id, event_type, channel, enabled, title_template, body_template
)
select school.id, template.event_type, channel.name, false, template.title_template, template.body_template
from public.schools school
cross join (values
  ('absent', 'Student marked absent', '{student} was marked absent on {date}.'),
  ('late', 'Late arrival recorded', '{student} was marked late on {date}.'),
  ('repeated_absence', 'Attendance follow-up required', 'Please contact the school about {student}''s recent attendance.'),
  ('leave_reminder', 'Absence explanation needed', 'Please submit an explanation for {student}''s absence on {date}.')
) as template(event_type, title_template, body_template)
cross join (values ('email'), ('sms'), ('push')) as channel(name)
on conflict (school_id, event_type, channel) do nothing;

create table public.attendance_absence_reminder_history (
  id bigint generated always as identity primary key,
  school_id uuid not null,
  session_id uuid not null,
  student_id uuid not null,
  recipient_profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  unique (session_id, student_id, recipient_profile_id),
  foreign key (school_id, session_id)
    references public.attendance_sessions(school_id, id) on delete cascade,
  foreign key (school_id, student_id)
    references public.students(school_id, id) on delete cascade
);

create or replace function public.create_attendance_notification_template_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.attendance_notification_templates (
    school_id, event_type, channel, enabled, title_template, body_template
  )
  select new.id, template.event_type, channel.name, channel.name = 'in_app',
    template.title_template, template.body_template
  from (values
    ('absent', 'Student marked absent', '{student} was marked absent on {date}.'),
    ('late', 'Late arrival recorded', '{student} was marked late on {date}.'),
    ('repeated_absence', 'Attendance follow-up required', 'Please contact the school about {student}''s recent attendance.'),
    ('leave_reminder', 'Absence explanation needed', 'Please submit an explanation for {student}''s absence on {date}.')
  ) as template(event_type, title_template, body_template)
  cross join (values ('in_app'), ('email'), ('sms'), ('push')) as channel(name)
  on conflict (school_id, event_type, channel) do nothing;
  return new;
end;
$$;
create trigger create_attendance_notification_template_defaults
  after insert on public.schools
  for each row execute function public.create_attendance_notification_template_defaults();

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
  template_title text;
  template_body text;
  template_enabled boolean;
  in_app_enabled boolean;
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
  select template.enabled, template.title_template, template.body_template
    into template_enabled, template_title, template_body
  from public.attendance_notification_templates template
  where template.school_id = new.school_id
    and template.event_type = target_type and template.channel = 'in_app';
  in_app_enabled := coalesce(template_enabled, true);
  template_title := coalesce(template_title,
    case target_type when 'absent' then 'Student marked absent' else 'Late arrival recorded' end);
  template_body := coalesce(template_body,
    '{student} was marked ' || target_type || ' on {date}.');
  template_title := replace(replace(template_title, '{student}', coalesce(student_name, 'A student')), '{date}', target_date::text);
  template_body := replace(replace(template_body, '{student}', coalesce(student_name, 'A student')), '{date}', target_date::text);

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
    if in_app_enabled then
      insert into public.attendance_notification_history (
        school_id, session_id, student_id, recipient_profile_id, notification_type
      ) values (
        new.school_id, new.session_id, new.student_id, recipient, target_type
      )
      on conflict (session_id, student_id, recipient_profile_id, notification_type) do nothing
      returning id into history_id;
      if history_id is not null then
        insert into public.notifications (school_id, profile_id, title, body, target_path)
        values (new.school_id, recipient, template_title, template_body, '/attendance')
        returning id into sent_notification_id;
        update public.attendance_notification_history
        set notification_id = sent_notification_id
        where school_id = new.school_id
          and session_id = new.session_id
          and student_id = new.student_id
          and recipient_profile_id = recipient
          and notification_type = target_type;
      end if;
    end if;
    insert into public.attendance_notification_deliveries (
      school_id, session_id, student_id, recipient_profile_id, event_type, channel, status, error_message
    )
    select new.school_id, new.session_id, new.student_id, recipient, target_type, template.channel,
      case when template.channel = 'push' then 'unsupported' else 'queued' end,
      case when template.channel = 'push' then 'Push delivery requires a configured device subscription.' else null end
    from public.attendance_notification_templates template
    where template.school_id = new.school_id
      and template.event_type = target_type
      and template.enabled
      and template.channel in ('email', 'sms', 'push')
    on conflict do nothing;
    history_id := null;
  end loop;
  return new;
end;
$$;

create or replace function public.record_attendance_notification_delivery()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.notification_id is not null and old.notification_id is null then
    insert into public.attendance_notification_deliveries (
      school_id, session_id, student_id, recipient_profile_id, event_type, channel, status, delivered_at
    ) values (
      new.school_id, new.session_id, new.student_id, new.recipient_profile_id,
      new.notification_type, 'in_app', 'sent', now()
    );
  end if;
  return new;
end;
$$;
create trigger record_attendance_notification_delivery
  after update of notification_id on public.attendance_notification_history
  for each row execute function public.record_attendance_notification_delivery();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'attendance-leave-documents',
  'attendance-leave-documents',
  false,
  10485760,
  array['application/pdf', 'image/jpeg', 'image/png']
)
on conflict (id) do nothing;

create policy "Families and staff read leave supporting documents"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'attendance-leave-documents'
    and (
      exists (
        select 1 from public.schools school
        where school.id::text = (storage.foldername(name))[1]
          and public.can_manage_timetable(school.id)
      )
      or exists (
        select 1 from public.students student
        where student.school_id::text = (storage.foldername(name))[1]
          and student.id::text = (storage.foldername(name))[2]
          and (
            student.profile_id = auth.uid()
            or public.is_parent_of_student(student.school_id, student.id)
          )
      )
    )
  );
create policy "Families upload leave supporting documents"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'attendance-leave-documents'
    and exists (
      select 1 from public.students student
      where student.school_id::text = (storage.foldername(name))[1]
        and student.id::text = (storage.foldername(name))[2]
        and (
          student.profile_id = auth.uid()
          or public.is_parent_of_student(student.school_id, student.id)
        )
    )
  );
create policy "Families remove leave supporting documents"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'attendance-leave-documents'
    and exists (
      select 1 from public.students student
      where student.school_id::text = (storage.foldername(name))[1]
        and student.id::text = (storage.foldername(name))[2]
        and (
          student.profile_id = auth.uid()
          or public.is_parent_of_student(student.school_id, student.id)
        )
    )
  );

create or replace function public.apply_approved_leave_to_attendance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  approved_leave public.attendance_leave_requests%rowtype;
begin
  if new.status <> 'absent' then
    return new;
  end if;
  select leave_request.* into approved_leave
  from public.attendance_leave_requests leave_request
  where leave_request.school_id = new.school_id
    and leave_request.student_id = new.student_id
    and leave_request.status = 'approved'
    and exists (
      select 1 from public.attendance_sessions session
      where session.school_id = new.school_id
        and session.id = new.session_id
        and session.attendance_date between leave_request.start_date and leave_request.end_date
    )
  order by leave_request.reviewed_at desc
  limit 1;
  if found then
    new.status := 'excused';
    new.absence_category := approved_leave.category;
    new.absence_reason := approved_leave.reason;
  end if;
  return new;
end;
$$;

create trigger apply_approved_leave_to_attendance
  before insert or update of status on public.attendance_records
  for each row execute function public.apply_approved_leave_to_attendance();

create or replace function public.convert_prolonged_lateness()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  late_cutoff time;
  conversion_minutes smallint;
  approved_leave public.attendance_leave_requests%rowtype;
begin
  if new.status <> 'late' or new.arrival_time is null then
    return new;
  end if;
  select setting.late_after, setting.late_to_absence_after_minutes
    into late_cutoff, conversion_minutes
  from public.attendance_settings setting
  where setting.school_id = new.school_id;
  if late_cutoff is not null and conversion_minutes is not null
      and new.arrival_time > late_cutoff + conversion_minutes * interval '1 minute' then
    select leave_request.* into approved_leave
    from public.attendance_leave_requests leave_request
    join public.attendance_sessions session
      on session.school_id = leave_request.school_id
    where session.school_id = new.school_id
      and session.id = new.session_id
      and leave_request.student_id = new.student_id
      and leave_request.status = 'approved'
      and session.attendance_date between leave_request.start_date and leave_request.end_date
    order by leave_request.reviewed_at desc
    limit 1;
    if found then
      new.status := 'excused';
      new.absence_category := approved_leave.category;
      new.absence_reason := approved_leave.reason;
    else
      new.status := 'absent';
      new.absence_category := 'unexplained';
      new.absence_reason := coalesce(new.absence_reason, 'Arrival exceeded the school late-to-absence threshold.');
    end if;
  end if;
  return new;
end;
$$;
create trigger convert_prolonged_lateness
  before insert or update of status, arrival_time on public.attendance_records
  for each row execute function public.convert_prolonged_lateness();

create or replace function public.guard_attendance_leave_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if current_setting('app.attendance_leave_review', true) = old.id::text then
      if new.school_id is distinct from old.school_id
          or new.student_id is distinct from old.student_id
          or new.requested_by is distinct from old.requested_by
          or new.start_date is distinct from old.start_date
          or new.end_date is distinct from old.end_date
          or new.category is distinct from old.category
          or new.reason is distinct from old.reason
          or new.supporting_document_path is distinct from old.supporting_document_path
          or new.status not in ('approved', 'rejected') then
        raise exception 'Only the leave decision and review details may change during review.';
      end if;
    elsif not (
      old.status = 'pending'
      and new.status = 'withdrawn'
      and new.requested_by = auth.uid()
      and new.school_id = old.school_id
      and new.student_id = old.student_id
      and new.start_date = old.start_date
      and new.end_date = old.end_date
      and new.category = old.category
      and new.reason = old.reason
      and new.supporting_document_path is not distinct from old.supporting_document_path
      and new.reviewed_by is not distinct from old.reviewed_by
      and new.reviewed_at is not distinct from old.reviewed_at
      and new.review_note is not distinct from old.review_note
    ) then
      raise exception 'Only the requesting guardian may withdraw a pending leave request.';
    end if;
  end if;
  if new.supporting_document_path is not null
      and new.supporting_document_path not like new.school_id::text || '/' || new.student_id::text || '/%' then
    raise exception 'The attached document must belong to this student and school.';
  end if;
  return new;
end;
$$;
create trigger guard_attendance_leave_request
  before insert or update on public.attendance_leave_requests
  for each row execute function public.guard_attendance_leave_request();

create or replace function public.generate_scheduled_attendance_registers(
  target_school uuid,
  date_from date,
  date_to date,
  target_class uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  created_count integer;
begin
  if date_from is null or date_to is null or date_to < date_from or date_to - date_from > 30 then
    raise exception 'Choose a valid attendance range of no more than 31 days.';
  end if;
  if target_school is null or not public.can_manage_timetable(target_school) then
    raise exception 'Only school administrators and academic coordinators can generate registers.';
  end if;

  with candidate_lessons as (
    select entry.school_id, entry.class_id, entry.id as lesson_entry_id,
      null::uuid as date_override_id, entry.teacher_id, schedule.academic_year_id,
      calendar_day::date as session_date, false as authorized_override
    from public.timetable entry
    join public.timetable_schedules schedule
      on schedule.school_id = entry.school_id and schedule.id = entry.schedule_id
    cross join generate_series(date_from, date_to, interval '1 day') calendar_day
    left join lateral (
      select academic_week.pattern_id,
        ((academic_week.week_number - 1) % schedule.cycle_weeks + 1)::smallint as cycle_week
      from public.academic_calendar_weeks academic_week
      where academic_week.school_id = schedule.school_id
        and academic_week.calendar_id = schedule.calendar_id
        and academic_week.academic_year_id = schedule.academic_year_id
        and calendar_day::date between academic_week.starts_on and academic_week.ends_on
      order by academic_week.starts_on desc
      limit 1
    ) current_week on true
    join public.academic_calendar_pattern_days pattern_day
      on pattern_day.school_id = schedule.school_id
      and pattern_day.calendar_id = schedule.calendar_id
      and pattern_day.pattern_id = coalesce(current_week.pattern_id, schedule.week_pattern_id)
      and pattern_day.day_of_week = extract(isodow from calendar_day)::smallint
      and pattern_day.is_open
    where entry.school_id = target_school
      and schedule.status = 'published'
      and entry.entry_type = 'lesson'
      and entry.class_id is not null
      and extract(isodow from calendar_day)::smallint = entry.day_of_week
      and entry.cycle_week = coalesce(current_week.cycle_week, 1)
      and (target_class is null or entry.class_id = target_class)
      and not exists (
        select 1 from public.timetable_date_overrides date_override
        where date_override.school_id = schedule.school_id
          and date_override.schedule_id = schedule.id
          and date_override.event_date = calendar_day::date
          and (
            (date_override.action in ('cancel', 'replace') and date_override.original_entry_id = entry.id)
        )
      )
      and not exists (
        select 1 from public.academic_calendar_dates calendar_date
        where calendar_date.school_id = schedule.school_id
          and calendar_date.calendar_id = schedule.calendar_id
          and calendar_date.event_date = calendar_day::date
          and not calendar_date.lessons_allowed
      )
      and exists (
        select 1 from public.class_students roster
        where roster.school_id = entry.school_id and roster.class_id = entry.class_id
      )
    union all
    select date_override.school_id, date_override.class_id, null::uuid,
      date_override.id, date_override.teacher_id, schedule.academic_year_id,
      date_override.event_date, true
    from public.timetable_date_overrides date_override
    join public.timetable_schedules schedule
      on schedule.school_id = date_override.school_id and schedule.id = date_override.schedule_id
    where date_override.school_id = target_school
      and schedule.status = 'published'
      and date_override.event_date between date_from and date_to
      and date_override.action in ('add', 'replace')
      and date_override.entry_type = 'lesson'
      and date_override.class_id is not null
      and (target_class is null or date_override.class_id = target_class)
      and exists (
        select 1 from public.class_students roster
        where roster.school_id = date_override.school_id and roster.class_id = date_override.class_id
      )
  )
  insert into public.attendance_sessions (
    school_id, class_id, attendance_date, recorded_by, session_type,
    lesson_entry_id, date_override_id, academic_year_id, assigned_teacher_id,
    non_school_day_override, override_reason
  )
  select target_school, candidate.class_id, candidate.session_date, auth.uid(), 'lesson',
    candidate.lesson_entry_id, candidate.date_override_id, candidate.academic_year_id,
    candidate.teacher_id, candidate.authorized_override,
    case when candidate.authorized_override then 'Authorized timetable date override' else null end
  from candidate_lessons candidate
  on conflict do nothing;
  get diagnostics created_count = row_count;
  return created_count;
end;
$$;

create or replace function public.run_attendance_followup_scan(target_school uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  settings public.attendance_settings%rowtype;
  created_count integer := 0;
  inserted_count integer;
  locked_count integer := 0;
  target_session public.attendance_sessions%rowtype;
begin
  if target_school is null or not public.can_manage_timetable(target_school) then
    raise exception 'Only school administrators and academic coordinators can run attendance follow-up.';
  end if;
  select * into settings from public.attendance_settings setting
  where setting.school_id = target_school;

  insert into public.attendance_followup_tasks (school_id, student_id, task_type, title, details, created_by)
  select target_school, record.student_id, 'repeated_absence', 'Review repeated absences',
    count(*)::text || ' absent registers in the last 30 days.', auth.uid()
  from public.attendance_records record
  join public.attendance_sessions session
    on session.school_id = record.school_id and session.id = record.session_id
  where record.school_id = target_school
    and record.status = 'absent'
    and session.attendance_date >= current_date - 30
    and session.attendance_date <= current_date
  group by record.student_id
  having count(*) >= settings.repeated_absence_threshold
  on conflict (school_id, student_id, task_type) where status <> 'resolved' do nothing;
  get diagnostics inserted_count = row_count;
  created_count := created_count + inserted_count;

  insert into public.attendance_followup_tasks (school_id, student_id, task_type, title, details, created_by)
  with recursive school_days as (
    select student.id as student_id, student.school_id, class_record.calendar_id,
      day_value::date as school_date,
      pattern_day.is_open
        and not exists (
          select 1 from public.academic_calendar_dates calendar_date
          where calendar_date.school_id = class_record.school_id
            and calendar_date.calendar_id = class_record.calendar_id
            and calendar_date.event_date = day_value::date
            and not calendar_date.lessons_allowed
        ) as is_teaching_day
    from public.students student
    join public.school_classes class_record
      on class_record.school_id = student.school_id and class_record.id = student.class_id
    join lateral (
      select coalesce(
        (select schedule.week_pattern_id from public.timetable_schedules schedule
         where schedule.school_id = class_record.school_id
           and schedule.calendar_id = class_record.calendar_id
           and schedule.academic_year_id is not distinct from class_record.academic_year_id
           and schedule.status = 'published'
         order by schedule.updated_at desc limit 1),
        (select pattern.id from public.academic_calendar_week_patterns pattern
         where pattern.school_id = class_record.school_id
           and pattern.calendar_id = class_record.calendar_id
         order by (pattern.name = 'Standard') desc, pattern.created_at limit 1)
      ) as pattern_id
    ) selected_pattern on selected_pattern.pattern_id is not null
    cross join generate_series(current_date - 30, current_date, interval '1 day') day_value
    join public.academic_calendar_pattern_days pattern_day
      on pattern_day.school_id = student.school_id
      and pattern_day.calendar_id = class_record.calendar_id
      and pattern_day.pattern_id = selected_pattern.pattern_id
      and pattern_day.day_of_week = extract(isodow from day_value)::smallint
    where student.school_id = target_school and student.status = 'active'
  ),
  daily_attendance as (
    select school_days.student_id, school_days.school_date, school_days.is_teaching_day,
      exists (
        select 1 from public.attendance_records record
        join public.attendance_sessions session
          on session.school_id = record.school_id and session.id = record.session_id
        where record.school_id = school_days.school_id
          and record.student_id = school_days.student_id
          and session.attendance_date = school_days.school_date
          and record.status = 'absent'
          and session.session_type in ('daily', 'morning', 'afternoon')
      ) as is_absent
    from school_days
  ),
  reverse_days as (
    select daily_attendance.*,
      row_number() over (partition by student_id order by school_date desc) as day_rank
    from daily_attendance
    where is_teaching_day
  ),
  consecutive_counts as (
    select student_id, count(*) as absent_days
    from reverse_days
    where day_rank <= settings.consecutive_absence_threshold
    group by student_id
    having count(*) = settings.consecutive_absence_threshold
      and bool_and(is_absent)
  )
  select target_school, consecutive_counts.student_id, 'consecutive_absence',
    'Check consecutive absences',
    consecutive_counts.absent_days::text || ' consecutive school days marked absent.', auth.uid()
  from consecutive_counts
  on conflict (school_id, student_id, task_type) where status <> 'resolved' do nothing;
  get diagnostics inserted_count = row_count;
  created_count := created_count + inserted_count;

  insert into public.attendance_followup_tasks (school_id, student_id, task_type, title, details, created_by)
  select target_school, summary.student_id, 'below_threshold', 'Attendance below warning level',
    'Attendance is ' || round(summary.attendance_percent, 1)::text || '%; school warning level is '
      || settings.attendance_warning_percent::text || '%.', auth.uid()
  from (
    select record.student_id,
      100.0 * count(*) filter (
        where status_setting.counts_as_present
          or (record.status = 'excused' and settings.excused_counts_as_present)
      )::numeric / nullif(count(*), 0) as attendance_percent
    from public.attendance_records record
    join public.attendance_sessions session
      on session.school_id = record.school_id and session.id = record.session_id
    join public.attendance_status_settings status_setting
      on status_setting.school_id = record.school_id and status_setting.status = record.status
    where record.school_id = target_school
      and (
        (settings.attendance_calculation_basis = 'daily' and session.session_type <> 'lesson')
        or (settings.attendance_calculation_basis = 'lesson' and session.session_type = 'lesson')
      )
    group by record.student_id
  ) summary
  where summary.attendance_percent < settings.attendance_warning_percent
  on conflict (school_id, student_id, task_type) where status <> 'resolved' do nothing;
  get diagnostics inserted_count = row_count;
  created_count := created_count + inserted_count;
  if settings.auto_lock_after_days is not null then
    for target_session in
      select session.* from public.attendance_sessions session
      where session.school_id = target_school
        and session.status = 'submitted'
        and session.submitted_at < now() - settings.auto_lock_after_days * interval '1 day'
      for update
    loop
      perform set_config('app.attendance_transition', target_session.id::text, true);
      update public.attendance_sessions
      set status = 'closed', closed_by = auth.uid(), closed_at = now()
      where school_id = target_school and id = target_session.id;
      locked_count := locked_count + 1;
    end loop;
  end if;
  return created_count;
end;
$$;

create or replace function public.review_attendance_leave_request(
  target_request uuid,
  decision text,
  note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  leave_request public.attendance_leave_requests%rowtype;
begin
  if decision not in ('approved', 'rejected') then
    raise exception 'Choose approve or reject.';
  end if;
  select * into leave_request from public.attendance_leave_requests
  where id = target_request for update;
  if not found or not public.can_manage_timetable(leave_request.school_id) then
    raise exception 'You are not authorized to review this leave request.';
  end if;
  if leave_request.status <> 'pending' then
    raise exception 'Only pending leave requests can be reviewed.';
  end if;
  perform set_config('app.attendance_leave_review', leave_request.id::text, true);
  update public.attendance_leave_requests
  set status = decision, reviewed_by = auth.uid(), reviewed_at = now(),
    review_note = nullif(trim(note), '')
  where id = target_request;
  if decision = 'approved' then
    update public.attendance_records record
    set status = 'excused', absence_category = leave_request.category,
      absence_reason = leave_request.reason
    from public.attendance_sessions session
    where session.school_id = leave_request.school_id
      and session.id = record.session_id
      and record.school_id = leave_request.school_id
      and record.student_id = leave_request.student_id
      and session.attendance_date between leave_request.start_date and leave_request.end_date
      and record.status = 'absent';
  end if;
end;
$$;

create or replace function public.review_attendance_correction_request(
  target_request uuid,
  decision text,
  note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  correction public.attendance_correction_requests%rowtype;
begin
  if decision not in ('approved', 'rejected') then
    raise exception 'Choose approve or reject.';
  end if;
  select * into correction from public.attendance_correction_requests
  where id = target_request for update;
  if not found or not public.can_manage_timetable(correction.school_id) then
    raise exception 'You are not authorized to review this correction request.';
  end if;
  if correction.status <> 'pending' then
    raise exception 'Only pending correction requests can be reviewed.';
  end if;
  perform set_config('app.attendance_correction_review', target_request::text, true);
  update public.attendance_correction_requests
  set status = decision, reviewed_by = auth.uid(), reviewed_at = now(),
    review_note = nullif(trim(note), '')
  where id = target_request;
  if decision = 'approved' then
    if correction.requested_status is null then
      raise exception 'Choose a replacement attendance status before approving this request.';
    end if;
    perform set_config('app.attendance_review', correction.session_id::text, true);
    update public.attendance_records
    set status = correction.requested_status,
      arrival_time = case when correction.requested_status = 'late'
        then coalesce(correction.requested_arrival_time, arrival_time) else arrival_time end
    where school_id = correction.school_id
      and session_id = correction.session_id
      and student_id = correction.student_id;
    if not found then
      raise exception 'The attendance record no longer exists.';
    end if;
  end if;
end;
$$;

create or replace function public.update_attendance_followup_task(
  target_task uuid,
  next_status text,
  assignee uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_school uuid;
begin
  if next_status not in ('open', 'in_progress', 'resolved') then
    raise exception 'Choose a valid follow-up status.';
  end if;
  select task.school_id into target_school from public.attendance_followup_tasks task
  where task.id = target_task;
  if target_school is null or not public.can_manage_timetable(target_school) then
    raise exception 'You are not authorized to update this follow-up task.';
  end if;
  if assignee is not null and not exists (
    select 1 from public.school_memberships membership
    where membership.school_id = target_school and membership.profile_id = assignee
  ) then
    raise exception 'The assigned staff member must belong to this school.';
  end if;
  update public.attendance_followup_tasks
  set status = next_status, assigned_to = coalesce(assignee, assigned_to),
    resolved_by = case when next_status = 'resolved' then auth.uid() else null end,
    resolved_at = case when next_status = 'resolved' then now() else null end
  where id = target_task;
end;
$$;

alter table public.attendance_substitute_assignments enable row level security;
alter table public.attendance_leave_requests enable row level security;
alter table public.attendance_followup_tasks enable row level security;
alter table public.attendance_correction_requests enable row level security;
alter table public.attendance_notification_templates enable row level security;
alter table public.attendance_notification_deliveries enable row level security;
alter table public.attendance_absence_reminder_history enable row level security;

create policy "Staff read attendance substitute assignments"
  on public.attendance_substitute_assignments for select to authenticated
  using (
    public.can_manage_timetable(school_id)
    or exists (
      select 1 from public.attendance_sessions session
      where session.school_id = attendance_substitute_assignments.school_id
        and session.id = attendance_substitute_assignments.session_id
        and public.is_teacher_for_class(session.school_id, session.class_id)
    )
  );
create policy "Coordinators manage attendance substitute assignments"
  on public.attendance_substitute_assignments for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));

create policy "Families and staff read leave requests"
  on public.attendance_leave_requests for select to authenticated
  using (
    public.can_manage_timetable(school_id)
    or public.is_parent_of_student(school_id, student_id)
    or exists (
      select 1 from public.students student
      where student.school_id = attendance_leave_requests.school_id
        and student.id = attendance_leave_requests.student_id
        and student.profile_id = auth.uid()
    )
  );
create policy "Parents submit linked student leave requests"
  on public.attendance_leave_requests for insert to authenticated
  with check (
    requested_by = auth.uid()
    and status = 'pending'
    and reviewed_by is null
    and reviewed_at is null
    and review_note is null
    and reviewed_by is null
    and (
      public.is_parent_of_student(school_id, student_id)
      or exists (
        select 1 from public.students student
        where student.school_id = attendance_leave_requests.school_id
          and student.id = attendance_leave_requests.student_id
          and student.profile_id = auth.uid()
      )
    )
  );
create policy "Parents withdraw pending leave requests"
  on public.attendance_leave_requests for update to authenticated
  using (
    requested_by = auth.uid()
    and status = 'pending'
    and (
      public.is_parent_of_student(school_id, student_id)
      or exists (
        select 1 from public.students student
        where student.school_id = attendance_leave_requests.school_id
          and student.id = attendance_leave_requests.student_id
          and student.profile_id = auth.uid()
      )
    )
  )
  with check (requested_by = auth.uid() and status = 'withdrawn');
create policy "Families read correction requests"
  on public.attendance_correction_requests for select to authenticated
  using (
    public.can_manage_timetable(school_id)
    or exists (select 1 from public.students student where student.id = attendance_correction_requests.student_id and student.profile_id = auth.uid())
    or public.is_parent_of_student(school_id, student_id)
    or exists (
      select 1 from public.attendance_sessions session
      where session.school_id = attendance_correction_requests.school_id
        and session.id = attendance_correction_requests.session_id
        and public.is_teacher_for_class(session.school_id, session.class_id)
    )
  );
create policy "Families submit attendance correction requests"
  on public.attendance_correction_requests for insert to authenticated
  with check (
    requested_by = auth.uid()
    and status = 'pending'
    and reviewed_by is null
    and (
      public.is_parent_of_student(school_id, student_id)
      or exists (select 1 from public.students student where student.id = attendance_correction_requests.student_id and student.profile_id = auth.uid())
    )
    and exists (
      select 1 from public.attendance_sessions session
      where session.school_id = attendance_correction_requests.school_id
        and session.id = attendance_correction_requests.session_id
        and session.status <> 'open'
    )
  );
create policy "Families withdraw pending correction requests"
  on public.attendance_correction_requests for update to authenticated
  using (
    requested_by = auth.uid()
    and status = 'pending'
    and (
      public.is_parent_of_student(school_id, student_id)
      or exists (select 1 from public.students student where student.id = attendance_correction_requests.student_id and student.profile_id = auth.uid())
    )
  )
  with check (
    requested_by = auth.uid() and status = 'withdrawn'
  );

create or replace function public.guard_attendance_correction_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if current_setting('app.attendance_correction_review', true) = old.id::text
       and public.can_manage_timetable(old.school_id)
       and old.status = 'pending'
       and new.status in ('approved', 'rejected')
       and new.reviewed_by = auth.uid()
       and new.reviewed_at is not null
       and new.school_id = old.school_id
       and new.session_id = old.session_id
       and new.student_id = old.student_id
       and new.requested_by = old.requested_by
       and new.requested_status is not distinct from old.requested_status
       and new.requested_arrival_time is not distinct from old.requested_arrival_time
       and new.reason = old.reason then
      return new;
    end if;
    if old.status = 'pending'
       and new.status = 'withdrawn'
       and old.requested_by = auth.uid()
       and new.school_id = old.school_id
       and new.session_id = old.session_id
       and new.student_id = old.student_id
       and new.requested_by = old.requested_by
       and new.requested_status is not distinct from old.requested_status
       and new.requested_arrival_time is not distinct from old.requested_arrival_time
       and new.reason = old.reason
       and new.reviewed_by is not distinct from old.reviewed_by
       and new.reviewed_at is not distinct from old.reviewed_at
       and new.review_note is not distinct from old.review_note then
      return new;
    end if;
    raise exception 'Correction requests cannot be edited after submission.';
  end if;
  if tg_op = 'INSERT' and (new.reviewed_by is not null or new.reviewed_at is not null or new.review_note is not null) then
    raise exception 'New correction requests must be pending and unreviewed.';
  end if;
  return new;
end;
$$;
create trigger guard_attendance_correction_request
  before insert or update on public.attendance_correction_requests
  for each row execute function public.guard_attendance_correction_request();
create policy "Staff read attendance follow-up tasks"
  on public.attendance_followup_tasks for select to authenticated
  using (
    public.can_manage_timetable(school_id)
    or assigned_to = auth.uid()
    or exists (
      select 1 from public.students student
      where student.school_id = attendance_followup_tasks.school_id
        and student.id = attendance_followup_tasks.student_id
        and student.class_id is not null
        and public.is_teacher_for_class(student.school_id, student.class_id)
    )
  );
create policy "Coordinators manage attendance notification templates"
  on public.attendance_notification_templates for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));
create policy "Staff read attendance notification deliveries"
  on public.attendance_notification_deliveries for select to authenticated
  using (
    recipient_profile_id = auth.uid()
    or public.can_manage_timetable(school_id)
  );
create policy "Families read absence reminder history"
  on public.attendance_absence_reminder_history for select to authenticated
  using (
    recipient_profile_id = auth.uid()
    or public.can_manage_timetable(school_id)
  );

create or replace function public.validate_attendance_correction_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.attendance_sessions session
    join public.class_students roster
      on roster.school_id = session.school_id and roster.class_id = session.class_id
    where session.school_id = new.school_id
      and session.id = new.session_id
      and roster.student_id = new.student_id
  ) then
    raise exception 'The requested correction must match a student enrolled in this register.';
  end if;
  return new;
end;
$$;
create trigger validate_attendance_correction_request
  before insert or update on public.attendance_correction_requests
  for each row execute function public.validate_attendance_correction_request();

create or replace function public.validate_attendance_substitute_assignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.teacher_profiles teacher
    where teacher.school_id = new.school_id and teacher.id = new.substitute_teacher_id
  ) then
    raise exception 'The substitute teacher must belong to this school.';
  end if;
  return new;
end;
$$;
create trigger validate_attendance_substitute_assignment
  before insert or update on public.attendance_substitute_assignments
  for each row execute function public.validate_attendance_substitute_assignment();

create or replace function public.sync_timetable_teacher_to_attendance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.attendance_sessions session
  set assigned_teacher_id = new.teacher_id
  where session.school_id = new.school_id
    and session.lesson_entry_id = new.id
    and session.status = 'open'
    and session.attendance_date >= current_date
    and session.class_id = new.class_id
    and session.attendance_date is not null
    and extract(isodow from session.attendance_date)::smallint = new.day_of_week
    and not exists (
      select 1 from public.attendance_records record
      where record.school_id = session.school_id and record.session_id = session.id
    );
  return new;
end;
$$;
create trigger sync_timetable_teacher_to_attendance
  after update of teacher_id on public.timetable
  for each row when (old.teacher_id is distinct from new.teacher_id)
  execute function public.sync_timetable_teacher_to_attendance();

create or replace function public.sync_timetable_override_to_attendance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.action = 'cancel' or new.entry_type <> 'lesson' then
    delete from public.attendance_sessions session
    where session.school_id = new.school_id
      and session.date_override_id = new.id
      and session.status = 'open'
      and not exists (
        select 1 from public.attendance_records record
        where record.school_id = session.school_id and record.session_id = session.id
      );
    return new;
  end if;

  update public.attendance_sessions session
  set class_id = new.class_id,
    attendance_date = new.event_date,
    assigned_teacher_id = new.teacher_id,
    academic_year_id = null,
    term_id = null
  where session.school_id = new.school_id
    and session.date_override_id = new.id
    and session.status = 'open'
    and session.attendance_date >= current_date
    and not exists (
      select 1 from public.attendance_records record
      where record.school_id = session.school_id and record.session_id = session.id
    );
  return new;
end;
$$;
create or replace function public.guard_timetable_override_attendance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (
    new.action, new.entry_type, new.class_id, new.event_date, new.teacher_id
  ) is distinct from (
    old.action, old.entry_type, old.class_id, old.event_date, old.teacher_id
  ) and exists (
    select 1
    from public.attendance_sessions session
    where session.school_id = old.school_id
      and session.date_override_id = old.id
      and (
        session.status <> 'open'
        or exists (
          select 1 from public.attendance_records record
          where record.school_id = session.school_id and record.session_id = session.id
        )
      )
  ) then
    raise exception 'A timetable date override cannot be changed after attendance has been submitted or recorded.';
  end if;
  return new;
end;
$$;
create trigger guard_timetable_override_attendance
  before update of action, entry_type, class_id, event_date, teacher_id
  on public.timetable_date_overrides
  for each row execute function public.guard_timetable_override_attendance();
create trigger sync_timetable_override_to_attendance
  after update of action, entry_type, teacher_id, class_id, event_date on public.timetable_date_overrides
  for each row when (
    old.action is distinct from new.action
    or old.entry_type is distinct from new.entry_type
    or
    old.teacher_id is distinct from new.teacher_id
    or old.class_id is distinct from new.class_id
    or old.event_date is distinct from new.event_date
  )
  execute function public.sync_timetable_override_to_attendance();

create or replace function public.transition_attendance_session(target_session uuid, target_status text)
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
  has_teacher_access boolean;
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
  has_teacher_access := public.is_teacher_for_class(target.school_id, target.class_id)
    or exists (
      select 1 from public.teacher_profiles teacher
      where teacher.school_id = target.school_id
        and teacher.id = target.assigned_teacher_id
        and teacher.profile_id = auth.uid()
    )
    or exists (
      select 1 from public.attendance_substitute_assignments substitute
      join public.teacher_profiles teacher
        on teacher.school_id = substitute.school_id and teacher.id = substitute.substitute_teacher_id
      where substitute.school_id = target.school_id
        and substitute.session_id = target.id
        and teacher.profile_id = auth.uid()
    );
  if not (public.can_manage_timetable(target.school_id) or (target_status = 'submitted' and has_teacher_access)) then
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
      into require_complete from public.attendance_settings setting
      where setting.school_id = target.school_id;
    require_complete := coalesce(require_complete, true);
    select count(*) into roster_count from public.class_students roster
      where roster.school_id = target.school_id and roster.class_id = target.class_id;
    select count(*) into marked_count
    from public.attendance_records attendance_row
    join public.class_students roster on roster.school_id = attendance_row.school_id
      and roster.class_id = target.class_id and roster.student_id = attendance_row.student_id
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

revoke all on function public.generate_scheduled_attendance_registers(uuid, date, date, uuid) from public;
revoke all on function public.run_attendance_followup_scan(uuid) from public;
revoke all on function public.review_attendance_leave_request(uuid, text, text) from public;
revoke all on function public.review_attendance_correction_request(uuid, text, text) from public;
revoke all on function public.update_attendance_followup_task(uuid, text, uuid) from public;
grant execute on function public.generate_scheduled_attendance_registers(uuid, date, date, uuid) to authenticated;
grant execute on function public.run_attendance_followup_scan(uuid) to authenticated;
grant execute on function public.review_attendance_leave_request(uuid, text, text) to authenticated;
grant execute on function public.review_attendance_correction_request(uuid, text, text) to authenticated;
grant execute on function public.update_attendance_followup_task(uuid, text, uuid) to authenticated;
grant execute on function public.transition_attendance_session(uuid, text) to authenticated;

grant select, insert, update, delete on public.attendance_substitute_assignments to authenticated;
grant select, insert, update on public.attendance_leave_requests to authenticated;
grant select, insert on public.attendance_followup_tasks to authenticated;
grant select, insert on public.attendance_correction_requests to authenticated;
grant select, insert, update, delete on public.attendance_notification_templates to authenticated;
grant select on public.attendance_notification_deliveries to authenticated;
grant select on public.attendance_absence_reminder_history to authenticated;
grant usage, select on sequence public.attendance_notification_deliveries_id_seq to authenticated;

create trigger set_updated_at
  before update on public.attendance_leave_requests
  for each row execute function public.set_updated_at();
create trigger set_updated_at
  before update on public.attendance_followup_tasks
  for each row execute function public.set_updated_at();

create extension if not exists pg_cron;

create or replace function public.run_attendance_daily_register_generation()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  school_target record;
  school_local_date date;
begin
  for school_target in
    select distinct on (school.id) school.id as school_id, school.timezone, membership.profile_id
    from public.schools school
    join public.school_memberships membership on membership.school_id = school.id
    where membership.role::text in ('school_admin', 'academic_coordinator')
      and exists (
        select 1 from public.timetable_schedules schedule
        where schedule.school_id = school.id and schedule.status = 'published'
      )
    order by school.id, membership.profile_id::text
  loop
    perform set_config('request.jwt.claim.sub', school_target.profile_id::text, true);
    school_local_date := (now() at time zone school_target.timezone)::date;
    perform public.generate_scheduled_attendance_registers(
      school_target.school_id,
      school_local_date,
      school_local_date,
      null
    );
  end loop;
end;
$$;

create or replace function public.run_attendance_daily_followup()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  school_target record;
begin
  for school_target in
    select distinct on (school.id) school.id as school_id, membership.profile_id
    from public.schools school
    join public.school_memberships membership on membership.school_id = school.id
    where membership.role::text in ('school_admin', 'academic_coordinator')
    order by school.id, membership.profile_id::text
  loop
    perform set_config('request.jwt.claim.sub', school_target.profile_id::text, true);
    perform public.run_attendance_followup_scan(school_target.school_id);
    perform public.apply_attendance_leave_reminder_scan(school_target.school_id);
  end loop;
end;
$$;

revoke all on function public.run_attendance_daily_register_generation() from public, authenticated, anon;
revoke all on function public.run_attendance_daily_followup() from public, authenticated, anon;
select cron.schedule(
  'campus-connect-attendance-registers',
  '*/15 * * * *',
  'select public.run_attendance_daily_register_generation()'
);
select cron.schedule(
  'campus-connect-attendance-followup',
  '15 4 * * *',
  'select public.run_attendance_daily_followup()'
);

create or replace function public.is_attendance_session_assignee(target_school uuid, target_session uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.attendance_sessions session
    join public.teacher_profiles teacher
      on teacher.school_id = session.school_id
      and teacher.id = session.assigned_teacher_id
    where session.school_id = target_school
      and session.id = target_session
      and teacher.profile_id = auth.uid()
  ) or exists (
    select 1
    from public.attendance_substitute_assignments substitute
    join public.teacher_profiles teacher
      on teacher.school_id = substitute.school_id
      and teacher.id = substitute.substitute_teacher_id
    where substitute.school_id = target_school
      and substitute.session_id = target_session
      and teacher.profile_id = auth.uid()
  );
$$;
revoke all on function public.is_attendance_session_assignee(uuid, uuid) from public;
grant execute on function public.is_attendance_session_assignee(uuid, uuid) to authenticated;

create or replace function public.is_attendance_class_assignee(target_school uuid, target_class uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.attendance_sessions session
    where session.school_id = target_school
      and session.class_id = target_class
      and public.is_attendance_session_assignee(session.school_id, session.id)
  );
$$;
revoke all on function public.is_attendance_class_assignee(uuid, uuid) from public;
grant execute on function public.is_attendance_class_assignee(uuid, uuid) to authenticated;

drop policy if exists "Staff read attendance substitute assignments" on public.attendance_substitute_assignments;
create policy "Staff read attendance substitute assignments"
  on public.attendance_substitute_assignments for select to authenticated
  using (
    public.can_manage_timetable(school_id)
    or public.is_attendance_session_assignee(school_id, session_id)
    or exists (
      select 1 from public.attendance_sessions session
      where session.school_id = attendance_substitute_assignments.school_id
        and session.id = attendance_substitute_assignments.session_id
        and public.is_teacher_for_class(session.school_id, session.class_id)
    )
  );

drop policy if exists "Authorized users read attendance sessions" on public.attendance_sessions;
create policy "Authorized users read attendance sessions"
  on public.attendance_sessions for select to authenticated
  using (
    public.can_manage_timetable(school_id)
    or public.is_teacher_for_class(school_id, class_id)
    or public.is_attendance_session_assignee(school_id, id)
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
drop policy if exists "Authorized staff update attendance sessions" on public.attendance_sessions;
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

drop policy if exists "Authorized users read students" on public.students;
create policy "Authorized users read students" on public.students for select to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or profile_id = auth.uid()
  or public.is_parent_of_student(school_id, id)
  or (class_id is not null and (
    public.is_teacher_for_class(school_id, class_id)
    or public.is_attendance_class_assignee(school_id, class_id)
  ))
);
drop policy if exists "Members read class rosters" on public.class_students;
create policy "Members read class rosters" on public.class_students for select to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or public.is_teacher_for_class(school_id, class_id)
  or public.is_attendance_class_assignee(school_id, class_id)
  or exists (select 1 from public.students student where student.id = student_id and student.profile_id = auth.uid())
  or public.is_parent_of_student(school_id, student_id)
);

drop policy if exists "Authorized users read attendance records" on public.attendance_records;
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
        and (
          public.is_teacher_for_class(session.school_id, session.class_id)
          or public.is_attendance_session_assignee(session.school_id, session.id)
        )
    )
  );
drop policy if exists "Authorized staff manage attendance records" on public.attendance_records;
create policy "Authorized staff manage attendance records"
  on public.attendance_records for all to authenticated
  using (
    public.can_manage_timetable(school_id)
    or exists (
      select 1 from public.attendance_sessions session
      join public.class_students roster
        on roster.school_id = session.school_id
        and roster.class_id = session.class_id
        and roster.student_id = attendance_records.student_id
      where session.school_id = attendance_records.school_id
        and session.id = attendance_records.session_id
        and (
          public.is_teacher_for_class(session.school_id, session.class_id)
          or public.is_attendance_session_assignee(session.school_id, session.id)
        )
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
        and (
          public.is_teacher_for_class(session.school_id, session.class_id)
          or public.is_attendance_session_assignee(session.school_id, session.id)
        )
    )
  );

create or replace function public.apply_attendance_leave_reminder_scan(target_school uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected_count integer;
begin
  if target_school is null or not public.can_manage_timetable(target_school) then
    raise exception 'Only school administrators and academic coordinators can run attendance follow-up.';
  end if;

  with eligible as (
    select distinct session.school_id, session.id as session_id, record.student_id,
      session.attendance_date, student.first_name || ' ' || student.last_name as student_name
    from public.attendance_sessions session
    join public.attendance_records record
      on record.school_id = session.school_id and record.session_id = session.id
    join public.students student
      on student.school_id = record.school_id and student.id = record.student_id
    where session.school_id = target_school
      and record.status = 'absent'
      and record.absence_category = 'unexplained'
      and session.attendance_date <= current_date - 2
      and not exists (
        select 1 from public.attendance_parent_explanations explanation
        where explanation.school_id = session.school_id
          and explanation.student_id = record.student_id
          and explanation.attendance_date = session.attendance_date
      )
  ), recipients as (
    select eligible.*, recipient_profile_id
    from eligible
    cross join lateral (
      select parent.profile_id as recipient_profile_id
      from public.parent_students relation
      join public.parent_profiles parent
        on parent.school_id = relation.school_id and parent.id = relation.parent_id
      where relation.school_id = eligible.school_id
        and relation.student_id = eligible.student_id
        and parent.profile_id is not null
      union
      select student.profile_id
      from public.students student
      where student.school_id = eligible.school_id
        and student.id = eligible.student_id
        and student.profile_id is not null
    ) linked_recipient
  ), inserted_reminders as (
    insert into public.attendance_absence_reminder_history (
      school_id, session_id, student_id, recipient_profile_id
    )
    select recipients.school_id, recipients.session_id, recipients.student_id, recipients.recipient_profile_id
    from recipients
    on conflict (session_id, student_id, recipient_profile_id) do nothing
    returning school_id, session_id, student_id, recipient_profile_id
  )
  insert into public.notifications (school_id, profile_id, title, body, target_path)
  select reminder.school_id, reminder.recipient_profile_id,
    'Absence explanation needed',
    student.first_name || ' ' || student.last_name
      || ' was marked absent on ' || session.attendance_date::text
      || '. Please submit an explanation if appropriate.',
    '/attendance'
  from inserted_reminders reminder
  join public.attendance_sessions session
    on session.school_id = reminder.school_id and session.id = reminder.session_id
  join public.students student
    on student.school_id = reminder.school_id and student.id = reminder.student_id;
  get diagnostics affected_count = row_count;
  return affected_count;
end;
$$;

revoke all on function public.apply_attendance_leave_reminder_scan(uuid) from public;
grant execute on function public.apply_attendance_leave_reminder_scan(uuid) to authenticated;
