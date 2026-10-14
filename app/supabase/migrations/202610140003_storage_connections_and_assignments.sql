alter table public.learning_materials
  add column storage_connection_id uuid;

create table public.school_storage_connections (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  label text not null check (char_length(trim(label)) between 2 and 80),
  credentials_ciphertext text not null,
  credentials_nonce text not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id)
);

alter table public.learning_materials
  add constraint learning_materials_storage_connection_fk
  foreign key (school_id, storage_connection_id)
  references public.school_storage_connections(school_id, id)
  on delete restrict;

alter table public.school_storage_connections enable row level security;
revoke all on public.school_storage_connections from anon, authenticated;
grant all on public.school_storage_connections to service_role;

create trigger audit_school_record_change
  after insert or update or delete on public.school_storage_connections
  for each row execute function public.log_school_record_change();

alter table public.assignments
  add column attached_material_id uuid references public.learning_materials(id) on delete set null;

create or replace function public.validate_assignment_material_attachment()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.attached_material_id is not null and not exists (
    select 1 from public.learning_materials material
    where material.id = new.attached_material_id
      and material.school_id = new.school_id
      and material.class_id = new.class_id
      and material.is_uploaded
      and material.is_published
  ) then
    raise exception 'Assignments can only attach a published resource for the same school and class.';
  end if;
  return new;
end;
$$;

create trigger validate_assignment_material_attachment
  before insert or update on public.assignments
  for each row execute function public.validate_assignment_material_attachment();

drop policy if exists "Authorized users read published assignments" on public.assignments;
drop policy if exists "Teachers and admins manage assignments" on public.assignments;

create policy "Authorized members read assignments"
  on public.assignments for select to authenticated
  using (
    public.can_manage_timetable(school_id)
    or public.is_teacher_for_class(school_id, class_id)
    or (
      status = 'published'
      and (
        exists (
          select 1 from public.students student
          where student.school_id = assignments.school_id
            and student.class_id = assignments.class_id
            and student.profile_id = auth.uid()
        )
        or exists (
          select 1 from public.class_students roster
          where roster.school_id = assignments.school_id
            and roster.class_id = assignments.class_id
            and public.is_parent_of_student(assignments.school_id, roster.student_id)
        )
      )
    )
  );

create policy "Authorized teachers manage assignments"
  on public.assignments for all to authenticated
  using (
    public.can_manage_timetable(school_id)
    or public.is_teacher_record_for_class(school_id, class_id, teacher_id)
  )
  with check (
    public.can_manage_timetable(school_id)
    or public.is_teacher_record_for_class(school_id, class_id, teacher_id)
  );

drop policy if exists "Students and teachers read submissions" on public.assignment_submissions;
drop policy if exists "Students submit and teachers grade" on public.assignment_submissions;

create policy "Authorized users read assignment submissions"
  on public.assignment_submissions for select to authenticated
  using (
    public.can_manage_timetable(school_id)
    or public.is_teacher_for_class(
      school_id,
      (select assignment.class_id from public.assignments assignment
       where assignment.school_id = assignment_submissions.school_id
         and assignment.id = assignment_submissions.assignment_id)
    )
    or exists (
      select 1 from public.students student
      where student.school_id = assignment_submissions.school_id
        and student.id = assignment_submissions.student_id
        and student.profile_id = auth.uid()
    )
    or public.is_parent_of_student(school_id, student_id)
  );

create policy "Students submit their own published assignments"
  on public.assignment_submissions for insert to authenticated
  with check (
    exists (
      select 1
      from public.students student
      join public.assignments assignment
        on assignment.school_id = student.school_id
       and assignment.class_id = student.class_id
      where student.school_id = assignment_submissions.school_id
        and student.id = assignment_submissions.student_id
        and student.profile_id = auth.uid()
        and assignment.id = assignment_submissions.assignment_id
        and assignment.status = 'published'
    )
  );

create policy "Students and assigned staff update submissions"
  on public.assignment_submissions for update to authenticated
  using (
    exists (
      select 1 from public.students student
      where student.school_id = assignment_submissions.school_id
        and student.id = assignment_submissions.student_id
        and student.profile_id = auth.uid()
    )
    or public.can_manage_timetable(school_id)
    or public.is_teacher_for_class(
      school_id,
      (select assignment.class_id from public.assignments assignment
       where assignment.school_id = assignment_submissions.school_id
         and assignment.id = assignment_submissions.assignment_id)
    )
  )
  with check (
    exists (
      select 1 from public.students student
      where student.school_id = assignment_submissions.school_id
        and student.id = assignment_submissions.student_id
        and student.profile_id = auth.uid()
    )
    or public.can_manage_timetable(school_id)
    or public.is_teacher_for_class(
      school_id,
      (select assignment.class_id from public.assignments assignment
       where assignment.school_id = assignment_submissions.school_id
         and assignment.id = assignment_submissions.assignment_id)
    )
  );

revoke all on public.assignments from anon, authenticated;
grant select, insert, update, delete on public.assignments to authenticated;
revoke all on public.assignment_submissions from anon, authenticated;
grant select on public.assignment_submissions to authenticated;
grant insert (school_id, assignment_id, student_id, storage_path, text_response)
  on public.assignment_submissions to authenticated;
