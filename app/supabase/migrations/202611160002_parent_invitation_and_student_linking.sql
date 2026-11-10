create or replace function public.manage_parent_student_links(
  target_school uuid,
  actor_profile uuid,
  target_profile uuid,
  parent_first_name text,
  parent_last_name text,
  parent_email text,
  parent_phone text,
  target_student_ids uuid[],
  target_relationship text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  parent_record_id uuid;
  existing_role text;
begin
  if (auth.uid() is not null and auth.uid() <> actor_profile)
    or not exists (
      select 1 from public.school_memberships membership
      where membership.school_id = target_school
        and membership.profile_id = actor_profile
        and membership.role = 'school_admin'
    ) then
    raise exception 'Only this school’s administrator can manage parent access.';
  end if;

  if target_profile is null
    or not exists (select 1 from public.profiles profile where profile.id = target_profile)
    or char_length(trim(coalesce(parent_first_name, ''))) not between 1 and 80
    or char_length(trim(coalesce(parent_last_name, ''))) not between 1 and 80
    or char_length(trim(coalesce(parent_email, ''))) not between 3 and 254
    or parent_email !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'
    or char_length(coalesce(parent_phone, '')) > 40
    or char_length(trim(coalesce(target_relationship, ''))) not between 1 and 60
    or coalesce(cardinality(target_student_ids), 0) not between 1 and 25
    or (select count(distinct selected.student_id)
        from unnest(target_student_ids) as selected(student_id)) <> cardinality(target_student_ids) then
    raise exception 'Provide valid parent details, relationship, and between one and twenty-five different students.';
  end if;

  select membership.role::text into existing_role
  from public.school_memberships membership
  where membership.school_id = target_school
    and membership.profile_id = target_profile;
  if existing_role is distinct from 'parent' then
    raise exception 'The account must have the parent role at this school.';
  end if;

  if (select count(*) from public.students student
      where student.school_id = target_school
        and student.status = 'active'
        and student.id = any(target_student_ids)) <> cardinality(target_student_ids) then
    raise exception 'One or more selected students are inactive or do not belong to this school.';
  end if;

  select parent.id into parent_record_id
  from public.parent_profiles parent
  where parent.school_id = target_school and parent.profile_id = target_profile
  order by parent.created_at
  limit 1
  for update;

  if parent_record_id is null then
    insert into public.parent_profiles(
      school_id, profile_id, first_name, last_name, email, phone
    ) values (
      target_school, target_profile, trim(parent_first_name), trim(parent_last_name),
      lower(trim(parent_email)), nullif(trim(parent_phone), '')
    )
    returning id into parent_record_id;
  else
    update public.parent_profiles
    set first_name = trim(parent_first_name),
        last_name = trim(parent_last_name),
        email = lower(trim(parent_email)),
        phone = nullif(trim(parent_phone), ''),
        updated_at = timezone('utc', now())
    where id = parent_record_id and school_id = target_school;
  end if;

  insert into public.parent_students(school_id, parent_id, student_id, relationship)
  select target_school, parent_record_id, student_id, trim(target_relationship)
  from unnest(target_student_ids) as selected(student_id)
  on conflict (parent_id, student_id) do update
  set relationship = excluded.relationship;

  return parent_record_id;
end;
$$;

revoke all on function public.manage_parent_student_links(uuid, uuid, uuid, text, text, text, text, uuid[], text)
  from public, anon, authenticated;
grant execute on function public.manage_parent_student_links(uuid, uuid, uuid, text, text, text, text, uuid[], text)
  to service_role;

notify pgrst, 'reload schema';
