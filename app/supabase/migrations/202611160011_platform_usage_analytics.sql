create index if not exists platform_runtime_performance_events_school_created_idx
  on public.platform_runtime_performance_events(school_id, created_at desc);

create or replace function public.platform_owner_usage_analytics(
  from_date date,
  through_date date,
  selected_school uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  analytics jsonb;
begin
  if from_date is null or through_date is null
    or from_date > through_date
    or through_date > current_date
    or through_date - from_date > 89 then
    raise exception 'Choose a valid date range of up to 90 days ending today or earlier.';
  end if;
  if selected_school is not null and not exists (
    select 1 from public.schools school where school.id = selected_school
  ) then
    raise exception 'The selected school does not exist.';
  end if;

  with current_events as materialized (
    select
      event.school_id,
      event.profile_id,
      event.session_id,
      event.event_type,
      event.label,
      event.duration_ms,
      event.status_code,
      event.created_at,
      case
        when event.event_type <> 'page' then null
        when split_part(event.route, '/', 2) in ('academic-planning', 'timetable', 'academic-calendar', 'calendar', 'attendance', 'classes', 'subjects', 'grades-results', 'learning', 'courses-lessons', 'assignments', 'curriculum-intelligence') then 'Academics & learning'
        when split_part(event.route, '/', 2) in ('admissions') then 'Admissions'
        when split_part(event.route, '/', 2) in ('students', 'parent-access', 'guardian-contact-verification') then 'Student & family administration'
        when split_part(event.route, '/', 2) in ('staff', 'teachers', 'accounting-staff') then 'Staff management'
        when split_part(event.route, '/', 2) = 'finance' then 'Finance'
        when split_part(event.route, '/', 2) = 'library' then 'Library'
        when split_part(event.route, '/', 2) in ('behaviour', 'health', 'visitors') then 'Student wellbeing & campus'
        when split_part(event.route, '/', 2) in ('messaging', 'family-communications', 'support') then 'Communication & support'
        when split_part(event.route, '/', 2) in ('settings', 'permissions', 'automations', 'website-management', 'admin-workflows', 'school-data', 'setup-health', 'audit-log') then 'School administration'
        when split_part(event.route, '/', 2) = 'dashboard' then 'School overview'
        else 'Other observed pages'
      end as module_name
    from public.platform_runtime_performance_events event
    where event.created_at >= from_date::timestamptz
      and event.created_at < (through_date + 1)::timestamptz
      and (selected_school is null or event.school_id = selected_school)
  ),
  previous_events as materialized (
    select event.school_id, event.profile_id, event.session_id, event.event_type,
      case
        when event.event_type <> 'page' then null
        when split_part(event.route, '/', 2) in ('academic-planning', 'timetable', 'academic-calendar', 'calendar', 'attendance', 'classes', 'subjects', 'grades-results', 'learning', 'courses-lessons', 'assignments', 'curriculum-intelligence') then 'Academics & learning'
        when split_part(event.route, '/', 2) = 'admissions' then 'Admissions'
        when split_part(event.route, '/', 2) in ('students', 'parent-access', 'guardian-contact-verification') then 'Student & family administration'
        when split_part(event.route, '/', 2) in ('staff', 'teachers', 'accounting-staff') then 'Staff management'
        when split_part(event.route, '/', 2) = 'finance' then 'Finance'
        when split_part(event.route, '/', 2) = 'library' then 'Library'
        when split_part(event.route, '/', 2) in ('behaviour', 'health', 'visitors') then 'Student wellbeing & campus'
        when split_part(event.route, '/', 2) in ('messaging', 'family-communications', 'support') then 'Communication & support'
        when split_part(event.route, '/', 2) in ('settings', 'permissions', 'automations', 'website-management', 'admin-workflows', 'school-data', 'setup-health', 'audit-log') then 'School administration'
        when split_part(event.route, '/', 2) = 'dashboard' then 'School overview'
        else 'Other observed pages'
      end as module_name,
      event.created_at
    from public.platform_runtime_performance_events event
    where from_date - (through_date - from_date + 1) >= current_date - 89
      and event.created_at >= (from_date - (through_date - from_date + 1))::timestamptz
      and event.created_at < from_date::timestamptz
      and (selected_school is null or event.school_id = selected_school)
  ),
  current_totals as (
    select count(*)::bigint as event_count,
      count(*) filter (where event_type = 'page')::bigint as page_renders,
      count(*) filter (where event_type = 'request')::bigint as api_samples,
      count(*) filter (where event_type = 'database')::bigint as database_samples,
      count(distinct profile_id)::bigint as active_users,
      count(distinct session_id)::bigint as active_sessions,
      count(distinct school_id)::bigint as reporting_schools,
      max(created_at) as last_activity
    from current_events
  ),
  previous_totals as (
    select count(*)::bigint as event_count,
      count(distinct profile_id)::bigint as active_users
    from previous_events
  ),
  reporting_school_denominator as (
    select count(distinct school_id)::bigint as school_count
    from current_events where event_type = 'page'
  ),
  daily_rows as (
    select created_at::date as activity_date,
      count(*) filter (where event_type = 'page')::bigint as page_renders,
      count(*) filter (where event_type = 'request')::bigint as api_samples,
      count(*) filter (where event_type = 'database')::bigint as database_samples,
      count(distinct profile_id)::bigint as active_users,
      count(distinct session_id)::bigint as active_sessions,
      count(distinct school_id)::bigint as active_schools
    from current_events
    group by created_at::date
  ),
  module_catalog(module_name) as (
    values
      ('Academics & learning'),
      ('Admissions'),
      ('Student & family administration'),
      ('Staff management'),
      ('Finance'),
      ('Library'),
      ('Student wellbeing & campus'),
      ('Communication & support'),
      ('School administration'),
      ('School overview'),
      ('Other observed pages')
  ),
  module_rows as (
    select catalog.module_name,
      count(event.school_id)::bigint as page_renders,
      count(distinct event.profile_id)::bigint as active_users,
      count(distinct event.school_id)::bigint as schools_using,
      max(event.created_at) as last_used
    from module_catalog catalog
    left join current_events event
      on event.event_type = 'page' and event.module_name = catalog.module_name
    group by catalog.module_name
  ),
  previous_module_rows as (
    select module_name, count(*)::bigint as page_renders
    from previous_events
    where event_type = 'page'
    group by module_name
  ),
  service_rows as (
    select event_type, label,
      count(*)::bigint as samples,
      count(*) filter (where status_code >= 400)::bigint as failures,
      count(*) filter (where status_code is null)::bigint as unknown_status,
      percentile_cont(0.95) within group (order by duration_ms) as p95_ms,
      max(created_at) as last_used
    from current_events
    where event_type in ('request', 'database')
    group by event_type, label
  ),
  school_rows as (
    select school.id as school_id, school.name as school_name,
      count(event.school_id)::bigint as event_count,
      count(event.school_id) filter (where event.event_type = 'page')::bigint as page_renders,
      count(event.school_id) filter (where event.event_type = 'request')::bigint as api_samples,
      count(event.school_id) filter (where event.event_type = 'database')::bigint as database_samples,
      count(distinct event.profile_id)::bigint as active_users,
      count(distinct event.session_id)::bigint as active_sessions,
      count(distinct event.module_name) filter (where event.event_type = 'page')::bigint as modules_used,
      max(event.created_at) as last_activity
    from public.schools school
    left join current_events event on event.school_id = school.id
    where selected_school is null or school.id = selected_school
    group by school.id, school.name
  )
  select jsonb_build_object(
    'fromDate', from_date,
    'throughDate', through_date,
    'selectedSchoolId', selected_school,
    'registeredSchools', case when selected_school is null then (select count(*)::bigint from public.schools) else 1 end,
    'reportingSchools', (select reporting_schools from current_totals),
    'coveragePercent', case
      when selected_school is not null then case when (select event_count from current_totals) > 0 then 100.0 else 0.0 end
      else round(100.0 * (select reporting_schools from current_totals)
        / nullif((select count(*) from public.schools), 0), 1)
    end,
    'totals', (select jsonb_build_object(
      'events', event_count, 'pageRenders', page_renders, 'apiSamples', api_samples,
      'databaseSamples', database_samples, 'activeUsers', active_users,
      'activeSessions', active_sessions, 'lastActivity', last_activity
    ) from current_totals),
    'comparisonAvailable', from_date - (through_date - from_date + 1) >= current_date - 89,
    'previousTotals', case
      when from_date - (through_date - from_date + 1) >= current_date - 89
        then (select jsonb_build_object('events', event_count, 'activeUsers', active_users) from previous_totals)
      else jsonb_build_object('events', null, 'activeUsers', null)
    end,
    'daily', coalesce((select jsonb_agg(jsonb_build_object(
      'date', activity_date, 'pageRenders', page_renders, 'apiSamples', api_samples,
      'databaseSamples', database_samples, 'activeUsers', active_users,
      'activeSessions', active_sessions, 'activeSchools', active_schools
    ) order by activity_date) from daily_rows), '[]'::jsonb),
    'modules', coalesce((select jsonb_agg(jsonb_build_object(
      'name', module_name, 'pageRenders', page_renders, 'activeUsers', active_users,
      'schoolsUsing', schools_using, 'reportingSchools', (select school_count from reporting_school_denominator),
      'previousPageRenders', case
        when from_date - (through_date - from_date + 1) >= current_date - 89
          then coalesce((select previous.page_renders from previous_module_rows previous where previous.module_name = module_rows.module_name), 0)
        else null
      end,
      'lastUsed', last_used
    ) order by page_renders desc, module_name)
      from module_rows), '[]'::jsonb),
    'services', coalesce((select jsonb_agg(jsonb_build_object(
      'type', case when event_type = 'database' then 'Database / RPC' else 'API / Edge Function' end,
      'name', label, 'samples', samples, 'failures', failures,
      'unknownStatus', unknown_status, 'p95Ms', round(p95_ms::numeric, 2), 'lastUsed', last_used
    ) order by samples desc, label)
      from service_rows), '[]'::jsonb),
    'schoolOptions', coalesce((select jsonb_agg(jsonb_build_object(
      'schoolId', school.id, 'schoolName', school.name
    ) order by school.name) from public.schools school), '[]'::jsonb),
    'schools', coalesce((select jsonb_agg(jsonb_build_object(
      'schoolId', school_id, 'schoolName', school_name, 'hasTelemetry', event_count > 0,
      'events', event_count, 'pageRenders', page_renders, 'apiSamples', api_samples,
      'databaseSamples', database_samples, 'activeUsers', active_users,
      'activeSessions', active_sessions, 'modulesUsed', modules_used, 'lastActivity', last_activity
    ) order by event_count desc, school_name)
      from school_rows), '[]'::jsonb)
  ) into analytics;

  return analytics;
end;
$$;

revoke all on function public.platform_owner_usage_analytics(date, date, uuid) from public, anon, authenticated;
grant execute on function public.platform_owner_usage_analytics(date, date, uuid) to service_role;

notify pgrst, 'reload schema';
