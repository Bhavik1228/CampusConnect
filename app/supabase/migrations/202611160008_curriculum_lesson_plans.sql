create table public.curriculum_lesson_plans (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  academic_year_id uuid not null,
  assignment_id uuid not null,
  subject_id uuid not null,
  class_id uuid,
  template_id uuid not null,
  template_version integer not null check (template_version > 0),
  course_lesson_id uuid,
  title text not null check (char_length(trim(title)) between 2 and 180),
  status text not null default 'draft' check (status in ('draft', 'approved', 'archived')),
  template_snapshot jsonb not null check (jsonb_typeof(template_snapshot) = 'object'),
  sections jsonb not null default '{}'::jsonb check (jsonb_typeof(sections) = 'object'),
  provenance jsonb not null default '{}'::jsonb check (jsonb_typeof(provenance) = 'object'),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, academic_year_id) references public.academic_years(school_id, id) on delete restrict,
  foreign key (school_id, assignment_id) references public.curriculum_document_assignments(school_id, id) on delete restrict,
  foreign key (school_id, subject_id) references public.subjects(school_id, id) on delete restrict,
  foreign key (school_id, class_id) references public.school_classes(school_id, id) on delete set null (class_id),
  foreign key (school_id, template_id) references public.curriculum_templates(school_id, id) on delete restrict,
  foreign key (school_id, course_lesson_id) references public.course_lessons(school_id, id) on delete set null (course_lesson_id)
);

create index curriculum_lesson_plans_assignment_idx
  on public.curriculum_lesson_plans(school_id, assignment_id, updated_at desc);

create or replace function public.validate_curriculum_teaching_plan()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  assigned_subject uuid;
  assigned_year uuid;
  assigned_class uuid;
  source_status text;
begin
  select document.subject_id, assignment.academic_year_id, assignment.class_id, document.status
    into assigned_subject, assigned_year, assigned_class, source_status
  from public.curriculum_document_assignments assignment
  join public.curriculum_documents document
    on document.school_id = assignment.school_id and document.id = assignment.document_id
  where assignment.school_id = new.school_id and assignment.id = new.assignment_id;
  if assigned_subject is null
    or assigned_subject is distinct from new.subject_id
    or assigned_year is distinct from new.academic_year_id
    or assigned_class is null
    or assigned_class is distinct from new.class_id
    or source_status not in ('approved', 'source_deleted') then
    raise exception 'Teaching plan assignment must match an approved class curriculum, subject, and year.';
  end if;
  if new.status <> 'draft' or new.approved_by is not null or new.approved_at is not null then
    raise exception 'Teaching plans remain drafts until an authorized approval workflow is available.';
  end if;
  if tg_op = 'INSERT' then
    if auth.uid() is null or new.created_by is distinct from auth.uid() then
      raise exception 'The teaching plan creator must be the authenticated user.';
    end if;
  elsif new.id is distinct from old.id
    or new.school_id is distinct from old.school_id
    or new.academic_year_id is distinct from old.academic_year_id
    or new.assignment_id is distinct from old.assignment_id
    or new.subject_id is distinct from old.subject_id
    or new.class_id is distinct from old.class_id
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
    or old.status <> 'draft' then
    raise exception 'Teaching-plan identity and assignment are immutable, and only drafts can be edited.';
  end if;
  return new;
end;
$$;

create trigger validate_curriculum_teaching_plan
  before insert or update on public.curriculum_teaching_plans
  for each row execute function public.validate_curriculum_teaching_plan();
revoke all on function public.validate_curriculum_teaching_plan() from public, anon, authenticated;

create or replace function public.validate_curriculum_teaching_plan_entry()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  plan_assignment uuid;
  plan_year uuid;
  plan_status text;
  assigned_document uuid;
  assigned_class uuid;
  assigned_subject uuid;
  document_status text;
  year_start date;
  year_end date;
  term_start date;
  term_end date;
  objective_document uuid;
