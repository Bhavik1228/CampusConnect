alter table public.past_paper_sources
  add column if not exists document_download_allowed boolean not null default false,
  add column if not exists document_storage_allowed boolean not null default false,
  add column if not exists ocr_allowed boolean not null default false,
  add column if not exists curriculum text,
  add column if not exists subject_name text,
  add column if not exists syllabus_code text,
  add column if not exists syllabus_version text,
  add column if not exists schedule_enabled boolean not null default false,
  add column if not exists schedule_interval_hours integer not null default 24,
  add column if not exists next_discovery_at timestamptz not null default timezone('utc', now()),
  add column if not exists document_max_bytes integer not null default 52428800;

alter table public.past_paper_discovery_items
  add column if not exists original_url text,
  add column if not exists pipeline_status text not null default 'DISCOVERED',
  add column if not exists curriculum text,
  add column if not exists subject_name text,
  add column if not exists syllabus_code text,
  add column if not exists syllabus_version text,
  add column if not exists examination_year integer,
  add column if not exists examination_session text,
  add column if not exists paper_number text,
  add column if not exists variant text,
  add column if not exists download_attempts integer not null default 0,
  add column if not exists next_retry_at timestamptz,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists lease_document_path text,
  add column if not exists lease_extraction_path text,
  add column if not exists failure_reason text,
  add column if not exists document_sha256 text,
  add column if not exists duplicate_document_id uuid,
  add column if not exists duplicate_item_id uuid,
  add column if not exists updated_at timestamptz not null default timezone('utc', now());

create index if not exists past_paper_items_work_queue_idx
  on public.past_paper_discovery_items(pipeline_status, next_retry_at, created_at)
  where pipeline_status in ('DISCOVERED', 'DOWNLOADED', 'SOURCE_UNAVAILABLE');

create table if not exists public.past_paper_documents (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  source_id uuid not null,
  discovery_item_id uuid not null,
  original_url text not null,
  canonical_url text not null,
  storage_path text not null unique,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  file_size bigint not null check (file_size > 0),
  content_type text not null check (content_type = 'application/pdf'),
  page_count integer not null check (page_count > 0),
  extraction_status text not null default 'pending'
    check (extraction_status in ('pending', 'completed', 'failed')),
  extraction_error text,
  extraction_storage_path text not null unique,
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, sha256),
  unique (school_id, discovery_item_id),
  foreign key (school_id, source_id)
    references public.past_paper_sources(school_id, id) on delete cascade,
  foreign key (school_id, discovery_item_id)
    references public.past_paper_discovery_items(school_id, id) on delete cascade
);

create index if not exists past_paper_documents_school_source_idx
  on public.past_paper_documents(school_id, source_id, created_at desc);
alter table public.past_paper_documents enable row level security;
drop policy if exists "School learning staff read paper document metadata"
  on public.past_paper_documents;
create policy "School learning staff read paper document metadata"
  on public.past_paper_documents for select to authenticated
  using (
    public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
    and public.school_permission_allowed(school_id, 'learning', 'view')
  );
grant select on public.past_paper_documents to authenticated;
grant all on public.past_paper_documents to service_role;

create table if not exists public.past_paper_document_pages (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  document_id uuid not null,
  page_number integer not null check (page_number > 0),
  text_content text not null default '',
  tables jsonb not null default '[]'::jsonb check (jsonb_typeof(tables) = 'array'),
  diagram_references jsonb not null default '[]'::jsonb check (jsonb_typeof(diagram_references) = 'array'),
  instructions text[] not null default '{}',
  extraction_method text not null check (extraction_method in ('pdf-text', 'ocr', 'mixed', 'empty')),
  ocr_confidence numeric(5,2) check (ocr_confidence between 0 and 100),
  needs_review boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, document_id, page_number),
  foreign key (school_id, document_id)
    references public.past_paper_documents(school_id, id) on delete cascade
);

create index if not exists past_paper_document_pages_document_page_idx
  on public.past_paper_document_pages(school_id, document_id, page_number);
alter table public.past_paper_document_pages enable row level security;
drop policy if exists "School learning staff read paper extraction pages"
  on public.past_paper_document_pages;
create policy "School learning staff read paper extraction pages"
  on public.past_paper_document_pages for select to authenticated
  using (
    public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
    and public.school_permission_allowed(school_id, 'learning', 'view')
  );
grant select on public.past_paper_document_pages to authenticated;
grant all on public.past_paper_document_pages to service_role;

