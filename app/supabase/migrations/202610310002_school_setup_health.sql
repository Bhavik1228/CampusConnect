create table public.school_setup_health_runs (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  requested_by uuid not null references public.profiles(id),
  status text not null check (status in ('running', 'completed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (school_id, id)
);

create table public.school_setup_health_results (
  school_id uuid not null,
  run_id uuid not null,
  rule_key text not null,
  name text not null,
  description text not null,
  category text not null,
  category_label text not null,
  workflows text[] not null default '{}',
  severity text not null check (severity in ('critical', 'high', 'medium', 'low', 'informational')),
  owner_role text not null,
  status text not null check (status in ('passed', 'failed', 'warning', 'not_applicable', 'needs_review')),
  is_applicable boolean not null,
  blocks_workflow boolean not null default false,
  fix_route text,
  result_message text not null,
  affected_count integer check (affected_count is null or affected_count >= 0),
  checked_at timestamptz not null default now(),
  primary key (run_id, rule_key),
  foreign key (school_id, run_id)
    references public.school_setup_health_runs(school_id, id) on delete cascade
);
create index school_setup_health_results_school_rule_idx
  on public.school_setup_health_results(school_id, rule_key, checked_at desc);

create table public.school_setup_health_state (
  school_id uuid primary key references public.schools(id) on delete cascade,
  latest_run_id uuid not null,
  summary jsonb not null,
  is_stale boolean not null default false,
  evaluated_at timestamptz not null,
  foreign key (school_id, latest_run_id)
    references public.school_setup_health_runs(school_id, id) on delete cascade
);

alter table public.school_setup_health_runs enable row level security;
alter table public.school_setup_health_results enable row level security;
alter table public.school_setup_health_state enable row level security;

create policy "School administrators read setup health runs"
  on public.school_setup_health_runs for select to authenticated
  using (public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[]));
create policy "School administrators read setup health results"
  on public.school_setup_health_results for select to authenticated
  using (public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[]));
create policy "School administrators read setup health state"
  on public.school_setup_health_state for select to authenticated
  using (public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[]));

revoke all on public.school_setup_health_runs from public, anon, authenticated;
revoke all on public.school_setup_health_results from public, anon, authenticated;
revoke all on public.school_setup_health_state from public, anon, authenticated;
grant select on public.school_setup_health_runs to authenticated;
grant select on public.school_setup_health_results to authenticated;
grant select on public.school_setup_health_state to authenticated;

