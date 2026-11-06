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
#variable_conflict use_column
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
  new_contact_name text;
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
    new_contact_name := nullif(trim(student_data->>format('emergency_contact_%s_name', contact_index)), '');
    contact_phone := nullif(trim(student_data->>format('emergency_contact_%s_phone', contact_index)), '');
    if new_contact_name is null then
      if contact_index = 1 then
        delete from public.student_emergency_contacts contact_record
        where contact_record.school_id = target_school
          and contact_record.student_id = saved_student.id
          and contact_record.is_primary;
      else
        delete from public.student_emergency_contacts contact_record
        where contact_record.id = (
          select existing_contact.id
          from public.student_emergency_contacts existing_contact
          where existing_contact.school_id = target_school
            and existing_contact.student_id = saved_student.id
            and not existing_contact.is_primary
          order by existing_contact.created_at, existing_contact.id
          limit 1
        );
      end if;
      continue;
    end if;
    if char_length(new_contact_name) > 120 or coalesce(char_length(contact_phone), 0) not between 1 and 40 then
      raise exception 'Enter a name and valid phone number for each emergency contact.';
    end if;

    if contact_index = 1 then
      insert into public.student_emergency_contacts (
        school_id, student_id, contact_name, relationship, phone, email, is_primary
      ) values (
        target_school, saved_student.id, new_contact_name,
        nullif(trim(student_data->>'emergency_contact_1_relationship'), ''),
        contact_phone, nullif(trim(student_data->>'emergency_contact_1_email'), ''), true
      )
      on conflict (school_id, student_id) where is_primary do update set
        contact_name = excluded.contact_name,
        relationship = excluded.relationship,
        phone = excluded.phone,
        email = excluded.email;
    else
      update public.student_emergency_contacts existing_contact
      set contact_name = new_contact_name,
          relationship = nullif(trim(student_data->>'emergency_contact_2_relationship'), ''),
          phone = contact_phone,
          email = nullif(trim(student_data->>'emergency_contact_2_email'), '')
      where existing_contact.id = (
        select contact_to_update.id
        from public.student_emergency_contacts contact_to_update
        where contact_to_update.school_id = target_school
          and contact_to_update.student_id = saved_student.id
          and not contact_to_update.is_primary
        order by contact_to_update.created_at, contact_to_update.id
        limit 1
      );
      if not found then
        insert into public.student_emergency_contacts (
          school_id, student_id, contact_name, relationship, phone, email, is_primary
        ) values (
          target_school, saved_student.id, new_contact_name,
          nullif(trim(student_data->>'emergency_contact_2_relationship'), ''),
          contact_phone, nullif(trim(student_data->>'emergency_contact_2_email'), ''), false
        );
      end if;
    end if;
  end loop;

  return query select saved_student.id, saved_student.student_number;
end;
$$;

revoke all on function public.save_student_record(uuid, uuid, jsonb) from public, anon, authenticated;

create or replace function public.create_admission_application(application_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_school uuid;
  created_application_id uuid;
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
  select stage.id into requested_stage from public.admission_workflow_stages stage
  where stage.school_id = target_school and stage.status = status_value and stage.active
  order by stage.sort_order limit 1;
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
  ) returning id into created_application_id;
  insert into public.admission_document_checklist(school_id, application_id, document_key, label)
  select target_school, created_application_id, document ->> 'key', document ->> 'label'
  from public.admission_school_settings settings
  cross join lateral jsonb_array_elements(settings.required_documents) document
  where settings.school_id = target_school
  on conflict (school_id, application_id, document_key) do nothing;
  return created_application_id;
end;
$$;

revoke all on function public.create_admission_application(jsonb) from public, anon;
grant execute on function public.create_admission_application(jsonb) to authenticated;

notify pgrst, 'reload schema';
