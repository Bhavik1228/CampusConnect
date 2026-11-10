alter table public.student_behaviour_records
  add column status text not null default 'published'
    check (status in ('draft', 'submitted', 'under_review', 'published', 'resolved', 'closed', 'returned')),
  add column severity text not null default 'moderate'
    check (severity in ('minor', 'moderate', 'serious')),
  add column context text not null default '' check (char_length(context) <= 200),
  add column student_perspective text not null default '' check (char_length(student_perspective) <= 3000),
  add column guardian_visible boolean not null default true,
  add column confidential boolean not null default false,
  add column reviewed_by uuid references public.profiles(id) on delete set null,
  add column reviewed_at timestamptz,
  add column review_note text not null default '' check (char_length(review_note) <= 2000),
  add column resolved_at timestamptz;
alter table public.student_behaviour_settings
  add column quiet_hours_start time not null default '21:00',
  add column quiet_hours_end time not null default '07:00',
  add column school_contact_email text not null default '' check (char_length(school_contact_email) <= 320);

alter table public.student_behaviour_records
  alter column status set default 'submitted',
  alter column guardian_visible set default false,
  alter column severity set default 'minor';

create table public.student_behaviour_email_templates (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  event_type text not null check (event_type in (
    'positive_recognition', 'recognition_award', 'improvement_update',
    'weekly_positive_summary', 'library_recognition', 'concern_notification',
    'meeting_invitation', 'followup_reminder', 'support_plan_review',
    'case_resolution', 'correction_update', 'staff_escalation', 'manual_report'
  )),
  enabled boolean not null default false,
  require_approval boolean not null default true,
  delay_minutes integer not null default 0 check (delay_minutes between 0 and 1440),
  subject_template text not null default 'A secure school update is available'
    check (char_length(trim(subject_template)) between 2 and 120),
  body_template text not null default 'A secure school update is available. Sign in to Campus Connect to review it: {secure_link}'
    check (char_length(trim(body_template)) between 10 and 1200),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, event_type)
);

create table public.student_behaviour_email_preferences (
  school_id uuid not null references public.schools(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  event_type text not null check (event_type in (
    'positive_recognition', 'recognition_award', 'improvement_update',
    'weekly_positive_summary', 'library_recognition', 'concern_notification',
    'meeting_invitation', 'followup_reminder', 'support_plan_review',
    'case_resolution', 'correction_update', 'staff_escalation', 'manual_report'
  )),
  email_enabled boolean not null default true,
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (school_id, profile_id, event_type)
);
insert into public.student_behaviour_email_preferences (school_id, profile_id, event_type, email_enabled)
select membership.school_id, membership.profile_id, events.event_type, true
from public.school_memberships membership
cross join (values
  ('positive_recognition'), ('recognition_award'), ('improvement_update'),
  ('weekly_positive_summary'), ('library_recognition'), ('concern_notification'),
  ('meeting_invitation'), ('followup_reminder'), ('support_plan_review'),
  ('case_resolution'), ('correction_update'), ('manual_report')
) events(event_type)
where membership.role::text in ('parent', 'student')
on conflict (school_id, profile_id, event_type) do nothing;

create table public.student_behaviour_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  recipient_profile_id uuid not null references public.profiles(id) on delete cascade,
  event_type text not null check (event_type in (
    'positive_recognition', 'recognition_award', 'improvement_update',
    'weekly_positive_summary', 'library_recognition', 'concern_notification',
    'meeting_invitation', 'followup_reminder', 'support_plan_review',
    'case_resolution', 'correction_update', 'staff_escalation', 'manual_report'
  )),
  record_id uuid,
  source_type text not null default 'record'
    check (source_type in ('record', 'award', 'meeting', 'followup', 'support_plan', 'correction', 'escalation', 'weekly_summary')),
  source_id uuid,
  target_path text not null check (target_path like '/%' and target_path not like '//%'),
  idempotency_key text not null unique,
  status text not null default 'queued'
    check (status in ('awaiting_approval', 'queued', 'sending', 'sent', 'failed', 'unknown', 'suppressed')),
  scheduled_at timestamptz not null default timezone('utc', now()),
  attempt_count integer not null default 0 check (attempt_count between 0 and 10),
  requested_by uuid references public.profiles(id) on delete set null,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  provider_reference text,
  last_error text not null default '' check (char_length(last_error) <= 500),
  notification_id uuid references public.notifications(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  attempted_at timestamptz,
  delivered_at timestamptz,
  foreign key (school_id, record_id)
    references public.student_behaviour_records(school_id, id) on delete cascade
);
create index student_behaviour_email_deliveries_due_idx
  on public.student_behaviour_email_deliveries(scheduled_at, created_at)
  where status = 'queued';
create index student_behaviour_email_deliveries_school_idx
  on public.student_behaviour_email_deliveries(school_id, created_at desc);

create table public.student_behaviour_followups (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  record_id uuid not null,
  title text not null check (char_length(trim(title)) between 2 and 120),
  description text not null default '' check (char_length(description) <= 1500),
  assigned_to uuid references public.profiles(id) on delete set null,
  due_at timestamptz,
  guardian_visible boolean not null default false,
  status text not null default 'open' check (status in ('open', 'in_progress', 'done', 'cancelled')),
  completed_at timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, record_id)
    references public.student_behaviour_records(school_id, id) on delete cascade
);

create table public.student_behaviour_support_plans (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null,
  record_id uuid,
  title text not null check (char_length(trim(title)) between 2 and 120),
  guardian_goals text not null default '' check (char_length(guardian_goals) <= 3000),
  review_due_at timestamptz,
  status text not null default 'active' check (status in ('active', 'completed', 'cancelled')),
  guardian_visible boolean not null default false,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, student_id) references public.students(school_id, id) on delete cascade,
  foreign key (school_id, record_id) references public.student_behaviour_records(school_id, id) on delete set null (record_id)
);
create table public.student_behaviour_support_plan_staff_notes (
  school_id uuid not null references public.schools(id) on delete cascade,
  plan_id uuid not null,
  note_id uuid primary key default gen_random_uuid(),
  note text not null check (char_length(trim(note)) between 1 and 3000),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, plan_id) references public.student_behaviour_support_plans(school_id, id) on delete cascade
);

create table public.student_behaviour_meetings (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null,
  record_id uuid,
  title text not null check (char_length(trim(title)) between 2 and 120),
  agenda text not null default '' check (char_length(agenda) <= 2000),
  scheduled_at timestamptz not null,
  location text not null default '' check (char_length(location) <= 200),
  guardian_visible boolean not null default true,
  status text not null default 'scheduled' check (status in ('scheduled', 'completed', 'cancelled')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, student_id) references public.students(school_id, id) on delete cascade,
  foreign key (school_id, record_id) references public.student_behaviour_records(school_id, id) on delete set null (record_id)
);

