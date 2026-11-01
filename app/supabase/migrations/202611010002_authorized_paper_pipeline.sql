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
