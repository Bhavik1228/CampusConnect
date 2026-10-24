alter type public.app_role add value if not exists 'website_editor';
alter type public.app_role add value if not exists 'website_publisher';
alter type public.app_role add value if not exists 'admissions_officer';
alter type public.app_role add value if not exists 'hr_staff_administrator';
alter type public.app_role add value if not exists 'transport_manager';
alter type public.app_role add value if not exists 'facilities_manager';
alter type public.app_role add value if not exists 'it_support_technician';
alter type public.app_role add value if not exists 'safeguarding_officer';
alter type public.app_role add value if not exists 'procurement_officer';
alter type public.app_role add value if not exists 'compliance_audit_officer';

create or replace function public.can_manage_administrative_domain(
  target_school uuid,
  target_domain text
)
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
      and (
        membership.role::text = 'school_admin'
        or (target_domain = 'transport' and membership.role::text = 'transport_manager')
        or (target_domain = 'facilities' and membership.role::text = 'facilities_manager')
        or (target_domain = 'it_support' and membership.role::text = 'it_support_technician')
        or (target_domain = 'hr' and membership.role::text = 'hr_staff_administrator')
        or (target_domain = 'safeguarding' and membership.role::text = 'safeguarding_officer')
        or (target_domain = 'procurement' and membership.role::text = 'procurement_officer')
        or (target_domain = 'compliance' and membership.role::text = 'compliance_audit_officer')
      )
  );
$$;

revoke all on function public.can_manage_administrative_domain(uuid, text) from public;
grant execute on function public.can_manage_administrative_domain(uuid, text) to authenticated;

create table public.school_administrative_work_items (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  domain text not null check (domain in ('transport', 'facilities', 'it_support', 'safeguarding', 'procurement', 'compliance')),
  record_type text not null check (record_type in (
    'vehicle', 'route', 'student_assignment', 'incident',
    'asset', 'maintenance_request',
    'support_ticket', 'equipment',
    'concern', 'referral',
    'supplier', 'requisition', 'purchase_order',
    'check', 'evidence', 'corrective_action'
  )),
  title text not null check (char_length(trim(title)) between 2 and 160),
  description text not null default '' check (char_length(description) <= 5000),
  status text not null default 'open'
    check (status in ('open', 'assigned', 'in_progress', 'pending_approval', 'approved', 'rejected', 'resolved', 'closed')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  assigned_to uuid,
  due_date date,
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, assigned_to)
    references public.school_memberships(school_id, profile_id) on delete set null (assigned_to),
  check (
    (domain = 'transport' and record_type in ('vehicle', 'route', 'student_assignment', 'incident'))
    or (domain = 'facilities' and record_type in ('asset', 'maintenance_request'))
    or (domain = 'it_support' and record_type in ('support_ticket', 'equipment'))
    or (domain = 'safeguarding' and record_type in ('concern', 'referral'))
    or (domain = 'procurement' and record_type in ('supplier', 'requisition', 'purchase_order'))
    or (domain = 'compliance' and record_type in ('check', 'evidence', 'corrective_action'))
  )
);

create index school_admin_work_items_domain_status_idx
  on public.school_administrative_work_items(school_id, domain, status, updated_at desc);
create index school_admin_work_items_assignee_idx
  on public.school_administrative_work_items(school_id, assigned_to, due_date);
alter table public.school_administrative_work_items enable row level security;
grant select, insert, update on public.school_administrative_work_items to authenticated;
create policy "Authorized school roles view their administrative domain"
  on public.school_administrative_work_items for select to authenticated
  using (public.can_manage_administrative_domain(school_id, domain))
;
create policy "Authorized school roles create domain records"
  on public.school_administrative_work_items for insert to authenticated
  with check (
    public.can_manage_administrative_domain(school_id, domain)
    and created_by = auth.uid()
    and updated_by = auth.uid()
  );
create policy "Authorized school roles update domain records"
  on public.school_administrative_work_items for update to authenticated
  using (public.can_manage_administrative_domain(school_id, domain))
  with check (
    public.can_manage_administrative_domain(school_id, domain)
    and updated_by = auth.uid()
  );

create table public.school_administrative_work_item_events (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools(id) on delete cascade,
  work_item_id uuid not null,
  domain text not null check (domain in ('transport', 'facilities', 'it_support', 'safeguarding', 'procurement', 'compliance')),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null check (action in ('created', 'updated')),
  from_status text,
  to_status text not null,
  note text not null default '' check (char_length(note) <= 1000),
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, work_item_id)
    references public.school_administrative_work_items(school_id, id) on delete cascade
);
create index school_admin_work_item_events_idx
  on public.school_administrative_work_item_events(school_id, work_item_id, created_at desc);
