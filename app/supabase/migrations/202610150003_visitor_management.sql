alter type public.app_role add value if not exists 'secretary';

alter table public.school_module_settings
  add column if not exists module_visitors boolean not null default false;

create or replace function public.visitor_access_enabled(target_school uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.school_memberships membership
    where membership.school_id = target_school
      and membership.profile_id = auth.uid()
      and membership.role::text in ('school_admin', 'secretary')
  )
  and exists (
    select 1
    from public.school_module_settings settings
    where settings.school_id = target_school
      and settings.module_visitors
  );
$$;

create table public.visitor_records (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  badge_number text not null,
  visitor_name text not null check (char_length(trim(visitor_name)) between 1 and 160),
  phone text not null check (char_length(trim(phone)) between 3 and 40),
  organization text not null default '' check (char_length(organization) <= 160),
  purpose text not null check (char_length(trim(purpose)) between 1 and 2000),
  host_name text not null check (char_length(trim(host_name)) between 1 and 160),
  host_department text not null default '' check (char_length(host_department) <= 120),
  id_type text not null default '' check (char_length(id_type) <= 80),
  id_number text not null default '' check (char_length(id_number) <= 120),
  photo_path text,
  visit_date date not null default current_date,
  valid_until date not null default current_date,
  status text not null default 'expected'
    check (status in ('expected', 'checked_in', 'checked_out', 'cancelled')),
  arrived_at timestamptz,
  departed_at timestamptz,
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, badge_number),
  check (valid_until >= visit_date),
  check (
    (status = 'expected' and arrived_at is null and departed_at is null)
    or (status = 'checked_in' and arrived_at is not null and departed_at is null)
    or (status = 'checked_out' and arrived_at is not null and departed_at is not null)
    or status = 'cancelled'
  ),
  check (
    photo_path is null or
    (photo_path like school_id::text || '/' || id::text || '/%')
  )
);

create index visitor_records_school_visit_idx
  on public.visitor_records(school_id, visit_date desc, created_at desc);
create index visitor_records_search_idx
  on public.visitor_records(school_id, lower(visitor_name), phone);
create unique index visitor_records_one_active_identity_idx
  on public.visitor_records(school_id, lower(trim(phone)))
  where status = 'checked_in';

create trigger visitor_records_set_updated_at
  before update on public.visitor_records
  for each row execute function public.set_updated_at();

create table public.visitor_audit_events (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools(id) on delete cascade,
  visitor_id uuid not null,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null check (action in ('created', 'corrected', 'checked_in', 'checked_out', 'cancelled')),
  changed_fields text[] not null default '{}',
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, visitor_id) references public.visitor_records(school_id, id) on delete cascade
);
create index visitor_audit_events_record_idx
  on public.visitor_audit_events(school_id, visitor_id, created_at desc);

alter table public.visitor_records enable row level security;
alter table public.visitor_audit_events enable row level security;

create policy "Authorized school staff read visitor records"
  on public.visitor_records for select to authenticated
  using (public.visitor_access_enabled(school_id));

create policy "Authorized school staff read visitor audit events"
  on public.visitor_audit_events for select to authenticated
  using (public.visitor_access_enabled(school_id));

grant select on public.visitor_records, public.visitor_audit_events to authenticated;
revoke insert, update, delete, truncate, references, trigger on public.visitor_records from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on public.visitor_audit_events from anon, authenticated;

create or replace function public.audit_visitor_record_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  old_record jsonb;
  new_record jsonb;
  fields_changed text[];
  action_name text;
