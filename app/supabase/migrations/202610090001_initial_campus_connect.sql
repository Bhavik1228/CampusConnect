create extension if not exists pgcrypto;

create type public.app_role as enum ('system_admin', 'school_admin', 'teacher', 'student', 'parent');
create type public.person_status as enum ('active', 'inactive', 'graduated');
create type public.attendance_status as enum ('present', 'absent', 'late', 'excused');
create type public.assignment_status as enum ('draft', 'published', 'archived');
create type public.submission_status as enum ('submitted', 'late', 'graded', 'returned');
create type public.audience_type as enum ('school', 'class', 'staff', 'students', 'parents');

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  email text,
  avatar_path text,
  phone text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    new.email
  )
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create table public.schools (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 120),
  timezone text not null default 'UTC',
  contact_email text,
  contact_phone text,
  address text,
  website text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.school_memberships (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role public.app_role not null check (role <> 'system_admin'),
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, profile_id),
  unique (school_id, id)
);

create index school_memberships_profile_school_idx on public.school_memberships(profile_id, school_id);

create or replace function public.is_school_member(target_school uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.school_memberships membership
    where membership.school_id = target_school
      and membership.profile_id = auth.uid()
  );
$$;

create or replace function public.has_school_role(target_school uuid, allowed_roles public.app_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.school_memberships membership
    where membership.school_id = target_school
      and membership.profile_id = auth.uid()
      and membership.role = any(allowed_roles)
  );
$$;

create table public.academic_years (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null,
  start_date date not null,
  end_date date not null,
  is_current boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  check (end_date > start_date)
);
create unique index academic_years_one_current_per_school on public.academic_years(school_id) where is_current;

create table public.terms (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  academic_year_id uuid not null,
  name text not null,
  start_date date not null,
  end_date date not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, academic_year_id) references public.academic_years(school_id, id) on delete cascade,
  check (end_date > start_date)
);

create table public.school_classes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null,
  grade_level text,
  academic_year_id uuid,
  room text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, name, academic_year_id),
  foreign key (school_id, academic_year_id) references public.academic_years(school_id, id) on delete set null (academic_year_id)
);
create index school_classes_school_idx on public.school_classes(school_id, name);

create table public.students (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete set null,
  class_id uuid,
  student_number text not null,
  first_name text not null,
  last_name text not null,
  email text,
  date_of_birth date,
  status public.person_status not null default 'active',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, student_number),
  foreign key (school_id, class_id) references public.school_classes(school_id, id) on delete set null (class_id)
);
create index students_school_name_idx on public.students(school_id, last_name, first_name);
create index students_profile_idx on public.students(profile_id);

create table public.teacher_profiles (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete set null,
  first_name text not null,
  last_name text not null,
  email text,
  employee_number text,
  status public.person_status not null default 'active',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, employee_number)
);
create index teacher_profiles_school_name_idx on public.teacher_profiles(school_id, last_name, first_name);

create table public.parent_profiles (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete set null,
  first_name text not null,
  last_name text not null,
  email text,
  phone text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id)
);

create table public.parent_students (
  school_id uuid not null references public.schools(id) on delete cascade,
  parent_id uuid not null,
  student_id uuid not null,
  relationship text,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (parent_id, student_id),
  foreign key (school_id, parent_id) references public.parent_profiles(school_id, id) on delete cascade,
  foreign key (school_id, student_id) references public.students(school_id, id) on delete cascade
);
create index parent_students_student_idx on public.parent_students(school_id, student_id);

create table public.class_students (
  school_id uuid not null references public.schools(id) on delete cascade,
  class_id uuid not null,
  student_id uuid not null,
  enrolled_at date not null default current_date,
  primary key (class_id, student_id),
  foreign key (school_id, class_id) references public.school_classes(school_id, id) on delete cascade,
  foreign key (school_id, student_id) references public.students(school_id, id) on delete cascade
);

create or replace function public.sync_student_class_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and old.class_id is distinct from new.class_id and old.class_id is not null then
    delete from public.class_students
    where school_id = old.school_id
      and class_id = old.class_id
      and student_id = old.id;
  end if;

  if new.class_id is not null then
    insert into public.class_students (school_id, class_id, student_id)
    values (new.school_id, new.class_id, new.id)
    on conflict (class_id, student_id) do nothing;
  end if;
  return new;
end;
$$;
create trigger sync_student_class_membership
  after insert or update of class_id on public.students
  for each row execute function public.sync_student_class_membership();

create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null,
  code text,
  description text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, code)
);
create index subjects_school_name_idx on public.subjects(school_id, name);

create table public.class_subjects (
  school_id uuid not null references public.schools(id) on delete cascade,
  class_id uuid not null,
  subject_id uuid not null,
  primary key (class_id, subject_id),
  foreign key (school_id, class_id) references public.school_classes(school_id, id) on delete cascade,
  foreign key (school_id, subject_id) references public.subjects(school_id, id) on delete cascade
);

create table public.teacher_class_assignments (
  school_id uuid not null references public.schools(id) on delete cascade,
  teacher_id uuid not null,
  class_id uuid not null,
  primary key (teacher_id, class_id),
  foreign key (school_id, teacher_id) references public.teacher_profiles(school_id, id) on delete cascade,
  foreign key (school_id, class_id) references public.school_classes(school_id, id) on delete cascade
);

