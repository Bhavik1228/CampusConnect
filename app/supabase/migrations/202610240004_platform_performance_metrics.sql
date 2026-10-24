create table public.platform_performance_metrics (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  session_id uuid not null,
  metric_name text not null check (metric_name in ('lcp', 'cls', 'inp')),
  metric_value double precision not null check (metric_value >= 0 and metric_value <= 120000),
  route text not null default '/workspace' check (char_length(route) <= 160),
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, profile_id, session_id, metric_name)
);

create index platform_performance_metrics_created_idx
  on public.platform_performance_metrics (created_at desc);

alter table public.platform_performance_metrics enable row level security;

create policy "School members can record performance metrics"
  on public.platform_performance_metrics for insert to authenticated
  with check (profile_id = auth.uid() and public.is_school_member(school_id));

create policy "Users can read their performance metrics"
  on public.platform_performance_metrics for select to authenticated
  using (profile_id = auth.uid() and public.is_school_member(school_id));

create policy "Users can update their performance metrics"
  on public.platform_performance_metrics for update to authenticated
  using (profile_id = auth.uid() and public.is_school_member(school_id))
  with check (profile_id = auth.uid() and public.is_school_member(school_id));

revoke all on public.platform_performance_metrics from anon, authenticated;
grant select, insert, update on public.platform_performance_metrics to authenticated;
grant select on public.platform_performance_metrics to service_role;
