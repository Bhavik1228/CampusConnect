import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin, Access-Control-Request-Headers',
};

const ticketCategories = new Set([
  'account_access', 'academics', 'attendance', 'finance', 'technical', 'other',
]);
const moduleSettingsColumns: Record<string, string> = {
  admissions: 'module_admissions',
  attendance: 'module_attendance',
  timetable: 'module_timetable',
  learning: 'module_learning',
  assignments: 'module_assignments',
  grades: 'module_assessment_results',
  finance: 'module_finance',
  messaging: 'module_messaging',
  library: 'module_library',
  calendar: 'module_calendar',
  health: 'module_health',
  visitors: 'module_visitors',
  automations: 'module_automations',
};
const supportFeatures: Record<string, { name: string; category: string; module: string | null; maintenanceModule?: string; route: string }> = {
  APL: { name: 'Academic planning', category: 'academics', module: 'academics', route: '/academic-planning' },
  ACL: { name: 'Academic calendar', category: 'academics', module: 'calendar', route: '/academic-calendar' },
  CAL: { name: 'Calendar', category: 'academics', module: 'calendar', route: '/calendar' },
  TMT: { name: 'Timetable', category: 'academics', module: 'timetable', route: '/timetable' },
  ATT: { name: 'Attendance', category: 'attendance', module: 'attendance', route: '/attendance' },
  ASM: { name: 'Assessments and results', category: 'academics', module: 'grades', route: '/grades-results' },
  FIN: { name: 'Finance', category: 'finance', module: 'finance', route: '/finance' },
  ADM: { name: 'Admissions', category: 'academics', module: 'admissions', route: '/admissions' },
  STU: { name: 'Student records', category: 'academics', module: 'students', route: '/students' },
  STF: { name: 'Staff and teachers', category: 'academics', module: 'staff', route: '/staff' },
  LIB: { name: 'Library', category: 'academics', module: 'library', route: '/library' },
  HLT: { name: 'Student health', category: 'other', module: 'health', route: '/health' },
  VIS: { name: 'Visitor management', category: 'other', module: 'visitors', route: '/visitors' },
  ASN: { name: 'Assignments', category: 'academics', module: 'assignments', route: '/assignments' },
  LMT: { name: 'Learning materials', category: 'academics', module: 'learning', route: '/learning-materials' },
  CRS: { name: 'Courses and lessons', category: 'academics', module: 'learning', route: '/courses-lessons' },
  LRN: { name: 'Learning and assessments', category: 'academics', module: 'learning', route: '/learning' },
  MSG: { name: 'Messaging', category: 'other', module: 'messaging', route: '/messaging' },
  AUT: { name: 'Automations', category: 'academics', module: 'automations', maintenanceModule: 'communication', route: '/automations' },
  SET: { name: 'Setup and data health', category: 'academics', module: null, route: '/setup-health' },
  PER: { name: 'Roles and permissions', category: 'account_access', module: null, route: '/permissions' },
  CFG: { name: 'School settings', category: 'other', module: null, route: '/settings' },
  DSH: { name: 'Dashboard', category: 'other', module: null, route: '/dashboard' },
  SUP: { name: 'Support Bot', category: 'technical', module: null, route: '/support' },
  WSP: { name: 'School workspace', category: 'technical', module: null, route: '/dashboard' },
  OWN: { name: 'Platform owner tools', category: 'technical', module: null, route: '/system-owner' },
  ACD: { name: 'Classes and subjects', category: 'academics', module: 'academics', route: '/classes' },
  WEB: { name: 'Website management', category: 'other', module: null, route: '/website-management' },
  WRK: { name: 'Administrative workflows', category: 'other', module: null, route: '/admin-workflows' },
  AST: { name: 'Accounting staff', category: 'finance', module: 'finance', route: '/accounting-staff' },
  SEC: { name: 'Account security', category: 'account_access', module: null, route: '/account-security' },
  PBL: { name: 'Public school website', category: 'other', module: null, route: '/dashboard' },
  AUD: { name: 'Audit log', category: 'account_access', module: null, route: '/audit-log' },
  DOC: { name: 'Document verification', category: 'other', module: null, route: '/dashboard' },
};
const diagnosticGuides: Record<string, { answer: string; steps: string[] }> = {
  AUTH: {
    answer: 'This code indicates that the feature could not confirm your sign-in session. Your school data was not changed by the diagnostic check.',
    steps: ['Refresh your sign-in and confirm you are using the intended account.', 'Return to the feature and retry the action once.'],
  },
  ACCESS: {
    answer: 'This code indicates that the action was refused by an access check. The feature may be restricted for your role or school.',
    steps: ['Confirm that you are in the correct school workspace.', 'Ask a school administrator to verify your role and access to this feature.'],
  },
  NETWORK: {
    answer: 'This code indicates that the app did not receive a timely response. A save may still have reached the service, so check the record before repeating a change.',
    steps: ['Check your connection and refresh the feature.', 'Verify whether the action completed before retrying, especially for payments or other changes.'],
  },
  DUPLICATE: {
    answer: 'This code indicates that the service rejected a duplicate value or record.',
    steps: ['Search the feature for an existing record with the same identifier or unique value.', 'If the existing record is unexpected, do not create another; include its details in a support request.'],
  },
  RELATED: {
    answer: 'This code indicates that a record this action depends on could not be found or linked.',
    steps: ['Confirm that the related student, class, school year, or other required record still exists.', 'If the related record is present, retry once; otherwise ask a school administrator to check the data.'],
  },
  MAINTENANCE: {
    answer: 'This code indicates that the feature may be temporarily unavailable or read-only during maintenance.',
    steps: ['Check the live status shown below and wait until maintenance ends before retrying.', 'Do not repeat a change if its completion status is uncertain.'],
  },
  INPUT: {
    answer: 'This code indicates that one or more values did not meet the feature’s validation rules.',
    steps: ['Review required fields, allowed values, and any limits shown by the feature.', 'Correct the values and retry the action.'],
  },
  UNEXPECTED: {
    answer: 'This feature error does not match a known recoverable cause. The live checks below can identify access or availability problems without repeating the failed action.',
    steps: ['Check that you are in the intended school workspace and that the feature is available.', 'Use “Retry the feature” only after confirming the original action did not already complete.'],
  },
};