create table public.teacher_subjects (
  school_id uuid not null references public.schools(id) on delete cascade,
  teacher_id uuid not null,
  subject_id uuid not null,
  primary key (teacher_id, subject_id),
  foreign key (school_id, teacher_id) references public.teacher_profiles(school_id, id) on delete cascade,
  foreign key (school_id, subject_id) references public.subjects(school_id, id) on delete cascade
);

create or replace function public.is_teacher_for_class(target_school uuid, target_class uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.teacher_class_assignments assignment
    join public.teacher_profiles teacher on teacher.id = assignment.teacher_id
    where assignment.school_id = target_school
      and assignment.class_id = target_class
      and teacher.profile_id = auth.uid()
  );
$$;

create or replace function public.is_teacher_record_for_class(target_school uuid, target_class uuid, target_teacher uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.teacher_class_assignments assignment
    join public.teacher_profiles teacher on teacher.id = assignment.teacher_id
    where assignment.school_id = target_school
      and assignment.class_id = target_class
      and assignment.teacher_id = target_teacher
      and teacher.profile_id = auth.uid()
  );
$$;

create or replace function public.is_parent_of_student(target_school uuid, target_student uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.parent_students relationship
    join public.parent_profiles parent on parent.id = relationship.parent_id
    where relationship.school_id = target_school
      and relationship.student_id = target_student
      and parent.profile_id = auth.uid()
  );
$$;

create or replace function public.is_student_record_in_class(target_school uuid, target_class uuid, target_student uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.class_students roster
    where roster.school_id = target_school
      and roster.class_id = target_class
      and roster.student_id = target_student
      and (
        public.has_school_role(target_school, array['school_admin']::public.app_role[])
        or public.is_teacher_for_class(target_school, target_class)
      )
  );
$$;
revoke all on function public.is_student_record_in_class(uuid, uuid, uuid) from public;
grant execute on function public.is_student_record_in_class(uuid, uuid, uuid) to authenticated;

create table public.timetable (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  class_id uuid not null,
  subject_id uuid not null,
  teacher_id uuid,
  day_of_week smallint not null check (day_of_week between 1 and 7),
  starts_at time not null,
  ends_at time not null,
  room text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, class_id) references public.school_classes(school_id, id) on delete cascade,
  foreign key (school_id, subject_id) references public.subjects(school_id, id) on delete cascade,
  foreign key (school_id, teacher_id) references public.teacher_profiles(school_id, id) on delete set null (teacher_id),
  check (ends_at > starts_at)
);
create index timetable_school_class_day_idx on public.timetable(school_id, class_id, day_of_week, starts_at);

create table public.attendance_sessions (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  class_id uuid not null,
  attendance_date date not null,
  recorded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, class_id, attendance_date),
  unique (school_id, id),
  foreign key (school_id, class_id) references public.school_classes(school_id, id) on delete cascade
);

create table public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  session_id uuid not null,
  student_id uuid not null,
  status public.attendance_status not null,
  note text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (session_id, student_id),
  foreign key (school_id, session_id) references public.attendance_sessions(school_id, id) on delete cascade,
  foreign key (school_id, student_id) references public.students(school_id, id) on delete cascade
);
create index attendance_records_school_date_idx on public.attendance_records(school_id, created_at);

create or replace function public.ensure_attendance_student_in_class()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.attendance_sessions session
    join public.class_students roster
      on roster.school_id = session.school_id
      and roster.class_id = session.class_id
    where session.school_id = new.school_id
      and session.id = new.session_id
      and roster.student_id = new.student_id
  ) then
    raise exception 'Attendance can only be recorded for students enrolled in the session class.';
  end if;
  return new;
end;
$$;
create trigger ensure_attendance_student_in_class
  before insert or update on public.attendance_records
  for each row execute function public.ensure_attendance_student_in_class();

create table public.assignments (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  class_id uuid not null,
  subject_id uuid not null,
  teacher_id uuid not null,
  title text not null,
  description text,
  due_at timestamptz,
  max_marks numeric(8,2) check (max_marks is null or max_marks >= 0),
  status public.assignment_status not null default 'draft',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, class_id) references public.school_classes(school_id, id) on delete cascade,
  foreign key (school_id, subject_id) references public.subjects(school_id, id) on delete cascade,
  foreign key (school_id, teacher_id) references public.teacher_profiles(school_id, id) on delete cascade
);
create index assignments_school_due_idx on public.assignments(school_id, due_at);

create table public.assignment_submissions (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  assignment_id uuid not null,
  student_id uuid not null,
  submitted_at timestamptz,
  storage_path text,
  text_response text,
  status public.submission_status not null default 'submitted',
  marks numeric(8,2) check (marks is null or marks >= 0),
  feedback text,
  graded_by uuid references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (assignment_id, student_id),
  foreign key (school_id, assignment_id) references public.assignments(school_id, id) on delete cascade,
  foreign key (school_id, student_id) references public.students(school_id, id) on delete cascade
);

create table public.learning_materials (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  class_id uuid not null,
  subject_id uuid,
  uploaded_by uuid not null references public.profiles(id),
  title text not null,
  description text,
  storage_path text not null,
  mime_type text,
  file_size bigint check (file_size is null or file_size >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, class_id) references public.school_classes(school_id, id) on delete cascade,
  foreign key (school_id, subject_id) references public.subjects(school_id, id) on delete set null (subject_id)
);

