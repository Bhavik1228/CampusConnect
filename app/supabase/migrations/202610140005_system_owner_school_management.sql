alter table public.schools
  add column favicon_path text,
  add column date_format text not null default 'YYYY-MM-DD'
    check (date_format in ('YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD.MM.YYYY')),
  add column subscription_status text not null default 'free'
    check (subscription_status in ('free', 'trial', 'active', 'past_due', 'cancelled')),
  add column subscription_plan text not null default 'phase_1_free'
    check (char_length(subscription_plan) <= 100),
  add column subscription_ends_at timestamptz;

create table public.platform_settings (
  id smallint primary key default 1 check (id = 1),
  platform_name text not null default 'Campus Connect' check (char_length(trim(platform_name)) between 2 and 120),
  logo_url text not null default '' check (char_length(logo_url) <= 2000),
  favicon_url text not null default '' check (char_length(favicon_url) <= 2000),
  contact_email text not null default '' check (char_length(contact_email) <= 320),
  contact_phone text not null default '' check (char_length(contact_phone) <= 40),
  default_language text not null default 'en' check (char_length(default_language) <= 20),
  default_timezone text not null default 'UTC' check (char_length(default_timezone) <= 100),
  default_date_format text not null default 'YYYY-MM-DD' check (char_length(default_date_format) <= 40),
  supported_school_types jsonb not null default '["primary", "secondary", "k12", "university", "other"]'::jsonb,
  default_academic_configuration jsonb not null default '{"academicYearStartMonth": 9, "academicYearStartDay": 1, "termCount": 3}'::jsonb,
  global_feature_availability jsonb not null default '{"attendance": true, "timetable": true, "learning": true, "assignments": true, "grades": true, "finance": true, "messaging": true, "admissions": true}'::jsonb,
  maintenance_notice text not null default '',
  default_notification_settings jsonb not null default '{"email": true, "inApp": true, "maintenanceNotices": true}'::jsonb,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default timezone('utc', now())
);

insert into public.platform_settings (id) values (1) on conflict (id) do nothing;
alter table public.platform_settings enable row level security;
revoke all on public.platform_settings from anon, authenticated;
grant all on public.platform_settings to service_role;

create or replace function public.platform_public_branding()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'platform_name', platform_name,
    'logo_url', logo_url,
    'favicon_url', favicon_url,
    'maintenance_notice', maintenance_notice
  )
  from public.platform_settings
  where id = 1;
$$;
revoke all on function public.platform_public_branding() from public;
grant execute on function public.platform_public_branding() to anon, authenticated;

alter table public.school_module_settings
  add column module_admissions boolean not null default true;

create or replace function public.apply_platform_defaults_to_new_school()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  platform_defaults public.platform_settings%rowtype;
  feature_flags jsonb;
  academic_defaults jsonb;
  notification_defaults jsonb;
begin
  select * into platform_defaults from public.platform_settings where id = 1;
  feature_flags := platform_defaults.global_feature_availability;
  academic_defaults := platform_defaults.default_academic_configuration;
  notification_defaults := platform_defaults.default_notification_settings;

  update public.schools
  set timezone = coalesce(nullif(timezone, 'UTC'), platform_defaults.default_timezone),
      default_language = coalesce(nullif(default_language, 'en'), platform_defaults.default_language),
      date_format = coalesce(nullif(date_format, 'YYYY-MM-DD'), platform_defaults.default_date_format)
  where id = new.id;

  update public.school_academic_policies
  set academic_year_start_month = coalesce((academic_defaults ->> 'academicYearStartMonth')::smallint, academic_year_start_month),
      academic_year_start_day = coalesce((academic_defaults ->> 'academicYearStartDay')::smallint, academic_year_start_day),
      default_term_count = coalesce((academic_defaults ->> 'termCount')::smallint, default_term_count)
  where school_id = new.id;

  update public.school_module_settings
  set module_attendance = coalesce((feature_flags ->> 'attendance')::boolean, module_attendance),
      module_timetable = coalesce((feature_flags ->> 'timetable')::boolean, module_timetable),
      module_learning = coalesce((feature_flags ->> 'learning')::boolean, module_learning),
      module_assignments = coalesce((feature_flags ->> 'assignments')::boolean, module_assignments),
      module_assessment_results = coalesce((feature_flags ->> 'grades')::boolean, module_assessment_results),
      module_finance = coalesce((feature_flags ->> 'finance')::boolean, module_finance),
      module_messaging = coalesce((feature_flags ->> 'messaging')::boolean, module_messaging),
      module_admissions = coalesce((feature_flags ->> 'admissions')::boolean, module_admissions)
  where school_id = new.id;

  if coalesce((notification_defaults ->> 'inApp')::boolean, true) = false then
    update public.school_communication_settings
    set notification_categories = jsonb_build_object(
      'announcements', false, 'attendance', false, 'assignments', false,
      'grades', false, 'events', false, 'messages', false
    )
    where school_id = new.id;
  end if;
  update public.school_notification_templates
  set enabled = false
  where school_id = new.id
    and ((channel = 'email' and coalesce((notification_defaults ->> 'email')::boolean, true) = false)
      or (channel = 'in_app' and coalesce((notification_defaults ->> 'inApp')::boolean, true) = false)
      or (event_type = 'system_maintenance' and coalesce((notification_defaults ->> 'maintenanceNotices')::boolean, true) = false));

  return new;
