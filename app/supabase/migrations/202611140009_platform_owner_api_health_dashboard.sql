-- Aggregate sampled API outcomes without exposing request URLs, payloads, or user records.
create or replace function public.platform_owner_api_health_dashboard(window_days integer default 7)
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
    raise exception 'API health dashboard window must be 7, 30, or 90 days.';
  end if;

  with recent_events as (
    select event_type, label, duration_ms, status_code, created_at
    from public.platform_runtime_performance_events
    where event_type in ('request', 'database')
      and created_at >= now() - make_interval(days => window_days)
  ),
  event_groups as (
    select
      event_type,
      label,
      count(*)::bigint as sample_count,
      count(*) filter (where status_code >= 400)::bigint as failure_count,
      count(*) filter (where status_code is null)::bigint as unknown_status_count,
      percentile_cont(0.50) within group (order by duration_ms) as p50_ms,
      percentile_cont(0.95) within group (order by duration_ms) as p95_ms,
      max(duration_ms) as max_ms,
      max(created_at) as last_observed_at
    from recent_events
    group by event_type, label
  )
  select jsonb_build_object(
    'windowDays', window_days,
    'totalSamples', (select count(*)::bigint from recent_events),
    'failureCount', (select count(*)::bigint from recent_events where status_code >= 400),
    'knownStatusCount', (select count(*)::bigint from recent_events where status_code is not null),
    'unknownStatusCount', (select count(*)::bigint from recent_events where status_code is null),
    'failureRate', (
      select round(
        100.0 * count(*) filter (where status_code >= 400)
        / nullif(count(*) filter (where status_code is not null), 0),
        2
      )
      from recent_events
    ),
    'p50Ms', (
      select round(percentile_cont(0.50) within group (order by duration_ms)::numeric, 2)
      from recent_events
    ),
    'p95Ms', (
      select round(percentile_cont(0.95) within group (order by duration_ms)::numeric, 2)
      from recent_events
    ),
    'maxMs', (
      select round(max(duration_ms)::numeric, 2)
      from recent_events
    ),
    'lastObservedAt', (select max(created_at) from recent_events),
    'endpointCount', (select count(*)::bigint from event_groups),
    'endpoints', coalesce((
      select jsonb_agg(jsonb_build_object(
        'eventType', top_groups.event_type,
        'label', top_groups.label,
        'sampleCount', top_groups.sample_count,
        'failureCount', top_groups.failure_count,
        'unknownStatusCount', top_groups.unknown_status_count,
        'p50Ms', round(top_groups.p50_ms::numeric, 2),
        'p95Ms', round(top_groups.p95_ms::numeric, 2),
        'maxMs', round(top_groups.max_ms::numeric, 2),
        'lastObservedAt', top_groups.last_observed_at
      ) order by top_groups.failure_count desc, top_groups.p95_ms desc, top_groups.sample_count desc)
      from (
        select *
        from event_groups
        order by failure_count desc, p95_ms desc, sample_count desc
        limit 200
      ) top_groups
    ), '[]'::jsonb),
    'recentFailures', coalesce((
      select jsonb_agg(jsonb_build_object(
        'eventType', failures.event_type,
        'label', failures.label,
        'durationMs', round(failures.duration_ms::numeric, 2),
        'statusCode', failures.status_code,
        'observedAt', failures.created_at
      ) order by failures.created_at desc)
      from (
        select event_type, label, duration_ms, status_code, created_at
        from recent_events
        where status_code >= 400
        order by created_at desc
        limit 100
      ) failures
    ), '[]'::jsonb)
  ) into dashboard;

  return dashboard;
end;
$$;

revoke all on function public.platform_owner_api_health_dashboard(integer) from public, anon, authenticated;
grant execute on function public.platform_owner_api_health_dashboard(integer) to service_role;
