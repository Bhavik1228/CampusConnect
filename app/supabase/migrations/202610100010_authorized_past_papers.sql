create table public.past_papers (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  created_by uuid not null references public.profiles(id),
  subject_name text not null,
  subject_code text not null,
  year integer not null check (year between 1900 and 2200),
  session text not null check (session in ('m', 's', 'w')),
  paper_number text not null,
  document_type text not null check (document_type in ('qp', 'ms', 'er', 'specimen')),
  file_name text not null,
  firebase_path text not null unique,
  source_url text not null,
  rights_basis text not null,
  file_size bigint not null check (file_size > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, file_name)
);

create index past_papers_school_subject_year_idx
  on public.past_papers(school_id, subject_code, year desc, session);

alter table public.past_papers enable row level security;

create policy "School staff manage authorized past paper metadata"
  on public.past_papers for all to authenticated
  using (public.has_school_role(school_id, array['school_admin', 'teacher']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin', 'teacher']::public.app_role[]));

grant select, insert, update, delete on public.past_papers to authenticated;
