create table public.student_medical_readiness (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null,
  allergy_status text not null default 'unknown'
    check (allergy_status in ('unknown', 'none_known', 'known')),
  allergy_details text not null default '' check (char_length(allergy_details) <= 5000),
  medical_conditions text not null default '' check (char_length(medical_conditions) <= 5000),
  medication_status text not null default 'unknown'
    check (medication_status in ('unknown', 'none', 'on_file')),
  medication_details text not null default '' check (char_length(medication_details) <= 5000),
  emergency_action_plan text not null default '' check (char_length(emergency_action_plan) <= 5000),
  reviewed_at date not null default current_date,
  review_due_at date,
  reviewed_by uuid not null references public.profiles(id),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, student_id),
  foreign key (school_id, student_id) references public.students(school_id, id) on delete cascade,
  check ((allergy_status = 'known' and char_length(trim(allergy_details)) > 0) or (allergy_status <> 'known' and allergy_details = '')),
  check ((medication_status = 'on_file' and char_length(trim(medication_details)) > 0) or (medication_status <> 'on_file' and medication_details = ''))
);
create index student_medical_readiness_school_review_idx
  on public.student_medical_readiness(school_id, review_due_at);

alter table public.student_medical_readiness enable row level security;
revoke all on public.student_medical_readiness from public, anon, authenticated;
create policy "Healthcare staff read medical readiness"
  on public.student_medical_readiness for select to authenticated
  using (public.health_access_enabled(school_id));
grant select on public.student_medical_readiness to authenticated;

create or replace function public.save_student_medical_readiness(
  target_school uuid,
  target_student uuid,
  readiness_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  next_allergy_status text;
  next_allergy_details text;
  next_medical_conditions text;
  next_medication_status text;
  next_medication_details text;
  next_emergency_action_plan text;
  next_review_due_at date;
begin
  if auth.uid() is null or not public.health_access_enabled(target_school) then
    raise exception 'Only this school’s authorized healthcare staff can update medical readiness.';
  end if;
  if not exists (
    select 1 from public.students
    where school_id = target_school and id = target_student
  ) then
    raise exception 'Student not found in this school.';
  end if;
  if jsonb_typeof(readiness_payload) is distinct from 'object' then
    raise exception 'Provide valid medical readiness details.';
  end if;

  next_allergy_status := readiness_payload ->> 'allergy_status';
  next_allergy_details := coalesce(readiness_payload ->> 'allergy_details', '');
  next_medical_conditions := coalesce(readiness_payload ->> 'medical_conditions', '');
  next_medication_status := readiness_payload ->> 'medication_status';
  next_medication_details := coalesce(readiness_payload ->> 'medication_details', '');
  next_emergency_action_plan := coalesce(readiness_payload ->> 'emergency_action_plan', '');
  next_review_due_at := nullif(readiness_payload ->> 'review_due_at', '')::date;

  if next_allergy_status not in ('unknown', 'none_known', 'known')
    or next_medication_status not in ('unknown', 'none', 'on_file')
    or char_length(next_allergy_details) > 5000
    or char_length(next_medical_conditions) > 5000
    or char_length(next_medication_details) > 5000
    or char_length(next_emergency_action_plan) > 5000 then
    raise exception 'Provide valid medical readiness values.';
  end if;
  if next_allergy_status = 'known' and char_length(trim(next_allergy_details)) = 0 then
    raise exception 'Describe the known allergy or allergies.';
  end if;
  if next_allergy_status <> 'known' and next_allergy_details <> '' then
    raise exception 'Allergy details can only be saved when known allergies are selected.';
  end if;
  if next_medication_status = 'on_file' and char_length(trim(next_medication_details)) = 0 then
    raise exception 'Describe the medication on file.';
  end if;
  if next_medication_status <> 'on_file' and next_medication_details <> '' then
    raise exception 'Medication details can only be saved when medication on file is selected.';
  end if;

  insert into public.student_medical_readiness(
    school_id, student_id, allergy_status, allergy_details, medical_conditions,
    medication_status, medication_details, emergency_action_plan, reviewed_at,
    review_due_at, reviewed_by, updated_at
  ) values (
    target_school, target_student, next_allergy_status, trim(next_allergy_details),
    trim(next_medical_conditions), next_medication_status, trim(next_medication_details),
    trim(next_emergency_action_plan), current_date, next_review_due_at, auth.uid(),
    timezone('utc', now())
  )
  on conflict (school_id, student_id) do update set
    allergy_status = excluded.allergy_status,
    allergy_details = excluded.allergy_details,
    medical_conditions = excluded.medical_conditions,
    medication_status = excluded.medication_status,
    medication_details = excluded.medication_details,
    emergency_action_plan = excluded.emergency_action_plan,
    reviewed_at = excluded.reviewed_at,
    review_due_at = excluded.review_due_at,
    reviewed_by = excluded.reviewed_by,
    updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.save_student_medical_readiness(uuid, uuid, jsonb) from public, anon;
grant execute on function public.save_student_medical_readiness(uuid, uuid, jsonb) to authenticated;
