create table if not exists public.past_paper_syllabus_topics (
  id uuid primary key default gen_random_uuid(),
  curriculum text not null check (curriculum in (
    'Cambridge Primary', 'Cambridge Lower Secondary', 'O Level',
    'IGCSE', 'AS Level', 'A Level'
  )),
  subject_name text not null check (length(btrim(subject_name)) between 1 and 160),
  syllabus_code text not null check (length(btrim(syllabus_code)) between 1 and 40),
  syllabus_version text not null check (length(btrim(syllabus_version)) between 1 and 80),
  topic text not null check (length(btrim(topic)) between 1 and 200),
  subtopic text not null default '' check (length(subtopic) <= 200),
  approved_phrases text[] not null default '{}',
  source_url text not null,
  verified_by uuid not null references public.profiles(id),
  verified_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  unique (curriculum, syllabus_code, syllabus_version, topic, subtopic)
);

create index if not exists past_paper_syllabus_lookup_idx
  on public.past_paper_syllabus_topics(curriculum, syllabus_code, syllabus_version);

alter table public.past_paper_syllabus_topics enable row level security;
drop policy if exists "School members read verified syllabus topics"
  on public.past_paper_syllabus_topics;
create policy "School members read verified syllabus topics"
  on public.past_paper_syllabus_topics for select to authenticated
  using (auth.uid() is not null);
grant select on public.past_paper_syllabus_topics to authenticated;
grant all on public.past_paper_syllabus_topics to service_role;

create table if not exists public.past_paper_syllabus_history (
  id uuid primary key default gen_random_uuid(),
  syllabus_topic_id uuid not null,
  changed_by uuid references public.profiles(id),
  operation text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  before_record jsonb,
  after_record jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.past_paper_syllabus_history enable row level security;
revoke all on public.past_paper_syllabus_history from anon, authenticated;
grant all on public.past_paper_syllabus_history to service_role;

create or replace function public.audit_past_paper_syllabus_topic()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.past_paper_syllabus_history (
    syllabus_topic_id, changed_by, operation, before_record, after_record
  ) values (
    coalesce(new.id, old.id),
    coalesce(
      auth.uid(),
      case when tg_op = 'DELETE' then old.verified_by else new.verified_by end
    ),
    tg_op,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists audit_past_paper_syllabus_topic_change
  on public.past_paper_syllabus_topics;
create trigger audit_past_paper_syllabus_topic_change
after insert or update or delete on public.past_paper_syllabus_topics
for each row execute function public.audit_past_paper_syllabus_topic();

do $$
begin
  if not exists (
    select 1
    from pg_constraint constraint_record
    where constraint_record.conrelid = 'public.past_paper_catalogue_questions'::regclass
      and constraint_record.conname = 'past_paper_catalogue_syllabus_topic_fk'
  ) then
    alter table public.past_paper_catalogue_questions
      add constraint past_paper_catalogue_syllabus_topic_fk
      foreign key (syllabus_topic_id)
      references public.past_paper_syllabus_topics(id)
      on delete set null
      not valid;
  end if;
end;
$$;

notify pgrst, 'reload schema';
