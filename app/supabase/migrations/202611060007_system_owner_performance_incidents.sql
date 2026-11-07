create table if not exists public.platform_runtime_performance_events (
  event_id uuid primary key,
  school_id uuid not null references public.schools(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  session_id uuid not null,
  event_type text not null check (event_type in ('page', 'request', 'database')),
  label text not null check (char_length(label) between 1 and 160),
  route text not null check (char_length(route) between 1 and 160),
  duration_ms double precision not null check (duration_ms >= 0 and duration_ms <= 120000),
  status_code integer check (status_code is null or status_code between 100 and 599),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists platform_runtime_performance_events_created_idx
  on public.platform_runtime_performance_events(created_at desc);
create index if not exists platform_runtime_performance_events_type_route_idx
  on public.platform_runtime_performance_events(event_type, route, created_at desc);

alter table public.platform_runtime_performance_events enable row level security;
create policy "School members can record runtime performance events"
  on public.platform_runtime_performance_events for insert to authenticated
  with check (
    profile_id = auth.uid()
    and public.is_school_member(school_id)
  );
revoke all on public.platform_runtime_performance_events from public, anon, authenticated;
grant insert on public.platform_runtime_performance_events to authenticated;
grant all on public.platform_runtime_performance_events to service_role;

create or replace function public.platform_owner_performance_dashboard(window_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  dashboard jsonb;
begin
  if window_days not in (7, 30, 90) then
    raise exception 'Performance dashboard window must be 7, 30, or 90 days.';
  end if;

  with recent_events as (
    select event_type, label, route, duration_ms, status_code, created_at
    from public.platform_runtime_performance_events
    where created_at >= now() - make_interval(days => window_days)
  ),
  event_groups as (
    select
      event_type,
      label,
      route,
      count(*)::bigint as sample_count,
      count(*) filter (where status_code >= 400)::bigint as failure_count,
      percentile_cont(0.50) within group (order by duration_ms) as p50_ms,
      percentile_cont(0.75) within group (order by duration_ms) as p75_ms,
      percentile_cont(0.95) within group (order by duration_ms) as p95_ms,
      max(duration_ms) as max_ms
    from recent_events
    group by event_type, label, route
  )
  select jsonb_build_object(
    'windowDays', window_days,
    'totalSamples', (select count(*)::bigint from recent_events),
    'summary', coalesce((
      select jsonb_agg(jsonb_build_object(
        'eventType', grouped.event_type,
        'sampleCount', grouped.sample_count,
        'failureCount', grouped.failure_count,
        'p50Ms', round(grouped.p50_ms::numeric, 2),
        'p75Ms', round(grouped.p75_ms::numeric, 2),
        'p95Ms', round(grouped.p95_ms::numeric, 2),
        'maxMs', round(grouped.max_ms::numeric, 2)
      ) order by grouped.event_type)
      from (
        select
          event_type,
          count(*)::bigint as sample_count,
          count(*) filter (where status_code >= 400)::bigint as failure_count,
          percentile_cont(0.50) within group (order by duration_ms) as p50_ms,
          percentile_cont(0.75) within group (order by duration_ms) as p75_ms,
          percentile_cont(0.95) within group (order by duration_ms) as p95_ms,
          max(duration_ms) as max_ms
        from recent_events
        group by event_type
      ) grouped
    ), '[]'::jsonb),
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object(
        'eventType', event_type,
        'label', label,
        'route', route,
        'sampleCount', sample_count,
        'failureCount', failure_count,
        'p50Ms', round(p50_ms::numeric, 2),
        'p75Ms', round(p75_ms::numeric, 2),
        'p95Ms', round(p95_ms::numeric, 2),
        'maxMs', round(max_ms::numeric, 2)
      ) order by p95_ms desc, sample_count desc)
      from (
        select *
        from event_groups
        order by p95_ms desc, sample_count desc
        limit 100
      ) top_groups
    ), '[]'::jsonb),
    'slowEvents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'eventType', event_type,
        'label', label,
        'route', route,
        'durationMs', round(duration_ms::numeric, 2),
        'statusCode', status_code,
        'createdAt', created_at
      ) order by duration_ms desc)
      from (
        select *
        from recent_events
        order by duration_ms desc
        limit 50
      ) slow
    ), '[]'::jsonb)
  ) into dashboard;

  return dashboard;
end;
$$;

revoke all on function public.platform_owner_performance_dashboard(integer) from public, anon, authenticated;
grant execute on function public.platform_owner_performance_dashboard(integer) to service_role;

create table if not exists public.platform_incidents (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 3 and 160),
  severity text not null check (severity in ('critical', 'high', 'medium', 'low')),
  status text not null default 'investigating'
    check (status in ('investigating', 'identified', 'monitoring', 'resolved')),
  started_at timestamptz not null,
  resolved_at timestamptz,
  affected_services text not null default '' check (char_length(affected_services) <= 500),
  impact text not null default '' check (char_length(impact) <= 2000),
  cause text not null default '' check (char_length(cause) <= 3000),
  fix text not null default '' check (char_length(fix) <= 3000),
  lessons text not null default '' check (char_length(lessons) <= 3000),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid not null references auth.users(id) on delete restrict,
  check (resolved_at is null or resolved_at >= started_at)
);

create index if not exists platform_incidents_started_idx
  on public.platform_incidents(started_at desc);
create index if not exists platform_incidents_status_started_idx
  on public.platform_incidents(status, started_at desc);

alter table public.platform_incidents enable row level security;
revoke all on public.platform_incidents from public, anon, authenticated;
grant all on public.platform_incidents to service_role;
