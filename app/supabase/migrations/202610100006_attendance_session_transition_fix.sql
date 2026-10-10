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
  validate_school_day boolean;
  resolve_academic_period boolean;
begin
  if tg_op = 'INSERT' then
    validate_school_day := true;
    resolve_academic_period := true;
  else
    validate_school_day := new.attendance_date is distinct from old.attendance_date
      or new.class_id is distinct from old.class_id
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
