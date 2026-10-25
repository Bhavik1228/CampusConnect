insert into public.school_module_settings (school_id)
select school.id
from public.schools school
on conflict (school_id) do nothing;

drop policy if exists "School staff read module settings" on public.school_module_settings;
drop policy if exists "School members read module settings" on public.school_module_settings;
create policy "School members read module settings"
  on public.school_module_settings for select to authenticated
  using (public.is_school_member(school_id));

create or replace function public.school_can_read_published_assessment(
  target_school uuid,
  target_assessment uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.learning_assessment_results result
    join public.students student
      on student.school_id = result.school_id and student.id = result.student_id
    where result.school_id = target_school
      and result.assessment_id = target_assessment
      and result.status = 'published'
      and (
        student.profile_id = auth.uid()
        or public.is_parent_of_student(result.school_id, result.student_id)
      )
  );
$$;
revoke all on function public.school_can_read_published_assessment(uuid, uuid) from public, anon;
grant execute on function public.school_can_read_published_assessment(uuid, uuid) to authenticated;

create or replace function public.school_hod_can_access_assessment(
  target_school uuid,
  target_assessment uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.learning_assessments assessment
    where assessment.school_id = target_school
      and assessment.id = target_assessment
      and assessment.department_id is not null
      and public.is_hod_for_department(target_school, assessment.department_id)
  );
$$;
revoke all on function public.school_hod_can_access_assessment(uuid, uuid) from public, anon;
grant execute on function public.school_hod_can_access_assessment(uuid, uuid) to authenticated;

drop policy if exists "Students and parents read published assessment details"
  on public.learning_assessments;
create policy "Students and parents read published assessment details"
  on public.learning_assessments for select to authenticated
  using (public.school_can_read_published_assessment(school_id, id));

drop policy if exists "HODs read department assessment results"
  on public.learning_assessment_results;
create policy "HODs read department assessment results"
  on public.learning_assessment_results for select to authenticated
  using (public.school_hod_can_access_assessment(school_id, assessment_id));

drop policy if exists "HODs record department assessment results"
  on public.learning_assessment_results;
create policy "HODs record department assessment results"
  on public.learning_assessment_results for insert to authenticated
  with check (
    status = 'draft'
    and created_by = auth.uid()
    and public.school_hod_can_access_assessment(school_id, assessment_id)
  );

drop policy if exists "HODs edit department draft results"
  on public.learning_assessment_results;
create policy "HODs edit department draft results"
  on public.learning_assessment_results for update to authenticated
  using (
    status = 'draft'
    and public.school_hod_can_access_assessment(school_id, assessment_id)
  )
  with check (
    status = 'draft'
    and public.school_hod_can_access_assessment(school_id, assessment_id)
  );

drop policy if exists "HODs delete department draft results"
  on public.learning_assessment_results;
create policy "HODs delete department draft results"
  on public.learning_assessment_results for delete to authenticated
  using (
    status = 'draft'
    and public.school_hod_can_access_assessment(school_id, assessment_id)
  );

notify pgrst, 'reload schema';
