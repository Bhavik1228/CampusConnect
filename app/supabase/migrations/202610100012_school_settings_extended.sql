-- Extended school settings for branding, grading, academic policies, and module configuration
-- Run after 202610090001_initial_campus_connect.sql and 202610100005_attendance_core.sql

-- School branding and identity
alter table public.schools
  add column if not exists logo_path text,
  add column if not exists primary_color text check (primary_color ~ '^#[0-9a-fA-F]{6}$'),
  add column if not exists secondary_color text check (secondary_color ~ '^#[0-9a-fA-F]{6}$'),
  add column if not exists motto text check (char_length(trim(motto)) <= 200),
  add column if not exists established_year smallint check (established_year between 1000 and 2100),
  add column if not exists school_type text check (school_type in ('primary', 'secondary', 'k12', 'university', 'other')),
  add column if not exists accreditation text check (char_length(trim(accreditation)) <= 500),
  add column if not exists student_id_prefix text check (char_length(trim(student_id_prefix)) <= 10),
  add column if not exists student_id_format text not null default '{prefix}{sequence:04d}' check (char_length(student_id_format) <= 50),
  add column if not exists default_language text not null default 'en' check (char_length(default_language) <= 10);

-- School academic policies
create table if not exists public.school_academic_policies (
  school_id uuid primary key references public.schools(id) on delete cascade,
  -- Grading
  grading_scale text not null default 'percentage' check (grading_scale in ('percentage', 'letter', 'gpa', 'custom')),
  passing_percentage numeric(5,2) not null default 50 check (passing_percentage between 0 and 100),
  distinction_percentage numeric(5,2) not null default 75 check (distinction_percentage between 0 and 100),
  grade_boundaries jsonb not null default '{"A*": 90, "A": 80, "B": 70, "C": 60, "D": 50, "E": 40, "U": 0}'::jsonb,
  -- Academic year
  academic_year_start_month smallint not null default 9 check (academic_year_start_month between 1 and 12),
  academic_year_start_day smallint not null default 1 check (academic_year_start_day between 1 and 28),
  -- Terms
  default_term_count smallint not null default 3 check (default_term_count between 1 and 6),
  term_naming_convention text not null default 'Term {n}' check (char_length(term_naming_convention) <= 50),
  -- Assessment
  default_assessment_weighting jsonb not null default '{"coursework": 40, "exam": 60}'::jsonb,
  allow_retakes boolean not null default true,
  max_retakes smallint not null default 2 check (max_retakes between 0 and 10),
  retake_grade_cap numeric(5,2) check (retake_grade_cap is null or (retake_grade_cap between 0 and 100)),
  -- Promotion
  promotion_criteria jsonb not null default '{"min_attendance_percent": 85, "min_subjects_passed": 5}'::jsonb,
  -- Homework
  homework_policy jsonb not null default '{"enabled": true, "max_per_night_minutes": 120, "weekend_allowed": true}'::jsonb,
  -- Exams
  exam_policy jsonb not null default '{"reading_time_minutes": 10, "allow_calculators": false, "calculator_types": []}'::jsonb,
  -- Reporting
  report_card_template text,
  report_frequency text not null default 'termly' check (report_frequency in ('monthly', 'termly', 'semester', 'yearly')),
  -- Timetable
  timetable_cycle_weeks smallint not null default 1 check (timetable_cycle_weeks in (1, 2)),
  lesson_duration_minutes smallint not null default 40 check (lesson_duration_minutes between 20 and 120),
  max_lessons_per_day smallint not null default 8 check (max_lessons_per_day between 1 and 15),
  -- Updated
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default timezone('utc', now())
);

