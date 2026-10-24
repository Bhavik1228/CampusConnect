create table public.dashboard_saved_views (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 80),
  configuration jsonb not null
    check (
      jsonb_typeof(configuration) = 'object'
      and jsonb_typeof(configuration -> 'widgets') = 'array'
    ),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, profile_id, name)
);

create trigger set_dashboard_saved_views_updated_at
  before update on public.dashboard_saved_views
  for each row execute function public.set_updated_at();

alter table public.dashboard_saved_views enable row level security;

create policy "Users manage their own school dashboard views"
  on public.dashboard_saved_views for all to authenticated
  using (
    profile_id = auth.uid()
    and public.is_school_member(school_id)
  )
  with check (
    profile_id = auth.uid()
    and public.is_school_member(school_id)
  );

grant select, insert, update, delete on public.dashboard_saved_views to authenticated;