create table public.exams (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  class_id uuid not null,
  subject_id uuid not null,
  teacher_id uuid not null,
  title text not null,
  exam_at timestamptz not null,
  max_marks numeric(8,2) not null check (max_marks > 0),
  published_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, class_id) references public.school_classes(school_id, id) on delete cascade,
  foreign key (school_id, subject_id) references public.subjects(school_id, id) on delete cascade,
  foreign key (school_id, teacher_id) references public.teacher_profiles(school_id, id) on delete cascade
);
create index exams_school_date_idx on public.exams(school_id, exam_at);

create table public.exam_results (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  exam_id uuid not null,
  student_id uuid not null,
  marks numeric(8,2) not null check (marks >= 0),
  feedback text,
  graded_by uuid not null references public.profiles(id),
  published_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (exam_id, student_id),
  foreign key (school_id, exam_id) references public.exams(school_id, id) on delete cascade,
  foreign key (school_id, student_id) references public.students(school_id, id) on delete cascade
);

create or replace function public.validate_exam_result()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  maximum_marks numeric(8,2);
  exam_class uuid;
begin
  select exam.max_marks, exam.class_id
  into maximum_marks, exam_class
  from public.exams exam
  where exam.school_id = new.school_id and exam.id = new.exam_id;
  if not found then
    raise exception 'The selected exam does not exist in this school.';
  end if;
  if new.marks > maximum_marks then
    raise exception 'Exam marks cannot exceed the maximum score.';
  end if;
  if not public.is_student_record_in_class(new.school_id, exam_class, new.student_id) then
    raise exception 'Exam results can only be recorded for students enrolled in the exam class.';
  end if;
  return new;
end;
$$;
create trigger validate_exam_result
  before insert or update on public.exam_results
  for each row execute function public.validate_exam_result();

create table public.grades (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null,
  subject_id uuid not null,
  term_id uuid,
  assessment_name text not null,
  score numeric(8,2) not null check (score >= 0),
  max_score numeric(8,2) not null check (max_score > 0 and score <= max_score),
  feedback text,
  graded_by uuid not null references public.profiles(id),
  published_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, student_id) references public.students(school_id, id) on delete cascade,
  foreign key (school_id, subject_id) references public.subjects(school_id, id) on delete cascade,
  foreign key (school_id, term_id) references public.terms(school_id, id) on delete set null (term_id)
);
create index grades_school_student_idx on public.grades(school_id, student_id, created_at desc);

create table public.quizzes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  class_id uuid not null,
  subject_id uuid not null,
  teacher_id uuid not null,
  title text not null,
  description text,
  opens_at timestamptz,
  closes_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, class_id) references public.school_classes(school_id, id) on delete cascade,
  foreign key (school_id, subject_id) references public.subjects(school_id, id) on delete cascade,
  foreign key (school_id, teacher_id) references public.teacher_profiles(school_id, id) on delete cascade,
  check (closes_at is null or opens_at is null or closes_at > opens_at)
);

create table public.quiz_questions (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  quiz_id uuid not null,
  prompt text not null,
  position integer not null check (position > 0),
  marks numeric(8,2) not null default 1 check (marks > 0),
  unique (quiz_id, position),
  unique (school_id, id),
  foreign key (school_id, quiz_id) references public.quizzes(school_id, id) on delete cascade
);

create table public.quiz_options (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  question_id uuid not null,
  option_text text not null,
  position integer not null check (position > 0),
  unique (question_id, position),
  unique (school_id, id),
  unique (school_id, question_id, id),
  foreign key (school_id, question_id) references public.quiz_questions(school_id, id) on delete cascade
);

create table public.quiz_answer_keys (
  school_id uuid not null references public.schools(id) on delete cascade,
  question_id uuid primary key,
  correct_option_id uuid not null,
  foreign key (school_id, question_id) references public.quiz_questions(school_id, id) on delete cascade,
  foreign key (school_id, question_id, correct_option_id) references public.quiz_options(school_id, question_id, id) on delete cascade
);

create table public.quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  quiz_id uuid not null,
  student_id uuid not null,
  score numeric(8,2) check (score is null or score >= 0),
  started_at timestamptz not null default timezone('utc', now()),
  submitted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, quiz_id) references public.quizzes(school_id, id) on delete cascade,
  foreign key (school_id, student_id) references public.students(school_id, id) on delete cascade
);
create index quiz_attempts_student_quiz_idx on public.quiz_attempts(school_id, student_id, quiz_id);

create table public.quiz_answers (
  school_id uuid not null references public.schools(id) on delete cascade,
  attempt_id uuid not null,
  question_id uuid not null,
  selected_option_id uuid,
  answered_at timestamptz not null default timezone('utc', now()),
  primary key (attempt_id, question_id),
  foreign key (school_id, attempt_id) references public.quiz_attempts(school_id, id) on delete cascade,
  foreign key (school_id, question_id) references public.quiz_questions(school_id, id) on delete cascade,
  foreign key (school_id, question_id, selected_option_id) references public.quiz_options(school_id, question_id, id) on delete set null (selected_option_id)
);

create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  class_id uuid,
  author_id uuid not null references public.profiles(id),
  title text not null,
  content text not null,
  audience public.audience_type not null default 'school',
  published_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, class_id) references public.school_classes(school_id, id) on delete cascade
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  organizer_id uuid not null references public.profiles(id),
  title text not null,
  description text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  location text,
  audience public.audience_type not null default 'school',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (ends_at > starts_at)
);
create index events_school_start_idx on public.events(school_id, starts_at);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  body text,
  target_path text,
  read_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);
create index notifications_profile_unread_idx on public.notifications(profile_id, created_at desc) where read_at is null;

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  title text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id)
);

