create table public.school_websites (
  school_id uuid primary key references public.schools(id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  enabled boolean not null default false,
  public_results_enabled boolean not null default false,
  hero_title text not null default '' check (char_length(hero_title) <= 140),
  hero_message text not null default '' check (char_length(hero_message) <= 1000),
  about_title text not null default 'Welcome to our school' check (char_length(about_title) <= 100),
  about_text text not null default '' check (char_length(about_text) <= 3000),
  admissions_open boolean not null default false,
  admissions_title text not null default 'Admissions' check (char_length(admissions_title) <= 100),
  admissions_text text not null default '' check (char_length(admissions_text) <= 3000),
  admission_requirements text not null default '' check (char_length(admission_requirements) <= 3000),
  admissions_deadline date,
  admissions_email text,
  fees jsonb not null default '[]'::jsonb check (jsonb_typeof(fees) = 'array'),
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.school_websites enable row level security;

create policy "School admins manage their school website"
  on public.school_websites for all to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));

grant select, insert, update, delete on public.school_websites to authenticated;

create or replace function public.get_public_school_website(target_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'school_id', website.school_id,
    'slug', website.slug,
    'public_results_enabled', website.public_results_enabled,
    'hero_title', website.hero_title,
    'hero_message', website.hero_message,
    'about_title', website.about_title,
    'about_text', website.about_text,
    'admissions_open', website.admissions_open,
    'admissions_title', website.admissions_title,
    'admissions_text', website.admissions_text,
    'admission_requirements', website.admission_requirements,
    'admissions_deadline', website.admissions_deadline,
    'admissions_email', website.admissions_email,
    'fees', website.fees,
    'name', school.name,
    'address', school.address,
    'contact_email', school.contact_email,
    'contact_phone', school.contact_phone,
    'website', school.website,
    'logo_path', school.logo_path,
    'primary_color', school.primary_color,
    'secondary_color', school.secondary_color,
    'motto', school.motto
  )
  from public.school_websites website
  join public.schools school on school.id = website.school_id
  where website.slug = lower(trim(target_slug))
    and website.enabled;
$$;

create or replace function public.lookup_public_student_results(
  target_slug text,
  target_student_number text
)
returns table (
  student_number text,
  first_name text,
  last_name text,
  subject text,
  assessment_title text,
  assessment_date date,
  marks_obtained numeric,
  maximum_marks numeric,
  percentage numeric,
  teacher_comment text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    student.student_number,
    student.first_name,
    student.last_name,
    assessment.subject,
    assessment.title,
    result.assessment_date,
    result.marks_obtained,
    result.maximum_marks,
    result.percentage,
    result.teacher_comment
  from public.school_websites website
  join public.students student on student.school_id = website.school_id
  join public.learning_assessment_results result
    on result.school_id = student.school_id and result.student_id = student.id
  join public.learning_assessments assessment
    on assessment.school_id = result.school_id and assessment.id = result.assessment_id
  where website.slug = lower(trim(target_slug))
    and website.enabled
    and website.public_results_enabled
    and student.student_number = trim(target_student_number)
    and result.status = 'published'
  order by result.assessment_date desc, assessment.subject, assessment.title;
$$;

revoke all on function public.get_public_school_website(text) from public;
revoke all on function public.lookup_public_student_results(text, text) from public;
grant execute on function public.get_public_school_website(text) to anon, authenticated;
grant execute on function public.lookup_public_student_results(text, text) to anon, authenticated;
