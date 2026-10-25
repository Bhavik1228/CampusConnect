alter table public.school_websites
  add column if not exists public_library_enabled boolean not null default false;

create or replace function public.get_school_library_publication_settings(target_school uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  publication_settings jsonb;
begin
  if not public.is_school_member(target_school) then
    raise exception 'School membership is required to read library publication settings.';
  end if;

  select jsonb_build_object(
    'slug', website.slug,
    'enabled', website.enabled,
    'public_library_enabled', website.public_library_enabled
  )
  into publication_settings
  from public.school_websites website
  where website.school_id = target_school;

  return publication_settings;
end;
$$;
revoke all on function public.get_school_library_publication_settings(uuid) from public, anon;
grant execute on function public.get_school_library_publication_settings(uuid) to authenticated;

notify pgrst, 'reload schema';