create table public.conversation_members (
  school_id uuid not null references public.schools(id) on delete cascade,
  conversation_id uuid not null,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default timezone('utc', now()),
  primary key (conversation_id, profile_id),
  foreign key (school_id, conversation_id) references public.conversations(school_id, id) on delete cascade
);

create or replace function public.is_conversation_member(target_conversation uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.conversation_members membership
    where membership.conversation_id = target_conversation
      and membership.profile_id = auth.uid()
  );
$$;

create or replace function public.is_conversation_creator(target_conversation uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.conversations conversation
    where conversation.id = target_conversation
      and conversation.created_by = auth.uid()
  );
$$;

create or replace function public.can_add_conversation_member(target_conversation uuid, target_profile uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.conversations conversation
    join public.school_memberships target_membership
      on target_membership.school_id = conversation.school_id
      and target_membership.profile_id = target_profile
    where conversation.id = target_conversation
      and conversation.created_by = auth.uid()
      and public.is_school_member(conversation.school_id)
  );
$$;
revoke all on function public.can_add_conversation_member(uuid, uuid) from public;
grant execute on function public.can_add_conversation_member(uuid, uuid) to authenticated;

create or replace function public.is_student_in_class(target_school uuid, target_class uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.class_students roster
    join public.students student on student.id = roster.student_id
    where roster.school_id = target_school
      and roster.class_id = target_class
      and student.profile_id = auth.uid()
  );
$$;

create or replace function public.is_parent_of_class_student(target_school uuid, target_class uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.class_students roster
    where roster.school_id = target_school
      and roster.class_id = target_class
      and public.is_parent_of_student(target_school, roster.student_id)
  );
$$;

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  conversation_id uuid not null,
  sender_id uuid not null references public.profiles(id),
  body text not null check (char_length(trim(body)) between 1 and 10000),
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, conversation_id) references public.conversations(school_id, id) on delete cascade
);
create index messages_conversation_created_idx on public.messages(conversation_id, created_at);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  target_table text not null,
  target_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);
create index audit_logs_school_created_idx on public.audit_logs(school_id, created_at desc);

create or replace function public.create_initial_school(school_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_school_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required to create a school.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  if exists (select 1 from public.school_memberships where profile_id = auth.uid()) then
    raise exception 'This account already has a school workspace.';
  end if;
  if school_name is null or char_length(trim(school_name)) < 2 or char_length(trim(school_name)) > 120 then
    raise exception 'School name must be between 2 and 120 characters.';
  end if;

  insert into public.schools (name, created_by)
  values (trim(school_name), auth.uid())
  returning id into new_school_id;

  insert into public.school_memberships (school_id, profile_id, role)
  values (new_school_id, auth.uid(), 'school_admin');

  return new_school_id;
end;
$$;
revoke all on function public.create_initial_school(text) from public;
grant execute on function public.create_initial_school(text) to authenticated;

create or replace function public.log_school_record_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  school_id_value uuid;
  target_id_value uuid;
  operation_value text;
begin
  school_id_value := coalesce(new.school_id, old.school_id);
  target_id_value := coalesce(new.id, old.id);
  operation_value := lower(tg_op);
  insert into public.audit_logs (school_id, actor_id, action, target_table, target_id)
  values (school_id_value, auth.uid(), operation_value, tg_table_name, target_id_value);
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.apply_updated_at_triggers()
returns void
language plpgsql
as $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'profiles', 'schools', 'academic_years', 'terms', 'school_classes', 'students',
    'teacher_profiles', 'parent_profiles', 'subjects', 'timetable', 'attendance_sessions',
    'attendance_records', 'assignments', 'assignment_submissions', 'learning_materials',
    'exams', 'exam_results', 'grades', 'quizzes', 'quiz_attempts',
    'announcements', 'events', 'conversations'
  ]
  loop
    execute format(
      'create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()',
      table_name
    );
  end loop;
end;
$$;
select public.apply_updated_at_triggers();
drop function public.apply_updated_at_triggers();

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'students', 'teacher_profiles', 'school_classes', 'subjects', 'assignments',
    'attendance_sessions', 'attendance_records', 'learning_materials', 'exams',
    'exam_results', 'grades', 'quizzes', 'announcements', 'events'
  ]
  loop
    execute format(
      'create trigger audit_school_record_change after insert or update or delete on public.%I for each row execute function public.log_school_record_change()',
      table_name
    );
  end loop;
end;
$$;

alter table public.profiles enable row level security;
alter table public.schools enable row level security;
alter table public.school_memberships enable row level security;
alter table public.academic_years enable row level security;
alter table public.terms enable row level security;
alter table public.school_classes enable row level security;
alter table public.students enable row level security;
alter table public.teacher_profiles enable row level security;
alter table public.parent_profiles enable row level security;
alter table public.parent_students enable row level security;
alter table public.class_students enable row level security;
alter table public.subjects enable row level security;
alter table public.class_subjects enable row level security;
alter table public.teacher_class_assignments enable row level security;
alter table public.teacher_subjects enable row level security;
alter table public.timetable enable row level security;
alter table public.attendance_sessions enable row level security;
alter table public.attendance_records enable row level security;
alter table public.assignments enable row level security;
alter table public.assignment_submissions enable row level security;
alter table public.learning_materials enable row level security;
alter table public.exams enable row level security;
alter table public.exam_results enable row level security;
alter table public.grades enable row level security;
alter table public.quizzes enable row level security;
alter table public.quiz_questions enable row level security;
alter table public.quiz_options enable row level security;
alter table public.quiz_answer_keys enable row level security;
alter table public.quiz_attempts enable row level security;
alter table public.quiz_answers enable row level security;
alter table public.announcements enable row level security;
alter table public.events enable row level security;
alter table public.notifications enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.audit_logs enable row level security;