const questionGuides: Array<{ keywords: string[]; feature: string; answer: string; steps: string[] }> = [
  { keywords: ['attendance', 'absent', 'late', 'register'], feature: 'ATT', answer: 'Attendance records are submitted from the Attendance workspace. A register may be unavailable when its class or school day is not configured, or when your role cannot edit it.', steps: ['Open Attendance and confirm the class and date.', 'Check whether the register is already submitted or locked.', 'If the save still fails, retry from the error link so the exact error code is included.'] },
  { keywords: ['calendar', 'term', 'holiday', 'school day'], feature: 'ACL', answer: 'The academic calendar defines school terms, teaching days, closures, and dates used by attendance and timetables.', steps: ['Confirm the correct academic year and calendar are selected.', 'Check whether the date falls within a term or is marked as a closure.', 'Ask a school administrator or academic coordinator to change calendar settings if you do not have access.'] },
  { keywords: ['timetable', 'schedule', 'period', 'lesson'], feature: 'TMT', answer: 'Timetables depend on the school calendar, teaching periods, teacher/class assignments, and publication status.', steps: ['Open Timetable and confirm the correct academic year and cycle.', 'Check that periods and teacher-subject assignments exist before generating a schedule.', 'If the displayed error remains, retry the feature and the bot will send the repeated failure to the platform owner.'] },
  { keywords: ['finance', 'fee', 'invoice', 'payment'], feature: 'FIN', answer: 'Finance actions depend on your school role and the fee or payment record being in a valid state. A failed save does not confirm that a payment or fee change was recorded.', steps: ['Refresh the finance page and check the record before repeating a payment action.', 'Ask a school administrator to confirm finance permissions if the action is unavailable.', 'Do not submit a payment twice while its status is uncertain.'] },
  { keywords: ['admission', 'enrol', 'applicant'], feature: 'ADM', answer: 'Admissions records are managed in Admissions & enrolment. Some status changes require school-administrator access and valid applicant details.', steps: ['Open the applicant and review any required fields.', 'Confirm your role is allowed to perform this status change.', 'Retry the failed action once after refreshing the page.'] },
  { keywords: ['assignment', 'homework', 'submission', 'grade', 'result', 'assessment'], feature: 'ASN', answer: 'Assignments and results are scoped to the school, class, and assigned teacher. Publishing and grading actions require the relevant role and an open assessment.', steps: ['Confirm the correct class and assessment are selected.', 'Check whether the item is published, closed, or already graded.', 'Refresh and retry once; a repeated error is escalated with its feature code.'] },
  { keywords: ['library', 'book', 'borrow', 'catalog'], feature: 'LIB', answer: 'Library records and circulation are school-scoped. A book may be unavailable because it is already checked out, archived, or not visible to your role.', steps: ['Refresh the book record and check its current availability.', 'Confirm the correct school library is selected.', 'Retry once after confirming the record state.'] },
  { keywords: ['health', 'nurse', 'medical'], feature: 'HLT', answer: 'Student health records are restricted to authorized healthcare roles and school administrators. A permission error prevents the record from being opened or changed.', steps: ['Confirm that you are in the correct school workspace.', 'Ask the school administrator to verify your health-module access.', 'Do not include student medical details in a general support question.'] },
  { keywords: ['visitor', 'check in', 'check-in', 'visitor badge'], feature: 'VIS', answer: 'Visitor check-in records and badges are managed by the school visitor workspace. The feature may be disabled or restricted to designated school staff.', steps: ['Confirm the visitor is not already checked in.', 'Refresh the visitor record before changing its status.', 'Ask a school administrator to verify visitor-module access if the action is unavailable.'] },
  { keywords: ['file', 'upload', 'learning material', 'resource'], feature: 'LMT', answer: 'Learning-material uploads use school/class visibility rules and the configured storage connection. A failed upload is not complete until the app confirms it.', steps: ['Confirm the file type and size are supported.', 'Check your connection and retry the upload once.', 'Ask a school administrator to verify school storage configuration if it fails again.'] },
  { keywords: ['automation', 'workflow', 'trigger'], feature: 'AUT', answer: 'School automations run only for enabled workflows, permitted roles, and supported event triggers. A test run checks configuration without sending or publishing actions.', steps: ['Open Automations and confirm the workflow is enabled.', 'Run “Test configuration” to inspect its conditions without performing actions.', 'Check run history for the failed step and retry after correcting its configuration.'] },
  { keywords: ['login', 'password', 'account', 'session', 'sign in', 'access'], feature: 'SEC', answer: 'Access issues are often caused by an expired sign-in session, the wrong active school, or a role that does not permit the action.', steps: ['The bot can refresh your sign-in and school membership safely.', 'If your role still cannot access the action, a school administrator must change the permission.'] },
  { keywords: ['message', 'messaging', 'notification', 'announcement'], feature: 'MSG', answer: 'Messages and notifications are scoped to your account and school. Delivery can also depend on school communication settings and enabled channels.', steps: ['Refresh the message list and confirm the intended recipients.', 'Check with a school administrator if the communication feature is disabled.', 'Retry once; report the error code if it persists.'] },
  { keywords: ['staff', 'teacher', 'employee'], feature: 'STF', answer: 'Staff records and invitations require the appropriate school-administrator permissions and a unique account or employee number.', steps: ['Confirm the staff member does not already have a school account or duplicate employee number.', 'Ask a school administrator to verify your role.', 'Retry after refreshing the staff page.'] },
  { keywords: ['class', 'subject', 'academic year', 'term'], feature: 'ACD', answer: 'Classes, subjects, and terms are linked to the school academic year. Changes can be blocked when the year is missing or the record is already in use.', steps: ['Confirm the correct academic year is selected.', 'Check that related classes or subjects are not already linked to another record.', 'Retry once after refreshing the workspace.'] },
  { keywords: ['website', 'web page', 'publish'], feature: 'WEB', answer: 'School website editing and publishing are separate permissions; editors can prepare content, while publishing may require a publisher or administrator.', steps: ['Save the draft and confirm your website role.', 'Ask a school administrator or publisher to publish if that action is unavailable.', 'Retry the save once after refreshing.'] },
  { keywords: ['setup', 'data health', 'school readiness'], feature: 'SET', answer: 'Setup and Data Health checks school configuration for missing or inconsistent setup records. Only school administrators and academic coordinators can run the detailed checks.', steps: ['Open Setup & Data Health if your role allows it.', 'Review the affected setup item and correct it in its school settings or academic workspace.', 'Run the check again to confirm the issue is resolved.'] },
  { keywords: ['audit', 'audit log', 'history'], feature: 'AUD', answer: 'The audit log records selected school changes and is visible only to authorized school administrators and audit/compliance roles.', steps: ['Confirm the correct school and date range are selected.', 'Ask a school administrator to verify your audit-log permission if access is denied.', 'Refresh the log and retry the search.'] },
];

