create table public.teacher_responsibilities (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  teacher_id uuid not null,
  responsibility_type text not null check (responsibility_type in ('class_teacher', 'head_of_department')),
  class_id uuid,
  department_id uuid,
  assigned_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, teacher_id)
    references public.teacher_profiles(school_id, id) on delete cascade,
  foreign key (school_id, class_id)
    references public.school_classes(school_id, id) on delete cascade,
  foreign key (school_id, department_id)
    references public.school_departments(school_id, id) on delete cascade,
  check (
    (responsibility_type = 'class_teacher' and class_id is not null and department_id is null)
    or (responsibility_type = 'head_of_department' and class_id is null and department_id is not null)
  )
);

create unique index teacher_responsibilities_class_unique
  on public.teacher_responsibilities(school_id, class_id)
  where responsibility_type = 'class_teacher';
create unique index teacher_responsibilities_department_unique
  on public.teacher_responsibilities(school_id, department_id)
  where responsibility_type = 'head_of_department';
create index teacher_responsibilities_teacher_idx
  on public.teacher_responsibilities(school_id, teacher_id, responsibility_type);

alter table public.teacher_responsibilities enable row level security;
revoke all on public.teacher_responsibilities from anon, authenticated;
grant select, insert, update, delete on public.teacher_responsibilities to authenticated;

create policy "School staff view teaching responsibilities"
  on public.teacher_responsibilities for select to authenticated
  using (
    public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
    or exists (
      select 1 from public.teacher_profiles teacher
      where teacher.school_id = teacher_responsibilities.school_id
        and teacher.id = teacher_responsibilities.teacher_id
        and teacher.profile_id = auth.uid()
    )
  );
create policy "School admins assign teaching responsibilities"
  on public.teacher_responsibilities for all to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check (
    assigned_by = auth.uid()
    and public.has_school_role(school_id, array['school_admin']::public.app_role[])
  );

alter table public.subjects
  add column department_id uuid,
  add constraint subjects_department_fk
    foreign key (school_id, department_id)
    references public.school_departments(school_id, id) on delete set null (department_id);
create index subjects_department_idx on public.subjects(school_id, department_id, name);

alter table public.learning_assessments
  add column department_id uuid,
  add constraint learning_assessments_department_fk
    foreign key (school_id, department_id)
    references public.school_departments(school_id, id) on delete set null (department_id);
create index learning_assessments_department_idx
  on public.learning_assessments(school_id, department_id, updated_at desc);

alter table public.learning_questions
  add column department_id uuid,
  add constraint learning_questions_department_fk
    foreign key (school_id, department_id)
    references public.school_departments(school_id, id) on delete set null (department_id);
create index learning_questions_department_idx
  on public.learning_questions(school_id, department_id, created_at desc);

create or replace function public.is_class_teacher(target_school uuid, target_class uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.teacher_responsibilities responsibility
    join public.teacher_profiles teacher
      on teacher.school_id = responsibility.school_id
     and teacher.id = responsibility.teacher_id
    join public.schools school on school.id = responsibility.school_id
    where responsibility.school_id = target_school
      and responsibility.class_id = target_class
      and responsibility.responsibility_type = 'class_teacher'
      and teacher.profile_id = auth.uid()
      and teacher.status = 'active'
      and teacher.employment_status = 'active'
      and school.platform_status = 'active'
  );
$$;

create or replace function public.is_hod_for_department(target_school uuid, target_department uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.teacher_responsibilities responsibility
    join public.teacher_profiles teacher
      on teacher.school_id = responsibility.school_id
     and teacher.id = responsibility.teacher_id
    join public.schools school on school.id = responsibility.school_id
    where responsibility.school_id = target_school
      and responsibility.department_id = target_department
      and responsibility.responsibility_type = 'head_of_department'
      and teacher.profile_id = auth.uid()
      and teacher.status = 'active'
      and teacher.employment_status = 'active'
      and school.platform_status = 'active'
  );
$$;

create or replace function public.is_hod_for_teacher(target_school uuid, target_teacher uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.teacher_profiles teacher
    join public.staff_profiles staff
      on staff.school_id = teacher.school_id
     and staff.id = teacher.staff_profile_id
    where teacher.school_id = target_school
      and teacher.id = target_teacher
      and staff.department_id is not null
      and public.is_hod_for_department(target_school, staff.department_id)
  );
$$;

create or replace function public.is_hod_for_subject(target_school uuid, target_subject uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.subjects subject
    where subject.school_id = target_school
      and subject.id = target_subject
      and subject.department_id is not null
      and public.is_hod_for_department(target_school, subject.department_id)
  );
