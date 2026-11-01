create table public.quality_of_life_drafts (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  entity text not null check (entity in ('assessment', 'lesson_plan', 'report_comment', 'website_content')),
  entity_id text not null check (char_length(entity_id) between 1 and 128),
  form_version text not null check (char_length(form_version) between 1 and 32),
  payload jsonb not null check (pg_column_size(payload) <= 1048576),
  correlation_id uuid not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, user_id, entity, entity_id, form_version)
);

create table public.quality_of_life_draft_versions (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  entity text not null check (entity in ('assessment', 'lesson_plan', 'report_comment', 'website_content')),
  entity_id text not null check (char_length(entity_id) between 1 and 128),
  form_version text not null check (char_length(form_version) between 1 and 32),
  payload jsonb not null check (pg_column_size(payload) <= 1048576),
  correlation_id uuid not null,
  created_at timestamptz not null default timezone('utc', now())
);

create table public.quality_of_life_draft_events (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  entity text not null check (entity in ('assessment', 'lesson_plan', 'report_comment', 'website_content')),
  entity_id text not null check (char_length(entity_id) between 1 and 128),
  event_type text not null check (event_type in ('started', 'completed', 'failed')),
  correlation_id uuid not null,
  occurred_at timestamptz not null default timezone('utc', now())
);

create or replace function public.snapshot_quality_of_life_draft()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.quality_of_life_draft_versions (
    school_id, user_id, entity, entity_id, form_version, payload, correlation_id
  ) values (
    new.school_id, new.user_id, new.entity, new.entity_id, new.form_version, new.payload, new.correlation_id
  );
  return new;
end;
$$;

revoke all on function public.snapshot_quality_of_life_draft() from public;
create trigger quality_of_life_drafts_snapshot
  after insert or update on public.quality_of_life_drafts
  for each row execute function public.snapshot_quality_of_life_draft();

create index quality_of_life_drafts_user_idx
  on public.quality_of_life_drafts(school_id, user_id, updated_at desc);
create index quality_of_life_draft_versions_lookup_idx
  on public.quality_of_life_draft_versions(school_id, user_id, entity, entity_id, created_at desc);
create index quality_of_life_draft_events_lookup_idx
  on public.quality_of_life_draft_events(school_id, user_id, occurred_at desc);

create or replace function public.can_access_quality_of_life_draft(
  target_school uuid,
  target_entity text,
  target_entity_id text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case target_entity
    when 'assessment' then public.has_school_role(
      target_school,
      array['school_admin', 'academic_coordinator', 'teacher']::public.app_role[]
    )
    when 'lesson_plan' then exists (
      select 1
      from public.lesson_courses course
      where course.school_id = target_school
        and course.id::text = target_entity_id
        and public.can_manage_lesson_course_subject(course.school_id, course.teacher_id, course.subject_id)
    )
    when 'report_comment' then
      public.has_school_role(target_school, array['school_admin', 'academic_coordinator']::public.app_role[])
      or (
        public.has_school_role(target_school, array['teacher']::public.app_role[])
        and (
          target_entity_id = 'new-result'
          or exists (
            select 1
            from public.students student
            where student.school_id = target_school
              and student.id::text = split_part(target_entity_id, ':', 1)
              and student.class_id is not null
              and public.is_teacher_for_class(student.school_id, student.class_id)
              and exists (
                select 1
                from public.learning_assessments assessment
                where assessment.school_id = target_school
                  and assessment.id::text = split_part(target_entity_id, ':', 2)
              )
          )
          or exists (
            select 1
            from public.learning_assessment_results result
            join public.students student
              on student.school_id = result.school_id and student.id = result.student_id
            where result.school_id = target_school
              and result.id::text = target_entity_id
              and result.status = 'draft'
              and student.class_id is not null
              and public.is_teacher_for_class(student.school_id, student.class_id)
          )
        )
      )
    when 'website_content' then
      public.has_school_role(target_school, array['school_admin', 'website_editor']::public.app_role[])
    else false
  end;
$$;
revoke all on function public.can_access_quality_of_life_draft(uuid, text, text) from public;
grant execute on function public.can_access_quality_of_life_draft(uuid, text, text) to authenticated;

alter table public.quality_of_life_drafts enable row level security;
alter table public.quality_of_life_draft_versions enable row level security;
alter table public.quality_of_life_draft_events enable row level security;

create policy "Users manage their authorized local-first drafts"
  on public.quality_of_life_drafts for all to authenticated
  using (
    user_id = auth.uid()
    and public.is_school_member(school_id)
    and public.can_access_quality_of_life_draft(school_id, entity, entity_id)
  )
  with check (
    user_id = auth.uid()
    and public.is_school_member(school_id)
    and public.can_access_quality_of_life_draft(school_id, entity, entity_id)
  );

create policy "Users read their authorized draft versions"
  on public.quality_of_life_draft_versions for select to authenticated
  using (
    user_id = auth.uid()
    and public.is_school_member(school_id)
    and public.can_access_quality_of_life_draft(school_id, entity, entity_id)
  );
create policy "Users record their own draft lifecycle events"
  on public.quality_of_life_draft_events for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.is_school_member(school_id)
    and public.can_access_quality_of_life_draft(school_id, entity, entity_id)
  );

revoke all on public.quality_of_life_drafts,
  public.quality_of_life_draft_versions,
  public.quality_of_life_draft_events
from anon, authenticated;
revoke all on sequence public.quality_of_life_draft_events_id_seq from anon, authenticated;
grant select, insert, update, delete on public.quality_of_life_drafts to authenticated;
grant select on public.quality_of_life_draft_versions to authenticated;
revoke insert on public.quality_of_life_draft_versions from authenticated;
grant insert on public.quality_of_life_draft_events to authenticated;
grant usage, select on sequence public.quality_of_life_draft_events_id_seq to authenticated;