type SupportRequest = {
  action?: unknown;
  schoolId?: unknown;
  eventId?: unknown;
  errorCode?: unknown;
  query?: unknown;
  code?: unknown;
  feature?: unknown;
  errorMessage?: unknown;
  from?: unknown;
  category?: unknown;
  title?: unknown;
  description?: unknown;
};

function respond(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractErrorCode(value: string) {
  return value.match(/\bCC-([A-Z0-9]{2,8})-(?:([A-Z]{3,12})-([A-F0-9]{8})|([A-F0-9]{8}))\b/i);
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return respond(405, { error: 'Method not allowed.' });

  try {
    const accessToken = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!accessToken) return respond(401, { error: 'Sign in to use Campus Connect support.' });

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      throw new Error('Support service configuration is incomplete.');
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser(accessToken);
    if (authError || !user) return respond(401, { error: 'Your session is invalid. Sign in again.' });

    const payload = await request.json() as SupportRequest;
    if (!isUuid(payload.schoolId)) return respond(400, { error: 'Choose a valid school workspace.' });

    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: membership, error: membershipError } = await serviceClient
      .from('school_memberships')
      .select('role, school:schools!inner(id,name,platform_status)')
      .eq('school_id', payload.schoolId)
      .eq('profile_id', user.id)
      .maybeSingle();
    if (membershipError) throw membershipError;
    if (!membership || !isRecord(membership.school)) {
      return respond(403, { error: 'Your account does not have access to this school workspace.' });
    }
    if (membership.school.platform_status !== 'active') {
      return respond(423, { error: 'This school workspace is currently suspended.' });
    }
    const role = membership.role;
    const schoolName = membership.school.name;

    if (payload.action === 'record-error-event') {
      if (!isUuid(payload.eventId) || typeof payload.errorCode !== 'string') {
        return respond(400, { error: 'Provide a valid diagnostic event.' });
      }
      const codeMatch = payload.errorCode.match(
        /^CC-([A-Z0-9]{2,8})-([A-Z]{3,12})-([A-F0-9]{8})$/,
      );
      if (!codeMatch) return respond(400, { error: 'The diagnostic error code is invalid.' });

      const [, featureCode, errorKind] = codeMatch;
      const severityByKind: Record<string, string> = {
        UNEXPECTED: 'high',
        AUTH: 'medium',
        ACCESS: 'medium',
        NETWORK: 'medium',
        RELATED: 'medium',
        DUPLICATE: 'low',
        MAINTENANCE: 'low',
        INPUT: 'low',
      };
      const severity = severityByKind[errorKind];
      if (!severity) return respond(400, { error: 'The diagnostic error category is invalid.' });

      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { count, error: rateLimitError } = await serviceClient
        .from('application_error_events')
        .select('event_id', { count: 'exact', head: true })
        .eq('reporter_id', user.id)
        .gte('created_at', tenMinutesAgo);
      if (rateLimitError) throw rateLimitError;
      if ((count ?? 0) >= 30) return respond(429, { error: 'Too many diagnostic events. Try again later.' });

      const { error: insertError } = await serviceClient
        .from('application_error_events')
        .upsert({
          event_id: payload.eventId,
          school_id: payload.schoolId,
          reporter_id: user.id,
          error_code: payload.errorCode,
          feature_code: featureCode,
          error_kind: errorKind,
          severity,
        }, { onConflict: 'event_id', ignoreDuplicates: true });
      if (insertError) throw insertError;

      const retentionCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      const { error: retentionError } = await serviceClient
        .from('application_error_events')
        .delete()
        .lt('created_at', retentionCutoff);
      if (retentionError) throw retentionError;
      return respond(202, { recorded: true });
    }

    const createTicket = async (category: string, title: string, description: string) => {
      if (!ticketCategories.has(category)) throw new Error('The support request category is invalid.');
      const requesterName = typeof user.user_metadata.full_name === 'string' && user.user_metadata.full_name.trim()
        ? user.user_metadata.full_name.trim().slice(0, 120)
        : user.email ?? 'Campus Connect user';
      const { data: ticket, error: insertError } = await serviceClient
        .from('support_tickets')
        .insert({
          school_id: payload.schoolId,
          school_name: schoolName,
          requester_id: user.id,
          requester_name: requesterName,
          requester_email: user.email ?? null,
          requester_role: role,
          category,
          title: title.slice(0, 120),
          description: description.slice(0, 5000),
        })
        .select('id,category,title,description,status,owner_response,created_at,updated_at')
        .single();
      if (insertError) throw insertError;
      return ticket;
    };

    if (payload.action === 'assist') {
      const query = typeof payload.query === 'string' ? payload.query.trim() : '';
      const errorMessage = typeof payload.errorMessage === 'string' ? payload.errorMessage.trim() : '';
      const pastedCode = typeof payload.code === 'string' ? payload.code.trim() : '';
      if (query.length > 1000 || errorMessage.length > 1000 || pastedCode.length > 64) {
        return respond(400, { error: 'Keep the question and error details under 1,000 characters.' });
      }

      const codeMatch = extractErrorCode(pastedCode) ?? extractErrorCode(query);
      const hasUnknownCode = /\bCC-/i.test(pastedCode || query)
        && (!codeMatch
          || !supportFeatures[codeMatch[1].toUpperCase()]
          || (codeMatch[2] !== undefined && !diagnosticGuides[codeMatch[2].toUpperCase()]));
      const feature = codeMatch ? supportFeatures[codeMatch[1].toUpperCase()] : undefined;
      const diagnosticGuide = codeMatch?.[2] ? diagnosticGuides[codeMatch[2].toUpperCase()] : undefined;
      const guide = feature
        ? questionGuides.find((item) => item.feature === codeMatch[1].toUpperCase())
        : questionGuides.find((item) => item.keywords.some((keyword) =>
          `${query} ${errorMessage}`.toLocaleLowerCase().includes(keyword)));
      const featureName = feature?.name
        ?? (guide ? supportFeatures[guide.feature].name : typeof payload.feature === 'string' ? payload.feature.slice(0, 100) : '');
      const code = codeMatch ? codeMatch[0].toUpperCase() : '';

      if (hasUnknownCode) {
        const unknownTicket = await createTicket(
          'technical',
          `Unrecognized feature error${code ? ` ${code}` : ''}`,
          `The Support Bot could not find this feature-specific error code.\nError code: ${pastedCode || code || 'not recognized'}\nFeature: ${featureName || 'Unknown feature'}\nWhat the user asked: ${query || '(no question provided)'}\nOriginal error: ${errorMessage || '(not provided)'}`,
        );
        return respond(200, {
          assistant: {
            answer: `I could not find a trusted explanation for ${pastedCode || code}. I have sent the error details to the platform owner automatically.`,
            steps: [],
            code,
            feature: featureName || 'Unknown feature',
            schoolName,
            checkedAt: new Date().toISOString(),
            liveStatus: 'available',
            safeFixAvailable: false,
            escalated: true,
            ticketId: unknownTicket.id,
            retryPath: null,
          },
        });
      }

      if (!codeMatch && !guide) {
        const unknownQuestionTicket = await createTicket(
          'technical',
          `Support Bot could not answer${featureName ? ` · ${featureName}` : ''}`,
          `The Support Bot could not confidently match this question to a supported feature guide.\nFeature: ${featureName || 'Unknown feature'}\nWhat the user asked: ${query || '(no question provided)'}\nOriginal error: ${errorMessage || '(not provided)'}`,
        );
        return respond(200, {
          assistant: {
            answer: 'I could not confidently identify this problem, so I sent your question and error details to the platform owner automatically.',
            steps: [],
            code,
            feature: featureName || 'School workspace',
            schoolName,
            checkedAt: new Date().toISOString(),
            liveStatus: 'available',
            safeFixAvailable: false,
            escalated: true,
            ticketId: unknownQuestionTicket.id,
            retryPath: null,
          },
        });
      }

      const selectedFeature = feature ?? (guide ? supportFeatures[guide.feature] : undefined);
      const { data: maintenance, error: maintenanceError } = await userClient.rpc('platform_maintenance_status', {
        target_school: payload.schoolId,
        target_module: selectedFeature?.maintenanceModule ?? selectedFeature?.module ?? null,
      });
      if (maintenanceError || !isRecord(maintenance)) {
        const reason = maintenanceError?.message ?? 'The live feature status check returned an invalid response.';
        const ticket = await createTicket(
          selectedFeature?.category ?? 'technical',
          `Support diagnostic failed${code ? ` · ${code}` : ''}`,
          `The Support Bot could not check the live status of ${featureName || 'the requested feature'}.\nError code: ${code || 'not provided'}\nUser question: ${query || '(not provided)'}\nOriginal feature error: ${errorMessage || '(not provided)'}\nDiagnostic failure: ${reason}`,
        );
        return respond(200, {
          assistant: {
            answer: 'The live feature check failed. I sent the original error and diagnostic failure to the platform owner automatically.',
            steps: [],
            code,
            feature: featureName || 'School workspace',
            schoolName,
            checkedAt: new Date().toISOString(),
            liveStatus: 'unavailable',
            safeFixAvailable: false,
            escalated: true,
            ticketId: ticket.id,
            retryPath: null,
          },
        });
      }

      let featureEnabled: boolean | null = null;
      if (selectedFeature?.module === 'health' && (role === 'nurse' || role === 'doctor')) {
        const { data, error: healthAccessError } = await userClient.rpc('health_access_enabled', {
          target_school: payload.schoolId,
        });
        if (healthAccessError) throw healthAccessError;
        if (typeof data !== 'boolean') throw new Error('The live health-feature check returned an invalid response.');
        featureEnabled = data;
      } else if (selectedFeature?.module === 'visitors' && role === 'secretary') {
        const { data, error: visitorAccessError } = await userClient.rpc('visitor_access_enabled', {
          target_school: payload.schoolId,
        });
        if (visitorAccessError) throw visitorAccessError;
        if (typeof data !== 'boolean') throw new Error('The live visitor-feature check returned an invalid response.');
        featureEnabled = data;
      } else if (selectedFeature?.module && moduleSettingsColumns[selectedFeature.module]) {
        const column = moduleSettingsColumns[selectedFeature.module];
        const { data, error: moduleError } = await userClient
          .from('school_module_settings')
          .select(column)
          .eq('school_id', payload.schoolId)
          .maybeSingle();
        if (moduleError) throw moduleError;
        if (!data || typeof data[column] !== 'boolean') {
          throw new Error('The live school-module check returned an invalid response.');
        }
        featureEnabled = data[column];
      }

      if (featureEnabled === false) {
        const ticket = await createTicket(
          selectedFeature?.category ?? 'technical',
          `Feature is disabled${code ? ` · ${code}` : ''}`,
          `The user reported a failure in ${featureName || 'a school feature'}, and the live school settings show that this feature is disabled.\nError code: ${code || 'not provided'}\nWhat the user asked: ${query || '(not provided)'}\nOriginal error: ${errorMessage || '(not provided)'}`,
        );
        return respond(200, {
          assistant: {
            answer: `${featureName} is currently disabled for ${schoolName}. I cannot enable a school feature on your behalf, so I sent this finding to the platform owner.`,
            steps: ['A school administrator can also review the school module settings if this feature should be enabled.'],
            code,
            feature: featureName || 'School feature',
            schoolName,
            checkedAt: new Date().toISOString(),
            liveStatus: 'unavailable',
            safeFixAvailable: false,
            escalated: true,
            ticketId: ticket.id,
            retryPath: null,
          },
        });
      }

      const fallbackAnswer = selectedFeature
        ? `${featureName} reported an error. I verified that your signed-in account still belongs to ${schoolName} and checked the live platform/module status. The failed feature action itself is not replayed automatically, so no school data is changed by this check.`
        : `I verified your signed-in ${role.replaceAll('_', ' ')} membership in ${schoolName} and checked the live platform status. Tell me which feature failed or paste its error code for more specific steps.`;
      const answer = diagnosticGuide?.answer ?? guide?.answer ?? fallbackAnswer;
      const steps = diagnosticGuide
        ? [...diagnosticGuide.steps, ...(guide?.steps ?? []).slice(0, 1)]
        : [...(guide?.steps ?? [
        'I will refresh your sign-in and school access, then recheck the feature status.',
        'Use “Retry the feature” to repeat the original page load. If the same error returns, it is sent to the platform owner automatically.',
        ])];
      if (maintenance.active === true) {
        steps.unshift('The platform reports active maintenance for this feature. Changes may be paused until maintenance ends.');
      }
      return respond(200, {
        assistant: {
          answer,
          steps,
          code,
          feature: featureName || 'School workspace',
          schoolName,
          checkedAt: new Date().toISOString(),
          liveStatus: maintenance.active === true ? 'maintenance' : 'available',
          safeFixAvailable: true,
          escalated: false,
          retryPath: typeof payload.from === 'string' && payload.from.startsWith('/') && !payload.from.startsWith('//')
            ? payload.from
            : selectedFeature?.route ?? null,
        },
      });
    }

    if (payload.action === 'auto-escalate') {
      const code = typeof payload.code === 'string' ? payload.code.trim().slice(0, 64) : '';
      const featureName = typeof payload.feature === 'string' ? payload.feature.trim().slice(0, 100) : '';
      const errorMessage = typeof payload.errorMessage === 'string' ? payload.errorMessage.trim().slice(0, 1000) : '';
      const query = typeof payload.query === 'string' ? payload.query.trim().slice(0, 1000) : '';
      const ticket = await createTicket(
        'technical',
        `Feature still failing${code ? ` · ${code}` : ''}`,
        `The Support Bot's safe recovery and feature retry did not resolve the problem.\nError code: ${code || 'not provided'}\nFeature: ${featureName || 'School workspace'}\nWhat the user asked: ${query || '(not provided)'}\nOriginal error: ${errorMessage || '(not provided)'}`,
      );
      return respond(201, { ticket });
    }

    if (payload.action === 'list-tickets') {
      const { data: tickets, error: ticketsError } = await serviceClient
        .from('support_tickets')
        .select('id,category,title,description,status,owner_response,created_at,updated_at')
        .eq('requester_id', user.id)
        .eq('school_id', payload.schoolId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (ticketsError) throw ticketsError;
      return respond(200, { tickets: tickets ?? [] });
    }

    if (payload.action === 'submit-ticket') {
      const category = typeof payload.category === 'string' ? payload.category : '';
      const title = typeof payload.title === 'string' ? payload.title.trim() : '';
      const description = typeof payload.description === 'string' ? payload.description.trim() : '';
      if (!ticketCategories.has(category)) return respond(400, { error: 'Choose a valid support category.' });
      if (title.length < 3 || title.length > 120) {
        return respond(400, { error: 'Enter a request title between 3 and 120 characters.' });
      }
      if (description.length < 10 || description.length > 5000) {
        return respond(400, { error: 'Describe the issue in 10 to 5,000 characters.' });
      }

      const ticket = await createTicket(category, title, description);
      return respond(201, { ticket });
    }

    return respond(400, { error: 'Unsupported support action.' });
  } catch (error) {
    console.error('Campus Connect support request failed.', error);
    return respond(500, {
      error: error instanceof Error ? error.message : 'The support request could not be completed.',
    });
  }
});
