create table public.school_grade_levels (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 60),
  sort_order integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, name)
);

alter table public.school_classes
  add column grade_level_id uuid,
  add column capacity integer check (capacity is null or capacity > 0),
  add constraint school_classes_grade_level_fk
    foreign key (school_id, grade_level_id)
    references public.school_grade_levels(school_id, id) on delete set null (grade_level_id);

alter table public.school_grade_levels enable row level security;

create policy "School members read grade levels"
  on public.school_grade_levels for select to authenticated
  using (public.is_school_member(school_id));
create policy "Academic managers manage grade levels"
  on public.school_grade_levels for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));

drop policy if exists "Admins manage classes" on public.school_classes;
create policy "Academic managers manage classes"
  on public.school_classes for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));

drop policy if exists "Admins manage rosters" on public.class_students;
create policy "Academic managers manage rosters"
  on public.class_students for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));

drop policy if exists "Admins manage class subjects" on public.class_subjects;
create policy "Academic managers manage class subjects"
  on public.class_subjects for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));

drop policy if exists "Admins manage teaching assignments" on public.teacher_class_assignments;
create policy "Academic managers manage teaching assignments"
  on public.teacher_class_assignments for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));

drop policy if exists "Admins manage teacher subjects" on public.teacher_subjects;
create policy "Academic managers manage teacher subjects"
  on public.teacher_subjects for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));

drop policy if exists "Admins manage subjects" on public.subjects;
create policy "Academic managers manage subjects"
  on public.subjects for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));

create or replace function public.enforce_class_capacity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  maximum_capacity integer;
  enrolled_count bigint;
begin
  if tg_op = 'UPDATE' then
    select count(*) into enrolled_count
    from public.class_students membership
    where membership.school_id = new.school_id
      and membership.class_id = new.id;
    if new.capacity is not null and new.capacity < enrolled_count then
      raise exception 'Class capacity cannot be lower than its current enrollment of %.', enrolled_count;
    end if;
    return new;
  end if;

  if exists (
    select 1 from public.class_students membership
    where membership.school_id = new.school_id
      and membership.class_id = new.class_id
      and membership.student_id = new.student_id
  ) then
    return new;
  end if;

  select class_record.capacity into maximum_capacity
  from public.school_classes class_record
  where class_record.school_id = new.school_id
    and class_record.id = new.class_id
  for update;
  if not found then
    raise exception 'Class not found in this school.';
  end if;

  if maximum_capacity is not null then
    select count(*) into enrolled_count
    from public.class_students membership
    where membership.school_id = new.school_id
      and membership.class_id = new.class_id;
    if enrolled_count >= maximum_capacity then
      raise exception 'This class is at capacity (% students).', maximum_capacity;
    end if;
  end if;
  return new;
end;
$$;

create trigger enforce_class_capacity
  before insert on public.class_students
  for each row execute function public.enforce_class_capacity();

create trigger validate_class_capacity_update
  before update of capacity on public.school_classes
  for each row execute function public.enforce_class_capacity();

create or replace function public.enroll_student_in_class(
  target_student uuid,
  target_class uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_school uuid;
  student_status public.person_status;
begin
  select student.school_id, student.status
  into target_school, student_status
  from public.students student
  where student.id = target_student
  for update;
  if not found or not public.can_manage_timetable(target_school) then
    raise exception 'Student not found or not authorized for this school.';
  end if;
  if student_status <> 'active' then
    raise exception 'Only active students can be enrolled in a class.';
  end if;
  if target_class is not null and not exists (
    select 1 from public.school_classes class_record
    where class_record.id = target_class and class_record.school_id = target_school
  ) then
    raise exception 'Choose a class belonging to this school.';
  end if;

  update public.students
  set class_id = target_class, updated_at = timezone('utc', now())
  where id = target_student and school_id = target_school;
end;
$$;

create or replace function public.save_class_assignments(
  target_class uuid,
  target_subjects uuid[],
  target_teachers uuid[]
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_school uuid;
begin
  select class_record.school_id into target_school
  from public.school_classes class_record
  where class_record.id = target_class;
  if not found or not public.can_manage_timetable(target_school) then
    raise exception 'Class not found or not authorized for this school.';
  end if;

  if exists (
    select 1 from unnest(coalesce(target_subjects, '{}'::uuid[])) assignment(id)
    where not exists (
      select 1 from public.subjects subject_record
      where subject_record.id = assignment.id and subject_record.school_id = target_school
    )
  ) then
    raise exception 'Every assigned subject must belong to this school.';
  end if;
  if exists (
    select 1 from unnest(coalesce(target_teachers, '{}'::uuid[])) assignment(id)
    where not exists (
      select 1 from public.teacher_profiles teacher
      where teacher.id = assignment.id and teacher.school_id = target_school
    )
  ) then
    raise exception 'Every assigned teacher must belong to this school.';
  end if;

  delete from public.class_subjects
  where school_id = target_school and class_id = target_class;
  insert into public.class_subjects (school_id, class_id, subject_id)
  select target_school, target_class, assignment.id
  from unnest(coalesce(target_subjects, '{}'::uuid[])) assignment(id);

  delete from public.teacher_class_assignments
  where school_id = target_school and class_id = target_class;
  insert into public.teacher_class_assignments (school_id, class_id, teacher_id)
  select target_school, target_class, assignment.id
  from unnest(coalesce(target_teachers, '{}'::uuid[])) assignment(id);
end;
$$;

revoke all on function public.enroll_student_in_class(uuid, uuid) from public;
grant execute on function public.enroll_student_in_class(uuid, uuid) to authenticated;
revoke all on function public.save_class_assignments(uuid, uuid[], uuid[]) from public;
grant execute on function public.save_class_assignments(uuid, uuid[], uuid[]) to authenticated;

create trigger audit_school_record_change
  after insert or update or delete on public.school_grade_levels
  for each row execute function public.log_school_record_change();

grant select, insert, update, delete on public.school_grade_levels to authenticated;
grant select, insert, update, delete on public.school_classes to authenticated;
grant select, insert, update, delete on public.class_students to authenticated;
grant select, insert, update, delete on public.class_subjects to authenticated;
grant select, insert, update, delete on public.teacher_class_assignments to authenticated;
grant select, insert, update, delete on public.teacher_subjects to authenticated;
grant select, insert, update, delete on public.subjects to authenticated;
