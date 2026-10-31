create table public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  school_id uuid references public.schools(id) on delete set null,
  school_name text not null,
  requester_id uuid not null,
  requester_name text not null,
  requester_email text,
  requester_role text not null,
  category text not null check (category in ('account_access', 'academics', 'attendance', 'finance', 'technical', 'other')),
  title text not null check (char_length(trim(title)) between 3 and 120),
  description text not null check (char_length(trim(description)) between 10 and 5000),
  status text not null default 'new' check (status in ('new', 'in_progress', 'waiting_on_requester', 'resolved', 'closed')),
  owner_response text not null default '',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index support_tickets_open_created_idx
  on public.support_tickets(created_at)
  where status in ('new', 'in_progress', 'waiting_on_requester');
create index support_tickets_requester_school_created_idx
  on public.support_tickets(requester_id, school_id, created_at desc);

alter table public.support_tickets enable row level security;
revoke all on public.support_tickets from public, anon, authenticated;
grant all on public.support_tickets to service_role;

create trigger set_support_tickets_updated_at
  before update on public.support_tickets
  for each row execute function public.set_updated_at();
