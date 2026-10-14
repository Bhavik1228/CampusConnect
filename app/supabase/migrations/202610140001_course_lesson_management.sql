create table public.lesson_courses (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  subject_id uuid not null,
  class_id uuid not null,
  teacher_id uuid not null,
  title text not null check (char_length(trim(title)) between 2 and 140),
  description text not null default '' check (char_length(description) <= 5000),
  objectives text not null default '' check (char_length(objectives) <= 5000),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, subject_id) references public.subjects(school_id, id) on delete restrict,
  foreign key (school_id, class_id) references public.school_classes(school_id, id) on delete restrict,
  foreign key (school_id, teacher_id) references public.teacher_profiles(school_id, id) on delete restrict
);

create index lesson_courses_school_class_idx
  on public.lesson_courses(school_id, class_id, status, title);

create table public.lesson_units (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  course_id uuid not null,
  title text not null check (char_length(trim(title)) between 1 and 140),
  description text not null default '' check (char_length(description) <= 3000),
  position integer not null default 0 check (position >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, course_id) references public.lesson_courses(school_id, id) on delete cascade
);

create index lesson_units_course_position_idx
  on public.lesson_units(school_id, course_id, position, title);

create table public.course_lessons (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  course_id uuid not null,
  unit_id uuid not null,
  title text not null check (char_length(trim(title)) between 2 and 160),
  description text not null default '' check (char_length(description) <= 5000),
  objectives text not null default '' check (char_length(objectives) <= 5000),
  position integer not null default 0 check (position >= 0),
  published boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, course_id) references public.lesson_courses(school_id, id) on delete cascade,
  foreign key (school_id, unit_id) references public.lesson_units(school_id, id) on delete cascade
);

create index course_lessons_unit_position_idx
  on public.course_lessons(school_id, unit_id, position, title);

create table public.lesson_completions (
  school_id uuid not null,
  lesson_id uuid not null,
  student_id uuid not null,
  completed_at timestamptz not null default timezone('utc', now()),
  completed_by uuid not null references public.profiles(id),
  primary key (lesson_id, student_id),
  foreign key (school_id, lesson_id) references public.course_lessons(school_id, id) on delete cascade,
  foreign key (school_id, student_id) references public.students(school_id, id) on delete cascade
);

create index lesson_completions_school_student_idx
  on public.lesson_completions(school_id, student_id, completed_at desc);

create or replace function public.can_manage_lesson_course(target_school uuid, target_teacher uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.can_manage_timetable(target_school)
    or exists (
      select 1
      from public.teacher_profiles teacher
      where teacher.school_id = target_school
        and teacher.id = target_teacher
        and teacher.profile_id = auth.uid()
    );
$$;

create or replace function public.can_view_lesson_course(
  target_school uuid,
  target_class uuid,
  target_teacher uuid,
  target_status text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.can_manage_lesson_course(target_school, target_teacher)
    or (
      target_status = 'published'
      and (
        public.is_teacher_for_class(target_school, target_class)
        or exists (
          select 1
          from public.students student
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
          select 1
          from public.class_students roster
          where roster.school_id = target_school
            and roster.class_id = target_class
            and public.is_parent_of_student(target_school, roster.student_id)
        )
      )
    );
$$;

alter table public.lesson_courses enable row level security;
alter table public.lesson_units enable row level security;
alter table public.course_lessons enable row level security;
alter table public.lesson_completions enable row level security;

create policy "Members read assigned or published lesson courses"
  on public.lesson_courses for select to authenticated
  using (public.can_view_lesson_course(school_id, class_id, teacher_id, status));
create policy "Authorized teachers manage lesson courses"
  on public.lesson_courses for insert to authenticated
  with check (
    created_by = auth.uid()
    and public.can_manage_lesson_course(school_id, teacher_id)
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
    )
  );
create policy "Authorized teachers update lesson courses"
  on public.lesson_courses for update to authenticated
  using (public.can_manage_lesson_course(school_id, teacher_id))
  with check (
    public.can_manage_lesson_course(school_id, teacher_id)
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
    )
  );