create policy "Users can read own profile" on public.profiles for select to authenticated using (id = auth.uid());
create policy "Users can update own profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy "Members can read their schools" on public.schools for select to authenticated using (public.is_school_member(id));
create policy "School admins can update their schools" on public.schools for update to authenticated using (public.has_school_role(id, array['school_admin']::public.app_role[])) with check (public.has_school_role(id, array['school_admin']::public.app_role[]));
create policy "Users can read own memberships" on public.school_memberships for select to authenticated using (profile_id = auth.uid());
create policy "Admins can read school memberships" on public.school_memberships for select to authenticated using (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "School admins manage memberships" on public.school_memberships for all to authenticated using (public.has_school_role(school_id, array['school_admin']::public.app_role[])) with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));

create policy "Members can read academic years" on public.academic_years for select to authenticated using (public.is_school_member(school_id));
create policy "Admins manage academic years" on public.academic_years for all to authenticated using (public.has_school_role(school_id, array['school_admin']::public.app_role[])) with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "Members can read terms" on public.terms for select to authenticated using (public.is_school_member(school_id));
create policy "Admins manage terms" on public.terms for all to authenticated using (public.has_school_role(school_id, array['school_admin']::public.app_role[])) with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "Members can read classes" on public.school_classes for select to authenticated using (public.is_school_member(school_id));
create policy "Admins manage classes" on public.school_classes for all to authenticated using (public.has_school_role(school_id, array['school_admin']::public.app_role[])) with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));

create policy "Authorized users read students" on public.students for select to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or profile_id = auth.uid()
  or public.is_parent_of_student(school_id, id)
  or (class_id is not null and public.is_teacher_for_class(school_id, class_id))
);
create policy "Admins manage students" on public.students for all to authenticated using (public.has_school_role(school_id, array['school_admin']::public.app_role[])) with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "Members read teacher directory" on public.teacher_profiles for select to authenticated using (public.is_school_member(school_id));
create policy "Admins manage teachers" on public.teacher_profiles for all to authenticated using (public.has_school_role(school_id, array['school_admin']::public.app_role[])) with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "Admins read parent records" on public.parent_profiles for select to authenticated using (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "Parents read own record" on public.parent_profiles for select to authenticated using (profile_id = auth.uid());
create policy "Admins manage parent records" on public.parent_profiles for all to authenticated using (public.has_school_role(school_id, array['school_admin']::public.app_role[])) with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "Parents and admins read child links" on public.parent_students for select to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or public.is_parent_of_student(school_id, student_id)
);
create policy "Admins manage child links" on public.parent_students for all to authenticated using (public.has_school_role(school_id, array['school_admin']::public.app_role[])) with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "Members read class rosters" on public.class_students for select to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or public.is_teacher_for_class(school_id, class_id)
  or exists (select 1 from public.students s where s.id = student_id and s.profile_id = auth.uid())
  or public.is_parent_of_student(school_id, student_id)
);
create policy "Admins manage rosters" on public.class_students for all to authenticated using (public.has_school_role(school_id, array['school_admin']::public.app_role[])) with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));

create policy "Members can read subjects" on public.subjects for select to authenticated using (public.is_school_member(school_id));
create policy "Admins manage subjects" on public.subjects for all to authenticated using (public.has_school_role(school_id, array['school_admin']::public.app_role[])) with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "Members read class subjects" on public.class_subjects for select to authenticated using (public.is_school_member(school_id));
create policy "Admins manage class subjects" on public.class_subjects for all to authenticated using (public.has_school_role(school_id, array['school_admin']::public.app_role[])) with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "Members read teaching assignments" on public.teacher_class_assignments for select to authenticated using (public.is_school_member(school_id));
create policy "Admins manage teaching assignments" on public.teacher_class_assignments for all to authenticated using (public.has_school_role(school_id, array['school_admin']::public.app_role[])) with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "Members read teacher subjects" on public.teacher_subjects for select to authenticated using (public.is_school_member(school_id));
create policy "Admins manage teacher subjects" on public.teacher_subjects for all to authenticated using (public.has_school_role(school_id, array['school_admin']::public.app_role[])) with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));

create policy "Authorized users read timetable" on public.timetable for select to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or public.is_teacher_for_class(school_id, class_id)
  or exists (select 1 from public.class_students cs join public.students s on s.id = cs.student_id where cs.school_id = timetable.school_id and cs.class_id = timetable.class_id and s.profile_id = auth.uid())
  or exists (select 1 from public.class_students cs where cs.school_id = timetable.school_id and cs.class_id = timetable.class_id and public.is_parent_of_student(timetable.school_id, cs.student_id))
);
create policy "Admins manage timetable" on public.timetable for all to authenticated using (public.has_school_role(school_id, array['school_admin']::public.app_role[])) with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));