-- School communication settings
create table if not exists public.school_communication_settings (
  school_id uuid primary key references public.schools(id) on delete cascade,
  -- Email
  email_from_name text not null default 'School Administration' check (char_length(email_from_name) <= 100),
  email_from_address text check (email_from_address ~* '^[^@]+@[^@]+\.[^@]+$'),
  email_reply_to text check (email_reply_to ~* '^[^@]+@[^@]+\.[^@]+$'),
  email_footer text check (char_length(email_footer) <= 1000),
  -- SMS
  sms_enabled boolean not null default false,
  sms_provider text check (sms_provider in ('twilio', 'vonage', 'plivo', 'custom')),
  sms_from_number text check (char_length(sms_from_number) <= 20),
  -- Push notifications
  push_enabled boolean not null default false,
  push_vapid_public_key text,
  push_vapid_private_key text,
  -- In-app notifications
  notification_retention_days smallint not null default 90 check (notification_retention_days between 7 and 365),
  notification_categories jsonb not null default '{"announcements": true, "attendance": true, "assignments": true, "grades": true, "events": true, "messages": true}'::jsonb,
  -- Parent portal
  parent_portal_enabled boolean not null default true,
  parent_portal_features jsonb not null default '{"attendance": true, "grades": true, "timetable": true, "announcements": true, "leave_requests": true, "explanations": true}'::jsonb,
  -- Student portal
  student_portal_enabled boolean not null default true,
  student_portal_features jsonb not null default '{"attendance": true, "grades": true, "timetable": true, "assignments": true, "announcements": true}'::jsonb,
  -- Updated
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default timezone('utc', now())
);

-- School module feature flags
create table if not exists public.school_module_settings (
  school_id uuid primary key references public.schools(id) on delete cascade,
  -- Core modules
  module_attendance boolean not null default true,
  module_timetable boolean not null default true,
  module_learning boolean not null default true,
  module_assignments boolean not null default true,
  module_announcements boolean not null default true,
  module_events boolean not null default true,
  module_messaging boolean not null default true,
  module_directory boolean not null default true,
  module_calendar boolean not null default true,
  module_reports boolean not null default true,
  module_settings boolean not null default true,
  -- Advanced modules
  module_leave_management boolean not null default true,
  module_parent_explanations boolean not null default true,
  module_correction_requests boolean not null default true,
  module_followup_tasks boolean not null default true,
  module_substitute_assignments boolean not null default true,
  module_notification_templates boolean not null default true,
  module_past_papers boolean not null default true,
  module_assessment_results boolean not null default true,
  module_analytics boolean not null default false,
  module_library boolean not null default false,
  module_finance boolean not null default false,
  module_transport boolean not null default false,
  module_hostel boolean not null default false,
  module_health boolean not null default false,
  module_canteen boolean not null default false,
  module_uniform boolean not null default false,
  -- Feature flags within modules
  attendance_lesson_registers boolean not null default true,
  attendance_auto_generation boolean not null default true,
  attendance_parent_notifications boolean not null default true,
  timetable_auto_generation boolean not null default true,
  timetable_bell_schedules boolean not null default true,
  learning_question_library boolean not null default true,
  learning_past_papers boolean not null default true,
  learning_ai_generation boolean not null default false,
  assignments_online_submission boolean not null default true,
  assignments_plagiarism_check boolean not null default false,
  announcements_email_digest boolean not null default true,
  events_rsvp boolean not null default true,
  messaging_threads boolean not null default true,
  messaging_attachments boolean not null default true,
  directory_parent_access boolean not null default true,
  calendar_academic boolean not null default true,
  calendar_personal boolean not null default true,
  reports_scheduled boolean not null default true,
  reports_custom boolean not null default false,
  -- Updated
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default timezone('utc', now())
);

