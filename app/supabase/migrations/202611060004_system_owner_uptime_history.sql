create table if not exists public.system_health_observations (
  id uuid primary key default gen_random_uuid(),
  probe_id uuid not null,
  component text not null check (component in ('application', 'database', 'authentication', 'storage')),
  status text not null check (status in ('operational', 'unavailable')),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  message text not null default '' check (char_length(message) <= 1000),
  checked_at timestamptz not null default timezone('utc', now()),
  unique (probe_id, component)
);

create index if not exists system_health_observations_component_time_idx
  on public.system_health_observations(component, checked_at desc);

alter table public.system_health_observations enable row level security;
revoke all on public.system_health_observations from public, anon, authenticated;
grant all on public.system_health_observations to service_role;

create or replace function public.platform_owner_uptime_history()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with observations as (
    select component, status, checked_at
    from public.system_health_observations
    where checked_at >= now() - interval '90 days'
  ),
  sequenced as (
    select
      component,
      status,
      checked_at,
      lag(status) over (partition by component order by checked_at) as previous_status
    from observations
  ),
  outage_starts as (
    select component, checked_at as started_at
    from sequenced
    where status = 'unavailable'
      and coalesce(previous_status, 'operational') <> 'unavailable'
  ),
  incidents as (
    select
      outage.component,
      outage.started_at,
      (
        select min(recovery.checked_at)
        from observations recovery
        where recovery.component = outage.component
          and recovery.status = 'operational'
          and recovery.checked_at > outage.started_at
      ) as recovered_at
    from outage_starts outage
  ),
  component_summary as (
    select
      component,
      count(*)::integer as sample_count,
      count(*) filter (where status = 'operational')::integer as operational_samples,
      (array_agg(status order by checked_at desc))[1] as last_status,
      min(checked_at) as first_checked_at,
      max(checked_at) as last_checked_at
    from observations
    group by component
  ),
  component_names as (
    select unnest(array['application', 'database', 'authentication', 'storage']) as component
  )
  select jsonb_build_object(
    'windowDays', 90,
    'windowStart', now() - interval '90 days',
    'components', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', names.component,
        'sampleCount', coalesce(summary.sample_count, 0),
        'uptimePercent', case
          when coalesce(summary.sample_count, 0) = 0 then null
          else round(summary.operational_samples::numeric * 100 / summary.sample_count, 3)
        end,
        'lastStatus', summary.last_status,
        'firstCheckedAt', summary.first_checked_at,
        'lastCheckedAt', summary.last_checked_at,
        'incidents', coalesce((
          select jsonb_agg(jsonb_build_object(
            'startedAt', recent.started_at,
            'recoveredAt', recent.recovered_at,
            'durationSeconds', greatest(
              0,
              extract(epoch from (coalesce(recent.recovered_at, now()) - recent.started_at))
            )::bigint
          ) order by recent.started_at desc)
          from (
            select incident.started_at, incident.recovered_at
            from incidents incident
            where incident.component = names.component
            order by incident.started_at desc
            limit 50
          ) recent
        ), '[]'::jsonb)
      ) order by names.component)
      from component_names names
      left join component_summary summary using (component)
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.platform_owner_uptime_history() from public, anon, authenticated;
grant execute on function public.platform_owner_uptime_history() to service_role;
