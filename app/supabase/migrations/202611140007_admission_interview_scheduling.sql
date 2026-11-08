create table public.admission_interviews (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  application_id uuid not null,
  interviewer_profile_id uuid references public.profiles(id) on delete set null,
  interview_type text not null check (interview_type in ('interview', 'assessment', 'interview_and_assessment')),
  scheduled_at timestamptz not null,
  duration_minutes integer not null check (duration_minutes between 15 and 180),
  location text not null check (char_length(trim(location)) between 2 and 200),
  status text not null default 'scheduled' check (status in ('scheduled', 'completed', 'cancelled', 'no_show')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, application_id)
    references public.admission_applications(school_id, id) on delete cascade
);

create index admission_interviews_schedule_idx
  on public.admission_interviews(school_id, scheduled_at, status);
create index admission_interviews_application_idx
  on public.admission_interviews(school_id, application_id, scheduled_at desc);

alter table public.admission_interviews enable row level security;
revoke all on public.admission_interviews from public, anon, authenticated;

create or replace function public.get_admission_interview_hub(target_school uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  hub_data jsonb;
begin
  if not public.is_admissions_officer(target_school) then
    raise exception 'Admissions staff access is required to view interview schedules.';
  end if;

  select jsonb_build_object(
    'candidates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', application.id,
        'reference', application.application_reference,
        'student_name', concat_ws(' ', application.student_first_name, application.student_last_name),
        'status', application.status,
        'applying_for', application.applying_for
      ) order by application.submitted_at desc)
      from public.admission_applications application
      where application.school_id = target_school
        and application.status in ('submitted', 'under_review', 'accepted', 'waitlisted')
    ), '[]'::jsonb),
    'interviewers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'profile_id', membership.profile_id,
        'name', coalesce(nullif(profile.full_name, ''), profile.email, 'Staff member'),
        'role', membership.role
      ) order by profile.full_name nulls last, membership.profile_id)
      from public.school_memberships membership
      join public.profiles profile on profile.id = membership.profile_id
      where membership.school_id = target_school
        and membership.role in ('school_admin', 'academic_coordinator', 'admissions_officer', 'teacher')
    ), '[]'::jsonb),
    'interviews', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', interview.id,
        'application_id', interview.application_id,
        'application_reference', application.application_reference,
        'student_name', concat_ws(' ', application.student_first_name, application.student_last_name),
        'interviewer_profile_id', interview.interviewer_profile_id,
        'interviewer_name', coalesce(nullif(profile.full_name, ''), profile.email, 'Former staff member'),
        'interview_type', interview.interview_type,
        'scheduled_at', interview.scheduled_at,
        'duration_minutes', interview.duration_minutes,
        'location', interview.location,
        'status', interview.status
      ) order by interview.scheduled_at desc)
      from (
        select scheduled.*
        from public.admission_interviews scheduled
        where scheduled.school_id = target_school
        order by scheduled.scheduled_at desc
        limit 500
      ) interview
      join public.admission_applications application
        on application.school_id = interview.school_id
        and application.id = interview.application_id
      left join public.profiles profile on profile.id = interview.interviewer_profile_id
    ), '[]'::jsonb)
  ) into hub_data;

  return hub_data;
end;
$$;

create or replace function public.schedule_admission_interview(
  target_school uuid,
  target_application uuid,
  target_interviewer uuid,
  target_type text,
  target_start timestamptz,
  target_duration integer,
  target_location text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_interview_id uuid;
  locked_profile_id uuid;
begin
  if not public.is_admissions_officer(target_school) then
    raise exception 'Admissions staff access is required to schedule interviews.';
  end if;
  if target_type is null or target_type not in ('interview', 'assessment', 'interview_and_assessment')
    or target_start is null or target_start <= now()
    or target_duration is null or target_duration not between 15 and 180
    or char_length(trim(coalesce(target_location, ''))) not between 2 and 200 then
    raise exception 'Provide a future time, valid appointment type, duration, and location.';
  end if;

  perform 1
  from public.admission_applications application
  where application.school_id = target_school
    and application.id = target_application
    and application.status in ('submitted', 'under_review', 'accepted', 'waitlisted')
  for update;
  if not found then
    raise exception 'The application is unavailable or no longer eligible for scheduling.';
  end if;

  select membership.profile_id into locked_profile_id
  from public.school_memberships membership
  where membership.school_id = target_school
    and membership.profile_id = target_interviewer
    and membership.role in ('school_admin', 'academic_coordinator', 'admissions_officer', 'teacher')
  for update;
  if locked_profile_id is null then
    raise exception 'Choose an active staff member from this school.';
  end if;

  if exists (
    select 1
    from public.admission_interviews existing
    where existing.school_id = target_school
      and existing.status = 'scheduled'
      and (
        existing.interviewer_profile_id = target_interviewer
        or existing.application_id = target_application
      )
      and existing.scheduled_at < target_start + make_interval(mins => target_duration)
      and existing.scheduled_at + make_interval(mins => existing.duration_minutes) > target_start
  ) then
    raise exception 'This interviewer or applicant already has a scheduled appointment during that time.';
  end if;

  insert into public.admission_interviews (
    school_id, application_id, interviewer_profile_id, interview_type,
    scheduled_at, duration_minutes, location, created_by
  ) values (
    target_school, target_application, target_interviewer, target_type,
    target_start, target_duration, trim(target_location), auth.uid()
  ) returning id into new_interview_id;

  return new_interview_id;
end;
$$;

create or replace function public.update_admission_interview_status(
  target_school uuid,
  target_interview uuid,
  target_status text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admissions_officer(target_school) then
    raise exception 'Admissions staff access is required to update interview outcomes.';
  end if;
  if target_status is null or target_status not in ('completed', 'cancelled', 'no_show') then
    raise exception 'Choose a valid interview outcome.';
  end if;

  update public.admission_interviews interview
  set status = target_status, updated_at = timezone('utc', now())
  where interview.school_id = target_school
    and interview.id = target_interview
    and interview.status = 'scheduled';
  if not found then
    raise exception 'The interview is unavailable or has already been updated.';
  end if;
end;
$$;

revoke all on function public.get_admission_interview_hub(uuid) from public;
revoke all on function public.schedule_admission_interview(uuid, uuid, uuid, text, timestamptz, integer, text) from public;
revoke all on function public.update_admission_interview_status(uuid, uuid, text) from public;
grant execute on function public.get_admission_interview_hub(uuid) to authenticated;
grant execute on function public.schedule_admission_interview(uuid, uuid, uuid, text, timestamptz, integer, text) to authenticated;
grant execute on function public.update_admission_interview_status(uuid, uuid, text) to authenticated;
