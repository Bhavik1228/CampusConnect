create table public.platform_accessibility_test_issues (
  id uuid primary key default gen_random_uuid(),
  test_type text not null check (test_type in ('accessibility', 'browser')),
  title text not null check (char_length(trim(title)) between 3 and 180),
  severity text not null default 'medium'
    check (severity in ('critical', 'high', 'medium', 'low')),
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'resolved', 'wont_fix')),
  device_type text not null check (device_type in ('desktop', 'mobile', 'tablet', 'other')),
  operating_system text not null check (char_length(trim(operating_system)) between 1 and 120),
  browser text not null default '' check (char_length(browser) <= 120),
  browser_version text not null default '' check (char_length(browser_version) <= 80),
  assistive_technology text not null default '' check (char_length(assistive_technology) <= 160),
  assistive_technology_version text not null default ''
    check (char_length(assistive_technology_version) <= 80),
  wcag_criterion text not null default '' check (char_length(wcag_criterion) <= 80),
  steps_to_reproduce text not null check (char_length(trim(steps_to_reproduce)) between 3 and 4000),
  expected_result text not null default '' check (char_length(expected_result) <= 2000),
  actual_result text not null check (char_length(trim(actual_result)) between 3 and 2000),
  resolution_notes text not null default '' check (char_length(resolution_notes) <= 2000),
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (browser <> '' or assistive_technology <> '')
);

create index platform_accessibility_test_issues_status_idx
  on public.platform_accessibility_test_issues(status, updated_at desc);
create index platform_accessibility_test_issues_type_severity_idx
  on public.platform_accessibility_test_issues(test_type, severity, created_at desc);

alter table public.platform_accessibility_test_issues enable row level security;
revoke all on public.platform_accessibility_test_issues from public, anon, authenticated;
grant all on public.platform_accessibility_test_issues to service_role;

create trigger platform_accessibility_test_issues_set_updated_at
  before update on public.platform_accessibility_test_issues
  for each row execute function public.set_updated_at();

notify pgrst, 'reload schema';