alter table public.school_administrative_work_item_events enable row level security;
revoke all on public.school_administrative_work_item_events from anon, authenticated;
grant select on public.school_administrative_work_item_events to authenticated;
create policy "Authorized roles read administrative workflow history"
  on public.school_administrative_work_item_events for select to authenticated
  using (public.can_manage_administrative_domain(school_id, domain));

create or replace function public.record_administrative_work_item_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.school_id is distinct from old.school_id
    or new.domain is distinct from old.domain
    or new.record_type is distinct from old.record_type
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'A workflow record identity, school, domain, type, creator, and creation time are immutable.';
  end if;
  if tg_op = 'INSERT'
    and new.domain = 'procurement'
    and new.status in ('approved', 'rejected')
    and not public.has_school_role(new.school_id, array['school_admin']::public.app_role[]) then
    raise exception 'Procurement submissions require school administrator approval.';
  end if;
  if tg_op = 'UPDATE'
    and old.domain = 'procurement'
    and new.status in ('approved', 'rejected')
    and old.status is distinct from new.status
    and exists (
      select 1
      from public.school_memberships membership
      where membership.school_id = new.school_id
        and membership.profile_id = auth.uid()
        and membership.role::text = 'procurement_officer'
    ) then
    raise exception 'Procurement submissions must be approved or rejected by a school administrator.';
  end if;

  insert into public.school_administrative_work_item_events (
    school_id, work_item_id, domain, actor_id, action, from_status, to_status, note
  ) values (
    new.school_id,
    new.id,
    new.domain,
    auth.uid(),
    case when tg_op = 'INSERT' then 'created' else 'updated' end,
    case when tg_op = 'INSERT' then null else old.status end,
    new.status,
    coalesce(new.details ->> 'latest_note', '')
  );
  return new;
end;
$$;

create trigger record_administrative_work_item_event
  after insert or update on public.school_administrative_work_items
  for each row execute function public.record_administrative_work_item_event();

alter table public.school_websites
  add column if not exists published_content jsonb not null default '{}'::jsonb
    check (jsonb_typeof(published_content) = 'object');
create table public.school_website_content_versions (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  status text not null default 'draft' check (status in ('draft', 'pending_review', 'published', 'rejected')),
  editor_id uuid not null references public.profiles(id),
  publisher_id uuid references public.profiles(id),
  review_note text not null default '' check (char_length(review_note) <= 1000),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id)
);
create index school_website_content_versions_school_status_idx
  on public.school_website_content_versions(school_id, status, updated_at desc);
alter table public.school_website_content_versions enable row level security;
grant select, insert, update on public.school_website_content_versions to authenticated;
create policy "Website editors and publishers review content drafts"
  on public.school_website_content_versions for select to authenticated
  using (public.can_manage_administrative_domain(school_id, 'website'));
create policy "Website editors create drafts"
  on public.school_website_content_versions for insert to authenticated
  with check (
    editor_id = auth.uid()
    and exists (
      select 1 from public.school_memberships membership
      where membership.school_id = school_website_content_versions.school_id
        and membership.profile_id = auth.uid()
        and membership.role::text in ('school_admin', 'website_editor')
    )
    and status in ('draft', 'pending_review')
  );
create policy "Website editors update their drafts"
  on public.school_website_content_versions for update to authenticated
  using (
    editor_id = auth.uid()
    and status in ('draft', 'rejected')
    and exists (
      select 1 from public.school_memberships membership
      where membership.school_id = school_website_content_versions.school_id
        and membership.profile_id = auth.uid()
        and membership.role::text in ('school_admin', 'website_editor')
    )
  )
  with check (
    editor_id = auth.uid()
    and status in ('draft', 'pending_review')
    and exists (
      select 1 from public.school_memberships membership
      where membership.school_id = school_website_content_versions.school_id
        and membership.profile_id = auth.uid()
        and membership.role::text in ('school_admin', 'website_editor')
    )
  );

