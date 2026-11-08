create or replace function public.get_school_leadership_dashboard(
  target_school uuid,
  period_start date,
  period_end date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  dashboard_data jsonb;
begin
  if not public.has_school_role(
    target_school,
    array['school_admin', 'academic_coordinator', 'auditor']::public.app_role[]
  ) then
    raise exception 'Leadership dashboard access is restricted to school leaders and auditors.';
  end if;
  if period_start is null or period_end is null
    or period_end < period_start
    or period_end > current_date
    or period_end - period_start > 366 then
    raise exception 'Choose a valid reporting period of no more than 367 days ending today or earlier.';
  end if;

  select jsonb_build_object(
    'period_start', period_start,
    'period_end', period_end,
    'active_students', (
      select count(*) from public.students student
      where student.school_id = target_school and student.status = 'active'
    ),
    'new_student_records', (
      select count(*) from public.students student
      where student.school_id = target_school
        and student.created_at >= period_start::timestamptz
        and student.created_at < (period_end + 1)::timestamptz
    ),
    'active_teachers', (
      select count(*) from public.teacher_profiles teacher
      where teacher.school_id = target_school
        and teacher.employment_status = 'active'
    ),
    'active_non_teaching_staff', (
      select count(*)
      from public.staff_profiles staff
      where staff.school_id = target_school
        and staff.employment_status = 'active'
        and not exists (
          select 1 from public.teacher_profiles teacher
          where teacher.school_id = staff.school_id
            and teacher.staff_profile_id = staff.id
        )
    ),
    'classes', (
      select count(*) from public.school_classes school_class
      where school_class.school_id = target_school
    ),
    'attendance', (
      select jsonb_build_object(
        'total_marks', count(record.id),
        'present', count(record.id) filter (where record.status = 'present'),
        'late', count(record.id) filter (where record.status = 'late'),
        'absent', count(record.id) filter (where record.status = 'absent'),
        'excused', count(record.id) filter (where record.status = 'excused')
      )
      from public.attendance_records record
      join public.attendance_sessions session
        on session.school_id = record.school_id
        and session.id = record.session_id
      where record.school_id = target_school
        and session.attendance_date between period_start and period_end
    ),
    'assessment', (
      select jsonb_build_object(
        'result_count', count(result.id),
        'average_percentage', round(avg(result.percentage), 1)
      )
      from public.learning_assessment_results result
      where result.school_id = target_school
        and result.assessment_date between period_start and period_end
    ),
    'admissions', (
      select jsonb_build_object(
        'total', count(application.id),
        'submitted', count(application.id) filter (where application.status = 'submitted'),
        'under_review', count(application.id) filter (where application.status = 'under_review'),
        'accepted', count(application.id) filter (where application.status = 'accepted'),
        'registered', count(application.id) filter (where application.status = 'registered'),
        'waitlisted', count(application.id) filter (where application.status = 'waitlisted'),
        'rejected', count(application.id) filter (where application.status = 'rejected'),
        'withdrawn', count(application.id) filter (where application.status = 'withdrawn')
      )
      from public.admission_applications application
      where application.school_id = target_school
        and application.submitted_at >= period_start::timestamptz
        and application.submitted_at < (period_end + 1)::timestamptz
    ),
    'monthly_enrolment', (
      select coalesce(
        jsonb_agg(jsonb_build_object('month', to_char(monthly.month_start, 'YYYY-MM'), 'count', monthly.student_count)
          order by monthly.month_start),
        '[]'::jsonb
      )
      from (
        select date_trunc('month', student.created_at)::date as month_start, count(*) as student_count
        from public.students student
        where student.school_id = target_school
          and student.created_at >= period_start::timestamptz
          and student.created_at < (period_end + 1)::timestamptz
        group by date_trunc('month', student.created_at)::date
      ) monthly
    )
  ) into dashboard_data;

  return dashboard_data;
end;
$$;

revoke all on function public.get_school_leadership_dashboard(uuid, date, date) from public;
grant execute on function public.get_school_leadership_dashboard(uuid, date, date) to authenticated;
