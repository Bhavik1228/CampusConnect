create extension if not exists pgcrypto with schema extensions;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('school-official-documents', 'school-official-documents', false, 20971520, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 20971520,
  allowed_mime_types = array['application/pdf'];

create table public.school_document_counters (
  school_id uuid not null references public.schools(id) on delete cascade,
  document_type text not null,
  document_year integer not null,
  last_value bigint not null default 0,
  primary key (school_id, document_type, document_year)
);

create table public.school_documents (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  document_type text not null check (document_type in ('academic_report', 'invoice', 'receipt', 'statement')),
  source_id uuid not null,
  source_status text,
  document_reference text not null,
  version integer not null check (version > 0),
  status text not null default 'generated'
    check (status in ('generated', 'issued', 'superseded', 'voided', 'revoked')),
  object_path text not null,
  token_hash bytea not null unique,
  content_sha256 bytea,
  created_by uuid not null references public.profiles(id),
  issued_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  issued_at timestamptz,
  expires_at timestamptz,
  replaced_by uuid references public.school_documents(id),
  unique (school_id, id),
  unique (school_id, document_type, document_reference, version),
  unique (object_path)
);
create index school_documents_school_source_idx
  on public.school_documents(school_id, document_type, source_id, version desc);
create index school_documents_school_created_idx
  on public.school_documents(school_id, created_at desc);

create table public.school_document_events (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools(id) on delete cascade,
  document_id uuid not null,
  actor_id uuid references public.profiles(id),
  action text not null check (action in ('issued', 'viewed', 'downloaded', 'reprinted', 'revoked', 'voided', 'verified')),
  created_at timestamptz not null default now(),
  foreign key (school_id, document_id)
    references public.school_documents(school_id, id) on delete cascade
);
create index school_document_events_document_idx
  on public.school_document_events(school_id, document_id, created_at desc);

alter table public.school_documents enable row level security;
alter table public.school_document_events enable row level security;
alter table public.school_document_counters enable row level security;
revoke all on public.school_documents, public.school_document_events, public.school_document_counters
  from public, anon, authenticated;

create or replace function public.can_access_school_document(target_school uuid, target_document uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.school_documents document
    join public.school_memberships membership
      on membership.school_id = document.school_id and membership.profile_id = auth.uid()
    where document.school_id = target_school and document.id = target_document
      and document.status in ('issued', 'superseded')
      and exists (select 1 from public.schools school
        where school.id = document.school_id and school.platform_status = 'active')
      and (
        (document.document_type in ('invoice', 'receipt', 'statement')
          and membership.role::text in ('school_admin', 'finance_manager', 'accountant', 'bursar', 'cashier', 'auditor'))
        or (document.document_type = 'academic_report' and (
          membership.role::text in ('school_admin', 'academic_coordinator')
          or exists (
            select 1 from public.students student
            where student.school_id = document.school_id and student.id = document.source_id
              and (
                student.profile_id = auth.uid()
                or public.is_parent_of_student(student.school_id, student.id)
                or (student.class_id is not null and public.is_teacher_for_class(student.school_id, student.class_id))
              )
          )
        ))
      )
  );
$$;
revoke all on function public.can_access_school_document(uuid, uuid) from public, anon;
grant execute on function public.can_access_school_document(uuid, uuid) to authenticated;

create or replace function public.can_upload_school_document(target_school uuid, target_document uuid, target_path text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.school_documents document
    where document.school_id = target_school and document.id = target_document
      and document.created_by = auth.uid() and document.status = 'generated'
      and document.object_path = target_path
      and public.is_school_member(target_school)
  );
$$;
revoke all on function public.can_upload_school_document(uuid, uuid, text) from public, anon;
grant execute on function public.can_upload_school_document(uuid, uuid, text) to authenticated;

create policy "Authorized members read official school PDFs"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'school-official-documents'
    and public.can_access_school_document(
      nullif((storage.foldername(name))[1], '')::uuid,
      nullif((storage.foldername(name))[2], '')::uuid
    )
  );
create policy "Authorized issuers upload generated official PDFs"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'school-official-documents'
    and public.can_upload_school_document(
      nullif((storage.foldername(name))[1], '')::uuid,
      nullif((storage.foldername(name))[2], '')::uuid,
      name
    )
  );