create or replace function public.protect_school_website_content_version()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.publisher_id is not null or new.review_note <> '' then
      raise exception 'New website drafts cannot contain publisher review data.';
    end if;
  else
    if new.id is distinct from old.id
      or new.school_id is distinct from old.school_id
      or new.editor_id is distinct from old.editor_id
      or new.created_at is distinct from old.created_at then
      raise exception 'Website draft identity, school, editor, and creation time are immutable.';
    end if;
    if not exists (
      select 1 from public.school_memberships membership
      where membership.school_id = old.school_id
        and membership.profile_id = auth.uid()
        and membership.role::text in ('school_admin', 'website_publisher')
    ) and (
      new.publisher_id is distinct from old.publisher_id
      or new.review_note <> ''
    ) then
      raise exception 'Only a website publisher can add review information.';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.protect_school_website_content_version() from public, anon, authenticated;
create trigger protect_school_website_content_version
  before insert or update on public.school_website_content_versions
  for each row execute function public.protect_school_website_content_version();

create or replace function public.can_manage_administrative_domain(
  target_school uuid,
  target_domain text
)
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
      and (
        membership.role::text = 'school_admin'
        or (target_domain = 'transport' and membership.role::text = 'transport_manager')
        or (target_domain = 'facilities' and membership.role::text = 'facilities_manager')
        or (target_domain = 'it_support' and membership.role::text = 'it_support_technician')
        or (target_domain = 'hr' and membership.role::text = 'hr_staff_administrator')
        or (target_domain = 'safeguarding' and membership.role::text = 'safeguarding_officer')
        or (target_domain = 'procurement' and membership.role::text = 'procurement_officer')
        or (target_domain = 'compliance' and membership.role::text = 'compliance_audit_officer')
        or (target_domain = 'website' and membership.role::text in ('website_editor', 'website_publisher'))
      )
  );
$$;

drop policy if exists "School admins manage their school website" on public.school_websites;
create policy "School admins manage their school website"
  on public.school_websites for all to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "Website staff read their website"
  on public.school_websites for select to authenticated
  using (public.can_manage_administrative_domain(school_id, 'website'));

create or replace function public.publish_school_website_content(target_version uuid, publisher_note text default '')
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  version_record public.school_website_content_versions%rowtype;
begin
  if char_length(coalesce(publisher_note, '')) > 1000 then
    raise exception 'Review note must be 1000 characters or fewer.';
  end if;
  select * into version_record
  from public.school_website_content_versions
  where id = target_version
  for update;
  if not found then raise exception 'Website draft not found.'; end if;
  if not exists (
    select 1 from public.school_memberships membership
    where membership.school_id = version_record.school_id
      and membership.profile_id = auth.uid()
      and membership.role::text in ('school_admin', 'website_publisher')
  ) then
    raise exception 'Only a website publisher can publish approved content.';
  end if;
  if version_record.status <> 'pending_review' then
    raise exception 'Only drafts submitted for review can be published.';
  end if;
  update public.school_websites
  set published_content = version_record.content,
      hero_title = coalesce(version_record.content ->> 'hero_title', hero_title),
      hero_message = coalesce(version_record.content ->> 'hero_message', hero_message),
      about_title = coalesce(version_record.content ->> 'about_title', about_title),
      about_text = coalesce(version_record.content ->> 'about_text', about_text),
      admissions_title = coalesce(version_record.content ->> 'admissions_title', admissions_title),
      admissions_text = coalesce(version_record.content ->> 'admissions_text', admissions_text),
      admission_requirements = coalesce(version_record.content ->> 'admission_requirements', admission_requirements),
      updated_by = auth.uid(),
      updated_at = timezone('utc', now())
  where school_id = version_record.school_id;
  if not found then raise exception 'School website is not configured.'; end if;
  update public.school_website_content_versions
  set status = 'published',
      publisher_id = auth.uid(),
      review_note = trim(coalesce(publisher_note, '')),
      updated_at = timezone('utc', now())
  where id = target_version;
end;
$$;
revoke all on function public.publish_school_website_content(uuid, text) from public, anon;
grant execute on function public.publish_school_website_content(uuid, text) to authenticated;

