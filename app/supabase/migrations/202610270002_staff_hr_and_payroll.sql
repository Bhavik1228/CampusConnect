alter table public.staff_profiles
  add column if not exists profile_id uuid references public.profiles(id) on delete set null,
  add column if not exists leave_status_synced boolean not null default false;

create unique index if not exists staff_profiles_school_profile_unique
  on public.staff_profiles(school_id, profile_id)
  where profile_id is not null;

update public.staff_profiles staff
set profile_id = teacher.profile_id
from public.teacher_profiles teacher
where teacher.school_id = staff.school_id
  and teacher.staff_profile_id = staff.id
  and staff.profile_id is null
  and teacher.profile_id is not null;

create or replace function public.is_staff_administrator(target_school uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.has_school_role(target_school, array['school_admin']::public.app_role[])
    or exists (
      select 1 from public.school_memberships membership
      where membership.school_id = target_school
        and membership.profile_id = auth.uid()
        and membership.role::text = 'hr_staff_administrator'
    );
$$;
revoke all on function public.is_staff_administrator(uuid) from public, anon;
grant execute on function public.is_staff_administrator(uuid) to authenticated;

alter table public.staff_documents
  add column if not exists document_type text not null default 'other'
    check (document_type in ('employment', 'identity', 'qualification', 'safeguarding', 'medical', 'other')),
  add column if not exists expires_on date;

create table public.staff_qualifications (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  staff_id uuid not null,
  qualification_name text not null check (char_length(trim(qualification_name)) between 2 and 160),
  issuer text not null default '' check (char_length(issuer) <= 160),
  credential_number text not null default '' check (char_length(credential_number) <= 100),
  issued_on date,
  expires_on date,
  status text not null default 'active' check (status in ('active', 'expired', 'revoked')),
  staff_document_id uuid,
  verified_by uuid references public.profiles(id),
  verified_at timestamptz,
  notes text not null default '' check (char_length(notes) <= 1000),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, staff_id)
    references public.staff_profiles(school_id, id) on delete cascade,
  foreign key (school_id, staff_document_id)
    references public.staff_documents(school_id, id) on delete set null (staff_document_id),
  check (expires_on is null or issued_on is null or expires_on >= issued_on)
);
create index staff_qualifications_expiry_idx
  on public.staff_qualifications(school_id, expires_on) where status = 'active';

create table public.staff_attendance_records (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  staff_id uuid not null,
  attendance_date date not null,
  status text not null check (status in ('present', 'late', 'absent', 'on_leave')),
  check_in time,
  check_out time,
  note text not null default '' check (char_length(note) <= 500),
  recorded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, staff_id, attendance_date),
  foreign key (school_id, staff_id)
    references public.staff_profiles(school_id, id) on delete cascade,
  check (check_in is null or check_out is null or check_out >= check_in),
  check (status in ('present', 'late') or (check_in is null and check_out is null))
);
create index staff_attendance_date_idx
  on public.staff_attendance_records(school_id, attendance_date, status);

create table public.staff_leave_requests (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  staff_id uuid not null,
  leave_type text not null check (leave_type in ('annual', 'sick', 'personal', 'family', 'unpaid', 'other')),
  start_date date not null,
  end_date date not null,
  reason text not null check (char_length(trim(reason)) between 3 and 1000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  review_note text not null default '' check (char_length(review_note) <= 1000),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  requested_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, staff_id)
    references public.staff_profiles(school_id, id) on delete cascade,
  check (end_date >= start_date),
  check (end_date - start_date <= 365)
);
create index staff_leave_school_status_dates_idx
  on public.staff_leave_requests(school_id, status, start_date, end_date);