begin
  select plan.assignment_id, plan.academic_year_id, plan.status, assignment.document_id,
         assignment.class_id, document.subject_id, document.status, year.start_date, year.end_date
    into plan_assignment, plan_year, plan_status, assigned_document,
         assigned_class, assigned_subject, document_status, year_start, year_end
  from public.curriculum_teaching_plans plan
  join public.curriculum_document_assignments assignment
    on assignment.school_id = plan.school_id and assignment.id = plan.assignment_id
  join public.curriculum_documents document
    on document.school_id = assignment.school_id and document.id = assignment.document_id
  join public.academic_years year
    on year.school_id = plan.school_id and year.id = plan.academic_year_id
  where plan.school_id = new.school_id and plan.id = new.plan_id;
  if plan_assignment is null or plan_status <> 'draft'
    or assigned_class is null or document_status not in ('approved', 'source_deleted')
    or new.syllabus_objective_id is null then
    raise exception 'Plan entries require an editable draft and an approved class curriculum objective.';
  end if;
  select document_id into objective_document
  from public.curriculum_objectives
  where school_id = new.school_id
    and id = new.syllabus_objective_id
    and review_status = 'approved';
  if objective_document is distinct from assigned_document then
    raise exception 'The plan objective must belong to its assigned approved curriculum.';
  end if;
  if new.lesson_objective_id is not null and not exists (
    select 1 from public.curriculum_lesson_objectives lesson_objective
    where lesson_objective.school_id = new.school_id
      and lesson_objective.id = new.lesson_objective_id
      and lesson_objective.syllabus_objective_id = new.syllabus_objective_id
      and (lesson_objective.assignment_id is null or lesson_objective.assignment_id = plan_assignment)
  ) then
    raise exception 'The lesson objective must be linked to the plan syllabus objective.';
  end if;
  if new.topic_id is not null and not exists (
    select 1 from public.curriculum_topics topic
    where topic.school_id = new.school_id
      and topic.id = new.topic_id
      and topic.document_id = assigned_document
      and topic.review_status = 'approved'
  ) then
    raise exception 'The plan topic must belong to its assigned approved curriculum.';
  end if;
  if new.term_id is not null then
    select term.start_date, term.end_date into term_start, term_end
    from public.terms term
    where term.school_id = new.school_id
      and term.id = new.term_id
      and term.academic_year_id = plan_year;
    if term_start is null then
      raise exception 'The plan term must belong to its academic year.';
    end if;
  end if;
  if (new.planned_start is not null and (
        new.planned_start < year_start or new.planned_start > year_end
        or (term_start is not null and new.planned_start not between term_start and term_end)
      ))
    or (new.planned_end is not null and (
        new.planned_end < year_start or new.planned_end > year_end
        or (term_start is not null and new.planned_end not between term_start and term_end)
      )) then
    raise exception 'Plan dates must fall within the selected academic year and term.';
  end if;
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.school_id is distinct from old.school_id
    or new.plan_id is distinct from old.plan_id
    or new.topic_id is distinct from old.topic_id
    or new.syllabus_objective_id is distinct from old.syllabus_objective_id
    or new.lesson_objective_id is distinct from old.lesson_objective_id
  ) then
    raise exception 'Plan entry assignment and objective provenance are immutable.';
  end if;
  return new;
end;
$$;

create trigger validate_curriculum_teaching_plan_entry
  before insert or update on public.curriculum_teaching_plan_entries
  for each row execute function public.validate_curriculum_teaching_plan_entry();
revoke all on function public.validate_curriculum_teaching_plan_entry() from public, anon, authenticated;

create or replace function public.validate_curriculum_lesson_plan()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  assigned_subject uuid;
  assigned_year uuid;
  assigned_class uuid;
  source_status text;
  linked_class uuid;
  linked_subject uuid;
  template_category text;
  template_sections jsonb;
  template_settings jsonb;
  template_name text;
