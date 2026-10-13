create table public.student_private_profiles (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null,
  phone text,
  address text,
  city text,
  region text,
  postal_code text,
  country text,
  gender text,
  nationality text,
  admission_date date,
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, student_id),
  foreign key (school_id, student_id) references public.students(school_id, id) on delete cascade
);

create table public.student_emergency_contacts (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null,
  contact_name text not null check (char_length(trim(contact_name)) between 1 and 120),
  relationship text,
  phone text not null check (char_length(trim(phone)) between 1 and 40),
  email text,
  is_primary boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, student_id, is_primary),
  foreign key (school_id, student_id) references public.students(school_id, id) on delete cascade
);

create table public.student_lifecycle_records (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null,
  event_type text not null check (event_type in ('enrollment', 'class_transfer', 'school_transfer', 'withdrawal', 'status_change')),
  event_date date not null default current_date,
  previous_status public.person_status,
  new_status public.person_status,
  previous_class_id uuid,
  new_class_id uuid,
  destination_school text,
  reason text,
  recorded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, student_id) references public.students(school_id, id) on delete cascade,
  foreign key (school_id, previous_class_id) references public.school_classes(school_id, id) on delete set null (previous_class_id),
  foreign key (school_id, new_class_id) references public.school_classes(school_id, id) on delete set null (new_class_id)
);
create index student_lifecycle_records_student_date_idx
  on public.student_lifecycle_records(school_id, student_id, event_date desc, created_at desc);

create table public.student_documents (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null,
  uploaded_by uuid not null references public.profiles(id),
  file_name text not null check (char_length(file_name) between 1 and 200),
  storage_path text not null unique,
  content_type text not null,
  file_size bigint not null check (file_size > 0 and file_size <= 52428800),
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, student_id) references public.students(school_id, id) on delete cascade
);

alter table public.student_private_profiles enable row level security;
alter table public.student_emergency_contacts enable row level security;
alter table public.student_lifecycle_records enable row level security;
alter table public.student_documents enable row level security;

create policy "School admins manage student private profiles"
  on public.student_private_profiles for all to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "School admins manage student emergency contacts"
  on public.student_emergency_contacts for all to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "School admins read student lifecycle records"
  on public.student_lifecycle_records for select to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "School admins manage student documents"
  on public.student_documents for all to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check (
    uploaded_by = auth.uid()
    and public.has_school_role(school_id, array['school_admin']::public.app_role[])
  );

create or replace function public.record_student_lifecycle_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  event_kind text;
begin
  if tg_op = 'INSERT' then
    insert into public.student_lifecycle_records (
      school_id, student_id, event_type, new_status, new_class_id, recorded_by
    ) values (
      new.school_id, new.id, 'enrollment', new.status, new.class_id, auth.uid()
    );
    return new;
  end if;

  if old.status is distinct from new.status then
    event_kind := case new.status
      when 'transferred' then 'school_transfer'
      when 'withdrawn' then 'withdrawal'
      else 'status_change'
    end;
  elsif old.class_id is distinct from new.class_id then
    event_kind := case when old.class_id is null then 'enrollment' else 'class_transfer' end;
  else
    return new;
  end if;

  insert into public.student_lifecycle_records (
    school_id, student_id, event_type, previous_status, new_status,
    previous_class_id, new_class_id, destination_school, reason, recorded_by
  ) values (
    new.school_id,
    new.id,
    event_kind,
    old.status,
    new.status,
    old.class_id,
    new.class_id,
    nullif(current_setting('app.student_destination_school', true), ''),
    nullif(current_setting('app.student_movement_reason', true), ''),
    auth.uid()
  );
  return new;
end;
$$;

create trigger record_student_lifecycle_change
  after insert or update of status, class_id on public.students
  for each row execute function public.record_student_lifecycle_change();

