create table public.past_paper_sources (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  created_by uuid not null references public.profiles(id),
  name text not null check (length(btrim(name)) between 1 and 120),
  listing_url text not null,
  canonical_host text not null,
  terms_url text not null,
  rights_basis text not null check (length(btrim(rights_basis)) >= 8),
  metadata_discovery_allowed boolean not null default false,
  question_extraction_allowed boolean not null default false,
  question_reuse_allowed boolean not null default false,
  status text not null default 'active' check (status in ('active', 'paused')),
  last_robots_check_at timestamptz,
  last_discovery_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  check (not question_reuse_allowed or question_extraction_allowed)
);

create index past_paper_sources_school_status_idx
  on public.past_paper_sources(school_id, status, created_at desc);

create or replace function public.guard_past_paper_source_identity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.school_id is distinct from old.school_id
    or new.created_by is distinct from old.created_by then
    raise exception 'Past-paper source school and creator are immutable.';
  end if;
  return new;
end;
$$;

create trigger guard_past_paper_source_identity
before update on public.past_paper_sources
for each row execute function public.guard_past_paper_source_identity();

alter table public.past_paper_sources enable row level security;

create policy "School members read paper sources"
  on public.past_paper_sources for select to authenticated
  using (
    public.is_school_member(school_id)
    and public.school_permission_allowed(school_id, 'learning', 'view')
  );

create policy "School academic leads register paper sources"
  on public.past_paper_sources for insert to authenticated
  with check (
    created_by = auth.uid()
    and public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
    and public.school_permission_allowed(school_id, 'learning', 'create')
  );

create policy "School academic leads update paper sources"
  on public.past_paper_sources for update to authenticated
  using (
    public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
    and public.school_permission_allowed(school_id, 'learning', 'edit')
  )
  with check (
    public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
    and public.school_permission_allowed(school_id, 'learning', 'edit')
  );

grant select, insert, update on public.past_paper_sources to authenticated;

create table public.past_paper_discovery_jobs (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  source_id uuid not null,
  requested_by uuid not null references public.profiles(id),
  correlation_id uuid not null default gen_random_uuid(),
  idempotency_key uuid not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  discovered_count integer not null default 0 check (discovered_count >= 0),
  failure_reason text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, idempotency_key),
  foreign key (school_id, source_id)
    references public.past_paper_sources(school_id, id) on delete cascade
);

create index past_paper_discovery_jobs_school_created_idx
  on public.past_paper_discovery_jobs(school_id, created_at desc);

create unique index past_paper_discovery_jobs_one_running_source_idx
  on public.past_paper_discovery_jobs(school_id, source_id)
  where status = 'running';

alter table public.past_paper_discovery_jobs enable row level security;

create policy "School members read paper discovery jobs"
  on public.past_paper_discovery_jobs for select to authenticated
  using (
    public.is_school_member(school_id)
    and public.school_permission_allowed(school_id, 'learning', 'view')
  );

grant select on public.past_paper_discovery_jobs to authenticated;

create table public.past_paper_discovery_items (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  source_id uuid not null,
  job_id uuid not null,
  canonical_url text not null,
  title text not null,
  link_text text not null default '',
  review_status text not null default 'pending' check (review_status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, source_id, canonical_url),
  foreign key (school_id, source_id)
    references public.past_paper_sources(school_id, id) on delete cascade,
  foreign key (school_id, job_id)
    references public.past_paper_discovery_jobs(school_id, id) on delete cascade
);

create index past_paper_discovery_items_school_status_idx
  on public.past_paper_discovery_items(school_id, review_status, created_at desc);

alter table public.past_paper_discovery_items enable row level security;

create policy "School members read discovered paper metadata"
  on public.past_paper_discovery_items for select to authenticated
  using (
    public.is_school_member(school_id)
    and public.school_permission_allowed(school_id, 'learning', 'view')
  );

grant select on public.past_paper_discovery_items to authenticated;

