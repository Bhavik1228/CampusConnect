alter table public.learning_assessment_results
  add column if not exists teacher_comment text not null default '',
  add column if not exists status text not null default 'draft'
    check (status in ('draft', 'approved', 'published')),
  add column if not exists approved_by uuid references public.profiles(id),
  add column if not exists approved_at timestamptz,
  add column if not exists correction_reason text not null default '';

create index if not exists learning_assessment_results_school_status_idx
  on public.learning_assessment_results(school_id, status, assessment_date desc);

create table public.learning_result_revisions (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools(id) on delete cascade,
  result_id uuid not null references public.learning_assessment_results(id) on delete cascade,
  changed_by uuid not null references public.profiles(id),
  previous_marks numeric(8,2) not null,
  previous_comment text not null,
  reason text not null,
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.learning_result_revisions enable row level security;

create policy "School academic leads read result revisions"
  on public.learning_result_revisions for select to authenticated
  using (public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[]));

grant select on public.learning_result_revisions to authenticated;

create or replace function public.audit_learning_result_correction()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status in ('approved', 'published')
    and (new.marks_obtained is distinct from old.marks_obtained
      or new.teacher_comment is distinct from old.teacher_comment) then
    if not public.has_school_role(
      old.school_id,
      array['school_admin', 'academic_coordinator']::public.app_role[]
    ) then
      raise exception 'Only a school administrator or academic coordinator may correct an approved result.';
    end if;
    if char_length(trim(new.correction_reason)) < 5 then
      raise exception 'Enter a correction reason of at least five characters.';
    end if;
    insert into public.learning_result_revisions (
      school_id, result_id, changed_by, previous_marks, previous_comment, reason
    ) values (
      old.school_id, old.id, auth.uid(), old.marks_obtained,
      old.teacher_comment, trim(new.correction_reason)
    );
  end if;
  return new;
end;
$$;

create trigger learning_result_correction_audit
  before update on public.learning_assessment_results
  for each row execute function public.audit_learning_result_correction();

create or replace function public.guard_learning_result_status_transition()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status is distinct from old.status then
    if not public.has_school_role(
      old.school_id,
      array['school_admin', 'academic_coordinator']::public.app_role[]
    ) then
      raise exception 'Only a school administrator or academic coordinator may approve or publish results.';
    end if;
    if old.status = 'draft' and new.status <> 'approved' then
      raise exception 'A draft result must be approved before it can be published.';
    end if;
    if old.status = 'approved' and new.status <> 'published' then
      raise exception 'An approved result cannot be returned to an earlier status.';
    end if;
    if old.status = 'published' then
      raise exception 'A published result cannot be unpublished.';
    end if;
    if new.status = 'approved'
      and (new.approved_by is null or new.approved_at is null) then
      raise exception 'Approving a result requires an approver and approval time.';
    end if;
  end if;
  return new;
end;
$$;

create trigger learning_result_status_transition_guard
  before update on public.learning_assessment_results
  for each row execute function public.guard_learning_result_status_transition();

drop policy if exists "School staff manage learning assessment results"
  on public.learning_assessment_results;

create policy "Authorized users read learning assessment results"
  on public.learning_assessment_results for select to authenticated
  using (
    public.has_school_role(
      school_id, array['school_admin', 'academic_coordinator']::public.app_role[]
    )
    or (
      public.has_school_role(school_id, array['teacher']::public.app_role[])
      and exists (
        select 1 from public.students student
        where student.school_id = learning_assessment_results.school_id
          and student.id = learning_assessment_results.student_id
          and student.class_id is not null
          and public.is_teacher_for_class(student.school_id, student.class_id)
      )
    )
    or (
      status = 'published'
      and (
        exists (
          select 1 from public.students student
          where student.school_id = learning_assessment_results.school_id
            and student.id = learning_assessment_results.student_id
            and student.profile_id = auth.uid()
        )
        or public.is_parent_of_student(school_id, student_id)
      )
    )
  );

create policy "Students and parents read published assessment details"
  on public.learning_assessments for select to authenticated
  using (
    exists (
      select 1 from public.learning_assessment_results result
      where result.school_id = learning_assessments.school_id
        and result.assessment_id = learning_assessments.id
        and result.status = 'published'
        and (
          exists (
            select 1 from public.students student
            where student.school_id = result.school_id
              and student.id = result.student_id
              and student.profile_id = auth.uid()
          )
          or public.is_parent_of_student(result.school_id, result.student_id)
        )
    )
  );

create policy "Teachers and academic leads record results"
  on public.learning_assessment_results for insert to authenticated
  with check (
    status = 'draft'
    and created_by = auth.uid()
    and (
      public.has_school_role(
        school_id, array['school_admin', 'academic_coordinator']::public.app_role[]
      )
      or (
        public.has_school_role(school_id, array['teacher']::public.app_role[])
        and exists (
          select 1 from public.students student
          where student.school_id = learning_assessment_results.school_id
            and student.id = learning_assessment_results.student_id
            and student.class_id is not null
            and public.is_teacher_for_class(student.school_id, student.class_id)
        )
      )
    )
  );

create policy "Teachers edit drafts and academic leads manage results"
  on public.learning_assessment_results for update to authenticated
  using (
    public.has_school_role(
      school_id, array['school_admin', 'academic_coordinator']::public.app_role[]
    )
    or (
      status = 'draft'
      and public.has_school_role(school_id, array['teacher']::public.app_role[])
      and exists (
        select 1 from public.students student
        where student.school_id = learning_assessment_results.school_id
          and student.id = learning_assessment_results.student_id
          and student.class_id is not null
          and public.is_teacher_for_class(student.school_id, student.class_id)
      )
    )
  )
  with check (
    public.has_school_role(
      school_id, array['school_admin', 'academic_coordinator']::public.app_role[]
    )
    or (
      status = 'draft'
      and public.has_school_role(school_id, array['teacher']::public.app_role[])
      and exists (
        select 1 from public.students student
        where student.school_id = learning_assessment_results.school_id
          and student.id = learning_assessment_results.student_id
          and student.class_id is not null
          and public.is_teacher_for_class(student.school_id, student.class_id)
      )
    )
  );

create policy "School staff delete draft results"
  on public.learning_assessment_results for delete to authenticated
  using (
    status = 'draft'
    and (
      public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
      or (
        public.has_school_role(school_id, array['teacher']::public.app_role[])
        and exists (
          select 1 from public.students student
          where student.school_id = learning_assessment_results.school_id
            and student.id = learning_assessment_results.student_id
            and student.class_id is not null
            and public.is_teacher_for_class(student.school_id, student.class_id)
        )
      )
    )
  );

create table public.school_report_templates (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 60),
  layout text not null check (layout in ('classic', 'modern', 'minimal', 'academic', 'vibrant')),
  title text not null check (char_length(trim(title)) between 2 and 100),
  subtitle text not null default '' check (char_length(subtitle) <= 160),
  accent_color text not null default '#5147c7'
    check (accent_color ~ '^#[0-9a-fA-F]{6}$'),
  footer text not null default '' check (char_length(footer) <= 200),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id)
);

alter table public.school_report_templates enable row level security;

create policy "School members read report templates"
  on public.school_report_templates for select to authenticated
  using (public.is_school_member(school_id));

create policy "School admins manage report templates"
  on public.school_report_templates for all to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));

grant select, insert, update, delete on public.school_report_templates to authenticated;