create table public.student_behaviour_meeting_responses (
  school_id uuid not null references public.schools(id) on delete cascade,
  meeting_id uuid not null,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  response text not null default 'pending' check (response in ('pending', 'accepted', 'declined', 'request_change')),
  response_note text not null default '' check (char_length(response_note) <= 1000),
  responded_at timestamptz,
  primary key (meeting_id, profile_id),
  foreign key (school_id, meeting_id) references public.student_behaviour_meetings(school_id, id) on delete cascade
);

create table public.student_behaviour_correction_requests (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  record_id uuid not null,
  requester_profile_id uuid not null references public.profiles(id) on delete cascade,
  request_text text not null check (char_length(trim(request_text)) between 5 and 2000),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'clarification_requested')),
  resolution_note text not null default '' check (char_length(resolution_note) <= 2000),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, record_id) references public.student_behaviour_records(school_id, id) on delete cascade
);

create table public.student_behaviour_escalations (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  record_id uuid not null,
  escalated_by uuid not null references public.profiles(id),
  assigned_to uuid references public.profiles(id) on delete set null,
  reason text not null check (char_length(trim(reason)) between 5 and 1500),
  status text not null default 'open' check (status in ('open', 'reviewing', 'resolved', 'closed')),
  resolution_note text not null default '' check (char_length(resolution_note) <= 2000),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, record_id) references public.student_behaviour_records(school_id, id) on delete cascade
);

