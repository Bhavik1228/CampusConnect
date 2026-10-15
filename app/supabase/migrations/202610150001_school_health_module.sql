alter type public.app_role add value if not exists 'nurse';
alter type public.app_role add value if not exists 'doctor';

create or replace function public.has_health_role(target_school uuid)
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
      and membership.role::text in ('nurse', 'doctor')
  );
$$;

create or replace function public.health_access_enabled(target_school uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.has_health_role(target_school)
    and exists (
      select 1
      from public.school_module_settings settings
      where settings.school_id = target_school
        and settings.module_health
    );
$$;

create table public.student_health_visits (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null,
  visit_at timestamptz not null default timezone('utc', now()),
  symptoms text not null default '' check (char_length(symptoms) <= 5000),
  clinical_notes text not null default '' check (char_length(clinical_notes) <= 10000),
  assessment text not null default '' check (char_length(assessment) <= 5000),
  diagnosis text not null default '' check (char_length(diagnosis) <= 5000),
  allergies text not null default '' check (char_length(allergies) <= 5000),
  vitals jsonb not null default '{}'::jsonb check (jsonb_typeof(vitals) = 'object'),
  prescriptions jsonb not null default '[]'::jsonb check (jsonb_typeof(prescriptions) = 'array'),
  recorded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, student_id) references public.students(school_id, id) on delete cascade
);

create index student_health_visits_student_date_idx
  on public.student_health_visits(school_id, student_id, visit_at desc);

create trigger student_health_visits_set_updated_at
  before update on public.student_health_visits
  for each row execute function public.set_updated_at();

alter table public.student_health_visits enable row level security;

create policy "Healthcare staff read health visits"
  on public.student_health_visits for select to authenticated
  using (public.health_access_enabled(school_id));

create policy "Healthcare staff read student health profiles"
  on public.student_private_profiles for select to authenticated
  using (public.health_access_enabled(school_id));

create policy "Healthcare staff read emergency contacts"
  on public.student_emergency_contacts for select to authenticated
  using (public.health_access_enabled(school_id));

grant select on public.student_health_visits to authenticated;
grant select on public.student_private_profiles to authenticated;
grant select on public.student_emergency_contacts to authenticated;
revoke insert, update, delete, truncate, references, trigger on public.student_health_visits from anon, authenticated;

