-- Curriculum Intelligence core data model and controlled source-file lifecycle.
create table public.curriculum_documents (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  academic_year_id uuid not null,
  subject_id uuid not null,
  uploaded_by uuid not null references public.profiles(id),
  title text not null check (char_length(trim(title)) between 2 and 180),
  curriculum_type text not null default 'Cambridge',
  syllabus_code text not null default '',
  category text not null default 'syllabus'
    check (category in ('syllabus', 'scheme_of_work', 'teaching_plan', 'other')),
  teaching_language text not null default '',
  notes text not null default '' check (char_length(notes) <= 5000),
  original_file_name text,
  original_content_type text,
  original_size_bytes bigint check (original_size_bytes is null or original_size_bytes between 0 and 52428800),
  source_sha256 text check (source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$'),
  temporary_storage_path text,
  status text not null default 'draft'
    check (status in ('draft', 'uploaded', 'queued', 'processing', 'needs_review', 'approved', 'rejected', 'failed', 'source_deleted', 'deletion_failed', 'expired')),
  source_deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, academic_year_id) references public.academic_years(school_id, id) on delete restrict,
  foreign key (school_id, subject_id) references public.subjects(school_id, id) on delete restrict,
  check (
    status in ('draft', 'failed')
    or (original_file_name is not null and original_content_type is not null and original_size_bytes is not null)
  ),
  check (
    (source_deleted_at is null and temporary_storage_path is not null)
    or (source_deleted_at is not null and temporary_storage_path is null)
    or status in ('draft', 'expired')
  )
);

create index curriculum_documents_school_year_idx
  on public.curriculum_documents(school_id, academic_year_id, status, updated_at desc);
create index curriculum_documents_school_subject_idx
  on public.curriculum_documents(school_id, subject_id, updated_at desc);
create index curriculum_documents_expiry_idx
  on public.curriculum_documents(updated_at)
  where status in ('draft', 'uploaded', 'failed');
create unique index curriculum_documents_source_hash_idx
  on public.curriculum_documents(school_id, source_sha256)
  where source_sha256 is not null;

create table public.curriculum_document_assignments (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  document_id uuid not null,
  academic_year_id uuid not null,
  year_group text not null check (char_length(trim(year_group)) between 1 and 80),
  class_id uuid,
  class_key text generated always as (coalesce(class_id::text, 'year_group')) stored,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, document_id, academic_year_id, year_group, class_key),
  foreign key (school_id, document_id) references public.curriculum_documents(school_id, id) on delete cascade,
  foreign key (school_id, academic_year_id) references public.academic_years(school_id, id) on delete restrict,
  foreign key (school_id, class_id) references public.school_classes(school_id, id) on delete cascade
);

create index curriculum_assignments_class_idx
  on public.curriculum_document_assignments(school_id, class_id, academic_year_id);

create table public.curriculum_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  document_id uuid not null,
  claimed_from_status text check (claimed_from_status is null or claimed_from_status in ('queued', 'ready_to_delete', 'source_deletion_failed')),
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'needs_review', 'failed', 'ready_to_delete', 'source_deletion_failed', 'source_deleted')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  idempotency_key text not null,
  manifest jsonb not null default '{}'::jsonb check (jsonb_typeof(manifest) = 'object'),
  error_message text not null default '',
  claimed_at timestamptz,
  completed_at timestamptz,
  source_deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, document_id, idempotency_key),
  foreign key (school_id, document_id) references public.curriculum_documents(school_id, id) on delete cascade
);

create index curriculum_processing_jobs_queue_idx
  on public.curriculum_processing_jobs(status, created_at)
  where status in ('queued', 'failed', 'ready_to_delete', 'source_deletion_failed');
create index curriculum_processing_jobs_stale_idx
  on public.curriculum_processing_jobs(claimed_at)
  where status = 'processing';

create table public.curriculum_source_units (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  document_id uuid not null,
  job_id uuid not null,
  unit_kind text not null check (unit_kind in ('page', 'slide', 'worksheet', 'text')),
  unit_reference text not null,
  unit_number integer not null check (unit_number > 0),
  extracted_text text not null default '',
  extracted_tables jsonb not null default '[]'::jsonb check (jsonb_typeof(extracted_tables) = 'array'),
  extraction_method text not null default 'text',
  extraction_confidence numeric(5,2) check (extraction_confidence is null or extraction_confidence between 0 and 100),
  needs_review boolean not null default false,
  review_status text not null default 'pending' check (review_status in ('pending', 'approved', 'needs_correction')),
  warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(warnings) = 'array'),
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, document_id, unit_reference),
  foreign key (school_id, document_id) references public.curriculum_documents(school_id, id) on delete cascade,
  foreign key (school_id, job_id) references public.curriculum_processing_jobs(school_id, id) on delete cascade
);

create index curriculum_source_units_document_idx
  on public.curriculum_source_units(school_id, document_id, unit_number);

create table public.curriculum_topics (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  document_id uuid not null,
  parent_topic_id uuid,
  source_unit_id uuid,
  name text not null check (char_length(trim(name)) between 1 and 500),
  corrected_name text not null default '',
  origin text not null default 'extracted' check (origin in ('extracted', 'ai', 'teacher')),
  section_number text not null default '',
  original_text text not null default '',
  extraction_confidence numeric(5,2) check (extraction_confidence is null or extraction_confidence between 0 and 100),
  review_status text not null default 'pending' check (review_status in ('pending', 'approved', 'rejected', 'needs_correction')),
  sort_order integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, document_id) references public.curriculum_documents(school_id, id) on delete cascade,
  foreign key (school_id, parent_topic_id) references public.curriculum_topics(school_id, id) on delete cascade,
  foreign key (school_id, source_unit_id) references public.curriculum_source_units(school_id, id) on delete set null (source_unit_id)
);

create index curriculum_topics_document_idx
  on public.curriculum_topics(school_id, document_id, sort_order);

