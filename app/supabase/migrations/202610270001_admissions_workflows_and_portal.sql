create table public.admission_school_settings (
  school_id uuid primary key references public.schools(id) on delete cascade,
  application_fields jsonb not null default '[]'::jsonb check (jsonb_typeof(application_fields) = 'array'),
  required_documents jsonb not null default '[]'::jsonb check (jsonb_typeof(required_documents) = 'array'),
  appointments_enabled boolean not null default false,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default timezone('utc', now())
);

insert into public.admission_school_settings(school_id)
select id from public.schools
on conflict (school_id) do nothing;

alter table public.admission_applications
  add column if not exists custom_fields jsonb not null default '{}'::jsonb
    check (jsonb_typeof(custom_fields) = 'object'),
  add column if not exists workflow_stage_id uuid;

create table public.admission_workflow_stages (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  stage_key text not null check (stage_key ~ '^[a-z0-9_]{2,40}$'),
  label text not null check (char_length(trim(label)) between 2 and 80),
  status text not null check (status in ('submitted', 'under_review', 'accepted', 'rejected', 'waitlisted', 'withdrawn', 'registered')),
  sort_order integer not null default 0,
  required_role text not null default 'admissions_officer'
    check (required_role in ('school_admin', 'admissions_officer')),
  approval_required boolean not null default false,
  active boolean not null default true,
  unique (school_id, id),
  unique (school_id, stage_key)
);

insert into public.admission_workflow_stages(school_id, stage_key, label, status, sort_order, required_role, approval_required)
select school.id, stage.stage_key, stage.label, stage.status, stage.sort_order, stage.required_role, stage.approval_required
from public.schools school
cross join (values
  ('submitted', 'Submitted', 'submitted', 10, 'admissions_officer', false),
  ('under_review', 'Under review', 'under_review', 20, 'admissions_officer', false),
  ('waitlisted', 'Waitlisted', 'waitlisted', 30, 'admissions_officer', true),
  ('accepted', 'Accepted', 'accepted', 40, 'school_admin', true),
  ('rejected', 'Rejected', 'rejected', 50, 'school_admin', true),
  ('withdrawn', 'Withdrawn', 'withdrawn', 60, 'admissions_officer', false),
  ('registered', 'Registered', 'registered', 70, 'school_admin', true)
) as stage(stage_key, label, status, sort_order, required_role, approval_required)
on conflict (school_id, stage_key) do nothing;

update public.admission_applications application
set workflow_stage_id = stage.id
from public.admission_workflow_stages stage
where stage.school_id = application.school_id
  and stage.status = application.status
  and stage.stage_key = application.status
  and application.workflow_stage_id is null;

alter table public.admission_applications
  add constraint admission_applications_stage_fk
  foreign key (school_id, workflow_stage_id)
  references public.admission_workflow_stages(school_id, id);

create table public.admission_document_checklist (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  application_id uuid not null,
  document_key text not null,
  label text not null check (char_length(trim(label)) between 2 and 120),
  status text not null default 'pending' check (status in ('pending', 'received', 'waived')),
  note text not null default '' check (char_length(note) <= 500),
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, application_id, document_key),
  foreign key (school_id, application_id)
    references public.admission_applications(school_id, id) on delete cascade
);

create table public.admission_application_drafts (
  school_id uuid not null references public.schools(id) on delete cascade,
  token_hash text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  expires_at timestamptz not null default (timezone('utc', now()) + interval '30 days'),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (school_id, token_hash)
);

create table public.admission_enquiries (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  guardian_name text not null check (char_length(trim(guardian_name)) between 2 and 160),
  guardian_email text not null check (char_length(trim(guardian_email)) between 3 and 254),
  guardian_phone text not null default '' check (char_length(guardian_phone) <= 40),
  student_name text not null check (char_length(trim(student_name)) between 2 and 160),
  applying_for text not null default '' check (char_length(applying_for) <= 100),
  message text not null check (char_length(trim(message)) between 2 and 2000),
  status text not null default 'new' check (status in ('new', 'contacted', 'converted', 'closed')),
  application_id uuid,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, application_id)
    references public.admission_applications(school_id, id) on delete set null (application_id)
);
create index admission_enquiries_school_created_idx
  on public.admission_enquiries(school_id, status, created_at desc);

create table public.admission_appointment_slots (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  slot_type text not null default 'appointment' check (slot_type in ('appointment', 'open_day')),
  title text not null check (char_length(trim(title)) between 2 and 120),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  capacity integer not null default 1 check (capacity between 1 and 500),
  location text not null default '' check (char_length(location) <= 240),
  active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  check (ends_at > starts_at),
  unique (school_id, id)
);

