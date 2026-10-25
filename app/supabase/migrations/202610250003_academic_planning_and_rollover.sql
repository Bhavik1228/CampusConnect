create table public.academic_subject_combinations (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  academic_year_id uuid,
  grade_level text,
  name text not null check (char_length(trim(name)) between 2 and 120),
  selection_rule text not null check (selection_rule in ('all_required', 'choose_one', 'choose_many')),
  minimum_selections integer not null default 1 check (minimum_selections >= 0),
  maximum_selections integer check (maximum_selections is null or maximum_selections >= minimum_selections),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, academic_year_id)
    references public.academic_years(school_id, id) on delete cascade,
  check (selection_rule <> 'choose_one' or (minimum_selections = 1 and maximum_selections = 1))
);
create unique index academic_subject_combinations_name_idx
  on public.academic_subject_combinations(
    school_id,
    coalesce(academic_year_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(lower(grade_level), ''),
    lower(name)
  );

create table public.academic_subject_combination_options (
  school_id uuid not null,
  combination_id uuid not null,
  subject_id uuid not null,
  is_required boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (combination_id, subject_id),
  foreign key (school_id, combination_id)
    references public.academic_subject_combinations(school_id, id) on delete cascade,
  foreign key (school_id, subject_id)
    references public.subjects(school_id, id) on delete cascade
);
alter table public.academic_subject_combinations enable row level security;
alter table public.academic_subject_combination_options enable row level security;
revoke all on public.academic_subject_combinations, public.academic_subject_combination_options from anon, authenticated;
grant select on public.academic_subject_combinations, public.academic_subject_combination_options to authenticated;
create policy "School members read subject combinations"
  on public.academic_subject_combinations for select to authenticated
  using (public.is_school_member(school_id));
create policy "School members read subject combination options"
  on public.academic_subject_combination_options for select to authenticated
  using (public.is_school_member(school_id));
create policy "Require school MFA for subject combinations"
  on public.academic_subject_combinations as restrictive for all to authenticated
  using (public.school_mfa_satisfied(school_id))
  with check (public.school_mfa_satisfied(school_id));
create policy "Require school MFA for subject combination options"
  on public.academic_subject_combination_options as restrictive for all to authenticated
  using (public.school_mfa_satisfied(school_id))
  with check (public.school_mfa_satisfied(school_id));

create or replace function public.save_academic_subject_combination(
  target_school uuid,
  target_combination uuid,
  combination_name text,
  target_academic_year uuid,
  target_grade_level text,
  target_selection_rule text,
  target_minimum integer,
  target_maximum integer,
  target_options jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_id uuid;
  option_row record;
  option_count integer;
begin
  if not public.can_manage_timetable(target_school) or not public.school_mfa_satisfied(target_school) then
    raise exception 'An authorized academic manager who satisfies the school MFA policy is required.';
  end if;
  if char_length(trim(coalesce(combination_name, ''))) not between 2 and 120
    or target_selection_rule not in ('all_required', 'choose_one', 'choose_many')
    or target_minimum < 0
    or (target_maximum is not null and target_maximum < target_minimum)
    or (target_selection_rule = 'choose_one' and (target_minimum <> 1 or target_maximum <> 1)) then
    raise exception 'Check the combination name and selection limits.';
  end if;
  if target_options is null or jsonb_typeof(target_options) <> 'array'
    or jsonb_array_length(target_options) < 1 or jsonb_array_length(target_options) > 100 then
    raise exception 'Add between 1 and 100 subjects to this combination.';
  end if;
  option_count := jsonb_array_length(target_options);
  if target_maximum is not null and target_maximum > option_count then
    raise exception 'The maximum selections cannot exceed the number of listed subjects.';
  end if;
  if target_selection_rule = 'choose_many' and target_minimum > option_count then
    raise exception 'The minimum selections cannot exceed the number of listed subjects.';
  end if;
  if target_academic_year is not null and not exists (
    select 1 from public.academic_years
    where school_id = target_school and id = target_academic_year
  ) then
    raise exception 'Choose an academic year belonging to this school.';
  end if;
  if target_combination is null then
    insert into public.academic_subject_combinations (
      school_id, academic_year_id, grade_level, name, selection_rule,
      minimum_selections, maximum_selections, created_by
    ) values (
      target_school, target_academic_year, nullif(trim(target_grade_level), ''),
      trim(combination_name), target_selection_rule, target_minimum, target_maximum, auth.uid()
    ) returning id into saved_id;
  else
    update public.academic_subject_combinations
    set academic_year_id = target_academic_year,
        grade_level = nullif(trim(target_grade_level), ''),
        name = trim(combination_name),
        selection_rule = target_selection_rule,
        minimum_selections = target_minimum,
        maximum_selections = target_maximum,
        updated_at = timezone('utc', now())
    where school_id = target_school and id = target_combination
    returning id into saved_id;
    if saved_id is null then raise exception 'Subject combination not found.'; end if;
  end if;

  delete from public.academic_subject_combination_options
  where school_id = target_school and combination_id = saved_id;
  for option_row in select (entry ->> 'subject_id')::uuid as subject_id,
    coalesce((entry ->> 'is_required')::boolean, false) as is_required
    from jsonb_array_elements(target_options) entry
  loop
    if not exists (
      select 1 from public.subjects
      where school_id = target_school and id = option_row.subject_id
    ) then raise exception 'Every option must reference a subject in this school.'; end if;
    insert into public.academic_subject_combination_options (
      school_id, combination_id, subject_id, is_required
    ) values (target_school, saved_id, option_row.subject_id, option_row.is_required);
  end loop;
  return saved_id;
end;
$$;
revoke all on function public.save_academic_subject_combination(uuid, uuid, text, uuid, text, text, integer, integer, jsonb) from public, anon;
grant execute on function public.save_academic_subject_combination(uuid, uuid, text, uuid, text, text, integer, integer, jsonb) to authenticated;

create or replace function public.delete_academic_subject_combination(target_school uuid, target_combination uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.can_manage_timetable(target_school) or not public.school_mfa_satisfied(target_school) then
    raise exception 'An authorized academic manager who satisfies the school MFA policy is required.';
  end if;
  delete from public.academic_subject_combinations
  where school_id = target_school and id = target_combination;
  if not found then raise exception 'Subject combination not found.'; end if;
end;
$$;
revoke all on function public.delete_academic_subject_combination(uuid, uuid) from public, anon;
grant execute on function public.delete_academic_subject_combination(uuid, uuid) to authenticated;

create or replace function public.get_academic_structure_conflicts(target_school uuid, target_year uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  conflicts jsonb;
begin
  if not public.can_manage_timetable(target_school) then
    raise exception 'An academic manager is required to inspect academic structure.';
  end if;
  select coalesce(jsonb_agg(to_jsonb(issue)), '[]'::jsonb) into conflicts
  from (
    select 'class_capacity'::text as type,
      class_record.id as class_id,
      format('%s has %s roster entries for a capacity of %s.',
        class_record.name, enrolled.count, class_record.capacity) as message
    from public.school_classes class_record
    cross join lateral (
      select count(*)::integer as count
      from public.class_students membership
      where membership.school_id = class_record.school_id
        and membership.class_id = class_record.id
    ) enrolled
    where class_record.school_id = target_school
      and (target_year is null or class_record.academic_year_id = target_year)
      and class_record.capacity is not null and enrolled.count > class_record.capacity
    union all
    select 'required_subject_unassigned',
      class_record.id,
      format('%s is missing required subject %s from combination %s.',
        class_record.name, subject.name, combination.name)
    from public.school_classes class_record
    join public.academic_subject_combinations combination
      on combination.school_id = class_record.school_id
      and (combination.academic_year_id is null or combination.academic_year_id = class_record.academic_year_id)
      and (combination.grade_level is null or lower(combination.grade_level) = lower(class_record.grade_level))
    join public.academic_subject_combination_options opt
      on opt.school_id = combination.school_id and opt.combination_id = combination.id
      and (opt.is_required or combination.selection_rule = 'all_required')
    join public.subjects subject on subject.school_id = opt.school_id and subject.id = opt.subject_id
    where class_record.school_id = target_school
      and (target_year is null or class_record.academic_year_id = target_year)
      and not exists (
        select 1 from public.class_subjects assignment
        where assignment.school_id = class_record.school_id and assignment.class_id = class_record.id
          and assignment.subject_id = opt.subject_id
      )
    union all
    select case combination.selection_rule
        when 'choose_one' then 'choice_subject_unavailable'
        else 'insufficient_choice_subjects'
      end,
      class_record.id,
      format('%s has fewer available subjects than combination %s requires.',
        class_record.name, combination.name)
    from public.school_classes class_record
    join public.academic_subject_combinations combination
      on combination.school_id = class_record.school_id
      and (combination.academic_year_id is null or combination.academic_year_id = class_record.academic_year_id)
      and (combination.grade_level is null or lower(combination.grade_level) = lower(class_record.grade_level))
    where class_record.school_id = target_school
      and (target_year is null or class_record.academic_year_id = target_year)
      and combination.selection_rule in ('choose_one', 'choose_many')
      and combination.minimum_selections > (
        select count(*)
        from public.academic_subject_combination_options opt
        join public.class_subjects assignment
          on assignment.school_id = class_record.school_id
          and assignment.class_id = class_record.id
          and assignment.subject_id = opt.subject_id
        where opt.school_id = combination.school_id and opt.combination_id = combination.id
      )
  ) issue;
  return conflicts;
end;
$$;
revoke all on function public.get_academic_structure_conflicts(uuid, uuid) from public, anon;
grant execute on function public.get_academic_structure_conflicts(uuid, uuid) to authenticated;

create or replace function public.simulate_academic_year_rollover(
  target_school uuid,
  source_year uuid,
  next_name text,
  next_start date,
  next_end date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  source public.academic_years%rowtype;
  conflicts jsonb := '[]'::jsonb;
  class_count integer;
  term_count integer;
  roster_count integer;
begin
  if not public.can_manage_timetable(target_school) then
    raise exception 'An academic manager is required to simulate year rollover.';
  end if;
  select * into source from public.academic_years
  where school_id = target_school and id = source_year;
  if not found then raise exception 'Choose a source academic year in this school.'; end if;
  if char_length(trim(coalesce(next_name, ''))) not between 2 and 100
    or next_start is null or next_end is null or next_end <= next_start then
    raise exception 'Enter a year name and a valid start/end date range.';
  end if;

  select count(*) into class_count from public.school_classes
  where school_id = target_school and academic_year_id = source_year;
  select count(*) into term_count from public.terms
  where school_id = target_school and academic_year_id = source_year;
  select count(*) into roster_count
  from public.students student
  join public.school_classes class_record
    on class_record.school_id = student.school_id and class_record.id = student.class_id
  where student.school_id = target_school and class_record.academic_year_id = source_year
    and student.status = 'active' and student.merged_into_student_id is null;

  if exists (
    select 1 from public.academic_years year
    where year.school_id = target_school and year.calendar_id = source.calendar_id
      and lower(year.name) = lower(trim(next_name))
  ) then
    conflicts := conflicts || jsonb_build_array(jsonb_build_object(
      'type', 'duplicate_year', 'message', 'An academic year with this name already exists in this calendar.'
    ));
  end if;
  if exists (
    select 1 from public.terms term
    where term.school_id = target_school and term.academic_year_id = source_year
      and (term.start_date + (next_start - source.start_date) < next_start
        or term.end_date + (next_start - source.start_date) > next_end)
  ) then
    conflicts := conflicts || jsonb_build_array(jsonb_build_object(
      'type', 'term_outside_year', 'message', 'One or more shifted term dates would fall outside the proposed academic year.'
    ));
  end if;
  conflicts := conflicts || coalesce(
    public.get_academic_structure_conflicts(target_school, source_year),
    '[]'::jsonb
  );
  if exists (
    select 1 from public.academic_years year
    where year.school_id = target_school and year.calendar_id = source.calendar_id
      and daterange(year.start_date, year.end_date, '[]') && daterange(next_start, next_end, '[]')
  ) then
    conflicts := conflicts || jsonb_build_array(jsonb_build_object(
      'type', 'overlapping_year', 'message', 'The proposed dates overlap another year in this calendar.'
    ));
  end if;
  return jsonb_build_object(
    'source_year_id', source_year, 'calendar_id', source.calendar_id,
    'name', trim(next_name), 'start_date', next_start, 'end_date', next_end,
    'classes_to_copy', class_count, 'terms_to_copy', term_count,
    'students_to_promote', roster_count, 'conflicts', conflicts,
    'notes', jsonb_build_array(
      'Classes, class-subject assignments, teacher assignments, and terms will be copied.',
      'Students are not moved automatically; use promotion and class allocation after creating the year.'
    )
  );
end;
$$;
revoke all on function public.simulate_academic_year_rollover(uuid, uuid, text, date, date) from public, anon;
grant execute on function public.simulate_academic_year_rollover(uuid, uuid, text, date, date) to authenticated;

create or replace function public.apply_academic_year_rollover(
  target_school uuid,
  source_year uuid,
  next_name text,
  next_start date,
  next_end date
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  source public.academic_years%rowtype;
  next_year uuid;
  date_offset integer;
  source_class record;
  next_class uuid;
  simulation jsonb;
begin
  if not public.can_manage_timetable(target_school) or not public.school_mfa_satisfied(target_school) then
    raise exception 'An authorized academic manager who satisfies school MFA is required to apply rollover.';
  end if;
  simulation := public.simulate_academic_year_rollover(target_school, source_year, next_name, next_start, next_end);
  if jsonb_array_length(simulation -> 'conflicts') > 0 then
    raise exception 'Resolve rollover conflicts before applying: %', simulation -> 'conflicts';
  end if;
  select * into source from public.academic_years
  where school_id = target_school and id = source_year for update;
  date_offset := next_start - source.start_date;
  insert into public.academic_years (
    school_id, calendar_id, name, start_date, end_date, is_current
  ) values (target_school, source.calendar_id, trim(next_name), next_start, next_end, false)
  returning id into next_year;

  insert into public.terms (
    school_id, calendar_id, academic_year_id, name, start_date, end_date
  )
  select school_id, calendar_id, next_year, name, start_date + date_offset, end_date + date_offset
  from public.terms
  where school_id = target_school and academic_year_id = source_year;

  for source_class in
    select * from public.school_classes
    where school_id = target_school and academic_year_id = source_year
    order by name
  loop
    insert into public.school_classes (
      school_id, name, grade_level, grade_level_id, capacity, room, calendar_id, academic_year_id
    ) values (
      target_school, source_class.name, source_class.grade_level, source_class.grade_level_id,
      source_class.capacity, source_class.room, source.calendar_id, next_year
    ) returning id into next_class;
    insert into public.class_subjects(school_id, class_id, subject_id)
    select target_school, next_class, subject_id
    from public.class_subjects
    where school_id = target_school and class_id = source_class.id;
    insert into public.teacher_class_assignments(school_id, class_id, teacher_id)
    select target_school, next_class, teacher_id
    from public.teacher_class_assignments
    where school_id = target_school and class_id = source_class.id;
  end loop;
  return next_year;
end;
$$;
revoke all on function public.apply_academic_year_rollover(uuid, uuid, text, date, date) from public, anon;
grant execute on function public.apply_academic_year_rollover(uuid, uuid, text, date, date) to authenticated;

create or replace function public.preview_student_class_allocations(
  target_school uuid,
  source_year uuid,
  destination_year uuid,
  allocations jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  conflicts jsonb;
  student_count integer;
begin
  if not public.can_manage_timetable(target_school) then
    raise exception 'An academic manager is required to preview student allocations.';
  end if;
  if source_year = destination_year or not exists (
    select 1 from public.academic_years where school_id = target_school and id = source_year
  ) or not exists (
    select 1 from public.academic_years where school_id = target_school and id = destination_year
  ) then
    raise exception 'Choose two different academic years in this school.';
  end if;
  if allocations is null or jsonb_typeof(allocations) <> 'array' or jsonb_array_length(allocations) > 10000 then
    raise exception 'Provide a valid allocation list of at most 10000 students.';
  end if;
  select count(*) into student_count from jsonb_array_elements(allocations);

  select coalesce(jsonb_agg(to_jsonb(issue)), '[]'::jsonb) into conflicts
  from (
    select 'duplicate_student'::text as type,
      format('Student %s appears more than once in the allocation plan.', duplicate.student_id) as message
    from (
      select entry ->> 'student_id' as student_id
      from jsonb_array_elements(allocations) entry
      group by entry ->> 'student_id' having count(*) > 1
    ) duplicate
    union all
    select 'invalid_student', format('Student %s is not an active student in a source-year class.', entry.student_id)
    from (
      select (value ->> 'student_id')::uuid as student_id
      from jsonb_array_elements(allocations)
    ) entry
    where not exists (
      select 1 from public.students student
      join public.school_classes source_class
        on source_class.school_id = student.school_id and source_class.id = student.class_id
      where student.school_id = target_school and student.id = entry.student_id
        and student.status = 'active' and student.merged_into_student_id is null
        and source_class.academic_year_id = source_year
    )
    union all
    select 'invalid_destination', format('Destination class %s is not in the target academic year.', entry.class_id)
    from (
      select (value ->> 'class_id')::uuid as class_id
      from jsonb_array_elements(allocations)
    ) entry
    where not exists (
      select 1 from public.school_classes target_class
      where target_class.school_id = target_school and target_class.id = entry.class_id
        and target_class.academic_year_id = destination_year
    )
    union all
    select 'class_capacity', format('%s would have %s roster entries for a capacity of %s.',
      target_class.name, final_count.total, target_class.capacity)
    from public.school_classes target_class
    cross join lateral (
      select
        (select count(*) from public.class_students existing_membership
          where existing_membership.school_id = target_school
            and existing_membership.class_id = target_class.id)
        + (select count(*) from jsonb_array_elements(allocations) planned
          where (planned ->> 'class_id')::uuid = target_class.id) as total
    ) final_count
    where target_class.school_id = target_school and target_class.academic_year_id = destination_year
      and target_class.capacity is not null and final_count.total > target_class.capacity
  ) issue;
  return jsonb_build_object('student_count', student_count, 'conflicts', conflicts);
end;
$$;
revoke all on function public.preview_student_class_allocations(uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function public.preview_student_class_allocations(uuid, uuid, uuid, jsonb) to authenticated;

create or replace function public.apply_student_class_allocations(
  target_school uuid,
  source_year uuid,
  destination_year uuid,
  allocations jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  report jsonb;
  changed_count integer;
begin
  if not public.can_manage_timetable(target_school) or not public.school_mfa_satisfied(target_school) then
    raise exception 'An authorized academic manager who satisfies school MFA is required to apply student allocations.';
  end if;
  report := public.preview_student_class_allocations(target_school, source_year, destination_year, allocations);
  if jsonb_array_length(report -> 'conflicts') > 0 then
    raise exception 'Resolve allocation conflicts before applying: %', report -> 'conflicts';
  end if;
  update public.students student
  set class_id = (allocation.value ->> 'class_id')::uuid,
      updated_at = timezone('utc', now())
  from jsonb_array_elements(allocations) allocation
  where student.school_id = target_school
    and student.id = (allocation.value ->> 'student_id')::uuid
    and student.status = 'active'
    and student.merged_into_student_id is null
    and exists (
      select 1
      from public.school_classes source_class
      where source_class.school_id = student.school_id
        and source_class.id = student.class_id
        and source_class.academic_year_id = source_year
    );
  get diagnostics changed_count = row_count;
  if changed_count <> (report ->> 'student_count')::integer then
    raise exception 'The active student roster changed after preview. Preview allocations again.';
  end if;
  return changed_count;
end;
$$;
revoke all on function public.apply_student_class_allocations(uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function public.apply_student_class_allocations(uuid, uuid, uuid, jsonb) to authenticated;