create or replace function public.review_school_website_content(
  target_version uuid,
  approved boolean,
  publisher_note text default ''
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  version_record public.school_website_content_versions%rowtype;
begin
  if char_length(coalesce(publisher_note, '')) > 1000 then
    raise exception 'Review note must be 1000 characters or fewer.';
  end if;
  select * into version_record
  from public.school_website_content_versions
  where id = target_version
  for update;
  if not found or version_record.status <> 'pending_review' then
    raise exception 'A pending website draft was not found.';
  end if;
  if not exists (
    select 1 from public.school_memberships membership
    where membership.school_id = version_record.school_id
      and membership.profile_id = auth.uid()
      and membership.role::text in ('school_admin', 'website_publisher')
  ) then
    raise exception 'Only a website publisher can review drafts.';
  end if;
  update public.school_website_content_versions
  set status = case when approved then 'pending_review' else 'rejected' end,
      publisher_id = auth.uid(),
      review_note = trim(coalesce(publisher_note, '')),
      updated_at = timezone('utc', now())
  where id = target_version;
  if approved then
    perform public.publish_school_website_content(target_version, publisher_note);
  end if;
end;
$$;
revoke all on function public.review_school_website_content(uuid, boolean, text) from public, anon;
grant execute on function public.review_school_website_content(uuid, boolean, text) to authenticated;

create or replace function public.is_admissions_officer(target_school uuid)
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
      and membership.role::text in ('school_admin', 'admissions_officer')
  );
$$;
revoke all on function public.is_admissions_officer(uuid) from public;
grant execute on function public.is_admissions_officer(uuid) to authenticated;

drop policy if exists "School admins read admissions applications" on public.admission_applications;
drop policy if exists "School admins read admissions documents" on public.admission_application_documents;
drop policy if exists "School admins read admissions history" on public.admission_application_history;
create policy "Admissions staff read applications"
  on public.admission_applications for select to authenticated
  using (public.is_admissions_officer(school_id));
create policy "Admissions staff read documents"
  on public.admission_application_documents for select to authenticated
  using (public.is_admissions_officer(school_id));
create policy "Admissions staff read history"
  on public.admission_application_history for select to authenticated
  using (public.is_admissions_officer(school_id));
alter table public.admission_applications
  add column if not exists assigned_to uuid references public.profiles(id) on delete set null;

