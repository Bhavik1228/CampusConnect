do $$
declare
  constraint_record record;
begin
  for constraint_record in
    select constraint_row.conname
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.school_automations'::regclass
      and constraint_row.contype = 'c'
      and (
        pg_get_constraintdef(constraint_row.oid) ilike '%trigger_type%'
        or pg_get_constraintdef(constraint_row.oid) ilike '%trigger_config%'
      )
  loop
    execute format(
      'alter table public.school_automations drop constraint %I',
      constraint_record.conname
    );
  end loop;

  alter table public.school_automations
    add constraint school_automations_trigger_type_check
      check (trigger_type in (
        'schedule', 'record_created', 'record_updated', 'status_changed', 'date_reached',
        'attendance_event', 'assignment_deadline', 'assessment_event', 'fee_event',
        'admission_event', 'staff_student_event'
      )),
    add constraint school_automations_trigger_config_check
      check (jsonb_typeof(trigger_config) = 'object');
end;
$$;

alter table public.school_automation_runs
  add column if not exists run_source text not null default 'scheduled';

do $$
declare
  constraint_record record;
begin
  for constraint_record in
    select constraint_row.conname
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.school_automation_runs'::regclass
      and constraint_row.contype = 'c'
      and pg_get_constraintdef(constraint_row.oid) ilike '%run_source%'
  loop
    execute format(
      'alter table public.school_automation_runs drop constraint %I',
      constraint_record.conname
    );
  end loop;

  alter table public.school_automation_runs
    add constraint school_automation_runs_run_source_check
      check (run_source in ('scheduled', 'manual', 'test', 'event'));
end;
$$;

alter table public.school_automations
  add column if not exists trigger_activated_at timestamptz;

update public.school_automations
set trigger_activated_at = now()
where status = 'active' and trigger_activated_at is null;

create or replace function public.next_school_automation_run(
  target_school uuid,
  target_config jsonb,
  after_time timestamptz default now()
)
returns timestamptz
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  school_timezone text;
  frequency text := target_config ->> 'frequency';
  run_time time;
  target_weekday integer;
  target_day integer;
  local_candidate timestamp;
  candidate timestamptz;
  day_offset integer;
  month_offset integer;
  month_start timestamp;
  month_last_day integer;
begin
  select timezone into school_timezone from public.schools where id = target_school;
  if not found then raise exception 'Automation school was not found.'; end if;
  if frequency not in ('daily', 'weekly', 'monthly') then
    raise exception 'Choose a daily, weekly, or monthly schedule.';
  end if;
  run_time := (target_config ->> 'time')::time;
  if frequency = 'weekly' then
    target_weekday := (target_config ->> 'weekday')::integer;
  elsif frequency = 'monthly' then
    target_day := (target_config ->> 'day_of_month')::integer;
  end if;

  if frequency = 'monthly' then
    for month_offset in 0..2 loop
      month_start := date_trunc('month', after_time at time zone school_timezone)
        + make_interval(months => month_offset);
      month_last_day := extract(day from (month_start + interval '1 month - 1 day'))::integer;
      local_candidate := month_start
        + (least(target_day, month_last_day) - 1) * interval '1 day'
        + run_time;
      candidate := local_candidate at time zone school_timezone;
      if candidate > after_time then return candidate; end if;
    end loop;
  else
    for day_offset in 0..8 loop
      local_candidate := ((after_time at time zone school_timezone)::date + day_offset) + run_time;
      candidate := local_candidate at time zone school_timezone;
      if candidate <= after_time then continue; end if;
      if frequency = 'weekly'
        and extract(dow from local_candidate)::integer <> target_weekday then continue; end if;
      return candidate;
    end loop;
  end if;
  raise exception 'Could not calculate the next automation run.';
end;
$$;

create or replace function public.set_school_automation_schedule()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  config_frequency text;
  config_event text;