end;
$$;

create trigger zz_apply_platform_defaults_to_new_school
  after insert on public.schools
  for each row execute function public.apply_platform_defaults_to_new_school();
revoke all on function public.apply_platform_defaults_to_new_school() from public, anon, authenticated;

create or replace function public.enforce_platform_feature_availability()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  feature_flags jsonb;
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  select global_feature_availability into feature_flags from public.platform_settings where id = 1;
  if coalesce((feature_flags ->> 'attendance')::boolean, true) = false and new.module_attendance then
    if tg_op = 'INSERT' then new.module_attendance := false; else raise exception 'Attendance is disabled platform-wide.'; end if;
  end if;
  if coalesce((feature_flags ->> 'timetable')::boolean, true) = false and new.module_timetable then
    if tg_op = 'INSERT' then new.module_timetable := false; else raise exception 'Timetable is disabled platform-wide.'; end if;
  end if;
  if coalesce((feature_flags ->> 'learning')::boolean, true) = false and new.module_learning then
    if tg_op = 'INSERT' then new.module_learning := false; else raise exception 'Learning is disabled platform-wide.'; end if;
  end if;
  if coalesce((feature_flags ->> 'assignments')::boolean, true) = false and new.module_assignments then
    if tg_op = 'INSERT' then new.module_assignments := false; else raise exception 'Assignments are disabled platform-wide.'; end if;
  end if;
  if coalesce((feature_flags ->> 'grades')::boolean, true) = false and new.module_assessment_results then
    if tg_op = 'INSERT' then new.module_assessment_results := false; else raise exception 'Grades are disabled platform-wide.'; end if;
  end if;
  if coalesce((feature_flags ->> 'finance')::boolean, true) = false and new.module_finance then
    if tg_op = 'INSERT' then new.module_finance := false; else raise exception 'Finance is disabled platform-wide.'; end if;
  end if;
  if coalesce((feature_flags ->> 'messaging')::boolean, true) = false and new.module_messaging then
    if tg_op = 'INSERT' then new.module_messaging := false; else raise exception 'Messaging is disabled platform-wide.'; end if;
  end if;
  if coalesce((feature_flags ->> 'admissions')::boolean, true) = false and new.module_admissions then
    if tg_op = 'INSERT' then new.module_admissions := false; else raise exception 'Admissions are disabled platform-wide.'; end if;
  end if;
  return new;
end;
$$;

create trigger enforce_platform_feature_availability
  before insert or update on public.school_module_settings
  for each row execute function public.enforce_platform_feature_availability();
revoke all on function public.enforce_platform_feature_availability() from public;