create policy "Authorized teachers delete lesson courses"
  on public.lesson_courses for delete to authenticated
  using (public.can_manage_lesson_course(school_id, teacher_id));

create policy "Members read visible course units"
  on public.lesson_units for select to authenticated
  using (
    exists (
      select 1 from public.lesson_courses course
      where course.school_id = lesson_units.school_id
        and course.id = lesson_units.course_id
        and public.can_view_lesson_course(course.school_id, course.class_id, course.teacher_id, course.status)
    )
  );
create policy "Course teachers manage units"
  on public.lesson_units for all to authenticated
  using (
    exists (
      select 1 from public.lesson_courses course
      where course.school_id = lesson_units.school_id
        and course.id = lesson_units.course_id
        and public.can_manage_lesson_course(course.school_id, course.teacher_id)
    )
  )
  with check (
    exists (
      select 1 from public.lesson_courses course
      where course.school_id = lesson_units.school_id
        and course.id = lesson_units.course_id
        and public.can_manage_lesson_course(course.school_id, course.teacher_id)
    )
  );

create policy "Members read visible course lessons"
  on public.course_lessons for select to authenticated
  using (
    (
      published
      and exists (
        select 1 from public.lesson_courses course
        where course.school_id = course_lessons.school_id
          and course.id = course_lessons.course_id
          and public.can_view_lesson_course(course.school_id, course.class_id, course.teacher_id, course.status)
      )
    )
    or exists (
      select 1 from public.lesson_courses course
      where course.school_id = course_lessons.school_id
        and course.id = course_lessons.course_id
        and public.can_manage_lesson_course(course.school_id, course.teacher_id)
    )
  );
create policy "Course teachers manage lessons"
  on public.course_lessons for all to authenticated
  using (
    exists (
      select 1 from public.lesson_courses course
      where course.school_id = course_lessons.school_id
        and course.id = course_lessons.course_id
        and public.can_manage_lesson_course(course.school_id, course.teacher_id)
    )
  )
  with check (
    exists (
      select 1 from public.lesson_courses course
      where course.school_id = course_lessons.school_id
        and course.id = course_lessons.course_id
        and public.can_manage_lesson_course(course.school_id, course.teacher_id)
    )
    and exists (
      select 1 from public.lesson_units unit
      where unit.school_id = course_lessons.school_id
        and unit.id = course_lessons.unit_id
        and unit.course_id = course_lessons.course_id
    )
  );

create policy "Students and course teachers read completion records"
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
          public.can_manage_lesson_course(course.school_id, course.teacher_id)
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
        and public.can_manage_lesson_course(course.school_id, course.teacher_id)
    )
  );
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
        and public.can_manage_lesson_course(course.school_id, course.teacher_id)
    )
  );

create trigger lesson_courses_set_updated_at
  before update on public.lesson_courses
  for each row execute function public.set_updated_at();
create trigger lesson_units_set_updated_at
  before update on public.lesson_units
  for each row execute function public.set_updated_at();
create trigger course_lessons_set_updated_at
  before update on public.course_lessons
  for each row execute function public.set_updated_at();

create trigger audit_lesson_course_change
  after insert or update or delete on public.lesson_courses
  for each row execute function public.log_school_record_change();
create trigger audit_lesson_unit_change
  after insert or update or delete on public.lesson_units
  for each row execute function public.log_school_record_change();
create trigger audit_course_lesson_change
  after insert or update or delete on public.course_lessons
  for each row execute function public.log_school_record_change();
create trigger audit_lesson_completion_change
  after insert or delete on public.lesson_completions
  for each row execute function public.log_school_record_change();

grant select, insert, update, delete on public.lesson_courses to authenticated;
grant select, insert, update, delete on public.lesson_units to authenticated;
grant select, insert, update, delete on public.course_lessons to authenticated;
grant select, insert, delete on public.lesson_completions to authenticated;
revoke all on function public.can_manage_lesson_course(uuid, uuid) from public;
grant execute on function public.can_manage_lesson_course(uuid, uuid) to authenticated;
revoke all on function public.can_view_lesson_course(uuid, uuid, uuid, text) from public;
grant execute on function public.can_view_lesson_course(uuid, uuid, uuid, text) to authenticated;
