create table public.system_owner_administrators (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  email text not null unique,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  revoked_at timestamptz,
  password_setup_pending boolean not null default true
);

alter table public.system_owner_administrators enable row level security;

create table public.system_owner_change_requests (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references public.profiles(id) on delete cascade,
  requested_by_email text not null,
  action text not null,
  request_payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'applied', 'denied', 'failed', 'execution_unknown')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  result_message text,
  created_at timestamptz not null default timezone('utc', now())
);

create index system_owner_change_requests_status_created_at_idx
  on public.system_owner_change_requests (status, created_at desc);
create index system_owner_change_requests_requested_by_created_at_idx
  on public.system_owner_change_requests (requested_by, created_at desc);

alter table public.system_owner_change_requests enable row level security;

revoke all on public.system_owner_administrators from anon, authenticated;
revoke all on public.system_owner_change_requests from anon, authenticated;
grant all on public.system_owner_administrators, public.system_owner_change_requests to service_role;
