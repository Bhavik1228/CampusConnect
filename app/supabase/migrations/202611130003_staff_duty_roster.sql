create table public.staff_duty_assignments (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  duty_date date not null,
  starts_at time not null,
  ends_at time not null,
  duty_type text not null check (duty_type in (
    'arrival_gate', 'playground', 'lunch', 'corridor', 'dismissal', 'event', 'other'
  )),
  location text not null check (char_length(trim(location)) between 1 and 120),
  primary_staff_id uuid not null,
  cover_staff_id uuid,
  status text not null default 'planned'
    check (status in ('planned', 'covered', 'complete', 'cancelled')),
  notes text not null default '' check (char_length(notes) <= 500),
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint staff_duty_assignments_time_check check (starts_at < ends_at),
  constraint staff_duty_assignments_staff_check check (
    cover_staff_id is null or cover_staff_id <> primary_staff_id
  ),
  constraint staff_duty_assignments_primary_staff_fk
    foreign key (school_id, primary_staff_id)
    references public.staff_profiles(school_id, id) on delete restrict,
  constraint staff_duty_assignments_cover_staff_fk
    foreign key (school_id, cover_staff_id)
    references public.staff_profiles(school_id, id) on delete restrict
);

create index staff_duty_assignments_school_date_idx
  on public.staff_duty_assignments(school_id, duty_date, starts_at);
create index staff_duty_assignments_primary_staff_idx
  on public.staff_duty_assignments(school_id, primary_staff_id, duty_date);
create index staff_duty_assignments_cover_staff_idx
  on public.staff_duty_assignments(school_id, cover_staff_id, duty_date)
  where cover_staff_id is not null;

create or replace function public.prevent_staff_duty_overlap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'cancelled' then
    return new;
  end if;

  if not exists (
    select 1 from public.staff_profiles staff
    where staff.school_id = new.school_id
      and staff.id = new.primary_staff_id
      and staff.employment_status = 'active'
  ) then
    raise exception 'The assigned staff member must be active in this school.';
  end if;
  if new.cover_staff_id is not null and not exists (
    select 1 from public.staff_profiles staff
    where staff.school_id = new.school_id
      and staff.id = new.cover_staff_id
      and staff.employment_status = 'active'
  ) then
    raise exception 'The covering staff member must be active in this school.';
  end if;

  if exists (
    select 1 from public.staff_duty_assignments existing
    where existing.school_id = new.school_id
      and existing.duty_date = new.duty_date
      and existing.status <> 'cancelled'
      and existing.id <> new.id
      and existing.starts_at < new.ends_at
      and new.starts_at < existing.ends_at
      and (
        existing.primary_staff_id in (new.primary_staff_id, new.cover_staff_id)
        or existing.cover_staff_id in (new.primary_staff_id, new.cover_staff_id)
      )
  ) then
    raise exception 'A staff member cannot cover overlapping duties on the same day.';
  end if;

  return new;
end;
$$;

create trigger staff_duty_assignments_prevent_overlap
  before insert or update on public.staff_duty_assignments
  for each row execute function public.prevent_staff_duty_overlap();
create trigger staff_duty_assignments_set_updated_at
  before update on public.staff_duty_assignments
  for each row execute function public.set_updated_at();

alter table public.staff_duty_assignments enable row level security;
revoke all on public.staff_duty_assignments from anon, authenticated;
grant select, insert, update, delete on public.staff_duty_assignments to authenticated;

create policy "School staff read duty assignments"
  on public.staff_duty_assignments for select to authenticated
  using (
    public.has_school_role(
      school_id,
      array['school_admin', 'academic_coordinator', 'hr_staff_administrator']::public.app_role[]
    )
    or exists (
      select 1 from public.staff_profiles staff
      where staff.school_id = staff_duty_assignments.school_id
        and staff.profile_id = auth.uid()
        and staff.id in (
          staff_duty_assignments.primary_staff_id,
          staff_duty_assignments.cover_staff_id
        )
    )
  );

create policy "School administrators manage duty assignments"
  on public.staff_duty_assignments for all to authenticated
  using (
    public.has_school_role(
      school_id,
      array['school_admin', 'academic_coordinator', 'hr_staff_administrator']::public.app_role[]
    )
  )
  with check (
    public.has_school_role(
      school_id,
      array['school_admin', 'academic_coordinator', 'hr_staff_administrator']::public.app_role[]
    )
  );
