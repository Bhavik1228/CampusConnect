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
  if jsonb_typeof(application_payload) is distinct from 'object' then
    raise exception 'Provide a valid application.';
  end if;
  if jsonb_typeof(coalesce(application_payload -> 'custom_fields', '{}'::jsonb)) is distinct from 'object'
    or pg_column_size(application_payload -> 'custom_fields') > 32768 then
    raise exception 'Provide valid additional application details.';
  end if;

  select website.school_id into target_school
  from public.school_websites website
  where website.slug = lower(trim(target_slug))
    and website.enabled
    and website.admissions_open
    and website.admissions_applications_enabled
    and (website.admissions_deadline is null or website.admissions_deadline >= current_date);
  if target_school is null then
    raise exception 'Online applications are not currently available.';
  end if;

  select * into settings
  from public.admission_school_settings
  where school_id = target_school;

  for field_config in
    select value
    from jsonb_array_elements(coalesce(settings.application_fields, '[]'::jsonb))
  loop
    field_value := application_payload -> 'custom_fields' ->> (field_config ->> 'key');
    if coalesce((field_config ->> 'required')::boolean, false)
      and coalesce(trim(field_value), '') = '' then
      raise exception '% is required.', field_config ->> 'label';
    end if;
    if field_value is not null and char_length(field_value) > 2000 then
      raise exception '% is too long.', field_config ->> 'label';
    end if;
    if field_value is not null and field_config ->> 'type' = 'select'
      and not exists (
        select 1
        from jsonb_array_elements_text(
          case
            when jsonb_typeof(field_config -> 'options') = 'array'
              then field_config -> 'options'
            else '[]'::jsonb
          end
        ) option_value
        where option_value = field_value
      ) then
      raise exception 'Choose a valid option for %.', field_config ->> 'label';
    end if;
  end loop;

  result := public.submit_public_admission_application(
    target_slug,
    application_payload ->> 'student_first_name',
    application_payload ->> 'student_last_name',
    nullif(trim(application_payload ->> 'date_of_birth'), '')::date,
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
        select stage.id
        from public.admission_workflow_stages stage
        where stage.school_id = target_school
          and stage.status = 'submitted'
          and stage.active
        order by stage.sort_order
        limit 1
      )
  where id = (result ->> 'id')::uuid
    and school_id = target_school;

  insert into public.admission_document_checklist(school_id, application_id, document_key, label)
  select target_school, (result ->> 'id')::uuid, document ->> 'key', document ->> 'label'
  from jsonb_array_elements(coalesce(settings.required_documents, '[]'::jsonb)) document
  on conflict (school_id, application_id, document_key) do nothing;

  resume_token := application_payload ->> 'resume_token';
  if resume_token is not null and char_length(resume_token) between 40 and 160 then
    delete from public.admission_application_drafts
    where school_id = target_school
      and token_hash = encode(
        extensions.digest(convert_to(resume_token, 'UTF8'), 'sha256'),
        'hex'
      );
  end if;

  return result;
end;
$$;

notify pgrst, 'reload schema';
