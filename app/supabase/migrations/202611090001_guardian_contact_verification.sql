create table public.guardian_contact_verifications (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  parent_id uuid not null,
  contact_channel text not null check (contact_channel in ('email', 'phone')),
  status text not null check (status in ('unverified', 'verified', 'invalid')),
  checked_value text,
  verification_method text check (
    verification_method is null
    or verification_method in ('phone_call', 'email_reply', 'in_person', 'document_review')
  ),
  verified_at timestamptz,
  verified_by uuid references public.profiles(id),
  note text not null default '' check (char_length(note) <= 500),
  updated_at timestamptz not null default timezone('utc', now()),
  updated_by uuid references public.profiles(id),
  unique (school_id, parent_id, contact_channel),
  foreign key (school_id, parent_id)
    references public.parent_profiles(school_id, id) on delete cascade,
  check (
    (status = 'unverified' and checked_value is null and verified_at is null and verified_by is null)
    or (status = 'verified' and checked_value is not null and verification_method is not null and verified_at is not null and verified_by is not null)
    or (status = 'invalid' and checked_value is not null and verification_method is not null and verified_at is null and verified_by is null)
  )
);

create table public.guardian_contact_verification_events (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools(id) on delete cascade,
  parent_id uuid not null,
  contact_channel text not null check (contact_channel in ('email', 'phone')),
  status text not null check (status in ('unverified', 'verified', 'invalid')),
  checked_value text,
  verification_method text,
  note text not null default '' check (char_length(note) <= 500),
  checked_by uuid references public.profiles(id) on delete set null,
  checked_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, parent_id)
    references public.parent_profiles(school_id, id) on delete cascade
);
create index guardian_contact_verification_events_parent_idx
  on public.guardian_contact_verification_events(school_id, parent_id, contact_channel, checked_at desc);

alter table public.guardian_contact_verifications enable row level security;
alter table public.guardian_contact_verification_events enable row level security;
revoke all on public.guardian_contact_verifications, public.guardian_contact_verification_events
  from public, anon, authenticated;

create policy "School admins read guardian contact verification"
  on public.guardian_contact_verifications for select to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "School admins read guardian contact verification events"
  on public.guardian_contact_verification_events for select to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
grant select on public.guardian_contact_verifications, public.guardian_contact_verification_events to authenticated;

create or replace function public.record_guardian_contact_verification(
  target_parent uuid,
  contact_channel text,
  next_status text,
  verification_method text,
  verification_note text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_school uuid;
  contact_value text;
  normalized_value text;
begin
  if contact_channel not in ('email', 'phone')
    or next_status not in ('unverified', 'verified', 'invalid')
    or char_length(coalesce(verification_note, '')) > 500 then
    raise exception 'Choose a valid contact channel and verification status.';
  end if;

  select parent.school_id,
    case
      when contact_channel = 'email' then nullif(lower(trim(parent.email)), '')
      else nullif(regexp_replace(trim(parent.phone), '\s+', '', 'g'), '')
    end
  into target_school, contact_value
  from public.parent_profiles parent
  where parent.id = target_parent;
  if target_school is null or not public.has_school_role(target_school, array['school_admin']::public.app_role[]) then
    raise exception 'Guardian not found or school administrator authorization is required.';
  end if;
  if next_status <> 'unverified' and contact_value is null then
    raise exception 'A contact value is required before it can be verified.';
  end if;
  if next_status <> 'unverified'
    and verification_method not in ('phone_call', 'email_reply', 'in_person', 'document_review') then
    raise exception 'Select how the contact was checked.';
  end if;
  normalized_value := case when next_status = 'unverified' then null else contact_value end;

  insert into public.guardian_contact_verifications(
    school_id, parent_id, contact_channel, status, checked_value, verification_method,
    verified_at, verified_by, note, updated_at, updated_by
  ) values (
    target_school, target_parent, contact_channel, next_status, normalized_value,
    case when next_status = 'unverified' then null else verification_method end,
    case when next_status = 'verified' then timezone('utc', now()) else null end,
    case when next_status = 'verified' then auth.uid() else null end,
    trim(coalesce(verification_note, '')), timezone('utc', now()), auth.uid()
  )
  on conflict (school_id, parent_id, contact_channel) do update set
    status = excluded.status,
    checked_value = excluded.checked_value,
    verification_method = excluded.verification_method,
    verified_at = excluded.verified_at,
    verified_by = excluded.verified_by,
    note = excluded.note,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by;

  insert into public.guardian_contact_verification_events(
    school_id, parent_id, contact_channel, status, checked_value, verification_method,
    note, checked_by
  ) values (
    target_school, target_parent, contact_channel, next_status, normalized_value,
    case when next_status = 'unverified' then null else verification_method end,
    trim(coalesce(verification_note, '')), auth.uid()
  );
end;
$$;

revoke all on function public.record_guardian_contact_verification(uuid, text, text, text, text)
  from public, anon;
grant execute on function public.record_guardian_contact_verification(uuid, text, text, text, text)
  to authenticated;
