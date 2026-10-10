create table public.learning_assessments (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  created_by uuid not null references public.profiles(id),
  title text not null,
  curriculum text not null default 'Cambridge',
  qualification text not null,
  subject text not null default '',
  syllabus_code text not null default '',
  topic text not null default '',
  subtopic text not null default '',
  duration_minutes integer not null default 60 check (duration_minutes > 0),
  total_marks numeric(8,2) not null default 0 check (total_marks >= 0),
  difficulty text not null default 'Mixed',
  instructions text not null default '',
  question_order text not null default 'As selected',
  permitted_resources text not null default '',
  mark_scheme text not null default '',
  question_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(question_ids) = 'array'),
  status text not null default 'draft' check (status in ('draft', 'ready')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id)
);

create index learning_assessments_school_updated_idx
  on public.learning_assessments(school_id, updated_at desc);

alter table public.learning_assessments enable row level security;

create policy "School staff manage learning assessments"
  on public.learning_assessments for all to authenticated
  using (public.has_school_role(school_id, array['school_admin', 'teacher']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin', 'teacher']::public.app_role[]));

grant select, insert, update, delete on public.learning_assessments to authenticated;

create table public.learning_questions (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  created_by uuid not null references public.profiles(id),
  question_text text not null,
  topic text not null,
  subtopic text not null default '',
  marks numeric(8,2) not null default 1 check (marks > 0),
  difficulty text not null default 'Standard',
  source_name text not null default 'Teacher-created',
  source_url text not null default '',
  mark_scheme text not null default '',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id)
);

create index learning_questions_school_topic_idx
  on public.learning_questions(school_id, topic);

alter table public.learning_questions enable row level security;

create policy "School staff manage learning questions"
  on public.learning_questions for all to authenticated
  using (public.has_school_role(school_id, array['school_admin', 'teacher']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin', 'teacher']::public.app_role[]));

grant select, insert, update, delete on public.learning_questions to authenticated;
