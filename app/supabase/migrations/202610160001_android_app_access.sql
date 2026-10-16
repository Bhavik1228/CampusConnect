update public.platform_settings
set global_feature_availability = global_feature_availability || '{"mobile_app": true}'::jsonb
where id = 1;

create table public.school_mobile_access (
  school_id uuid primary key references public.schools(id) on delete cascade,
  enabled boolean not null default false,
  role_modules jsonb not null default '{
    "school_admin": ["visitors", "library", "notifications"],
    "academic_coordinator": ["library", "notifications"],
    "nurse": ["health", "notifications"],
    "doctor": ["health", "notifications"],
    "secretary": ["visitors", "notifications"]
  }'::jsonb check (jsonb_typeof(role_modules) = 'object'),
  announcement text not null default '' check (char_length(announcement) <= 1000),
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.school_mobile_access_audit (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  previous_settings jsonb not null,
  new_settings jsonb not null,
  created_at timestamptz not null default timezone('utc', now())
);
create index school_mobile_access_audit_school_idx
  on public.school_mobile_access_audit(school_id, created_at desc);

create table public.mobile_app_sessions (
  auth_session_id uuid primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  app_version text not null default '' check (char_length(app_version) <= 40),
  platform text not null default 'android' check (platform in ('android', 'ios')),
  registered_at timestamptz not null default timezone('utc', now()),
  last_seen_at timestamptz not null default timezone('utc', now())
);
create index mobile_app_sessions_profile_idx
  on public.mobile_app_sessions(profile_id, last_seen_at desc);

alter table public.school_mobile_access enable row level security;
alter table public.school_mobile_access_audit enable row level security;
alter table public.mobile_app_sessions enable row level security;
revoke all on public.school_mobile_access from anon, authenticated;
revoke all on public.school_mobile_access_audit from anon, authenticated;
revoke all on public.mobile_app_sessions from anon, authenticated;
grant all on public.school_mobile_access, public.school_mobile_access_audit, public.mobile_app_sessions to service_role;

create or replace function public.mobile_app_session_registered()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
    and exists (
      select 1 from public.mobile_app_sessions mobile_session
      where mobile_session.profile_id = auth.uid()
        and mobile_session.auth_session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid
    );
$$;