create table public.past_paper_catalogue_questions (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  source_id uuid not null,
  discovery_item_id uuid not null,
  created_by uuid not null references public.profiles(id),
  question_text text not null check (length(btrim(question_text)) between 10 and 12000),
  topic text not null check (length(btrim(topic)) between 1 and 160),
  subtopic text not null default '' check (length(subtopic) <= 160),
  syllabus_code text not null default '' check (length(syllabus_code) <= 40),
  marks numeric(8,2) not null check (marks > 0 and marks <= 1000),
  difficulty text not null default 'Standard' check (difficulty in ('Foundation', 'Standard', 'Challenging')),
  mark_scheme text not null default '' check (length(mark_scheme) <= 12000),
  content_fingerprint text not null,
  review_status text not null default 'pending' check (review_status in ('pending', 'approved', 'rejected')),
  validation_errors text[] not null default '{}',
  reviewer_note text not null default '' check (length(reviewer_note) <= 2000),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, source_id, content_fingerprint),
  foreign key (school_id, source_id)
    references public.past_paper_sources(school_id, id) on delete cascade,
  foreign key (school_id, discovery_item_id)
    references public.past_paper_discovery_items(school_id, id) on delete cascade
);

create index past_paper_catalogue_questions_school_status_idx
  on public.past_paper_catalogue_questions(school_id, review_status, topic);

alter table public.past_paper_catalogue_questions enable row level security;

create policy "School staff read reviewed catalogue questions"
  on public.past_paper_catalogue_questions for select to authenticated
  using (
    public.is_school_member(school_id)
    and public.school_permission_allowed(school_id, 'learning', 'view')
    and exists (
      select 1
      from public.past_paper_sources source
      join public.past_paper_discovery_items item
        on item.school_id = source.school_id and item.source_id = source.id
      where source.school_id = past_paper_catalogue_questions.school_id
        and source.id = past_paper_catalogue_questions.source_id
        and item.id = past_paper_catalogue_questions.discovery_item_id
        and source.status = 'active'
        and source.question_extraction_allowed
        and source.question_reuse_allowed
        and item.review_status = 'approved'
    )
    and (
      (
        review_status = 'approved'
        and exists (
          select 1
          from public.past_paper_sources source
          join public.past_paper_discovery_items item
            on item.school_id = source.school_id and item.source_id = source.id
          where source.school_id = past_paper_catalogue_questions.school_id
            and source.id = past_paper_catalogue_questions.source_id
            and item.id = past_paper_catalogue_questions.discovery_item_id
            and source.status = 'active'
            and source.question_reuse_allowed
            and item.review_status = 'approved'
        )
      )
      or created_by = auth.uid()
      or public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
    )
  );

grant select on public.past_paper_catalogue_questions to authenticated;

alter table public.learning_questions
  add column catalogue_question_id uuid;

alter table public.learning_questions
  add constraint learning_questions_catalogue_question_fk
  foreign key (school_id, catalogue_question_id)
  references public.past_paper_catalogue_questions(school_id, id)
  on delete set null (catalogue_question_id);

create unique index learning_questions_school_catalogue_question_idx
  on public.learning_questions(school_id, catalogue_question_id)
  where catalogue_question_id is not null;

drop policy "Authors and department leads manage questions" on public.learning_questions;
create policy "Authors read currently eligible questions"
  on public.learning_questions for select to authenticated
  using (
    public.school_permission_allowed(school_id, 'learning', 'view')
    and (
      public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
      or (
        public.has_school_role(school_id, array['teacher']::public.app_role[])
        and created_by = auth.uid()
      )
      or (
        department_id is not null
        and public.is_hod_for_department(school_id, department_id)
      )
    )
    and (
      catalogue_question_id is null
      or exists (
        select 1
        from public.past_paper_catalogue_questions catalogue
        join public.past_paper_sources source
          on source.school_id = catalogue.school_id and source.id = catalogue.source_id
        join public.past_paper_discovery_items item
          on item.school_id = catalogue.school_id and item.id = catalogue.discovery_item_id
        where catalogue.school_id = learning_questions.school_id
          and catalogue.id = learning_questions.catalogue_question_id
          and catalogue.review_status = 'approved'
          and catalogue.validation_status = 'APPROVED'
          and catalogue.content_use_status = 'ELIGIBLE'
          and source.status = 'active'
          and source.question_reuse_allowed
          and item.review_status = 'approved'
      )
    )
  );

create policy "School staff create original questions"
  on public.learning_questions for insert to authenticated
  with check (
    public.school_permission_allowed(school_id, 'learning', 'create')
    and (
      public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
      or (
        public.has_school_role(school_id, array['teacher']::public.app_role[])
        and created_by = auth.uid()
      )
      or (
        department_id is not null
        and public.is_hod_for_department(school_id, department_id)
      )
    )
    and catalogue_question_id is null
  );