create table public.staff_leave_coverage (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  leave_request_id uuid not null,
  substitute_staff_id uuid not null,
  coverage_notes text not null default '' check (char_length(coverage_notes) <= 1000),
  status text not null default 'planned' check (status in ('planned', 'completed', 'cancelled')),
  assigned_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, leave_request_id),
  foreign key (school_id, leave_request_id)
    references public.staff_leave_requests(school_id, id) on delete cascade,
  foreign key (school_id, substitute_staff_id)
    references public.staff_profiles(school_id, id) on delete cascade
);

create table public.staff_payroll_profiles (
  school_id uuid not null,
  staff_id uuid not null,
  payroll_identifier text not null check (char_length(trim(payroll_identifier)) between 1 and 80),
  pay_frequency text not null default 'monthly'
    check (pay_frequency in ('weekly', 'biweekly', 'monthly', 'four_weekly')),
  contracted_weekly_hours numeric(5,2) not null default 0
    check (contracted_weekly_hours between 0 and 168),
  updated_by uuid not null references public.profiles(id),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (school_id, staff_id),
  foreign key (school_id, staff_id)
    references public.staff_profiles(school_id, id) on delete cascade
);

create table public.staff_expiry_reminder_history (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  reminder_key text not null,
  reminder_window text not null check (reminder_window in ('30_day', 'expired')),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, reminder_key, reminder_window, profile_id)
);

alter table public.staff_qualifications enable row level security;
alter table public.staff_attendance_records enable row level security;
alter table public.staff_leave_requests enable row level security;
alter table public.staff_leave_coverage enable row level security;
alter table public.staff_payroll_profiles enable row level security;
alter table public.staff_expiry_reminder_history enable row level security;

revoke all on public.staff_qualifications, public.staff_attendance_records,
  public.staff_leave_requests, public.staff_leave_coverage,
  public.staff_payroll_profiles, public.staff_expiry_reminder_history from anon, authenticated;
grant select on public.staff_qualifications, public.staff_attendance_records,
  public.staff_leave_requests, public.staff_leave_coverage to authenticated;

create policy "School and HR administrators read staff qualifications"
  on public.staff_qualifications for select to authenticated
  using (public.is_staff_administrator(school_id));
create policy "School and HR administrators manage staff qualifications"
  on public.staff_qualifications for all to authenticated
  using (public.is_staff_administrator(school_id))
  with check (public.is_staff_administrator(school_id));
create policy "School and HR administrators read staff attendance"
  on public.staff_attendance_records for select to authenticated
  using (public.is_staff_administrator(school_id));
create policy "School and HR administrators manage staff attendance"
  on public.staff_attendance_records for all to authenticated
  using (public.is_staff_administrator(school_id))
  with check (public.is_staff_administrator(school_id));
create policy "School and HR administrators read staff leave"
  on public.staff_leave_requests for select to authenticated
  using (public.is_staff_administrator(school_id));
create policy "School and HR administrators manage staff leave"
  on public.staff_leave_requests for all to authenticated
  using (public.is_staff_administrator(school_id))
  with check (public.is_staff_administrator(school_id));
create policy "School and HR administrators read staff coverage"
  on public.staff_leave_coverage for select to authenticated
  using (public.is_staff_administrator(school_id));
create policy "School and HR administrators manage staff coverage"
  on public.staff_leave_coverage for all to authenticated
  using (public.is_staff_administrator(school_id))
  with check (public.is_staff_administrator(school_id));
create policy "School and HR administrators manage payroll identifiers"
  on public.staff_payroll_profiles for all to authenticated
  using (public.is_staff_administrator(school_id))
  with check (public.is_staff_administrator(school_id));

grant select, insert, update, delete on public.staff_qualifications,
  public.staff_attendance_records, public.staff_leave_requests,
  public.staff_leave_coverage to authenticated;
grant select, insert, update, delete on public.staff_payroll_profiles to authenticated;
revoke all on public.staff_expiry_reminder_history from anon, authenticated;