create table public.student_behaviour_awards (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null,
  record_id uuid,
  title text not null check (char_length(trim(title)) between 2 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  award_type text not null default 'badge' check (award_type in ('badge', 'certificate')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  guardian_visible boolean not null default false,
  created_by uuid not null references public.profiles(id),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, student_id) references public.students(school_id, id) on delete cascade,
  foreign key (school_id, record_id) references public.student_behaviour_records(school_id, id) on delete set null (record_id)
);

drop function public.create_student_behaviour_record(uuid, uuid, uuid, uuid, timestamptz, text, text, text, uuid[]);
create function public.create_student_behaviour_record(
  target_school uuid,
  target_student uuid,
  target_behaviour_type uuid,
  target_action uuid,
  target_occurred_at timestamptz,
  target_location text,
  target_description text,
  target_actions_taken text,
  involved_student_ids uuid[] default '{}'::uuid[],
  target_severity text default 'minor',
  target_context text default '',
  target_student_perspective text default '',
  target_confidential boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  created_record_id uuid;
  participant_ids uuid[] := coalesce(involved_student_ids, '{}'::uuid[]);
begin
  if auth.uid() is null or not public.can_access_student_behaviour(target_school) then
    raise exception 'Your school role cannot record student behaviour.';
  end if;
  if target_severity not in ('minor', 'moderate', 'serious')
    or char_length(coalesce(target_context, '')) > 200
    or char_length(coalesce(target_student_perspective, '')) > 3000 then
    raise exception 'Review the severity, context, and student-perspective fields.';
  end if;
  if cardinality(participant_ids) > 100 then
    raise exception 'A behaviour report cannot include more than 100 additional students.';
  end if;
  if exists (
    select 1 from unnest(participant_ids) as participants(student_id)
    where participants.student_id is null or participants.student_id = target_student
      or not exists (
        select 1 from public.students student
        where student.school_id = target_school and student.id = participants.student_id
          and student.status = 'active' and student.merged_into_student_id is null
      )
  ) then
    raise exception 'Choose only active students from this school as additional participants.';
  end if;
  insert into public.student_behaviour_records (
    school_id, student_id, behaviour_type_id, action_id, reported_by, occurred_at,
    location, context, description, actions_taken, student_perspective, severity, confidential
  ) values (
    target_school, target_student, target_behaviour_type, target_action, auth.uid(),
    target_occurred_at, coalesce(target_location, ''), coalesce(target_context, ''),
    target_description, coalesce(target_actions_taken, ''), coalesce(target_student_perspective, ''),
    target_severity, coalesce(target_confidential, false)
  ) returning id into created_record_id;
  insert into public.student_behaviour_record_participants (school_id, record_id, student_id)
  select target_school, created_record_id, participant_id
  from (select distinct unnest(array_remove(participant_ids, target_student)) as participant_id) participants;
  return created_record_id;
end;
$$;

create or replace function public.list_student_behaviour_family(target_school uuid)
returns table (
  student_id uuid,
  student_number text,
  first_name text,
  last_name text,
  class_name text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_school_member(target_school) then
    raise exception 'An active school membership is required.';
  end if;
  return query
  select student.id, student.student_number, student.first_name, student.last_name,
    coalesce(class.name, '')
  from public.students student
  left join public.school_classes class
    on class.school_id = student.school_id and class.id = student.class_id
  where student.school_id = target_school
    and student.status = 'active'
    and student.merged_into_student_id is null
    and (
      student.profile_id = auth.uid()
      or exists (
        select 1
        from public.parent_students link
        join public.parent_profiles parent on parent.school_id = link.school_id and parent.id = link.parent_id
        where link.school_id = student.school_id and link.student_id = student.id
          and parent.profile_id = auth.uid()
      )
    )
  order by student.last_name, student.first_name;
end;
$$;

create or replace function public.behaviour_email_scheduled_time(target_school uuid, delay_minutes integer)
returns timestamptz
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  zone_name text;
  quiet_start time;
  quiet_end time;
  candidate timestamptz;
  local_candidate timestamp;
  local_date date;
  local_clock time;
begin
  select school.timezone, settings.quiet_hours_start, settings.quiet_hours_end
  into zone_name, quiet_start, quiet_end
  from public.schools school
  join public.student_behaviour_settings settings on settings.school_id = school.id
  where school.id = target_school;
  candidate := timezone('utc', now()) + make_interval(mins => greatest(0, least(delay_minutes, 1440)));
  if zone_name is null or quiet_start = quiet_end then return candidate; end if;
  local_candidate := candidate at time zone zone_name;
  local_date := local_candidate::date;
  local_clock := local_candidate::time;
  if quiet_start > quiet_end then
    if local_clock >= quiet_start then
      return ((local_date + 1 + quiet_end) at time zone zone_name);
    elsif local_clock < quiet_end then
      return ((local_date + quiet_end) at time zone zone_name);
    end if;
  elsif local_clock >= quiet_start and local_clock < quiet_end then
    return ((local_date + quiet_end) at time zone zone_name);
  end if;
  return candidate;
end;
$$;

insert into public.student_behaviour_email_templates (school_id, event_type, subject_template, body_template)
select school.id, events.event_type, events.subject_template, events.body_template
from public.schools school
cross join (values
  ('positive_recognition', 'A positive update from your school', 'A positive recognition is available in your Campus Connect account. Sign in to view it: {secure_link}'),
  ('recognition_award', 'A school recognition is available', 'A school recognition is available in your Campus Connect account. Sign in to view it: {secure_link}'),
  ('improvement_update', 'A positive school update is available', 'A positive school update is available in your Campus Connect account. Sign in to view it: {secure_link}'),
  ('weekly_positive_summary', 'Your weekly school recognition summary', 'Positive recognitions from this week are available in your Campus Connect account. Sign in to review them: {secure_link}'),
  ('library_recognition', 'A library recognition is available', 'A library recognition is available in your Campus Connect account. Sign in to view it: {secure_link}'),
  ('concern_notification', 'A school update is available', 'A school update is available in your Campus Connect account. Sign in to review it and any next steps: {secure_link}'),
  ('meeting_invitation', 'A school meeting invitation', 'A meeting invitation is available in your Campus Connect account. Sign in to review the details and respond: {secure_link}'),
  ('followup_reminder', 'A school follow-up is due', 'A school follow-up is due. Sign in to review the information and next steps: {secure_link}'),
  ('support_plan_review', 'A school support-plan review is due', 'A school support-plan review is due. Sign in to review the goals and next steps: {secure_link}'),
  ('case_resolution', 'A school update is available', 'A school update is available in your Campus Connect account. Sign in to review it: {secure_link}'),
  ('correction_update', 'An update to your school request', 'There is an update to your behaviour-record request. Sign in to review it: {secure_link}'),
  ('staff_escalation', 'A behaviour concern requires staff review', 'A behaviour concern requires authorized staff review. Sign in to the staff workspace: {secure_link}'),
  ('manual_report', 'A secure student report is available', 'A secure student report is available in your Campus Connect account. Sign in to view it: {secure_link}')
) as events(event_type, subject_template, body_template)
on conflict (school_id, event_type) do nothing;

create or replace function public.create_student_behaviour_email_defaults()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.student_behaviour_email_templates (school_id, event_type, subject_template, body_template)
  values
    (new.id, 'positive_recognition', 'A positive update from your school', 'A positive recognition is available in your Campus Connect account. Sign in to view it: {secure_link}'),
    (new.id, 'recognition_award', 'A school recognition is available', 'A school recognition is available in your Campus Connect account. Sign in to view it: {secure_link}'),
    (new.id, 'improvement_update', 'A positive school update is available', 'A positive school update is available in your Campus Connect account. Sign in to view it: {secure_link}'),
    (new.id, 'weekly_positive_summary', 'Your weekly school recognition summary', 'Positive recognitions from this week are available in your Campus Connect account. Sign in to review them: {secure_link}'),
    (new.id, 'library_recognition', 'A library recognition is available', 'A library recognition is available in your Campus Connect account. Sign in to view it: {secure_link}'),
    (new.id, 'concern_notification', 'A school update is available', 'A school update is available in your Campus Connect account. Sign in to review it and any next steps: {secure_link}'),
    (new.id, 'meeting_invitation', 'A school meeting invitation', 'A meeting invitation is available in your Campus Connect account. Sign in to review the details and respond: {secure_link}'),
    (new.id, 'followup_reminder', 'A school follow-up is due', 'A school follow-up is due. Sign in to review the information and next steps: {secure_link}'),
    (new.id, 'support_plan_review', 'A school support-plan review is due', 'A school support-plan review is due. Sign in to review the goals and next steps: {secure_link}'),
    (new.id, 'case_resolution', 'A school update is available', 'A school update is available in your Campus Connect account. Sign in to review it: {secure_link}'),
    (new.id, 'correction_update', 'An update to your school request', 'There is an update to your behaviour-record request. Sign in to review it: {secure_link}'),
    (new.id, 'staff_escalation', 'A behaviour concern requires staff review', 'A behaviour concern requires authorized staff review. Sign in to the staff workspace: {secure_link}'),
    (new.id, 'manual_report', 'A secure student report is available', 'A secure student report is available in your Campus Connect account. Sign in to view it: {secure_link}');
  return new;
end;
$$;
create trigger create_student_behaviour_email_defaults_after_school_insert
  after insert on public.schools
  for each row execute function public.create_student_behaviour_email_defaults();

create or replace function public.enqueue_student_behaviour_email(
  target_school uuid,
  target_profile uuid,
  target_event text,
  target_record uuid,
  target_source_type text,
  target_source uuid,
  target_path text,
  target_key text,
  actor uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  template_row public.student_behaviour_email_templates%rowtype;
  delivery_id uuid;
  require_approval boolean;
begin
  select * into template_row
  from public.student_behaviour_email_templates
  where school_id = target_school and event_type = target_event and enabled;
  if not found or target_profile is null then return null; end if;
  require_approval := template_row.require_approval
    or target_event in ('concern_notification', 'staff_escalation');
  if target_record is not null and exists (
    select 1 from public.student_behaviour_records report
    where report.school_id = target_school and report.id = target_record
      and (report.confidential or report.severity = 'serious')
  ) then
    require_approval := true;
  end if;
  if target_event not in ('concern_notification', 'meeting_invitation', 'support_plan_review', 'case_resolution', 'correction_update', 'staff_escalation')
    and exists (
    select 1 from public.student_behaviour_email_preferences preference
    where preference.school_id = target_school
      and preference.profile_id = target_profile
      and preference.event_type = target_event
      and not preference.email_enabled
  ) then return null; end if;
  if target_event in ('concern_notification', 'staff_escalation') then
    template_row.require_approval := true;
  end if;

  insert into public.student_behaviour_email_deliveries (
    school_id, recipient_profile_id, event_type, record_id, source_type, source_id,
    target_path, idempotency_key, status, scheduled_at, requested_by
  ) values (
    target_school, target_profile, target_event, target_record, target_source_type,
    target_source, target_path, target_key,
    case when require_approval then 'awaiting_approval' else 'queued' end,
    public.behaviour_email_scheduled_time(target_school, template_row.delay_minutes), actor
  )
  on conflict (idempotency_key) do nothing
  returning id into delivery_id;
  return delivery_id;
end;
$$;

create or replace function public.approve_student_behaviour_email(target_delivery uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  delivery_school uuid;
begin
  if auth.uid() is null then raise exception 'Authentication is required.'; end if;
  select school_id into delivery_school
  from public.student_behaviour_email_deliveries where id = target_delivery;
  if delivery_school is null
    or not public.has_school_role(delivery_school, array['school_admin', 'academic_coordinator', 'safeguarding_officer']::public.app_role[]) then
    raise exception 'You are not authorized to approve this behaviour email.';
  end if;
  update public.student_behaviour_email_deliveries
  set status = 'queued', approved_by = auth.uid(), approved_at = timezone('utc', now()),
      scheduled_at = greatest(scheduled_at, timezone('utc', now()))
  where id = target_delivery and status = 'awaiting_approval';
  if not found then raise exception 'This email is no longer awaiting approval.'; end if;
  insert into public.audit_logs (school_id, actor_id, action, target_table, target_id, metadata)
  values (delivery_school, auth.uid(), 'behaviour_email_approved', 'student_behaviour_email_deliveries',
    target_delivery, jsonb_build_object('event_type', (select event_type from public.student_behaviour_email_deliveries where id = target_delivery)));
end;
$$;

create or replace function public.queue_due_student_behaviour_emails_job()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  queued_count integer;
begin
  perform public.queue_due_student_behaviour_emails();
  select count(*) into queued_count
  from public.student_behaviour_email_deliveries
  where status = 'queued' and scheduled_at <= timezone('utc', now());
  return queued_count;
end;
$$;

create extension if not exists pg_cron;
select cron.unschedule(jobid)
from cron.job
where jobname = 'campus-connect-behaviour-email-reminders';
select cron.schedule(
  'campus-connect-behaviour-email-reminders',
  '*/15 * * * *',
  'select public.queue_due_student_behaviour_emails_job()'
);

create or replace function public.queue_student_behaviour_record_emails()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  event_name text;
  parent_row record;
begin
  if new.status = 'published' and old.status is distinct from new.status and new.guardian_visible then
    event_name := case
      when new.category = 'positive' and lower(new.location) like '%librar%' then 'library_recognition'
      when new.category = 'positive' then 'positive_recognition'
      else 'concern_notification'
    end;
    for parent_row in
      select distinct parent.profile_id
      from public.parent_students link
      join public.parent_profiles parent
        on parent.school_id = link.school_id and parent.id = link.parent_id
      join public.school_memberships membership
        on membership.school_id = parent.school_id and membership.profile_id = parent.profile_id
      where link.school_id = new.school_id
        and link.student_id = new.student_id
        and parent.profile_id is not null
        and membership.role::text = 'parent'
    loop
      perform public.enqueue_student_behaviour_email(
        new.school_id, parent_row.profile_id, event_name, new.id, 'record', new.id,
        '/behaviour/report/' || new.id::text,
        concat(new.id::text, ':', event_name, ':', parent_row.profile_id::text),
        auth.uid()
      );
    end loop;
  elsif new.status = 'resolved' and old.status is distinct from new.status and new.guardian_visible then
    for parent_row in
      select distinct parent.profile_id
      from public.parent_students link
      join public.parent_profiles parent on parent.school_id = link.school_id and parent.id = link.parent_id
      join public.school_memberships membership on membership.school_id = parent.school_id and membership.profile_id = parent.profile_id
      where link.school_id = new.school_id and link.student_id = new.student_id
        and parent.profile_id is not null and membership.role::text = 'parent'
    loop
      perform public.enqueue_student_behaviour_email(
        new.school_id, parent_row.profile_id, 'case_resolution', new.id, 'record', new.id,
        '/behaviour/report/' || new.id::text,
        concat(new.id::text, ':case_resolution:', parent_row.profile_id::text),
        auth.uid()
      );
    end loop;
  end if;
  return new;
end;
$$;

create trigger queue_student_behaviour_record_emails_after_status
  after update of status on public.student_behaviour_records
  for each row execute function public.queue_student_behaviour_record_emails();

create or replace function public.queue_student_behaviour_meeting_email()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  parent_row record;
begin
  if not new.guardian_visible then return new; end if;
  for parent_row in
    select distinct parent.profile_id
    from public.parent_students link
    join public.parent_profiles parent on parent.school_id = link.school_id and parent.id = link.parent_id
    join public.school_memberships membership on membership.school_id = parent.school_id and membership.profile_id = parent.profile_id
    where link.school_id = new.school_id and link.student_id = new.student_id
      and parent.profile_id is not null and membership.role::text = 'parent'
  loop
    insert into public.student_behaviour_meeting_responses (school_id, meeting_id, profile_id)
    values (new.school_id, new.id, parent_row.profile_id)
    on conflict (meeting_id, profile_id) do nothing;
    perform public.enqueue_student_behaviour_email(
      new.school_id, parent_row.profile_id, 'meeting_invitation', new.record_id, 'meeting', new.id,
      '/behaviour/my',
      concat(new.id::text, ':meeting_invitation:', parent_row.profile_id::text),
      auth.uid()
    );
  end loop;
  insert into public.student_behaviour_meeting_responses (school_id, meeting_id, profile_id)
  select new.school_id, new.id, student.profile_id
  from public.students student
  join public.school_memberships membership
    on membership.school_id = student.school_id and membership.profile_id = student.profile_id
  where student.school_id = new.school_id
    and student.id = new.student_id
    and student.profile_id is not null
    and membership.role::text = 'student'
  on conflict (meeting_id, profile_id) do nothing;
  return new;
end;
$$;
create trigger queue_student_behaviour_meeting_email_after_insert
  after insert on public.student_behaviour_meetings
  for each row execute function public.queue_student_behaviour_meeting_email();

create or replace function public.queue_student_behaviour_award_email()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  parent_row record;
  event_name text;
begin
  if new.status <> 'approved' or old.status = 'approved' or not new.guardian_visible then return new; end if;
  event_name := case
    when exists (
      select 1 from public.student_behaviour_records report
      where report.school_id = new.school_id and report.id = new.record_id
        and lower(report.location) like '%librar%'
    ) then 'library_recognition'
    else 'recognition_award'
  end;
  for parent_row in
    select distinct parent.profile_id
    from public.parent_students link
    join public.parent_profiles parent on parent.school_id = link.school_id and parent.id = link.parent_id
    join public.school_memberships membership on membership.school_id = parent.school_id and membership.profile_id = parent.profile_id
    where link.school_id = new.school_id and link.student_id = new.student_id
      and parent.profile_id is not null and membership.role::text = 'parent'
  loop
    perform public.enqueue_student_behaviour_email(
      new.school_id, parent_row.profile_id, event_name, new.record_id, 'award', new.id,
      '/behaviour/my',
      concat(new.id::text, ':', event_name, ':', parent_row.profile_id::text),
      auth.uid()
    );
  end loop;
  return new;
end;
$$;
create trigger queue_student_behaviour_award_email_after_update
  after update of status on public.student_behaviour_awards
  for each row execute function public.queue_student_behaviour_award_email();

create or replace function public.queue_student_behaviour_correction_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status is distinct from old.status then
    perform public.enqueue_student_behaviour_email(
      new.school_id, new.requester_profile_id, 'correction_update', new.record_id, 'correction', new.id,
      '/behaviour/my',
      concat(new.id::text, ':correction_update:', new.requester_profile_id::text, ':', new.status),
      auth.uid()
    );
  end if;
  if due_row.guardian_visible then
    perform public.enqueue_student_behaviour_email(
      due_row.school_id, parent.profile_id, 'followup_reminder', due_row.record_id,
      'followup', due_row.id, '/behaviour/my',
      concat(due_row.id::text, ':followup_reminder:', parent.profile_id::text, ':', due_row.due_at::text),
      null
    )
    from public.student_behaviour_records report
    join public.parent_students link on link.school_id = report.school_id and link.student_id = report.student_id
    join public.parent_profiles parent on parent.school_id = link.school_id and parent.id = link.parent_id
    join public.school_memberships membership on membership.school_id = parent.school_id and membership.profile_id = parent.profile_id
    where report.school_id = due_row.school_id and report.id = due_row.record_id
      and parent.profile_id is not null and membership.role::text = 'parent';
  end if;
  return new;
end;
$$;
create trigger queue_student_behaviour_correction_email_after_update
  after update of status on public.student_behaviour_correction_requests
  for each row execute function public.queue_student_behaviour_correction_update();

create or replace function public.create_student_behaviour_escalation(
  target_record uuid,
  target_reason text,
  target_assignee uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  record_row public.student_behaviour_records%rowtype;
  escalation_id uuid;
  staff_row record;
begin
  if auth.uid() is null or char_length(trim(coalesce(target_reason, ''))) not between 5 and 1500 then
    raise exception 'Enter an escalation reason between 5 and 1,500 characters.';
  end if;
  select * into record_row from public.student_behaviour_records where id = target_record;
  if not found or not public.can_access_student_behaviour(record_row.school_id) then
    raise exception 'You are not authorized to escalate this record.';
  end if;
  if target_assignee is not null and not exists (
    select 1 from public.school_memberships membership
    where membership.school_id = record_row.school_id
      and membership.profile_id = target_assignee
      and membership.role::text in ('school_admin', 'academic_coordinator', 'safeguarding_officer')
  ) then
    raise exception 'Choose an authorized safeguarding or school lead.';
  end if;
  insert into public.student_behaviour_escalations (
    school_id, record_id, escalated_by, assigned_to, reason
  ) values (record_row.school_id, target_record, auth.uid(), target_assignee, trim(target_reason))
  returning id into escalation_id;
  for staff_row in
    select membership.profile_id
    from public.school_memberships membership
    where membership.school_id = record_row.school_id
      and membership.role::text in ('school_admin', 'academic_coordinator', 'safeguarding_officer')
      and (target_assignee is null or membership.profile_id = target_assignee)
  loop
    insert into public.notifications (school_id, profile_id, title, body, target_path)
    values (record_row.school_id, staff_row.profile_id, 'Behaviour concern requires review',
      'An authorized staff member submitted a confidential behaviour escalation.', '/behaviour');
    perform public.enqueue_student_behaviour_email(
      record_row.school_id, staff_row.profile_id, 'staff_escalation', target_record, 'escalation', escalation_id,
      '/behaviour',
      concat(escalation_id::text, ':staff_escalation:', staff_row.profile_id::text),
      auth.uid()
    );
  end loop;
  return escalation_id;
end;
$$;

create or replace function public.create_student_behaviour_support_plan(
  target_school uuid,
  target_student uuid,
  target_record uuid,
  target_title text,
  target_goals text,
  target_staff_note text,
  target_review_due timestamptz,
  target_guardian_visible boolean
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  plan_id uuid;
begin
  if auth.uid() is null or not public.has_school_role(target_school, array['school_admin', 'academic_coordinator', 'safeguarding_officer']::public.app_role[]) then
    raise exception 'You are not authorized to create a support plan.';
  end if;
  if char_length(trim(coalesce(target_title, ''))) not between 2 and 120
    or char_length(coalesce(target_goals, '')) > 3000
    or char_length(coalesce(target_staff_note, '')) > 3000 then
    raise exception 'Review the support-plan title and notes.';
  end if;
  if not exists (
    select 1 from public.students student
    where student.school_id = target_school and student.id = target_student
      and student.status = 'active' and student.merged_into_student_id is null
  ) then
    raise exception 'Choose an active student from this school.';
  end if;
  if target_record is not null and not exists (
    select 1 from public.student_behaviour_records report
    where report.school_id = target_school and report.id = target_record and report.student_id = target_student
  ) then
    raise exception 'The selected behaviour record does not belong to this student.';
  end if;
  insert into public.student_behaviour_support_plans (
    school_id, student_id, record_id, title, guardian_goals, review_due_at,
    guardian_visible, created_by
  ) values (
    target_school, target_student, target_record, trim(target_title), coalesce(target_goals, ''),
    target_review_due, coalesce(target_guardian_visible, false), auth.uid()
  ) returning id into plan_id;
  if nullif(trim(target_staff_note), '') is not null then
    insert into public.student_behaviour_support_plan_staff_notes (school_id, plan_id, note, created_by)
    values (target_school, plan_id, trim(target_staff_note), auth.uid());
  end if;
  insert into public.audit_logs (school_id, actor_id, action, target_table, target_id, metadata)
  values (target_school, auth.uid(), 'behaviour_support_plan_created', 'student_behaviour_support_plans',
    plan_id, jsonb_build_object('guardian_visible', coalesce(target_guardian_visible, false)));
  return plan_id;
end;
$$;

create or replace function public.queue_due_student_behaviour_emails()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  due_row record;
  affected integer := 0;
  week_key text;
begin
  for due_row in
    select followup.*
    from public.student_behaviour_followups followup
    where followup.status in ('open', 'in_progress')
      and followup.due_at is not null
      and followup.due_at <= now()
      and followup.due_at > now() - interval '1 day'
  loop
    if due_row.assigned_to is not null then
      perform public.enqueue_student_behaviour_email(
        due_row.school_id, due_row.assigned_to, 'followup_reminder', due_row.record_id,
        'followup', due_row.id, '/behaviour',
        concat(due_row.id::text, ':followup_reminder:', due_row.assigned_to::text, ':', due_row.due_at::text),
        null
      );
    end if;
  end loop;
  for due_row in
    select plan.*
    from public.student_behaviour_support_plans plan
    where plan.status = 'active' and plan.review_due_at is not null
      and plan.review_due_at <= now() and plan.review_due_at > now() - interval '1 day'
  loop
    perform public.enqueue_student_behaviour_email(
      due_row.school_id, due_row.created_by, 'support_plan_review', null, 'support_plan', due_row.id,
      '/behaviour', concat(due_row.id::text, ':support_plan_review:staff:', due_row.review_due_at::text), null
    );
    if due_row.guardian_visible then
      perform public.enqueue_student_behaviour_email(
        due_row.school_id, parent.profile_id, 'support_plan_review', null, 'support_plan', due_row.id,
        '/behaviour/my', concat(due_row.id::text, ':support_plan_review:', parent.profile_id::text, ':', due_row.review_due_at::text), null
      )
      from public.parent_students link
      join public.parent_profiles parent on parent.school_id = link.school_id and parent.id = link.parent_id
      join public.school_memberships membership on membership.school_id = parent.school_id and membership.profile_id = parent.profile_id
      where link.school_id = due_row.school_id and link.student_id = due_row.student_id
        and parent.profile_id is not null and membership.role::text = 'parent';
    end if;
  end loop;

  for due_row in
    select school.id as school_id, school.timezone
    from public.schools school
    where extract(isodow from now() at time zone school.timezone) = 1
  loop
    week_key := to_char((now() at time zone due_row.timezone)::date, 'IYYY-IW');
    perform public.enqueue_student_behaviour_email(
      due_row.school_id, parent.profile_id, 'weekly_positive_summary', null, 'weekly_summary', null,
      '/behaviour/my',
      concat(due_row.school_id::text, ':weekly_positive_summary:', parent.profile_id::text, ':', week_key),
      null
    )
    from (
      select distinct parent.profile_id
      from public.student_behaviour_records record
      join public.parent_students link on link.school_id = record.school_id and link.student_id = record.student_id
      join public.parent_profiles parent on parent.school_id = link.school_id and parent.id = link.parent_id
      join public.school_memberships membership on membership.school_id = parent.school_id and membership.profile_id = parent.profile_id
      where record.school_id = due_row.school_id and record.category = 'positive'
        and record.status = 'published' and record.guardian_visible
        and record.created_at >= now() - interval '7 days'
        and membership.role::text = 'parent'
    ) parent;
  end loop;
  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function public.claim_student_behaviour_email(target_delivery uuid)
returns setof public.student_behaviour_email_deliveries
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.student_behaviour_email_deliveries
  set status = 'sending', attempt_count = attempt_count + 1,
      attempted_at = timezone('utc', now()), last_error = ''
  where id = target_delivery and status = 'queued'
    and scheduled_at <= timezone('utc', now()) and attempt_count < 10
  returning *;
$$;

create or replace function public.review_student_behaviour_record(
  target_record uuid,
  target_decision text,
  target_note text default '',
  target_guardian_visible boolean default true
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  record_school uuid;
begin
  if auth.uid() is null or target_decision not in ('under_review', 'published', 'returned', 'resolved', 'closed') then
    raise exception 'Choose a valid behaviour review decision.';
  end if;
  select school_id into record_school
  from public.student_behaviour_records where id = target_record;
  if record_school is null
    or not public.has_school_role(record_school, array['school_admin', 'academic_coordinator', 'safeguarding_officer']::public.app_role[]) then
    raise exception 'You are not authorized to review this behaviour record.';
  end if;
  if char_length(coalesce(target_note, '')) > 2000 then
    raise exception 'The review note is too long.';
  end if;
  update public.student_behaviour_records
  set status = target_decision,
      guardian_visible = case
        when target_decision in ('published', 'resolved') then target_guardian_visible and not (
          select report.confidential from public.student_behaviour_records report where report.id = target_record
        )
        when target_decision = 'closed' then guardian_visible and not (
          select report.confidential from public.student_behaviour_records report where report.id = target_record
        )
        else false
      end,
      reviewed_by = auth.uid(),
      reviewed_at = timezone('utc', now()),
      review_note = coalesce(target_note, ''),
      resolved_at = case when target_decision = 'resolved' then timezone('utc', now()) else resolved_at end
  where id = target_record;
  insert into public.audit_logs (school_id, actor_id, action, target_table, target_id, metadata)
  values (record_school, auth.uid(), 'behaviour_record_reviewed', 'student_behaviour_records', target_record,
    jsonb_build_object('decision', target_decision, 'guardian_visible',
      (select report.guardian_visible from public.student_behaviour_records report where report.id = target_record)));
end;
$$;

create or replace function public.create_student_behaviour_correction_request(
  target_record uuid,
  target_text text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  record_row public.student_behaviour_records%rowtype;
  request_id uuid;
begin
  if auth.uid() is null or char_length(trim(coalesce(target_text, ''))) not between 5 and 2000 then
    raise exception 'Enter a correction request between 5 and 2,000 characters.';
  end if;
  select * into record_row
  from public.student_behaviour_records
  where id = target_record and status in ('published', 'resolved') and guardian_visible;
  if not found or not (
    public.is_parent_of_student(record_row.school_id, record_row.student_id)
    or exists (select 1 from public.students s where s.school_id = record_row.school_id and s.id = record_row.student_id and s.profile_id = auth.uid())
  ) then
    raise exception 'You cannot request a correction for this report.';
  end if;
  insert into public.student_behaviour_correction_requests (
    school_id, record_id, requester_profile_id, request_text
  ) values (record_row.school_id, target_record, auth.uid(), trim(target_text))
  returning id into request_id;
  insert into public.notifications (school_id, profile_id, title, body, target_path)
  select record_row.school_id, membership.profile_id, 'Behaviour correction request received',
    'A guardian or student requested a review of a published behaviour record.', '/behaviour'
  from public.school_memberships membership
  where membership.school_id = record_row.school_id
    and membership.role::text in ('school_admin', 'academic_coordinator', 'safeguarding_officer');
  return request_id;
end;
$$;

create or replace function public.review_student_behaviour_correction(
  target_request uuid,
  target_status text,
  target_note text default ''
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  request_school uuid;
begin
  if auth.uid() is null or target_status not in ('accepted', 'declined', 'clarification_requested') then
    raise exception 'Choose a valid correction-request decision.';
  end if;
  select school_id into request_school
  from public.student_behaviour_correction_requests where id = target_request;
  if request_school is null
    or not public.has_school_role(request_school, array['school_admin', 'academic_coordinator', 'safeguarding_officer']::public.app_role[]) then
    raise exception 'You are not authorized to review this correction request.';
  end if;
  update public.student_behaviour_correction_requests
  set status = target_status, resolution_note = left(coalesce(target_note, ''), 2000),
      reviewed_by = auth.uid(), reviewed_at = timezone('utc', now()), updated_at = timezone('utc', now())
  where id = target_request;
  insert into public.audit_logs (school_id, actor_id, action, target_table, target_id, metadata)
  values (request_school, auth.uid(), 'behaviour_correction_reviewed', 'student_behaviour_correction_requests',
    target_request, jsonb_build_object('decision', target_status));
end;
$$;

create or replace function public.review_student_behaviour_award(
  target_award uuid,
  target_status text,
  target_guardian_visible boolean default true
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  award_school uuid;
begin
  if auth.uid() is null or target_status not in ('approved', 'rejected') then
    raise exception 'Choose a valid recognition decision.';
  end if;
  select school_id into award_school from public.student_behaviour_awards where id = target_award;
  if award_school is null
    or not public.has_school_role(award_school, array['school_admin', 'academic_coordinator']::public.app_role[]) then
    raise exception 'You are not authorized to review this recognition.';
  end if;
  update public.student_behaviour_awards
  set status = target_status, guardian_visible = target_status = 'approved' and target_guardian_visible,
      reviewed_by = auth.uid(), reviewed_at = timezone('utc', now())
  where id = target_award;
  insert into public.audit_logs (school_id, actor_id, action, target_table, target_id, metadata)
  values (award_school, auth.uid(), 'behaviour_award_reviewed', 'student_behaviour_awards', target_award,
    jsonb_build_object('decision', target_status, 'guardian_visible', target_status = 'approved' and target_guardian_visible));
end;
$$;

alter table public.student_behaviour_email_templates enable row level security;
alter table public.student_behaviour_email_preferences enable row level security;
alter table public.student_behaviour_email_deliveries enable row level security;
alter table public.student_behaviour_followups enable row level security;
alter table public.student_behaviour_support_plans enable row level security;
alter table public.student_behaviour_meetings enable row level security;
alter table public.student_behaviour_meeting_responses enable row level security;
alter table public.student_behaviour_correction_requests enable row level security;
alter table public.student_behaviour_escalations enable row level security;
alter table public.student_behaviour_awards enable row level security;

drop policy if exists "Behaviour staff and linked parents read reports" on public.student_behaviour_records;
create policy "Behaviour staff and approved family read reports"
  on public.student_behaviour_records for select to authenticated
  using (
    (public.can_access_student_behaviour(school_id) and (not confidential or public.has_school_role(school_id, array['school_admin', 'academic_coordinator', 'safeguarding_officer']::public.app_role[])))
    or (
      status in ('published', 'resolved', 'closed') and guardian_visible and not confidential
      and (public.is_parent_of_student(student_behaviour_records.school_id, student_behaviour_records.student_id)
        or exists (
          select 1 from public.students student
          where student.school_id = student_behaviour_records.school_id
            and student.id = student_behaviour_records.student_id and student.profile_id = auth.uid()
        ))
    )
  );
drop policy if exists "Authors and admins update reports" on public.student_behaviour_records;
revoke update on public.student_behaviour_records from authenticated;
grant update (location, context, description, actions_taken, student_perspective) on public.student_behaviour_records to authenticated;
drop policy if exists "Behaviour staff manage report participants" on public.student_behaviour_record_participants;
create policy "Authorized staff manage report participants"
  on public.student_behaviour_record_participants for all to authenticated
  using (
    public.can_access_student_behaviour(school_id)
    and exists (
      select 1 from public.student_behaviour_records report
      where report.school_id = student_behaviour_record_participants.school_id
        and report.id = student_behaviour_record_participants.record_id
        and (not report.confidential or public.has_school_role(report.school_id, array['school_admin', 'academic_coordinator', 'safeguarding_officer']::public.app_role[]))
    )
  )
  with check (
    public.can_access_student_behaviour(school_id)
    and exists (
      select 1 from public.student_behaviour_records report
      where report.school_id = student_behaviour_record_participants.school_id
        and report.id = student_behaviour_record_participants.record_id
        and (not report.confidential or public.has_school_role(report.school_id, array['school_admin', 'academic_coordinator', 'safeguarding_officer']::public.app_role[]))
    )
  );

create policy "Behaviour staff read email templates"
  on public.student_behaviour_email_templates for select to authenticated
  using (public.can_access_student_behaviour(school_id));
create policy "School admins manage email templates"
  on public.student_behaviour_email_templates for all to authenticated
  using (public.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy "Users manage own behaviour email preferences"
  on public.student_behaviour_email_preferences for all to authenticated
  using (profile_id = auth.uid() and public.is_school_member(school_id))
  with check (profile_id = auth.uid() and public.is_school_member(school_id));
create policy "Staff and recipients read behaviour email delivery status"
  on public.student_behaviour_email_deliveries for select to authenticated
  using (
    (public.can_access_student_behaviour(school_id) and public.has_school_role(school_id, array['school_admin', 'academic_coordinator', 'safeguarding_officer']::public.app_role[]))
    or recipient_profile_id = auth.uid()
  );
create policy "Staff read behaviour follow-ups"
  on public.student_behaviour_followups for select to authenticated
  using (public.can_access_student_behaviour(school_id));
create policy "Authorized staff create behaviour follow-ups"
  on public.student_behaviour_followups for insert to authenticated
  with check (public.can_access_student_behaviour(school_id) and created_by = auth.uid());
create policy "Assigned staff update behaviour follow-ups"
  on public.student_behaviour_followups for update to authenticated
  using (public.has_school_role(school_id, array['school_admin', 'academic_coordinator', 'safeguarding_officer']::public.app_role[]) or assigned_to = auth.uid())
  with check (public.has_school_role(school_id, array['school_admin', 'academic_coordinator', 'safeguarding_officer']::public.app_role[]) or assigned_to = auth.uid());
create policy "Admins delete behaviour follow-ups"
  on public.student_behaviour_followups for delete to authenticated
  using (public.has_school_role(school_id, array['school_admin', 'academic_coordinator', 'safeguarding_officer']::public.app_role[]));
create policy "Staff and linked guardians read support plans"
  on public.student_behaviour_support_plans for select to authenticated
  using (
    public.can_access_student_behaviour(school_id)
    or (guardian_visible and status = 'active' and public.is_parent_of_student(school_id, student_id))
    or (guardian_visible and status = 'active' and exists (
      select 1 from public.students student
      where student.school_id = student_behaviour_support_plans.school_id
        and student.id = student_behaviour_support_plans.student_id and student.profile_id = auth.uid()
    ))
  );
create policy "Staff manage support plans"
  on public.student_behaviour_support_plans for all to authenticated
  using (public.has_school_role(school_id, array['school_admin', 'academic_coordinator', 'safeguarding_officer']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin', 'academic_coordinator', 'safeguarding_officer']::public.app_role[]));
alter table public.student_behaviour_support_plan_staff_notes enable row level security;
create policy "Restricted staff read support-plan notes"
  on public.student_behaviour_support_plan_staff_notes for select to authenticated
  using (public.has_school_role(school_id, array['school_admin', 'academic_coordinator', 'safeguarding_officer']::public.app_role[]));
create policy "Restricted staff create support-plan notes"
  on public.student_behaviour_support_plan_staff_notes for insert to authenticated
  with check (
    created_by = auth.uid()
    and public.has_school_role(school_id, array['school_admin', 'academic_coordinator', 'safeguarding_officer']::public.app_role[])
  );
create policy "Staff and linked parents read behaviour meetings"
  on public.student_behaviour_meetings for select to authenticated
  using (
    public.can_access_student_behaviour(school_id)
    or (guardian_visible and public.is_parent_of_student(school_id, student_id))
    or (guardian_visible and exists (select 1 from public.students student where student.school_id = student_behaviour_meetings.school_id and student.id = student_behaviour_meetings.student_id and student.profile_id = auth.uid()))
  );
create policy "Authorized staff manage behaviour meetings"
  on public.student_behaviour_meetings for all to authenticated
  using (public.can_access_student_behaviour(school_id))
  with check (public.can_access_student_behaviour(school_id) and created_by = auth.uid());
create policy "Meeting participants manage own responses"
  on public.student_behaviour_meeting_responses for all to authenticated
  using (
    public.has_school_role(school_id, array['school_admin', 'academic_coordinator', 'safeguarding_officer']::public.app_role[])
    or (profile_id = auth.uid() and exists (
      select 1 from public.student_behaviour_meetings meeting
      where meeting.school_id = student_behaviour_meeting_responses.school_id
        and meeting.id = student_behaviour_meeting_responses.meeting_id
        and (public.is_parent_of_student(meeting.school_id, meeting.student_id)
          or exists (select 1 from public.students student where student.school_id = meeting.school_id and student.id = meeting.student_id and student.profile_id = auth.uid()))
    ))
  )
  with check (
    public.has_school_role(school_id, array['school_admin', 'academic_coordinator', 'safeguarding_officer']::public.app_role[])
    or (profile_id = auth.uid() and exists (
      select 1 from public.student_behaviour_meetings meeting
      where meeting.school_id = student_behaviour_meeting_responses.school_id
        and meeting.id = student_behaviour_meeting_responses.meeting_id
        and (public.is_parent_of_student(meeting.school_id, meeting.student_id)
          or exists (select 1 from public.students student where student.school_id = meeting.school_id and student.id = meeting.student_id and student.profile_id = auth.uid()))
    ))
  );
create policy "Requester and staff read correction requests"
  on public.student_behaviour_correction_requests for select to authenticated
  using (requester_profile_id = auth.uid() or public.has_school_role(school_id, array['school_admin', 'academic_coordinator', 'safeguarding_officer']::public.app_role[]));
create policy "Requesters create correction requests"
  on public.student_behaviour_correction_requests for insert to authenticated
  with check (
    requester_profile_id = auth.uid()
    and public.is_school_member(school_id)
    and exists (
      select 1 from public.student_behaviour_records report
      where report.school_id = student_behaviour_correction_requests.school_id
        and report.id = student_behaviour_correction_requests.record_id
        and report.status in ('published', 'resolved') and report.guardian_visible
        and (public.is_parent_of_student(report.school_id, report.student_id)
          or exists (select 1 from public.students student where student.school_id = report.school_id and student.id = report.student_id and student.profile_id = auth.uid()))
    )
  );
create policy "Authorized staff read and manage escalations"
  on public.student_behaviour_escalations for all to authenticated
  using (public.has_school_role(school_id, array['school_admin', 'academic_coordinator', 'safeguarding_officer']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin', 'academic_coordinator', 'safeguarding_officer']::public.app_role[]));
create policy "Staff and guardians read approved awards"
  on public.student_behaviour_awards for select to authenticated
  using (
    public.can_access_student_behaviour(school_id)
    or (status = 'approved' and guardian_visible and public.is_parent_of_student(school_id, student_id))
    or (status = 'approved' and guardian_visible and exists (
      select 1 from public.students student
      where student.school_id = student_behaviour_awards.school_id
        and student.id = student_behaviour_awards.student_id and student.profile_id = auth.uid()
    ))
  );
create policy "School admins manage behaviour awards"
  on public.student_behaviour_awards for select to authenticated
  using (public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[]))
;
create policy "Staff nominate behaviour awards"
  on public.student_behaviour_awards for insert to authenticated
  with check (
    created_by = auth.uid() and status = 'pending' and not guardian_visible
    and public.can_access_student_behaviour(school_id)
  );
create policy "Admins update behaviour awards"
  on public.student_behaviour_awards for update to authenticated
  using (public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[]));

grant select, insert, update, delete on public.student_behaviour_email_templates to authenticated;
grant select, insert, update, delete on public.student_behaviour_email_preferences to authenticated;
grant select on public.student_behaviour_email_deliveries to authenticated;
grant select, insert, update on public.student_behaviour_followups to authenticated;
grant select, insert, update on public.student_behaviour_support_plans to authenticated;
grant select, insert on public.student_behaviour_support_plan_staff_notes to authenticated;
grant select, insert, update on public.student_behaviour_meetings to authenticated;
grant select, insert, update on public.student_behaviour_meeting_responses to authenticated;
grant select, insert, update on public.student_behaviour_correction_requests to authenticated;
grant select, insert, update on public.student_behaviour_escalations to authenticated;
grant select, insert on public.student_behaviour_awards to authenticated;
grant select on public.student_behaviour_meeting_responses to authenticated;

revoke all on function public.enqueue_student_behaviour_email(uuid, uuid, text, uuid, text, uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.queue_student_behaviour_record_emails() from public, anon, authenticated;
revoke all on function public.review_student_behaviour_record(uuid, text, text, boolean) from public, anon;
revoke all on function public.create_student_behaviour_correction_request(uuid, text) from public, anon;
revoke all on function public.review_student_behaviour_correction(uuid, text, text) from public, anon;
revoke all on function public.approve_student_behaviour_email(uuid) from public, anon;
revoke all on function public.queue_due_student_behaviour_emails() from public, anon, authenticated;
revoke all on function public.queue_due_student_behaviour_emails_job() from public, anon, authenticated;
revoke all on function public.claim_student_behaviour_email(uuid) from public, anon, authenticated;
revoke all on function public.behaviour_email_scheduled_time(uuid, integer) from public, anon, authenticated;
revoke all on function public.create_student_behaviour_escalation(uuid, text, uuid) from public, anon;
revoke all on function public.review_student_behaviour_award(uuid, text, boolean) from public, anon;
revoke all on function public.create_student_behaviour_support_plan(uuid, uuid, uuid, text, text, text, timestamptz, boolean) from public, anon;
revoke all on function public.list_student_behaviour_family(uuid) from public, anon;
grant execute on function public.review_student_behaviour_record(uuid, text, text, boolean) to authenticated;
grant execute on function public.create_student_behaviour_correction_request(uuid, text) to authenticated;
grant execute on function public.review_student_behaviour_correction(uuid, text, text) to authenticated;
grant execute on function public.create_student_behaviour_escalation(uuid, text, uuid) to authenticated;
grant execute on function public.approve_student_behaviour_email(uuid) to authenticated;
grant execute on function public.review_student_behaviour_award(uuid, text, boolean) to authenticated;
grant execute on function public.create_student_behaviour_support_plan(uuid, uuid, uuid, text, text, text, timestamptz, boolean) to authenticated;
grant execute on function public.list_student_behaviour_family(uuid) to authenticated;
revoke all on function public.create_student_behaviour_record(uuid, uuid, uuid, uuid, timestamptz, text, text, text, uuid[], text, text, text, boolean) from public, anon;
grant execute on function public.create_student_behaviour_record(uuid, uuid, uuid, uuid, timestamptz, text, text, text, uuid[], text, text, text, boolean) to authenticated;
grant execute on function public.claim_student_behaviour_email(uuid) to service_role;
grant execute on function public.queue_due_student_behaviour_emails_job() to service_role;
grant execute on function public.enqueue_student_behaviour_email(uuid, uuid, text, uuid, text, uuid, text, text, uuid) to service_role;
revoke all on function public.create_student_behaviour_email_defaults() from public, anon, authenticated;
revoke all on function public.behaviour_email_scheduled_time(uuid, integer) from public, anon, authenticated;
grant select, update on public.student_behaviour_email_deliveries to service_role;
grant select on public.student_behaviour_email_templates, public.student_behaviour_email_preferences,
  public.student_behaviour_records, public.student_behaviour_meetings,
  public.student_behaviour_awards, public.student_behaviour_followups,
  public.student_behaviour_support_plans to service_role;

notify pgrst, 'reload schema';
