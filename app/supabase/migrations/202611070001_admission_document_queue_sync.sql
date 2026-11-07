create or replace function public.sync_admission_document_checklist(target_school uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  configured_documents jsonb;
begin
  if not public.is_admissions_officer(target_school) then
    raise exception 'Admissions staff authorization is required.';
  end if;

  select required_documents into configured_documents
  from public.admission_school_settings
  where school_id = target_school;

  if configured_documents is null then
    return;
  end if;

  insert into public.admission_document_checklist(
    school_id, application_id, document_key, label
  )
  select target_school, application.id, document ->> 'key', document ->> 'label'
  from public.admission_applications application
  cross join jsonb_array_elements(configured_documents) document
  where application.school_id = target_school
  on conflict (school_id, application_id, document_key)
  do update set label = excluded.label;
end;
$$;

revoke all on function public.sync_admission_document_checklist(uuid) from public, anon;
grant execute on function public.sync_admission_document_checklist(uuid) to authenticated;