create table public.admission_appointment_bookings (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  slot_id uuid not null,
  guardian_name text not null check (char_length(trim(guardian_name)) between 2 and 160),
  guardian_email text not null check (char_length(trim(guardian_email)) between 3 and 254),
  guardian_phone text not null default '' check (char_length(guardian_phone) <= 40),
  student_name text not null check (char_length(trim(student_name)) between 2 and 160),
  note text not null default '' check (char_length(note) <= 1000),
  status text not null default 'booked' check (status in ('booked', 'cancelled', 'attended', 'no_show')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, slot_id)
    references public.admission_appointment_slots(school_id, id) on delete cascade
);
create index admission_appointment_bookings_slot_idx
  on public.admission_appointment_bookings(school_id, slot_id, status);

alter table public.admission_school_settings enable row level security;
alter table public.admission_workflow_stages enable row level security;
alter table public.admission_document_checklist enable row level security;
alter table public.admission_application_drafts enable row level security;
alter table public.admission_enquiries enable row level security;
alter table public.admission_appointment_slots enable row level security;
alter table public.admission_appointment_bookings enable row level security;

revoke all on public.admission_school_settings, public.admission_workflow_stages,
  public.admission_document_checklist, public.admission_application_drafts,
  public.admission_enquiries, public.admission_appointment_slots,
  public.admission_appointment_bookings from anon, authenticated;

create policy "Admissions staff read admissions configuration"
  on public.admission_school_settings for select to authenticated
  using (public.is_admissions_officer(school_id));
create policy "School admins manage admissions configuration"
  on public.admission_school_settings for all to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "Admissions staff read workflow stages"
  on public.admission_workflow_stages for select to authenticated
  using (public.is_admissions_officer(school_id));
create policy "School admins manage workflow stages"
  on public.admission_workflow_stages for all to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "Admissions staff manage document checklist"
  on public.admission_document_checklist for all to authenticated
  using (public.is_admissions_officer(school_id))
  with check (public.is_admissions_officer(school_id));
create policy "Admissions staff manage enquiries"
  on public.admission_enquiries for all to authenticated
  using (public.is_admissions_officer(school_id))
  with check (public.is_admissions_officer(school_id));
create policy "Admissions staff manage appointment slots"
  on public.admission_appointment_slots for all to authenticated
  using (public.is_admissions_officer(school_id))
  with check (public.is_admissions_officer(school_id));
create policy "Admissions staff manage appointment bookings"
  on public.admission_appointment_bookings for all to authenticated
  using (public.is_admissions_officer(school_id))
  with check (public.is_admissions_officer(school_id));

grant select on public.admission_school_settings, public.admission_workflow_stages,
  public.admission_document_checklist, public.admission_enquiries,
  public.admission_appointment_slots, public.admission_appointment_bookings to authenticated;
revoke insert, update, delete on public.admission_school_settings, public.admission_workflow_stages,
  public.admission_document_checklist, public.admission_enquiries,
  public.admission_appointment_slots, public.admission_appointment_bookings from authenticated;

create or replace function public.get_public_admission_configuration(target_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'application_fields', coalesce(settings.application_fields, '[]'::jsonb),
    'required_documents', coalesce(settings.required_documents, '[]'::jsonb),
    'appointments_enabled', coalesce(settings.appointments_enabled, false),
    'appointment_slots', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', slot.id, 'slot_type', slot.slot_type, 'title', slot.title,
        'starts_at', slot.starts_at, 'ends_at', slot.ends_at,
        'location', slot.location, 'remaining', slot.capacity - (
          select count(*) from public.admission_appointment_bookings booking
          where booking.school_id = slot.school_id and booking.slot_id = slot.id
            and booking.status = 'booked'
        )
      ) order by slot.starts_at)
      from public.admission_appointment_slots slot
      where slot.school_id = website.school_id and slot.active and slot.starts_at > now()
        and slot.capacity > (
          select count(*) from public.admission_appointment_bookings booking
          where booking.school_id = slot.school_id and booking.slot_id = slot.id
            and booking.status = 'booked'
        )
    ), '[]'::jsonb)
  )
  from public.school_websites website
  left join public.admission_school_settings settings on settings.school_id = website.school_id
  where website.slug = lower(trim(target_slug)) and website.enabled
    and website.admissions_open and website.admissions_applications_enabled;
$$;