create or replace function public.prepare_school_document(
  target_school uuid,
  target_type text,
  target_source uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  caller_role text;
  source_reference text;
  source_status text;
  new_reference text;
  new_token text;
  new_document_id uuid;
  new_version integer;
  document_year integer := extract(year from current_date)::integer;
  prefix text;
  previous_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in to generate a school document.'; end if;
  select role::text into caller_role from public.school_memberships
  where school_id = target_school and profile_id = auth.uid();
  if caller_role is null then raise exception 'An active school membership is required.'; end if;
  if not public.is_school_member(target_school) then
    raise exception 'Documents cannot be issued for an inactive school.';
  end if;
  if target_type not in ('academic_report', 'invoice', 'receipt', 'statement') then
    raise exception 'Unsupported document type.';
  end if;

  if target_type in ('invoice', 'receipt', 'statement') then
    if caller_role not in ('school_admin', 'finance_manager', 'accountant', 'bursar', 'cashier') then
      raise exception 'Finance document access is required.';
    end if;
    if target_type = 'invoice' then
      select invoice.invoice_number, invoice.status into source_reference, source_status
      from public.student_fee_invoices invoice
      where invoice.school_id = target_school and invoice.id = target_source;
    elsif target_type = 'receipt' then
      select payment.receipt_number into source_reference from public.student_fee_payments payment
      where payment.school_id = target_school and payment.id = target_source;
    else
      if not exists (select 1 from public.students where school_id = target_school and id = target_source) then
        raise exception 'The requested student record was not found in this school.';
      end if;
      if target_type = 'academic_report' and not exists (
        select 1 from public.learning_assessment_results result
        where result.school_id = target_school and result.student_id = target_source and result.status = 'published'
      ) then
        raise exception 'A student report requires published academic results.';
      end if;
    end if;
  else
    if caller_role not in ('school_admin', 'academic_coordinator', 'teacher') then
      raise exception 'Academic report access is required.';
    end if;
    if not exists (select 1 from public.students where school_id = target_school and id = target_source) then
      raise exception 'The requested student record was not found in this school.';
    end if;
    if caller_role = 'teacher' and not exists (
      select 1 from public.students student
      where student.school_id = target_school and student.id = target_source
        and student.class_id is not null
        and public.is_teacher_for_class(target_school, student.class_id)
    ) then
      raise exception 'Teachers can generate reports only for students in their assigned classes.';
    end if;
  end if;
  if target_type in ('invoice', 'receipt') and source_reference is null then
    raise exception 'The requested finance record was not found in this school.';
  end if;

  prefix := case target_type
    when 'academic_report' then 'RPT'
    when 'statement' then 'STM'
    else null
  end;
  if prefix is not null then
    insert into public.school_document_counters(school_id, document_type, document_year, last_value)
    values (target_school, target_type, document_year, 1)
    on conflict (school_id, document_type, document_year)
    do update set last_value = public.school_document_counters.last_value + 1
    returning last_value into new_version;
    new_reference := prefix || '-' || document_year::text || '-' || lpad(new_version::text, 6, '0');
  else
    new_reference := source_reference;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target_school::text || target_type || target_source::text, 0));
  select max(version)::integer into new_version from public.school_documents
  where school_id = target_school and document_type = target_type and source_id = target_source;
  new_version := coalesce(new_version, 0) + 1;
  new_document_id := gen_random_uuid();
  new_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.school_documents(
    id, school_id, document_type, source_id, source_status, document_reference, version, object_path, token_hash, created_by
  ) values (
    new_document_id, target_school, target_type, target_source,
    source_status, new_reference, new_version,
    target_school::text || '/' || new_document_id::text || '/' || new_version::text || '.pdf',
    extensions.digest(new_token, 'sha256'), auth.uid()
  );
  return jsonb_build_object(
    'id', new_document_id,
    'reference', new_reference,
    'version', new_version,
    'token', new_token,
    'object_path', target_school::text || '/' || new_document_id::text || '/' || new_version::text || '.pdf'
  );
end;
$$;
revoke all on function public.prepare_school_document(uuid, text, uuid) from public, anon;
grant execute on function public.prepare_school_document(uuid, text, uuid) to authenticated;

create or replace function public.finalize_school_document(
  target_document uuid,
  target_sha256 bytea
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.school_documents%rowtype;
begin
  if auth.uid() is null or octet_length(target_sha256) <> 32 then
    raise exception 'A valid signed-in document issuer and SHA-256 digest are required.';
  end if;
  select * into target from public.school_documents
  where id = target_document and created_by = auth.uid() and status = 'generated';
  if not found then raise exception 'Generated document not found or no longer editable.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    target.school_id::text || target.document_type || target.source_id::text, 0
  ));
  select * into target from public.school_documents
  where id = target_document and created_by = auth.uid() and status = 'generated'
  for update;
  if not found then raise exception 'Generated document not found or no longer editable.'; end if;
  if not exists (
    select 1 from storage.objects object
    where object.bucket_id = 'school-official-documents' and object.name = target.object_path
  ) then raise exception 'The private PDF upload is missing.'; end if;
  update public.school_documents set
    status = case when target.document_type = 'invoice' and target.source_status = 'void' then 'voided' else 'issued' end,
    content_sha256 = target_sha256,
    issued_by = auth.uid(), issued_at = now()
  where id = target.id;
  update public.school_documents set status = 'superseded', replaced_by = target.id
  where school_id = target.school_id and document_type = target.document_type
    and source_id = target.source_id and id <> target.id and status = 'issued';
  insert into public.school_document_events(school_id, document_id, actor_id, action)
  values (target.school_id, target.id, auth.uid(),
    case when target.document_type = 'invoice' and target.source_status = 'void' then 'voided' else 'issued' end);
  insert into public.audit_logs(school_id, actor_id, action, target_table, target_id, metadata)
  values (target.school_id, auth.uid(), 'official_document_issued', 'school_documents', target.id,
    jsonb_build_object('type', target.document_type, 'reference', target.document_reference, 'version', target.version));
