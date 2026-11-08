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
    select 1 from public.staff_leave_requests substitute_leave
    where substitute_leave.school_id = leave_request.school_id
      and substitute_leave.staff_id = target_substitute
      and substitute_leave.status = 'approved'
      and daterange(substitute_leave.start_date, substitute_leave.end_date, '[]')
        && daterange(leave_request.start_date, leave_request.end_date, '[]')
  ) then raise exception 'The selected substitute has approved leave during this period.'; end if;
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

revoke all on function public.assign_staff_leave_coverage(uuid, uuid, text) from public, anon;
grant execute on function public.assign_staff_leave_coverage(uuid, uuid, text) to authenticated;

notify pgrst, 'reload schema';
