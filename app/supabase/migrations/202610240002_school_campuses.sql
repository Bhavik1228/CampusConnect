create table if not exists public.school_campuses (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 120),
  code text,
  address text,
  is_primary boolean not null default false,
  allow_cross_campus_admin boolean not null default false,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, name)
);

create unique index if not exists school_campuses_code_unique
  on public.school_campuses (school_id, lower(code))
  where code is not null;

create trigger set_school_campuses_updated_at
  before update on public.school_campuses
  for each row execute function public.set_updated_at();

alter table public.school_campuses enable row level security;

create policy "Members can read campuses" on public.school_campuses for select to authenticated
using (public.is_school_member(school_id));

create policy "Admins manage campuses" on public.school_campuses for all to authenticated
using (public.has_school_role(school_id, array['school_admin']::public.app_role[]))
with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));

grant select, insert, update, delete on public.school_campuses to authenticated;

do $$
begin
  insert into public.school_campuses (school_id, name, code, address, is_primary, created_by)
  select s.id, s.name, 'MAIN', s.address, true, s.created_by
  from public.schools s
  where not exists (
    select 1 from public.school_campuses campus where campus.school_id = s.id
  )
  on conflict (school_id, name) do nothing;
end $$;

create or replace function public.create_initial_school(school_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_school_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required to create a school.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  if exists (select 1 from public.school_memberships where profile_id = auth.uid()) then
    raise exception 'This account already has a school workspace.';
  end if;
  if school_name is null or char_length(trim(school_name)) < 2 or char_length(trim(school_name)) > 120 then
    raise exception 'School name must be between 2 and 120 characters.';
  end if;

  insert into public.schools (name, created_by)
  values (trim(school_name), auth.uid())
  returning id into new_school_id;

  insert into public.school_memberships (school_id, profile_id, role)
  values (new_school_id, auth.uid(), 'school_admin');

  insert into public.school_campuses (school_id, name, code, address, is_primary, created_by)
  values (new_school_id, trim(school_name), 'MAIN', null, true, auth.uid());

  return new_school_id;
end;
$$;
revoke all on function public.create_initial_school(text) from public;
grant execute on function public.create_initial_school(text) to authenticated;