-- School security and privacy settings
create table if not exists public.school_security_settings (
  school_id uuid primary key references public.schools(id) on delete cascade,
  -- Session
  session_timeout_minutes smallint not null default 480 check (session_timeout_minutes between 15 and 10080),
  require_mfa boolean not null default false,
  mfa_methods text[] not null default '{}' check (mfa_methods <@ array['totp', 'sms', 'email', 'webauthn']),
  -- Password policy
  password_min_length smallint not null default 8 check (password_min_length between 6 and 64),
  password_require_uppercase boolean not null default true,
  password_require_lowercase boolean not null default true,
  password_require_numbers boolean not null default true,
  password_require_symbols boolean not null default true,
  password_max_age_days smallint check (password_max_age_days is null or password_max_age_days between 30 and 365),
  password_history_count smallint not null default 5 check (password_history_count between 0 and 24),
  -- Account lockout
  lockout_after_failed_attempts smallint not null default 5 check (lockout_after_failed_attempts between 3 and 20),
  lockout_duration_minutes smallint not null default 15 check (lockout_duration_minutes between 5 and 1440),
  -- Data privacy
  data_retention_years smallint not null default 7 check (data_retention_years between 1 and 20),
  anonymize_on_graduation boolean not null default true,
  allow_data_export boolean not null default true,
  gdpr_compliance_mode boolean not null default false,
  -- Audit
  audit_log_retention_days smallint not null default 365 check (audit_log_retention_days between 30 and 2555),
  audit_sensitive_actions text[] not null default '{"login", "password_change", "role_change", "data_export", "bulk_delete"}',
  -- IP restrictions
  allowed_ip_ranges text[] not null default '{}',
  -- Updated
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default timezone('utc', now())
);

-- School integration settings
create table if not exists public.school_integration_settings (
  school_id uuid primary key references public.schools(id) on delete cascade,
  -- LMS
  lms_enabled boolean not null default false,
  lms_provider text check (lms_provider in ('moodle', 'canvas', 'google_classroom', 'teams', 'custom')),
  lms_api_url text,
  lms_api_key text,
  lms_sync_frequency text check (lms_sync_frequency in ('realtime', 'hourly', 'daily', 'weekly')),
  -- SIS
  sis_enabled boolean not null default false,
  sis_provider text check (sis_provider in ('powerschool', 'infinite_campus', 'skyward', 'custom')),
  sis_api_url text,
  sis_api_key text,
  -- Calendar
  calendar_sync_enabled boolean not null default false,
  calendar_provider text check (calendar_provider in ('google', 'outlook', 'ical', 'custom')),
  calendar_sync_url text,
  -- Email
  smtp_host text,
  smtp_port smallint check (smtp_port between 1 and 65535),
  smtp_username text,
  smtp_password text,
  smtp_encryption text check (smtp_encryption in ('none', 'ssl', 'tls', 'starttls')),
  -- Storage
  storage_provider text check (storage_provider in ('supabase', 'aws_s3', 'google_cloud', 'azure_blob', 'firebase', 'custom')),
  storage_bucket text,
  storage_region text,
  storage_access_key text,
  storage_secret_key text,
  -- SSO
  sso_enabled boolean not null default false,
  sso_provider text check (sso_provider in ('saml', 'oidc', 'azure_ad', 'google_workspace', 'okta', 'custom')),
  sso_metadata_url text,
  sso_client_id text,
  sso_client_secret text,
  sso_attribute_mapping jsonb not null default '{"email": "email", "name": "name", "role": "role"}'::jsonb,
  -- Updated
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default timezone('utc', now())
);

-- School notification templates (general, not just attendance)
create table if not exists public.school_notification_templates (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  event_type text not null check (event_type in (
    'welcome', 'password_reset', 'account_locked', 'role_assigned',
    'assignment_created', 'assignment_due', 'assignment_graded', 'assignment_returned',
    'announcement_published', 'event_created', 'event_reminder', 'event_cancelled',
    'grade_published', 'report_card_available', 'timetable_changed', 'timetable_published',
    'leave_request_submitted', 'leave_request_approved', 'leave_request_rejected',
    'explanation_submitted', 'explanation_approved', 'explanation_rejected',
    'correction_requested', 'correction_approved', 'correction_rejected',
    'followup_created', 'followup_assigned', 'followup_resolved',
    'substitute_assigned', 'message_received', 'mention', 'system_maintenance'
  )),
  channel text not null check (channel in ('in_app', 'email', 'sms', 'push')),
  enabled boolean not null default true,
  title_template text not null check (char_length(trim(title_template)) between 2 and 160),
  body_template text not null check (char_length(trim(body_template)) between 3 and 5000),
  available_variables jsonb not null default '[]'::jsonb,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, event_type, channel)
);