create policy "Authorized users read attendance sessions" on public.attendance_sessions for select to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or public.is_teacher_for_class(school_id, class_id)
  or exists (select 1 from public.class_students cs join public.students s on s.id = cs.student_id where cs.school_id = attendance_sessions.school_id and cs.class_id = attendance_sessions.class_id and s.profile_id = auth.uid())
  or exists (select 1 from public.class_students cs where cs.school_id = attendance_sessions.school_id and cs.class_id = attendance_sessions.class_id and public.is_parent_of_student(attendance_sessions.school_id, cs.student_id))
);
create policy "Teachers and admins record attendance" on public.attendance_sessions for insert to authenticated with check (
  public.has_school_role(school_id, array['school_admin']::public.app_role[]) or public.is_teacher_for_class(school_id, class_id)
);
create policy "Teachers and admins update attendance" on public.attendance_sessions for update to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[]) or public.is_teacher_for_class(school_id, class_id)
) with check (
  public.has_school_role(school_id, array['school_admin']::public.app_role[]) or public.is_teacher_for_class(school_id, class_id)
);
create policy "Authorized users read attendance records" on public.attendance_records for select to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or exists (select 1 from public.students s where s.id = student_id and s.profile_id = auth.uid())
  or public.is_parent_of_student(school_id, student_id)
  or exists (select 1 from public.attendance_sessions a where a.id = session_id and public.is_teacher_for_class(school_id, a.class_id))
);
create policy "Teachers and admins manage attendance records" on public.attendance_records for all to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or exists (select 1 from public.attendance_sessions a where a.id = session_id and public.is_teacher_for_class(school_id, a.class_id))
) with check (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or exists (
    select 1 from public.attendance_sessions a
    join public.class_students roster on roster.school_id = a.school_id and roster.class_id = a.class_id
    where a.id = session_id
      and roster.student_id = attendance_records.student_id
      and public.is_teacher_for_class(school_id, a.class_id)
  )
);

create policy "Authorized users read published assignments" on public.assignments for select to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or teacher_id in (select teacher.id from public.teacher_profiles teacher where teacher.profile_id = auth.uid() and teacher.school_id = assignments.school_id)
  or (status = 'published' and (
    public.is_teacher_for_class(school_id, class_id)
    or exists (select 1 from public.class_students cs join public.students s on s.id = cs.student_id where cs.school_id = assignments.school_id and cs.class_id = assignments.class_id and s.profile_id = auth.uid())
    or exists (select 1 from public.class_students cs where cs.school_id = assignments.school_id and cs.class_id = assignments.class_id and public.is_parent_of_student(assignments.school_id, cs.student_id))
  ))
);
create policy "Teachers and admins manage assignments" on public.assignments for all to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or public.is_teacher_record_for_class(school_id, class_id, teacher_id)
) with check (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or public.is_teacher_record_for_class(school_id, class_id, teacher_id)
);
create policy "Students and teachers read submissions" on public.assignment_submissions for select to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or exists (select 1 from public.students s where s.id = student_id and s.profile_id = auth.uid())
  or public.is_parent_of_student(school_id, student_id)
  or exists (select 1 from public.assignments a where a.id = assignment_id and (public.is_teacher_for_class(school_id, a.class_id) or public.has_school_role(school_id, array['school_admin']::public.app_role[])))
);
create policy "Students submit and teachers grade" on public.assignment_submissions for all to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or exists (select 1 from public.students s where s.id = student_id and s.profile_id = auth.uid())
  or exists (select 1 from public.assignments a where a.id = assignment_id and public.is_teacher_for_class(school_id, a.class_id))
) with check (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or exists (select 1 from public.students s where s.id = student_id and s.profile_id = auth.uid())
  or exists (select 1 from public.assignments a where a.id = assignment_id and public.is_teacher_for_class(school_id, a.class_id))
);