end;
$$;
revoke all on function public.finalize_school_document(uuid, bytea) from public, anon;
grant execute on function public.finalize_school_document(uuid, bytea) to authenticated;

create or replace function public.record_school_document_download(target_document uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.school_documents%rowtype;
begin
  select * into target from public.school_documents
  where id = target_document and status in ('issued', 'superseded');
  if not found or not public.can_access_school_document(target.school_id, target.id) then
    raise exception 'Document access is unavailable.';
  end if;
  insert into public.school_document_events(school_id, document_id, actor_id, action)
  values (target.school_id, target.id, auth.uid(), 'downloaded');
  insert into public.audit_logs(school_id, actor_id, action, target_table, target_id, metadata)
  values (target.school_id, auth.uid(), 'official_document_downloaded', 'school_documents', target.id,
    jsonb_build_object('type', target.document_type, 'reference', target.document_reference, 'version', target.version));
end;
$$;
revoke all on function public.record_school_document_download(uuid) from public, anon;
grant execute on function public.record_school_document_download(uuid) to authenticated;

create or replace function public.verify_school_document(verification_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  target public.school_documents%rowtype;
  school_name text;
begin
  if verification_token is null or verification_token !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into target from public.school_documents
  where token_hash = extensions.digest(verification_token, 'sha256');
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  select name into school_name from public.schools where id = target.school_id;
  insert into public.school_document_events(school_id, document_id, actor_id, action)
  values (target.school_id, target.id, auth.uid(), 'verified');
  return jsonb_build_object(
    'status', case
      when target.status in ('revoked', 'voided') then target.status
      when target.expires_at is not null and target.expires_at < now() then 'expired'
      when target.status = 'superseded' then 'superseded'
      when target.status = 'issued' then 'authentic'
      else 'unavailable'
    end,
    'school_name', school_name,
    'document_type', target.document_type,
    'masked_reference', left(target.document_reference, greatest(0, length(target.document_reference) - 4))
      || '••••' || right(target.document_reference, 4),
    'issued_at', target.issued_at
  );
end;
$$;
revoke all on function public.verify_school_document(text) from public;
grant execute on function public.verify_school_document(text) to anon, authenticated;

create or replace function public.get_authorized_school_document(verification_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  target public.school_documents%rowtype;
begin
  if auth.uid() is null or verification_token is null or verification_token !~ '^[0-9a-f]{64}$' then
    raise exception 'Sign in with an authorized school account to access this document.';
  end if;
  select * into target from public.school_documents
  where token_hash = extensions.digest(verification_token, 'sha256');
  if not found or not public.can_access_school_document(target.school_id, target.id) then
    raise exception 'This document is unavailable or your account is not authorized to view it.';
  end if;
  insert into public.school_document_events(school_id, document_id, actor_id, action)
  values (target.school_id, target.id, auth.uid(), 'viewed');
  insert into public.audit_logs(school_id, actor_id, action, target_table, target_id, metadata)
  values (target.school_id, auth.uid(), 'official_document_viewed', 'school_documents', target.id,
    jsonb_build_object('type', target.document_type, 'reference', target.document_reference, 'version', target.version));
  return jsonb_build_object('object_path', target.object_path, 'reference', target.document_reference);
end;
$$;
revoke all on function public.get_authorized_school_document(text) from public, anon;
grant execute on function public.get_authorized_school_document(text) to authenticated;

create or replace function public.revoke_school_document(target_document uuid, target_status text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.school_documents%rowtype;
begin
  if auth.uid() is null or target_status <> 'revoked' then
    raise exception 'A signed-in user and revoked document status are required.';
  end if;
  select * into target from public.school_documents where id = target_document for update;
  if not found then raise exception 'Document not found.'; end if;
  if target.status not in ('issued', 'superseded') then
    raise exception 'Only an issued document can be revoked.';
  end if;
  if target.document_type in ('invoice', 'receipt', 'statement') then
    if not public.has_school_role(target.school_id, array['school_admin', 'finance_manager']::public.app_role[]) then
      raise exception 'A finance administrator is required to revoke this document.';
    end if;
  elsif not public.has_school_role(target.school_id, array['school_admin']::public.app_role[]) then
    raise exception 'A school administrator is required to revoke this document.';
  end if;
  update public.school_documents set status = target_status where id = target.id;
  insert into public.school_document_events(school_id, document_id, actor_id, action)
  values (target.school_id, target.id, auth.uid(), target_status);
  insert into public.audit_logs(school_id, actor_id, action, target_table, target_id, metadata)
  values (target.school_id, auth.uid(), 'official_document_' || target_status, 'school_documents', target.id,
    jsonb_build_object('type', target.document_type, 'reference', target.document_reference));
end;
$$;
revoke all on function public.revoke_school_document(uuid, text) from public, anon;
grant execute on function public.revoke_school_document(uuid, text) to authenticated;

create policy "Authorized members read official document events"
  on public.school_document_events for select to authenticated
  using (public.can_access_school_document(school_id, document_id));
grant select on public.school_document_events to authenticated;

notify pgrst, 'reload schema';