-- Default notification templates
insert into public.school_notification_templates (school_id, event_type, channel, enabled, title_template, body_template, available_variables)
select school.id, template.event_type, template.channel, template.enabled, template.title_template, template.body_template, template.available_variables
from public.schools school
cross join (values
  ('welcome', 'in_app', true, 'Welcome to {school_name}!', 'Your account has been created. Please complete your profile.', '["school_name", "user_name", "login_url"]'),
  ('welcome', 'email', true, 'Welcome to {school_name}!', 'Dear {user_name},\n\nWelcome to {school_name}. Your account has been created. Please log in at {login_url} to complete your profile.\n\nBest regards,\n{school_name} Administration', '["school_name", "user_name", "login_url"]'),
  ('password_reset', 'in_app', true, 'Password Reset Request', 'Click the link to reset your password. This link expires in 1 hour.', '["reset_url", "expiry_hours"]'),
  ('password_reset', 'email', true, 'Password Reset Request', 'Dear {user_name},\n\nYou requested a password reset. Click here: {reset_url}\n\nThis link expires in {expiry_hours} hours.\n\nIf you did not request this, please ignore this email.', '["user_name", "reset_url", "expiry_hours"]'),
  ('assignment_due', 'in_app', true, 'Assignment Due Soon', '{assignment_title} is due on {due_date}.', '["assignment_title", "due_date", "subject", "class"]'),
  ('assignment_due', 'email', true, 'Assignment Due Reminder', 'Dear {user_name},\n\nThis is a reminder that {assignment_title} for {subject} ({class}) is due on {due_date}.\n\nPlease submit your work on time.', '["user_name", "assignment_title", "subject", "class", "due_date"]'),
  ('grade_published', 'in_app', true, 'New Grade Published', 'Your grade for {assignment_title} is now available: {grade}.', '["assignment_title", "grade", "subject", "class"]'),
  ('grade_published', 'email', true, 'Grade Published', 'Dear {user_name},\n\nA new grade has been published for {assignment_title} ({subject}, {class}).\n\nGrade: {grade}\n\nView details in the portal.', '["user_name", "assignment_title", "grade", "subject", "class"]'),
  ('announcement_published', 'in_app', true, 'New Announcement: {title}', '{body_preview}', '["title", "body_preview", "author", "priority"]'),
  ('announcement_published', 'email', true, 'New Announcement from {school_name}', 'Dear {user_name},\n\n{title}\n\n{body}\n\n— {author}\n{school_name}', '["user_name", "title", "body", "author", "school_name"]'),
  ('event_reminder', 'in_app', true, 'Event Reminder: {event_title}', '{event_title} starts in {time_until} on {event_date}.', '["event_title", "event_date", "time_until", "location"]'),
  ('event_reminder', 'email', true, 'Event Reminder: {event_title}', 'Dear {user_name},\n\nThis is a reminder about {event_title} on {event_date} at {event_time}.\n\nLocation: {location}\n\nDescription: {description}', '["user_name", "event_title", "event_date", "event_time", "location", "description"]'),
  ('timetable_changed', 'in_app', true, 'Timetable Updated', 'Your timetable has been updated. Please check the latest version.', '["class", "effective_date", "changes_summary"]'),
  ('timetable_changed', 'email', true, 'Timetable Change Notification', 'Dear {user_name},\n\nThe timetable for {class} has been updated effective {effective_date}.\n\nChanges: {changes_summary}\n\nPlease check the portal for the latest timetable.', '["user_name", "class", "effective_date", "changes_summary"]'),
  ('leave_request_approved', 'in_app', true, 'Leave Request Approved', 'Your leave request from {start_date} to {end_date} has been approved.', '["start_date", "end_date", "category"]'),
  ('leave_request_approved', 'email', true, 'Leave Request Approved', 'Dear {user_name},\n\nYour leave request from {start_date} to {end_date} ({category}) has been approved.\n\nReview note: {review_note}', '["user_name", "start_date", "end_date", "category", "review_note"]'),
  ('leave_request_rejected', 'in_app', true, 'Leave Request Not Approved', 'Your leave request from {start_date} to {end_date} was not approved. Reason: {review_note}', '["start_date", "end_date", "review_note"]'),
  ('leave_request_rejected', 'email', true, 'Leave Request Not Approved', 'Dear {user_name},\n\nYour leave request from {start_date} to {end_date} was not approved.\n\nReason: {review_note}\n\nPlease contact the school office for more information.', '["user_name", "start_date", "end_date", "review_note"]'),
  ('report_card_available', 'in_app', true, 'Report Card Available', 'Your {term} report card is now available.', '["term", "academic_year", "report_url"]'),
  ('report_card_available', 'email', true, 'Report Card Available', 'Dear {user_name},\n\nThe {term} {academic_year} report card for {student_name} is now available.\n\nView it here: {report_url}', '["user_name", "student_name", "term", "academic_year", "report_url"]'),
  ('system_maintenance', 'in_app', true, 'Scheduled Maintenance', 'System maintenance is scheduled for {maintenance_date} from {start_time} to {end_time}. Some features may be unavailable.', '["maintenance_date", "start_time", "end_time", "affected_features"]'),
  ('system_maintenance', 'email', true, 'Scheduled System Maintenance', 'Dear {user_name},\n\nScheduled maintenance will occur on {maintenance_date} from {start_time} to {end_time}.\n\nAffected features: {affected_features}\n\nWe apologize for any inconvenience.', '["user_name", "maintenance_date", "start_time", "end_time", "affected_features"]")
) as template(event_type, channel, enabled, title_template, body_template, available_variables)
on conflict (school_id, event_type, channel) do nothing;

-- Enable RLS on new tables
alter table public.school_academic_policies enable row level security;
alter table public.school_communication_settings enable row level security;
alter table public.school_module_settings enable row level security;
alter table public.school_security_settings enable row level security;
alter table public.school_integration_settings enable row level security;
alter table public.school_notification_templates enable row level security;

-- Policies for school_academic_policies
create policy "School admins manage academic policies"
  on public.school_academic_policies for all to authenticated
  using (public.has_school_role(school_id, '{school_admin}'::public.app_role[]))
  with check (public.has_school_role(school_id, '{school_admin}'::public.app_role[]));

create policy "School staff read academic policies"
  on public.school_academic_policies for select to authenticated
  using (public.has_school_role(school_id, '{school_admin,teacher,academic_coordinator}'::public.app_role[]));

-- Policies for school_communication_settings
create policy "School admins manage communication settings"
  on public.school_communication_settings for all to authenticated
  using (public.has_school_role(school_id, '{school_admin}'::public.app_role[]))
  with check (public.has_school_role(school_id, '{school_admin}'::public.app_role[]));

create policy "School staff read communication settings"
  on public.school_communication_settings for select to authenticated
  using (public.has_school_role(school_id, '{school_admin,teacher,academic_coordinator}'::public.app_role[]));

-- Policies for school_module_settings
create policy "School admins manage module settings"
  on public.school_module_settings for all to authenticated
  using (public.has_school_role(school_id, '{school_admin}'::public.app_role[]))
  with check (public.has_school_role(school_id, '{school_admin}'::public.app_role[]));

create policy "School staff read module settings"
  on public.school_module_settings for select to authenticated
  using (public.has_school_role(school_id, '{school_admin,teacher,academic_coordinator}'::public.app_role[]));

-- Policies for school_security_settings
create policy "School admins manage security settings"
  on public.school_security_settings for all to authenticated
  using (public.has_school_role(school_id, '{school_admin}'::public.app_role[]))
  with check (public.has_school_role(school_id, '{school_admin}'::public.app_role[]));

create policy "School staff read security settings"
  on public.school_security_settings for select to authenticated
  using (public.has_school_role(school_id, '{school_admin}'::public.app_role[]));

-- Policies for school_integration_settings
create policy "School admins manage integration settings"
  on public.school_integration_settings for all to authenticated
  using (public.has_school_role(school_id, '{school_admin}'::public.app_role[]))
  with check (public.has_school_role(school_id, '{school_admin}'::public.app_role[]));

create policy "School staff read integration settings"
  on public.school_integration_settings for select to authenticated
  using (public.has_school_role(school_id, '{school_admin}'::public.app_role[]));

-- Policies for school_notification_templates
create policy "School admins manage notification templates"
  on public.school_notification_templates for all to authenticated
  using (public.has_school_role(school_id, '{school_admin}'::public.app_role[]))
  with check (public.has_school_role(school_id, '{school_admin}'::public.app_role[]));

create policy "School staff read notification templates"
  on public.school_notification_templates for select to authenticated
  using (public.has_school_role(school_id, '{school_admin,teacher,academic_coordinator}'::public.app_role[]));

-- Grants
grant select, insert, update, delete on public.school_academic_policies to authenticated;
grant select, insert, update, delete on public.school_communication_settings to authenticated;
grant select, insert, update, delete on public.school_module_settings to authenticated;
grant select, insert, update, delete on public.school_security_settings to authenticated;
grant select, insert, update, delete on public.school_integration_settings to authenticated;
grant select, insert, update, delete on public.school_notification_templates to authenticated;

-- Auto-create default rows for new schools
create or replace function public.create_default_school_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.school_academic_policies (school_id) values (new.id)
  on conflict (school_id) do nothing;
  
  insert into public.school_communication_settings (school_id) values (new.id)
  on conflict (school_id) do nothing;
  
  insert into public.school_module_settings (school_id) values (new.id)
  on conflict (school_id) do nothing;
  
  insert into public.school_security_settings (school_id) values (new.id)
  on conflict (school_id) do nothing;
  
  insert into public.school_integration_settings (school_id) values (new.id)
  on conflict (school_id) do nothing;
  
  return new;
end;
$$;

create trigger create_default_school_settings
  after insert on public.schools
  for each row execute function public.create_default_school_settings();

revoke all on function public.create_default_school_settings() from public;

-- Updated_at triggers
create trigger set_updated_at
  before update on public.school_academic_policies
  for each row execute function public.set_updated_at();

create trigger set_updated_at
  before update on public.school_communication_settings
  for each row execute function public.set_updated_at();

create trigger set_updated_at
  before update on public.school_module_settings
  for each row execute function public.set_updated_at();

create trigger set_updated_at
  before update on public.school_security_settings
  for each row execute function public.set_updated_at();

create trigger set_updated_at
  before update on public.school_integration_settings
  for each row execute function public.set_updated_at();

create trigger set_updated_at
  before update on public.school_notification_templates
  for each row execute function public.set_updated_at();

-- Create default rows for existing schools
insert into public.school_academic_policies (school_id)
select id from public.schools
on conflict (school_id) do nothing;

insert into public.school_communication_settings (school_id)
select id from public.schools
on conflict (school_id) do nothing;

insert into public.school_module_settings (school_id)
select id from public.schools
on conflict (school_id) do nothing;

insert into public.school_security_settings (school_id)
select id from public.schools
on conflict (school_id) do nothing;

insert into public.school_integration_settings (school_id)
select id from public.schools
on conflict (school_id) do nothing;