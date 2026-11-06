create table if not exists public.application_error_events (
  event_id uuid primary key,
  school_id uuid not null references public.schools(id) on delete cascade,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  error_code text not null check (error_code ~ '^CC-[A-Z0-9]{2,8}-[A-Z]{3,12}-[A-F0-9]{8}$'),
  feature_code text not null check (feature_code ~ '^[A-Z0-9]{2,8}$'),
  error_kind text not null check (error_kind in (
    'AUTH', 'ACCESS', 'NETWORK', 'DUPLICATE', 'RELATED',
    'MAINTENANCE', 'INPUT', 'UNEXPECTED'
  )),
  severity text not null check (severity in ('critical', 'high', 'medium', 'low')),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists application_error_events_created_at_idx
  on public.application_error_events(created_at desc);
create index if not exists application_error_events_reporter_created_at_idx
  on public.application_error_events(reporter_id, created_at desc);
create index if not exists application_error_events_grouping_idx
  on public.application_error_events(error_code, created_at desc);

alter table public.application_error_events enable row level security;
revoke all on public.application_error_events from public, anon, authenticated;
grant all on public.application_error_events to service_role;

create or replace function public.platform_owner_error_dashboard(window_days integer default 30)
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
    raise exception 'Error dashboard window must be 7, 30, or 90 days.';
  end if;

  with recent_events as (
    select error_code, feature_code, error_kind, severity, school_id, created_at
    from public.application_error_events
    where created_at >= now() - make_interval(days => window_days)
  ),
  grouped_errors as (
    select
      error_code,
      feature_code,
      error_kind,
      severity,
      count(*)::bigint as occurrence_count,
      count(distinct school_id)::bigint as school_count,
      min(created_at) as first_seen_at,
      max(created_at) as last_seen_at
    from recent_events
    group by error_code, feature_code, error_kind, severity
  ),
  severities as (
    select unnest(array['critical', 'high', 'medium', 'low']) as severity
  )
  select jsonb_build_object(
    'windowDays', window_days,
    'totalEvents', (select count(*)::bigint from recent_events),
    'severityCounts', coalesce((
      select jsonb_object_agg(
        severities.severity,
        coalesce(counts.occurrence_count, 0)
      )
      from severities
      left join (
        select severity, count(*)::bigint as occurrence_count
        from recent_events
        group by severity
      ) counts using (severity)
    ), '{}'::jsonb),
    'errors', coalesce((
      select jsonb_agg(jsonb_build_object(
        'code', error_code,
        'featureCode', feature_code,
        'kind', error_kind,
        'severity', severity,
        'occurrences', occurrence_count,
        'affectedSchools', school_count,
        'firstSeenAt', first_seen_at,
        'lastSeenAt', last_seen_at
      ) order by occurrence_count desc, last_seen_at desc)
      from (
        select *
        from grouped_errors
        order by occurrence_count desc, last_seen_at desc
        limit 200
      ) top_errors
    ), '[]'::jsonb)
  ) into dashboard;

  return dashboard;
end;
$$;

revoke all on function public.platform_owner_error_dashboard(integer) from public, anon, authenticated;
grant execute on function public.platform_owner_error_dashboard(integer) to service_role;