create or replace function public.save_student_record(
  target_school uuid,
  target_student uuid,
  student_data jsonb
)
returns table (student_id uuid, student_number text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_student public.students%rowtype;
  next_sequence bigint;
  number_format text;
  school_prefix text;
  number_width integer := 0;
  width_text text;
  generated_number text;
  movement_reason text := nullif(trim(student_data->>'movement_reason'), '');
  destination text := nullif(trim(student_data->>'destination_school'), '');
  target_status public.person_status;
  previous_status public.person_status;
  is_exit_transition boolean := false;
  target_class uuid := nullif(student_data->>'class_id', '')::uuid;
  contact_index integer;
  contact_name text;
  contact_phone text;
begin
  if not public.has_school_role(target_school, array['school_admin']::public.app_role[]) then
    raise exception 'Only this school’s administrator can manage student records.';
  end if;

  if student_data->>'first_name' is null or char_length(trim(student_data->>'first_name')) not between 1 and 80
    or student_data->>'last_name' is null or char_length(trim(student_data->>'last_name')) not between 1 and 80 then
    raise exception 'Enter a first and last name of 1 to 80 characters.';
  end if;
  target_status := coalesce(nullif(student_data->>'status', '')::public.person_status, 'active');
  if target_student is null and target_status in ('transferred', 'withdrawn') then
    raise exception 'New student records must be created before they can be transferred or withdrawn.';
  end if;
  if target_student is not null then
    select student.status into previous_status
    from public.students student
    where student.id = target_student and student.school_id = target_school;
    if not found then raise exception 'Student not found in this school.'; end if;
    is_exit_transition := previous_status is distinct from target_status
      and target_status in ('transferred', 'withdrawn');
  end if;
  if is_exit_transition and movement_reason is null then
    raise exception 'A reason is required for a transfer or withdrawal.';
  end if;
  if is_exit_transition and target_status = 'transferred' and destination is null then
    raise exception 'Enter the destination school for a transfer.';
  end if;
  if target_class is not null and not exists (
    select 1 from public.school_classes class_record
    where class_record.school_id = target_school and class_record.id = target_class
  ) then
    raise exception 'Choose a class belonging to this school.';
  end if;
  if target_status in ('transferred', 'withdrawn') then
    target_class := null;
  end if;
  if is_exit_transition then
    perform set_config('app.student_movement_reason', coalesce(movement_reason, ''), true);
    perform set_config('app.student_destination_school', coalesce(destination, ''), true);
  end if;

  if target_student is null then
    perform pg_advisory_xact_lock(hashtextextended(target_school::text, 0));
    insert into public.admission_student_number_sequences (school_id, last_value)
    select target_school, count(*) from public.students where school_id = target_school
    on conflict (school_id) do nothing;

    select school.student_id_prefix, school.student_id_format
    into school_prefix, number_format
    from public.schools school where school.id = target_school;

    width_text := (regexp_match(number_format, '\{sequence:([0-9]+)d\}'))[1];
    if width_text is not null then
      if char_length(width_text) > 2 then raise exception 'Student ID padding must be from 1 to 10 digits.'; end if;
      number_width := width_text::integer;
      if number_width not between 1 and 10 then raise exception 'Student ID padding must be from 1 to 10 digits.'; end if;
    end if;
    if regexp_count(number_format, '\{sequence(:[0-9]+d)?\}') <> 1
      or regexp_replace(regexp_replace(number_format, '\{prefix\}', '', 'g'), '\{sequence(:[0-9]+d)?\}', '', 'g') ~ '[{}]' then
      raise exception 'Configure a valid student ID format in School Settings.';
    end if;

    loop
      update public.admission_student_number_sequences
      set last_value = last_value + 1
      where school_id = target_school
      returning last_value into next_sequence;
      generated_number := replace(number_format, '{prefix}', coalesce(school_prefix, ''));
      if number_width > 0 then
        generated_number := regexp_replace(generated_number, '\{sequence:[0-9]+d\}', lpad(next_sequence::text, number_width, '0'));
      else
        generated_number := replace(generated_number, '{sequence}', next_sequence::text);
      end if;
      if generated_number !~ '[{}]' and not exists (
        select 1 from public.students student
        where student.school_id = target_school and student.student_number = generated_number
      ) then exit; end if;
    end loop;

    insert into public.students (
      school_id, student_number, first_name, last_name, email, date_of_birth, class_id, status
    ) values (
      target_school, generated_number, trim(student_data->>'first_name'), trim(student_data->>'last_name'),
      nullif(trim(student_data->>'email'), ''), nullif(student_data->>'date_of_birth', '')::date,
      target_class, target_status
    ) returning * into saved_student;
  else
    update public.students student
    set first_name = trim(student_data->>'first_name'),
        last_name = trim(student_data->>'last_name'),
        email = nullif(trim(student_data->>'email'), ''),
        date_of_birth = nullif(student_data->>'date_of_birth', '')::date,
        class_id = target_class,
        status = target_status,
        updated_at = timezone('utc', now())
    where student.id = target_student and student.school_id = target_school
    returning * into saved_student;
    if not found then raise exception 'Student not found in this school.'; end if;
  end if;

  insert into public.student_private_profiles (
    school_id, student_id, phone, address, city, region, postal_code, country,
    gender, nationality, admission_date, updated_at
  ) values (
    target_school, saved_student.id, nullif(trim(student_data->>'phone'), ''),
    nullif(trim(student_data->>'address'), ''), nullif(trim(student_data->>'city'), ''),
    nullif(trim(student_data->>'region'), ''), nullif(trim(student_data->>'postal_code'), ''),
    nullif(trim(student_data->>'country'), ''), nullif(trim(student_data->>'gender'), ''),
    nullif(trim(student_data->>'nationality'), ''),
    nullif(student_data->>'admission_date', '')::date, timezone('utc', now())
  )
  on conflict (school_id, student_id) do update set
    phone = excluded.phone, address = excluded.address, city = excluded.city,
    region = excluded.region, postal_code = excluded.postal_code, country = excluded.country,
    gender = excluded.gender, nationality = excluded.nationality,
    admission_date = excluded.admission_date, updated_at = excluded.updated_at;

  for contact_index in 1..2 loop
    contact_name := nullif(trim(student_data->>format('emergency_contact_%s_name', contact_index)), '');
    contact_phone := nullif(trim(student_data->>format('emergency_contact_%s_phone', contact_index)), '');
    if contact_name is null then
      delete from public.student_emergency_contacts contact_record
      where contact_record.school_id = target_school
        and contact_record.student_id = saved_student.id
        and contact_record.is_primary = (contact_index = 1);
      continue;
    end if;
    if char_length(contact_name) > 120 or coalesce(char_length(contact_phone), 0) not between 1 and 40 then
      raise exception 'Enter a name and valid phone number for each emergency contact.';
    end if;
    insert into public.student_emergency_contacts (
      school_id, student_id, contact_name, relationship, phone, email, is_primary
    ) values (
      target_school,
      saved_student.id,
      contact_name,
      nullif(trim(student_data->>format('emergency_contact_%s_relationship', contact_index)), ''),
      contact_phone,
      nullif(trim(student_data->>format('emergency_contact_%s_email', contact_index)), ''),
      contact_index = 1
    )
    on conflict (school_id, student_id, is_primary) do update set
      contact_name = excluded.contact_name,
      relationship = excluded.relationship,
      phone = excluded.phone,
      email = excluded.email;
  end loop;

  return query select saved_student.id, saved_student.student_number;
end;
$$;

revoke all on function public.save_student_record(uuid, uuid, jsonb) from public;
grant execute on function public.save_student_record(uuid, uuid, jsonb) to authenticated;

create trigger audit_school_record_change
  after insert or update or delete on public.student_private_profiles
  for each row execute function public.log_school_record_change();
create trigger audit_school_record_change
  after insert or update or delete on public.student_emergency_contacts
  for each row execute function public.log_school_record_change();
create trigger audit_school_record_change
  after insert or update or delete on public.student_lifecycle_records
  for each row execute function public.log_school_record_change();
create trigger audit_school_record_change
  after insert or update or delete on public.student_documents
  for each row execute function public.log_school_record_change();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'student-documents', 'student-documents', false, 52428800,
  array[
    'application/pdf', 'image/jpeg', 'image/png',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do nothing;

create policy "School admins read student document files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'student-documents'
    and exists (
      select 1 from public.school_memberships membership
      where membership.profile_id = auth.uid()
        and membership.school_id::text = (storage.foldername(name))[1]
        and membership.role = 'school_admin'
    )
  );
create policy "School admins upload student document files"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'student-documents'
    and exists (
      select 1 from public.school_memberships membership
      where membership.profile_id = auth.uid()
        and membership.school_id::text = (storage.foldername(name))[1]
        and membership.role = 'school_admin'
    )
  );
create policy "School admins delete student document files"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'student-documents'
    and exists (
      select 1 from public.school_memberships membership
      where membership.profile_id = auth.uid()
        and membership.school_id::text = (storage.foldername(name))[1]
        and membership.role = 'school_admin'
    )
  );

grant select, insert, update, delete on public.student_private_profiles to authenticated;
grant select, insert, update, delete on public.student_emergency_contacts to authenticated;
grant select on public.student_lifecycle_records to authenticated;
grant select, insert, update, delete on public.student_documents to authenticated;