create or replace function public.mobile_school_access_allowed(target_school uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select not public.mobile_app_session_registered()
    or exists (
      select 1
      from public.school_mobile_access access_settings
      join public.school_memberships membership
        on membership.school_id = access_settings.school_id
       and membership.profile_id = auth.uid()
      join public.schools school on school.id = access_settings.school_id
      join public.platform_settings platform on platform.id = 1
      where access_settings.school_id = target_school
        and access_settings.enabled
        and school.platform_status = 'active'
        and coalesce((platform.global_feature_availability ->> 'mobile_app')::boolean, true)
        and access_settings.role_modules ? membership.role::text
        and jsonb_typeof(access_settings.role_modules -> membership.role::text) = 'array'
        and jsonb_array_length(access_settings.role_modules -> membership.role::text) > 0
    );
$$;

create or replace function public.mobile_module_access_allowed(
  target_school uuid,
  requested_module text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select not public.mobile_app_session_registered()
    or (
      public.mobile_school_access_allowed(target_school)
      and exists (
        select 1
        from public.school_mobile_access access_settings
        join public.school_memberships membership
          on membership.school_id = access_settings.school_id
         and membership.profile_id = auth.uid()
        where access_settings.school_id = target_school
          and jsonb_typeof(access_settings.role_modules -> membership.role::text) = 'array'
          and (access_settings.role_modules -> membership.role::text) ? requested_module
      )
      and case requested_module
        when 'visitors' then exists (
          select 1 from public.school_module_settings modules
          where modules.school_id = target_school and modules.module_visitors
        )
        when 'library' then exists (
          select 1 from public.school_module_settings modules
          where modules.school_id = target_school and modules.module_library
        )
        when 'health' then exists (
          select 1 from public.school_module_settings modules
          where modules.school_id = target_school and modules.module_health
        )
        when 'notifications' then true
        else false
      end
    );
$$;

create or replace function public.register_mobile_app_session(
  requested_platform text default 'android',
  requested_app_version text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  session_id_value uuid;
  membership_record record;
  result jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sign in before enabling mobile access.';
  end if;
  if requested_platform not in ('android', 'ios')
    or char_length(coalesce(requested_app_version, '')) > 40 then
    raise exception 'The mobile app session details are invalid.';
  end if;

  session_id_value := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  if session_id_value is null then
    raise exception 'The current authentication session cannot be registered for mobile access.';
  end if;

  insert into public.mobile_app_sessions (
    auth_session_id, profile_id, platform, app_version
  ) values (
    session_id_value, auth.uid(), requested_platform, coalesce(requested_app_version, '')
  )
  on conflict (auth_session_id) do update
    set profile_id = excluded.profile_id,
        platform = excluded.platform,
        app_version = excluded.app_version,
        last_seen_at = timezone('utc', now());

  for membership_record in
    select membership.school_id, membership.role::text as role, school.name,
      access_settings.enabled,
      access_settings.role_modules -> membership.role::text as role_modules,
      coalesce((platform.global_feature_availability ->> 'mobile_app')::boolean, true) as platform_enabled,
      school.platform_status
    from public.school_memberships membership
    join public.schools school on school.id = membership.school_id
    left join public.school_mobile_access access_settings on access_settings.school_id = membership.school_id
    cross join public.platform_settings platform
    where membership.profile_id = auth.uid()
    order by school.name
  loop
    result := result || jsonb_build_array(jsonb_build_object(
      'school_id', membership_record.school_id,
      'school_name', membership_record.name,
      'role', membership_record.role,
      'eligible', coalesce(membership_record.enabled, false)
        and membership_record.platform_enabled
        and membership_record.platform_status = 'active'
        and jsonb_typeof(membership_record.role_modules) = 'array'
        and exists (
          select 1
          from jsonb_array_elements_text(coalesce(membership_record.role_modules, '[]'::jsonb)) module_name
          where public.mobile_module_access_allowed(membership_record.school_id, module_name)
        ),
      'mobile_enabled', coalesce(membership_record.enabled, false),
      'platform_enabled', membership_record.platform_enabled,
      'school_active', membership_record.platform_status = 'active',
      'role_modules', coalesce(membership_record.role_modules, '[]'::jsonb),
      'announcement', coalesce((
        select access_settings.announcement
        from public.school_mobile_access access_settings
        where access_settings.school_id = membership_record.school_id
      ), ''),
      'accessible_modules', coalesce((
        select jsonb_agg(module_name)
        from jsonb_array_elements_text(coalesce(membership_record.role_modules, '[]'::jsonb)) module_name
        where public.mobile_module_access_allowed(membership_record.school_id, module_name)
      ), '[]'::jsonb)
    ));
  end loop;
  return jsonb_build_object('memberships', result);
end;
$$;

create or replace function public.unregister_mobile_app_session()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.mobile_app_sessions
  where profile_id = auth.uid()
    and auth_session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid;
end;
$$;

create or replace function public.get_school_mobile_access(target_school uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  settings_record public.school_mobile_access%rowtype;
  platform_enabled boolean;
begin
  if auth.uid() is null or not public.has_school_role(
    target_school, array['school_admin']::public.app_role[]
  ) then
    raise exception 'Only this school’s administrator can view mobile access settings.';
  end if;

  select * into settings_record
  from public.school_mobile_access
  where school_id = target_school;
  select coalesce((global_feature_availability ->> 'mobile_app')::boolean, true)
    into platform_enabled
  from public.platform_settings
  where id = 1;

  return jsonb_build_object(
    'enabled', coalesce(settings_record.enabled, false),
    'role_modules', coalesce(settings_record.role_modules, '{
      "school_admin": ["visitors", "library", "notifications"],
      "academic_coordinator": ["library", "notifications"],
      "nurse": ["health", "notifications"],
      "doctor": ["health", "notifications"],
      "secretary": ["visitors", "notifications"]
    }'::jsonb),
    'announcement', coalesce(settings_record.announcement, ''),
    'platform_enabled', coalesce(platform_enabled, false),
    'recent_active_sessions', (
      select count(distinct mobile_session.auth_session_id)
      from public.mobile_app_sessions mobile_session
      join public.school_memberships membership
        on membership.profile_id = mobile_session.profile_id
       and membership.school_id = target_school
      where mobile_session.last_seen_at > timezone('utc', now()) - interval '30 days'
    ),
    'recent_activity', coalesce((
      select jsonb_agg(jsonb_build_object(
        'actor_name', coalesce(profile.full_name, 'Former user'),
        'created_at', audit.created_at,
        'previous_settings', audit.previous_settings,
        'new_settings', audit.new_settings
      ) order by audit.created_at desc)
      from (
        select * from public.school_mobile_access_audit audit
        where audit.school_id = target_school
        order by audit.created_at desc
        limit 10
      ) audit
      left join public.profiles profile on profile.id = audit.actor_id
    ), '[]'::jsonb),
    'updated_at', settings_record.updated_at
  );
end;
$$;

create or replace function public.save_school_mobile_access(
  target_school uuid,
  requested_enabled boolean,
  requested_role_modules jsonb,
  requested_announcement text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing_settings public.school_mobile_access%rowtype;
  actor uuid := auth.uid();
  role_item record;
  module_item jsonb;
  allowed_roles text[] := array[
    'school_admin', 'academic_coordinator', 'teacher', 'student', 'parent',
    'finance_manager', 'accountant', 'bursar', 'cashier', 'nurse', 'doctor', 'secretary'
  ];
  allowed_modules text[] := array['visitors', 'library', 'health', 'notifications'];
  platform_enabled boolean;
begin
  if actor is null or not public.has_school_role(
    target_school, array['school_admin']::public.app_role[]
  ) then
    raise exception 'Only this school’s administrator can change mobile access settings.';
  end if;
  if requested_enabled is null
    or jsonb_typeof(requested_role_modules) <> 'object'
    or char_length(coalesce(requested_announcement, '')) > 1000 then
    raise exception 'Provide valid mobile access settings.';
  end if;

  for role_item in select key, value from jsonb_each(requested_role_modules)
  loop
    if not (role_item.key = any(allowed_roles))
      or jsonb_typeof(role_item.value) <> 'array' then
      raise exception 'A mobile role permission is invalid.';
    end if;
    for module_item in select value from jsonb_array_elements(role_item.value)
    loop
      if jsonb_typeof(module_item) <> 'string'
        or not ((module_item #>> '{}') = any(allowed_modules)) then
        raise exception 'A mobile module permission is invalid.';
      end if;
    end loop;
  end loop;

  select * into existing_settings
  from public.school_mobile_access
  where school_id = target_school
  for update;

  insert into public.school_mobile_access (
    school_id, enabled, role_modules, announcement, updated_by
  ) values (
    target_school, requested_enabled, requested_role_modules,
    coalesce(requested_announcement, ''), actor
  )
  on conflict (school_id) do update set
    enabled = excluded.enabled,
    role_modules = excluded.role_modules,
    announcement = excluded.announcement,
    updated_by = excluded.updated_by,
    updated_at = timezone('utc', now());

  insert into public.school_mobile_access_audit (
    school_id, actor_id, previous_settings, new_settings
  ) values (
    target_school,
    actor,
    case when existing_settings.school_id is null then '{}'::jsonb else
      jsonb_build_object(
        'enabled', existing_settings.enabled,
        'role_modules', existing_settings.role_modules,
        'announcement', existing_settings.announcement
      ) end,
    jsonb_build_object(
      'enabled', requested_enabled,
      'role_modules', requested_role_modules,
      'announcement', coalesce(requested_announcement, '')
    )
  );

  select coalesce((global_feature_availability ->> 'mobile_app')::boolean, true)
    into platform_enabled
  from public.platform_settings where id = 1;
  return jsonb_build_object('saved', true, 'platform_enabled', coalesce(platform_enabled, false));
end;
$$;

create or replace function public.is_school_member(target_school uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.school_memberships membership
    join public.schools school on school.id = membership.school_id
    where membership.school_id = target_school
      and membership.profile_id = auth.uid()
      and school.platform_status = 'active'
      and public.mobile_school_access_allowed(target_school)
  );
$$;

create or replace function public.has_school_role(target_school uuid, allowed_roles public.app_role[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.school_memberships membership
    join public.schools school on school.id = membership.school_id
    where membership.school_id = target_school
      and membership.profile_id = auth.uid()
      and membership.role = any(allowed_roles)
      and school.platform_status = 'active'
      and public.mobile_school_access_allowed(target_school)
  );
$$;

create or replace function public.visitor_access_enabled(target_school uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.school_memberships membership
    where membership.school_id = target_school
      and membership.profile_id = auth.uid()
      and membership.role::text in ('school_admin', 'secretary')
  )
  and exists (
    select 1 from public.school_module_settings settings
    where settings.school_id = target_school
      and settings.module_visitors
  )
  and public.mobile_module_access_allowed(target_school, 'visitors');
$$;

create or replace function public.health_access_enabled(target_school uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.school_memberships membership
    where membership.school_id = target_school
      and membership.profile_id = auth.uid()
      and membership.role::text in ('nurse', 'doctor')
  )
  and exists (
    select 1 from public.school_module_settings settings
    where settings.school_id = target_school and settings.module_health
  )
  and public.mobile_module_access_allowed(target_school, 'health');
$$;

create policy "Mobile sessions only access enabled library records"
  on public.school_books as restrictive for all to authenticated
  using (public.mobile_module_access_allowed(school_id, 'library'))
  with check (public.mobile_module_access_allowed(school_id, 'library'));
create policy "Mobile sessions only access enabled checkout records"
  on public.library_checkouts as restrictive for all to authenticated
  using (public.mobile_module_access_allowed(school_id, 'library'))
  with check (public.mobile_module_access_allowed(school_id, 'library'));
create policy "Mobile sessions only access enabled library requests"
  on public.library_requests as restrictive for all to authenticated
  using (public.mobile_module_access_allowed(school_id, 'library'))
  with check (public.mobile_module_access_allowed(school_id, 'library'));
create policy "Mobile sessions only access permitted student rosters"
  on public.students as restrictive for all to authenticated
  using (
    public.mobile_module_access_allowed(school_id, 'library')
    or public.mobile_module_access_allowed(school_id, 'health')
  )
  with check (
    public.mobile_module_access_allowed(school_id, 'library')
    or public.mobile_module_access_allowed(school_id, 'health')
  );
create policy "Mobile sessions only access enabled notifications"
  on public.notifications as restrictive for all to authenticated
  using (public.mobile_module_access_allowed(school_id, 'notifications'))
  with check (public.mobile_module_access_allowed(school_id, 'notifications'));

create or replace function public.checkout_library_book(
  target_book uuid,
  target_student uuid,
  requested_code_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  book_record public.school_books%rowtype;
  student_record public.students%rowtype;
  checkout_id uuid;
begin
  if actor is null then raise exception 'Sign in to check out a book.'; end if;
  if requested_code_hash is null or requested_code_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'A valid one-time return code is required.';
  end if;

  select * into book_record
  from public.school_books
  where id = target_book and archived_at is null
  for update;
  if not found then raise exception 'This book is unavailable.'; end if;
  if not public.has_school_role(book_record.school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
    or not public.mobile_module_access_allowed(book_record.school_id, 'library') then
    raise exception 'Only authorized school library staff can check out books.';
  end if;
  if book_record.available_copies < 1 then raise exception 'There are no available copies of this book.'; end if;

  select * into student_record
  from public.students
  where id = target_student and school_id = book_record.school_id and status = 'active'
  for share;
  if not found then raise exception 'Choose an active student from this school.'; end if;

  if exists (
    select 1 from public.library_checkouts
    where library_checkouts.return_code_hash = requested_code_hash
  ) then
    raise exception 'This return code has already been used. Generate a new code and try again.';
  end if;

  update public.school_books
  set available_copies = available_copies - 1,
      updated_by = actor,
      updated_at = timezone('utc', now())
  where id = book_record.id;

  insert into public.library_checkouts (
    school_id, book_id, student_id, return_code_hash, checked_out_by
  ) values (
    book_record.school_id, book_record.id, student_record.id, requested_code_hash, actor
  ) returning id into checkout_id;

  return jsonb_build_object('checkout_id', checkout_id, 'checked_out_at', timezone('utc', now()));
end;
$$;

create or replace function public.return_library_book(return_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  code_hash text;
  checkout_record public.library_checkouts%rowtype;
  book_record public.school_books%rowtype;
begin
  if actor is null then raise exception 'Sign in to process a book return.'; end if;
  if return_code is null or length(regexp_replace(return_code, '[^A-Za-z0-9]', '', 'g')) <> 16 then
    raise exception 'Enter the 16-character return code printed below the QR code.';
  end if;

  code_hash := encode(
    extensions.digest(
      convert_to(upper(regexp_replace(return_code, '[^A-Za-z0-9]', '', 'g')), 'UTF8'),
      'sha256'::text
    ),
    'hex'
  );
  select * into checkout_record
  from public.library_checkouts
  where library_checkouts.return_code_hash = code_hash
    and library_checkouts.returned_at is null
  for update;
  if not found then raise exception 'No active checkout matches this code. It may be invalid or already returned.'; end if;
  if not public.has_school_role(checkout_record.school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
    or not public.mobile_module_access_allowed(checkout_record.school_id, 'library') then
    raise exception 'You are not authorized to process returns for this school.';
  end if;

  select * into book_record from public.school_books where id = checkout_record.book_id for update;
  if not found then raise exception 'The book record for this checkout is unavailable.'; end if;
  update public.library_checkouts
  set returned_by = actor, returned_at = timezone('utc', now())
  where id = checkout_record.id and returned_at is null;
  if not found then raise exception 'This book has already been returned.'; end if;
  update public.school_books
  set available_copies = least(total_copies, available_copies + 1),
      updated_by = actor,
      updated_at = timezone('utc', now())
  where id = book_record.id;

  return jsonb_build_object(
    'checkout_id', checkout_record.id,
    'book_title', book_record.title,
    'returned_at', timezone('utc', now())
  );
end;
$$;

grant execute on function public.mobile_app_session_registered() to authenticated;
grant execute on function public.mobile_school_access_allowed(uuid) to authenticated;
grant execute on function public.mobile_module_access_allowed(uuid, text) to authenticated;
grant execute on function public.register_mobile_app_session(text, text) to authenticated;
grant execute on function public.unregister_mobile_app_session() to authenticated;
grant execute on function public.get_school_mobile_access(uuid) to authenticated;
grant execute on function public.save_school_mobile_access(uuid, boolean, jsonb, text) to authenticated;
grant execute on function public.checkout_library_book(uuid, uuid, text) to authenticated;
grant execute on function public.return_library_book(text) to authenticated;

revoke all on function public.mobile_app_session_registered() from public, anon;
revoke all on function public.mobile_school_access_allowed(uuid) from public, anon;
revoke all on function public.mobile_module_access_allowed(uuid, text) from public, anon;
revoke all on function public.register_mobile_app_session(text, text) from public, anon;
revoke all on function public.unregister_mobile_app_session() from public, anon;
revoke all on function public.get_school_mobile_access(uuid) from public, anon;
revoke all on function public.save_school_mobile_access(uuid, boolean, jsonb, text) from public, anon;
revoke all on function public.checkout_library_book(uuid, uuid, text) from public, anon;
revoke all on function public.return_library_book(text) from public, anon;

notify pgrst, 'reload schema';