create table public.curriculum_objectives (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  document_id uuid not null,
  topic_id uuid,
  source_unit_id uuid,
  section_number text not null default '',
  objective_type text not null default 'core'
    check (objective_type in ('core', 'supplement', 'practical', 'assessment', 'teaching_guidance', 'other')),
  origin text not null default 'extracted' check (origin in ('extracted', 'ai', 'teacher')),
  original_text text not null check (char_length(trim(original_text)) between 1 and 5000),
  corrected_text text not null default '',
  simplified_text text not null default '',
  extraction_confidence numeric(5,2) check (extraction_confidence is null or extraction_confidence between 0 and 100),
  review_status text not null default 'pending' check (review_status in ('pending', 'approved', 'rejected', 'needs_correction')),
  sort_order integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, document_id) references public.curriculum_documents(school_id, id) on delete cascade,
  foreign key (school_id, topic_id) references public.curriculum_topics(school_id, id) on delete set null (topic_id),
  foreign key (school_id, source_unit_id) references public.curriculum_source_units(school_id, id) on delete set null (source_unit_id)
);

create index curriculum_objectives_document_idx
  on public.curriculum_objectives(school_id, document_id, review_status, sort_order);
create index curriculum_objectives_topic_idx
  on public.curriculum_objectives(school_id, topic_id);

create table public.curriculum_lesson_objectives (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  syllabus_objective_id uuid not null,
  assignment_id uuid,
  objective_text text not null check (char_length(trim(objective_text)) between 1 and 2000),
  prerequisites text not null default '',
  measurable_outcomes jsonb not null default '[]'::jsonb check (jsonb_typeof(measurable_outcomes) = 'array'),
  suggested_activities jsonb not null default '[]'::jsonb check (jsonb_typeof(suggested_activities) = 'array'),
  assessment_evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(assessment_evidence) = 'array'),
  origin text not null default 'deterministic' check (origin in ('deterministic', 'ai', 'teacher')),
  review_status text not null default 'draft' check (review_status in ('draft', 'approved', 'rejected')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, syllabus_objective_id) references public.curriculum_objectives(school_id, id) on delete cascade,
  foreign key (school_id, assignment_id) references public.curriculum_document_assignments(school_id, id) on delete set null (assignment_id)
);

create index curriculum_lesson_objectives_source_idx
  on public.curriculum_lesson_objectives(school_id, syllabus_objective_id, review_status);

create table public.curriculum_templates (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  template_key uuid not null default gen_random_uuid(),
  version integer not null default 1 check (version > 0),
  name text not null check (char_length(trim(name)) between 2 and 160),
  description text not null default '',
  category text not null check (category in (
    'lesson_plan', 'lesson_notes', 'worksheet', 'homework', 'quiz', 'class_test',
    'midterm_exam', 'end_term_exam', 'mock_exam', 'revision', 'practical',
    'mark_scheme', 'rubric', 'progress_report', 'department_report'
  )),
  subject_id uuid,
  year_groups text[] not null default '{}',
  examination_board text not null default '',
  document_format text not null default 'html' check (document_format in ('html', 'json', 'pdf')),
  sections jsonb not null default '[]'::jsonb check (jsonb_typeof(sections) = 'array'),
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  is_approved boolean not null default false,
  is_locked boolean not null default false,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, template_key, version),
  foreign key (school_id, subject_id) references public.subjects(school_id, id) on delete set null (subject_id)
);

create index curriculum_templates_school_category_idx
  on public.curriculum_templates(school_id, category, is_approved, name);

create table public.curriculum_teaching_plans (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  academic_year_id uuid not null,
  assignment_id uuid not null,
  subject_id uuid not null,
  class_id uuid,
  title text not null check (char_length(trim(title)) between 2 and 180),
  status text not null default 'draft' check (status in ('draft', 'approved', 'archived')),
  capacity_report jsonb not null default '{}'::jsonb check (jsonb_typeof(capacity_report) = 'object'),
  created_by uuid not null references public.profiles(id),
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, academic_year_id) references public.academic_years(school_id, id) on delete restrict,
  foreign key (school_id, assignment_id) references public.curriculum_document_assignments(school_id, id) on delete restrict,
  foreign key (school_id, subject_id) references public.subjects(school_id, id) on delete restrict,
  foreign key (school_id, class_id) references public.school_classes(school_id, id) on delete set null (class_id)
);

create table public.curriculum_teaching_plan_entries (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  plan_id uuid not null,
  topic_id uuid,
  syllabus_objective_id uuid,
  lesson_objective_id uuid,
  term_id uuid,
  week_number integer check (week_number is null or week_number > 0),
  planned_start date,
  planned_end date,
  estimated_periods numeric(5,2) not null default 1 check (estimated_periods > 0),
  resources jsonb not null default '[]'::jsonb check (jsonb_typeof(resources) = 'array'),
  assessment_checkpoints jsonb not null default '[]'::jsonb check (jsonb_typeof(assessment_checkpoints) = 'array'),
  position integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, plan_id) references public.curriculum_teaching_plans(school_id, id) on delete cascade,
  foreign key (school_id, topic_id) references public.curriculum_topics(school_id, id) on delete set null (topic_id),
  foreign key (school_id, syllabus_objective_id) references public.curriculum_objectives(school_id, id) on delete set null (syllabus_objective_id),
  foreign key (school_id, lesson_objective_id) references public.curriculum_lesson_objectives(school_id, id) on delete set null (lesson_objective_id),
  foreign key (school_id, term_id) references public.terms(school_id, id) on delete set null (term_id),
  check (planned_end is null or planned_start is null or planned_end >= planned_start)
);

create table public.curriculum_coverage_records (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  assignment_id uuid not null,
  class_id uuid not null,
  syllabus_objective_id uuid not null,
  lesson_objective_id uuid,
  lesson_id uuid,
  coverage_status text not null check (coverage_status in ('fully_covered', 'partially_covered', 'not_covered')),
  lesson_date date not null default current_date,
  notes text not null default '' check (char_length(notes) <= 5000),
  recorded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, assignment_id) references public.curriculum_document_assignments(school_id, id) on delete cascade,
  foreign key (school_id, class_id) references public.school_classes(school_id, id) on delete cascade,
  foreign key (school_id, syllabus_objective_id) references public.curriculum_objectives(school_id, id) on delete cascade,
  foreign key (school_id, lesson_objective_id) references public.curriculum_lesson_objectives(school_id, id) on delete set null (lesson_objective_id),
  foreign key (school_id, lesson_id) references public.course_lessons(school_id, id) on delete set null (lesson_id)
);