create or replace function public.save_student_health_visit(
  target_school uuid,
  target_visit uuid,
  visit_data jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_id uuid;
  target_student uuid;
  role_name text;
  existing_diagnosis text;
  visit_time timestamptz;
  vitals_data jsonb;
  prescriptions_data jsonb;
  prescription jsonb;
  temperature numeric;
  heart_rate integer;
  systolic integer;
  diastolic integer;
  weight numeric;
  height numeric;
begin
  if auth.uid() is null or not public.health_access_enabled(target_school) then
    raise exception 'Only this school’s authorized healthcare staff can access health records.';
  end if;

  target_student := nullif(visit_data->>'student_id', '')::uuid;
  if target_student is null or not exists (
    select 1 from public.students student
    where student.school_id = target_school and student.id = target_student
  ) then
    raise exception 'Select a student from this school.';
  end if;

  select membership.role::text into role_name
  from public.school_memberships membership
  where membership.school_id = target_school and membership.profile_id = auth.uid();

  if role_name <> 'doctor' and target_visit is null
    and nullif(trim(coalesce(visit_data->>'diagnosis', '')), '') is not null then
      raise exception 'Only an authorized school doctor can record a diagnosis.';
  end if;

  visit_time := coalesce(nullif(visit_data->>'visit_at', '')::timestamptz, timezone('utc', now()));
  vitals_data := coalesce(visit_data->'vitals', '{}'::jsonb);
  prescriptions_data := coalesce(visit_data->'prescriptions', '[]'::jsonb);

  if jsonb_typeof(vitals_data) <> 'object' then
    raise exception 'Vital signs must be provided as an object.';
  end if;
  if jsonb_typeof(prescriptions_data) <> 'array' then
    raise exception 'Prescriptions must be provided as a list.';
  end if;

  temperature := nullif(vitals_data->>'temperature_c', '')::numeric;
  heart_rate := nullif(vitals_data->>'heart_rate_bpm', '')::integer;
  systolic := nullif(vitals_data->>'blood_pressure_systolic', '')::integer;
  diastolic := nullif(vitals_data->>'blood_pressure_diastolic', '')::integer;
  weight := nullif(vitals_data->>'weight_kg', '')::numeric;
  height := nullif(vitals_data->>'height_cm', '')::numeric;

  if temperature is not null and temperature not between 25 and 45 then
    raise exception 'Temperature must be between 25 and 45 °C.';
  end if;
  if heart_rate is not null and heart_rate not between 20 and 300 then
    raise exception 'Heart rate must be between 20 and 300 bpm.';
  end if;
  if systolic is not null and systolic not between 40 and 300 then
    raise exception 'Systolic pressure must be between 40 and 300 mmHg.';
  end if;
  if diastolic is not null and diastolic not between 20 and 200 then
    raise exception 'Diastolic pressure must be between 20 and 200 mmHg.';
  end if;
  if weight is not null and weight not between 0.2 and 500 then
    raise exception 'Weight must be between 0.2 and 500 kg.';
  end if;
  if height is not null and height not between 20 and 250 then
    raise exception 'Height must be between 20 and 250 cm.';
  end if;

  for prescription in select value from jsonb_array_elements(prescriptions_data)
  loop
    if jsonb_typeof(prescription) <> 'object'
      or char_length(trim(coalesce(prescription->>'medication_name', ''))) not between 1 and 200
      or char_length(coalesce(prescription->>'dosage', '')) > 200
      or char_length(coalesce(prescription->>'frequency', '')) > 200
      or char_length(coalesce(prescription->>'duration', '')) > 200
      or char_length(coalesce(prescription->>'instructions', '')) > 2000 then
      raise exception 'Each prescription needs a medication name and valid field lengths.';
    end if;
  end loop;

  if target_visit is null then
    insert into public.student_health_visits (
      school_id, student_id, visit_at, symptoms, clinical_notes, assessment,
      diagnosis, allergies, vitals, prescriptions, recorded_by
    ) values (
      target_school,
      target_student,
      visit_time,
      coalesce(visit_data->>'symptoms', ''),
      coalesce(visit_data->>'clinical_notes', ''),
      coalesce(visit_data->>'assessment', ''),
      coalesce(visit_data->>'diagnosis', ''),
      coalesce(visit_data->>'allergies', ''),
      vitals_data,
      prescriptions_data,
      auth.uid()
    )
    returning id into saved_id;
  else
    select visit.diagnosis into existing_diagnosis
    from public.student_health_visits visit
    where visit.id = target_visit and visit.school_id = target_school;

    if not found then
      raise exception 'The health visit was not found in this school.';
    end if;
    if role_name <> 'doctor'
      and coalesce(visit_data->>'diagnosis', '') is distinct from coalesce(existing_diagnosis, '') then
      raise exception 'Only an authorized school doctor can change a diagnosis.';
    end if;

    update public.student_health_visits
    set student_id = target_student,
        visit_at = visit_time,
        symptoms = coalesce(visit_data->>'symptoms', ''),
        clinical_notes = coalesce(visit_data->>'clinical_notes', ''),
        assessment = coalesce(visit_data->>'assessment', ''),
        diagnosis = coalesce(visit_data->>'diagnosis', ''),
        allergies = coalesce(visit_data->>'allergies', ''),
        vitals = vitals_data,
        prescriptions = prescriptions_data
    where id = target_visit and school_id = target_school
    returning id into saved_id;

    if saved_id is null then
      raise exception 'The health visit was not found in this school.';
    end if;
  end if;

  return saved_id;
end;
$$;

revoke all on function public.save_student_health_visit(uuid, uuid, jsonb) from public;
grant execute on function public.save_student_health_visit(uuid, uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
