alter type public.app_role add value 'academic_coordinator';

create table public.timetable_schedules (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 120),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id)
);

create index timetable_schedules_school_updated_idx
  on public.timetable_schedules(school_id, updated_at desc);

alter table public.timetable
  add column schedule_id uuid,
  add column entry_type text not null default 'lesson'
    check (entry_type in ('lesson', 'registration', 'break', 'lunch', 'other')),
  add column label text;

alter table public.timetable
  alter column class_id drop not null,
  alter column subject_id drop not null,
  add constraint timetable_schedule_school_fk
    foreign key (school_id, schedule_id)
    references public.timetable_schedules(school_id, id)
    on delete cascade,
  add constraint timetable_entry_type_requirements
    check (
      (entry_type = 'lesson' and class_id is not null and subject_id is not null)
      or (entry_type <> 'lesson' and label is not null and char_length(trim(label)) > 0)
    );

create index timetable_schedule_day_idx
  on public.timetable(school_id, schedule_id, day_of_week, starts_at);

create or replace function public.can_manage_timetable(target_school uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_school_role(target_school, array['school_admin']::public.app_role[])
    or exists (
      select 1
      from public.school_memberships membership
      where membership.school_id = target_school
        and membership.profile_id = auth.uid()
        and membership.role::text = 'academic_coordinator'
    );
$$;

revoke all on function public.can_manage_timetable(uuid) from public;
grant execute on function public.can_manage_timetable(uuid) to authenticated;

alter table public.timetable_schedules enable row level security;

create policy "Members read published timetables"
  on public.timetable_schedules for select to authenticated
  using (
    public.can_manage_timetable(school_id)
    or (status = 'published' and public.is_school_member(school_id))
  );

create policy "Coordinators manage timetables"
  on public.timetable_schedules for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));

drop policy if exists "Authorized users read timetable" on public.timetable;
create policy "Authorized users read timetable"
  on public.timetable for select to authenticated
  using (
    public.can_manage_timetable(school_id)
    or (
      (schedule_id is null or exists (
        select 1
        from public.timetable_schedules schedule
        where schedule.id = timetable.schedule_id
          and schedule.school_id = timetable.school_id
          and schedule.status = 'published'
      ))
      and (
        class_id is null
        or public.is_teacher_for_class(school_id, class_id)
        or exists (
          select 1
          from public.class_students roster
          join public.students student
            on student.school_id = roster.school_id and student.id = roster.student_id
          where roster.school_id = timetable.school_id
            and roster.class_id = timetable.class_id
            and student.profile_id = auth.uid()
        )
        or exists (
          select 1
          from public.class_students roster
          where roster.school_id = timetable.school_id
            and roster.class_id = timetable.class_id
            and public.is_parent_of_student(timetable.school_id, roster.student_id)
        )
      )
    )
  );

drop policy if exists "Admins manage timetable" on public.timetable;
create policy "Coordinators manage timetable entries"
  on public.timetable for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));

create trigger set_updated_at
  before update on public.timetable_schedules
  for each row execute function public.set_updated_at();

grant select, insert, update, delete on public.timetable_schedules to authenticated;