create index curriculum_coverage_class_date_idx
  on public.curriculum_coverage_records(school_id, class_id, lesson_date desc);
create index curriculum_coverage_objective_idx
  on public.curriculum_coverage_records(school_id, syllabus_objective_id, coverage_status);

create table public.curriculum_assessment_objectives (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  assessment_id uuid not null,
  syllabus_objective_id uuid not null,
  question_id uuid,
  foreign key (school_id, assessment_id) references public.learning_assessments(school_id, id) on delete cascade,
  foreign key (school_id, syllabus_objective_id) references public.curriculum_objectives(school_id, id) on delete cascade,
  foreign key (school_id, question_id) references public.learning_questions(school_id, id) on delete cascade
);

create or replace function public.can_manage_curriculum(
  target_school uuid,
  target_subject uuid,
  target_class uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.has_school_role(target_school, array['school_admin', 'academic_coordinator']::public.app_role[])
    or public.is_hod_for_subject(target_school, target_subject)
    or exists (
      select 1
      from public.teacher_profiles teacher
      join public.teacher_subjects subject_assignment
        on subject_assignment.school_id = teacher.school_id
       and subject_assignment.teacher_id = teacher.id
      where teacher.school_id = target_school
        and teacher.profile_id = auth.uid()
        and teacher.status = 'active'
        and subject_assignment.subject_id = target_subject
        and (
          target_class is null
          or (
            public.is_teacher_for_class(target_school, target_class)
            and exists (
              select 1 from public.class_subjects class_subject
              where class_subject.school_id = target_school
                and class_subject.class_id = target_class
                and class_subject.subject_id = target_subject
            )
          )
        )
    );
$$;

create or replace function public.can_view_curriculum_document(
  target_school uuid,
  target_subject uuid,
  target_owner uuid,
  target_status text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.has_school_role(target_school, array['school_admin', 'academic_coordinator']::public.app_role[])
    or public.is_hod_for_subject(target_school, target_subject)
    or target_owner = auth.uid()
    or (
      target_status in ('approved', 'source_deleted')
      and public.can_manage_curriculum(target_school, target_subject)
    );
$$;

create or replace function public.validate_curriculum_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  document_subject uuid;
  document_year uuid;
  class_year uuid;
  class_grade text;
begin
  select subject_id, academic_year_id
    into document_subject, document_year
  from public.curriculum_documents
  where school_id = new.school_id and id = new.document_id;
  if not found or document_year <> new.academic_year_id then
    raise exception 'Choose the academic year selected for this curriculum document.';
  end if;
  if new.class_id is not null then
    select academic_year_id, grade_level
      into class_year, class_grade
    from public.school_classes
    where school_id = new.school_id and id = new.class_id;
    if not found or class_year is distinct from new.academic_year_id then
      raise exception 'The selected class must belong to the chosen academic year.';
    end if;
    if class_grade is not null and lower(trim(class_grade)) <> lower(trim(new.year_group)) then
      raise exception 'The selected year group must match the class grade level.';
    end if;
    if not public.can_manage_curriculum(new.school_id, document_subject, new.class_id) then
      raise exception 'You are not authorized to assign this subject to the selected class.';
    end if;
  elsif not public.can_manage_curriculum(new.school_id, document_subject) then
    raise exception 'You are not authorized to manage this subject curriculum.';
  end if;
  return new;
end;
$$;

create trigger validate_curriculum_assignment
  before insert or update on public.curriculum_document_assignments
  for each row execute function public.validate_curriculum_assignment();

create table public.curriculum_audit_events (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  document_id uuid,
  actor_id uuid references public.profiles(id) on delete set null,
  event_type text not null,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, document_id) references public.curriculum_documents(school_id, id) on delete set null (document_id)
);

create index curriculum_audit_events_school_recent_idx
  on public.curriculum_audit_events(school_id, created_at desc);

create or replace function public.submit_curriculum_document(target_document uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.curriculum_documents%rowtype;
  saved_job uuid;
begin
  select * into target
  from public.curriculum_documents
  where id = target_document
  for update;
  if not found or not public.can_manage_curriculum(target.school_id, target.subject_id) then
    raise exception 'Curriculum document not found or access denied.';
  end if;
  if target.status not in ('uploaded', 'failed') or target.temporary_storage_path is null then
    raise exception 'Upload a valid source document before processing.';
  end if;
  insert into public.curriculum_processing_jobs (school_id, document_id, idempotency_key)
  values (target.school_id, target.id, coalesce(target.source_sha256, target.id::text))
  on conflict (school_id, document_id, idempotency_key)
  do update set status = 'queued', error_message = '', updated_at = timezone('utc', now())
  returning id into saved_job;
  return saved_job;
end;
$$;

create or replace function public.attach_curriculum_source(
  target_document uuid,
  file_name text,
  content_type text,
  size_bytes bigint,
  source_hash text,
  storage_path text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.curriculum_documents%rowtype;
begin
  select * into target from public.curriculum_documents
  where id = target_document
  for update;
  if not found or target.status <> 'draft'
    or not public.can_manage_curriculum(target.school_id, target.subject_id) then
    raise exception 'An authorized curriculum draft is required.';
  end if;
  if char_length(trim(coalesce(file_name, ''))) not between 1 and 255
    or char_length(coalesce(content_type, '')) > 255
    or size_bytes is null or size_bytes not between 1 and 52428800
    or source_hash is null or source_hash !~ '^[0-9a-f]{64}$'
    or split_part(coalesce(storage_path, ''), '/', 1) <> target.school_id::text
    or split_part(coalesce(storage_path, ''), '/', 2) <> target.id::text
    or array_length(string_to_array(coalesce(storage_path, ''), '/'), 1) <> 3
    or split_part(coalesce(storage_path, ''), '/', 3) in ('', '.', '..')
    or position(chr(92) in coalesce(storage_path, '')) > 0
    or (target.source_sha256 is not null and target.source_sha256 <> source_hash) then
    raise exception 'The source-file metadata or restricted storage path is invalid.';
  end if;
  update public.curriculum_documents
  set original_file_name = trim(file_name),
      original_content_type = coalesce(nullif(trim(content_type), ''), 'application/octet-stream'),
      original_size_bytes = size_bytes,
      source_sha256 = source_hash,
      temporary_storage_path = storage_path,
      updated_at = timezone('utc', now())
  where id = target.id;
end;
$$;

create or replace function public.mark_curriculum_uploaded(target_document uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.curriculum_documents%rowtype;
begin
  select * into target from public.curriculum_documents
  where id = target_document
  for update;
  if not found or target.status <> 'draft'
    or not public.can_manage_curriculum(target.school_id, target.subject_id) then
    raise exception 'An authorized draft upload is required.';
  end if;
  if target.temporary_storage_path is null or not exists (
    select 1 from storage.objects object
    where object.bucket_id = 'curriculum-temporary'
      and object.name = target.temporary_storage_path
  ) then
    raise exception 'The temporary source file is not present in restricted storage.';
  end if;
  update public.curriculum_documents
  set status = 'uploaded', updated_at = timezone('utc', now())
  where id = target.id;
  insert into public.curriculum_audit_events (school_id, document_id, actor_id, event_type, details)
  values (target.school_id, target.id, auth.uid(), 'source_uploaded',
    jsonb_build_object('file_name', target.original_file_name, 'size_bytes', target.original_size_bytes));
end;
$$;

create or replace function public.review_curriculum_objective(
  target_objective uuid,
  new_text text,
  new_review_status text,
  new_simplified_text text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.curriculum_objectives%rowtype;
  document_status text;
begin
  select objective.* into target
  from public.curriculum_objectives objective
  where objective.id = target_objective
  for update;
  select status into document_status
  from public.curriculum_documents
  where school_id = target.school_id and id = target.document_id;
  if not found or document_status <> 'needs_review'
    or not public.can_manage_curriculum(target.school_id, (
      select subject_id from public.curriculum_documents
      where school_id = target.school_id and id = target.document_id
    )) then
    raise exception 'Curriculum objective not found or access denied.';
  end if;
  if new_review_status not in ('pending', 'approved', 'rejected', 'needs_correction')
    or char_length(trim(coalesce(new_text, ''))) not between 1 and 5000 then
    raise exception 'Enter objective text and a valid review decision.';
  end if;
  update public.curriculum_objectives
  set corrected_text = case when trim(new_text) = original_text then '' else trim(new_text) end,
      simplified_text = coalesce(new_simplified_text, simplified_text),
      review_status = new_review_status,
      updated_at = timezone('utc', now())
  where id = target.id;
  insert into public.curriculum_audit_events (school_id, document_id, actor_id, event_type, details)
  values (target.school_id, target.document_id, auth.uid(), 'objective_reviewed',
    jsonb_build_object('objective_id', target.id, 'review_status', new_review_status));
end;
$$;

create or replace function public.review_curriculum_source_unit(
  target_source_unit uuid,
  new_review_status text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.curriculum_source_units%rowtype;
  document_status text;
  document_subject uuid;
begin
  select * into target from public.curriculum_source_units
  where id = target_source_unit
  for update;
  select status, subject_id into document_status, document_subject
  from public.curriculum_documents
  where school_id = target.school_id and id = target.document_id;
  if not found or document_status <> 'needs_review'
    or not public.can_manage_curriculum(target.school_id, document_subject) then
    raise exception 'An editable curriculum review is required to review this source unit.';
  end if;
  if new_review_status not in ('approved', 'needs_correction') then
    raise exception 'Choose whether the source unit is reviewed or needs correction.';
  end if;
  update public.curriculum_source_units
  set review_status = new_review_status
  where id = target.id;
  insert into public.curriculum_audit_events (school_id, document_id, actor_id, event_type, details)
  values (target.school_id, target.document_id, auth.uid(), 'source_unit_reviewed',
    jsonb_build_object('source_unit_id', target.id, 'review_status', new_review_status));
end;
$$;

create or replace function public.add_curriculum_objective(
  target_document uuid,
  target_topic uuid,
  target_source_unit uuid,
  new_text text,
  new_section_number text,
  new_objective_type text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.curriculum_documents%rowtype;
  saved_id uuid;
begin
  select * into target from public.curriculum_documents
  where id = target_document;
  if not found or target.status <> 'needs_review'
    or not public.can_manage_curriculum(target.school_id, target.subject_id) then
    raise exception 'An editable curriculum review is required to add an objective.';
  end if;
  if char_length(trim(coalesce(new_text, ''))) not between 1 and 5000
    or char_length(coalesce(new_section_number, '')) > 80
    or new_objective_type not in ('core', 'supplement', 'practical', 'assessment', 'teaching_guidance', 'other') then
    raise exception 'Enter valid objective wording, section and type.';
  end if;
  if target_topic is not null and not exists (
    select 1 from public.curriculum_topics
    where school_id = target.school_id and document_id = target.id and id = target_topic
  ) then
    raise exception 'The selected topic does not belong to this curriculum document.';
  end if;
  if target_source_unit is not null and not exists (
    select 1 from public.curriculum_source_units
    where school_id = target.school_id and document_id = target.id and id = target_source_unit
  ) then
    raise exception 'The selected source reference does not belong to this curriculum document.';
  end if;
  insert into public.curriculum_objectives (
    school_id, document_id, topic_id, source_unit_id, section_number,
    objective_type, origin, original_text, review_status, sort_order
  ) values (
    target.school_id, target.id, target_topic, target_source_unit,
    trim(coalesce(new_section_number, '')), new_objective_type, 'teacher',
    trim(new_text), 'pending',
    (select coalesce(max(sort_order), 0) + 1 from public.curriculum_objectives
      where school_id = target.school_id and document_id = target.id)
  )
  returning id into saved_id;
  insert into public.curriculum_audit_events (school_id, document_id, actor_id, event_type, details)
  values (target.school_id, target.id, auth.uid(), 'objective_added',
    jsonb_build_object('objective_id', saved_id, 'origin', 'teacher'));
  return saved_id;
end;
$$;

create or replace function public.add_curriculum_topic(
  target_document uuid,
  target_source_unit uuid,
  new_name text,
  new_section_number text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.curriculum_documents%rowtype;
  saved_id uuid;
begin
  select * into target from public.curriculum_documents
  where id = target_document;
  if not found or target.status <> 'needs_review'
    or not public.can_manage_curriculum(target.school_id, target.subject_id) then
    raise exception 'An editable curriculum review is required to add a topic.';
  end if;
  if char_length(trim(coalesce(new_name, ''))) not between 1 and 500
    or char_length(coalesce(new_section_number, '')) > 80 then
    raise exception 'Enter a topic name and a valid section number.';
  end if;
  if target_source_unit is not null and not exists (
    select 1 from public.curriculum_source_units
    where school_id = target.school_id and document_id = target.id and id = target_source_unit
  ) then
    raise exception 'The selected source reference does not belong to this curriculum document.';
  end if;
  insert into public.curriculum_topics (
    school_id, document_id, source_unit_id, name, origin, section_number,
    original_text, review_status, sort_order
  ) values (
    target.school_id, target.id, target_source_unit, trim(new_name), 'teacher',
    trim(coalesce(new_section_number, '')), trim(new_name), 'pending',
    (select coalesce(max(sort_order), 0) + 1 from public.curriculum_topics
      where school_id = target.school_id and document_id = target.id)
  )
  returning id into saved_id;
  insert into public.curriculum_audit_events (school_id, document_id, actor_id, event_type, details)
  values (target.school_id, target.id, auth.uid(), 'topic_added',
    jsonb_build_object('topic_id', saved_id, 'origin', 'teacher'));
  return saved_id;
end;
$$;

create or replace function public.review_curriculum_topic(
  target_topic uuid,
  new_name text,
  new_review_status text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.curriculum_topics%rowtype;
  target_subject uuid;
  document_status text;
begin
  select topic.* into target
  from public.curriculum_topics topic
  where topic.id = target_topic
  for update;
  select subject_id, status into target_subject, document_status
  from public.curriculum_documents
  where school_id = target.school_id and id = target.document_id;
  if not found or document_status <> 'needs_review'
    or not public.can_manage_curriculum(target.school_id, target_subject) then
    raise exception 'Curriculum topic not found or access denied.';
  end if;
  if new_review_status not in ('pending', 'approved', 'rejected', 'needs_correction')
    or char_length(trim(coalesce(new_name, ''))) not between 1 and 500 then
    raise exception 'Enter a topic name and a valid review decision.';
  end if;
  update public.curriculum_topics
  set corrected_name = case when trim(new_name) = name then '' else trim(new_name) end,
      review_status = new_review_status,
      updated_at = timezone('utc', now())
  where id = target.id;
  insert into public.curriculum_audit_events (school_id, document_id, actor_id, event_type, details)
  values (target.school_id, target.document_id, auth.uid(), 'topic_reviewed',
    jsonb_build_object('topic_id', target.id, 'review_status', new_review_status));
end;
$$;

create or replace function public.approve_curriculum_document(target_document uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.curriculum_documents%rowtype;
  job public.curriculum_processing_jobs%rowtype;
  unit_count integer;
begin
  select * into target
  from public.curriculum_documents
  where id = target_document
  for update;
  if not found or not (
    public.has_school_role(target.school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
    or public.is_hod_for_subject(target.school_id, target.subject_id)
  ) then
    raise exception 'An academic approver must review this curriculum.';
  end if;
  if target.status <> 'needs_review' then
    raise exception 'Curriculum extraction must be ready for review before approval.';
  end if;
  select * into job
  from public.curriculum_processing_jobs
  where school_id = target.school_id and document_id = target.id
  order by created_at desc
  limit 1
  for update;
  if not found or job.status <> 'needs_review' then
    raise exception 'Curriculum processing must finish before approval.';
  end if;
  if coalesce((job.manifest ->> 'total_units')::integer, -1)
      <> coalesce((job.manifest ->> 'processed_units')::integer, -2)
    or coalesce((job.manifest ->> 'failed_units')::integer, 1) <> 0 then
    raise exception 'Every document unit must be processed successfully before approval.';
  end if;
  select count(*) into unit_count
  from public.curriculum_source_units
  where school_id = target.school_id and document_id = target.id;
  if unit_count = 0 or unit_count <> (job.manifest ->> 'total_units')::integer then
    raise exception 'Extracted source evidence is incomplete.';
  end if;
  if exists (
    select 1 from public.curriculum_source_units
    where school_id = target.school_id and document_id = target.id
      and review_status <> 'approved'
  ) then
    raise exception 'Review every source page, slide and worksheet before approval.';
  end if;
  if exists (
    select 1 from public.curriculum_objectives
    where school_id = target.school_id and document_id = target.id
      and review_status not in ('approved', 'rejected')
  ) or exists (
    select 1 from public.curriculum_topics
    where school_id = target.school_id and document_id = target.id
      and review_status not in ('approved', 'rejected')
  ) then
    raise exception 'Review or explicitly reject every extracted topic and objective before approval.';
  end if;
  if target.category = 'syllabus' and not exists (
    select 1 from public.curriculum_objectives
    where school_id = target.school_id and document_id = target.id
      and review_status = 'approved'
  ) then
    raise exception 'Approve at least one syllabus objective before approving this curriculum.';
  end if;
  update public.curriculum_documents
  set status = 'approved'
  where id = target.id;
  update public.curriculum_processing_jobs
  set status = 'ready_to_delete',
      updated_at = timezone('utc', now())
  where id = job.id;
  insert into public.curriculum_audit_events (school_id, document_id, actor_id, event_type, details)
  values (target.school_id, target.id, auth.uid(), 'curriculum_approved',
    jsonb_build_object('job_id', job.id, 'approved_at', timezone('utc', now())));
end;
$$;

alter table public.curriculum_documents enable row level security;
alter table public.curriculum_document_assignments enable row level security;
alter table public.curriculum_processing_jobs enable row level security;
alter table public.curriculum_source_units enable row level security;
alter table public.curriculum_topics enable row level security;
alter table public.curriculum_objectives enable row level security;
alter table public.curriculum_lesson_objectives enable row level security;
alter table public.curriculum_templates enable row level security;
alter table public.curriculum_teaching_plans enable row level security;
alter table public.curriculum_teaching_plan_entries enable row level security;
alter table public.curriculum_coverage_records enable row level security;
alter table public.curriculum_assessment_objectives enable row level security;
alter table public.curriculum_audit_events enable row level security;

create policy "Authorized staff read curriculum documents"
  on public.curriculum_documents for select to authenticated
  using (public.can_view_curriculum_document(school_id, subject_id, uploaded_by, status));
create policy "Authorized staff create curriculum drafts"
  on public.curriculum_documents for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and status = 'draft'
    and public.can_manage_curriculum(school_id, subject_id)
  );
create policy "Owners and academic leads update curriculum drafts"
  on public.curriculum_documents for update to authenticated
  using (
    (uploaded_by = auth.uid() and status in ('draft', 'uploaded', 'failed'))
    or public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
    or public.is_hod_for_subject(school_id, subject_id)
  )
  with check (public.can_manage_curriculum(school_id, subject_id));
create policy "Owners and academic leads delete curriculum drafts"
  on public.curriculum_documents for delete to authenticated
  using (
    status in ('draft', 'failed', 'rejected')
    and (
      uploaded_by = auth.uid()
      or public.has_school_role(school_id, array['school_admin']::public.app_role[])
    )
  );

create policy "Authorized staff read curriculum assignments"
  on public.curriculum_document_assignments for select to authenticated
  using (
    exists (
      select 1 from public.curriculum_documents document
      where document.school_id = curriculum_document_assignments.school_id
        and document.id = curriculum_document_assignments.document_id
        and public.can_view_curriculum_document(document.school_id, document.subject_id, document.uploaded_by, document.status)
    )
  );
create policy "Authorized staff manage curriculum assignments"
  on public.curriculum_document_assignments for all to authenticated
  using (
    exists (
      select 1 from public.curriculum_documents document
      where document.school_id = curriculum_document_assignments.school_id
        and document.id = curriculum_document_assignments.document_id
        and public.can_manage_curriculum(document.school_id, document.subject_id, curriculum_document_assignments.class_id)
    )
  )
  with check (
    created_by = auth.uid()
    and exists (
      select 1 from public.curriculum_documents document
      where document.school_id = curriculum_document_assignments.school_id
        and document.id = curriculum_document_assignments.document_id
        and public.can_manage_curriculum(document.school_id, document.subject_id, curriculum_document_assignments.class_id)
    )
  );

create policy "Authorized staff read curriculum processing status"
  on public.curriculum_processing_jobs for select to authenticated
  using (
    exists (
      select 1 from public.curriculum_documents document
      where document.school_id = curriculum_processing_jobs.school_id
        and document.id = curriculum_processing_jobs.document_id
        and public.can_view_curriculum_document(document.school_id, document.subject_id, document.uploaded_by, document.status)
    )
  );

create policy "Authorized staff read curriculum source units"
  on public.curriculum_source_units for select to authenticated
  using (
    exists (
      select 1 from public.curriculum_documents document
      where document.school_id = curriculum_source_units.school_id
        and document.id = curriculum_source_units.document_id
        and public.can_view_curriculum_document(document.school_id, document.subject_id, document.uploaded_by, document.status)
    )
  );

create policy "Authorized staff read curriculum topics"
  on public.curriculum_topics for select to authenticated
  using (
    exists (
      select 1 from public.curriculum_documents document
      where document.school_id = curriculum_topics.school_id
        and document.id = curriculum_topics.document_id
        and public.can_view_curriculum_document(document.school_id, document.subject_id, document.uploaded_by, document.status)
    )
  );
create policy "Authorized staff create curriculum topics"
  on public.curriculum_topics for insert to authenticated
  with check (
    exists (
      select 1 from public.curriculum_documents document
      where document.school_id = curriculum_topics.school_id
        and document.id = curriculum_topics.document_id
        and document.uploaded_by = auth.uid()
        and public.can_manage_curriculum(document.school_id, document.subject_id)
        and document.status in ('draft', 'needs_review')
    )
  );
create policy "Authorized staff update curriculum topics"
  on public.curriculum_topics for update to authenticated
  using (
    exists (
      select 1 from public.curriculum_documents document
      where document.school_id = curriculum_topics.school_id
        and document.id = curriculum_topics.document_id
        and public.can_manage_curriculum(document.school_id, document.subject_id)
    )
  )
  with check (
    exists (
      select 1 from public.curriculum_documents document
      where document.school_id = curriculum_topics.school_id
        and document.id = curriculum_topics.document_id
        and public.can_manage_curriculum(document.school_id, document.subject_id)
    )
  );

create policy "Authorized staff read curriculum objectives"
  on public.curriculum_objectives for select to authenticated
  using (
    exists (
      select 1 from public.curriculum_documents document
      where document.school_id = curriculum_objectives.school_id
        and document.id = curriculum_objectives.document_id
        and public.can_view_curriculum_document(document.school_id, document.subject_id, document.uploaded_by, document.status)
    )
  );
create policy "Authorized staff update curriculum objectives"
  on public.curriculum_objectives for update to authenticated
  using (
    exists (
      select 1 from public.curriculum_documents document
      where document.school_id = curriculum_objectives.school_id
        and document.id = curriculum_objectives.document_id
        and public.can_manage_curriculum(document.school_id, document.subject_id)
    )
  )
  with check (
    exists (
      select 1 from public.curriculum_documents document
      where document.school_id = curriculum_objectives.school_id
        and document.id = curriculum_objectives.document_id
        and public.can_manage_curriculum(document.school_id, document.subject_id)
    )
  );

create policy "Authorized staff manage lesson objectives"
  on public.curriculum_lesson_objectives for all to authenticated
  using (
    exists (
      select 1 from public.curriculum_objectives objective
      join public.curriculum_documents document
        on document.school_id = objective.school_id and document.id = objective.document_id
      where objective.school_id = curriculum_lesson_objectives.school_id
        and objective.id = curriculum_lesson_objectives.syllabus_objective_id
        and public.can_manage_curriculum(document.school_id, document.subject_id)
    )
  )
  with check (
    created_by = auth.uid()
    and exists (
      select 1 from public.curriculum_objectives objective
      join public.curriculum_documents document
        on document.school_id = objective.school_id and document.id = objective.document_id
      where objective.school_id = curriculum_lesson_objectives.school_id
        and objective.id = curriculum_lesson_objectives.syllabus_objective_id
        and public.can_manage_curriculum(document.school_id, document.subject_id)
    )
  );

create policy "School members read approved curriculum templates"
  on public.curriculum_templates for select to authenticated
  using (
    is_approved and public.is_school_member(school_id)
    or public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
    or (subject_id is not null and public.is_hod_for_subject(school_id, subject_id))
  );
create policy "Academic leads manage curriculum templates"
  on public.curriculum_templates for all to authenticated
  using (
    public.has_school_role(school_id, array['school_admin']::public.app_role[])
    or (subject_id is not null and public.is_hod_for_subject(school_id, subject_id))
  )
  with check (
    created_by = auth.uid()
    and (
      public.has_school_role(school_id, array['school_admin']::public.app_role[])
      or (subject_id is not null and public.is_hod_for_subject(school_id, subject_id))
    )
  );

create policy "Authorized staff read teaching plans"
  on public.curriculum_teaching_plans for select to authenticated
  using (
    created_by = auth.uid()
    or public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
    or public.is_hod_for_subject(school_id, subject_id)
    or (status = 'approved' and public.can_manage_curriculum(school_id, subject_id, class_id))
  );
create policy "Authorized staff manage teaching plans"
  on public.curriculum_teaching_plans for all to authenticated
  using (public.can_manage_curriculum(school_id, subject_id, class_id))
  with check (created_by = auth.uid() and public.can_manage_curriculum(school_id, subject_id, class_id));

create policy "Authorized staff read teaching plan entries"
  on public.curriculum_teaching_plan_entries for select to authenticated
  using (
    exists (
      select 1 from public.curriculum_teaching_plans plan
      where plan.school_id = curriculum_teaching_plan_entries.school_id
        and plan.id = curriculum_teaching_plan_entries.plan_id
        and (
          plan.created_by = auth.uid()
          or public.has_school_role(plan.school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
          or public.is_hod_for_subject(plan.school_id, plan.subject_id)
          or (plan.status = 'approved' and public.can_manage_curriculum(plan.school_id, plan.subject_id, plan.class_id))
        )
    )
  );
create policy "Authorized staff manage teaching plan entries"
  on public.curriculum_teaching_plan_entries for all to authenticated
  using (
    exists (
      select 1 from public.curriculum_teaching_plans plan
      where plan.school_id = curriculum_teaching_plan_entries.school_id
        and plan.id = curriculum_teaching_plan_entries.plan_id
        and public.can_manage_curriculum(plan.school_id, plan.subject_id, plan.class_id)
    )
  )
  with check (
    exists (
      select 1 from public.curriculum_teaching_plans plan
      where plan.school_id = curriculum_teaching_plan_entries.school_id
        and plan.id = curriculum_teaching_plan_entries.plan_id
        and public.can_manage_curriculum(plan.school_id, plan.subject_id, plan.class_id)
    )
  );

create policy "Authorized staff read curriculum coverage"
  on public.curriculum_coverage_records for select to authenticated
  using (
    public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
    or public.is_teacher_for_class(school_id, class_id)
    or public.is_hod_for_subject(school_id, (
      select subject_id from public.curriculum_documents document
      join public.curriculum_document_assignments assignment
        on assignment.school_id = document.school_id and assignment.document_id = document.id
      where assignment.id = curriculum_coverage_records.assignment_id
    ))
  );
create policy "Authorized teachers record curriculum coverage"
  on public.curriculum_coverage_records for insert to authenticated
  with check (
    recorded_by = auth.uid()
    and public.can_manage_curriculum(school_id, (
      select subject_id from public.curriculum_documents document
      join public.curriculum_document_assignments assignment
        on assignment.school_id = document.school_id and assignment.document_id = document.id
      where assignment.id = curriculum_coverage_records.assignment_id
    ), class_id)
  );
create policy "Authorized teachers update curriculum coverage"
  on public.curriculum_coverage_records for update to authenticated
  using (recorded_by = auth.uid() or public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[]))
  with check (public.can_manage_curriculum(school_id, (
    select subject_id from public.curriculum_documents document
    join public.curriculum_document_assignments assignment
      on assignment.school_id = document.school_id and assignment.document_id = document.id
    where assignment.id = curriculum_coverage_records.assignment_id
  ), class_id));

create policy "Authorized staff manage assessment objective links"
  on public.curriculum_assessment_objectives for all to authenticated
  using (
    public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
    or exists (
      select 1 from public.learning_assessments assessment
      where assessment.school_id = curriculum_assessment_objectives.school_id
        and assessment.id = curriculum_assessment_objectives.assessment_id
        and assessment.created_by = auth.uid()
    )
  )
  with check (
    public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
    or exists (
      select 1 from public.learning_assessments assessment
      where assessment.school_id = curriculum_assessment_objectives.school_id
        and assessment.id = curriculum_assessment_objectives.assessment_id
        and assessment.created_by = auth.uid()
    )
  );

create policy "Academic leads read curriculum audit events"
  on public.curriculum_audit_events for select to authenticated
  using (
    public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
    or public.is_hod_for_subject(school_id, (
      select subject_id from public.curriculum_documents document
      where document.school_id = curriculum_audit_events.school_id
        and document.id = curriculum_audit_events.document_id
    ))
  );

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'curriculum-temporary',
  'curriculum-temporary',
  false,
  52428800,
  array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'application/octet-stream'
  ]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "Authorized staff upload temporary curriculum sources"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'curriculum-temporary'
    and exists (
      select 1 from public.curriculum_documents document
      where document.school_id::text = split_part(name, '/', 1)
        and document.id::text = split_part(name, '/', 2)
        and document.temporary_storage_path = name
        and document.status in ('draft', 'uploaded')
        and public.can_manage_curriculum(document.school_id, document.subject_id)
    )
  );
create policy "Authorized staff read temporary curriculum sources"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'curriculum-temporary'
    and exists (
      select 1 from public.curriculum_documents document
      where document.school_id::text = split_part(name, '/', 1)
        and document.id::text = split_part(name, '/', 2)
        and document.temporary_storage_path = name
        and public.can_view_curriculum_document(document.school_id, document.subject_id, document.uploaded_by, document.status)
    )
  );
create policy "Owners and academic leads delete temporary curriculum sources"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'curriculum-temporary'
    and exists (
      select 1 from public.curriculum_documents document
      where document.school_id::text = split_part(name, '/', 1)
        and document.id::text = split_part(name, '/', 2)
        and document.temporary_storage_path = name
        and document.status in ('draft', 'uploaded', 'failed', 'rejected')
        and (
          document.uploaded_by = auth.uid()
          or public.has_school_role(document.school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
        )
    )
  );

grant select, insert on public.curriculum_documents to authenticated;
revoke update, delete on public.curriculum_documents from authenticated;
grant select, insert, update, delete on public.curriculum_document_assignments to authenticated;
grant select on public.curriculum_processing_jobs, public.curriculum_source_units to authenticated;
grant select on public.curriculum_topics to authenticated;
grant select on public.curriculum_objectives to authenticated;
revoke insert, update, delete on public.curriculum_topics, public.curriculum_objectives from authenticated;
grant select, insert, update, delete on public.curriculum_lesson_objectives to authenticated;
grant select, insert, update, delete on public.curriculum_templates to authenticated;
grant select, insert, update, delete on public.curriculum_teaching_plans, public.curriculum_teaching_plan_entries to authenticated;
grant select, insert, update on public.curriculum_coverage_records to authenticated;
grant select, insert, update, delete on public.curriculum_assessment_objectives to authenticated;
grant select on public.curriculum_audit_events to authenticated;

revoke all on function public.can_manage_curriculum(uuid, uuid, uuid) from public, anon;
grant execute on function public.can_manage_curriculum(uuid, uuid, uuid) to authenticated;
revoke all on function public.can_view_curriculum_document(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.can_view_curriculum_document(uuid, uuid, uuid, text) to authenticated;
revoke all on function public.submit_curriculum_document(uuid) from public, anon;
grant execute on function public.submit_curriculum_document(uuid) to authenticated;
revoke all on function public.attach_curriculum_source(uuid, text, text, bigint, text, text) from public, anon;
grant execute on function public.attach_curriculum_source(uuid, text, text, bigint, text, text) to authenticated;
revoke all on function public.mark_curriculum_uploaded(uuid) from public, anon;
grant execute on function public.mark_curriculum_uploaded(uuid) to authenticated;
revoke all on function public.review_curriculum_objective(uuid, text, text, text) from public, anon;
grant execute on function public.review_curriculum_objective(uuid, text, text, text) to authenticated;
revoke all on function public.review_curriculum_source_unit(uuid, text) from public, anon;
grant execute on function public.review_curriculum_source_unit(uuid, text) to authenticated;
revoke all on function public.add_curriculum_objective(uuid, uuid, uuid, text, text, text) from public, anon;
grant execute on function public.add_curriculum_objective(uuid, uuid, uuid, text, text, text) to authenticated;
revoke all on function public.add_curriculum_topic(uuid, uuid, text, text) from public, anon;
grant execute on function public.add_curriculum_topic(uuid, uuid, text, text) to authenticated;
revoke all on function public.review_curriculum_topic(uuid, text, text) from public, anon;
grant execute on function public.review_curriculum_topic(uuid, text, text) to authenticated;
revoke all on function public.approve_curriculum_document(uuid) from public, anon;
grant execute on function public.approve_curriculum_document(uuid) to authenticated;

create trigger set_curriculum_documents_updated_at
  before update on public.curriculum_documents
  for each row execute function public.set_updated_at();
create trigger set_curriculum_jobs_updated_at
  before update on public.curriculum_processing_jobs
  for each row execute function public.set_updated_at();
create trigger set_curriculum_topics_updated_at
  before update on public.curriculum_topics
  for each row execute function public.set_updated_at();
create trigger set_curriculum_objectives_updated_at
  before update on public.curriculum_objectives
  for each row execute function public.set_updated_at();
create trigger set_curriculum_lesson_objectives_updated_at
  before update on public.curriculum_lesson_objectives
  for each row execute function public.set_updated_at();
create trigger set_curriculum_teaching_plans_updated_at
  before update on public.curriculum_teaching_plans
  for each row execute function public.set_updated_at();
create trigger set_curriculum_teaching_plan_entries_updated_at
  before update on public.curriculum_teaching_plan_entries
  for each row execute function public.set_updated_at();

create or replace function public.prevent_curriculum_objective_source_rewrite()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.original_text is distinct from old.original_text
    and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Original extracted syllabus wording is immutable; enter corrections separately.';
  end if;
  return new;
end;
$$;
create trigger prevent_curriculum_objective_source_rewrite
  before update on public.curriculum_objectives
  for each row execute function public.prevent_curriculum_objective_source_rewrite();
