create table if not exists public.platform_release_known_issues (
  vercel_deployment_id text primary key
    check (char_length(vercel_deployment_id) between 5 and 128),
  known_issues text not null
    check (char_length(known_issues) between 1 and 3000),
  updated_at timestamptz not null default timezone('utc', now()),
  updated_by uuid not null references auth.users(id) on delete restrict
);

alter table public.platform_release_known_issues enable row level security;
revoke all on public.platform_release_known_issues from public, anon, authenticated;
grant all on public.platform_release_known_issues to service_role;
