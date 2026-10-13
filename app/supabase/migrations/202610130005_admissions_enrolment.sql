alter table public.school_websites
  add column admissions_applications_enabled boolean not null default false;

create table public.admission_applications (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  application_reference text not null,
  source text not null default 'public_website'
    check (source in ('public_website', 'school_admin')),
  status text not null default 'submitted'
    check (status in ('submitted', 'under_review', 'accepted', 'rejected', 'waitlisted', 'withdrawn', 'registered')),
  student_first_name text not null check (char_length(trim(student_first_name)) between 1 and 80),
  student_last_name text not null check (char_length(trim(student_last_name)) between 1 and 80),
  date_of_birth date,
  gender text check (gender is null or char_length(gender) <= 40),
  applying_for text not null check (char_length(trim(applying_for)) between 1 and 100),
  academic_year text check (academic_year is null or char_length(academic_year) <= 100),
  previous_school text check (previous_school is null or char_length(previous_school) <= 160),
  student_email text,
  student_phone text check (student_phone is null or char_length(student_phone) <= 40),
  address text check (address is null or char_length(address) <= 500),
  guardian_name text not null check (char_length(trim(guardian_name)) between 2 and 160),
  guardian_relationship text not null check (char_length(trim(guardian_relationship)) between 1 and 60),
  guardian_email text not null,
  guardian_phone text not null check (char_length(trim(guardian_phone)) between 5 and 40),
  notes text check (notes is null or char_length(notes) <= 3000),
  decision_note text check (decision_note is null or char_length(decision_note) <= 3000),
  submitted_at timestamptz not null default timezone('utc', now()),
  reviewed_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  registered_student_id uuid,
  registered_class_id uuid,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, application_reference),
  foreign key (school_id, registered_student_id)
    references public.students(school_id, id) on delete set null (registered_student_id),
  foreign key (school_id, registered_class_id)
    references public.school_classes(school_id, id) on delete set null (registered_class_id)
);

create index admission_applications_school_status_idx
  on public.admission_applications(school_id, status, submitted_at desc);
create index admission_applications_school_name_idx
  on public.admission_applications(school_id, student_last_name, student_first_name);
alter table public.admission_applications replica identity full;

create table public.admission_application_documents (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  application_id uuid not null,
  file_name text not null check (char_length(file_name) between 1 and 200),
  storage_path text not null unique,
  content_type text not null,
  file_size bigint not null check (file_size > 0 and file_size <= 10485760),
  uploaded_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, application_id)
    references public.admission_applications(school_id, id) on delete cascade
);
create index admission_documents_application_idx
  on public.admission_application_documents(school_id, application_id);

create table public.admission_application_history (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  application_id uuid not null,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  from_status text,
  to_status text,
  note text,
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, application_id)
    references public.admission_applications(school_id, id) on delete cascade
);
create index admission_history_application_idx
  on public.admission_application_history(school_id, application_id, created_at desc);

alter table public.admission_applications enable row level security;
alter table public.admission_application_documents enable row level security;
alter table public.admission_application_history enable row level security;

create policy "School admins read admissions applications"
  on public.admission_applications for select to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "School admins read admissions documents"
  on public.admission_application_documents for select to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "School admins read admissions history"
  on public.admission_application_history for select to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]));

grant select on public.admission_applications,
  public.admission_application_documents,
  public.admission_application_history to authenticated;
revoke all on public.admission_applications,
  public.admission_application_documents,
  public.admission_application_history from anon, authenticated;
grant select on public.admission_applications,
  public.admission_application_documents,
  public.admission_application_history to authenticated;

