create table if not exists public.school_past_paper_storage (
  school_id uuid primary key references public.schools(id) on delete cascade,
  account_id text not null check (account_id ~ '^[a-f0-9]{32}$'),
  bucket_name text not null check (bucket_name ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
  credentials_ciphertext text not null,
  credentials_nonce text not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.school_past_paper_storage enable row level security;
revoke all on public.school_past_paper_storage from anon, authenticated;
grant all on public.school_past_paper_storage to service_role;

create trigger audit_school_record_change
  after insert or update or delete on public.school_past_paper_storage
  for each row execute function public.log_school_record_change();

alter table public.past_paper_sources
  alter column terms_url drop not null,
  alter column rights_basis drop not null;

alter table public.past_paper_discovery_items
  add column lease_storage_provider text not null default 'supabase'
    check (lease_storage_provider in ('supabase', 'r2'));

alter table public.past_paper_documents
  add column storage_provider text not null default 'supabase'
    check (storage_provider in ('supabase', 'r2'));

create or replace function public.claim_past_paper_discovery_item()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.past_paper_discovery_items%rowtype;
  source_row public.past_paper_sources%rowtype;
begin
  with candidate as (
    select item.id
    from public.past_paper_discovery_items item
    join public.past_paper_sources source
      on source.school_id = item.school_id and source.id = item.source_id
    where item.pipeline_status in ('DISCOVERED', 'DOWNLOADED', 'SOURCE_UNAVAILABLE')
      and item.review_status <> 'rejected'
      and item.download_attempts < 5
      and (item.next_retry_at is null or item.next_retry_at <= now())
      and (item.lease_expires_at is null or item.lease_expires_at <= now())
      and source.status = 'active'
      and source.metadata_discovery_allowed
      and source.document_download_allowed
      and source.document_storage_allowed
      and source.question_extraction_allowed
    order by item.created_at
    for update of item skip locked
    limit 1
  )
  update public.past_paper_discovery_items item
  set download_attempts = item.download_attempts + 1,
      lease_expires_at = now() + interval '30 minutes',
      lease_document_path = item.school_id::text || '/' || item.id::text || '/' || gen_random_uuid()::text || '.pdf',
      lease_extraction_path = item.school_id::text || '/' || item.id::text || '/' || gen_random_uuid()::text || '.json',
      lease_storage_provider = case when exists (
        select 1 from public.school_past_paper_storage storage
        where storage.school_id = item.school_id
      ) then 'r2' else 'supabase' end,
      updated_at = now()
  from candidate
  where item.id = candidate.id
  returning item.* into claimed;

  if claimed.id is null then return null; end if;

  select * into source_row
  from public.past_paper_sources source
  where source.id = claimed.source_id and source.school_id = claimed.school_id;

  return jsonb_build_object(
    'id', claimed.id,
    'school_id', claimed.school_id,
    'source_id', claimed.source_id,
    'canonical_url', claimed.canonical_url,
    'original_url', coalesce(claimed.original_url, claimed.canonical_url),
    'title', claimed.title,
    'curriculum', coalesce(claimed.curriculum, source_row.curriculum),
    'subject_name', coalesce(claimed.subject_name, source_row.subject_name),
    'syllabus_code', coalesce(claimed.syllabus_code, source_row.syllabus_code),
    'syllabus_version', coalesce(claimed.syllabus_version, source_row.syllabus_version),
    'examination_year', claimed.examination_year,
    'examination_session', claimed.examination_session,
    'paper_number', claimed.paper_number,
    'variant', claimed.variant,
    'document_path', claimed.lease_document_path,
    'extraction_path', claimed.lease_extraction_path,
    'storage_provider', claimed.lease_storage_provider,
    'document_max_bytes', source_row.document_max_bytes,
    'ocr_allowed', source_row.ocr_allowed,
    'question_reuse_allowed', source_row.question_reuse_allowed,
    'rights_basis', source_row.rights_basis,
    'terms_url', source_row.terms_url,
    'canonical_host', source_row.canonical_host,
    'download_attempts', claimed.download_attempts
  );
end;
$$;