create or replace function public.platform_owner_save_settings(settings_value jsonb, actor uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  feature_flags jsonb := settings_value -> 'global_feature_availability';
begin
  insert into public.platform_settings (
    id, platform_name, logo_url, favicon_url, contact_email, contact_phone,
    default_language, default_timezone, default_date_format, supported_school_types,
    default_academic_configuration, global_feature_availability, maintenance_notice,
    default_notification_settings, updated_by, updated_at
  ) values (
    1, settings_value ->> 'platform_name', settings_value ->> 'logo_url',
    settings_value ->> 'favicon_url', settings_value ->> 'contact_email',
    settings_value ->> 'contact_phone', settings_value ->> 'default_language',
    settings_value ->> 'default_timezone', settings_value ->> 'default_date_format',
    settings_value -> 'supported_school_types', settings_value -> 'default_academic_configuration',
    feature_flags, settings_value ->> 'maintenance_notice',
    settings_value -> 'default_notification_settings', actor, timezone('utc', now())
  )
  on conflict (id) do update set
    platform_name = excluded.platform_name,
    logo_url = excluded.logo_url,
    favicon_url = excluded.favicon_url,
    contact_email = excluded.contact_email,
    contact_phone = excluded.contact_phone,
    default_language = excluded.default_language,
    default_timezone = excluded.default_timezone,
    default_date_format = excluded.default_date_format,
    supported_school_types = excluded.supported_school_types,
    default_academic_configuration = excluded.default_academic_configuration,
    global_feature_availability = excluded.global_feature_availability,
    maintenance_notice = excluded.maintenance_notice,
    default_notification_settings = excluded.default_notification_settings,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  update public.school_module_settings
  set module_attendance = case when coalesce((feature_flags ->> 'attendance')::boolean, true) then module_attendance else false end,
      module_timetable = case when coalesce((feature_flags ->> 'timetable')::boolean, true) then module_timetable else false end,
      module_learning = case when coalesce((feature_flags ->> 'learning')::boolean, true) then module_learning else false end,
      module_assignments = case when coalesce((feature_flags ->> 'assignments')::boolean, true) then module_assignments else false end,
      module_assessment_results = case when coalesce((feature_flags ->> 'grades')::boolean, true) then module_assessment_results else false end,
      module_finance = case when coalesce((feature_flags ->> 'finance')::boolean, true) then module_finance else false end,
      module_messaging = case when coalesce((feature_flags ->> 'messaging')::boolean, true) then module_messaging else false end,
      module_admissions = case when coalesce((feature_flags ->> 'admissions')::boolean, true) then module_admissions else false end
  where (feature_flags ->> 'attendance')::boolean is false
    or (feature_flags ->> 'timetable')::boolean is false
    or (feature_flags ->> 'learning')::boolean is false
    or (feature_flags ->> 'assignments')::boolean is false
    or (feature_flags ->> 'grades')::boolean is false
    or (feature_flags ->> 'finance')::boolean is false
    or (feature_flags ->> 'messaging')::boolean is false
    or (feature_flags ->> 'admissions')::boolean is false;
end;
$$;

revoke all on function public.platform_owner_save_settings(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.platform_owner_save_settings(jsonb, uuid) to service_role;

create or replace function public.protect_system_owned_school_settings()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if auth.role() is distinct from 'service_role'
    and (
      new.platform_status is distinct from old.platform_status
      or new.managed_storage_enabled is distinct from old.managed_storage_enabled
      or new.subscription_status is distinct from old.subscription_status
      or new.subscription_plan is distinct from old.subscription_plan
      or new.subscription_ends_at is distinct from old.subscription_ends_at
    ) then
    raise exception 'Platform owner authorization is required to change platform school settings.';
  end if;
  return new;
end;
$$;

create or replace function public.platform_owner_school_list(
  search_text text default '',
  status_filter text default '',
  type_filter text default '',
  sort_field text default 'created_at',
  sort_ascending boolean default false,
  page_number integer default 1,
  page_size integer default 20
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with filtered as (
    select school.*
    from public.schools school
    where (coalesce(search_text, '') = '' or school.name ilike '%' || search_text || '%')
      and (coalesce(status_filter, '') = '' or school.platform_status = status_filter)
      and (coalesce(type_filter, '') = '' or school.school_type = type_filter)
  ),
  ranked as (
    select school.*,
      row_number() over (order by
      case when sort_field = 'name' and sort_ascending then school.name end asc,
      case when sort_field = 'name' and not sort_ascending then school.name end desc,
      case when sort_field = 'status' and sort_ascending then school.platform_status end asc,
      case when sort_field = 'status' and not sort_ascending then school.platform_status end desc,
      case when sort_field = 'subscription' and sort_ascending then school.subscription_status end asc,
      case when sort_field = 'subscription' and not sort_ascending then school.subscription_status end desc,
      case when sort_field = 'created_at' and sort_ascending then school.created_at end asc,
      case when sort_field = 'created_at' and not sort_ascending then school.created_at end desc,
      school.name asc
      ) as owner_order
    from filtered school
  ),
  selected as (
    select *
    from ranked
    where owner_order > greatest(coalesce(page_number, 1) - 1, 0) * least(greatest(coalesce(page_size, 20), 1), 50)
      and owner_order <= greatest(coalesce(page_number, 1) - 1, 0) * least(greatest(coalesce(page_size, 20), 1), 50)
        + least(greatest(coalesce(page_size, 20), 1), 50)
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'schools', coalesce((
      select jsonb_agg(
        (to_jsonb(school_row) - 'owner_order')
        || jsonb_build_object(
          'user_count', (
            select count(distinct membership.profile_id)
            from public.school_memberships membership
            where membership.school_id = school_row.id
          ),
          'student_count', (
            select count(*)
            from public.students student
            where student.school_id = school_row.id
          ),
          'administrators', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', profile.id,
              'name', profile.full_name,
              'email', profile.email
            ) order by profile.full_name)
            from public.school_memberships membership
            join public.profiles profile on profile.id = membership.profile_id
            where membership.school_id = school_row.id
              and membership.role = 'school_admin'
          ), '[]'::jsonb)
        )
        order by school_row.owner_order
      )
      from (
        select id, name, platform_status, subscription_status, subscription_plan,
          subscription_ends_at, school_type, contact_email, contact_phone, address, date_format,
          website, timezone, default_language, logo_path, favicon_path, created_at, owner_order
        from selected
      ) school_row
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.platform_owner_school_list(text, text, text, text, boolean, integer, integer) from public, anon, authenticated;
grant execute on function public.platform_owner_school_list(text, text, text, text, boolean, integer, integer) to service_role;