create or replace function public.evaluate_school_setup_health_rules(target_school uuid)
returns table (
  rule_key text,
  name text,
  description text,
  category text,
  category_label text,
  workflows text[],
  severity text,
  owner_role text,
  status text,
  is_applicable boolean,
  blocks_workflow boolean,
  fix_route text,
  result_message text,
  affected_count integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with school_data as (
    select
      school.id,
      nullif(trim(school.name), '') is not null as has_name,
      (nullif(trim(school.contact_email), '') is not null
        or nullif(trim(school.contact_phone), '') is not null) as has_contact,
      nullif(trim(school.address), '') is not null as has_address,
      (school.logo_path is not null or school.primary_color is not null) as has_branding,
      exists (
        select 1 from pg_catalog.pg_timezone_names zone
        where zone.name = school.timezone
      ) as has_timezone,
      exists (
        select 1 from public.academic_years year
        join public.academic_calendars calendar
          on calendar.school_id = year.school_id and calendar.id = year.calendar_id
        where year.school_id = school.id and calendar.is_default
      ) as has_any_academic_year,
      exists (
        select 1 from public.academic_years year
        join public.academic_calendars calendar
          on calendar.school_id = year.school_id and calendar.id = year.calendar_id
        where year.school_id = school.id and year.is_current and calendar.is_default
      ) as has_current_year,
      (
        select year.id from public.academic_years year
        join public.academic_calendars calendar
          on calendar.school_id = year.school_id and calendar.id = year.calendar_id
        where year.school_id = school.id and year.is_current and calendar.is_default
        limit 1
      ) as current_year_id,
      (
        select count(*)::integer from public.terms term
        where term.school_id = school.id
          and term.academic_year_id = (
            select year.id from public.academic_years year
            join public.academic_calendars calendar
              on calendar.school_id = year.school_id and calendar.id = year.calendar_id
            where year.school_id = school.id and year.is_current and calendar.is_default
            limit 1
          )
      ) as current_term_count,
      (
        select count(*)::integer
        from public.terms first_term
        join public.terms second_term
          on second_term.school_id = first_term.school_id
          and second_term.academic_year_id = first_term.academic_year_id
          and second_term.id > first_term.id
          and first_term.start_date <= second_term.end_date
          and second_term.start_date <= first_term.end_date
        where first_term.school_id = school.id
          and first_term.academic_year_id = (
            select year.id from public.academic_years year
            join public.academic_calendars calendar
              on calendar.school_id = year.school_id and calendar.id = year.calendar_id
            where year.school_id = school.id and year.is_current and calendar.is_default
            limit 1
          )
      ) as overlapping_term_count,
      (
        select count(*)::integer
        from public.terms term
        join public.academic_years year
          on year.school_id = term.school_id and year.id = term.academic_year_id
        join public.academic_calendars calendar
          on calendar.school_id = year.school_id and calendar.id = year.calendar_id
        where term.school_id = school.id
          and year.is_current and calendar.is_default
          and (term.start_date < year.start_date or term.end_date > year.end_date)
      ) as out_of_year_term_count,
      (select count(*)::integer from public.school_classes item where item.school_id = school.id) as class_count,
      (
        select count(*)::integer from public.school_classes item
        where item.school_id = school.id
          and item.academic_year_id is distinct from (
            select year.id from public.academic_years year
            join public.academic_calendars calendar
              on calendar.school_id = year.school_id and calendar.id = year.calendar_id
            where year.school_id = school.id and year.is_current and calendar.is_default
            limit 1
          )
      ) as classes_outside_current_year_count,
      (select count(*)::integer from public.subjects item where item.school_id = school.id) as subject_count,
      (
        select count(*)::integer from public.school_classes class
        where class.school_id = school.id
          and not exists (
            select 1 from public.class_subjects assignment
            where assignment.school_id = school.id and assignment.class_id = class.id
          )
      ) as classes_without_subjects_count,
      (
        select count(*)::integer from public.staff_profiles item
        where item.school_id = school.id and item.employment_status = 'active'
      ) as active_staff_count,
      (
        select count(*)::integer from public.teacher_profiles item
        where item.school_id = school.id and item.status = 'active'
          and item.employment_status = 'active'
      ) as active_teacher_count,
      (
        select count(*)::integer from public.school_classes class
        where class.school_id = school.id
          and not exists (
            select 1
            from public.teacher_class_assignments assignment
            join public.teacher_profiles teacher
              on teacher.school_id = assignment.school_id and teacher.id = assignment.teacher_id
            where assignment.school_id = school.id and assignment.class_id = class.id
              and teacher.status = 'active' and teacher.employment_status = 'active'
          )
      ) as classes_without_active_teachers_count,
      (
        select count(*)::integer from public.teacher_profiles teacher
        where teacher.school_id = school.id and teacher.status = 'active'
          and teacher.employment_status = 'active'
          and not exists (
            select 1 from public.teacher_subjects assignment
            where assignment.school_id = school.id and assignment.teacher_id = teacher.id
          )
      ) as teachers_without_subjects_count,
      (
        select count(*)::integer from public.students item
        where item.school_id = school.id and item.status = 'active'
      ) as active_student_count,
      (
        select count(*)::integer from public.students item
        where item.school_id = school.id and item.status = 'active' and item.class_id is null
      ) as unassigned_student_count,
      exists (select 1 from public.school_module_settings setting where setting.school_id = school.id) as has_module_settings,
      coalesce((select setting.module_attendance from public.school_module_settings setting where setting.school_id = school.id), false) as attendance_enabled,
      coalesce((select setting.module_timetable from public.school_module_settings setting where setting.school_id = school.id), false) as timetable_enabled,
      coalesce((select setting.module_reports from public.school_module_settings setting where setting.school_id = school.id), false) as reports_enabled,
      coalesce((select setting.module_finance from public.school_module_settings setting where setting.school_id = school.id), false) as finance_enabled,
      exists (select 1 from public.attendance_settings setting where setting.school_id = school.id) as has_attendance_settings,
      exists (select 1 from public.school_academic_policies setting where setting.school_id = school.id) as has_academic_policies,
      (
        select count(*)::integer from public.fee_structures fee
        where fee.school_id = school.id and fee.is_active
      ) as active_fee_structure_count,
      (
        select count(*)::integer from public.fee_structures fee
        where fee.school_id = school.id and fee.is_active
          and fee.academic_year_id is distinct from (
            select year.id from public.academic_years year
            join public.academic_calendars calendar
              on calendar.school_id = year.school_id and calendar.id = year.calendar_id
            where year.school_id = school.id and year.is_current and calendar.is_default
            limit 1
          )
      ) as fee_structures_outside_current_year_count,
      website.enabled as website_enabled,
      nullif(trim(website.hero_title), '') is not null as has_website_homepage_title
    from public.schools school
    left join public.school_websites website on website.school_id = school.id
    where school.id = target_school
  ),
  configured_rules as (
    select rule.*
    from school_data data
    cross join lateral (values
      (
        'school_name', 'School name', 'A school name identifies the workspace in the application and its reports.',
        'school_profile', 'School Profile', array['daily_operations']::text[], 'critical', 'school_admin',
        case when data.has_name then 'passed' else 'failed' end, true, true, '/settings?tab=profile',
        case when data.has_name then 'School name is configured.' else 'Add a school name to identify this workspace.' end,
        null::integer
      ),
      (
        'school_contact', 'School contact details', 'At least one school contact method should be available for everyday administration.',
        'school_profile', 'School Profile', array['daily_operations']::text[], 'medium', 'school_admin',
        case when data.has_contact then 'passed' else 'warning' end, true, false, '/settings?tab=profile',
        case when data.has_contact then 'Contact details are available.' else 'Add a contact email or phone number.' end,
        null::integer
      ),
      (
        'school_address', 'School address', 'A configured address helps identify the school on administrative documents.',
        'school_profile', 'School Profile', array['daily_operations']::text[], 'low', 'school_admin',
        case when data.has_address then 'passed' else 'warning' end, true, false, '/settings?tab=profile',
        case when data.has_address then 'School address is configured.' else 'Add the school address if it is required for your documents.' end,
        null::integer
      ),
      (
        'school_branding', 'School branding', 'Add a logo or primary brand colour so school-facing pages can use the configured identity.',
        'school_profile', 'School Profile', array['daily_operations']::text[], 'low', 'school_admin',
        case when data.has_branding then 'passed' else 'warning' end, true, false, '/settings?tab=profile',
        case when data.has_branding then 'School branding is configured.' else 'Add a school logo or primary brand colour.' end,
        null::integer
      ),
      (
        'school_timezone', 'School timezone', 'The timezone determines how school dates and schedules are interpreted.',
        'school_profile', 'School Profile', array['daily_operations', 'timetable', 'attendance']::text[], 'medium', 'school_admin',
        case when data.has_timezone then 'passed' else 'failed' end, true, true, '/settings?tab=profile',
        case when data.has_timezone then 'A school timezone is configured.' else 'Set the school timezone before scheduling school activities.' end,
        null::integer
      ),
      (
        'module_settings', 'School module configuration', 'Module state is required to determine which workflow checks apply.',
        'school_profile', 'School Profile', array['daily_operations']::text[], 'high', 'school_admin',
        case when data.has_module_settings then 'passed' else 'needs_review' end, true, false, '/settings?tab=modules',
        case when data.has_module_settings then 'School module settings are available.' else 'Module settings are missing, so module-specific readiness cannot be confirmed.' end,
        null::integer
      ),
      (
        'timetable_module_status', 'Timetable module status', 'Timetable setup checks apply only while the timetable module is enabled.',
        'school_profile', 'School Profile', array['timetable']::text[], 'informational', 'school_admin',
        case
          when not data.has_module_settings then 'needs_review'
          when data.timetable_enabled then 'passed'
          else 'not_applicable'
        end,
        (not data.has_module_settings or data.timetable_enabled), false, '/settings?tab=modules',
        case
          when not data.has_module_settings then 'Module settings are unavailable; timetable status cannot be confirmed.'
          when data.timetable_enabled then 'The timetable module is enabled.'
          else 'The timetable module is disabled.'
        end,
        null::integer
      ),
      (
        'attendance_module_status', 'Attendance module status', 'Attendance setup checks apply only while the attendance module is enabled.',
        'school_profile', 'School Profile', array['attendance']::text[], 'informational', 'school_admin',
        case
          when not data.has_module_settings then 'needs_review'
          when data.attendance_enabled then 'passed'
          else 'not_applicable'
        end,
        (not data.has_module_settings or data.attendance_enabled), false, '/settings?tab=modules',
        case
          when not data.has_module_settings then 'Module settings are unavailable; attendance status cannot be confirmed.'
          when data.attendance_enabled then 'The attendance module is enabled.'
          else 'The attendance module is disabled.'
        end,
        null::integer
      ),
      (
        'reports_module_status', 'Reports module status', 'Academic report readiness is relevant only when the reports module is enabled.',
        'school_profile', 'School Profile', array['reports']::text[], 'informational', 'school_admin',
        case
          when not data.has_module_settings then 'needs_review'
          when data.reports_enabled then 'passed'
          else 'not_applicable'
        end,
        (not data.has_module_settings or data.reports_enabled), false, '/settings?tab=modules',
        case
          when not data.has_module_settings then 'Module settings are unavailable; reports status cannot be confirmed.'
          when data.reports_enabled then 'The reports module is enabled.'
          else 'The reports module is disabled.'
        end,
        null::integer
      ),
      (
        'academic_year_exists', 'Academic year exists', 'At least one academic year must be available before school workflows can be prepared.',
        'academic_years', 'Academic Years & Terms',
        array['timetable', 'attendance', 'reports', 'fees', 'daily_operations']::text[], 'critical', 'academic_coordinator',
        case when data.has_any_academic_year then 'passed' else 'failed' end, true, true, '/academic-calendar',
        case when data.has_any_academic_year then 'An academic year is configured for the default calendar.' else 'Create an academic year in the default academic calendar.' end,
        null::integer
      ),
      (
        'current_academic_year', 'Current academic year is selected', 'The current year anchors classes, attendance and academic reports.',
        'academic_years', 'Academic Years & Terms',
        array['timetable', 'attendance', 'reports', 'fees', 'daily_operations']::text[], 'critical', 'academic_coordinator',
        case when data.has_current_year then 'passed' else 'failed' end, true, true, '/academic-calendar',
        case when data.has_current_year then 'A current academic year is selected.' else 'Select a current academic year for the default calendar.' end,
        null::integer
      ),
      (
        'academic_terms_exist', 'Terms are configured', 'At least one term in the current academic year is needed for term-based planning and reports.',
        'academic_years', 'Academic Years & Terms',
        array['timetable', 'reports']::text[], 'high', 'academic_coordinator',
        case when data.current_term_count > 0 then 'passed' else 'failed' end, true, true, '/academic-calendar',
        case when data.current_term_count > 0 then 'Terms are linked to the current academic year.' else 'Add at least one term to the current academic year.' end,
        data.current_term_count
      ),
      (
        'academic_term_dates', 'Term dates do not overlap or exceed the year', 'Term ranges should fit within the current year and should not overlap.',
        'academic_years', 'Academic Years & Terms',
        array['timetable', 'reports']::text[], 'medium', 'academic_coordinator',
        case
          when not data.has_current_year then 'needs_review'
          when data.overlapping_term_count + data.out_of_year_term_count > 0 then 'warning'
          else 'passed'
        end,
        true, false, '/academic-calendar',
        case
          when not data.has_current_year then 'Select a current academic year before term dates can be checked.'
          when data.overlapping_term_count + data.out_of_year_term_count > 0
            then 'Review term ranges; overlapping or out-of-year terms were found.'
          else 'Current-year term ranges are valid.'
        end,
        data.overlapping_term_count + data.out_of_year_term_count
      ),
      (
        'classes_exist', 'Classes are configured', 'At least one class is needed to enrol students and prepare registers or timetables.',
        'classes', 'Classes & Streams',
        array['timetable', 'attendance', 'reports', 'daily_operations']::text[], 'critical', 'academic_coordinator',
        case when data.class_count > 0 then 'passed' else 'failed' end, true, true, '/classes',
        case when data.class_count > 0 then 'School classes are configured.' else 'Create at least one class.' end,
        data.class_count
      ),
      (
        'classes_current_year', 'Classes are linked to the current academic year', 'Year associations help keep class membership and reports aligned with the selected year.',
        'classes', 'Classes & Streams', array['timetable', 'attendance', 'reports']::text[], 'medium', 'academic_coordinator',
        case
          when not data.has_current_year then 'needs_review'
          when data.classes_outside_current_year_count > 0 then 'warning'
          else 'passed'
        end,
        data.has_current_year and data.class_count > 0, false, '/classes',
        case
          when not data.has_current_year then 'Select a current academic year before class-year links can be checked.'
          when data.classes_outside_current_year_count > 0 then 'Review classes that are not linked to the current academic year.'
          else 'Classes are linked to the current academic year.'
        end,
        data.classes_outside_current_year_count
      ),
      (
        'subjects_exist', 'Subjects are configured', 'Subjects are required for class curricula and academic reporting.',
        'subjects', 'Subjects', array['timetable', 'reports']::text[], 'high', 'academic_coordinator',
        case when data.subject_count > 0 then 'passed' else 'failed' end, true, true, '/subjects',
        case when data.subject_count > 0 then 'School subjects are configured.' else 'Create at least one subject.' end,
        data.subject_count
      ),
      (
        'class_subject_assignments', 'Classes have subject assignments', 'Relevant classes should have at least one subject before they can be fully timetabled.',
        'subjects', 'Subjects', array['timetable', 'reports']::text[], 'high', 'academic_coordinator',
        case
          when not data.has_module_settings then 'needs_review'
          when not data.timetable_enabled then 'not_applicable'
          when data.class_count = 0 then 'not_applicable'
          when data.classes_without_subjects_count > 0 then 'failed'
          else 'passed'
        end,
        not data.has_module_settings or (data.timetable_enabled and data.class_count > 0),
        true, '/subjects',
        case
          when not data.has_module_settings then 'Module settings are unavailable; timetable applicability cannot be confirmed.'
          when not data.timetable_enabled then 'The timetable module is disabled.'
          when data.class_count = 0 then 'Create classes before assigning subjects.'
          when data.classes_without_subjects_count > 0 then 'Assign subjects to each class that uses the timetable.'
          else 'Classes have subject assignments.'
        end,
        data.classes_without_subjects_count
      ),
      (
        'staff_records_exist', 'Active staff records exist', 'Staff records support daily school operations and ownership of school workflows.',
        'staff', 'Staff & Teachers', array['daily_operations']::text[], 'high', 'hr_staff_administrator',
        case when data.active_staff_count > 0 then 'passed' else 'failed' end, true, true, '/staff',
        case when data.active_staff_count > 0 then 'Active staff records are available.' else 'Add or activate at least one staff record.' end,
        data.active_staff_count
      ),
      (
        'active_teachers_exist', 'Active teachers are available', 'The timetable workflow needs at least one active teacher.',
        'staff', 'Staff & Teachers', array['timetable']::text[], 'high', 'hr_staff_administrator',
        case
          when not data.has_module_settings then 'needs_review'
          when not data.timetable_enabled then 'not_applicable'
          when data.active_teacher_count > 0 then 'passed'
          else 'failed'
        end,
        not data.has_module_settings or data.timetable_enabled, true, '/staff',
        case
          when not data.has_module_settings then 'Module settings are unavailable; timetable applicability cannot be confirmed.'
          when not data.timetable_enabled then 'The timetable module is disabled.'
          when data.active_teacher_count > 0 then 'Active teachers are available.'
          else 'Add or activate a teacher before preparing timetables.'
        end,
        data.active_teacher_count
      ),
      (
        'teacher_class_assignments', 'Classes have active teacher assignments', 'Active teacher assignments support timetable and teacher-led register workflows.',
        'staff', 'Staff & Teachers', array['timetable', 'attendance']::text[], 'high', 'hr_staff_administrator',
        case
          when not data.has_module_settings then 'needs_review'
          when not (data.timetable_enabled or data.attendance_enabled) then 'not_applicable'
          when data.class_count = 0 or data.active_teacher_count = 0 then 'not_applicable'
          when data.classes_without_active_teachers_count > 0 then 'failed'
          else 'passed'
        end,
        not data.has_module_settings or (
          (data.timetable_enabled or data.attendance_enabled)
          and data.class_count > 0 and data.active_teacher_count > 0
        ),
        true, '/staff',
        case
          when not data.has_module_settings then 'Module settings are unavailable; assignment applicability cannot be confirmed.'
          when not (data.timetable_enabled or data.attendance_enabled) then 'Timetable and attendance modules are disabled.'
          when data.class_count = 0 or data.active_teacher_count = 0 then 'Create classes and active teacher records before assigning teachers.'
          when data.classes_without_active_teachers_count > 0 then 'Assign an active teacher to each relevant class.'
          else 'Relevant classes have active teacher assignments.'
        end,
        data.classes_without_active_teachers_count
      ),
      (
        'teacher_subject_assignments', 'Active teachers have subject assignments', 'Subject assignments help validate teacher workload and timetable eligibility.',
        'staff', 'Staff & Teachers', array['timetable']::text[], 'medium', 'hr_staff_administrator',
        case
          when not data.has_module_settings then 'needs_review'
          when not data.timetable_enabled then 'not_applicable'
          when data.active_teacher_count = 0 then 'not_applicable'
          when data.teachers_without_subjects_count > 0 then 'warning'
          else 'passed'
        end,
        not data.has_module_settings or (data.timetable_enabled and data.active_teacher_count > 0),
        false, '/staff',
        case
          when not data.has_module_settings then 'Module settings are unavailable; timetable applicability cannot be confirmed.'
          when not data.timetable_enabled then 'The timetable module is disabled.'
          when data.active_teacher_count = 0 then 'Add active teachers before checking subject assignments.'
          when data.teachers_without_subjects_count > 0 then 'Review active teachers without a subject assignment.'
          else 'Active teachers have subject assignments.'
        end,
        data.teachers_without_subjects_count
      ),
      (
        'students_exist', 'Active students are enrolled', 'Student records are needed for registers, class reports and everyday operations.',
        'students', 'Students', array['attendance', 'reports', 'daily_operations']::text[], 'critical', 'school_admin',
        case when data.active_student_count > 0 then 'passed' else 'failed' end, true, true, '/students',
        case when data.active_student_count > 0 then 'Active student records are available.' else 'Enrol or activate students before using registers and reports.' end,
        data.active_student_count
      ),
      (
        'students_assigned_to_classes', 'Active students are assigned to classes', 'Students without a class are excluded from class-based registers and reports.',
        'students', 'Students', array['attendance', 'reports']::text[], 'high', 'school_admin',
        case
          when data.active_student_count = 0 then 'not_applicable'
          when data.unassigned_student_count > 0 then 'failed'
          else 'passed'
        end,
        data.active_student_count > 0, true, '/students',
        case
          when data.active_student_count = 0 then 'Enrol students before checking class allocations.'
          when data.unassigned_student_count > 0 then 'Assign active students to their current classes.'
          else 'Active students are assigned to classes.'
        end,
        data.unassigned_student_count
      ),
      (
        'attendance_settings', 'Attendance settings are available', 'Attendance settings define the default register behavior for the school.',
        'students', 'Students', array['attendance']::text[], 'high', 'school_admin',
        case
          when not data.has_module_settings then 'needs_review'
          when not data.attendance_enabled then 'not_applicable'
          when data.has_attendance_settings then 'passed'
          else 'failed'
        end,
        not data.has_module_settings or data.attendance_enabled, true, '/settings?tab=attendance',
        case
          when not data.has_module_settings then 'Module settings are unavailable; attendance applicability cannot be confirmed.'
          when not data.attendance_enabled then 'The attendance module is disabled.'
          when data.has_attendance_settings then 'Attendance settings are configured.'
          else 'Configure attendance settings before taking registers.'
        end,
        null::integer
      ),
      (
        'academic_policies', 'Academic policies are configured', 'Grading and timetable policies support consistent academic reporting and scheduling.',
        'academic_years', 'Academic Years & Terms', array['timetable', 'reports']::text[], 'medium', 'school_admin',
        case when data.has_academic_policies then 'passed' else 'warning' end, true, false, '/settings?tab=academics',
        case when data.has_academic_policies then 'Academic policies are configured.' else 'Review academic policy defaults before publishing reports or timetables.' end,
        null::integer
      ),
      (
        'finance_module_status', 'Fee module status is known', 'Fee configuration is checked only when the school has enabled its finance module.',
        'fees', 'Fees & Finance', array['fees']::text[], 'informational', 'school_admin',
        case
          when not data.has_module_settings then 'needs_review'
          when data.finance_enabled then 'passed'
          else 'not_applicable'
        end,
        (not data.has_module_settings or data.finance_enabled), false, '/settings?tab=modules',
        case
          when not data.has_module_settings then 'Module settings are unavailable; fee readiness cannot be confirmed.'
          when data.finance_enabled then 'The fee module is enabled.'
          else 'The fee module is disabled; fee checks are not applicable.'
        end,
        null::integer
      ),
      (
        'fee_structures_exist', 'Active fee structures exist', 'At least one active fee structure is needed before the school can prepare fee invoices.',
        'fees', 'Fees & Finance', array['fees']::text[], 'critical', 'finance_manager',
        case
          when not data.has_module_settings then 'needs_review'
          when not data.finance_enabled then 'not_applicable'
          when data.active_fee_structure_count > 0 then 'passed'
          else 'failed'
        end,
        not data.has_module_settings or data.finance_enabled, true, '/finance',
        case
          when not data.has_module_settings then 'Module settings are unavailable; fee applicability cannot be confirmed.'
          when not data.finance_enabled then 'The fee module is disabled.'
          when data.active_fee_structure_count > 0 then 'Active fee structures are configured.'
          else 'Create an active fee structure before issuing fee invoices.'
        end,
        data.active_fee_structure_count
      ),
      (
        'fee_structure_year_links', 'Fee structures match the current academic year', 'Associating fee structures with the current academic year reduces the risk of issuing outdated fees.',
        'fees', 'Fees & Finance', array['fees']::text[], 'medium', 'finance_manager',
        case
          when not data.has_module_settings then 'needs_review'
          when not data.finance_enabled then 'not_applicable'
          when data.active_fee_structure_count = 0 then 'not_applicable'
          when not data.has_current_year then 'needs_review'
          when data.fee_structures_outside_current_year_count > 0 then 'warning'
          else 'passed'
        end,
        not data.has_module_settings or (data.finance_enabled and data.active_fee_structure_count > 0),
        false, '/finance',
        case
          when not data.has_module_settings then 'Module settings are unavailable; fee applicability cannot be confirmed.'
          when not data.finance_enabled then 'The fee module is disabled.'
          when data.active_fee_structure_count = 0 then 'Create fee structures before checking their year associations.'
          when not data.has_current_year then 'Select a current academic year before checking fee associations.'
          when data.fee_structures_outside_current_year_count > 0 then 'Review active fee structures not linked to the current academic year.'
          else 'Active fee structures match the current academic year.'
        end,
        data.fee_structures_outside_current_year_count
      ),
      (
        'website_enabled', 'School website publication status', 'The school website is optional and is assessed only when it is enabled.',
        'website', 'Website', array[]::text[], 'informational', 'school_admin',
        case when coalesce(data.website_enabled, false) then 'passed' else 'not_applicable' end,
        coalesce(data.website_enabled, false), false, '/website-management',
        case when coalesce(data.website_enabled, false) then 'The school website is enabled.' else 'The school website is disabled; website checks are not applicable.' end,
        null::integer
      ),
      (
        'website_homepage_content', 'Website homepage content is configured', 'The enabled public website should have a homepage title.',
        'website', 'Website', array[]::text[], 'medium', 'website_editor',
        case
          when coalesce(data.website_enabled, false) and coalesce(data.has_website_homepage_title, false) then 'passed'
          when coalesce(data.website_enabled, false) then 'warning'
          else 'not_applicable'
        end,
        coalesce(data.website_enabled, false), false, '/website-management',
        case
          when not coalesce(data.website_enabled, false) then 'The school website is disabled.'
          when coalesce(data.has_website_homepage_title, false) then 'Homepage title is configured.'
          else 'Add a homepage title before sharing the public website.'
        end,
        null::integer
      ),
      (
        'website_public_contact', 'Website has public contact details', 'Public contact information makes the enabled school website usable for families.',
        'website', 'Website', array[]::text[], 'low', 'school_admin',
        case
          when not coalesce(data.website_enabled, false) then 'not_applicable'
          when data.has_contact then 'passed'
          else 'warning'
        end,
        coalesce(data.website_enabled, false), false, '/settings?tab=profile',
        case
          when not coalesce(data.website_enabled, false) then 'The school website is disabled.'
          when data.has_contact then 'School contact information is available for the website.'
          else 'Add a public contact email or phone number to the school profile.'
        end,
        null::integer
      )
    ) as rule(
      rule_key, name, description, category, category_label, workflows, severity, owner_role,
      status, is_applicable, blocks_workflow, fix_route, result_message, affected_count
    )
  )
  select
    configured_rules.rule_key::text,
    configured_rules.name::text,
    configured_rules.description::text,
    configured_rules.category::text,
    configured_rules.category_label::text,
    configured_rules.workflows::text[],
    configured_rules.severity::text,
    configured_rules.owner_role::text,
    configured_rules.status::text,
    configured_rules.is_applicable::boolean,
    configured_rules.blocks_workflow::boolean,
    configured_rules.fix_route::text,
    configured_rules.result_message::text,
    configured_rules.affected_count::integer
  from configured_rules;
$$;
revoke all on function public.evaluate_school_setup_health_rules(uuid) from public, anon, authenticated;

create or replace function public.school_setup_health_weight(target_severity text)
returns numeric
language sql
immutable
set search_path = pg_catalog
as $$
  select case target_severity
    when 'critical' then 5
    when 'high' then 3
    when 'medium' then 2
    when 'low' then 1
    else 0
  end::numeric;
$$;
revoke all on function public.school_setup_health_weight(text) from public, anon, authenticated;

create or replace function public.run_school_setup_health_check(target_school uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_run_id uuid;
  score numeric(5, 1);
  applicable_count integer;
  completed_count integer;
  failed_count integer;
  critical_blocker_count integer;
  warning_count integer;
  readiness_label text;
  category_summary jsonb;
  workflow_summary jsonb;
  check_summary jsonb;
  result_summary jsonb;
  evaluation_time timestamptz := now();
begin
  if auth.uid() is null
    or not public.has_school_role(target_school, array['school_admin', 'academic_coordinator']::public.app_role[]) then
    raise exception 'A school administrator or academic coordinator membership is required to run this health check.';
  end if;

  insert into public.school_setup_health_runs(school_id, requested_by, status)
  values (target_school, auth.uid(), 'running')
  returning id into new_run_id;

  insert into public.school_setup_health_results(
    school_id, run_id, rule_key, name, description, category, category_label, workflows,
    severity, owner_role, status, is_applicable, blocks_workflow, fix_route,
    result_message, affected_count, checked_at
  )
  select target_school, new_run_id, rule.rule_key, rule.name, rule.description,
    rule.category, rule.category_label, rule.workflows, rule.severity, rule.owner_role,
    rule.status, rule.is_applicable, rule.blocks_workflow, rule.fix_route,
    rule.result_message, rule.affected_count, evaluation_time
  from public.evaluate_school_setup_health_rules(target_school) rule;

  select
    round(
      100.0 * coalesce(sum(
        case result.status
          when 'passed' then public.school_setup_health_weight(result.severity)
          when 'warning' then 0.5 * public.school_setup_health_weight(result.severity)
          when 'needs_review' then 0.5 * public.school_setup_health_weight(result.severity)
          else 0
        end
      ), 0) / nullif(sum(case when result.is_applicable then
        public.school_setup_health_weight(result.severity)
      else 0 end), 0), 1),
    count(*) filter (where result.is_applicable)::integer,
    count(*) filter (where result.is_applicable and result.status = 'passed')::integer,
    count(*) filter (where result.is_applicable and result.status = 'failed')::integer,
    count(*) filter (
      where result.is_applicable and result.status = 'failed'
        and result.severity = 'critical' and result.blocks_workflow
    )::integer,
    count(*) filter (where result.is_applicable and result.status in ('warning', 'needs_review'))::integer
  into score, applicable_count, completed_count, failed_count, critical_blocker_count, warning_count
  from public.school_setup_health_results result
  where result.school_id = target_school and result.run_id = new_run_id;

  score := coalesce(score, 0);
  if applicable_count = 0 then
    readiness_label := 'Not Configured';
  elsif critical_blocker_count > 0 or score < 50 then
    readiness_label := 'Needs Attention';
  elsif score < 75 then
    readiness_label := 'Partially Ready';
  elsif score < 90 then
    readiness_label := 'Nearly Ready';
  else
    readiness_label := 'Ready';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'key', grouped.category,
    'label', grouped.category_label,
    'score', grouped.score,
    'status', grouped.readiness_status,
    'completed_checks', grouped.completed_checks,
    'total_checks', grouped.total_checks,
    'failed_checks', grouped.failed_checks,
    'warnings', grouped.warnings
  ) order by grouped.category_order), '[]'::jsonb)
  into category_summary
  from (
    select result.category, result.category_label,
      case result.category
        when 'school_profile' then 1 when 'academic_years' then 2 when 'classes' then 3
        when 'subjects' then 4 when 'staff' then 5 when 'students' then 6 when 'fees' then 7 else 8
      end as category_order,
      round(100.0 * coalesce(sum(
        case result.status
          when 'passed' then public.school_setup_health_weight(result.severity)
          when 'warning' then 0.5 * public.school_setup_health_weight(result.severity)
          when 'needs_review' then 0.5 * public.school_setup_health_weight(result.severity)
          else 0
        end
      ), 0) / nullif(sum(case when result.is_applicable then public.school_setup_health_weight(result.severity) else 0 end), 0), 1) as score,
      count(*) filter (where result.is_applicable and result.status = 'passed')::integer as completed_checks,
      count(*) filter (where result.is_applicable)::integer as total_checks,
      count(*) filter (where result.is_applicable and result.status = 'failed')::integer as failed_checks,
      count(*) filter (where result.is_applicable and result.status in ('warning', 'needs_review'))::integer as warnings,
      case
        when count(*) filter (where result.is_applicable) = 0 then 'Not Applicable'
        when count(*) filter (where result.is_applicable and result.status = 'failed' and result.severity = 'critical' and result.blocks_workflow) > 0 then 'Needs Attention'
        when round(100.0 * coalesce(sum(
          case result.status
            when 'passed' then public.school_setup_health_weight(result.severity)
            when 'warning' then 0.5 * public.school_setup_health_weight(result.severity)
            when 'needs_review' then 0.5 * public.school_setup_health_weight(result.severity)
            else 0
          end
        ), 0) / nullif(sum(case when result.is_applicable then public.school_setup_health_weight(result.severity) else 0 end), 0), 1) >= 90 then 'Ready'
        when round(100.0 * coalesce(sum(
          case result.status
            when 'passed' then public.school_setup_health_weight(result.severity)
            when 'warning' then 0.5 * public.school_setup_health_weight(result.severity)
            when 'needs_review' then 0.5 * public.school_setup_health_weight(result.severity)
            else 0
          end
        ), 0) / nullif(sum(case when result.is_applicable then public.school_setup_health_weight(result.severity) else 0 end), 0), 1) >= 75 then 'Nearly Ready'
        else 'Partially Ready'
      end as readiness_status
    from public.school_setup_health_results result
    where result.school_id = target_school and result.run_id = new_run_id
    group by result.category, result.category_label
  ) grouped;

  select coalesce(jsonb_agg(jsonb_build_object(
    'key', grouped.workflow,
    'label', grouped.workflow_label,
    'description', grouped.workflow_description,
    'score', case when grouped.is_disabled then null else grouped.score end,
    'status', grouped.readiness_status,
    'completed_checks', case when grouped.is_disabled then 0 else grouped.completed_checks end,
    'total_checks', case when grouped.is_disabled then 0 else grouped.total_checks end,
    'blockers', case when grouped.is_disabled then 0 else grouped.blockers end,
    'warnings', case when grouped.is_disabled then 0 else grouped.warnings end
  ) order by grouped.workflow_order), '[]'::jsonb)
  into workflow_summary
  from (
    select workflow.workflow, workflow.workflow_label, workflow.workflow_description,
      workflow.workflow_order,
      coalesce(bool_or(result.rule_key = workflow.module_rule_key and result.status = 'not_applicable'), false) as is_disabled,
      round(100.0 * coalesce(sum(
        case result.status
          when 'passed' then public.school_setup_health_weight(result.severity)
          when 'warning' then 0.5 * public.school_setup_health_weight(result.severity)
          when 'needs_review' then 0.5 * public.school_setup_health_weight(result.severity)
          else 0
        end
      ), 0) / nullif(sum(case when result.is_applicable then public.school_setup_health_weight(result.severity) else 0 end), 0), 1) as score,
      count(*) filter (where result.is_applicable and result.status = 'passed')::integer as completed_checks,
      count(*) filter (where result.is_applicable)::integer as total_checks,
      count(*) filter (where result.is_applicable and result.status = 'failed' and result.blocks_workflow)::integer as blockers,
      count(*) filter (where result.is_applicable and result.status in ('warning', 'needs_review'))::integer as warnings,
      case
        when bool_or(result.rule_key = workflow.module_rule_key and result.status = 'not_applicable') then 'Module Disabled'
        when count(*) filter (where result.is_applicable) = 0 then 'Not Applicable'
        when count(*) filter (where result.is_applicable and result.status = 'failed' and result.blocks_workflow) > 0 then 'Needs Attention'
        when round(100.0 * coalesce(sum(
          case result.status
            when 'passed' then public.school_setup_health_weight(result.severity)
            when 'warning' then 0.5 * public.school_setup_health_weight(result.severity)
            when 'needs_review' then 0.5 * public.school_setup_health_weight(result.severity)
            else 0
          end
        ), 0) / nullif(sum(case when result.is_applicable then public.school_setup_health_weight(result.severity) else 0 end), 0), 1) >= 90 then 'Ready'
        when round(100.0 * coalesce(sum(
          case result.status
            when 'passed' then public.school_setup_health_weight(result.severity)
            when 'warning' then 0.5 * public.school_setup_health_weight(result.severity)
            when 'needs_review' then 0.5 * public.school_setup_health_weight(result.severity)
            else 0
          end
        ), 0) / nullif(sum(case when result.is_applicable then public.school_setup_health_weight(result.severity) else 0 end), 0), 1) >= 75 then 'Nearly Ready'
        else 'Partially Ready'
      end as readiness_status
    from (
      select 'timetable'::text as workflow, 'Timetable'::text as workflow_label, 'Can the school prepare and publish a usable timetable?'::text as workflow_description, 1 as workflow_order, 'timetable_module_status'::text as module_rule_key
      union all select 'attendance', 'Attendance registers', 'Can staff take class registers with the current school setup?', 2, 'attendance_module_status'
      union all select 'reports', 'Reports', 'Is the core academic structure ready for common reports?', 3, 'reports_module_status'
      union all select 'fees', 'Fees', 'Can finance staff prepare fee invoices?', 4, 'finance_module_status'
      union all select 'daily_operations', 'Daily operations', 'Are the core school identity, people and class records available?', 5, null
    ) workflow
    join public.school_setup_health_results result
      on result.school_id = target_school and result.run_id = new_run_id
      and workflow.workflow = any(result.workflows)
    group by workflow.workflow, workflow.workflow_label, workflow.workflow_description,
      workflow.workflow_order, workflow.module_rule_key
  ) grouped;

  select coalesce(jsonb_agg(jsonb_build_object(
    'rule_key', result.rule_key,
    'name', result.name,
    'description', result.description,
    'category', result.category,
    'category_label', result.category_label,
    'workflows', result.workflows,
    'severity', result.severity,
    'owner_role', result.owner_role,
    'status', result.status,
    'is_applicable', result.is_applicable,
    'blocks_workflow', result.blocks_workflow,
    'fix_route', result.fix_route,
    'result_message', result.result_message,
    'affected_count', result.affected_count,
    'checked_at', result.checked_at
  ) order by result.category, result.rule_key), '[]'::jsonb)
  into check_summary
  from public.school_setup_health_results result
  where result.school_id = target_school and result.run_id = new_run_id;

  select jsonb_build_object(
    'has_run', true,
    'run_id', new_run_id,
    'readiness_score', score,
    'readiness_status', readiness_label,
    'completed_checks', completed_count,
    'total_checks', applicable_count,
    'failed_checks', failed_count,
    'critical_blockers', critical_blocker_count,
    'warnings', warning_count,
    'stale', false,
    'last_checked_at', evaluation_time,
    'categories', category_summary,
    'workflows', workflow_summary,
    'checks', check_summary,
    'scoring_formula', 'Passed checks earn their severity weight; Warning and Needs Review earn half; Failed checks earn zero; Not Applicable checks are excluded. Weights: critical 5, high 3, medium 2, low 1, informational 0.'
  )
  into result_summary;

  update public.school_setup_health_runs
  set status = 'completed', completed_at = evaluation_time
  where id = new_run_id and school_id = target_school;

  insert into public.school_setup_health_state(school_id, latest_run_id, summary, is_stale, evaluated_at)
  values (target_school, new_run_id, result_summary, false, evaluation_time)
  on conflict (school_id) do update
  set latest_run_id = excluded.latest_run_id,
      summary = excluded.summary,
      is_stale = false,
      evaluated_at = excluded.evaluated_at;

  return result_summary;
