drop policy "Academic leads manage curriculum templates" on public.curriculum_templates;

create policy "Academic leads create curriculum template versions"
  on public.curriculum_templates for insert to authenticated
  with check (
    created_by = auth.uid()
    and (
      public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
      or (
        not is_approved
        and subject_id is not null
        and public.is_hod_for_subject(school_id, subject_id)
      )
    )
  );

create or replace function public.prevent_curriculum_template_version_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from public.schools where id = old.school_id
  ) then
    return old;
  end if;
  if tg_op = 'UPDATE' and old.subject_id is not null and new.subject_id is null then
    return new;
  end if;
  raise exception 'Curriculum template versions are immutable. Create a new version instead.';
end;
$$;

create trigger curriculum_template_versions_immutable
  before update or delete on public.curriculum_templates
  for each row execute function public.prevent_curriculum_template_version_mutation();

revoke update, delete on public.curriculum_templates from authenticated;
grant select, insert on public.curriculum_templates to authenticated;
revoke all on function public.prevent_curriculum_template_version_mutation() from public, anon, authenticated;
