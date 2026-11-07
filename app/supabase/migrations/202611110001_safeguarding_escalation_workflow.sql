create or replace function public.list_safeguarding_assignees(target_school uuid)
returns table (
  profile_id uuid,
  role public.app_role,
  full_name text,
  email text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select membership.profile_id, membership.role, profile.full_name, profile.email
  from public.school_memberships membership
  join public.profiles profile on profile.id = membership.profile_id
  where membership.school_id = target_school
    and membership.role::text in ('school_admin', 'safeguarding_officer')
    and public.can_manage_administrative_domain(target_school, 'safeguarding')
  order by profile.full_name nulls last, profile.email nulls last;
$$;

revoke all on function public.list_safeguarding_assignees(uuid) from public, anon;
grant execute on function public.list_safeguarding_assignees(uuid) to authenticated;

alter table public.school_administrative_work_items
  add constraint safeguarding_work_item_details_valid check (
    domain <> 'safeguarding'
    or (
      (details ->> 'category' is null or details ->> 'category' in (
        'bullying', 'abuse_disclosure', 'neglect', 'online_safety',
        'mental_wellbeing', 'attendance', 'other'
      ))
      and (details ->> 'escalation_level' is null or details ->> 'escalation_level' in ('routine', 'urgent', 'immediate'))
      and (
        details ->> 'incident_date' is null
        or details ->> 'incident_date' ~ '^\d{4}-\d{2}-\d{2}$'
      )
      and char_length(coalesce(details ->> 'reference', '')) <= 120
      and char_length(coalesce(details ->> 'location', '')) <= 200
      and char_length(coalesce(details ->> 'immediate_action', '')) <= 2000
      and char_length(coalesce(details ->> 'referral_details', '')) <= 2000
      and char_length(coalesce(details ->> 'latest_note', '')) <= 1000
    )
  );

create or replace function public.enforce_safeguarding_referral_approval()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.domain = 'safeguarding'
    and new.status in ('approved', 'rejected')
    and (
      tg_op = 'INSERT'
      or old.status is distinct from new.status
    ) then
    if new.record_type <> 'referral' then
      raise exception 'Only safeguarding referral records can be approved or declined.';
    end if;
    if not public.has_school_role(new.school_id, array['school_admin']::public.app_role[]) then
      raise exception 'A school administrator must approve or decline safeguarding referrals.';
    end if;
  end if;
  return new;
end;
$$;

create trigger enforce_safeguarding_referral_approval
  before insert or update on public.school_administrative_work_items
  for each row execute function public.enforce_safeguarding_referral_approval();
