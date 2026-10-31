create or replace function public.validate_assignment_prerequisites()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
    from public.teacher_profiles teacher
    where teacher.school_id = new.school_id
      and teacher.id = new.teacher_id
      and teacher.status = 'active'
  ) then
    raise exception 'Choose an active teacher in this school for the assignment.';
  end if;

  if exists (
    select 1
    from public.teacher_class_assignments assignment
    where assignment.school_id = new.school_id
      and assignment.class_id = new.class_id
  ) and not exists (
    select 1
    from public.teacher_class_assignments assignment
    where assignment.school_id = new.school_id
      and assignment.class_id = new.class_id
      and assignment.teacher_id = new.teacher_id
  ) then
    raise exception 'The selected teacher is not assigned to this class.';
  end if;

  if exists (
    select 1
    from public.class_subjects assignment
    where assignment.school_id = new.school_id
      and assignment.class_id = new.class_id
  ) and not exists (
    select 1
    from public.class_subjects assignment
    where assignment.school_id = new.school_id
      and assignment.class_id = new.class_id
      and assignment.subject_id = new.subject_id
  ) then
    raise exception 'The selected subject is not offered to this class.';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_assignment_prerequisites on public.assignments;
create trigger validate_assignment_prerequisites
  before insert or update of school_id, class_id, subject_id, teacher_id
  on public.assignments
  for each row execute function public.validate_assignment_prerequisites();