create or replace function public.assign_admission_application(
  target_application uuid,
  target_assignee uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_school uuid;
begin
  select school_id into target_school
  from public.admission_applications
  where id = target_application
  for update;
  if not found or not public.is_admissions_officer(target_school) then
    raise exception 'Application not found or not authorized.';
  end if;
  if target_assignee is not null and not exists (
    select 1 from public.school_memberships membership
    where membership.school_id = target_school
      and membership.profile_id = target_assignee
      and membership.role::text in ('school_admin', 'admissions_officer')
  ) then
    raise exception 'Assign applications only to an admissions officer or school administrator.';
  end if;
  update public.admission_applications
  set assigned_to = target_assignee,
      updated_at = timezone('utc', now())
  where id = target_application;
  insert into public.admission_application_history (
    school_id, application_id, actor_id, action, from_status, to_status, note
  )
  select application.school_id, application.id, auth.uid(), 'assigned',
    application.status, application.status,
    case when target_assignee is null then 'Application unassigned.'
      else 'Application assigned to ' || target_assignee::text || '.' end
  from public.admission_applications application
  where application.id = target_application;
end;
$$;
revoke all on function public.assign_admission_application(uuid, uuid) from public, anon;
grant execute on function public.assign_admission_application(uuid, uuid) to authenticated;

create or replace function public.review_admission_application(
  target_application uuid,
  next_status text,
  reviewer_note text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  application_record public.admission_applications%rowtype;
begin
  select * into application_record
  from public.admission_applications application
  where application.id = target_application
    and public.is_admissions_officer(application.school_id)
  for update;
  if not found then raise exception 'Application not found or not authorized.'; end if;
  if next_status not in ('under_review', 'accepted', 'rejected', 'waitlisted', 'withdrawn') then
    raise exception 'Choose a valid application status.';
  end if;
  if application_record.status = 'registered' then
    raise exception 'Registered applications cannot be changed.';
  end if;
  if char_length(coalesce(reviewer_note, '')) > 3000 then
    raise exception 'Review notes must be 3000 characters or fewer.';
  end if;
  update public.admission_applications
  set status = next_status,
      decision_note = nullif(trim(reviewer_note), ''),
      reviewed_by = auth.uid(),
      decided_at = case when next_status in ('accepted', 'rejected', 'waitlisted') then timezone('utc', now()) else decided_at end,
      updated_at = timezone('utc', now())
  where id = application_record.id;
end;
$$;

create or replace function public.register_admission_student(
  target_application uuid,
  target_class uuid
)
returns table (student_id uuid, student_number text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  application_record public.admission_applications%rowtype;
  school_prefix text;
  number_format text;
  next_sequence bigint;
  number_width integer;
  number_width_text text;
  generated_number text;
  created_student_id uuid;
begin
  select * into application_record
  from public.admission_applications application
  where application.id = target_application
    and public.is_admissions_officer(application.school_id)
  for update;
  if not found then raise exception 'Application not found or not authorized.'; end if;
  if application_record.status <> 'accepted' then
    raise exception 'Only accepted applicants can be registered as students.';
  end if;
  if application_record.registered_student_id is not null then
    raise exception 'This application has already been registered.';
  end if;
  if not exists (
    select 1 from public.school_classes school_class
    where school_class.school_id = application_record.school_id
      and school_class.id = target_class
  ) then
    raise exception 'Choose a class belonging to this school.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(application_record.school_id::text, 0));
  insert into public.admission_student_number_sequences (school_id, last_value)
  select application_record.school_id, count(*)
  from public.students student
  where student.school_id = application_record.school_id
  on conflict (school_id) do nothing;

  select school.student_id_prefix, school.student_id_format
  into school_prefix, number_format
  from public.schools school
  where school.id = application_record.school_id;

  number_width_text := (regexp_match(number_format, '\{sequence:([0-9]+)d\}'))[1];
  if number_width_text is not null then
    if char_length(number_width_text) > 2 then
      raise exception 'Student ID sequence padding must be between 1 and 10 digits.';
    end if;
    number_width := number_width_text::integer;
    if number_width < 1 or number_width > 10 then
      raise exception 'Student ID sequence padding must be between 1 and 10 digits.';
    end if;
  else
    number_width := 0;
  end if;
  if regexp_count(number_format, '\{sequence(:[0-9]+d)?\}') <> 1
    or regexp_replace(
      regexp_replace(number_format, '\{prefix\}', '', 'g'),
      '\{sequence(:[0-9]+d)?\}', '', 'g'
    ) ~ '[{}]' then
    raise exception 'Configure a student ID format containing {sequence} or {sequence:04d} before registration.';
  end if;
  loop
    update public.admission_student_number_sequences
    set last_value = last_value + 1
    where school_id = application_record.school_id
    returning last_value into next_sequence;
    generated_number := replace(number_format, '{prefix}', coalesce(school_prefix, ''));
    if number_width > 0 then
      generated_number := regexp_replace(
        generated_number, '\{sequence:[0-9]+d\}',
        lpad(next_sequence::text, number_width, '0')
      );
    else
      generated_number := replace(generated_number, '{sequence}', next_sequence::text);
    end if;
    if generated_number !~ '[{}]' and not exists (
      select 1 from public.students student
      where student.school_id = application_record.school_id
        and student.student_number = generated_number
    ) then
      exit;
    end if;
  end loop;
  insert into public.students (
    school_id, class_id, student_number, first_name, last_name, email,
    date_of_birth, status
  ) values (
    application_record.school_id, target_class, generated_number,
    application_record.student_first_name, application_record.student_last_name,
    application_record.student_email, application_record.date_of_birth, 'active'
  )
  returning id into created_student_id;
  insert into public.student_private_profiles (
    school_id, student_id, address, gender, admission_date
  ) values (
    application_record.school_id, created_student_id, application_record.address,
    application_record.gender, current_date
  );
  update public.admission_applications
  set status = 'registered',
      registered_student_id = created_student_id,
      registered_class_id = target_class,
      reviewed_by = auth.uid(),
      updated_at = timezone('utc', now())
  where id = target_application;
  return query select created_student_id, generated_number;
end;
$$;

drop policy if exists "School admins manage staff profiles" on public.staff_profiles;
create policy "School and HR administrators manage staff profiles"
  on public.staff_profiles for all to authenticated
  using (
    public.has_school_role(school_id, array['school_admin']::public.app_role[])
    or exists (
      select 1 from public.school_memberships membership
      where membership.school_id = staff_profiles.school_id
        and membership.profile_id = auth.uid()
        and membership.role::text = 'hr_staff_administrator'
    )
  )
  with check (
    public.has_school_role(school_id, array['school_admin']::public.app_role[])
    or exists (
      select 1 from public.school_memberships membership
      where membership.school_id = staff_profiles.school_id
        and membership.profile_id = auth.uid()
        and membership.role::text = 'hr_staff_administrator'
    )
  );
create policy "HR administrators read teacher profiles"
  on public.teacher_profiles for select to authenticated
  using (
    exists (
      select 1 from public.school_memberships membership
      where membership.school_id = teacher_profiles.school_id
        and membership.profile_id = auth.uid()
        and membership.role::text = 'hr_staff_administrator'
    )
  );
drop policy if exists "School admins read staff document metadata" on public.staff_documents;
drop policy if exists "School admins manage staff document metadata" on public.staff_documents;
create policy "School and HR administrators read staff document metadata"
  on public.staff_documents for select to authenticated
  using (
    public.has_school_role(school_id, array['school_admin']::public.app_role[])
    or exists (
      select 1 from public.school_memberships membership
      where membership.school_id = staff_documents.school_id
        and membership.profile_id = auth.uid()
        and membership.role::text = 'hr_staff_administrator'
    )
  );
create policy "School and HR administrators manage staff document metadata"
  on public.staff_documents for all to authenticated
  using (
    public.has_school_role(school_id, array['school_admin']::public.app_role[])
    or exists (
      select 1 from public.school_memberships membership
      where membership.school_id = staff_documents.school_id
        and membership.profile_id = auth.uid()
        and membership.role::text = 'hr_staff_administrator'
    )
  )
  with check (
    uploaded_by = auth.uid()
    and (
      public.has_school_role(school_id, array['school_admin']::public.app_role[])
      or exists (
        select 1 from public.school_memberships membership
        where membership.school_id = staff_documents.school_id
          and membership.profile_id = auth.uid()
          and membership.role::text = 'hr_staff_administrator'
      )
    )
  );

drop policy if exists "Admins and auditors read audit logs" on public.audit_logs;
create policy "Admins auditors and compliance officers read audit logs"
  on public.audit_logs for select to authenticated
  using (
    public.has_school_role(school_id, array['school_admin']::public.app_role[])
    or public.is_school_auditor(school_id)
    or exists (
      select 1 from public.school_memberships membership
      where membership.school_id = audit_logs.school_id
        and membership.profile_id = auth.uid()
        and membership.role::text = 'compliance_audit_officer'
    )
  );

drop policy if exists "School admins read staff document files" on storage.objects;
drop policy if exists "School admins upload staff document files" on storage.objects;
drop policy if exists "School admins update staff document files" on storage.objects;
drop policy if exists "School admins delete staff document files" on storage.objects;
create policy "School and HR administrators read staff document files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'staff-documents'
    and exists (
      select 1 from public.school_memberships membership
      where membership.profile_id = auth.uid()
        and membership.school_id::text = (storage.foldername(name))[1]
        and membership.role::text in ('school_admin', 'hr_staff_administrator')
    )
  );
create policy "School and HR administrators upload staff document files"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'staff-documents'
    and exists (
      select 1 from public.school_memberships membership
      where membership.profile_id = auth.uid()
        and membership.school_id::text = (storage.foldername(name))[1]
        and membership.role::text in ('school_admin', 'hr_staff_administrator')
    )
  );
create policy "School and HR administrators update staff document files"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'staff-documents'
    and exists (
      select 1 from public.school_memberships membership
      where membership.profile_id = auth.uid()
        and membership.school_id::text = (storage.foldername(name))[1]
        and membership.role::text in ('school_admin', 'hr_staff_administrator')
    )
  )
  with check (
    bucket_id = 'staff-documents'
    and exists (
      select 1 from public.school_memberships membership
      where membership.profile_id = auth.uid()
        and membership.school_id::text = (storage.foldername(name))[1]
        and membership.role::text in ('school_admin', 'hr_staff_administrator')
    )
  );
create policy "School and HR administrators delete staff document files"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'staff-documents'
    and exists (
      select 1 from public.school_memberships membership
      where membership.profile_id = auth.uid()
        and membership.school_id::text = (storage.foldername(name))[1]
        and membership.role::text in ('school_admin', 'hr_staff_administrator')
    )
  );

create or replace function public.can_read_admission_document(
  folder_school text,
  folder_application text,
  object_path text
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  parsed_school uuid;
  parsed_application uuid;
begin
  if folder_school !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or folder_application !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  parsed_school := folder_school::uuid;
  parsed_application := folder_application::uuid;
  return public.is_admissions_officer(parsed_school)
    and exists (
      select 1 from public.admission_application_documents document
      where document.school_id = parsed_school
        and document.application_id = parsed_application
        and document.storage_path = object_path
        and object_path like folder_school || '/' || folder_application || '/%'
    );
end;
$$;
revoke all on function public.can_read_admission_document(text, text, text) from public, anon;
grant execute on function public.can_read_admission_document(text, text, text) to authenticated;

revoke all on function public.record_administrative_work_item_event() from public, anon, authenticated;
