create or replace function public.execute_school_automation(
  target_automation uuid,
  test_only boolean,
  actor_id uuid,
  run_source text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  workflow public.school_automations%rowtype;
  school_name text;
  recipient_count integer := 0;
  announcement_id uuid;
  run_id uuid;
  rendered_title text;
  rendered_body text;
  weekday_number integer;
begin
  select * into workflow from public.school_automations
  where id = target_automation for update;
  if not found then raise exception 'Automation not found.'; end if;
  if not test_only and workflow.status <> 'active' then
    raise exception 'Only active automations can run.';
  end if;

  insert into public.school_automation_runs (
    school_id, automation_id, status, run_source, is_test, initiated_by, summary, details
  ) values (
    workflow.school_id, workflow.id, 'successful', run_source, test_only, actor_id,
    case when test_only then 'Configuration validated. No action was sent.' else 'Automation action completed.' end,
    jsonb_build_object('test_only', test_only, 'action_type', workflow.action_type)
  ) returning id into run_id;

  if test_only then
    update public.school_automation_runs set completed_at = now() where id = run_id;
    update public.school_automations set last_run_at = now() where id = workflow.id;
    return run_id;
  end if;

  begin
    select name into school_name from public.schools where id = workflow.school_id;
    rendered_title := replace(coalesce(workflow.action_config ->> 'title', ''), '{school_name}', school_name);
    rendered_title := replace(rendered_title, '{date}', (now() at time zone (select timezone from public.schools where id = workflow.school_id))::date::text);
    rendered_body := replace(coalesce(workflow.action_config ->> 'body', ''), '{school_name}', school_name);
    rendered_body := replace(rendered_body, '{date}', (now() at time zone (select timezone from public.schools where id = workflow.school_id))::date::text);

    if length(trim(rendered_title)) < 2 or length(trim(rendered_title)) > 160 then
      raise exception 'Action title must be between 2 and 160 characters.';
    end if;
    if length(trim(rendered_body)) < 3 or length(rendered_body) > 5000 then
      raise exception 'Action message must be between 3 and 5000 characters.';
    end if;

    if workflow.conditions @> '{"weekdays_only":true}'::jsonb then
      weekday_number := extract(isodow from now() at time zone (select timezone from public.schools where id = workflow.school_id))::integer;
      if weekday_number > 5 then
        update public.school_automation_runs
        set status = 'skipped', summary = 'Skipped because the condition allows weekdays only.',
            completed_at = now(), details = details || '{"condition":"weekdays_only"}'::jsonb
        where id = run_id;
        update public.school_automations set last_run_at = now() where id = workflow.id;
        return run_id;
      end if;
    end if;

    if workflow.action_type = 'notification' then
      if jsonb_typeof(workflow.action_config -> 'recipient_roles') <> 'array'
        or jsonb_array_length(workflow.action_config -> 'recipient_roles') = 0 then
        raise exception 'Choose at least one recipient role for the notification.';
      end if;
      insert into public.notifications (school_id, profile_id, title, body, target_path)
      select workflow.school_id, membership.profile_id, rendered_title, rendered_body,
        nullif(workflow.action_config ->> 'target_path', '')
      from public.school_memberships membership
      where membership.school_id = workflow.school_id
        and membership.role::text in (
          select jsonb_array_elements_text(workflow.action_config -> 'recipient_roles')
        );
      get diagnostics recipient_count = row_count;
      if recipient_count = 0 then
        update public.school_automation_runs
        set status = 'skipped', summary = 'No active school members match the selected recipient roles.',
            completed_at = now(), details = details || jsonb_build_object('recipient_count', 0)
        where id = run_id;
      else
        update public.school_automation_runs
        set summary = format('In-app notification sent to %s school member(s).', recipient_count),
            completed_at = now(), details = details || jsonb_build_object('recipient_count', recipient_count)
        where id = run_id;
      end if;
    elsif workflow.action_type = 'announcement' then
      if workflow.action_config ->> 'audience' not in ('school', 'staff', 'students', 'parents') then
        raise exception 'Choose a valid school announcement audience.';
      end if;
      insert into public.announcements (school_id, author_id, title, content, audience, published_at)
      values (workflow.school_id, workflow.owner_id, rendered_title, rendered_body,
        (workflow.action_config ->> 'audience')::public.audience_type, now())
      returning id into announcement_id;
      update public.school_automation_runs
      set summary = 'School announcement published.',
          completed_at = now(), details = details || jsonb_build_object('announcement_id', announcement_id)
      where id = run_id;
    else
      raise exception 'This automation action is not supported.';
    end if;

    update public.school_automations set last_run_at = now() where id = workflow.id;
    return run_id;
  exception when others then
    if run_id is not null then
      update public.school_automation_runs
      set status = 'failed', summary = 'Automation action failed.',
          error_message = left(sqlerrm, 1000), completed_at = now()
      where id = run_id;
      update public.school_automations set status = 'failed' where id = workflow.id;
    end if;
    return run_id;
  end;
end;
$$;

create or replace function public.run_due_school_automations()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  workflow public.school_automations%rowtype;
  due_record record;
  execution_count integer := 0;
  next_run timestamptz;
  current_status text;
  event_key text;
  target_event_name text;
  outstanding_amount numeric;
  school_timezone text;
begin
  if not pg_try_advisory_xact_lock(hashtext('campus-connect-school-automations')::bigint) then
    return 0;
  end if;
  for workflow in
    select * from public.school_automations
    where status = 'active' and trigger_type = 'schedule' and next_run_at <= now()
    order by next_run_at
    limit 100
    for update skip locked
  loop
    perform public.execute_school_automation(workflow.id, false, workflow.owner_id, 'scheduled'::text);
    select status into current_status from public.school_automations where id = workflow.id;
    if current_status = 'active' then
      next_run := public.next_school_automation_run(workflow.school_id, workflow.trigger_config, now());
      update public.school_automations set next_run_at = next_run where id = workflow.id;
    end if;
    execution_count := execution_count + 1;
  end loop;

  for workflow in
    select * from public.school_automations
    where status = 'active' and trigger_type in ('date_reached', 'assignment_deadline', 'fee_event')
    order by id
    limit 500
  loop
    select timezone into school_timezone from public.schools where id = workflow.school_id;
    if workflow.trigger_type = 'assignment_deadline'
      or workflow.trigger_type = 'date_reached' and workflow.trigger_config ->> 'source' = 'assignment_deadline' then
      for due_record in
        select assignment.id, assignment.title, assignment.due_at
        from public.assignments assignment
        where assignment.school_id = workflow.school_id and assignment.status = 'published'
          and assignment.due_at <= now() and workflow.trigger_activated_at <= assignment.due_at
          and not exists (
            select 1 from public.school_automation_runs run
            where run.school_id = workflow.school_id and run.automation_id = workflow.id
              and run.details ->> 'event_key' = ('assignment_deadline:' || assignment.id::text)
          )
      loop
        event_key := 'assignment_deadline:' || due_record.id::text;
        target_event_name := case when workflow.trigger_type = 'assignment_deadline'
          then 'assignment_deadline' else 'date_reached' end;
        execution_count := execution_count + public.fire_school_automation_event(
          workflow.school_id, target_event_name, 'assignments',
          jsonb_build_object('id', due_record.id, 'title', due_record.title, 'date_source', 'assignment_deadline'),
          event_key
        );
      end loop;
    end if;
    if workflow.trigger_type = 'date_reached'
      and workflow.trigger_config ->> 'source' = 'exam_date' then
      for due_record in
        select exam.id, exam.title, exam.exam_at
        from public.exams exam
        where exam.school_id = workflow.school_id and exam.exam_at <= now()
          and workflow.trigger_activated_at <= exam.exam_at
          and not exists (
            select 1 from public.school_automation_runs run
            where run.school_id = workflow.school_id and run.automation_id = workflow.id
              and run.details ->> 'event_key' = ('exam_date:' || exam.id::text)
          )
      loop
        event_key := 'exam_date:' || due_record.id::text;
        execution_count := execution_count + public.fire_school_automation_event(
          workflow.school_id, 'date_reached', 'exams',
          jsonb_build_object('id', due_record.id, 'title', due_record.title, 'date_source', 'exam_date'),
          event_key
        );
      end loop;
    end if;
    if workflow.trigger_type = 'date_reached'
      and workflow.trigger_config ->> 'source' = 'invoice_due_date' then
      for due_record in
        select invoice.id, invoice.description, invoice.due_on
        from public.student_fee_invoices invoice
        where invoice.school_id = workflow.school_id and invoice.status = 'issued'
          and invoice.due_on <= (now() at time zone school_timezone)::date
          and workflow.trigger_activated_at <= (invoice.due_on::timestamp at time zone school_timezone)
          and not exists (
            select 1 from public.school_automation_runs run
            where run.school_id = workflow.school_id and run.automation_id = workflow.id
              and run.details ->> 'event_key' = ('invoice_due_date:' || invoice.id::text)
          )
      loop
        event_key := 'invoice_due_date:' || due_record.id::text;
        execution_count := execution_count + public.fire_school_automation_event(
          workflow.school_id, 'date_reached', 'student_fee_invoices',
          jsonb_build_object('id', due_record.id, 'title', due_record.description, 'date_source', 'invoice_due_date'),
          event_key
        );
      end loop;
    end if;
    if workflow.trigger_type = 'fee_event' and workflow.trigger_config ->> 'event' = 'invoice_overdue' then
      for due_record in
        select invoice.id, invoice.description, invoice.due_on,
          invoice.amount - invoice.discount_amount
            + coalesce(adjustment_totals.net_adjustments, 0)
            - coalesce(payment_totals.allocated, 0) as balance
        from public.student_fee_invoices invoice
        left join lateral (
          select sum(case when adjustment.adjustment_type = 'charge' then adjustment.amount else -adjustment.amount end) as net_adjustments
          from public.student_fee_adjustments adjustment
          where adjustment.school_id = invoice.school_id and adjustment.invoice_id = invoice.id
        ) adjustment_totals on true
        left join lateral (
          select sum(allocation.amount) as allocated
          from public.student_fee_payment_allocations allocation
          where allocation.school_id = invoice.school_id and allocation.invoice_id = invoice.id
        ) payment_totals on true
        where invoice.school_id = workflow.school_id and invoice.status = 'issued'
          and invoice.due_on < (now() at time zone school_timezone)::date
          and workflow.trigger_activated_at <= ((invoice.due_on + 1)::timestamp at time zone school_timezone)
          and not exists (
            select 1 from public.school_automation_runs run
            where run.school_id = workflow.school_id and run.automation_id = workflow.id
              and run.details ->> 'event_key' = ('invoice_overdue:' || invoice.id::text)
          )
      loop
        outstanding_amount := due_record.balance;
        if outstanding_amount > 0 then
          event_key := 'invoice_overdue:' || due_record.id::text;
          execution_count := execution_count + public.fire_school_automation_event(
            workflow.school_id, 'invoice_overdue', 'student_fee_invoices',
            jsonb_build_object('id', due_record.id, 'title', due_record.description, 'date_source', 'invoice_overdue'),
            event_key
          );
        end if;
      end loop;
    end if;
  end loop;
  return execution_count;
end;
$$;

revoke all on function public.execute_school_automation(uuid, boolean, uuid, text) from public, anon, authenticated;
revoke all on function public.run_due_school_automations() from public, anon, authenticated;

notify pgrst, 'reload schema';