create or replace function public.save_admission_configuration(
  target_school uuid,
  fields jsonb,
  required_documents jsonb,
  appointments_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_school_role(target_school, array['school_admin']::public.app_role[])
    or not public.school_mfa_satisfied(target_school) then
    raise exception 'A school administrator who satisfies the school MFA policy is required.';
  end if;
  if jsonb_typeof(fields) is distinct from 'array'
    or jsonb_typeof(required_documents) is distinct from 'array'
    or appointments_enabled is null then
    raise exception 'Provide valid application fields, document requirements, and appointment settings.';
  end if;
  if jsonb_array_length(fields) > 30 or jsonb_array_length(required_documents) > 30 then
    raise exception 'Provide no more than thirty application fields or required documents.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(fields) field
    where jsonb_typeof(field) is distinct from 'object'
      or coalesce(field ->> 'key', '') !~ '^[a-z][a-z0-9_]{1,39}$'
      or char_length(trim(coalesce(field ->> 'label', ''))) not between 2 and 100
      or coalesce(field ->> 'type', '') not in ('text', 'email', 'tel', 'date', 'select', 'textarea')
      or coalesce(field ->> 'required', '') not in ('true', 'false')
      or (field ->> 'type' = 'select' and (
        jsonb_typeof(field -> 'options') is distinct from 'array'
        or jsonb_array_length(field -> 'options') not between 1 and 20
      ))
  ) then raise exception 'One or more application fields are invalid.'; end if;
  if (select count(distinct field ->> 'key') from jsonb_array_elements(fields) field) <> jsonb_array_length(fields) then
    raise exception 'Application field keys must be unique.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(required_documents) document
    where jsonb_typeof(document) is distinct from 'object'
      or coalesce(document ->> 'key', '') !~ '^[a-z][a-z0-9_]{1,39}$'
      or char_length(trim(coalesce(document ->> 'label', ''))) not between 2 and 120
  ) then raise exception 'One or more required document labels are invalid.'; end if;
  if (select count(distinct document ->> 'key') from jsonb_array_elements(required_documents) document) <> jsonb_array_length(required_documents) then
    raise exception 'Required document keys must be unique.';
  end if;
  insert into public.admission_school_settings(
    school_id, application_fields, required_documents, appointments_enabled, updated_by, updated_at
  ) values (target_school, fields, required_documents, appointments_enabled, auth.uid(), timezone('utc', now()))
  on conflict (school_id) do update set
    application_fields = excluded.application_fields,
    required_documents = excluded.required_documents,
    appointments_enabled = excluded.appointments_enabled,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;
end;
$$;

create or replace function public.save_admission_workflow_stages(target_school uuid, stage_config jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  stage jsonb;
  stage_id uuid;
begin
  if not public.has_school_role(target_school, array['school_admin']::public.app_role[])
    or not public.school_mfa_satisfied(target_school) then
    raise exception 'A school administrator who satisfies the school MFA policy is required.';
  end if;
  if jsonb_typeof(stage_config) is distinct from 'array' then
    raise exception 'Provide between one and thirty workflow stages.';
  end if;
  if jsonb_array_length(stage_config) not between 1 and 30 then
    raise exception 'Provide between one and thirty workflow stages.';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(stage_config) configured_stage
    where coalesce((configured_stage ->> 'active')::boolean, false)
  ) then
    raise exception 'At least one admissions workflow stage must remain active.';
  end if;
  for stage in select value from jsonb_array_elements(stage_config)
  loop
    if jsonb_typeof(stage) is distinct from 'object'
      or char_length(trim(coalesce(stage ->> 'label', ''))) not between 2 and 80
      or coalesce(stage ->> 'stage_key', '') !~ '^[a-z0-9_]{2,40}$'
      or coalesce(stage ->> 'status', '') not in ('submitted', 'under_review', 'accepted', 'rejected', 'waitlisted', 'withdrawn', 'registered')
      or coalesce(stage ->> 'required_role', '') not in ('school_admin', 'admissions_officer')
      or coalesce(stage ->> 'approval_required', '') not in ('true', 'false')
      or coalesce(stage ->> 'active', '') not in ('true', 'false') then
      raise exception 'One or more workflow stages are invalid.';
    end if;
    stage_id := nullif(stage ->> 'id', '')::uuid;
    if stage_id is null then
      insert into public.admission_workflow_stages(
        school_id, stage_key, label, status, sort_order, required_role, approval_required, active
      ) values (
        target_school, stage ->> 'stage_key', trim(stage ->> 'label'), stage ->> 'status',
        (stage ->> 'sort_order')::integer, stage ->> 'required_role',
        (stage ->> 'approval_required')::boolean, (stage ->> 'active')::boolean
      );
    else
      update public.admission_workflow_stages
      set label = trim(stage ->> 'label'),
          status = stage ->> 'status',
          sort_order = (stage ->> 'sort_order')::integer,
          required_role = stage ->> 'required_role',
          approval_required = (stage ->> 'approval_required')::boolean,
          active = (stage ->> 'active')::boolean
      where id = stage_id and school_id = target_school;
      if not found then raise exception 'A workflow stage was not found for this school.'; end if;
    end if;
  end loop;
end;
$$;