begin
  select document.subject_id, assignment.academic_year_id, assignment.class_id, document.status
    into assigned_subject, assigned_year, assigned_class, source_status
  from public.curriculum_document_assignments assignment
  join public.curriculum_documents document
    on document.school_id = assignment.school_id and document.id = assignment.document_id
  where assignment.school_id = new.school_id
    and assignment.id = new.assignment_id;
  if assigned_subject is null
    or assigned_subject <> new.subject_id
    or assigned_year <> new.academic_year_id
    or assigned_class is distinct from new.class_id
    or source_status not in ('approved', 'source_deleted') then
    raise exception 'Lesson plan assignment must match an approved curriculum, subject, year, and class.';
  end if;
  if new.status <> 'draft' then
    raise exception 'Lesson plans remain drafts until an authorized approval workflow is available.';
  end if;
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.school_id is distinct from old.school_id
    or new.academic_year_id is distinct from old.academic_year_id
    or new.assignment_id is distinct from old.assignment_id
    or new.subject_id is distinct from old.subject_id
    or new.class_id is distinct from old.class_id
    or new.template_id is distinct from old.template_id
    or new.template_version is distinct from old.template_version
    or new.template_snapshot is distinct from old.template_snapshot
    or new.provenance is distinct from old.provenance
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
    or old.status <> 'draft'
  ) then
    raise exception 'Lesson-plan assignment, template, and provenance are immutable.';
  end if;

  select category, sections, settings, name
    into template_category, template_sections, template_settings, template_name
  from public.curriculum_templates template
  where template.school_id = new.school_id and template.id = new.template_id
    and template.version = new.template_version and template.is_approved;
  if template_category is distinct from 'lesson_plan' then
    raise exception 'Choose an approved immutable template version.';
  end if;
  if new.template_snapshot is distinct from jsonb_build_object(
    'id', new.template_id,
    'version', new.template_version,
    'name', template_name,
    'sections', template_sections,
    'settings', template_settings
  ) then
    raise exception 'Lesson-plan template provenance must match the selected approved version.';
  end if;

  if new.course_lesson_id is not null then
    select course.class_id, course.subject_id
      into linked_class, linked_subject
    from public.course_lessons lesson
    join public.lesson_courses course
      on course.school_id = lesson.school_id and course.id = lesson.course_id
    where lesson.school_id = new.school_id and lesson.id = new.course_lesson_id;
    if linked_class is distinct from new.class_id or linked_subject is distinct from new.subject_id then
      raise exception 'The linked course lesson must match the lesson plan class and subject.';
    end if;
  end if;
  return new;
end;
$$;

create trigger validate_curriculum_lesson_plan
  before insert or update on public.curriculum_lesson_plans
  for each row execute function public.validate_curriculum_lesson_plan();
revoke all on function public.validate_curriculum_lesson_plan() from public, anon, authenticated;

create table public.curriculum_lesson_plan_objectives (
  school_id uuid not null,
  lesson_plan_id uuid not null,
  syllabus_objective_id uuid not null,
  lesson_objective_id uuid,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (lesson_plan_id, syllabus_objective_id),
  foreign key (school_id, lesson_plan_id) references public.curriculum_lesson_plans(school_id, id) on delete cascade,
  foreign key (school_id, syllabus_objective_id) references public.curriculum_objectives(school_id, id) on delete restrict,
  foreign key (school_id, lesson_objective_id) references public.curriculum_lesson_objectives(school_id, id) on delete set null (lesson_objective_id)
);

create or replace function public.validate_curriculum_lesson_plan_objective()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  plan_assignment uuid;
  plan_document uuid;
  objective_document uuid;
  linked_source_objective uuid;
