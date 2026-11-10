create extension if not exists pg_net with schema extensions;

create or replace function public.configure_student_behaviour_email_scheduler(target_secret text)
returns void
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
declare
  secret_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the trusted email service can configure scheduled delivery.';
  end if;
  if target_secret is null or char_length(target_secret) < 32 then
    raise exception 'The scheduled-delivery secret is missing or invalid.';
  end if;

  select id into secret_id
  from vault.decrypted_secrets
  where name = 'behaviour_email_cron_secret';

  if secret_id is null then
    perform vault.create_secret(
      target_secret,
      'behaviour_email_cron_secret',
      'Authorization for the scheduled Campus Connect behaviour email function.'
    );
  else
    perform vault.update_secret(
      secret_id,
      target_secret,
      'behaviour_email_cron_secret',
      'Authorization for the scheduled Campus Connect behaviour email function.'
    );
  end if;
end;
$$;

revoke all on function public.configure_student_behaviour_email_scheduler(text) from public, anon, authenticated;
grant execute on function public.configure_student_behaviour_email_scheduler(text) to service_role;

select cron.unschedule(jobid)
from cron.job
where jobname = 'campus-connect-behaviour-email-delivery';

select cron.schedule(
  'campus-connect-behaviour-email-delivery',
  '*/15 * * * *',
  $job$
    select net.http_post(
      url := 'https://vztnrxtfsusvjixczinv.supabase.co/functions/v1/student-behaviour-email',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-behaviour-cron-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'behaviour_email_cron_secret'
        )
      ),
      body := '{"action":"process_due"}'::jsonb
    );
  $job$
);

notify pgrst, 'reload schema';
