create index curriculum_assessment_objectives_assessment_idx
  on public.curriculum_assessment_objectives(school_id, assessment_id, syllabus_objective_id);
create unique index curriculum_assessment_single_whole_objective_idx
  on public.curriculum_assessment_objectives(school_id, assessment_id)
  where question_id is null;
create unique index curriculum_assessment_question_objective_idx
  on public.curriculum_assessment_objectives(school_id, assessment_id, question_id, syllabus_objective_id)
  where question_id is not null;

create or replace function public.validate_curriculum_assessment_objective()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  assessment_subject text;
  assessment_syllabus text;
  question_ids jsonb;
  objective_subject text;
  objective_syllabus text;
begin
  if tg_op = 'UPDATE'
    and (new.school_id is distinct from old.school_id
      or new.assessment_id is distinct from old.assessment_id
      or new.syllabus_objective_id is distinct from old.syllabus_objective_id
      or new.question_id is distinct from old.question_id)
    and exists (
      select 1 from public.learning_assessment_results result
      where result.school_id = old.school_id and result.assessment_id = old.assessment_id
    ) then
    raise exception 'Assessment objective alignment cannot be changed after marks have been recorded.';
  end if;
  select assessment.subject, assessment.syllabus_code, assessment.question_ids
    into assessment_subject, assessment_syllabus, question_ids
  from public.learning_assessments assessment
  where assessment.school_id = new.school_id and assessment.id = new.assessment_id;
  select subject.name, document.syllabus_code
    into objective_subject, objective_syllabus
  from public.curriculum_objectives objective
  join public.curriculum_documents document
    on document.school_id = objective.school_id and document.id = objective.document_id
  join public.subjects subject
    on subject.school_id = document.school_id and subject.id = document.subject_id
  where objective.school_id = new.school_id
    and objective.id = new.syllabus_objective_id
    and objective.review_status = 'approved'
    and document.status in ('approved', 'source_deleted');
  if assessment_subject is null or objective_subject is null
    or lower(trim(assessment_subject)) <> lower(trim(objective_subject))
    or (nullif(trim(assessment_syllabus), '') is not null
      and nullif(trim(objective_syllabus), '') is not null
      and lower(trim(assessment_syllabus)) <> lower(trim(objective_syllabus))) then
    raise exception 'Choose an approved curriculum objective matching the assessment subject and syllabus.';
  end if;
  if new.question_id is not null and not (coalesce(question_ids, '[]'::jsonb) ? new.question_id::text) then
    raise exception 'The aligned question must belong to this saved assessment.';
  end if;
  if new.question_id is null and exists (
    select 1 from public.curriculum_assessment_objectives existing
    where existing.school_id = new.school_id
      and existing.assessment_id = new.assessment_id
      and existing.question_id is null
      and (
        tg_op = 'INSERT'
        or existing.assessment_id <> old.assessment_id
        or existing.syllabus_objective_id <> old.syllabus_objective_id
        or existing.question_id is distinct from old.question_id
      )
  ) then
    raise exception 'A test can have only one whole-assessment objective alignment.';
  end if;
  return new;
end;
$$;

create trigger validate_curriculum_assessment_objective
  before insert or update on public.curriculum_assessment_objectives
  for each row execute function public.validate_curriculum_assessment_objective();
revoke all on function public.validate_curriculum_assessment_objective() from public, anon, authenticated;

create or replace function public.protect_curriculum_assessment_alignment_history()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.learning_assessment_results result
    where result.school_id = old.school_id and result.assessment_id = old.assessment_id
  ) then
    raise exception 'Assessment objective alignment cannot be changed after marks have been recorded.';
  end if;
  return old;
end;
$$;

create trigger protect_curriculum_assessment_alignment_history
  before delete on public.curriculum_assessment_objectives
  for each row execute function public.protect_curriculum_assessment_alignment_history();
revoke all on function public.protect_curriculum_assessment_alignment_history() from public, anon, authenticated;

create or replace function public.protect_assessment_subject_alignment_history()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (new.subject is distinct from old.subject or new.syllabus_code is distinct from old.syllabus_code)
    and exists (
      select 1 from public.curriculum_assessment_objectives alignment
      where alignment.school_id = old.school_id and alignment.assessment_id = old.id
    )
    and exists (
      select 1 from public.learning_assessment_results result
      where result.school_id = old.school_id and result.assessment_id = old.id
    ) then
    raise exception 'Assessment subject and syllabus cannot change after results are recorded for an aligned test.';
  end if;
  return new;
end;
$$;

create trigger protect_assessment_subject_alignment_history
  before update on public.learning_assessments
  for each row execute function public.protect_assessment_subject_alignment_history();
revoke all on function public.protect_assessment_subject_alignment_history() from public, anon, authenticated;