create or replace function public.record_staff_attendance(
  target_school uuid,
  target_staff uuid,
  target_date date,
  next_status text,
  check_in_time time,
  check_out_time time,
  attendance_note text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  attendance_id uuid;
begin
  if not public.is_staff_administrator(target_school) then
    raise exception 'School or HR administrator access is required.';
  end if;
  if target_date is null or target_date > current_date or target_date < current_date - 366
    or next_status not in ('present', 'late', 'absent', 'on_leave')
    or char_length(coalesce(attendance_note, '')) > 500
    or (next_status not in ('present', 'late') and (check_in_time is not null or check_out_time is not null))
    or (check_in_time is not null and check_out_time is not null and check_out_time < check_in_time) then
    raise exception 'Provide a valid staff attendance date, status, and times.';
  end if;
  if not exists (
    select 1 from public.staff_profiles staff
    where staff.id = target_staff and staff.school_id = target_school
      and staff.employment_status <> 'terminated'
  ) then raise exception 'Choose an active staff record.'; end if;
  if exists (
    select 1 from public.staff_leave_requests leave_request
    where leave_request.school_id = target_school and leave_request.staff_id = target_staff
      and leave_request.status = 'approved'
      and target_date between leave_request.start_date and leave_request.end_date
  ) and next_status <> 'on_leave' then
    raise exception 'This employee has approved leave on the selected date and must be marked on leave.';
  end if;
  insert into public.staff_attendance_records(
    school_id, staff_id, attendance_date, status, check_in, check_out, note, recorded_by, updated_at
  ) values (
    target_school, target_staff, target_date, next_status, check_in_time, check_out_time,
    trim(coalesce(attendance_note, '')), auth.uid(), timezone('utc', now())
  )
  on conflict (school_id, staff_id, attendance_date) do update set
    status = excluded.status,
    check_in = excluded.check_in,
    check_out = excluded.check_out,
    note = excluded.note,
    recorded_by = excluded.recorded_by,
    updated_at = timezone('utc', now())
  returning id into attendance_id;
  return attendance_id;
end;
$$;

create or replace function public.create_staff_leave_request(
  target_school uuid,
  target_staff uuid,
  leave_type text,
  leave_start date,
  leave_end date,
  leave_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  leave_id uuid;
begin
  if not public.is_staff_administrator(target_school) then
    raise exception 'School or HR administrator access is required.';
  end if;
  if leave_type not in ('annual', 'sick', 'personal', 'family', 'unpaid', 'other')
    or leave_start is null or leave_end is null or leave_end < leave_start
    or leave_end - leave_start > 365
    or char_length(trim(coalesce(leave_reason, ''))) not between 3 and 1000 then
    raise exception 'Provide valid leave dates, type, and reason.';
  end if;
  if not exists (
    select 1 from public.staff_profiles staff
    where staff.id = target_staff and staff.school_id = target_school
      and staff.employment_status in ('active', 'on_leave')
  ) then raise exception 'Choose an active employee.'; end if;
  if exists (
    select 1 from public.staff_leave_requests request
    where request.school_id = target_school and request.staff_id = target_staff
      and request.status = 'approved'
      and daterange(request.start_date, request.end_date, '[]') && daterange(leave_start, leave_end, '[]')
  ) then raise exception 'The employee already has approved leave during those dates.'; end if;
  insert into public.staff_leave_requests(
    school_id, staff_id, leave_type, start_date, end_date, reason, requested_by
  ) values (
    target_school, target_staff, leave_type, leave_start, leave_end, trim(leave_reason), auth.uid()
  ) returning id into leave_id;
  return leave_id;
end;
$$;

create or replace function public.review_staff_leave_request(
  target_request uuid,
  decision text,
  decision_note text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  leave_request public.staff_leave_requests%rowtype;
begin
  select * into leave_request from public.staff_leave_requests
  where id = target_request for update;
  if not found or not public.is_staff_administrator(leave_request.school_id) then
    raise exception 'Staff leave request not found or not authorized.';
  end if;
  if leave_request.status <> 'pending' or decision not in ('approved', 'rejected')
    or char_length(coalesce(decision_note, '')) > 1000 then
    raise exception 'Only pending leave requests can be approved or rejected.';
  end if;
  if decision = 'approved' and exists (
    select 1 from public.staff_leave_requests other_request
    where other_request.school_id = leave_request.school_id
      and other_request.staff_id = leave_request.staff_id
      and other_request.id <> leave_request.id and other_request.status = 'approved'
      and daterange(other_request.start_date, other_request.end_date, '[]')
        && daterange(leave_request.start_date, leave_request.end_date, '[]')
  ) then raise exception 'The employee already has approved leave during those dates.'; end if;
  update public.staff_leave_requests
  set status = decision, review_note = trim(coalesce(decision_note, '')),
      reviewed_by = auth.uid(), reviewed_at = timezone('utc', now()),
      updated_at = timezone('utc', now())
  where id = target_request;
  if decision = 'approved' then
    update public.staff_profiles set employment_status = 'on_leave', updated_at = timezone('utc', now())
    where id = leave_request.staff_id and school_id = leave_request.school_id
      and leave_request.start_date <= current_date and leave_request.end_date >= current_date
      and employment_status = 'active';
  end if;
  insert into public.notifications(school_id, profile_id, title, body, target_path)
  select leave_request.school_id, staff.profile_id,
    case when decision = 'approved' then 'Staff leave approved' else 'Staff leave request declined' end,
    format('%s: %s to %s.%s',
      case when decision = 'approved' then 'Your leave request is approved' else 'Your leave request was declined' end,
      leave_request.start_date, leave_request.end_date,
      case when decision_note is null or trim(decision_note) = '' then '' else ' Note: ' || trim(decision_note) end),
    '/staff'
  from public.staff_profiles staff
  where staff.school_id = leave_request.school_id and staff.id = leave_request.staff_id
    and staff.profile_id is not null;
end;
$$;

create or replace function public.assign_staff_leave_coverage(
  target_request uuid,
  target_substitute uuid,
  coverage_note text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  leave_request public.staff_leave_requests%rowtype;
  coverage_id uuid;
begin
  select * into leave_request from public.staff_leave_requests
  where id = target_request for update;
  if not found or not public.is_staff_administrator(leave_request.school_id) then
    raise exception 'Staff leave request not found or not authorized.';
  end if;
  if leave_request.status <> 'approved' or target_substitute = leave_request.staff_id
    or char_length(coalesce(coverage_note, '')) > 1000 then
    raise exception 'Coverage requires approved leave and a different substitute.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(leave_request.school_id::text || ':' || target_substitute::text, 0));
  if not exists (
    select 1 from public.staff_profiles substitute
    where substitute.id = target_substitute and substitute.school_id = leave_request.school_id
      and substitute.employment_status = 'active'
  ) then raise exception 'Choose an active substitute from this school.'; end if;
  if not exists (
    select 1 from public.teacher_profiles teacher
    where teacher.school_id = leave_request.school_id and teacher.staff_profile_id = target_substitute
      and teacher.employment_status = 'active'
  ) then raise exception 'Choose an active teacher as the substitute.'; end if;
  if exists (
    select 1 from public.staff_leave_coverage coverage
    join public.staff_leave_requests other_leave
      on other_leave.school_id = coverage.school_id and other_leave.id = coverage.leave_request_id
    where coverage.school_id = leave_request.school_id
      and coverage.substitute_staff_id = target_substitute
      and coverage.status = 'planned'
      and other_leave.status = 'approved'
      and other_leave.id <> leave_request.id
      and daterange(other_leave.start_date, other_leave.end_date, '[]')
        && daterange(leave_request.start_date, leave_request.end_date, '[]')
  ) then raise exception 'The selected substitute already has a conflicting coverage assignment.'; end if;
  insert into public.staff_leave_coverage(
    school_id, leave_request_id, substitute_staff_id, coverage_notes, assigned_by, updated_at
  ) values (
    leave_request.school_id, leave_request.id, target_substitute, trim(coalesce(coverage_note, '')),
    auth.uid(), timezone('utc', now())
  )
  on conflict (school_id, leave_request_id) do update set
    substitute_staff_id = excluded.substitute_staff_id,
    coverage_notes = excluded.coverage_notes,
    status = 'planned',
    assigned_by = excluded.assigned_by,
    updated_at = timezone('utc', now())
  returning id into coverage_id;
  return coverage_id;
end;
$$;

create or replace function public.get_staff_payroll_export(
  target_school uuid,
  period_start date,
  period_end date
)
returns table (
  employee_number text,
  payroll_identifier text,
  first_name text,
  last_name text,
  email text,
  department text,
  job_title text,
  employment_status text,
  pay_frequency text,
  contracted_weekly_hours numeric,
  attendance_days integer,
  late_days integer,
  absence_days integer,
  approved_leave_days integer,
  recorded_hours numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_staff_administrator(target_school) then
    raise exception 'School or HR administrator access is required to export payroll data.';
  end if;
  if period_start is null or period_end is null or period_end < period_start
    or period_end - period_start > 93 then
    raise exception 'Choose a payroll period no longer than 94 days.';
  end if;
  return query
  select staff.employee_number, coalesce(payroll.payroll_identifier, staff.employee_number), staff.first_name, staff.last_name,
    staff.email, department.name, staff.job_title, staff.employment_status,
    payroll.pay_frequency, payroll.contracted_weekly_hours,
    count(attendance.id) filter (where attendance.status in ('present', 'late'))::integer,
    count(attendance.id) filter (where attendance.status = 'late')::integer,
    count(attendance.id) filter (where attendance.status = 'absent')::integer,
    coalesce((
      select sum(least(leave_request.end_date, period_end) - greatest(leave_request.start_date, period_start) + 1)::integer
      from public.staff_leave_requests leave_request
      where leave_request.school_id = staff.school_id and leave_request.staff_id = staff.id
        and leave_request.status = 'approved'
        and leave_request.start_date <= period_end and leave_request.end_date >= period_start
    ), 0),
    coalesce(round(sum(
      case when attendance.check_in is not null and attendance.check_out is not null
        then extract(epoch from (attendance.check_out - attendance.check_in)) / 3600
        else 0 end
    )::numeric, 2), 0)
  from public.staff_profiles staff
  left join public.school_departments department
    on department.school_id = staff.school_id and department.id = staff.department_id
  left join public.staff_payroll_profiles payroll
    on payroll.school_id = staff.school_id and payroll.staff_id = staff.id
  left join public.staff_attendance_records attendance
    on attendance.school_id = staff.school_id and attendance.staff_id = staff.id
    and attendance.attendance_date between period_start and period_end
  where staff.school_id = target_school and staff.employment_status <> 'terminated'
  group by staff.id, department.name, payroll.payroll_identifier, payroll.pay_frequency,
    payroll.contracted_weekly_hours
  order by staff.employee_number;
end;
$$;

create or replace function public.run_staff_expiry_reminder_scan()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target record;
  reminder_target record;
  item_label text;
  item_expires date;
  reminder_key_value text;
  reminder_window_value text;
  reminder_title text;
begin
  update public.staff_qualifications
  set status = 'expired', updated_at = timezone('utc', now())
  where status = 'active' and expires_on < current_date;
  for target in select id as school_id from public.schools loop
    update public.staff_profiles staff
    set employment_status = 'on_leave', leave_status_synced = true, updated_at = timezone('utc', now())
    where staff.school_id = target.school_id and staff.employment_status = 'active'
      and exists (
        select 1 from public.staff_leave_requests leave_request
        where leave_request.school_id = staff.school_id and leave_request.staff_id = staff.id
          and leave_request.status = 'approved'
          and current_date between leave_request.start_date and leave_request.end_date
      );
    update public.staff_profiles staff
    set employment_status = 'active', leave_status_synced = false, updated_at = timezone('utc', now())
    where staff.school_id = target.school_id and staff.leave_status_synced
      and staff.employment_status = 'on_leave'
      and not exists (
        select 1 from public.staff_leave_requests leave_request
        where leave_request.school_id = staff.school_id and leave_request.staff_id = staff.id
          and leave_request.status = 'approved'
          and current_date between leave_request.start_date and leave_request.end_date
      );
    for reminder_target in
      select membership.profile_id
      from public.school_memberships membership
      where membership.school_id = target.school_id
        and membership.role::text in ('school_admin', 'hr_staff_administrator')
    loop
      for item_label, item_expires, reminder_key_value in
        select document.file_name, document.expires_on, 'document:' || document.id::text
        from public.staff_documents document
        where document.school_id = target.school_id and document.expires_on is not null
          and document.expires_on <= current_date + 30
        union all
        select qualification.qualification_name, qualification.expires_on, 'qualification:' || qualification.id::text
        from public.staff_qualifications qualification
        where qualification.school_id = target.school_id and qualification.status = 'active'
          and qualification.expires_on is not null and qualification.expires_on <= current_date + 30
      loop
        reminder_window_value := case when item_expires < current_date then 'expired' else '30_day' end;
        if not exists (
          select 1 from public.staff_expiry_reminder_history reminder
          where reminder.school_id = target.school_id
            and reminder.reminder_key = reminder_key_value
            and reminder.reminder_window = reminder_window_value
            and reminder.profile_id = reminder_target.profile_id
        ) then
          reminder_title := case when reminder_window_value = 'expired'
            then 'Staff credential or document expired'
            else 'Staff credential or document expires soon' end;
          insert into public.notifications(school_id, profile_id, title, body, target_path)
          values (
            target.school_id, reminder_target.profile_id, reminder_title,
            format('%s expires on %s.', item_label, item_expires), '/staff'
          );
          insert into public.staff_expiry_reminder_history(
            school_id, reminder_key, reminder_window, profile_id
          ) values (
            target.school_id, reminder_key_value, reminder_window_value, reminder_target.profile_id
          );
        end if;
      end loop;
    end loop;
  end loop;
end;
$$;

revoke all on function public.record_staff_attendance(uuid,uuid,date,text,time,time,text) from public, anon;
revoke all on function public.create_staff_leave_request(uuid,uuid,text,date,date,text) from public, anon;
revoke all on function public.review_staff_leave_request(uuid,text,text) from public, anon;
revoke all on function public.assign_staff_leave_coverage(uuid,uuid,text) from public, anon;
revoke all on function public.get_staff_payroll_export(uuid,date,date) from public, anon;
revoke all on function public.run_staff_expiry_reminder_scan() from public, anon, authenticated;
grant execute on function public.record_staff_attendance(uuid,uuid,date,text,time,time,text) to authenticated;
grant execute on function public.create_staff_leave_request(uuid,uuid,text,date,date,text) to authenticated;
grant execute on function public.review_staff_leave_request(uuid,text,text) to authenticated;
grant execute on function public.assign_staff_leave_coverage(uuid,uuid,text) to authenticated;
grant execute on function public.get_staff_payroll_export(uuid,date,date) to authenticated;

create extension if not exists pg_cron;
do $$
declare
  scheduled_job bigint;
begin
  select jobid into scheduled_job from cron.job where jobname = 'campus-connect-staff-expiry-reminders';
  if scheduled_job is not null then perform cron.unschedule(scheduled_job); end if;
  perform cron.schedule(
    'campus-connect-staff-expiry-reminders',
    '0 6 * * *',
    'select public.run_staff_expiry_reminder_scan()'
  );
end;
$$;

notify pgrst, 'reload schema';
