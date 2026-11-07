create or replace function public.get_timetable_readiness(
  target_school uuid,
  target_calendar uuid default null,
  target_year uuid default null,
  target_pattern uuid default null,
  target_bell_schedule uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  calendar_id uuid;
  year_id uuid;
  pattern_id uuid;
  bell_schedule_id uuid;
  bell_cycle_weeks smallint := 1;
  has_calendar boolean := false;
  has_year boolean := false;
  open_pattern_count integer := 0;
  teaching_week_count integer := 0;
  bell_period_count integer := 0;
  class_count integer := 0;
  subject_count integer := 0;
  teacher_count integer := 0;
  class_subject_count integer := 0;
  teacher_subject_count integer := 0;
  teacher_class_count integer := 0;
  manual_ready boolean;
  generation_ready boolean;
begin
  if target_school is null or not public.can_manage_timetable(target_school) then
    raise exception 'Only academic managers can inspect timetable readiness.';
  end if;

  if target_calendar is null then
    select calendar.id into calendar_id
    from public.academic_calendars calendar
    where calendar.school_id = target_school
    order by calendar.is_default desc, calendar.name
    limit 1;
  else
    select calendar.id into calendar_id
    from public.academic_calendars calendar
    where calendar.school_id = target_school and calendar.id = target_calendar;
    if not found then
      raise exception 'The selected academic calendar does not belong to this school.';
    end if;
  end if;
  has_calendar := calendar_id is not null;

  if target_year is null and calendar_id is not null then
    select year.id into year_id
    from public.academic_years year
    where year.school_id = target_school and year.calendar_id = calendar_id
    order by year.is_current desc, year.start_date desc
    limit 1;
  elsif target_year is not null then
    select year.id into year_id
    from public.academic_years year
    where year.school_id = target_school
      and year.calendar_id = calendar_id
      and year.id = target_year;
    if not found then
      raise exception 'The selected academic year does not belong to this school calendar.';
    end if;
  end if;
  has_year := year_id is not null;

  if calendar_id is not null then
    if target_pattern is null then
      select pattern.id into pattern_id
      from public.academic_calendar_week_patterns pattern
      where pattern.school_id = target_school and pattern.calendar_id = calendar_id
      order by (pattern.name = 'Standard') desc, pattern.name
      limit 1;
    else
      select pattern.id into pattern_id
      from public.academic_calendar_week_patterns pattern
      where pattern.school_id = target_school
        and pattern.calendar_id = calendar_id
        and pattern.id = target_pattern;
      if not found then
        raise exception 'The selected week pattern does not belong to this school calendar.';
      end if;
    end if;
    if target_bell_schedule is not null then
      select bell.id, bell.cycle_weeks into bell_schedule_id, bell_cycle_weeks
      from public.academic_bell_schedules bell
      where bell.school_id = target_school
        and bell.calendar_id = calendar_id
        and bell.week_pattern_id = pattern_id
        and bell.id = target_bell_schedule;
      if not found then
        raise exception 'The selected bell schedule does not match this school calendar and week pattern.';
      end if;
    end if;
    select count(*)::integer into open_pattern_count
    from public.academic_calendar_pattern_days day
    where day.school_id = target_school
      and day.calendar_id = calendar_id
      and day.pattern_id = pattern_id
      and day.is_open;
    select count(*)::integer into bell_period_count
    from public.academic_bell_periods period
    join public.academic_bell_schedules bell
      on bell.school_id = period.school_id and bell.id = period.bell_schedule_id
    where bell.school_id = target_school and bell.id = bell_schedule_id;
    select count(*)::integer into class_count
    from public.school_classes school_class
    where school_class.school_id = target_school
      and school_class.calendar_id = calendar_id
      and (year_id is null or school_class.academic_year_id is null or school_class.academic_year_id = year_id);
    if year_id is not null then
      select count(*)::integer into teaching_week_count
      from public.academic_calendar_weeks week
      where week.school_id = target_school
        and week.calendar_id = calendar_id
        and week.academic_year_id = year_id
        and week.pattern_id = pattern_id;
    end if;
  end if;

  select count(*)::integer into subject_count
  from public.subjects subject
  where subject.school_id = target_school;
  select count(*)::integer into teacher_count
  from public.teacher_profiles teacher
  where teacher.school_id = target_school and teacher.status = 'active';
  select count(*)::integer into class_subject_count
  from public.class_subjects assignment
  join public.school_classes school_class
    on school_class.school_id = assignment.school_id and school_class.id = assignment.class_id
  where assignment.school_id = target_school
    and (calendar_id is null or school_class.calendar_id = calendar_id)
    and (year_id is null or school_class.academic_year_id is null or school_class.academic_year_id = year_id);
  select count(*)::integer into teacher_subject_count
  from public.teacher_subjects assignment
  where assignment.school_id = target_school;
  select count(*)::integer into teacher_class_count
  from public.teacher_class_assignments assignment
  join public.school_classes school_class
    on school_class.school_id = assignment.school_id and school_class.id = assignment.class_id
  where assignment.school_id = target_school
    and (calendar_id is null or school_class.calendar_id = calendar_id)
    and (year_id is null or school_class.academic_year_id is null or school_class.academic_year_id = year_id);

  manual_ready := has_calendar and open_pattern_count > 0 and class_count > 0 and subject_count > 0;
  generation_ready := manual_ready and has_year
    and (bell_cycle_weeks <> 2 or teaching_week_count > 0)
    and bell_period_count > 0 and teacher_count > 0
    and class_subject_count > 0 and teacher_subject_count > 0;

  return jsonb_build_object(
    'calendar_id', calendar_id,
    'academic_year_id', year_id,
    'week_pattern_id', pattern_id,
    'bell_schedule_id', bell_schedule_id,
    'ready_for_manual_planning', manual_ready,
    'ready_for_auto_generation', generation_ready,
    'checks', jsonb_build_array(
      jsonb_build_object('key', 'calendar', 'label', 'Academic calendar', 'status',
        case when has_calendar then 'ready' else 'blocker' end,
        'detail', case when has_calendar then 'A school calendar is available.' else 'Create an academic calendar before planning a timetable.' end),
      jsonb_build_object('key', 'academic_year', 'label', 'Academic year', 'status',
        case when has_year then 'ready' else 'warning' end,
        'detail', case when has_year then 'The selected calendar has an academic year.' else 'Select or create an academic year to scope the timetable and teaching weeks.' end),
      jsonb_build_object('key', 'week_pattern', 'label', 'Operating-day pattern', 'status',
        case when open_pattern_count > 0 then 'ready' else 'blocker' end,
        'detail', case when open_pattern_count > 0 then open_pattern_count::text || ' open teaching day(s) are configured.' else 'Configure the selected week pattern with one or more open teaching days.' end),
      jsonb_build_object('key', 'teaching_weeks', 'label', 'Teaching weeks', 'status',
        case when not has_year then 'warning' when bell_cycle_weeks <> 2 or teaching_week_count > 0 then 'ready' else 'warning' end,
        'detail', case when not has_year then 'Select an academic year to check the teaching-week calendar.' when bell_cycle_weeks <> 2 then 'The selected bell schedule does not use an A/B cycle.' when teaching_week_count > 0 then teaching_week_count::text || ' teaching week(s) are configured for this pattern.' else 'Teaching weeks are not configured for this pattern; A/B rotation dates will default to cycle week A.' end),
      jsonb_build_object('key', 'bell_periods', 'label', 'Bell schedule', 'status',
        case when bell_period_count > 0 then 'ready' else 'warning' end,
        'detail', case when bell_period_count > 0 then bell_period_count::text || ' bell period(s) are available.' else 'Optional for manual planning; configure bell periods to use guided or automatic generation.' end),
      jsonb_build_object('key', 'classes', 'label', 'Classes', 'status',
        case when class_count > 0 then 'ready' else 'blocker' end,
        'detail', case when class_count > 0 then class_count::text || ' class(es) match this calendar and year.' else 'Create classes for this calendar and academic year.' end),
      jsonb_build_object('key', 'subjects', 'label', 'Subjects', 'status',
        case when subject_count > 0 then 'ready' else 'blocker' end,
        'detail', case when subject_count > 0 then subject_count::text || ' subject(s) are available.' else 'Add subjects before scheduling lessons.' end),
      jsonb_build_object('key', 'teachers', 'label', 'Active teachers', 'status',
        case when teacher_count > 0 then 'ready' else 'warning' end,
        'detail', case when teacher_count > 0 then teacher_count::text || ' active teacher(s) are available.' else 'Add active teacher profiles and assign them to subjects before generating lessons.' end),
      jsonb_build_object('key', 'class_subjects', 'label', 'Class subject assignments', 'status',
        case when class_subject_count > 0 then 'ready' else 'warning' end,
        'detail', case when class_subject_count > 0 then class_subject_count::text || ' class-subject assignment(s) are configured.' else 'Assign subjects to classes for accurate lesson generation.' end),
      jsonb_build_object('key', 'teacher_subjects', 'label', 'Teacher subject assignments', 'status',
        case when teacher_subject_count > 0 then 'ready' else 'warning' end,
        'detail', case when teacher_subject_count > 0 then teacher_subject_count::text || ' teacher-subject assignment(s) are configured.' else 'Assign teachers to subjects before generating lessons.' end),
      jsonb_build_object('key', 'teacher_classes', 'label', 'Teacher class assignments', 'status',
        case when teacher_class_count > 0 then 'ready' else 'warning' end,
        'detail', case when teacher_class_count > 0 then teacher_class_count::text || ' teacher-class assignment(s) are configured.' else 'Teacher-class assignments improve eligibility checks and workload planning.' end)
    )
  );
end;
$$;

revoke all on function public.get_timetable_readiness(uuid, uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.get_timetable_readiness(uuid, uuid, uuid, uuid, uuid) to authenticated;

create or replace function public.assert_timetable_schedule_ready(target_school uuid, target_schedule uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  schedule public.timetable_schedules%rowtype;
begin
  select * into schedule
  from public.timetable_schedules timetable_schedule
  where timetable_schedule.school_id = target_school
    and timetable_schedule.id = target_schedule;
  if not found then
    raise exception 'The timetable does not belong to this school.';
  end if;
  if not exists (
    select 1 from public.timetable entry
    where entry.school_id = target_school
      and entry.schedule_id = target_schedule
      and entry.entry_type = 'lesson'
  ) then
    raise exception 'Add at least one lesson before publishing the timetable.';
  end if;
  if exists (
    select 1 from public.timetable entry
    where entry.school_id = target_school
      and entry.schedule_id = target_schedule
      and entry.entry_type = 'lesson'
      and (entry.teacher_id is null or nullif(btrim(entry.room), '') is null)
  ) then
    raise exception 'Assign a teacher and room to every lesson before publishing.';
  end if;
  if exists (
    select 1
    from public.timetable first_entry
    join public.timetable second_entry
      on second_entry.school_id = first_entry.school_id
      and second_entry.schedule_id = first_entry.schedule_id
      and second_entry.id > first_entry.id
      and second_entry.entry_type = 'lesson'
      and second_entry.day_of_week = first_entry.day_of_week
      and second_entry.cycle_week = first_entry.cycle_week
      and first_entry.starts_at < second_entry.ends_at
      and second_entry.starts_at < first_entry.ends_at
      and (
        second_entry.class_id = first_entry.class_id
        or second_entry.teacher_id = first_entry.teacher_id
        or (
          nullif(btrim(first_entry.room), '') is not null
          and lower(btrim(second_entry.room)) = lower(btrim(first_entry.room))
        )
      )
    where first_entry.school_id = target_school
      and first_entry.schedule_id = target_schedule
      and first_entry.entry_type = 'lesson'
  ) then
    raise exception 'Resolve all class, teacher, and room timetable conflicts before publishing.';
  end if;
  if exists (
    select 1
    from public.timetable entry
    join public.school_classes school_class
      on school_class.school_id = entry.school_id and school_class.id = entry.class_id
    where entry.school_id = target_school
      and entry.schedule_id = target_schedule
      and entry.entry_type = 'lesson'
      and (
        school_class.calendar_id <> schedule.calendar_id
        or (
          schedule.academic_year_id is not null
          and school_class.academic_year_id is not null
          and school_class.academic_year_id <> schedule.academic_year_id
        )
      )
  ) then
    raise exception 'Every scheduled class must match the timetable calendar and academic year.';
  end if;
  if exists (
    select 1
    from public.timetable entry
    left join public.teacher_profiles teacher
      on teacher.school_id = entry.school_id and teacher.id = entry.teacher_id
    where entry.school_id = target_school
      and entry.schedule_id = target_schedule
      and entry.entry_type = 'lesson'
      and teacher.status is distinct from 'active'
  ) then
    raise exception 'Replace inactive teacher assignments before publishing.';
  end if;
end;
$$;

revoke all on function public.assert_timetable_schedule_ready(uuid, uuid) from public, anon, authenticated;

create or replace function public.guard_timetable_schedule_publication()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'published' and old.status is distinct from 'published' then
    if old.status <> 'draft' then
      raise exception 'Only draft timetables can be published.';
    end if;
    perform public.assert_timetable_schedule_ready(new.school_id, new.id);
  end if;
  return new;
end;
$$;

revoke all on function public.guard_timetable_schedule_publication() from public, anon, authenticated;

create trigger guard_timetable_schedule_publication
  before update of status on public.timetable_schedules
  for each row execute function public.guard_timetable_schedule_publication();

create or replace function public.publish_timetable_schedule(target_school uuid, target_schedule uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_status text;
begin
  if target_school is null or not public.can_manage_timetable(target_school) then
    raise exception 'Only academic managers can publish timetables.';
  end if;
  select schedule.status into current_status
  from public.timetable_schedules schedule
  where schedule.school_id = target_school and schedule.id = target_schedule
  for update;
  if not found then
    raise exception 'The timetable does not belong to this school.';
  end if;
  if current_status <> 'draft' then
    raise exception 'Only draft timetables can be published.';
  end if;
  update public.timetable_schedules
  set status = 'published', updated_at = timezone('utc', now())
  where school_id = target_school and id = target_schedule;
end;
$$;

revoke all on function public.publish_timetable_schedule(uuid, uuid) from public, anon;
grant execute on function public.publish_timetable_schedule(uuid, uuid) to authenticated;
