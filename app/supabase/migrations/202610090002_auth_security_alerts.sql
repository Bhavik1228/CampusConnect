create table public.auth_login_failure_windows (
  email_hash text not null check (email_hash ~ '^[0-9a-f]{64}$'),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  failure_count integer not null default 0 check (failure_count >= 0),
  window_started_at timestamptz not null,
  last_attempt_at timestamptz not null,
  alert_claimed_at timestamptz,
  alert_sent_at timestamptz,
  primary key (email_hash, source_hash)
);

alter table public.auth_login_failure_windows enable row level security;
revoke all on table public.auth_login_failure_windows from public, anon, authenticated;
grant all on table public.auth_login_failure_windows to service_role;

create index auth_login_failure_windows_last_attempt_idx
  on public.auth_login_failure_windows(last_attempt_at);

create or replace function public.claim_login_failure_alert(
  p_email_hash text,
  p_source_hash text
)
returns table (failure_count integer, should_send_alert boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_attempts integer;
  claimed boolean := false;
begin
  if p_email_hash !~ '^[0-9a-f]{64}$' or p_source_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid login alert fingerprint';
  end if;

  insert into public.auth_login_failure_windows as current_window (
    email_hash,
    source_hash,
    failure_count,
    window_started_at,
    last_attempt_at
  )
  values (p_email_hash, p_source_hash, 1, now(), now())
  on conflict (email_hash, source_hash) do update
  set failure_count = case
        when current_window.window_started_at < now() - interval '15 minutes' then 1
        else current_window.failure_count + 1
      end,
      window_started_at = case
        when current_window.window_started_at < now() - interval '15 minutes' then now()
        else current_window.window_started_at
      end,
      last_attempt_at = now()
  returning current_window.failure_count into current_attempts;

  if current_attempts >= 5 then
    update public.auth_login_failure_windows as failure_window
    set alert_claimed_at = now()
    where failure_window.email_hash = p_email_hash
      and failure_window.source_hash = p_source_hash
      and (
        failure_window.alert_sent_at is null
        or failure_window.alert_sent_at < now() - interval '1 hour'
      )
      and (
        failure_window.alert_claimed_at is null
        or failure_window.alert_claimed_at < now() - interval '2 minutes'
      );
    claimed := found;
  end if;

  delete from public.auth_login_failure_windows
  where last_attempt_at < now() - interval '30 days';

  return query select current_attempts, claimed;
end;
$$;

create or replace function public.finish_login_failure_alert(
  p_email_hash text,
  p_source_hash text,
  p_sent boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_email_hash !~ '^[0-9a-f]{64}$' or p_source_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid login alert fingerprint';
  end if;

  update public.auth_login_failure_windows
  set alert_sent_at = case when p_sent then now() else alert_sent_at end,
      alert_claimed_at = null
  where email_hash = p_email_hash
    and source_hash = p_source_hash;
end;
$$;

revoke all on function public.claim_login_failure_alert(text, text) from public, anon, authenticated;
revoke all on function public.finish_login_failure_alert(text, text, boolean) from public, anon, authenticated;
grant execute on function public.claim_login_failure_alert(text, text) to service_role;
grant execute on function public.finish_login_failure_alert(text, text, boolean) to service_role;
