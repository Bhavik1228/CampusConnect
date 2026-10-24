create or replace function public.get_school_mfa_policy(target_school uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  settings_row public.school_security_settings%rowtype;
begin
  if not exists (
    select 1 from public.school_memberships membership
    where membership.school_id = target_school
      and membership.profile_id = auth.uid()
  ) then
    raise exception 'School membership is required to read its MFA policy.';
  end if;

  select * into settings_row
  from public.school_security_settings
  where school_id = target_school;
  return jsonb_build_object(
    'require_mfa', coalesce(settings_row.require_mfa, false),
    'mfa_methods', coalesce(settings_row.mfa_methods, '{}'::text[])
  );
end;
$$;
revoke all on function public.get_school_mfa_policy(uuid) from public, anon;
grant execute on function public.get_school_mfa_policy(uuid) to authenticated;

create or replace function public.school_mfa_satisfied(target_school uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.school_memberships membership
    where membership.school_id = target_school
      and membership.profile_id = auth.uid()
      and (
        not exists (
          select 1 from public.school_security_settings settings
          where settings.school_id = target_school
            and settings.require_mfa
        )
        or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      )
  );
$$;
revoke all on function public.school_mfa_satisfied(uuid) from public, anon;
grant execute on function public.school_mfa_satisfied(uuid) to authenticated;

do $$
declare
  target_table record;
begin
  for target_table in
    select table_info.table_name
    from information_schema.columns table_info
    join pg_class relation on relation.relname = table_info.table_name
    join pg_namespace schema_info on schema_info.oid = relation.relnamespace
    where table_info.table_schema = 'public'
      and table_info.column_name = 'school_id'
      and schema_info.nspname = 'public'
      and relation.relkind in ('r', 'p')
      and relation.relrowsecurity
      and table_info.table_name not in ('school_memberships', 'school_security_settings', 'schools')
  loop
    execute format(
      'drop policy if exists "Require school MFA" on public.%I',
      target_table.table_name
    );
    execute format(
      'create policy "Require school MFA" on public.%I as restrictive for all to authenticated using (school_id is null or public.school_mfa_satisfied(school_id)) with check (school_id is null or public.school_mfa_satisfied(school_id))',
      target_table.table_name
    );
  end loop;
end;
$$;