alter table public.past_paper_catalogue_questions
  alter column topic drop not null,
  alter column marks drop not null,
  add column if not exists document_id uuid,
  add column if not exists parent_question_id uuid,
  add column if not exists question_number text,
  add column if not exists page_start integer,
  add column if not exists page_end integer,
  add column if not exists curriculum text,
  add column if not exists subject_name text,
  add column if not exists syllabus_version text,
  add column if not exists examination_year integer,
  add column if not exists examination_session text,
  add column if not exists paper_number text,
  add column if not exists variant text,
  add column if not exists syllabus_topic_id uuid,
  add column if not exists classification_confidence numeric(5,2),
  add column if not exists classification_status text not null default 'NEEDS_REVIEW',
  add column if not exists extraction_status text not null default 'NEEDS_REVIEW',
  add column if not exists content_use_status text not null default 'NOT_REVIEWED',
  add column if not exists validation_status text not null default 'NEEDS_REVIEW',
  add column if not exists question_structure jsonb not null default '{}'::jsonb,
  add column if not exists duplicate_of uuid,
  add column if not exists similarity_score numeric(5,2),
  add column if not exists validation_reasons text[] not null default '{}',
  add column if not exists validated_at timestamptz,
  add column if not exists validated_by uuid references public.profiles(id),
  add column if not exists diagram_references jsonb not null default '[]'::jsonb,
  add column if not exists validation_correlation_id uuid;

create index if not exists past_paper_catalogue_testmaker_idx
  on public.past_paper_catalogue_questions(
    school_id, curriculum, syllabus_code, examination_year, examination_session,
    topic, subtopic, review_status, validation_status, content_use_status
  );
create index if not exists past_paper_catalogue_document_parts_idx
  on public.past_paper_catalogue_questions(school_id, document_id, question_number, page_start);

create table if not exists public.past_paper_validation_events (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  catalogue_question_id uuid not null,
  actor_id uuid references public.profiles(id),
  correlation_id uuid not null,
  status text not null check (status in (
    'DISCOVERED', 'DOWNLOADED', 'EXTRACTED', 'VALIDATING', 'NEEDS_REVIEW',
    'APPROVED', 'REJECTED', 'DUPLICATE', 'SOURCE_UNAVAILABLE', 'PERMISSION_BLOCKED'
  )),
  reasons text[] not null default '{}',
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, catalogue_question_id)
    references public.past_paper_catalogue_questions(school_id, id) on delete cascade
);
alter table public.past_paper_validation_events enable row level security;
drop policy if exists "School learning staff read paper validation events"
  on public.past_paper_validation_events;
create policy "School learning staff read paper validation events"
  on public.past_paper_validation_events for select to authenticated
  using (
    public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
    and public.school_permission_allowed(school_id, 'learning', 'view')
  );
grant select on public.past_paper_validation_events to authenticated;
grant all on public.past_paper_validation_events to service_role;

create table if not exists public.past_paper_syllabus_topics (
  id uuid primary key default gen_random_uuid(),
  curriculum text not null check (curriculum in (
    'Cambridge Primary', 'Cambridge Lower Secondary', 'O Level',
    'IGCSE', 'AS Level', 'A Level'
  )),
  subject_name text not null check (length(btrim(subject_name)) between 1 and 160),
  syllabus_code text not null check (length(btrim(syllabus_code)) between 1 and 40),
  syllabus_version text not null check (length(btrim(syllabus_version)) between 1 and 80),
  topic text not null check (length(btrim(topic)) between 1 and 200),
  subtopic text not null default '' check (length(subtopic) <= 200),
  approved_phrases text[] not null default '{}',
  source_url text not null,
  verified_by uuid not null references public.profiles(id),
  verified_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  unique (curriculum, syllabus_code, syllabus_version, topic, subtopic)
);

create index if not exists past_paper_syllabus_lookup_idx
  on public.past_paper_syllabus_topics(curriculum, syllabus_code, syllabus_version);

alter table public.past_paper_syllabus_topics enable row level security;
drop policy if exists "School members read verified syllabus topics"
  on public.past_paper_syllabus_topics;
create policy "School members read verified syllabus topics"
  on public.past_paper_syllabus_topics for select to authenticated
  using (auth.uid() is not null);
grant select on public.past_paper_syllabus_topics to authenticated;
grant all on public.past_paper_syllabus_topics to service_role;