create or replace function public.get_public_school_website(target_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'school_id', website.school_id,
    'slug', website.slug,
    'public_results_enabled', website.public_results_enabled,
    'admissions_applications_enabled', website.admissions_applications_enabled,
    'hero_title', website.hero_title,
    'hero_message', website.hero_message,
    'about_title', website.about_title,
    'about_text', website.about_text,
    'admissions_open', website.admissions_open,
    'admissions_title', website.admissions_title,
    'admissions_text', website.admissions_text,
    'admission_requirements', website.admission_requirements,
    'admissions_deadline', website.admissions_deadline,
    'admissions_email', website.admissions_email,
    'fees', website.fees,
    'name', school.name,
    'address', school.address,
    'contact_email', school.contact_email,
    'contact_phone', school.contact_phone,
    'website', school.website,
    'logo_path', school.logo_path,
    'primary_color', school.primary_color,
    'secondary_color', school.secondary_color,
    'motto', school.motto
  )
  from public.school_websites website
  join public.schools school on school.id = website.school_id
  where website.slug = lower(trim(target_slug))
    and website.enabled;
$$;

create or replace function public.submit_public_admission_application(
  target_slug text,
  applicant_first_name text,
  applicant_last_name text,
  applicant_date_of_birth date,
  applicant_gender text,
  requested_grade text,
  requested_academic_year text,
  applicant_previous_school text,
  applicant_email text,
  applicant_phone text,
  applicant_address text,
  guardian_full_name text,
  guardian_relationship text,
  guardian_contact_email text,
  guardian_contact_phone text,
  applicant_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_school uuid;
  new_application_id uuid;
  new_reference text;
begin
  if applicant_first_name is null or char_length(trim(applicant_first_name)) not between 1 and 80
    or applicant_last_name is null or char_length(trim(applicant_last_name)) not between 1 and 80
    or requested_grade is null or char_length(trim(requested_grade)) not between 1 and 100
    or guardian_full_name is null or char_length(trim(guardian_full_name)) not between 2 and 160
    or guardian_relationship is null or char_length(trim(guardian_relationship)) not between 1 and 60
    or guardian_contact_email is null or char_length(trim(guardian_contact_email)) > 254
    or guardian_contact_email !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'
    or guardian_contact_phone is null or char_length(trim(guardian_contact_phone)) not between 5 and 40
    or (applicant_date_of_birth is not null and applicant_date_of_birth > current_date)
    or (applicant_gender is not null and char_length(applicant_gender) > 40)
    or (requested_academic_year is not null and char_length(requested_academic_year) > 100)
    or (applicant_previous_school is not null and char_length(applicant_previous_school) > 160)
    or (applicant_email is not null and char_length(applicant_email) > 254)
    or (applicant_phone is not null and char_length(applicant_phone) > 40)
    or (applicant_address is not null and char_length(applicant_address) > 500)
    or (applicant_notes is not null and char_length(applicant_notes) > 3000) then
    raise exception 'Please check the application details and correct any fields outside their allowed limits.';
  end if;

  select website.school_id into target_school
  from public.school_websites website
  where website.slug = lower(trim(target_slug))
    and website.enabled
    and website.admissions_open
    and website.admissions_applications_enabled
    and (website.admissions_deadline is null or website.admissions_deadline >= current_date);
  if target_school is null then
    raise exception 'Online applications are not currently available for this school.';
  end if;

  new_reference := 'ADM-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16));
  insert into public.admission_applications (
    school_id, application_reference, source, student_first_name,
    student_last_name, date_of_birth, gender, applying_for, academic_year,
    previous_school, student_email, student_phone, address, guardian_name,
    guardian_relationship, guardian_email, guardian_phone, notes
  ) values (
    target_school, new_reference, 'public_website', trim(applicant_first_name),
    trim(applicant_last_name), applicant_date_of_birth, nullif(trim(applicant_gender), ''),
    trim(requested_grade), nullif(trim(requested_academic_year), ''),
    nullif(trim(applicant_previous_school), ''), nullif(trim(applicant_email), ''),
    nullif(trim(applicant_phone), ''), nullif(trim(applicant_address), ''),
    trim(guardian_full_name), trim(guardian_relationship),
    lower(trim(guardian_contact_email)), trim(guardian_contact_phone),
    nullif(trim(applicant_notes), '')
  )
  returning id into new_application_id;

  return jsonb_build_object('id', new_application_id, 'reference', new_reference);
end;
$$;

create or replace function public.can_upload_admission_document(
  folder_school text,
  folder_application text
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
  return exists (
    select 1
    from public.admission_applications application
    join public.school_websites website on website.school_id = application.school_id
    where application.school_id = parsed_school
      and application.id = parsed_application
      and application.source = 'public_website'
      and application.status = 'submitted'
      and website.enabled
      and website.admissions_open
      and website.admissions_applications_enabled
      and (website.admissions_deadline is null or website.admissions_deadline >= current_date)
      and (
        select count(*)
        from storage.objects stored_object
        where stored_object.bucket_id = 'admission-documents'
          and stored_object.name like folder_school || '/' || folder_application || '/%'
      ) < 5
  );
end;
$$;

create or replace function public.add_public_admission_document(
  target_application uuid,
  target_file_name text,
  target_storage_path text,
  target_content_type text,
  target_file_size bigint
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_school uuid;
  new_document_id uuid;
begin
  select application.school_id into target_school
  from public.admission_applications application
  where application.id = target_application
    and application.source = 'public_website'
    and application.status = 'submitted';
  if target_school is null then
    raise exception 'This application cannot accept uploaded documents.';
  end if;
  if target_file_name is null or char_length(target_file_name) not between 1 and 200
    or target_file_size is null or target_file_size not between 1 and 10485760
    or target_content_type is null
    or target_content_type is null
    or target_content_type not in (
      'application/pdf', 'image/jpeg', 'image/png',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
    or target_storage_path !~ (
      '^' || target_school::text || '/' || target_application::text || '/[A-Za-z0-9._-]{1,120}$'
    )
    or not exists (
      select 1 from storage.objects object
      where object.bucket_id = 'admission-documents'
        and object.name = target_storage_path
    ) then
    raise exception 'The uploaded document is invalid or could not be verified.';
  end if;
  insert into public.admission_application_documents (
    school_id, application_id, file_name, storage_path, content_type, file_size
  ) values (
    target_school, target_application, target_file_name, target_storage_path,
    target_content_type, target_file_size
  )
  returning id into new_document_id;
  return new_document_id;
end;
$$;

create or replace function public.get_public_admission_status(
  target_reference text,
  target_guardian_email text
)
returns table (
  application_reference text,
  student_name text,
  school_name text,
  application_status text,
  applying_for text,
  decision_note text,
  submitted_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select application.application_reference,
    application.student_first_name || ' ' || application.student_last_name,
    school.name,
    application.status,
    application.applying_for,
    application.decision_note,
    application.submitted_at,
    application.updated_at
  from public.admission_applications application
  join public.schools school on school.id = application.school_id
  where upper(application.application_reference) = upper(trim(target_reference))
    and lower(application.guardian_email) = lower(trim(target_guardian_email))
  limit 1;
$$;

create or replace function public.log_admission_application_history()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed_action text;
  event_note text;
begin
  if tg_op = 'INSERT' then
    changed_action := 'application_submitted';
    event_note := null;
  else
    if old.status is distinct from new.status then
      changed_action := case
        when new.status = 'registered' then 'student_registered'
        when new.status in ('accepted', 'rejected', 'waitlisted') then 'admission_decision'
        else 'status_changed'
      end;
    elsif old.decision_note is distinct from new.decision_note then
      changed_action := 'decision_note_updated';
    elsif old.registered_class_id is distinct from new.registered_class_id then
      changed_action := 'class_placement_changed';
    else
      return new;
    end if;
    event_note := new.decision_note;
  end if;

  insert into public.admission_application_history (
    school_id, application_id, actor_id, action, from_status, to_status, note
  ) values (
    new.school_id, new.id, auth.uid(), changed_action,
    case when tg_op = 'INSERT' then null else old.status end,
    new.status, event_note
  );
  return new;
end;
$$;

create trigger record_admission_application_history
  after insert or update on public.admission_applications
  for each row execute function public.log_admission_application_history();

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
    and public.has_school_role(application.school_id, array['school_admin']::public.app_role[])
  for update;
  if not found then raise exception 'Application not found or not authorized.'; end if;
  if next_status not in ('under_review', 'accepted', 'rejected', 'waitlisted', 'withdrawn') then
    raise exception 'Choose a valid application status.';
  end if;
  if application_record.status = 'registered' then
    raise exception 'Registered applications cannot be changed.';
  end if;
  if char_length(coalesce(reviewer_note, '')) > 3000 then
    raise exception 'Decision notes must be 3000 characters or fewer.';
  end if;

  update public.admission_applications
  set status = next_status,
      decision_note = nullif(trim(reviewer_note), ''),
      reviewed_by = auth.uid(),
      decided_at = case when next_status in ('accepted', 'rejected', 'waitlisted') then timezone('utc', now()) else decided_at end,
      updated_at = timezone('utc', now())
  where id = target_application;
end;
$$;

create table public.admission_student_number_sequences (
  school_id uuid primary key references public.schools(id) on delete cascade,
  last_value bigint not null default 0 check (last_value >= 0)
);

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
    and public.has_school_role(application.school_id, array['school_admin']::public.app_role[])
  for update;
  if not found then raise exception 'Application not found or not authorized.'; end if;
  if application_record.status <> 'accepted' then
    raise exception 'Only accepted applicants can be registered as students.';
  end if;
  if not exists (
    select 1 from public.school_classes class
    where class.school_id = application_record.school_id and class.id = target_class
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
  return public.has_school_role(parsed_school, array['school_admin']::public.app_role[])
    and exists (
      select 1 from public.admission_application_documents document
      where document.school_id = parsed_school
        and document.application_id = parsed_application
          and document.storage_path = object_path
          and object_path like folder_school || '/' || folder_application || '/%'
    );
end;
$$;

revoke all on function public.submit_public_admission_application(text, text, text, date, text, text, text, text, text, text, text, text, text, text, text, text) from public;
grant execute on function public.submit_public_admission_application(text, text, text, date, text, text, text, text, text, text, text, text, text, text, text, text) to anon, authenticated;
revoke all on function public.add_public_admission_document(uuid, text, text, text, bigint) from public;
grant execute on function public.add_public_admission_document(uuid, text, text, text, bigint) to anon, authenticated;
revoke all on function public.get_public_admission_status(text, text) from public;
grant execute on function public.get_public_admission_status(text, text) to anon, authenticated;
revoke all on function public.review_admission_application(uuid, text, text) from public;
grant execute on function public.review_admission_application(uuid, text, text) to authenticated;
revoke all on function public.register_admission_student(uuid, uuid) from public;
grant execute on function public.register_admission_student(uuid, uuid) to authenticated;
revoke all on function public.can_upload_admission_document(text, text) from public;
grant execute on function public.can_upload_admission_document(text, text) to anon, authenticated;
revoke all on function public.can_read_admission_document(text, text, text) from public;
grant execute on function public.can_read_admission_document(text, text, text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'admission-documents',
  'admission-documents',
  false,
  10485760,
  array[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do nothing;

create policy "Public applicants upload documents for open applications"
  on storage.objects for insert to anon, authenticated
  with check (
    bucket_id = 'admission-documents'
    and public.can_upload_admission_document(
      (storage.foldername(name))[1], (storage.foldername(name))[2]
    )
    and array_length(storage.foldername(name), 1) = 2
  );

create policy "School admins read admission document files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'admission-documents'
    and public.can_read_admission_document(
      (storage.foldername(name))[1], (storage.foldername(name))[2], name
    )
  );

create policy "School admins delete admission document files"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'admission-documents'
    and public.can_read_admission_document(
      (storage.foldername(name))[1], (storage.foldername(name))[2], name
    )
  );

create trigger set_admission_applications_updated_at
  before update on public.admission_applications
  for each row execute function public.set_updated_at();

create trigger audit_admission_applications
  after insert or update or delete on public.admission_applications
  for each row execute function public.log_school_record_change();
create trigger audit_admission_application_documents
  after insert or update or delete on public.admission_application_documents
  for each row execute function public.log_school_record_change();
create trigger audit_admission_application_history
  after insert or update or delete on public.admission_application_history
  for each row execute function public.log_school_record_change();

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'admission_applications'
    ) then
      alter publication supabase_realtime add table public.admission_applications;
    end if;
  end if;
end;
$$;