begin
  if new.status = 'active' then
    if length(trim(coalesce(new.action_config ->> 'title', ''))) not between 2 and 160 then
      raise exception 'Action title must be between 2 and 160 characters before activation.';
    end if;
    if length(trim(coalesce(new.action_config ->> 'body', ''))) not between 3 and 5000 then
      raise exception 'Action message must be between 3 and 5000 characters before activation.';
    end if;
    if jsonb_typeof(new.conditions -> 'weekdays_only') not in ('boolean', 'null') then
      raise exception 'Automation conditions are invalid.';
    end if;
    if new.action_type = 'notification' then
      if jsonb_typeof(new.action_config -> 'recipient_roles') <> 'array'
        or jsonb_array_length(new.action_config -> 'recipient_roles') = 0 then
        raise exception 'Choose at least one notification recipient role before activation.';
      end if;
      if exists (
        select 1 from jsonb_array_elements_text(new.action_config -> 'recipient_roles') recipient(role)
        where recipient.role not in (
          'school_admin', 'academic_coordinator', 'teacher', 'student', 'parent',
          'finance_manager', 'accountant', 'bursar', 'cashier', 'nurse', 'doctor', 'secretary'
        )
      ) then
        raise exception 'Notification recipient roles contain an unsupported role.';
      end if;
      if nullif(new.action_config ->> 'target_path', '') is not null
        and (new.action_config ->> 'target_path' !~ '^/' or new.action_config ->> 'target_path' ~ '^//') then
        raise exception 'Notification destination must be a safe in-app path.';
      end if;
    elsif new.action_type = 'announcement'
      and coalesce(new.action_config ->> 'audience', '') not in ('school', 'staff', 'students', 'parents') then
      raise exception 'Choose a valid announcement audience before activation.';
    end if;

    config_frequency := new.trigger_config ->> 'frequency';
    config_event := new.trigger_config ->> 'event';
    if new.trigger_type = 'schedule' then
      if config_frequency not in ('daily', 'weekly', 'monthly')
        or coalesce(new.trigger_config ->> 'time', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
        raise exception 'Choose a valid daily, weekly, or monthly schedule.';
      end if;
      if config_frequency = 'weekly'
        and coalesce((new.trigger_config ->> 'weekday')::integer between 0 and 6, false) is false then
        raise exception 'Choose a valid day of the week.';
      end if;
      if config_frequency = 'monthly'
        and coalesce((new.trigger_config ->> 'day_of_month')::integer between 1 and 31, false) is false then
        raise exception 'Choose a valid day of the month.';
      end if;
    elsif new.trigger_type in ('record_created', 'record_updated', 'status_changed') then
      if coalesce(new.trigger_config ->> 'source_table', '') not in (
        'students', 'staff_profiles', 'assignments', 'assignment_submissions',
        'attendance_records', 'exam_results', 'learning_assessment_results',
        'student_fee_invoices', 'admission_applications'
      ) then
        raise exception 'Choose a supported school record type.';
      end if;
      if new.trigger_type = 'status_changed'
        and new.trigger_config ->> 'source_table' = 'exam_results' then
        raise exception 'Exam results do not have a status field; choose an event trigger instead.';
      end if;
    elsif new.trigger_type = 'date_reached'
      and coalesce(new.trigger_config ->> 'source', '') not in ('assignment_deadline', 'exam_date', 'invoice_due_date') then
      raise exception 'Choose a supported school date.';
    elsif new.trigger_type = 'attendance_event' then
      if config_event = 'recorded' then
        null;
      elsif config_event = 'absence_threshold' then
        if coalesce((new.trigger_config ->> 'threshold')::integer between 1 and 30, false) is false
          or coalesce((new.trigger_config ->> 'window_days')::integer between 1 and 90, false) is false then
          raise exception 'Choose a valid attendance absence threshold and date window.';
        end if;
      else
        raise exception 'Choose a supported attendance event.';
      end if;
    elsif new.trigger_type = 'assignment_deadline' then
      null;
    elsif new.trigger_type = 'assessment_event'
      and coalesce(config_event, '') not in ('marks_submitted', 'assessment_published', 'submission_graded') then
      raise exception 'Choose a supported assessment event.';
    elsif new.trigger_type = 'fee_event'
      and coalesce(config_event, '') not in ('payment_recorded', 'invoice_overdue') then
      raise exception 'Choose a supported fee event.';
    elsif new.trigger_type = 'admission_event'
      and coalesce(config_event, '') not in ('submitted', 'status_changed') then
      raise exception 'Choose a supported admission event.';
    elsif new.trigger_type = 'staff_student_event'
      and coalesce(config_event, '') not in ('student_created', 'student_status_changed', 'student_enrolled', 'staff_created', 'staff_status_changed') then
      raise exception 'Choose a supported staff or student event.';
    end if;

    if new.trigger_type = 'schedule' then
      if tg_op = 'INSERT' then
        new.next_run_at := public.next_school_automation_run(new.school_id, new.trigger_config, now());
      elsif new.status is distinct from old.status
        or new.trigger_type is distinct from old.trigger_type
        or new.trigger_config is distinct from old.trigger_config then
        new.next_run_at := public.next_school_automation_run(new.school_id, new.trigger_config, now());
      else
        new.next_run_at := old.next_run_at;
      end if;
    else
      new.next_run_at := null;
    end if;
    if tg_op = 'INSERT' then
      new.trigger_activated_at := now();
    elsif new.status is distinct from old.status
      or new.trigger_type is distinct from old.trigger_type
      or new.trigger_config is distinct from old.trigger_config then
      new.trigger_activated_at := now();
    else
      new.trigger_activated_at := old.trigger_activated_at;
    end if;
  else
    new.next_run_at := null;
    new.trigger_activated_at := null;
  end if;
  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists school_automations_schedule_update on public.school_automations;
create trigger school_automations_schedule_update
  before insert or update of status, trigger_type, trigger_config, action_type, action_config,
    conditions, trigger_activated_at
  on public.school_automations
  for each row execute function public.set_school_automation_schedule();

create or replace function public.fire_school_automation_event(
  target_school uuid,
  target_event text,
  target_table text,
  target_record jsonb,
  target_event_key text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  workflow public.school_automations%rowtype;
  run_id uuid;
  fire_workflow boolean;
  absence_count integer;
  window_days integer;
  fired_count integer := 0;
  target_record_id text := target_record ->> 'id';
begin
  for workflow in
    select * from public.school_automations automation
    where automation.school_id = target_school and automation.status = 'active'
      and automation.trigger_type <> 'schedule'
    order by automation.id
  loop
    fire_workflow := case workflow.trigger_type
      when 'record_created' then target_event = 'created' and workflow.trigger_config ->> 'source_table' = target_table
      when 'record_updated' then target_event = 'updated' and workflow.trigger_config ->> 'source_table' = target_table
      when 'status_changed' then target_event = 'status_changed' and workflow.trigger_config ->> 'source_table' = target_table
      when 'date_reached' then target_event = 'date_reached'
        and workflow.trigger_config ->> 'source' = target_record ->> 'date_source'
      when 'attendance_event' then
        workflow.trigger_config ->> 'event' = 'recorded' and target_event = 'attendance_recorded'
        or workflow.trigger_config ->> 'event' = 'absence_threshold' and target_event = 'attendance_absence'
      when 'assignment_deadline' then target_event = 'assignment_deadline'
      when 'assessment_event' then workflow.trigger_config ->> 'event' = target_event
      when 'fee_event' then workflow.trigger_config ->> 'event' = target_event
      when 'admission_event' then workflow.trigger_config ->> 'event' = target_event
      when 'staff_student_event' then workflow.trigger_config ->> 'event' = target_event
      else false
    end;

    if workflow.trigger_type = 'status_changed' and fire_workflow then
      fire_workflow := coalesce(target_record ->> 'new_status', '') <> ''
        and target_record ->> 'new_status' is distinct from target_record ->> 'old_status'
        and (nullif(workflow.trigger_config ->> 'status', '') is null
          or workflow.trigger_config ->> 'status' = target_record ->> 'new_status');
    end if;
    if workflow.trigger_type = 'attendance_event'
      and workflow.trigger_config ->> 'event' = 'absence_threshold'
      and target_event = 'attendance_absence' then
      window_days := (workflow.trigger_config ->> 'window_days')::integer;
      select count(*) into absence_count
      from public.attendance_records record
      join public.attendance_sessions session
        on session.school_id = record.school_id and session.id = record.session_id
      where record.school_id = target_school
        and record.student_id = (target_record ->> 'student_id')::uuid
        and record.status = 'absent'
        and session.attendance_date >= (now() at time zone (select timezone from public.schools where id = target_school))::date - window_days + 1;
      fire_workflow := absence_count = (workflow.trigger_config ->> 'threshold')::integer;
    end if;
    if target_event_key is not null and exists (
      select 1 from public.school_automation_runs run
      where run.school_id = workflow.school_id and run.automation_id = workflow.id
        and run.details ->> 'event_key' = target_event_key
    ) then
      fire_workflow := false;
    end if;

    if fire_workflow then
      run_id := public.execute_school_automation(workflow.id, false, workflow.owner_id, 'event');
      if run_id is not null then
        update public.school_automation_runs
        set details = details || jsonb_build_object(
          'event', target_event,
          'source_table', target_table,
          'record_id', target_record_id,
          'event_key', target_event_key
        )
        where id = run_id;
        fired_count := fired_count + 1;
      end if;
    end if;
  end loop;
  return fired_count;
end;
$$;

create or replace function public.capture_school_automation_record_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  current_record jsonb;
  previous_record jsonb;
  changed_field text;
  event_count integer := 0;
  target_status text;
  previous_status text;
begin
  current_record := to_jsonb(new);
  if tg_op = 'UPDATE' then
    previous_record := to_jsonb(old);
  end if;
  if tg_op = 'INSERT' then
    event_count := event_count + public.fire_school_automation_event(new.school_id, 'created', tg_table_name, current_record);
  else
    event_count := event_count + public.fire_school_automation_event(new.school_id, 'updated', tg_table_name, current_record);
    target_status := coalesce(current_record ->> 'status', current_record ->> 'employment_status');
    previous_status := coalesce(previous_record ->> 'status', previous_record ->> 'employment_status');
    if target_status is distinct from previous_status and target_status is not null then
      current_record := current_record || jsonb_build_object('new_status', target_status, 'old_status', previous_status);
      event_count := event_count + public.fire_school_automation_event(new.school_id, 'status_changed', tg_table_name, current_record);
    end if;
  end if;

  if tg_table_name = 'attendance_records' then
    if tg_op = 'INSERT' then
      event_count := event_count + public.fire_school_automation_event(new.school_id, 'attendance_recorded', tg_table_name, current_record);
    elsif old.status is distinct from new.status then
      if new.status = 'absent' then
        event_count := event_count + public.fire_school_automation_event(new.school_id, 'attendance_absence', tg_table_name, current_record);
      end if;
    end if;
    if tg_op = 'INSERT' and new.status = 'absent' then
      event_count := event_count + public.fire_school_automation_event(new.school_id, 'attendance_absence', tg_table_name, current_record);
    end if;
  elsif tg_table_name = 'exam_results' then
    if tg_op = 'INSERT' then
      event_count := event_count + public.fire_school_automation_event(new.school_id, 'marks_submitted', tg_table_name, current_record);
      if new.published_at is not null then
        event_count := event_count + public.fire_school_automation_event(new.school_id, 'assessment_published', tg_table_name, current_record);
      end if;
    elsif old.published_at is null and new.published_at is not null then
      event_count := event_count + public.fire_school_automation_event(new.school_id, 'assessment_published', tg_table_name, current_record);
    end if;
  elsif tg_table_name = 'learning_assessment_results' then
    if tg_op = 'INSERT' then
      event_count := event_count + public.fire_school_automation_event(new.school_id, 'marks_submitted', tg_table_name, current_record);
      if new.status = 'published' then
        event_count := event_count + public.fire_school_automation_event(new.school_id, 'assessment_published', tg_table_name, current_record);
      end if;
    elsif old.status is distinct from new.status and new.status = 'published' then
      event_count := event_count + public.fire_school_automation_event(new.school_id, 'assessment_published', tg_table_name, current_record);
    end if;
  elsif tg_table_name = 'assignment_submissions' then
    if tg_op = 'UPDATE' then
      if old.status is distinct from new.status and new.status in ('graded', 'returned') then
        event_count := event_count + public.fire_school_automation_event(new.school_id, 'submission_graded', tg_table_name, current_record);
      end if;
    end if;
  elsif tg_table_name = 'student_fee_payments' and tg_op = 'INSERT' then
    event_count := event_count + public.fire_school_automation_event(new.school_id, 'payment_recorded', tg_table_name, current_record);
  elsif tg_table_name = 'admission_applications' then
    if tg_op = 'INSERT' and new.status = 'submitted' then
      event_count := event_count + public.fire_school_automation_event(new.school_id, 'submitted', tg_table_name, current_record);
    elsif tg_op = 'UPDATE' and old.status is distinct from new.status then
      current_record := current_record || jsonb_build_object('new_status', new.status, 'old_status', old.status);
      event_count := event_count + public.fire_school_automation_event(new.school_id, 'status_changed', tg_table_name, current_record);
    end if;
  elsif tg_table_name = 'students' then
    if tg_op = 'INSERT' then
      event_count := event_count + public.fire_school_automation_event(new.school_id, 'student_created', tg_table_name, current_record);
    elsif old.status is distinct from new.status then
      event_count := event_count + public.fire_school_automation_event(new.school_id, 'student_status_changed', tg_table_name, current_record);
    end if;
  elsif tg_table_name = 'staff_profiles' then
    if tg_op = 'INSERT' then
      event_count := event_count + public.fire_school_automation_event(new.school_id, 'staff_created', tg_table_name, current_record);
    elsif old.employment_status is distinct from new.employment_status then
      event_count := event_count + public.fire_school_automation_event(new.school_id, 'staff_status_changed', tg_table_name, current_record);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists school_automation_students_events on public.students;
create trigger school_automation_students_events
  after insert or update on public.students
  for each row execute function public.capture_school_automation_record_change();
drop trigger if exists school_automation_staff_events on public.staff_profiles;
create trigger school_automation_staff_events
  after insert or update on public.staff_profiles
  for each row execute function public.capture_school_automation_record_change();
drop trigger if exists school_automation_assignments_events on public.assignments;
create trigger school_automation_assignments_events
  after insert or update on public.assignments
  for each row execute function public.capture_school_automation_record_change();
drop trigger if exists school_automation_submissions_events on public.assignment_submissions;
create trigger school_automation_submissions_events
  after insert or update on public.assignment_submissions
  for each row execute function public.capture_school_automation_record_change();
drop trigger if exists school_automation_attendance_events on public.attendance_records;
create trigger school_automation_attendance_events
  after insert or update on public.attendance_records
  for each row execute function public.capture_school_automation_record_change();
drop trigger if exists school_automation_exam_results_events on public.exam_results;
create trigger school_automation_exam_results_events
  after insert or update on public.exam_results
  for each row execute function public.capture_school_automation_record_change();
drop trigger if exists school_automation_learning_results_events on public.learning_assessment_results;
create trigger school_automation_learning_results_events
  after insert or update on public.learning_assessment_results
  for each row execute function public.capture_school_automation_record_change();
drop trigger if exists school_automation_fee_invoices_events on public.student_fee_invoices;
create trigger school_automation_fee_invoices_events
  after insert or update on public.student_fee_invoices
  for each row execute function public.capture_school_automation_record_change();
drop trigger if exists school_automation_fee_payments_events on public.student_fee_payments;
create trigger school_automation_fee_payments_events
  after insert on public.student_fee_payments
  for each row execute function public.capture_school_automation_record_change();
drop trigger if exists school_automation_admissions_events on public.admission_applications;
create trigger school_automation_admissions_events
  after insert or update on public.admission_applications
  for each row execute function public.capture_school_automation_record_change();

create or replace function public.capture_school_automation_student_enrolment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.fire_school_automation_event(
    new.school_id,
    'student_enrolled',
    'class_students',
    to_jsonb(new) || jsonb_build_object('id', new.student_id)
  );
  return new;
end;
$$;

drop trigger if exists school_automation_student_enrolment_event on public.class_students;
create trigger school_automation_student_enrolment_event
  after insert on public.class_students
  for each row execute function public.capture_school_automation_student_enrolment();

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
    perform public.execute_school_automation(workflow.id, false, workflow.owner_id, 'scheduled');
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
    if workflow.trigger_type = 'date_reached' and workflow.trigger_config ->> 'source' = 'exam_date' then
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
    if workflow.trigger_type = 'date_reached' and workflow.trigger_config ->> 'source' = 'invoice_due_date' then
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

revoke all on function public.fire_school_automation_event(uuid, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.capture_school_automation_record_change() from public, anon, authenticated;
revoke all on function public.capture_school_automation_student_enrolment() from public, anon, authenticated;
revoke all on function public.run_due_school_automations() from public, anon, authenticated;