create table if not exists public.past_paper_syllabus_history (
  id uuid primary key default gen_random_uuid(),
  syllabus_topic_id uuid not null,
  changed_by uuid references public.profiles(id),
  operation text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  before_record jsonb,
  after_record jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.past_paper_syllabus_history enable row level security;
revoke all on public.past_paper_syllabus_history from anon, authenticated;
grant all on public.past_paper_syllabus_history to service_role;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.past_paper_sources'::regclass
      and conname = 'paper_source_storage_requires_download'
  ) then
    alter table public.past_paper_sources
      add constraint paper_source_storage_requires_download
      check (not document_storage_allowed or document_download_allowed) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.past_paper_catalogue_questions'::regclass
      and conname = 'past_paper_catalogue_document_fk'
  ) then
    alter table public.past_paper_catalogue_questions
      add constraint past_paper_catalogue_document_fk
      foreign key (school_id, document_id)
      references public.past_paper_documents(school_id, id)
      on delete cascade not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.past_paper_catalogue_questions'::regclass
      and conname = 'past_paper_catalogue_parent_fk'
  ) then
    alter table public.past_paper_catalogue_questions
      add constraint past_paper_catalogue_parent_fk
      foreign key (school_id, parent_question_id)
      references public.past_paper_catalogue_questions(school_id, id)
      on delete cascade not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.past_paper_catalogue_questions'::regclass
      and conname = 'past_paper_catalogue_duplicate_fk'
  ) then
    alter table public.past_paper_catalogue_questions
      add constraint past_paper_catalogue_duplicate_fk
      foreign key (school_id, duplicate_of)
      references public.past_paper_catalogue_questions(school_id, id)
      on delete set null (duplicate_of) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.past_paper_discovery_items'::regclass
      and conname = 'past_paper_duplicate_document_fk'
  ) then
    alter table public.past_paper_discovery_items
      add constraint past_paper_duplicate_document_fk
      foreign key (school_id, duplicate_document_id)
      references public.past_paper_documents(school_id, id)
      on delete set null (duplicate_document_id) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.past_paper_discovery_items'::regclass
      and conname = 'past_paper_duplicate_item_fk'
  ) then
    alter table public.past_paper_discovery_items
      add constraint past_paper_duplicate_item_fk
      foreign key (school_id, duplicate_item_id)
      references public.past_paper_discovery_items(school_id, id)
      on delete set null (duplicate_item_id) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.past_paper_sources'::regclass
      and conname = 'paper_source_ocr_requires_extraction'
  ) then
    alter table public.past_paper_sources
      add constraint paper_source_ocr_requires_extraction
      check (not ocr_allowed or (document_download_allowed and document_storage_allowed and question_extraction_allowed)) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.past_paper_catalogue_questions'::regclass
      and conname = 'catalogue_question_page_range'
  ) then
    alter table public.past_paper_catalogue_questions
      add constraint catalogue_question_page_range
      check (
        (page_start is null and page_end is null) or
        (page_start > 0 and page_end >= page_start)
      ) not valid;
  end if;
end;
$$;

create or replace function public.audit_past_paper_syllabus_topic()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.past_paper_syllabus_history (
    syllabus_topic_id, changed_by, operation, before_record, after_record
  ) values (
    coalesce(new.id, old.id),
    coalesce(
      auth.uid(),
      case when tg_op = 'DELETE' then old.verified_by else new.verified_by end
    ),
    tg_op,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists audit_past_paper_syllabus_topic_change
  on public.past_paper_syllabus_topics;
create trigger audit_past_paper_syllabus_topic_change
after insert or update or delete on public.past_paper_syllabus_topics
for each row execute function public.audit_past_paper_syllabus_topic();

do $$
begin
  if not exists (
    select 1
    from pg_constraint constraint_record
    where constraint_record.conrelid = 'public.past_paper_catalogue_questions'::regclass
      and constraint_record.conname = 'past_paper_catalogue_syllabus_topic_fk'
  ) then
    alter table public.past_paper_catalogue_questions
      add constraint past_paper_catalogue_syllabus_topic_fk
      foreign key (syllabus_topic_id)
      references public.past_paper_syllabus_topics(id)
      on delete set null
      not valid;
  end if;
end;
$$;

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

create or replace function public.release_past_paper_discovery_item(
  target_item uuid,
  failure text,
  can_retry boolean default true
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.past_paper_discovery_items
  set pipeline_status = 'SOURCE_UNAVAILABLE',
      failure_reason = left(coalesce(failure, 'Document processing failed.'), 1000),
      next_retry_at = case
        when can_retry and download_attempts < 5
          then now() + make_interval(mins => least(60, power(2, download_attempts)::integer * 5))
        else null
      end,
      lease_expires_at = null,
      updated_at = now()
  where id = target_item
    and lease_expires_at > now();
  if not found then
    raise exception 'Past-paper item lease expired or item was not found.';
  end if;
end;
$$;

revoke all on function public.claim_past_paper_discovery_item() from public, anon, authenticated;
revoke all on function public.release_past_paper_discovery_item(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.claim_past_paper_discovery_item() to service_role;
grant execute on function public.release_past_paper_discovery_item(uuid, text, boolean) to service_role;

notify pgrst, 'reload schema';