create or replace function public.save_public_admission_draft(
  target_slug text,
  resume_token text,
  draft_payload jsonb
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_school uuid;
  token_digest text;
  expiry timestamptz;
begin
  select website.school_id into target_school
  from public.school_websites website
  where website.slug = lower(trim(target_slug)) and website.enabled
    and website.admissions_open and website.admissions_applications_enabled
    and (website.admissions_deadline is null or website.admissions_deadline >= current_date);
  if target_school is null then raise exception 'Online applications are not currently available.'; end if;
  if resume_token is null or char_length(resume_token) not between 40 and 160
    or jsonb_typeof(draft_payload) is distinct from 'object' or pg_column_size(draft_payload) > 32768 then
    raise exception 'Provide a valid resume token and application draft.';
  end if;
  token_digest := encode(extensions.digest(convert_to(resume_token, 'UTF8'), 'sha256'), 'hex');
  expiry := timezone('utc', now()) + interval '30 days';
  insert into public.admission_application_drafts(school_id, token_hash, payload, expires_at, updated_at)
  values (target_school, token_digest, draft_payload, expiry, timezone('utc', now()))
  on conflict (school_id, token_hash) do update
  set payload = excluded.payload, expires_at = excluded.expires_at, updated_at = excluded.updated_at;
  return expiry;
end;
$$;

create or replace function public.get_public_admission_draft(target_slug text, resume_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  target_school uuid;
  draft_payload jsonb;
begin
  select website.school_id into target_school
  from public.school_websites website
  where website.slug = lower(trim(target_slug)) and website.enabled
    and website.admissions_open and website.admissions_applications_enabled;
  if target_school is null or resume_token is null or char_length(resume_token) not between 40 and 160 then
    return null;
  end if;
  select draft.payload into draft_payload
  from public.admission_application_drafts draft
  where draft.school_id = target_school
    and draft.token_hash = encode(extensions.digest(convert_to(resume_token, 'UTF8'), 'sha256'), 'hex')
    and draft.expires_at > timezone('utc', now());
  return draft_payload;
end;
$$;

create or replace function public.submit_public_admission_application_v2(target_slug text, application_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  result jsonb;
  target_school uuid;
  settings public.admission_school_settings%rowtype;
  field_config jsonb;
  field_value text;
  resume_token text;
begin
  if jsonb_typeof(application_payload) is distinct from 'object' then raise exception 'Provide a valid application.'; end if;
  if jsonb_typeof(coalesce(application_payload -> 'custom_fields', '{}'::jsonb)) is distinct from 'object'
    or pg_column_size(application_payload -> 'custom_fields') > 32768 then
    raise exception 'Provide valid additional application details.';
  end if;
  select website.school_id into target_school
  from public.school_websites website
  where website.slug = lower(trim(target_slug)) and website.enabled
    and website.admissions_open and website.admissions_applications_enabled
    and (website.admissions_deadline is null or website.admissions_deadline >= current_date);
  if target_school is null then raise exception 'Online applications are not currently available.'; end if;
  select * into settings from public.admission_school_settings where school_id = target_school;
  for field_config in select value from jsonb_array_elements(coalesce(settings.application_fields, '[]'::jsonb))
  loop
    field_value := application_payload -> 'custom_fields' ->> (field_config ->> 'key');
    if coalesce((field_config ->> 'required')::boolean, false) and coalesce(trim(field_value), '') = '' then
      raise exception '% is required.', field_config ->> 'label';
    end if;
    if field_value is not null and char_length(field_value) > 2000 then
      raise exception '% is too long.', field_config ->> 'label';
    end if;
    if field_value is not null and field_config ->> 'type' = 'select'
      and not exists (
        select 1 from jsonb_array_elements_text(field_config -> 'options') option_value
        where option_value = field_value
      ) then
      raise exception 'Choose a valid option for %.', field_config ->> 'label';
    end if;
  end loop;

  result := public.submit_public_admission_application(
    target_slug,
    application_payload ->> 'student_first_name',
    application_payload ->> 'student_last_name',
    nullif(application_payload ->> 'date_of_birth', '')::date,
    application_payload ->> 'gender',
    application_payload ->> 'applying_for',
    application_payload ->> 'academic_year',
    application_payload ->> 'previous_school',
    application_payload ->> 'student_email',
    application_payload ->> 'student_phone',
    application_payload ->> 'address',
    application_payload ->> 'guardian_name',
    application_payload ->> 'guardian_relationship',
    application_payload ->> 'guardian_email',
    application_payload ->> 'guardian_phone',
    application_payload ->> 'notes'
  );
  update public.admission_applications
  set custom_fields = coalesce(application_payload -> 'custom_fields', '{}'::jsonb),
      workflow_stage_id = (
        select stage.id from public.admission_workflow_stages stage
        where stage.school_id = target_school and stage.status = 'submitted' and stage.active
        order by stage.sort_order limit 1
      )
  where id = (result ->> 'id')::uuid and school_id = target_school;

  insert into public.admission_document_checklist(school_id, application_id, document_key, label)
  select target_school, (result ->> 'id')::uuid, document ->> 'key', document ->> 'label'
  from jsonb_array_elements(coalesce(settings.required_documents, '[]'::jsonb)) document
  on conflict (school_id, application_id, document_key) do nothing;

  resume_token := application_payload ->> 'resume_token';
  if resume_token is not null and char_length(resume_token) between 40 and 160 then
    delete from public.admission_application_drafts
    where school_id = target_school
      and token_hash = encode(extensions.digest(convert_to(resume_token, 'UTF8'), 'sha256'), 'hex');
  end if;
  return result;
end;
$$;

create or replace function public.create_admission_application(application_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_school uuid;
  application_id uuid;
  reference text;
  status_value text := coalesce(application_payload ->> 'status', 'submitted');
  requested_stage uuid;
  requested_assignee uuid;
begin
  if jsonb_typeof(application_payload) is distinct from 'object'
    or pg_column_size(application_payload) > 32768
    or jsonb_typeof(coalesce(application_payload -> 'custom_fields', '{}'::jsonb)) is distinct from 'object' then
    raise exception 'Provide a valid application record.';
  end if;
  target_school := nullif(application_payload ->> 'school_id', '')::uuid;
  if target_school is null or not public.is_admissions_officer(target_school) then
    raise exception 'Admissions staff access is required.';
  end if;
  if status_value not in ('submitted', 'under_review', 'accepted', 'rejected', 'waitlisted') then
    raise exception 'Choose a valid initial application status.';
  end if;
  if char_length(trim(coalesce(application_payload ->> 'student_first_name', ''))) not between 1 and 80
    or char_length(trim(coalesce(application_payload ->> 'student_last_name', ''))) not between 1 and 80
    or char_length(trim(coalesce(application_payload ->> 'applying_for', ''))) not between 1 and 100
    or char_length(trim(coalesce(application_payload ->> 'guardian_name', ''))) not between 2 and 160
    or char_length(trim(coalesce(application_payload ->> 'guardian_relationship', ''))) not between 1 and 60
    or char_length(trim(coalesce(application_payload ->> 'guardian_email', ''))) not between 3 and 254
    or char_length(trim(coalesce(application_payload ->> 'guardian_phone', ''))) not between 5 and 40 then
    raise exception 'Complete the required applicant and guardian details.';
  end if;
  requested_assignee := nullif(application_payload ->> 'assigned_to', '')::uuid;
  if requested_assignee is not null and not exists (
    select 1 from public.school_memberships membership
    where membership.school_id = target_school
      and membership.profile_id = requested_assignee
      and membership.role in ('school_admin', 'admissions_officer')
  ) then
    raise exception 'The assigned staff member must belong to this school admissions team.';
  end if;
  reference := 'ADM-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  select id into requested_stage from public.admission_workflow_stages
  where school_id = target_school and status = status_value and active order by sort_order limit 1;
  insert into public.admission_applications(
    school_id, application_reference, source, status, workflow_stage_id,
    student_first_name, student_last_name, date_of_birth, gender, applying_for, academic_year,
    previous_school, student_email, student_phone, address, guardian_name, guardian_relationship,
    guardian_email, guardian_phone, notes, custom_fields, assigned_to
  ) values (
    target_school, reference, 'school_admin', status_value, requested_stage,
    trim(application_payload ->> 'student_first_name'), trim(application_payload ->> 'student_last_name'),
    nullif(application_payload ->> 'date_of_birth', '')::date,
    nullif(application_payload ->> 'gender', ''),
    trim(application_payload ->> 'applying_for'),
    nullif(application_payload ->> 'academic_year', ''),
    nullif(application_payload ->> 'previous_school', ''),
    nullif(application_payload ->> 'student_email', ''),
    nullif(application_payload ->> 'student_phone', ''),
    nullif(application_payload ->> 'address', ''),
    trim(application_payload ->> 'guardian_name'),
    trim(application_payload ->> 'guardian_relationship'),
    lower(trim(application_payload ->> 'guardian_email')),
    trim(application_payload ->> 'guardian_phone'),
    nullif(application_payload ->> 'notes', ''),
    coalesce(application_payload -> 'custom_fields', '{}'::jsonb),
    requested_assignee
  ) returning id into application_id;
  insert into public.admission_document_checklist(school_id, application_id, document_key, label)
  select target_school, application_id, document ->> 'key', document ->> 'label'
  from public.admission_school_settings settings
  cross join lateral jsonb_array_elements(settings.required_documents) document
  where settings.school_id = target_school
  on conflict (school_id, application_id, document_key) do nothing;
  return application_id;
end;
$$;

create or replace function public.set_admission_document_checklist(
  target_checklist uuid,
  next_status text,
  checklist_note text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_school uuid;
begin
  select school_id into target_school from public.admission_document_checklist where id = target_checklist;
  if target_school is null or not public.is_admissions_officer(target_school) then
    raise exception 'Checklist item not found or not authorized.';
  end if;
  if next_status not in ('pending', 'received', 'waived') or char_length(coalesce(checklist_note, '')) > 500 then
    raise exception 'Choose a valid document status and note.';
  end if;
  update public.admission_document_checklist
  set status = next_status, note = trim(coalesce(checklist_note, '')),
      updated_by = auth.uid(), updated_at = timezone('utc', now())
  where id = target_checklist;
end;
$$;

create or replace function public.move_admission_application_stage(
  target_application uuid,
  target_stage uuid,
  stage_note text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  application_record public.admission_applications%rowtype;
  stage_record public.admission_workflow_stages%rowtype;
  caller_role text;
begin
  select * into application_record from public.admission_applications
  where id = target_application for update;
  if not found or not public.is_admissions_officer(application_record.school_id) then
    raise exception 'Application not found or not authorized.';
  end if;
  select * into stage_record from public.admission_workflow_stages
  where id = target_stage and school_id = application_record.school_id and active;
  if not found then raise exception 'Choose an active admissions stage.'; end if;
  if application_record.status = 'registered' or stage_record.status = 'registered' then
    raise exception 'Student registration must be completed through the registration workflow.';
  end if;
  select role::text into caller_role from public.school_memberships
  where school_id = application_record.school_id and profile_id = auth.uid();
  if stage_record.required_role = 'school_admin' and caller_role <> 'school_admin' then
    raise exception 'A school administrator must approve this stage.';
  end if;
  if stage_record.approval_required and not public.school_permission_allowed(application_record.school_id, 'admissions', 'approve') then
    raise exception 'Your admissions role does not have approval permission.';
  end if;
  if char_length(coalesce(stage_note, '')) > 3000 then raise exception 'Stage notes must be 3000 characters or fewer.'; end if;
  update public.admission_applications
  set workflow_stage_id = stage_record.id,
      status = stage_record.status,
      decision_note = case when nullif(trim(stage_note), '') is null then decision_note else trim(stage_note) end,
      reviewed_by = auth.uid(),
      decided_at = case when stage_record.status in ('accepted', 'rejected', 'waitlisted') then timezone('utc', now()) else decided_at end,
      updated_at = timezone('utc', now())
  where id = target_application;
  if application_record.status = stage_record.status then
    insert into public.admission_application_history(
      school_id, application_id, actor_id, action, from_status, to_status, note
    ) values (
      application_record.school_id, target_application, auth.uid(), 'stage_transition',
      application_record.status, stage_record.status,
      coalesce(nullif(trim(stage_note), ''), stage_record.label)
    );
  end if;
end;
$$;

create or replace function public.submit_public_admission_enquiry(
  target_slug text,
  guardian_name text,
  guardian_email text,
  guardian_phone text,
  student_name text,
  applying_for text,
  enquiry_message text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_school uuid;
  enquiry_id uuid;
begin
  select website.school_id into target_school
  from public.school_websites website
  where website.slug = lower(trim(target_slug)) and website.enabled
    and website.admissions_email is not null;
  if target_school is null then raise exception 'Admissions enquiries are not available for this school.'; end if;
  if char_length(trim(coalesce(guardian_name, ''))) not between 2 and 160
    or char_length(trim(coalesce(guardian_email, ''))) not between 3 and 254
    or char_length(trim(coalesce(student_name, ''))) not between 2 and 160
    or char_length(trim(coalesce(enquiry_message, ''))) not between 2 and 2000
    or char_length(coalesce(guardian_phone, '')) > 40
    or char_length(coalesce(applying_for, '')) > 100 then
    raise exception 'Complete the required enquiry contact details and message.';
  end if;
  insert into public.admission_enquiries(
    school_id, guardian_name, guardian_email, guardian_phone, student_name, applying_for, message
  ) values (
    target_school, trim(guardian_name), lower(trim(guardian_email)), trim(coalesce(guardian_phone, '')),
    trim(student_name), trim(coalesce(applying_for, '')), trim(enquiry_message)
  ) returning id into enquiry_id;
  return enquiry_id;
end;
$$;

create or replace function public.convert_admission_enquiry(target_enquiry uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  enquiry public.admission_enquiries%rowtype;
  created_application_id uuid;
  names text[];
begin
  select * into enquiry from public.admission_enquiries where id = target_enquiry for update;
  if not found or not public.is_admissions_officer(enquiry.school_id) then
    raise exception 'Enquiry not found or not authorized.';
  end if;
  if enquiry.status = 'converted' then raise exception 'This enquiry has already been converted.'; end if;
  names := regexp_split_to_array(trim(enquiry.student_name), '\s+');
  created_application_id := public.create_admission_application(jsonb_build_object(
    'school_id', enquiry.school_id,
    'student_first_name', names[1],
    'student_last_name', case when cardinality(names) > 1 then array_to_string(names[2:], ' ') else names[1] end,
    'applying_for', coalesce(nullif(enquiry.applying_for, ''), 'To be confirmed'),
    'guardian_name', enquiry.guardian_name,
    'guardian_relationship', 'Guardian',
    'guardian_email', enquiry.guardian_email,
    'guardian_phone', case when char_length(enquiry.guardian_phone) >= 5 then enquiry.guardian_phone else 'To be confirmed' end,
    'notes', 'Converted from enquiry: ' || enquiry.message,
    'status', 'submitted'
  ));
  update public.admission_enquiries
  set status = 'converted', application_id = created_application_id, updated_at = timezone('utc', now())
  where id = target_enquiry;
  return created_application_id;
end;
$$;

create or replace function public.get_public_admission_appointment_slots(target_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.get_public_admission_configuration(target_slug) -> 'appointment_slots';
$$;

create or replace function public.book_admission_appointment(
  target_slug text,
  target_slot uuid,
  guardian_name text,
  guardian_email text,
  guardian_phone text,
  student_name text,
  booking_note text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_school uuid;
  slot_record public.admission_appointment_slots%rowtype;
  booking_id uuid;
  booking_count integer;
begin
  select website.school_id into target_school
  from public.school_websites website
  join public.admission_school_settings settings on settings.school_id = website.school_id
  where website.slug = lower(trim(target_slug)) and website.enabled and website.admissions_open
    and website.admissions_applications_enabled and settings.appointments_enabled;
  if target_school is null then raise exception 'Admissions appointment booking is not currently available.'; end if;
  select * into slot_record from public.admission_appointment_slots
  where id = target_slot and school_id = target_school and active and starts_at > now()
  for update;
  if not found then raise exception 'This appointment time is no longer available.'; end if;
  select count(*) into booking_count from public.admission_appointment_bookings
  where school_id = target_school and slot_id = target_slot and status = 'booked';
  if booking_count >= slot_record.capacity then raise exception 'This appointment time is fully booked.'; end if;
  if char_length(trim(coalesce(guardian_name, ''))) not between 2 and 160
    or char_length(trim(coalesce(guardian_email, ''))) not between 3 and 254
    or char_length(trim(coalesce(student_name, ''))) not between 2 and 160
    or char_length(coalesce(guardian_phone, '')) > 40
    or char_length(coalesce(booking_note, '')) > 1000 then
    raise exception 'Complete the required booking details.';
  end if;
  insert into public.admission_appointment_bookings(
    school_id, slot_id, guardian_name, guardian_email, guardian_phone, student_name, note
  ) values (
    target_school, target_slot, trim(guardian_name), lower(trim(guardian_email)),
    trim(coalesce(guardian_phone, '')), trim(student_name), trim(coalesce(booking_note, ''))
  ) returning id into booking_id;
  return booking_id;
end;
$$;

create or replace function public.manage_admission_appointment_slot(
  target_school uuid,
  target_slot uuid,
  slot_type text,
  slot_title text,
  slot_starts_at timestamptz,
  slot_ends_at timestamptz,
  slot_capacity integer,
  slot_location text,
  slot_active boolean
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_slot uuid;
begin
  if not public.is_admissions_officer(target_school) then raise exception 'Admissions staff access is required.'; end if;
  if slot_type not in ('appointment', 'open_day') or slot_starts_at <= now()
    or slot_ends_at <= slot_starts_at or slot_capacity not between 1 and 500
    or char_length(trim(coalesce(slot_title, ''))) not between 2 and 120
    or char_length(coalesce(slot_location, '')) > 240 then
    raise exception 'Provide valid future appointment details and capacity.';
  end if;
  if target_slot is null then
    insert into public.admission_appointment_slots(
      school_id, slot_type, title, starts_at, ends_at, capacity, location, active, created_by
    ) values (
      target_school, slot_type, trim(slot_title), slot_starts_at, slot_ends_at,
      slot_capacity, trim(coalesce(slot_location, '')), coalesce(slot_active, true), auth.uid()
    ) returning id into saved_slot;
  else
    if slot_capacity < (
      select count(*) from public.admission_appointment_bookings
      where school_id = target_school and slot_id = target_slot and status = 'booked'
    ) then
      raise exception 'Capacity cannot be lower than the number of active bookings.';
    end if;
    update public.admission_appointment_slots
    set slot_type = manage_admission_appointment_slot.slot_type,
        title = trim(slot_title), starts_at = slot_starts_at, ends_at = slot_ends_at,
        capacity = slot_capacity, location = trim(coalesce(slot_location, '')),
        active = coalesce(slot_active, true)
    where id = target_slot and school_id = target_school
    returning id into saved_slot;
    if saved_slot is null then raise exception 'Appointment slot not found.'; end if;
  end if;
  return saved_slot;
end;
$$;

create or replace function public.set_admission_appointment_booking_status(target_booking uuid, next_status text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  booking public.admission_appointment_bookings%rowtype;
  capacity integer;
  booked_count integer;
begin
  select * into booking
  from public.admission_appointment_bookings
  where id = target_booking
  for update;
  if not found or not public.is_admissions_officer(booking.school_id) then
    raise exception 'Appointment booking not found or not authorized.';
  end if;
  if next_status not in ('booked', 'cancelled', 'attended', 'no_show') then
    raise exception 'Choose a valid appointment booking status.';
  end if;
  if next_status = 'booked' and booking.status <> 'booked' then
    select slot.capacity into capacity
    from public.admission_appointment_slots slot
    where slot.id = booking.slot_id and slot.school_id = booking.school_id
    for update;
    select count(*) into booked_count
    from public.admission_appointment_bookings other_booking
    where other_booking.slot_id = booking.slot_id and other_booking.school_id = booking.school_id
      and other_booking.status = 'booked';
    if booked_count >= capacity then raise exception 'This appointment time is fully booked.'; end if;
  end if;
  update public.admission_appointment_bookings
  set status = next_status, updated_at = timezone('utc', now())
  where id = target_booking;
end;
$$;

create or replace function public.set_admission_enquiry_status(target_enquiry uuid, next_status text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_school uuid;
begin
  select school_id into target_school from public.admission_enquiries where id = target_enquiry;
  if target_school is null or not public.is_admissions_officer(target_school) then
    raise exception 'Enquiry not found or not authorized.';
  end if;
  if next_status not in ('contacted', 'closed') then raise exception 'Choose a valid enquiry status.'; end if;
  update public.admission_enquiries
  set status = next_status, updated_at = timezone('utc', now())
  where id = target_enquiry and status <> 'converted';
end;
$$;

do $$
declare
  function_signature text;
begin
  for function_signature in select unnest(array[
    'get_public_admission_configuration(text)',
    'save_admission_configuration(uuid,jsonb,jsonb,boolean)',
    'save_public_admission_draft(text,text,jsonb)',
    'get_public_admission_draft(text,text)',
    'submit_public_admission_application_v2(text,jsonb)',
    'save_admission_workflow_stages(uuid,jsonb)',
    'create_admission_application(jsonb)',
    'set_admission_document_checklist(uuid,text,text)',
    'move_admission_application_stage(uuid,uuid,text)',
    'submit_public_admission_enquiry(text,text,text,text,text,text,text)',
    'convert_admission_enquiry(uuid)',
    'get_public_admission_appointment_slots(text)',
    'book_admission_appointment(text,uuid,text,text,text,text,text)',
    'manage_admission_appointment_slot(uuid,uuid,text,text,timestamptz,timestamptz,integer,text,boolean)',
    'set_admission_appointment_booking_status(uuid,text)',
    'set_admission_enquiry_status(uuid,text)'
  ]) loop
    execute format('revoke all on function public.%s from public', function_signature);
  end loop;
end;
$$;

grant execute on function public.get_public_admission_configuration(text) to anon, authenticated;
grant execute on function public.save_admission_configuration(uuid,jsonb,jsonb,boolean) to authenticated;
grant execute on function public.save_public_admission_draft(text,text,jsonb) to anon, authenticated;
grant execute on function public.get_public_admission_draft(text,text) to anon, authenticated;
grant execute on function public.submit_public_admission_application_v2(text,jsonb) to anon, authenticated;
grant execute on function public.save_admission_workflow_stages(uuid,jsonb) to authenticated;
grant execute on function public.create_admission_application(jsonb) to authenticated;
grant execute on function public.set_admission_document_checklist(uuid,text,text) to authenticated;
grant execute on function public.move_admission_application_stage(uuid,uuid,text) to authenticated;
grant execute on function public.submit_public_admission_enquiry(text,text,text,text,text,text,text) to anon, authenticated;
grant execute on function public.convert_admission_enquiry(uuid) to authenticated;
grant execute on function public.get_public_admission_appointment_slots(text) to anon, authenticated;
grant execute on function public.book_admission_appointment(text,uuid,text,text,text,text,text) to anon, authenticated;
grant execute on function public.manage_admission_appointment_slot(uuid,uuid,text,text,timestamptz,timestamptz,integer,text,boolean) to authenticated;
grant execute on function public.set_admission_appointment_booking_status(uuid,text) to authenticated;
grant execute on function public.set_admission_enquiry_status(uuid,text) to authenticated;

notify pgrst, 'reload schema';