end;
$$;
revoke all on function public.run_school_setup_health_check(uuid) from public, anon;
grant execute on function public.run_school_setup_health_check(uuid) to authenticated;

create or replace function public.get_school_setup_health(target_school uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  current_summary jsonb;
  summary_stale boolean;
begin
  if auth.uid() is null
    or not public.has_school_role(target_school, array['school_admin', 'academic_coordinator']::public.app_role[]) then
    raise exception 'A school administrator or academic coordinator membership is required to view setup health.';
  end if;

  select state.summary,
    state.is_stale or state.evaluated_at < now() - interval '24 hours'
  into current_summary, summary_stale
  from public.school_setup_health_state state
  where state.school_id = target_school;

  if current_summary is null then
    return jsonb_build_object(
      'has_run', false,
      'stale', false,
      'categories', '[]'::jsonb,
      'workflows', '[]'::jsonb,
      'checks', '[]'::jsonb
    );
  end if;

  return jsonb_set(current_summary, '{stale}', to_jsonb(summary_stale), true);
end;
$$;
revoke all on function public.get_school_setup_health(uuid) from public, anon;
grant execute on function public.get_school_setup_health(uuid) to authenticated;

create or replace function public.platform_owner_setup_health_overview()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'totalSchools', count(school.id)::integer,
    'checkedSchools', count(state.school_id)::integer,
    'staleSchools', (count(state.school_id) filter (
      where state.is_stale or state.evaluated_at < now() - interval '24 hours'
    ))::integer,
    'schools', coalesce(jsonb_agg(jsonb_build_object(
      'schoolId', school.id,
      'schoolName', school.name,
      'score', case when state.school_id is null then null
        else nullif(state.summary ->> 'readiness_score', '')::numeric end,
      'status', coalesce(state.summary ->> 'readiness_status', 'Not checked'),
      'stale', state.school_id is not null and (
        state.is_stale or state.evaluated_at < now() - interval '24 hours'
      ),
      'lastCheckedAt', state.evaluated_at
    ) order by
      (state.school_id is null) desc,
      (state.is_stale or state.evaluated_at < now() - interval '24 hours') desc,
      nullif(state.summary ->> 'readiness_score', '')::numeric asc nulls first,
      school.name
    ), '[]'::jsonb)
  )
  from public.schools school
  left join public.school_setup_health_state state on state.school_id = school.id;
$$;
revoke all on function public.platform_owner_setup_health_overview() from public, anon, authenticated;
grant execute on function public.platform_owner_setup_health_overview() to service_role;

create or replace function public.mark_school_setup_health_stale()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed_row jsonb;
  target_school uuid;
begin
  changed_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  target_school := coalesce(
    nullif(changed_row ->> 'school_id', '')::uuid,
    nullif(changed_row ->> 'id', '')::uuid
  );
  if target_school is not null then
    update public.school_setup_health_state
    set is_stale = true
    where school_id = target_school;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.mark_school_setup_health_stale() from public, anon, authenticated;

do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'schools', 'academic_years', 'terms', 'school_classes', 'class_students',
    'students', 'subjects', 'class_subjects', 'teacher_profiles',
    'teacher_class_assignments', 'teacher_subjects', 'staff_profiles',
    'school_module_settings', 'school_academic_policies', 'attendance_settings',
    'fee_structures', 'school_websites'
  ] loop
    execute format(
      'create trigger mark_school_setup_health_stale after insert or update or delete on public.%I for each row execute function public.mark_school_setup_health_stale()',
      target_table
    );
  end loop;
end;
$$;

notify pgrst, 'reload schema';