begin
  select plan.assignment_id, assignment.document_id, objective.document_id
    into plan_assignment, plan_document, objective_document
  from public.curriculum_lesson_plans plan
  join public.curriculum_document_assignments assignment
    on assignment.school_id = plan.school_id and assignment.id = plan.assignment_id
  join public.curriculum_objectives objective
    on objective.school_id = new.school_id and objective.id = new.syllabus_objective_id
  where plan.school_id = new.school_id and plan.id = new.lesson_plan_id
    and objective.review_status = 'approved';
  if plan_assignment is null or plan_document is distinct from objective_document then
    raise exception 'Lesson plan objectives must belong to its assigned approved curriculum.';
  end if;
  if new.lesson_objective_id is not null then
    select syllabus_objective_id into linked_source_objective
    from public.curriculum_lesson_objectives
    where school_id = new.school_id and id = new.lesson_objective_id;
    if linked_source_objective is distinct from new.syllabus_objective_id then
      raise exception 'The linked lesson objective must originate from the selected syllabus objective.';
    end if;
  end if;
  return new;
end;
$$;

create trigger validate_curriculum_lesson_plan_objective
  before insert or update on public.curriculum_lesson_plan_objectives
  for each row execute function public.validate_curriculum_lesson_plan_objective();
revoke all on function public.validate_curriculum_lesson_plan_objective() from public, anon, authenticated;

alter table public.curriculum_lesson_plans enable row level security;
alter table public.curriculum_lesson_plan_objectives enable row level security;

create policy "Authorized staff read curriculum lesson plans"
  on public.curriculum_lesson_plans for select to authenticated
  using (
    created_by = auth.uid()
    or public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
    or public.is_hod_for_subject(school_id, subject_id)
    or (status = 'approved' and public.can_manage_curriculum(school_id, subject_id, class_id))
  );
create policy "Authorized staff create curriculum lesson plans"
  on public.curriculum_lesson_plans for insert to authenticated
  with check (
    created_by = auth.uid()
    and status = 'draft'
    and public.can_manage_curriculum(school_id, subject_id, class_id)
    and exists (
      select 1 from public.curriculum_templates template
      where template.school_id = curriculum_lesson_plans.school_id
        and template.id = curriculum_lesson_plans.template_id
        and template.version = curriculum_lesson_plans.template_version
        and template.is_approved
    )
  );
create policy "Authorized staff update draft curriculum lesson plans"
  on public.curriculum_lesson_plans for update to authenticated
  using (status = 'draft' and public.can_manage_curriculum(school_id, subject_id, class_id))
  with check (status = 'draft' and public.can_manage_curriculum(school_id, subject_id, class_id));

