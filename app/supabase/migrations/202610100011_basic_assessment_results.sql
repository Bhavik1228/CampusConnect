create table public.learning_assessment_results (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null,
  assessment_id uuid not null,
  created_by uuid not null references public.profiles(id),
  marks_obtained numeric(8,2) not null check (marks_obtained >= 0),
  maximum_marks numeric(8,2) not null check (maximum_marks > 0),
  percentage numeric(5,2) generated always as (
    round((marks_obtained / maximum_marks) * 100, 2)
  ) stored,
  assessment_date date not null default current_date,
  notes text not null default '',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, student_id)
    references public.students(school_id, id) on delete restrict,
  foreign key (school_id, assessment_id)
    references public.learning_assessments(school_id, id) on delete restrict,
  check (marks_obtained <= maximum_marks)
);

create index learning_assessment_results_student_history_idx
  on public.learning_assessment_results(school_id, student_id, assessment_date desc, created_at desc);

create index learning_assessment_results_assessment_history_idx
  on public.learning_assessment_results(school_id, assessment_id, assessment_date desc);

alter table public.learning_assessment_results enable row level security;

create policy "School staff manage learning assessment results"
  on public.learning_assessment_results for all to authenticated
  using (
    public.has_school_role(school_id, array['school_admin']::public.app_role[])
    or (
      public.has_school_role(school_id, array['teacher']::public.app_role[])
      and exists (
        select 1
        from public.students student
        where student.school_id = learning_assessment_results.school_id
          and student.id = learning_assessment_results.student_id
          and student.class_id is not null
          and public.is_teacher_for_class(student.school_id, student.class_id)
      )
    )
  )
  with check (
    public.has_school_role(school_id, array['school_admin']::public.app_role[])
    or (
      public.has_school_role(school_id, array['teacher']::public.app_role[])
      and exists (
        select 1
        from public.students student
        where student.school_id = learning_assessment_results.school_id
          and student.id = learning_assessment_results.student_id
          and student.class_id is not null
          and public.is_teacher_for_class(student.school_id, student.class_id)
      )
    )
  );

grant select, insert, update, delete on public.learning_assessment_results to authenticated;