create policy "Class members read learning materials" on public.learning_materials for select to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or public.is_teacher_for_class(school_id, class_id)
  or exists (select 1 from public.class_students cs join public.students s on s.id = cs.student_id where cs.school_id = learning_materials.school_id and cs.class_id = learning_materials.class_id and s.profile_id = auth.uid())
  or exists (select 1 from public.class_students cs where cs.school_id = learning_materials.school_id and cs.class_id = learning_materials.class_id and public.is_parent_of_student(learning_materials.school_id, cs.student_id))
);
create policy "Teachers and admins manage learning materials" on public.learning_materials for all to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[]) or public.is_teacher_for_class(school_id, class_id)
) with check (
  public.has_school_role(school_id, array['school_admin']::public.app_role[]) or public.is_teacher_for_class(school_id, class_id)
);
create policy "Members read authorized exams" on public.exams for select to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or public.is_teacher_for_class(school_id, class_id)
  or public.is_student_in_class(school_id, class_id)
  or public.is_parent_of_class_student(school_id, class_id)
);
create policy "Teachers and admins manage exams" on public.exams for all to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[]) or public.is_teacher_record_for_class(school_id, class_id, teacher_id)
) with check (
  public.has_school_role(school_id, array['school_admin']::public.app_role[]) or public.is_teacher_record_for_class(school_id, class_id, teacher_id)
);
create policy "Users read authorized exam results" on public.exam_results for select to authenticated using (
  (published_at is not null and (
    exists (select 1 from public.students student where student.id = student_id and student.profile_id = auth.uid())
    or public.is_parent_of_student(school_id, student_id)
  ))
  or public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or exists (select 1 from public.exams exam where exam.id = exam_id and public.is_teacher_for_class(school_id, exam.class_id))
);
create policy "Teachers and admins grade exams" on public.exam_results for all to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or exists (select 1 from public.exams exam where exam.id = exam_id and public.is_teacher_for_class(school_id, exam.class_id))
) with check (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or exists (select 1 from public.exams exam where exam.id = exam_id and public.is_teacher_for_class(school_id, exam.class_id))
);
create policy "Users read authorized grades" on public.grades for select to authenticated using (
  (published_at is not null and (
    exists (select 1 from public.students student where student.id = student_id and student.profile_id = auth.uid())
    or public.is_parent_of_student(school_id, student_id)
  ))
  or public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or exists (select 1 from public.students student where student.id = student_id and student.class_id is not null and public.is_teacher_for_class(school_id, student.class_id))
);
create policy "Teachers and admins manage grades" on public.grades for all to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or exists (select 1 from public.students student where student.id = student_id and student.class_id is not null and public.is_teacher_for_class(school_id, student.class_id))
) with check (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or exists (select 1 from public.students student where student.id = student_id and student.class_id is not null and public.is_teacher_for_class(school_id, student.class_id))
);
create policy "Members read authorized quizzes" on public.quizzes for select to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or public.is_teacher_for_class(school_id, class_id)
  or (published_at is not null and (public.is_student_in_class(school_id, class_id) or public.is_parent_of_class_student(school_id, class_id)))
);
create policy "Teachers and admins manage quizzes" on public.quizzes for all to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[]) or public.is_teacher_record_for_class(school_id, class_id, teacher_id)
) with check (
  public.has_school_role(school_id, array['school_admin']::public.app_role[]) or public.is_teacher_record_for_class(school_id, class_id, teacher_id)
);
create policy "Users read quiz questions for authorized quizzes" on public.quiz_questions for select to authenticated using (
  exists (select 1 from public.quizzes quiz where quiz.id = quiz_id and (
    public.has_school_role(school_id, array['school_admin']::public.app_role[])
    or public.is_teacher_for_class(school_id, quiz.class_id)
    or (quiz.published_at is not null and (public.is_student_in_class(school_id, quiz.class_id) or public.is_parent_of_class_student(school_id, quiz.class_id)))
  ))
);
create policy "Teachers and admins manage quiz questions" on public.quiz_questions for all to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or exists (select 1 from public.quizzes quiz where quiz.id = quiz_id and public.is_teacher_for_class(school_id, quiz.class_id))
) with check (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or exists (select 1 from public.quizzes quiz where quiz.id = quiz_id and public.is_teacher_for_class(school_id, quiz.class_id))
);
create policy "Users read options for authorized quizzes" on public.quiz_options for select to authenticated using (
  exists (
    select 1 from public.quiz_questions question join public.quizzes quiz on quiz.id = question.quiz_id
    where question.id = question_id and (
      public.has_school_role(school_id, array['school_admin']::public.app_role[])
      or public.is_teacher_for_class(school_id, quiz.class_id)
      or (quiz.published_at is not null and (public.is_student_in_class(school_id, quiz.class_id) or public.is_parent_of_class_student(school_id, quiz.class_id)))
    )
  )
);
create policy "Teachers and admins manage quiz options" on public.quiz_options for all to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or exists (select 1 from public.quiz_questions question join public.quizzes quiz on quiz.id = question.quiz_id where question.id = question_id and public.is_teacher_for_class(school_id, quiz.class_id))
) with check (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or exists (select 1 from public.quiz_questions question join public.quizzes quiz on quiz.id = question.quiz_id where question.id = question_id and public.is_teacher_for_class(school_id, quiz.class_id))
);
create policy "Teachers manage private quiz answer keys" on public.quiz_answer_keys for all to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or exists (select 1 from public.quiz_questions question join public.quizzes quiz on quiz.id = question.quiz_id where question.id = question_id and public.is_teacher_for_class(school_id, quiz.class_id))
) with check (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or exists (select 1 from public.quiz_questions question join public.quizzes quiz on quiz.id = question.quiz_id where question.id = question_id and public.is_teacher_for_class(school_id, quiz.class_id))
);
create policy "Users read own and authorized quiz attempts" on public.quiz_attempts for select to authenticated using (
  exists (select 1 from public.students student where student.id = student_id and student.profile_id = auth.uid())
  or public.is_parent_of_student(school_id, student_id)
  or public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or exists (select 1 from public.quizzes quiz where quiz.id = quiz_id and public.is_teacher_for_class(school_id, quiz.class_id))
);
create policy "Students submit own quiz attempts" on public.quiz_attempts for insert to authenticated with check (
  exists (select 1 from public.students student where student.id = student_id and student.profile_id = auth.uid())
  and exists (select 1 from public.quizzes quiz where quiz.id = quiz_id and quiz.published_at is not null and public.is_student_in_class(school_id, quiz.class_id))
);
create policy "Students answer own attempts" on public.quiz_answers for all to authenticated using (
  exists (
    select 1 from public.quiz_attempts attempt join public.students student on student.id = attempt.student_id
    where attempt.id = attempt_id and student.profile_id = auth.uid() and attempt.submitted_at is null
  )
) with check (
  exists (
    select 1 from public.quiz_attempts attempt join public.students student on student.id = attempt.student_id
    where attempt.id = attempt_id and student.profile_id = auth.uid() and attempt.submitted_at is null
  )
);
create policy "Teachers read quiz answers" on public.quiz_answers for select to authenticated using (
  exists (
    select 1 from public.quiz_attempts attempt join public.quizzes quiz on quiz.id = attempt.quiz_id
    where attempt.id = attempt_id and public.is_teacher_for_class(school_id, quiz.class_id)
  )
);