create policy "Authorized staff read lesson plan objective links"
  on public.curriculum_lesson_plan_objectives for select to authenticated
  using (
    exists (
      select 1 from public.curriculum_lesson_plans plan
      where plan.school_id = curriculum_lesson_plan_objectives.school_id
        and plan.id = curriculum_lesson_plan_objectives.lesson_plan_id
        and (
          plan.created_by = auth.uid()
          or public.has_school_role(plan.school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
          or public.is_hod_for_subject(plan.school_id, plan.subject_id)
          or (plan.status = 'approved' and public.can_manage_curriculum(plan.school_id, plan.subject_id, plan.class_id))
        )
    )
  );
create policy "Authorized staff create lesson plan objective links"
  on public.curriculum_lesson_plan_objectives for insert to authenticated
  with check (
    exists (
      select 1 from public.curriculum_lesson_plans plan
      join public.curriculum_objectives objective
        on objective.school_id = curriculum_lesson_plan_objectives.school_id
       and objective.id = curriculum_lesson_plan_objectives.syllabus_objective_id
      where plan.school_id = curriculum_lesson_plan_objectives.school_id
        and plan.id = curriculum_lesson_plan_objectives.lesson_plan_id
        and plan.status = 'draft'
        and objective.review_status = 'approved'
        and public.can_manage_curriculum(plan.school_id, plan.subject_id, plan.class_id)
    )
  );

create trigger set_curriculum_lesson_plans_updated_at
  before update on public.curriculum_lesson_plans
  for each row execute function public.set_updated_at();

grant select, insert, update on public.curriculum_lesson_plans to authenticated;
grant select, insert on public.curriculum_lesson_plan_objectives to authenticated;

drop policy "Authorized staff manage teaching plans" on public.curriculum_teaching_plans;
create policy "Authorized staff create draft teaching plans"
  on public.curriculum_teaching_plans for insert to authenticated
  with check (
    created_by = auth.uid()
    and status = 'draft'
    and public.can_manage_curriculum(school_id, subject_id, class_id)
  );
create policy "Authorized staff update draft teaching plans"
  on public.curriculum_teaching_plans for update to authenticated
  using (status = 'draft' and public.can_manage_curriculum(school_id, subject_id, class_id))
  with check (status = 'draft' and public.can_manage_curriculum(school_id, subject_id, class_id));
revoke delete on public.curriculum_teaching_plans from authenticated;
grant select, insert, update on public.curriculum_teaching_plans to authenticated;

create or replace function public.create_curriculum_teaching_plan(
  target_school uuid,
  target_academic_year uuid,
  target_assignment uuid,
  target_subject uuid,
  target_class uuid,
  target_title text,
  target_capacity_report jsonb,
  target_entries jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  source_document uuid;
  document_status text;
  entry jsonb;
  objective_id uuid;
  lesson_objective_id uuid;
  term_id uuid;
  new_plan_id uuid;
  entry_position integer := 0;
begin
  if auth.uid() is null or not public.can_manage_curriculum(target_school, target_subject, target_class) then
    raise exception 'You are not authorized to create this teaching plan.';
  end if;
  if char_length(trim(coalesce(target_title, ''))) not between 2 and 180
    or jsonb_typeof(target_capacity_report) is distinct from 'object'
    or jsonb_typeof(target_entries) is distinct from 'array'
    or target_class is null
    or jsonb_array_length(target_entries) > 500 then
    raise exception 'The teaching plan details or generated entries are invalid.';
  end if;
  select assignment.document_id, document.status
    into source_document, document_status
  from public.curriculum_document_assignments assignment
  join public.curriculum_documents document
    on document.school_id = assignment.school_id and document.id = assignment.document_id
  where assignment.school_id = target_school
    and assignment.id = target_assignment
    and assignment.academic_year_id = target_academic_year
    and assignment.class_id is not distinct from target_class
    and document.subject_id = target_subject;
  if source_document is null or document_status not in ('approved', 'source_deleted') then
    raise exception 'Choose an assignment for an approved curriculum in the selected year, class, and subject.';
  end if;
  insert into public.curriculum_teaching_plans (
    school_id, academic_year_id, assignment_id, subject_id, class_id,
    title, status, capacity_report, created_by
  ) values (
    target_school, target_academic_year, target_assignment, target_subject, target_class,
    trim(target_title), 'draft', target_capacity_report, auth.uid()
  ) returning id into new_plan_id;

  for entry in select value from jsonb_array_elements(target_entries) loop
    objective_id := nullif(entry->>'syllabus_objective_id', '')::uuid;
    term_id := nullif(entry->>'term_id', '')::uuid;
    if objective_id is null or not exists (
      select 1 from public.curriculum_objectives objective
      where objective.school_id = target_school
        and objective.id = objective_id
        and objective.document_id = source_document
        and objective.review_status = 'approved'
    ) then
      raise exception 'Every teaching-plan entry must reference an approved objective in its assigned curriculum.';
    end if;
    if term_id is not null and not exists (
      select 1 from public.terms term
      where term.school_id = target_school
        and term.id = term_id
        and term.academic_year_id = target_academic_year
    ) then
      raise exception 'A teaching-plan term must belong to its academic year.';
    end if;
    lesson_objective_id := nullif(entry->>'lesson_objective_id', '')::uuid;
    if lesson_objective_id is not null and not exists (
      select 1 from public.curriculum_lesson_objectives lesson_objective
      where lesson_objective.school_id = target_school
        and lesson_objective.id = lesson_objective_id
        and lesson_objective.syllabus_objective_id = objective_id
    ) then
      raise exception 'A generated lesson objective must originate from the linked syllabus objective.';
    end if;
    insert into public.curriculum_teaching_plan_entries (
      school_id, plan_id, term_id, week_number, planned_start, planned_end,
      estimated_periods, syllabus_objective_id, lesson_objective_id,
      assessment_checkpoints, resources, position
    ) values (
      target_school,
      new_plan_id,
      term_id,
      nullif(entry->>'week_number', '')::integer,
      nullif(entry->>'planned_start', '')::date,
      nullif(entry->>'planned_end', '')::date,
      coalesce(nullif(entry->>'estimated_periods', '')::numeric, 1),
      objective_id,
      lesson_objective_id,
      coalesce(entry->'assessment_checkpoints', '[]'::jsonb),
      coalesce(entry->'resources', '[]'::jsonb),
      coalesce(nullif(entry->>'position', '')::integer, entry_position)
    );
    entry_position := entry_position + 1;
  end loop;
  return new_plan_id;
end;
$$;

drop policy "Authorized staff create draft teaching plans" on public.curriculum_teaching_plans;
revoke insert on public.curriculum_teaching_plans from authenticated;
grant select, update on public.curriculum_teaching_plans to authenticated;
revoke insert, delete on public.curriculum_teaching_plan_entries from authenticated;
grant select, update on public.curriculum_teaching_plan_entries to authenticated;

revoke all on function public.create_curriculum_teaching_plan(uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb)
  from public, anon;
grant execute on function public.create_curriculum_teaching_plan(uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb)
  to authenticated;

create or replace function public.create_curriculum_lesson_plan(
  target_school uuid,
  target_academic_year uuid,
  target_assignment uuid,
  target_subject uuid,
  target_class uuid,
  target_template uuid,
  target_template_version integer,
  target_course_lesson uuid,
  target_title text,
  target_sections jsonb,
  target_generation text,
  target_objective_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  source_document uuid;
  document_status text;
  template_record public.curriculum_templates%rowtype;
  section_record jsonb;
  objective_id uuid;
  linked_lesson_objective uuid;
  new_plan_id uuid;
begin
  if auth.uid() is null or not public.can_manage_curriculum(target_school, target_subject, target_class) then
    raise exception 'You are not authorized to create this lesson plan.';
  end if;
  if char_length(trim(coalesce(target_title, ''))) not between 2 and 180
    or jsonb_typeof(target_sections) is distinct from 'object'
    or coalesce(array_length(target_objective_ids, 1), 0) not between 1 and 60
    or target_generation is null
    or target_generation not in ('deterministic', 'teacher') then
    raise exception 'The lesson plan details or selected objectives are invalid.';
  end if;
  if cardinality(target_objective_ids) <> (
    select count(distinct objective_id) from unnest(target_objective_ids) as objective_ids(objective_id)
  ) then
    raise exception 'Choose each source objective only once.';
  end if;
  select assignment.document_id, document.status
    into source_document, document_status
  from public.curriculum_document_assignments assignment
  join public.curriculum_documents document
    on document.school_id = assignment.school_id and document.id = assignment.document_id
  where assignment.school_id = target_school
    and assignment.id = target_assignment
    and assignment.academic_year_id = target_academic_year
    and assignment.class_id is not distinct from target_class
    and document.subject_id = target_subject;
  if source_document is null or document_status not in ('approved', 'source_deleted') then
    raise exception 'Choose an assignment for an approved curriculum in the selected year, class, and subject.';
  end if;
  select * into template_record
  from public.curriculum_templates template
  where template.school_id = target_school
    and template.id = target_template
    and template.version = target_template_version
    and template.category = 'lesson_plan'
    and template.is_approved;
  if not found then
    raise exception 'Choose an approved lesson-plan template version.';
  end if;
  if exists (
    select 1
    from jsonb_each(target_sections) as supplied(section_key, section_value)
    where jsonb_typeof(supplied.section_value) <> 'string'
      or char_length(supplied.section_value #>> '{}') > 12000
      or not exists (
        select 1 from jsonb_array_elements(template_record.sections) as defined(section)
        where defined.section->>'key' = supplied.section_key
      )
  ) then
    raise exception 'Lesson-plan section values must be text within the selected template.';
  end if;
  for section_record in select value from jsonb_array_elements(template_record.sections) loop
    if section_record->>'required' = 'true'
      and (nullif(trim(target_sections->>(section_record->>'key')), '') is null) then
      raise exception 'Complete required template sections before saving the lesson plan.';
    end if;
  end loop;
  if target_course_lesson is not null and not exists (
    select 1 from public.course_lessons lesson
    join public.lesson_courses course
      on course.school_id = lesson.school_id and course.id = lesson.course_id
    where lesson.school_id = target_school
      and lesson.id = target_course_lesson
      and course.class_id is not distinct from target_class
      and course.subject_id = target_subject
  ) then
    raise exception 'The linked course lesson must match the lesson plan class and subject.';
  end if;
  if exists (
    select 1 from unnest(target_objective_ids) as objective_ids(objective_id)
    where not exists (
      select 1 from public.curriculum_objectives objective
      where objective.school_id = target_school
        and objective.id = objective_id
        and objective.document_id = source_document
        and objective.review_status = 'approved'
    )
  ) then
    raise exception 'Every lesson-plan objective must be approved and belong to the assigned curriculum.';
  end if;
  insert into public.curriculum_lesson_plans (
    school_id, academic_year_id, assignment_id, subject_id, class_id,
    template_id, template_version, course_lesson_id, title, status,
    template_snapshot, sections, provenance, created_by
  ) values (
    target_school, target_academic_year, target_assignment, target_subject, target_class,
    target_template, target_template_version, target_course_lesson, trim(target_title), 'draft',
    jsonb_build_object(
      'id', template_record.id,
      'version', template_record.version,
      'name', template_record.name,
      'sections', template_record.sections,
      'settings', template_record.settings
    ),
    target_sections,
    jsonb_build_object(
      'generation', target_generation,
      'source_document_id', source_document,
      'source_objective_ids', to_jsonb(target_objective_ids),
      'generated_at', timezone('utc', now())
    ),
    auth.uid()
  ) returning id into new_plan_id;

  foreach objective_id in array target_objective_ids loop
    select lesson_objective.id into linked_lesson_objective
    from public.curriculum_lesson_objectives lesson_objective
    where lesson_objective.school_id = target_school
      and lesson_objective.syllabus_objective_id = objective_id
      and (lesson_objective.assignment_id = target_assignment or lesson_objective.assignment_id is null)
    order by lesson_objective.created_at desc
    limit 1;
    insert into public.curriculum_lesson_plan_objectives (
      school_id, lesson_plan_id, syllabus_objective_id, lesson_objective_id
    ) values (
      target_school, new_plan_id, objective_id, linked_lesson_objective
    );
  end loop;
  return new_plan_id;
end;
$$;

drop policy "Authorized staff create curriculum lesson plans" on public.curriculum_lesson_plans;
revoke insert on public.curriculum_lesson_plans from authenticated;
grant select, update on public.curriculum_lesson_plans to authenticated;
revoke insert, update, delete on public.curriculum_lesson_plan_objectives from authenticated;
grant select on public.curriculum_lesson_plan_objectives to authenticated;

revoke all on function public.create_curriculum_lesson_plan(uuid, uuid, uuid, uuid, uuid, uuid, integer, uuid, text, jsonb, text, uuid[])
  from public, anon;
grant execute on function public.create_curriculum_lesson_plan(uuid, uuid, uuid, uuid, uuid, uuid, integer, uuid, text, jsonb, text, uuid[])
  to authenticated;
