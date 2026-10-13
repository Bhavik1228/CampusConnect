create table public.school_departments (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 80),
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, name)
);

create table public.staff_profiles (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete set null,
  department_id uuid,
  employee_number text not null,
  first_name text not null check (char_length(trim(first_name)) between 1 and 80),
  last_name text not null check (char_length(trim(last_name)) between 1 and 80),
  email text,
  phone text,
  job_title text not null default '',
  employment_status text not null default 'active'
    check (employment_status in ('active', 'on_leave', 'inactive', 'terminated')),
  hire_date date,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, employee_number),
  foreign key (school_id, department_id)
    references public.school_departments(school_id, id) on delete set null (department_id)
);

create index staff_profiles_school_name_idx
  on public.staff_profiles(school_id, last_name, first_name);

alter table public.teacher_profiles
  add column staff_profile_id uuid,
  add column qualifications text not null default '',
  add column employment_status text not null default 'active'
    check (employment_status in ('active', 'on_leave', 'inactive', 'terminated'));

insert into public.staff_profiles (
  school_id, employee_number, first_name, last_name, email, job_title, employment_status
)
select
  teacher.school_id,
  coalesce(nullif(trim(teacher.employee_number), ''), 'T-' || left(replace(teacher.id::text, '-', ''), 12)),
  teacher.first_name,
  teacher.last_name,
  teacher.email,
  'Teacher',
  case
    when teacher.status = 'active' then 'active'
    when teacher.status = 'inactive' then 'inactive'
    else 'inactive'
  end
from public.teacher_profiles teacher;

update public.teacher_profiles teacher
set staff_profile_id = staff.id,
    employment_status = staff.employment_status::text
from public.staff_profiles staff
where staff.school_id = teacher.school_id
  and staff.employee_number = coalesce(
    nullif(trim(teacher.employee_number), ''),
    'T-' || left(replace(teacher.id::text, '-', ''), 12)
  );

alter table public.teacher_profiles
  add constraint teacher_profiles_staff_profile_fk
  foreign key (school_id, staff_profile_id)
  references public.staff_profiles(school_id, id) on delete set null (staff_profile_id);

create unique index teacher_profiles_staff_profile_unique
  on public.teacher_profiles(school_id, staff_profile_id)
  where staff_profile_id is not null;

create table public.staff_documents (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  staff_id uuid not null,
  uploaded_by uuid not null references public.profiles(id),
  file_name text not null check (char_length(file_name) between 1 and 200),
  storage_path text not null unique,
  content_type text not null,
  file_size bigint not null check (file_size > 0 and file_size <= 52428800),
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, staff_id)
    references public.staff_profiles(school_id, id) on delete cascade
);

alter table public.school_departments enable row level security;
alter table public.staff_profiles enable row level security;
alter table public.staff_documents enable row level security;

create policy "School members read departments"
  on public.school_departments for select to authenticated
  using (public.is_school_member(school_id));

create policy "School admins manage departments"
  on public.school_departments for all to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));

create policy "School members read staff directory"
  on public.staff_profiles for select to authenticated
  using (public.is_school_member(school_id));

create policy "School admins manage staff profiles"
  on public.staff_profiles for all to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));

create policy "School admins read staff document metadata"
  on public.staff_documents for select to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]));

create policy "School admins manage staff document metadata"
  on public.staff_documents for all to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check (
    uploaded_by = auth.uid()
    and public.has_school_role(school_id, array['school_admin']::public.app_role[])
  );

create policy "School admins manage teachers and qualifications"
  on public.teacher_profiles for all to authenticated
  using (
    public.has_school_role(school_id, array['school_admin']::public.app_role[])
    or public.has_school_role(school_id, array['academic_coordinator']::public.app_role[])
  )
  with check (
    public.has_school_role(school_id, array['school_admin']::public.app_role[])
    or public.has_school_role(school_id, array['academic_coordinator']::public.app_role[])
  );

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'staff-documents',
  'staff-documents',
  false,
  52428800,
  array[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do nothing;

create policy "School admins read staff document files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'staff-documents'
    and exists (
      select 1 from public.school_memberships membership
      where membership.profile_id = auth.uid()
        and membership.school_id::text = (storage.foldername(name))[1]
        and membership.role = 'school_admin'
    )
  );

create policy "School admins upload staff document files"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'staff-documents'
    and exists (
      select 1 from public.school_memberships membership
      where membership.profile_id = auth.uid()
        and membership.school_id::text = (storage.foldername(name))[1]
        and membership.role = 'school_admin'
    )
  );

create policy "School admins update staff document files"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'staff-documents'
    and exists (
      select 1 from public.school_memberships membership
      where membership.profile_id = auth.uid()
        and membership.school_id::text = (storage.foldername(name))[1]
        and membership.role = 'school_admin'
    )
  )
  with check (
    bucket_id = 'staff-documents'
    and exists (
      select 1 from public.school_memberships membership
      where membership.profile_id = auth.uid()
        and membership.school_id::text = (storage.foldername(name))[1]
        and membership.role = 'school_admin'
    )
  );

create policy "School admins delete staff document files"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'staff-documents'
    and exists (
      select 1 from public.school_memberships membership
      where membership.profile_id = auth.uid()
        and membership.school_id::text = (storage.foldername(name))[1]
        and membership.role = 'school_admin'
    )
  );

grant select, insert, update, delete on public.school_departments to authenticated;
grant select, insert, update, delete on public.staff_profiles to authenticated;
grant select, insert, update, delete on public.staff_documents to authenticated;