begin
  if tg_op = 'INSERT' then
    insert into public.visitor_audit_events (school_id, visitor_id, actor_id, action, changed_fields)
    values (new.school_id, new.id, auth.uid(), 'created', array['visitor_record']);
    return new;
  end if;

  if tg_op = 'UPDATE' then
    old_record := to_jsonb(old) - array['updated_at', 'updated_by'];
    new_record := to_jsonb(new) - array['updated_at', 'updated_by'];
    select coalesce(array_agg(changed.key order by changed.key), '{}')
      into fields_changed
      from jsonb_each(new_record) as changed(key, value)
      where old_record -> changed.key is distinct from changed.value;

    action_name := case
      when old.status is distinct from new.status and new.status = 'checked_in' then 'checked_in'
      when old.status is distinct from new.status and new.status = 'checked_out' then 'checked_out'
      when old.status is distinct from new.status and new.status = 'cancelled' then 'cancelled'
      else 'corrected'
    end;

    if cardinality(fields_changed) > 0 then
      insert into public.visitor_audit_events (school_id, visitor_id, actor_id, action, changed_fields)
      values (new.school_id, new.id, auth.uid(), action_name, fields_changed);
    end if;
    return new;
  end if;
  return old;
end;
$$;

create trigger visitor_records_audit
  after insert or update on public.visitor_records
  for each row execute function public.audit_visitor_record_change();

