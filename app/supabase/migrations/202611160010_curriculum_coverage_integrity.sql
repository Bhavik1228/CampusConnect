create index curriculum_coverage_assignment_objective_idx
  on public.curriculum_coverage_records(school_id, assignment_id, syllabus_objective_id, lesson_date desc);

create or replace function public.validate_curriculum_coverage_record()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  assigned_class uuid;
  assigned_subject uuid;
  assigned_document uuid;
  linked_class uuid;
  linked_subject uuid;
  objective_document uuid;
  document_status text;
begin
  select assignment.class_id, document.subject_id, document.id, document.status
    into assigned_class, assigned_subject, assigned_document, document_status
  from public.curriculum_document_assignments assignment
  join public.curriculum_documents document
    on document.school_id = assignment.school_id and document.id = assignment.document_id
  where assignment.school_id = new.school_id and assignment.id = new.assignment_id;
  select document_id into objective_document
  from public.curriculum_objectives
  where school_id = new.school_id and id = new.syllabus_objective_id and review_status = 'approved';
  if assigned_class is null or assigned_class is distinct from new.class_id
    or assigned_document is distinct from objective_document
    or document_status not in ('approved', 'source_deleted') then
    raise exception 'Coverage must reference an approved objective assigned to the selected class.';
  end if;
  if new.lesson_id is null then
    raise exception 'Select the actual course lesson where coverage was recorded.';
  end if;
  select course.class_id, course.subject_id
    into linked_class, linked_subject
  from public.course_lessons lesson
  join public.lesson_courses course
    on course.school_id = lesson.school_id and course.id = lesson.course_id
  where lesson.school_id = new.school_id and lesson.id = new.lesson_id;
  if linked_class is distinct from new.class_id or linked_subject is distinct from assigned_subject then
    raise exception 'The course lesson must match the curriculum assignment class and subject.';
  end if;
  return new;
end;
$$;

create trigger validate_curriculum_coverage_record
  before insert or update on public.curriculum_coverage_records
  for each row execute function public.validate_curriculum_coverage_record();
revoke all on function public.validate_curriculum_coverage_record() from public, anon, authenticated;

create policy "Curriculum teachers read aligned assessment links"
  on public.curriculum_assessment_objectives for select to authenticated
  using (
    exists (
      select 1
      from public.learning_assessments assessment
      join public.curriculum_objectives objective
        on objective.school_id = curriculum_assessment_objectives.school_id
       and objective.id = curriculum_assessment_objectives.syllabus_objective_id
      join public.curriculum_documents document
        on document.school_id = objective.school_id and document.id = objective.document_id
      where assessment.school_id = curriculum_assessment_objectives.school_id
        and assessment.id = curriculum_assessment_objectives.assessment_id
        and public.can_manage_curriculum(document.school_id, document.subject_id)
    )
  );