$$;

create or replace function public.can_manage_lesson_course_subject(
  target_school uuid,
  target_teacher uuid,
  target_subject uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.can_manage_timetable(target_school)
    or exists (
      select 1 from public.teacher_profiles teacher
      where teacher.school_id = target_school
        and teacher.id = target_teacher
        and teacher.profile_id = auth.uid()
    )
    or (
      public.is_hod_for_teacher(target_school, target_teacher)
      and public.is_hod_for_subject(target_school, target_subject)
    );
$$;

create or replace function public.can_view_lesson_course_scoped(
  target_school uuid,
  target_class uuid,
  target_teacher uuid,
  target_subject uuid,
  target_status text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.can_manage_lesson_course_subject(target_school, target_teacher, target_subject)
    or (
      target_status = 'published'
      and (
        public.is_teacher_for_class(target_school, target_class)
        or exists (
          select 1 from public.students student
          where student.school_id = target_school
            and student.class_id = target_class
            and student.profile_id = auth.uid()
        )
        or exists (
          select 1
          from public.class_students roster
          join public.students student
            on student.school_id = roster.school_id
           and student.id = roster.student_id
          where roster.school_id = target_school
            and roster.class_id = target_class
            and student.profile_id = auth.uid()
        )
        or exists (
          select 1 from public.class_students roster
          where roster.school_id = target_school
            and roster.class_id = target_class
            and public.is_parent_of_student(target_school, roster.student_id)
        )
      )
    );
$$;

create or replace function public.is_teacher_for_class(target_school uuid, target_class uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.teacher_class_assignments assignment
    join public.teacher_profiles teacher on teacher.id = assignment.teacher_id
    join public.schools school on school.id = assignment.school_id
    where assignment.school_id = target_school
      and assignment.class_id = target_class
      and teacher.profile_id = auth.uid()
      and teacher.status = 'active'
      and teacher.employment_status = 'active'
      and school.platform_status = 'active'
  ) or public.is_class_teacher(target_school, target_class);
$$;

create or replace function public.is_teacher_record_for_class(
  target_school uuid,
  target_class uuid,
  target_teacher uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.teacher_class_assignments assignment
    join public.teacher_profiles teacher on teacher.id = assignment.teacher_id
    join public.schools school on school.id = assignment.school_id
    where assignment.school_id = target_school
      and assignment.class_id = target_class
      and assignment.teacher_id = target_teacher
      and teacher.profile_id = auth.uid()
      and teacher.status = 'active'
      and teacher.employment_status = 'active'
      and school.platform_status = 'active'
  ) or (
    public.is_class_teacher(target_school, target_class)
    and exists (
      select 1 from public.teacher_profiles teacher
      where teacher.school_id = target_school
        and teacher.id = target_teacher
        and teacher.profile_id = auth.uid()
        and teacher.status = 'active'
        and teacher.employment_status = 'active'
    )
  );
$$;

drop policy if exists "Admins manage subjects" on public.subjects;
drop policy "Academic managers manage subjects" on public.subjects;
create policy "Admins and HODs manage department subjects"
  on public.subjects for all to authenticated
  using (
    public.can_manage_timetable(school_id)
    or (department_id is not null and public.is_hod_for_department(school_id, department_id))
  )
  with check (
    public.can_manage_timetable(school_id)
    or (department_id is not null and public.is_hod_for_department(school_id, department_id))
  );

drop policy "School staff manage learning assessments" on public.learning_assessments;
create policy "Authors and department leads manage assessments"
  on public.learning_assessments for all to authenticated
  using (
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
  with check (
    public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
    or (
      public.has_school_role(school_id, array['teacher']::public.app_role[])
      and created_by = auth.uid()
    )
    or (
      department_id is not null
      and public.is_hod_for_department(school_id, department_id)
    )
  );

drop policy "School staff manage learning questions" on public.learning_questions;
create policy "Authors and department leads manage questions"
  on public.learning_questions for all to authenticated
  using (
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
  with check (
    public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
    or (
      public.has_school_role(school_id, array['teacher']::public.app_role[])
      and created_by = auth.uid()
    )
    or (
      department_id is not null
      and public.is_hod_for_department(school_id, department_id)
    )
  );

create policy "HODs read department assessment results"
  on public.learning_assessment_results for select to authenticated
  using (
    exists (
      select 1 from public.learning_assessments assessment
      where assessment.school_id = learning_assessment_results.school_id
        and assessment.id = learning_assessment_results.assessment_id
        and assessment.department_id is not null
        and public.is_hod_for_department(assessment.school_id, assessment.department_id)
    )
  );

create policy "HODs record department assessment results"
  on public.learning_assessment_results for insert to authenticated
  with check (
    status = 'draft'
    and created_by = auth.uid()
    and exists (
      select 1 from public.learning_assessments assessment
      where assessment.school_id = learning_assessment_results.school_id
        and assessment.id = learning_assessment_results.assessment_id
        and assessment.department_id is not null
        and public.is_hod_for_department(assessment.school_id, assessment.department_id)
    )
  );

create policy "HODs edit department draft results"
  on public.learning_assessment_results for update to authenticated
  using (
    status = 'draft'
    and exists (
      select 1 from public.learning_assessments assessment
      where assessment.school_id = learning_assessment_results.school_id
        and assessment.id = learning_assessment_results.assessment_id
        and assessment.department_id is not null
        and public.is_hod_for_department(assessment.school_id, assessment.department_id)
    )
  )
  with check (
    status = 'draft'
    and exists (
      select 1 from public.learning_assessments assessment
      where assessment.school_id = learning_assessment_results.school_id
        and assessment.id = learning_assessment_results.assessment_id
        and assessment.department_id is not null
        and public.is_hod_for_department(assessment.school_id, assessment.department_id)
    )
  );

create policy "HODs delete department draft results"
  on public.learning_assessment_results for delete to authenticated
  using (
    status = 'draft'
    and exists (
      select 1 from public.learning_assessments assessment
      where assessment.school_id = learning_assessment_results.school_id
        and assessment.id = learning_assessment_results.assessment_id
        and assessment.department_id is not null
        and public.is_hod_for_department(assessment.school_id, assessment.department_id)
    )
  );

drop policy if exists "Admins manage class subjects" on public.class_subjects;
drop policy "Academic managers manage class subjects" on public.class_subjects;
create policy "Admins and HODs manage department class subjects"
  on public.class_subjects for all to authenticated
  using (
    public.can_manage_timetable(school_id)
    or public.is_hod_for_subject(school_id, subject_id)
  )
  with check (
    public.can_manage_timetable(school_id)
    or public.is_hod_for_subject(school_id, subject_id)
  );

drop policy if exists "Admins manage teaching assignments" on public.teacher_class_assignments;
drop policy "Academic managers manage teaching assignments" on public.teacher_class_assignments;
create policy "Admins and HODs manage department teacher classes"
  on public.teacher_class_assignments for all to authenticated
  using (
    public.can_manage_timetable(school_id)
    or public.is_hod_for_teacher(school_id, teacher_id)
  )
  with check (
    public.can_manage_timetable(school_id)
    or public.is_hod_for_teacher(school_id, teacher_id)
  );

drop policy if exists "Admins manage teacher subjects" on public.teacher_subjects;
drop policy "Academic managers manage teacher subjects" on public.teacher_subjects;
create policy "Admins and HODs manage department teacher subjects"
  on public.teacher_subjects for all to authenticated
  using (
    public.can_manage_timetable(school_id)
    or (
      public.is_hod_for_teacher(school_id, teacher_id)
      and public.is_hod_for_subject(school_id, subject_id)
    )
  )
  with check (
    public.can_manage_timetable(school_id)
    or (
      public.is_hod_for_teacher(school_id, teacher_id)
      and public.is_hod_for_subject(school_id, subject_id)
    )
  );

drop policy "School admins manage staff profiles" on public.staff_profiles;
create policy "School admins manage staff profiles"
  on public.staff_profiles for all to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "HODs manage staff in their departments"
  on public.staff_profiles for update to authenticated
  using (department_id is not null and public.is_hod_for_department(school_id, department_id))
  with check (department_id is not null and public.is_hod_for_department(school_id, department_id));

drop policy "School admins manage teachers and qualifications" on public.teacher_profiles;
create policy "School admins manage teachers and qualifications"
  on public.teacher_profiles for all to authenticated
  using (
    public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
    or public.is_hod_for_teacher(school_id, id)
  )
  with check (
    public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
    or public.is_hod_for_teacher(school_id, id)
  );

create or replace function public.can_manage_lesson_course(target_school uuid, target_teacher uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.can_manage_timetable(target_school)
    or public.is_hod_for_teacher(target_school, target_teacher)
    or exists (
      select 1 from public.teacher_profiles teacher
      where teacher.school_id = target_school
        and teacher.id = target_teacher
        and teacher.profile_id = auth.uid()
    );
$$;

drop policy "Members read assigned or published lesson courses" on public.lesson_courses;
create policy "Members read assigned or published lesson courses"
  on public.lesson_courses for select to authenticated
  using (public.can_view_lesson_course_scoped(school_id, class_id, teacher_id, subject_id, status));

drop policy "Authorized teachers manage lesson courses" on public.lesson_courses;
create policy "Authorized teachers and HODs manage lesson courses"
  on public.lesson_courses for insert to authenticated
  with check (
    created_by = auth.uid()
    and public.can_manage_lesson_course_subject(school_id, teacher_id, subject_id)
    and (
      public.can_manage_timetable(school_id)
      or (
        public.is_teacher_record_for_class(school_id, class_id, teacher_id)
        and exists (
          select 1 from public.teacher_subjects assignment
          where assignment.school_id = lesson_courses.school_id
            and assignment.teacher_id = lesson_courses.teacher_id
            and assignment.subject_id = lesson_courses.subject_id
        )
      )
      or (
        public.is_hod_for_teacher(school_id, teacher_id)
        and public.is_hod_for_subject(school_id, subject_id)
      )
    )
  );

drop policy "Authorized teachers update lesson courses" on public.lesson_courses;
create policy "Authorized teachers and HODs update lesson courses"
  on public.lesson_courses for update to authenticated
  using (public.can_manage_lesson_course_subject(school_id, teacher_id, subject_id))
  with check (
    public.can_manage_lesson_course_subject(school_id, teacher_id, subject_id)
    and (
      public.can_manage_timetable(school_id)
      or (
        public.is_teacher_record_for_class(school_id, class_id, teacher_id)
        and exists (
          select 1 from public.teacher_subjects assignment
          where assignment.school_id = lesson_courses.school_id
            and assignment.teacher_id = lesson_courses.teacher_id
            and assignment.subject_id = lesson_courses.subject_id
        )
      )
      or (
        public.is_hod_for_teacher(school_id, teacher_id)
        and public.is_hod_for_subject(school_id, subject_id)
      )
    )
  );

drop policy "Authorized teachers delete lesson courses" on public.lesson_courses;
create policy "Authorized teachers and HODs delete lesson courses"
  on public.lesson_courses for delete to authenticated
  using (public.can_manage_lesson_course_subject(school_id, teacher_id, subject_id));

drop policy "Members read visible course units" on public.lesson_units;
create policy "Members read visible course units"
  on public.lesson_units for select to authenticated
  using (
    exists (
      select 1 from public.lesson_courses course
      where course.school_id = lesson_units.school_id
        and course.id = lesson_units.course_id
        and public.can_view_lesson_course_scoped(course.school_id, course.class_id, course.teacher_id, course.subject_id, course.status)
    )
  );

drop policy "Course teachers manage units" on public.lesson_units;
create policy "Course teachers and HODs manage units"
  on public.lesson_units for all to authenticated
  using (
    exists (
      select 1 from public.lesson_courses course
      where course.school_id = lesson_units.school_id
        and course.id = lesson_units.course_id
        and public.can_manage_lesson_course_subject(course.school_id, course.teacher_id, course.subject_id)
    )
  )
  with check (
    exists (
      select 1 from public.lesson_courses course
      where course.school_id = lesson_units.school_id
        and course.id = lesson_units.course_id
        and public.can_manage_lesson_course_subject(course.school_id, course.teacher_id, course.subject_id)
    )
  );

drop policy "Members read visible course lessons" on public.course_lessons;
create policy "Members read visible course lessons"
  on public.course_lessons for select to authenticated
  using (
    exists (
      select 1 from public.lesson_courses course
      where course.school_id = course_lessons.school_id
        and course.id = course_lessons.course_id
        and public.can_view_lesson_course_scoped(course.school_id, course.class_id, course.teacher_id, course.subject_id, course.status)
        and (course.status <> 'published' or course_lessons.published or public.can_manage_lesson_course_subject(course.school_id, course.teacher_id, course.subject_id))
    )
  );

drop policy "Course teachers manage lessons" on public.course_lessons;
create policy "Course teachers and HODs manage lessons"
  on public.course_lessons for all to authenticated
  using (
    exists (
      select 1 from public.lesson_courses course
      where course.school_id = course_lessons.school_id
        and course.id = course_lessons.course_id
        and public.can_manage_lesson_course_subject(course.school_id, course.teacher_id, course.subject_id)
    )
  )
  with check (
    exists (
      select 1 from public.lesson_courses course
      where course.school_id = course_lessons.school_id
        and course.id = course_lessons.course_id
        and public.can_manage_lesson_course_subject(course.school_id, course.teacher_id, course.subject_id)
    )
    and exists (
      select 1 from public.lesson_units unit
      where unit.school_id = course_lessons.school_id
        and unit.id = course_lessons.unit_id
        and unit.course_id = course_lessons.course_id
    )
  );

drop policy "Students and course teachers read completion records" on public.lesson_completions;
create policy "Students, parents, teachers and HODs read completion records"
  on public.lesson_completions for select to authenticated
  using (
    exists (
      select 1
      from public.course_lessons lesson
      join public.lesson_courses course
        on course.school_id = lesson.school_id
       and course.id = lesson.course_id
      where lesson.school_id = lesson_completions.school_id
        and lesson.id = lesson_completions.lesson_id
        and (
          public.can_manage_lesson_course_subject(course.school_id, course.teacher_id, course.subject_id)
          or exists (
            select 1 from public.students student
            where student.school_id = lesson_completions.school_id
              and student.id = lesson_completions.student_id
              and student.profile_id = auth.uid()
          )
          or public.is_parent_of_student(lesson_completions.school_id, lesson_completions.student_id)
        )
    )
  );

drop policy "Course teachers record lesson completion" on public.lesson_completions;
create policy "Course teachers record lesson completion"
  on public.lesson_completions for insert to authenticated
  with check (
    completed_by = auth.uid()
    and exists (
      select 1
      from public.course_lessons lesson
      join public.lesson_courses course
        on course.school_id = lesson.school_id
       and course.id = lesson.course_id
      join public.students student
        on student.school_id = lesson_completions.school_id
       and student.id = lesson_completions.student_id
      where lesson.school_id = lesson_completions.school_id
        and lesson.id = lesson_completions.lesson_id
        and student.class_id = course.class_id
        and (
          public.can_manage_timetable(course.school_id)
          or exists (
            select 1 from public.teacher_profiles teacher
            where teacher.school_id = course.school_id
              and teacher.id = course.teacher_id
              and teacher.profile_id = auth.uid()
          )
        )
    )
  );

drop policy "Course teachers clear lesson completion" on public.lesson_completions;
create policy "Course teachers clear lesson completion"
  on public.lesson_completions for delete to authenticated
  using (
    exists (
      select 1
      from public.course_lessons lesson
      join public.lesson_courses course
        on course.school_id = lesson.school_id
       and course.id = lesson.course_id
      where lesson.school_id = lesson_completions.school_id
        and lesson.id = lesson_completions.lesson_id
        and (
          public.can_manage_timetable(course.school_id)
          or exists (
            select 1 from public.teacher_profiles teacher
            where teacher.school_id = course.school_id
              and teacher.id = course.teacher_id
              and teacher.profile_id = auth.uid()
          )
        )
    )
  );

grant execute on function public.is_class_teacher(uuid, uuid) to authenticated;
grant execute on function public.is_hod_for_department(uuid, uuid) to authenticated;
grant execute on function public.is_hod_for_teacher(uuid, uuid) to authenticated;
grant execute on function public.is_hod_for_subject(uuid, uuid) to authenticated;
grant execute on function public.is_teacher_for_class(uuid, uuid) to authenticated;
grant execute on function public.is_teacher_record_for_class(uuid, uuid, uuid) to authenticated;
grant execute on function public.can_manage_lesson_course_subject(uuid, uuid, uuid) to authenticated;
grant execute on function public.can_view_lesson_course_scoped(uuid, uuid, uuid, uuid, text) to authenticated;
revoke all on function public.is_class_teacher(uuid, uuid) from public, anon;
revoke all on function public.is_hod_for_department(uuid, uuid) from public, anon;
revoke all on function public.is_hod_for_teacher(uuid, uuid) from public, anon;
revoke all on function public.is_hod_for_subject(uuid, uuid) from public, anon;
revoke all on function public.is_teacher_for_class(uuid, uuid) from public, anon;
revoke all on function public.is_teacher_record_for_class(uuid, uuid, uuid) from public, anon;
revoke all on function public.can_manage_lesson_course_subject(uuid, uuid, uuid) from public, anon;
revoke all on function public.can_view_lesson_course_scoped(uuid, uuid, uuid, uuid, text) from public, anon;

notify pgrst, 'reload schema';