create policy "Members read announcements" on public.announcements for select to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or (published_at is not null and (
    audience = 'school'
    or (audience = 'staff' and public.has_school_role(school_id, array['teacher']::public.app_role[]))
    or (audience = 'students' and public.has_school_role(school_id, array['student']::public.app_role[]))
    or (audience = 'parents' and public.has_school_role(school_id, array['parent']::public.app_role[]))
    or (audience = 'class' and class_id is not null and (
      public.is_teacher_for_class(school_id, class_id)
      or public.is_student_in_class(school_id, class_id)
      or public.is_parent_of_class_student(school_id, class_id)
    ))
  ))
);
create policy "Admins and teachers manage announcements" on public.announcements for all to authenticated using (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or (audience = 'class' and class_id is not null and public.is_teacher_for_class(school_id, class_id))
) with check (
  public.has_school_role(school_id, array['school_admin']::public.app_role[])
  or (audience = 'class' and class_id is not null and public.is_teacher_for_class(school_id, class_id))
);
create policy "Members read events" on public.events for select to authenticated using (public.is_school_member(school_id));
create policy "Admins manage events" on public.events for all to authenticated using (public.has_school_role(school_id, array['school_admin']::public.app_role[])) with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));

create policy "Users read own notifications" on public.notifications for select to authenticated using (profile_id = auth.uid() and public.is_school_member(school_id));
create policy "Users update own notifications" on public.notifications for update to authenticated using (profile_id = auth.uid()) with check (profile_id = auth.uid());
create policy "Members read conversations" on public.conversations for select to authenticated using (
  public.is_school_member(school_id)
  and public.is_conversation_member(id)
);
create policy "Members create conversations" on public.conversations for insert to authenticated with check (public.is_school_member(school_id) and created_by = auth.uid());
create policy "Members read conversation participants" on public.conversation_members for select to authenticated using (public.is_conversation_member(conversation_id));
create policy "Conversation creators add members" on public.conversation_members for insert to authenticated with check (
  public.can_add_conversation_member(conversation_id, profile_id)
);
create policy "Participants read messages" on public.messages for select to authenticated using (
  public.is_conversation_member(conversation_id)
);
create policy "Participants send messages" on public.messages for insert to authenticated with check (
  sender_id = auth.uid()
  and public.is_conversation_member(conversation_id)
);

create policy "Admins read audit logs" on public.audit_logs for select to authenticated using (public.has_school_role(school_id, array['school_admin']::public.app_role[]));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('avatars', 'avatars', false, 5242880, array['image/jpeg', 'image/png', 'image/webp']),
  ('learning-materials', 'learning-materials', false, 52428800, array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']),
  ('assignment-submissions', 'assignment-submissions', false, 52428800, array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
  ('school-documents', 'school-documents', false, 52428800, array['application/pdf', 'image/jpeg', 'image/png', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do nothing;

create policy "Users access own avatar files" on storage.objects for select to authenticated using (
  bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
);
create policy "Users upload own avatar files" on storage.objects for insert to authenticated with check (
  bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
);
create policy "Users update own avatar files" on storage.objects for update to authenticated using (
  bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
) with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Users remove own avatar files" on storage.objects for delete to authenticated using (
  bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "School members can access authorized learning files" on storage.objects for select to authenticated using (
  bucket_id in ('learning-materials', 'assignment-submissions', 'school-documents')
  and (
    (
      bucket_id = 'learning-materials'
      and exists (select 1 from public.learning_materials material where material.storage_path = name)
    )
    or (
      bucket_id = 'assignment-submissions'
      and exists (select 1 from public.assignment_submissions submission where submission.storage_path = name)
    )
    or (
      bucket_id = 'school-documents'
      and exists (
        select 1 from public.school_memberships membership
        where membership.profile_id = auth.uid()
          and membership.school_id::text = (storage.foldername(name))[1]
          and membership.role = 'school_admin'
      )
    )
  )
);
create policy "School staff upload school files" on storage.objects for insert to authenticated with check (
  (
    bucket_id in ('learning-materials', 'school-documents')
    and exists (
      select 1 from public.school_memberships membership
      where membership.profile_id = auth.uid()
        and membership.school_id::text = (storage.foldername(name))[1]
        and membership.role in ('school_admin', 'teacher')
    )
  )
  or (
    bucket_id = 'assignment-submissions'
    and exists (
      select 1 from public.students student
      where student.profile_id = auth.uid()
        and student.school_id::text = (storage.foldername(name))[1]
        and student.id::text = (storage.foldername(name))[2]
    )
  )
);
create policy "School admins update or delete school files" on storage.objects for update to authenticated using (
  bucket_id in ('learning-materials', 'assignment-submissions', 'school-documents')
  and exists (
    select 1 from public.school_memberships membership
    where membership.profile_id = auth.uid()
      and membership.school_id::text = (storage.foldername(name))[1]
      and membership.role = 'school_admin'
  )
) with check (
  bucket_id in ('learning-materials', 'assignment-submissions', 'school-documents')
  and exists (
    select 1 from public.school_memberships membership
    where membership.profile_id = auth.uid()
      and membership.school_id::text = (storage.foldername(name))[1]
      and membership.role = 'school_admin'
  )
);
create policy "School admins delete school files" on storage.objects for delete to authenticated using (
  bucket_id in ('learning-materials', 'assignment-submissions', 'school-documents')
  and exists (
    select 1 from public.school_memberships membership
    where membership.profile_id = auth.uid()
      and membership.school_id::text = (storage.foldername(name))[1]
      and membership.role = 'school_admin'
  )
);
