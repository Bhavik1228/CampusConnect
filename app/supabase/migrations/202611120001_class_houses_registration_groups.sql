create table public.school_houses (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 80),
  color text not null default '#2563EB' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  house_lead_teacher_id uuid,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, name),
  foreign key (school_id, house_lead_teacher_id)
    references public.teacher_profiles(school_id, id) on delete set null (house_lead_teacher_id)
);

create table public.school_registration_groups (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  calendar_id uuid not null,
  academic_year_id uuid not null,
  name text not null check (char_length(trim(name)) between 1 and 80),
  tutor_teacher_id uuid,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, calendar_id, academic_year_id, name),
  foreign key (school_id, calendar_id)
    references public.academic_calendars(school_id, id) on delete cascade,
  foreign key (school_id, calendar_id, academic_year_id)
    references public.academic_years(school_id, calendar_id, id) on delete cascade,
  foreign key (school_id, tutor_teacher_id)
    references public.teacher_profiles(school_id, id) on delete set null (tutor_teacher_id)
);

alter table public.students
  add column house_id uuid,
  add column registration_group_id uuid,
  add constraint students_school_house_fk
    foreign key (school_id, house_id)
    references public.school_houses(school_id, id) on delete set null (house_id),
  add constraint students_school_registration_group_fk
    foreign key (school_id, registration_group_id)
    references public.school_registration_groups(school_id, id) on delete set null (registration_group_id);

create index students_school_house_idx on public.students(school_id, house_id);
create index students_school_registration_group_idx on public.students(school_id, registration_group_id);

alter table public.school_houses enable row level security;
alter table public.school_registration_groups enable row level security;
grant select, insert, update, delete on public.school_houses, public.school_registration_groups to authenticated;

create policy "School members read houses"
  on public.school_houses for select to authenticated
  using (public.is_school_member(school_id));
create policy "Academic managers manage houses"
  on public.school_houses for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));
create policy "School members read registration groups"
  on public.school_registration_groups for select to authenticated
  using (public.is_school_member(school_id));
create policy "Academic managers manage registration groups"
  on public.school_registration_groups for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));

create or replace function public.get_class_structure_roster(target_school uuid)
returns table (
  student_id uuid,
  student_number text,
  first_name text,
  last_name text,
  class_id uuid,
  class_name text,
  house_id uuid,
  registration_group_id uuid
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if target_school is null or not public.can_manage_timetable(target_school) then
    raise exception 'Only academic managers can view the class placement roster.';
  end if;
  return query
  select student.id, student.student_number, student.first_name, student.last_name,
    student.class_id, class_record.name, student.house_id, student.registration_group_id
  from public.students student
  left join public.school_classes class_record
    on class_record.school_id = student.school_id and class_record.id = student.class_id
  where student.school_id = target_school and student.status = 'active'
  order by student.last_name, student.first_name, student.student_number;
end;
$$;

revoke all on function public.get_class_structure_roster(uuid) from public, anon;
grant execute on function public.get_class_structure_roster(uuid) to authenticated;

create or replace function public.validate_student_registration_group()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  selected_group public.school_registration_groups%rowtype;
  selected_class public.school_classes%rowtype;
begin
  if new.registration_group_id is null then
    return new;
  end if;
  select * into selected_group
  from public.school_registration_groups group_record
  where group_record.school_id = new.school_id and group_record.id = new.registration_group_id;
  if not found then
    raise exception 'The registration group does not belong to this school.';
  end if;
  if new.class_id is not null then
    select * into selected_class
    from public.school_classes class_record
    where class_record.school_id = new.school_id and class_record.id = new.class_id;
    if not found then
      raise exception 'The selected class does not belong to this school.';
    end if;
    if selected_group.calendar_id <> selected_class.calendar_id
      or (selected_class.academic_year_id is not null and selected_group.academic_year_id <> selected_class.academic_year_id) then
      raise exception 'The registration group must match the student class calendar and academic year.';
    end if;
  end if;
  return new;
end;
$$;

create trigger validate_student_registration_group
  before insert or update of school_id, class_id, registration_group_id
  on public.students
  for each row execute function public.validate_student_registration_group();

create or replace function public.set_student_class_group_placement(
  target_student uuid,
  next_class uuid,
  next_house uuid,
  next_registration_group uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_school uuid;
begin
  select student.school_id into target_school
  from public.students student
  where student.id = target_student;
  if not found or not public.can_manage_timetable(target_school) then
    raise exception 'Only academic managers can update student house and registration group placement.';
  end if;
  update public.students
  set class_id = next_class,
    house_id = next_house,
    registration_group_id = next_registration_group,
    updated_at = timezone('utc', now())
  where school_id = target_school and id = target_student;
end;
$$;

revoke all on function public.set_student_class_group_placement(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.set_student_class_group_placement(uuid, uuid, uuid, uuid) to authenticated;
