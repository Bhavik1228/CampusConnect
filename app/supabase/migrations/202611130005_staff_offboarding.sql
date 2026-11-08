create table public.staff_offboarding_plans (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  staff_id uuid not null,
  exit_date date not null,
  reason text not null check (char_length(trim(reason)) between 3 and 500),
  status text not null default 'planned' check (status in ('planned', 'in_progress', 'completed', 'cancelled')),
  handover_notes text not null default '' check (char_length(handover_notes) <= 2000),
  access_removed_at timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, staff_id, exit_date),
  foreign key (school_id, staff_id)
    references public.staff_profiles(school_id, id) on delete cascade,
  check (exit_date >= current_date or status = 'cancelled')
);

create index staff_offboarding_school_date_idx
  on public.staff_offboarding_plans(school_id, exit_date, status);

create or replace function public.sync_staff_offboarding_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'completed' and new.access_removed_at is null then
    new.access_removed_at := timezone('utc', now());
  end if;

  if new.status = 'completed' and old.status is distinct from 'completed' then
    update public.staff_profiles
    set employment_status = 'inactive', updated_at = timezone('utc', now())
    where school_id = new.school_id and id = new.staff_id and employment_status <> 'terminated';
  end if;

  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    update public.staff_profiles
    set employment_status = 'active', updated_at = timezone('utc', now())
    where school_id = new.school_id and id = new.staff_id and employment_status = 'inactive';
  end if;

  return new;
end;
$$;

create trigger staff_offboarding_sync_status
  before insert or update on public.staff_offboarding_plans
  for each row execute function public.sync_staff_offboarding_status();

create trigger staff_offboarding_set_updated_at
  before update on public.staff_offboarding_plans
  for each row execute function public.set_updated_at();

alter table public.staff_offboarding_plans enable row level security;
revoke all on public.staff_offboarding_plans from anon, authenticated;
grant select, insert, update, delete on public.staff_offboarding_plans to authenticated;

create policy "School administrators manage staff offboarding"
  on public.staff_offboarding_plans for all to authenticated
  using (public.is_staff_administrator(school_id))
  with check (public.is_staff_administrator(school_id));

create policy "School members read offboarding plans"
  on public.staff_offboarding_plans for select to authenticated
  using (public.is_school_member(school_id));

notify pgrst, 'reload schema';
