export type AppRole = 'system_admin' | 'school_admin' | 'academic_coordinator' | 'teacher' | 'student' | 'parent' | 'finance_manager' | 'accountant' | 'bursar' | 'cashier';

export interface SchoolMembership {
  school_id: string;
  role: AppRole;
  school: {
    id: string;
    name: string;
    timezone: string;
    address?: string | null;
    contact_email?: string | null;
    contact_phone?: string | null;
    website?: string | null;
    logo_path: string | null;
    primary_color: string | null;
    secondary_color: string | null;
    motto: string | null;
    established_year: number | null;
    school_type: string | null;
    accreditation: string | null;
    student_id_prefix: string | null;
    student_id_format: string;
    default_language: string;
  };
}

export interface Student {
  id: string;
  school_id: string;
  student_number: string;
  first_name: string;
  last_name: string;
  email: string | null;
  date_of_birth: string | null;
  status: 'active' | 'inactive' | 'graduated';
  class_id: string | null;
  created_at: string;
  school_classes: { name: string } | null;
}

export interface SchoolClass {
  id: string;
  school_id: string;
  name: string;
  grade_level: string | null;
  academic_year_id: string | null;
  created_at: string;
}

export interface Subject {
  id: string;
  school_id: string;
  name: string;
  code: string | null;
  created_at: string;
}

export interface DashboardSummary {
  students: number;
  teachers: number;
  classes: number;
  attendanceToday: { present: number; total: number } | null;
}

export interface SchoolAcademicPolicies {
  school_id: string;
  grading_scale: 'percentage' | 'letter' | 'gpa' | 'custom';
  passing_percentage: number;
  distinction_percentage: number;
  grade_boundaries: Record<string, number>;
  academic_year_start_month: number;
  academic_year_start_day: number;
  default_term_count: number;
  term_naming_convention: string;
  default_assessment_weighting: Record<string, number>;
  allow_retakes: boolean;
  max_retakes: number;
  retake_grade_cap: number | null;
  promotion_criteria: Record<string, unknown>;
  homework_policy: Record<string, unknown>;
  exam_policy: Record<string, unknown>;
  report_card_template: string | null;
  report_frequency: 'monthly' | 'termly' | 'semester' | 'yearly';
  timetable_cycle_weeks: 1 | 2;
  lesson_duration_minutes: number;
  max_lessons_per_day: number;
  updated_by: string | null;
  updated_at: string;
}

export interface SchoolCommunicationSettings {
  school_id: string;
  email_from_name: string;
  email_from_address: string | null;
  email_reply_to: string | null;
  email_footer: string | null;
  sms_enabled: boolean;
  sms_provider: string | null;
  sms_from_number: string | null;
  push_enabled: boolean;
  push_vapid_public_key: string | null;
  push_vapid_private_key: string | null;
  notification_retention_days: number;
  notification_categories: Record<string, boolean>;
  parent_portal_enabled: boolean;
  parent_portal_features: Record<string, boolean>;
  student_portal_enabled: boolean;
  student_portal_features: Record<string, boolean>;
  updated_by: string | null;
  updated_at: string;
}

export interface SchoolModuleSettings {
  school_id: string;
  module_attendance: boolean;
  module_timetable: boolean;
  module_learning: boolean;
  module_assignments: boolean;
  module_announcements: boolean;
  module_events: boolean;
  module_messaging: boolean;
  module_directory: boolean;
  module_calendar: boolean;
  module_reports: boolean;
  module_settings: boolean;
  module_leave_management: boolean;
  module_parent_explanations: boolean;
  module_correction_requests: boolean;
  module_followup_tasks: boolean;
  module_substitute_assignments: boolean;
  module_notification_templates: boolean;
  module_past_papers: boolean;
  module_assessment_results: boolean;
  module_analytics: boolean;
  module_library: boolean;
  module_finance: boolean;
  module_transport: boolean;
  module_hostel: boolean;
  module_health: boolean;
  module_canteen: boolean;
  module_uniform: boolean;
  attendance_lesson_registers: boolean;
  attendance_auto_generation: boolean;
  attendance_parent_notifications: boolean;
  timetable_auto_generation: boolean;
  timetable_bell_schedules: boolean;
  learning_question_library: boolean;
  learning_past_papers: boolean;
  learning_ai_generation: boolean;
  assignments_online_submission: boolean;
  assignments_plagiarism_check: boolean;
  announcements_email_digest: boolean;
  events_rsvp: boolean;
  messaging_threads: boolean;
  messaging_attachments: boolean;
  directory_parent_access: boolean;
  calendar_academic: boolean;
  calendar_personal: boolean;
  reports_scheduled: boolean;
  reports_custom: boolean;
  updated_by: string | null;
  updated_at: string;
}

export interface SchoolSecuritySettings {
  school_id: string;
  session_timeout_minutes: number;
  require_mfa: boolean;
  mfa_methods: string[];
  password_min_length: number;
  password_require_uppercase: boolean;
  password_require_lowercase: boolean;
  password_require_numbers: boolean;
  password_require_symbols: boolean;
  password_max_age_days: number | null;
  password_history_count: number;
  lockout_after_failed_attempts: number;
  lockout_duration_minutes: number;
  data_retention_years: number;
  anonymize_on_graduation: boolean;
  allow_data_export: boolean;
  gdpr_compliance_mode: boolean;
  audit_log_retention_days: number;
  audit_sensitive_actions: string[];
  allowed_ip_ranges: string[];
  updated_by: string | null;
  updated_at: string;
}

export interface SchoolIntegrationSettings {
  school_id: string;
  lms_enabled: boolean;
  lms_provider: string | null;
  lms_api_url: string | null;
  lms_api_key: string | null;
  lms_sync_frequency: string | null;
  sis_enabled: boolean;
  sis_provider: string | null;
  sis_api_url: string | null;
  sis_api_key: string | null;
  calendar_sync_enabled: boolean;
  calendar_provider: string | null;
  calendar_sync_url: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_username: string | null;
  smtp_password: string | null;
  smtp_encryption: string | null;
  storage_provider: string | null;
  storage_bucket: string | null;
  storage_region: string | null;
  storage_access_key: string | null;
  storage_secret_key: string | null;
  sso_enabled: boolean;
  sso_provider: string | null;
  sso_metadata_url: string | null;
  sso_client_id: string | null;
  sso_client_secret: string | null;
  sso_attribute_mapping: Record<string, string>;
  updated_by: string | null;
  updated_at: string;
}

export interface SchoolNotificationTemplate {
  id: string;
  school_id: string;
  event_type: string;
  channel: 'in_app' | 'email' | 'sms' | 'push';
  enabled: boolean;
  title_template: string;
  body_template: string;
  available_variables: string[];
  updated_by: string | null;
  updated_at: string;
}
