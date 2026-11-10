update public.student_behaviour_email_templates
set enabled = true,
    require_approval = true,
    updated_at = timezone('utc', now())
where event_type = 'manual_report';

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
    (new.id, 'manual_report', 'A secure student report is available', 'A secure student report is available in your Campus Connect account. Sign in to view it: {secure_link}')
  on conflict (school_id, event_type) do nothing;

  update public.student_behaviour_email_templates
  set enabled = true, require_approval = true
  where school_id = new.id and event_type = 'manual_report';

  return new;
end;
$$;