create policy "School staff update eligible questions"
  on public.learning_questions for update to authenticated
  using (
    public.school_permission_allowed(school_id, 'learning', 'edit')
    and (
      public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
      or (
        public.has_school_role(school_id, array['teacher']::public.app_role[])
        and created_by = auth.uid()
      )
      or (
        department_id is not null
        and public.is_hod_for_department(school_id, department_id)
      )
    )
    and (
      catalogue_question_id is null
      or exists (
        select 1
        from public.past_paper_catalogue_questions catalogue
        join public.past_paper_sources source
          on source.school_id = catalogue.school_id and source.id = catalogue.source_id
        join public.past_paper_discovery_items item
          on item.school_id = catalogue.school_id and item.id = catalogue.discovery_item_id
        where catalogue.school_id = learning_questions.school_id
          and catalogue.id = learning_questions.catalogue_question_id
          and catalogue.review_status = 'approved'
          and catalogue.validation_status = 'APPROVED'
          and catalogue.content_use_status = 'ELIGIBLE'
          and source.status = 'active'
          and source.question_reuse_allowed
          and item.review_status = 'approved'
      )
    )
  )
  with check (
    public.school_permission_allowed(school_id, 'learning', 'edit')
    and (
      public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
      or (
        public.has_school_role(school_id, array['teacher']::public.app_role[])
        and created_by = auth.uid()
      )
      or (
        department_id is not null
        and public.is_hod_for_department(school_id, department_id)
      )
    )
    and (
      catalogue_question_id is null
      or exists (
        select 1
        from public.past_paper_catalogue_questions catalogue
        join public.past_paper_sources source
          on source.school_id = catalogue.school_id and source.id = catalogue.source_id
        join public.past_paper_discovery_items item
          on item.school_id = catalogue.school_id and item.id = catalogue.discovery_item_id
        where catalogue.school_id = learning_questions.school_id
          and catalogue.id = learning_questions.catalogue_question_id
          and catalogue.review_status = 'approved'
          and catalogue.validation_status = 'APPROVED'
          and catalogue.content_use_status = 'ELIGIBLE'
          and source.status = 'active'
          and source.question_reuse_allowed
          and item.review_status = 'approved'
      )
    )
  );

create policy "School staff delete authored questions"
  on public.learning_questions for delete to authenticated
  using (
    public.school_permission_allowed(school_id, 'learning', 'delete')
    and (
      public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
      or (
        public.has_school_role(school_id, array['teacher']::public.app_role[])
        and created_by = auth.uid()
      )
      or (
        department_id is not null
        and public.is_hod_for_department(school_id, department_id)
      )
    )
  );

create or replace function public.guard_catalogue_question_provenance()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.catalogue_question_id is distinct from old.catalogue_question_id then
    raise exception 'Authorized catalogue question provenance cannot be changed.';
  end if;
  return new;
end;
$$;

create trigger guard_catalogue_question_provenance
before update on public.learning_questions
for each row execute function public.guard_catalogue_question_provenance();

create view public.past_paper_restricted_questions
with (security_invoker = true)
as
select
  catalogue.school_id,
  catalogue.id,
  question.id as learning_question_id,
  catalogue.question_text,
  source.name as source_name,
  source.name as registered_source_name,
  source.status as source_status,
  source.question_reuse_allowed,
  catalogue.review_status as catalogue_review_status,
  item.review_status as item_review_status
from public.past_paper_catalogue_questions catalogue
join public.past_paper_sources source
  on source.school_id = catalogue.school_id and source.id = catalogue.source_id
join public.past_paper_discovery_items item
  on item.school_id = catalogue.school_id and item.id = catalogue.discovery_item_id
left join public.learning_questions question
  on question.school_id = catalogue.school_id and question.catalogue_question_id = catalogue.id
where catalogue.review_status <> 'approved'
  or source.status <> 'active'
  or not source.question_reuse_allowed
  or item.review_status <> 'approved';

revoke all on public.past_paper_restricted_questions from public, anon, authenticated;
grant select on public.past_paper_restricted_questions to service_role;