create or replace function public.save_visitor_record(
  target_school uuid,
  target_visit uuid,
  visitor_data jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  visit_id uuid;
  is_new boolean;
  visit_status text;
  visit_date_value date;
  validity_date date;
  photo_path_value text;
  maintenance jsonb;
begin
  if auth.uid() is null or not public.visitor_access_enabled(target_school) then
    raise exception 'Visitor management is disabled or you do not have authorized access.';
  end if;
  maintenance := public.platform_maintenance_status(target_school, 'visitors');
  if coalesce((maintenance ->> 'active')::boolean, false) then
    raise exception 'Visitor records are read-only during scheduled maintenance.';
  end if;

  if char_length(trim(coalesce(visitor_data->>'visitor_name', ''))) not between 1 and 160
    or char_length(trim(coalesce(visitor_data->>'phone', ''))) not between 3 and 40
    or char_length(trim(coalesce(visitor_data->>'purpose', ''))) not between 1 and 2000
    or char_length(trim(coalesce(visitor_data->>'host_name', ''))) not between 1 and 160 then
    raise exception 'Enter the visitor name, phone, purpose and person being visited.';
  end if;

  visit_date_value := coalesce(nullif(visitor_data->>'visit_date', '')::date, current_date);
  validity_date := coalesce(nullif(visitor_data->>'valid_until', '')::date, visit_date_value);
  if validity_date < visit_date_value then
    raise exception 'Badge validity cannot end before the visit date.';
  end if;

  is_new := target_visit is null or not exists (
    select 1 from public.visitor_records record
    where record.id = target_visit and record.school_id = target_school
  );
  visit_id := case when is_new then coalesce(target_visit, gen_random_uuid()) else target_visit end;

  photo_path_value := nullif(trim(coalesce(visitor_data->>'photo_path', '')), '');
  if photo_path_value is not null and (
    split_part(photo_path_value, '/', 1) <> target_school::text
    or split_part(photo_path_value, '/', 2) <> visit_id::text
  ) then
    raise exception 'Visitor photo path must belong to this school and visit.';
  end if;

  if is_new then
    insert into public.visitor_records (
      id, school_id, badge_number, visitor_name, phone, organization, purpose,
      host_name, host_department, id_type, id_number, photo_path, visit_date,
      valid_until, status, created_by, updated_by
    ) values (
      visit_id, target_school, 'VIS-' || upper(substr(replace(visit_id::text, '-', ''), 1, 10)),
      trim(visitor_data->>'visitor_name'), trim(visitor_data->>'phone'),
      trim(coalesce(visitor_data->>'organization', '')), trim(visitor_data->>'purpose'),
      trim(visitor_data->>'host_name'), trim(coalesce(visitor_data->>'host_department', '')),
      trim(coalesce(visitor_data->>'id_type', '')), trim(coalesce(visitor_data->>'id_number', '')),
      photo_path_value, visit_date_value, validity_date, 'expected', auth.uid(), auth.uid()
    );
  else
    select record.id into visit_id
    from public.visitor_records record
    where record.id = target_visit and record.school_id = target_school;
    if visit_id is null then
      raise exception 'The visitor record is not available in this school.';
    end if;
    if exists (
      select 1 from public.visitor_records record
      where record.id = target_visit and record.school_id = target_school
        and record.status = 'checked_in'
        and (visit_date_value > current_date or validity_date < current_date)
    ) then
      raise exception 'A checked-in visit must remain valid for today.';
    end if;

    update public.visitor_records
    set visitor_name = trim(visitor_data->>'visitor_name'),
        phone = trim(visitor_data->>'phone'),
        organization = trim(coalesce(visitor_data->>'organization', '')),
        purpose = trim(visitor_data->>'purpose'),
        host_name = trim(visitor_data->>'host_name'),
        host_department = trim(coalesce(visitor_data->>'host_department', '')),
        id_type = trim(coalesce(visitor_data->>'id_type', '')),
        id_number = trim(coalesce(visitor_data->>'id_number', '')),
        photo_path = photo_path_value,
        visit_date = visit_date_value,
        valid_until = validity_date,
        updated_by = auth.uid()
    where id = target_visit and school_id = target_school;
  end if;
  return visit_id;
end;
$$;

create or replace function public.transition_visitor_status(
  target_school uuid,
  target_visit uuid,
  next_status text
)
returns public.visitor_records
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved public.visitor_records%rowtype;
  maintenance jsonb;
begin
  if auth.uid() is null or not public.visitor_access_enabled(target_school) then
    raise exception 'Visitor management is disabled or you do not have authorized access.';
  end if;
  maintenance := public.platform_maintenance_status(target_school, 'visitors');
  if coalesce((maintenance ->> 'active')::boolean, false) then
    raise exception 'Visitor check-in and check-out are disabled during scheduled maintenance.';
  end if;

  if next_status not in ('checked_in', 'checked_out', 'cancelled') then
    raise exception 'Choose a valid visitor status.';
  end if;

  if next_status = 'checked_in' then
    update public.visitor_records
    set status = 'checked_in', arrived_at = timezone('utc', now()), updated_by = auth.uid()
    where id = target_visit and school_id = target_school
      and status = 'expected' and visit_date <= current_date and valid_until >= current_date
    returning * into saved;
    if not found then
      raise exception 'This badge is invalid, expired or already checked in.';
    end if;
  elsif next_status = 'checked_out' then
    update public.visitor_records
    set status = 'checked_out', departed_at = timezone('utc', now()), updated_by = auth.uid()
    where id = target_visit and school_id = target_school and status = 'checked_in'
    returning * into saved;
    if not found then
      raise exception 'Only a currently checked-in visitor can be checked out.';
    end if;
  else
    update public.visitor_records
    set status = 'cancelled', updated_by = auth.uid()
    where id = target_visit and school_id = target_school and status = 'expected'
    returning * into saved;
    if not found then
      raise exception 'Only an expected visitor can be cancelled.';
    end if;
  end if;

  return saved;
end;
$$;

revoke all on function public.save_visitor_record(uuid, uuid, jsonb) from public;
revoke all on function public.transition_visitor_status(uuid, uuid, text) from public;
grant execute on function public.save_visitor_record(uuid, uuid, jsonb) to authenticated;
grant execute on function public.transition_visitor_status(uuid, uuid, text) to authenticated;

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
  select global_feature_availability into feature_flags
  from public.platform_settings where id = 1;
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
  if coalesce((feature_flags ->> 'visitors')::boolean, true) = false and new.module_visitors then
    if tg_op = 'INSERT' then
      new.module_visitors := false;
    else
      raise exception 'Visitor management is disabled platform-wide.';
    end if;
  end if;
  return new;
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('visitor-photos', 'visitor-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = false,
    file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

create policy "Authorized staff read visitor badge photos"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'visitor-photos'
    and public.visitor_access_enabled((storage.foldername(name))[1]::uuid)
  );

create policy "Authorized staff upload visitor badge photos"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'visitor-photos'
    and public.visitor_access_enabled((storage.foldername(name))[1]::uuid)
  );

create policy "Authorized staff replace visitor badge photos"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'visitor-photos'
    and public.visitor_access_enabled((storage.foldername(name))[1]::uuid)
  )
  with check (
    bucket_id = 'visitor-photos'
    and public.visitor_access_enabled((storage.foldername(name))[1]::uuid)
  );

notify pgrst, 'reload schema';