grant update (storage_path, text_response, status, marks, feedback, graded_by)
  on public.assignment_submissions to authenticated;

create or replace function public.validate_assignment_submission()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  is_own_student boolean;
  validate_path boolean := false;
  assignment_record public.assignments%rowtype;
begin
  select * into assignment_record
  from public.assignments assignment
  where assignment.school_id = new.school_id
    and assignment.id = new.assignment_id;
  if not found then
    raise exception 'The assignment is not available.';
  end if;

  select exists (
    select 1 from public.students student
    where student.school_id = new.school_id
      and student.id = new.student_id
      and student.profile_id = auth.uid()
  ) into is_own_student;

  if tg_op = 'INSERT' then
    validate_path := true;
    if not is_own_student or assignment_record.status <> 'published'
      or not exists (
        select 1 from public.students student
        where student.school_id = new.school_id
          and student.id = new.student_id
          and student.class_id = assignment_record.class_id
      ) then
      raise exception 'Only an enrolled student can submit this published assignment.';
    end if;
    new.submitted_at := timezone('utc', now());
    new.status := case
      when assignment_record.due_at is not null and assignment_record.due_at < new.submitted_at
        then 'late'::public.submission_status
      else 'submitted'::public.submission_status
    end;
    new.marks := null;
    new.feedback := null;
    new.graded_by := null;
  else
    validate_path := new.storage_path is distinct from old.storage_path;
    if new.school_id <> old.school_id
      or new.assignment_id <> old.assignment_id
      or new.student_id <> old.student_id then
      raise exception 'Submission ownership cannot be changed.';
    end if;

    if is_own_student then
      if old.status = 'graded' then
        raise exception 'Graded work cannot be changed unless the teacher returns it.';
      end if;
      if new.marks is distinct from old.marks
        or new.feedback is distinct from old.feedback
        or new.graded_by is distinct from old.graded_by then
        raise exception 'Students cannot change teacher feedback or marks.';
      end if;
      if assignment_record.status <> 'published' then
        raise exception 'This assignment is no longer accepting submissions.';
      end if;
      new.submitted_at := timezone('utc', now());
      new.status := case
        when assignment_record.due_at is not null and assignment_record.due_at < new.submitted_at
          then 'late'::public.submission_status
        else 'submitted'::public.submission_status
      end;
      if old.status = 'returned' then
        new.marks := null;
        new.feedback := null;
        new.graded_by := null;
      end if;
    else
      if new.storage_path is distinct from old.storage_path
        or new.text_response is distinct from old.text_response
        or new.submitted_at is distinct from old.submitted_at then
        raise exception 'Teachers cannot change a student submission.';
      end if;
      if new.marks is not null and (
        assignment_record.max_marks is null
        or new.marks > assignment_record.max_marks
      ) then
        raise exception 'Marks cannot exceed the assignment maximum.';
      end if;
      if new.status not in ('graded', 'returned') and (
        new.marks is not null or new.feedback is not null or new.graded_by is not null
      ) then
        raise exception 'Graded submissions must be marked as graded or returned.';
      end if;
      if new.status in ('graded', 'returned') then
        new.graded_by := auth.uid();
      end if;
    end if;
  end if;

  if validate_path
    and new.storage_path is not null
    and (
      split_part(new.storage_path, '/', 1) <> new.school_id::text
      or split_part(new.storage_path, '/', 2) <> new.student_id::text
      or split_part(new.storage_path, '/', 3) <> new.assignment_id::text
      or split_part(new.storage_path, '/', 4) = ''
    ) then
    raise exception 'Submission attachments must be stored under their school, student, and assignment.';
  end if;

  return new;
end;
$$;

create trigger validate_assignment_submission
  before insert or update on public.assignment_submissions
  for each row execute function public.validate_assignment_submission();

create policy "Students remove their own assignment files"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'assignment-submissions'
    and exists (
      select 1 from public.students student
      where student.profile_id = auth.uid()
        and student.school_id::text = (storage.foldername(name))[1]
        and student.id::text = (storage.foldername(name))[2]
    )
  );

drop policy if exists "School staff upload school files" on storage.objects;
create policy "School staff upload school files"
  on storage.objects for insert to authenticated
  with check (
    (
      bucket_id in ('learning-materials', 'school-documents')
      and exists (
        select 1 from public.school_memberships membership
        where membership.profile_id = auth.uid()
          and membership.school_id::text = (storage.foldername(name))[1]
          and membership.role in ('school_admin', 'teacher')
      )
    )
    or (
      bucket_id = 'assignment-submissions'
      and exists (
        select 1
        from public.students student
        join public.assignments assignment
          on assignment.school_id = student.school_id
         and assignment.class_id = student.class_id
        where student.profile_id = auth.uid()
          and student.school_id::text = (storage.foldername(name))[1]
          and student.id::text = (storage.foldername(name))[2]
          and assignment.id::text = (storage.foldername(name))[3]
          and assignment.status = 'published'
      )
    )
  );

update storage.buckets
set file_size_limit = 52428800,
    allowed_mime_types = array[
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain',
      'image/jpeg',
      'image/png',
      'image/webp'
    ]
where id = 'assignment-submissions';