create or replace function public.remove_restricted_past_paper_question(
  target_school uuid,
  target_catalogue_question uuid,
  target_actor uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  question_record record;
  correlation_id uuid := gen_random_uuid();
  removed_question_count integer;
begin
  if not exists (
    select 1
    from public.school_memberships membership
    where membership.school_id = target_school
      and membership.profile_id = target_actor
      and membership.role in ('school_admin', 'academic_coordinator')
  ) then
    raise exception 'Only a school administrator or academic coordinator can remove restricted questions.';
  end if;

  select
    catalogue.id as catalogue_id,
    catalogue.review_status as catalogue_status,
    source.status as source_status,
    source.question_reuse_allowed,
    item.review_status as item_status
  into question_record
  from public.past_paper_catalogue_questions catalogue
  join public.past_paper_sources source
    on source.school_id = catalogue.school_id and source.id = catalogue.source_id
  join public.past_paper_discovery_items item
    on item.school_id = catalogue.school_id and item.id = catalogue.discovery_item_id
  where catalogue.school_id = target_school
    and catalogue.id = target_catalogue_question
  for update of catalogue, source, item;

  if not found then
    raise exception 'The catalogue question was not found in this school.';
  end if;
  if question_record.catalogue_status = 'approved'
    and question_record.source_status = 'active'
    and question_record.question_reuse_allowed
    and question_record.item_status = 'approved' then
    raise exception 'The question is currently eligible for reuse and cannot be removed through restricted-content cleanup.';
  end if;

  delete from public.learning_questions
  where school_id = target_school and catalogue_question_id = target_catalogue_question;
  get diagnostics removed_question_count = row_count;
  delete from public.past_paper_catalogue_questions
  where school_id = target_school and id = target_catalogue_question;

  insert into public.audit_logs (
    school_id, actor_id, action, target_table, target_id, metadata
  ) values (
    target_school,
    target_actor,
    'restricted_past_paper_question_removed',
    'past_paper_catalogue_questions',
    target_catalogue_question,
    jsonb_build_object(
      'correlation_id', correlation_id,
      'removed_learning_question_count', removed_question_count
    )
  );
  return correlation_id;
end;
$$;

revoke all on function public.remove_restricted_past_paper_question(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.remove_restricted_past_paper_question(uuid, uuid, uuid) to service_role;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'past_paper_sources',
    'past_paper_discovery_jobs',
    'past_paper_discovery_items',
    'past_paper_catalogue_questions'
  ]
  loop
    execute format(
      'create trigger audit_school_record_change after insert or update or delete on public.%I for each row execute function public.log_school_record_change()',
      table_name
    );
  end loop;
end;
$$;

notify pgrst, 'reload schema';

alter table public.past_paper_sources
  add column document_download_allowed boolean not null default false,
  add column document_storage_allowed boolean not null default false,
  add column ocr_allowed boolean not null default false,
  add column curriculum text check (curriculum in (
    'Cambridge Primary', 'Cambridge Lower Secondary', 'O Level',
    'IGCSE', 'AS Level', 'A Level'
  )),
  add column subject_name text check (subject_name is null or length(subject_name) <= 160),
  add column syllabus_code text check (syllabus_code is null or length(syllabus_code) <= 40),
  add column syllabus_version text check (syllabus_version is null or length(syllabus_version) <= 80),
  add column schedule_enabled boolean not null default false,
  add column schedule_interval_hours integer not null default 24 check (schedule_interval_hours between 1 and 720),
  add column next_discovery_at timestamptz not null default timezone('utc', now()),
  add column document_max_bytes integer not null default 52428800 check (document_max_bytes between 1024 and 52428800),
  add constraint paper_source_storage_requires_download check (
    not document_storage_allowed or document_download_allowed
  ),
  add constraint paper_source_ocr_requires_extraction check (
    not ocr_allowed or (document_download_allowed and document_storage_allowed and question_extraction_allowed)
  );

alter table public.past_paper_discovery_items
  add column original_url text,
  add column pipeline_status text not null default 'DISCOVERED'
    check (pipeline_status in (
      'DISCOVERED', 'DOWNLOADED', 'EXTRACTED', 'VALIDATING', 'NEEDS_REVIEW',
      'APPROVED', 'REJECTED', 'DUPLICATE', 'SOURCE_UNAVAILABLE', 'PERMISSION_BLOCKED'
    )),
  add column curriculum text check (curriculum in (
    'Cambridge Primary', 'Cambridge Lower Secondary', 'O Level',
    'IGCSE', 'AS Level', 'A Level'
  )),
  add column subject_name text check (subject_name is null or length(subject_name) <= 160),
  add column syllabus_code text check (syllabus_code is null or length(syllabus_code) <= 40),
  add column syllabus_version text check (syllabus_version is null or length(syllabus_version) <= 80),
  add column examination_year integer check (examination_year between 1900 and 2200),
  add column examination_session text check (examination_session in ('m', 's', 'w')),
  add column paper_number text check (paper_number is null or length(paper_number) <= 30),
  add column variant text check (variant is null or length(variant) <= 30),
  add column download_attempts integer not null default 0 check (download_attempts >= 0),
  add column next_retry_at timestamptz,
  add column lease_expires_at timestamptz,
  add column lease_document_path text,
  add column lease_extraction_path text,
  add column failure_reason text,
  add column document_sha256 text check (document_sha256 ~ '^[0-9a-f]{64}$'),
  add column duplicate_document_id uuid,
  add column updated_at timestamptz not null default timezone('utc', now());

create index past_paper_items_work_queue_idx
  on public.past_paper_discovery_items(pipeline_status, next_retry_at, created_at)
  where pipeline_status in ('DISCOVERED', 'SOURCE_UNAVAILABLE');

create table public.past_paper_documents (
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

create index past_paper_documents_school_source_idx
  on public.past_paper_documents(school_id, source_id, created_at desc);

alter table public.past_paper_documents enable row level security;

create policy "School learning staff read paper document metadata"
  on public.past_paper_documents for select to authenticated
  using (
    public.is_school_member(school_id)
    and public.school_permission_allowed(school_id, 'learning', 'view')
  );

grant select on public.past_paper_documents to authenticated;

create table public.past_paper_document_pages (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  document_id uuid not null,
  page_number integer not null check (page_number > 0),
  text_content text not null default '',
  tables jsonb not null default '[]'::jsonb check (jsonb_typeof(tables) = 'array'),
  diagram_references jsonb not null default '[]'::jsonb check (jsonb_typeof(diagram_references) = 'array'),
  extraction_method text not null check (extraction_method in ('pdf-text', 'ocr', 'mixed', 'empty')),
  ocr_confidence numeric(5,2) check (ocr_confidence between 0 and 100),
  needs_review boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, document_id, page_number),
  foreign key (school_id, document_id)
    references public.past_paper_documents(school_id, id) on delete cascade
);

create index past_paper_document_pages_document_page_idx
  on public.past_paper_document_pages(school_id, document_id, page_number);

alter table public.past_paper_document_pages enable row level security;

create policy "School learning staff read paper extraction pages"
  on public.past_paper_document_pages for select to authenticated
  using (
    public.is_school_member(school_id)
    and public.school_permission_allowed(school_id, 'learning', 'view')
  );

grant select on public.past_paper_document_pages to authenticated;

alter table public.past_paper_catalogue_questions
  alter column topic drop not null,
  alter column marks drop not null,
  add column document_id uuid,
  add column parent_question_id uuid,
  add column question_number text,
  add column page_start integer,
  add column page_end integer,
  add column curriculum text check (curriculum in (
    'Cambridge Primary', 'Cambridge Lower Secondary', 'O Level',
    'IGCSE', 'AS Level', 'A Level'
  )),
  add column syllabus_version text,
  add column syllabus_topic_id uuid,
  add column classification_confidence numeric(5,2) check (classification_confidence between 0 and 100),
  add column classification_status text not null default 'NEEDS_REVIEW'
    check (classification_status in ('CLASSIFIED', 'NEEDS_REVIEW')),
  add column extraction_status text not null default 'NEEDS_REVIEW'
    check (extraction_status in ('COMPLETE', 'NEEDS_REVIEW', 'INCOMPLETE')),
  add column content_use_status text not null default 'NOT_REVIEWED'
    check (content_use_status in ('NOT_REVIEWED', 'ELIGIBLE', 'BLOCKED')),
  add column validation_status text not null default 'NEEDS_REVIEW'
    check (validation_status in (
      'DISCOVERED', 'DOWNLOADED', 'EXTRACTED', 'VALIDATING', 'NEEDS_REVIEW',
      'APPROVED', 'REJECTED', 'DUPLICATE', 'SOURCE_UNAVAILABLE', 'PERMISSION_BLOCKED'
    )),
  add column question_structure jsonb not null default '{}'::jsonb check (jsonb_typeof(question_structure) = 'object'),
  add column duplicate_of uuid,
  add column similarity_score numeric(5,2) check (similarity_score between 0 and 100),
  add column validation_reasons text[] not null default '{}',
  add column reviewer_note text not null default '' check (length(reviewer_note) <= 2000),
  add column validated_at timestamptz,
  add column validated_by uuid references public.profiles(id),
  add constraint catalogue_question_page_range check (
    (page_start is null and page_end is null) or
    (page_start > 0 and page_end >= page_start)
  ),
  add column diagram_references jsonb not null default '[]'::jsonb
    check (jsonb_typeof(diagram_references) = 'array'),
  add column validation_correlation_id uuid;

alter table public.past_paper_catalogue_questions
  add constraint past_paper_catalogue_document_fk
  foreign key (school_id, document_id)
  references public.past_paper_documents(school_id, id) on delete cascade,
  add constraint past_paper_catalogue_parent_fk
  foreign key (school_id, parent_question_id)
  references public.past_paper_catalogue_questions(school_id, id) on delete cascade,
  add constraint past_paper_catalogue_duplicate_fk
  foreign key (school_id, duplicate_of)
  references public.past_paper_catalogue_questions(school_id, id) on delete set null (duplicate_of);

create index past_paper_catalogue_testmaker_idx
  on public.past_paper_catalogue_questions(
    school_id, curriculum, syllabus_code, examination_year, examination_session,
    topic, subtopic, review_status, validation_status, content_use_status
  );

create index past_paper_catalogue_document_parts_idx
  on public.past_paper_catalogue_questions(school_id, document_id, question_number, page_start);

create table public.past_paper_validation_events (
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
create policy "School learning staff read paper validation events"
  on public.past_paper_validation_events for select to authenticated
  using (
    public.is_school_member(school_id)
    and public.school_permission_allowed(school_id, 'learning', 'view')
  );
grant select on public.past_paper_validation_events to authenticated;

alter table public.past_paper_discovery_items
  add constraint past_paper_duplicate_document_fk
  foreign key (school_id, duplicate_document_id)
  references public.past_paper_documents(school_id, id) on delete set null (duplicate_document_id);

create table public.past_paper_syllabus_topics (
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

alter table public.past_paper_catalogue_questions
  add constraint past_paper_catalogue_syllabus_topic_fk
  foreign key (syllabus_topic_id) references public.past_paper_syllabus_topics(id) on delete set null;

create index past_paper_syllabus_lookup_idx
  on public.past_paper_syllabus_topics(curriculum, syllabus_code, syllabus_version);

alter table public.past_paper_syllabus_topics enable row level security;

create policy "School members read verified syllabus topics"
  on public.past_paper_syllabus_topics for select to authenticated
  using (auth.uid() is not null);

grant select on public.past_paper_syllabus_topics to authenticated;

create table public.past_paper_syllabus_history (
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

create trigger audit_past_paper_syllabus_topic_change
after insert or update or delete on public.past_paper_syllabus_topics
for each row execute function public.audit_past_paper_syllabus_topic();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('past-paper-documents', 'past-paper-documents', false, 52428800, array['application/pdf', 'application/json'])
on conflict (id) do update set public = false, file_size_limit = 52428800, allowed_mime_types = array['application/pdf', 'application/json'];

create policy "School members read authorized past-paper objects"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'past-paper-documents'
    and (storage.foldername(name))[1] ~* '^[0-9a-f-]{36}$'
    and public.is_school_member(((storage.foldername(name))[1])::uuid)
    and public.school_permission_allowed(((storage.foldername(name))[1])::uuid, 'learning', 'view')
    and exists (
      select 1
      from public.past_paper_documents document
      join public.past_paper_sources source
        on source.school_id = document.school_id and source.id = document.source_id
      join public.past_paper_discovery_items item
        on item.school_id = document.school_id and item.id = document.discovery_item_id
      where document.school_id = ((storage.foldername(name))[1])::uuid
        and (document.storage_path = name or document.extraction_storage_path = name)
        and source.status = 'active'
        and source.document_storage_allowed
        and item.pipeline_status in ('DOWNLOADED', 'EXTRACTED', 'VALIDATING', 'NEEDS_REVIEW', 'APPROVED')
    )
  );

grant select on public.past_paper_documents, public.past_paper_document_pages to authenticated;

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
    where item.pipeline_status in ('DISCOVERED', 'SOURCE_UNAVAILABLE')
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
      lease_expires_at = now() + interval '10 minutes',
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
