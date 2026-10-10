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
  add column attendance_calculation_basis text not null default 'daily'
    check (attendance_calculation_basis in ('daily', 'lesson')),
  add column excused_counts_as_present boolean not null default false;

alter table public.attendance_sessions
  add column assigned_teacher_id uuid,
  add constraint attendance_sessions_assigned_teacher_fk
    foreign key (school_id, assigned_teacher_id)
    references public.teacher_profiles(school_id, id) on delete set null (assigned_teacher_id);

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
  reason text not null check (char_length(trim(reason)) between 3 and 1000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
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

  insert into public.attendance_sessions (
    school_id, class_id, attendance_date, recorded_by, session_type,
    lesson_entry_id, academic_year_id, assigned_teacher_id
  )
  select target_school, entry.class_id, calendar_day::date, auth.uid(), 'lesson',
    entry.id, schedule.academic_year_id, entry.teacher_id
  from public.timetable entry
  join public.timetable_schedules schedule
    on schedule.school_id = entry.school_id and schedule.id = entry.schedule_id
  cross join generate_series(date_from, date_to, interval '1 day') calendar_day
  join public.academic_calendar_pattern_days pattern_day
    on pattern_day.school_id = schedule.school_id
    and pattern_day.calendar_id = schedule.calendar_id
    and pattern_day.pattern_id = schedule.week_pattern_id
    and pattern_day.day_of_week = extract(isodow from calendar_day)::smallint
    and pattern_day.is_open
  where entry.school_id = target_school
    and schedule.status = 'published'
    and entry.entry_type = 'lesson'
    and entry.class_id is not null
    and extract(isodow from calendar_day)::smallint = entry.day_of_week
    and (target_class is null or entry.class_id = target_class)
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
  on conflict do nothing;
  get diagnostics created_count = row_count;
  return created_count;
end;
$$;

create or replace function public.run_attendance_followup_scan()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  target_school uuid;
  settings public.attendance_settings%rowtype;
  created_count integer := 0;
  inserted_count integer;
begin
  select membership.school_id into target_school
  from public.school_memberships membership
  where membership.profile_id = auth.uid()
    and public.can_manage_timetable(membership.school_id)
  order by membership.school_id
  limit 1;
  if target_school is null then
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
    join public.attendance_status_settings status_setting
      on status_setting.school_id = record.school_id and status_setting.status = record.status
    where record.school_id = target_school
    group by record.student_id
  ) summary
  where summary.attendance_percent < settings.attendance_warning_percent
  on conflict (school_id, student_id, task_type) where status <> 'resolved' do nothing;
  get diagnostics inserted_count = row_count;
  created_count := created_count + inserted_count;
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
    set status = correction.requested_status
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
    and public.is_parent_of_student(school_id, student_id)
  );
create policy "Parents withdraw pending leave requests"
  on public.attendance_leave_requests for update to authenticated
  using (
    requested_by = auth.uid()
    and status = 'pending'
    and public.is_parent_of_student(school_id, student_id)
  )
  with check (requested_by = auth.uid() and status = 'withdrawn');
create policy "Families read correction requests"
  on public.attendance_correction_requests for select to authenticated
  using (
    public.can_manage_timetable(school_id)
    or exists (select 1 from public.students student where student.id = attendance_correction_requests.student_id and student.profile_id = auth.uid())
    or public.is_parent_of_student(school_id, student_id)
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
revoke all on function public.run_attendance_followup_scan() from public;
revoke all on function public.review_attendance_leave_request(uuid, text, text) from public;
revoke all on function public.review_attendance_correction_request(uuid, text, text) from public;
revoke all on function public.update_attendance_followup_task(uuid, text, uuid) from public;
grant execute on function public.generate_scheduled_attendance_registers(uuid, date, date, uuid) to authenticated;
grant execute on function public.run_attendance_followup_scan() to authenticated;
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
    or public.is_attendance_session_assignee(school_id, id)
  )
  with check (
    public.can_manage_timetable(school_id)
    or public.is_teacher_for_class(school_id, class_id)
    or public.is_attendance_session_assignee(school_id, id)
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

create policy "Teachers read attendance for assigned sessions"
  on public.attendance_records for select to authenticated
  using (public.is_attendance_session_assignee(school_id, session_id));

create or replace function public.apply_attendance_leave_reminder_scan()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  target_school uuid;
  affected_count integer;
begin
  select membership.school_id into target_school
  from public.school_memberships membership
  where membership.profile_id = auth.uid()
    and public.can_manage_timetable(membership.school_id)
  order by membership.school_id
  limit 1;
  if target_school is null then
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

revoke all on function public.apply_attendance_leave_reminder_scan() from public;
grant execute on function public.apply_attendance_leave_reminder_scan() to authenticated;
