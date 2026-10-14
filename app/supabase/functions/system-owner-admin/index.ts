import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin, Access-Control-Request-Headers',
};

type OwnerRequest = {
  action?: unknown;
  schoolId?: unknown;
  status?: unknown;
  requestId?: unknown;
  decision?: unknown;
  search?: unknown;
  statusFilter?: unknown;
  typeFilter?: unknown;
  sortField?: unknown;
  sortAscending?: unknown;
  page?: unknown;
  pageSize?: unknown;
  school?: unknown;
  adminEmail?: unknown;
  settings?: unknown;
  enabled?: unknown;
  readOnly?: unknown;
  emergency?: unknown;
  notice?: unknown;
  scope?: unknown;
  moduleKey?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
  windowId?: unknown;
};

const schoolTypes = ['primary', 'secondary', 'k12', 'university', 'other'];
const subscriptionStatuses = ['free', 'trial', 'active', 'past_due', 'cancelled'];
const maintenanceModules = [
  'academics', 'admissions', 'assignments', 'attendance', 'calendar',
  'communication', 'finance', 'grades', 'learning', 'messaging',
  'staff', 'students', 'timetable',
];

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

function isShortText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (request.method !== 'POST') return respond(405, { error: 'Method not allowed.' });

  try {
    const accessToken = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!accessToken) return respond(401, { error: 'Sign in to access the system owner panel.' });

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const ownerId = Deno.env.get('SYSTEM_OWNER_USER_ID');
    if (!supabaseUrl || !anonKey || !serviceRoleKey) throw new Error('System owner function configuration is incomplete.');
    if (!ownerId || !isUuid(ownerId)) throw new Error('Set SYSTEM_OWNER_USER_ID to the platform owner Supabase Auth user ID.');

    const userClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser(accessToken);
    if (authError || !user) return respond(401, { error: 'Your session is invalid. Sign in again.' });
    if (user.id !== ownerId) return respond(200, { authorized: false });

    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const payload = await request.json() as OwnerRequest;

    if (payload.action === 'check') return respond(200, { authorized: true });

    if (payload.action === 'dashboard') {
      const { data, error } = await serviceClient.rpc('platform_owner_dashboard');
      if (error) throw error;
      const managedStorageConfigured = Boolean(
        Deno.env.get('R2_ACCOUNT_ID')
        && Deno.env.get('R2_BUCKET_NAME')
        && Deno.env.get('R2_ACCESS_KEY_ID')
        && Deno.env.get('R2_SECRET_ACCESS_KEY'),
      );
      return respond(200, { dashboard: { ...data, managedStorageConfigured } });
    }

    if (payload.action === 'maintenance-dashboard') {
      const [
        { data: maintenance, error: maintenanceError },
        { data: status, error: statusError },
        { data: windows, error: windowsError },
        { data: schools, error: schoolsError },
      ] = await Promise.all([
        serviceClient.from('platform_maintenance').select('*').eq('id', 1).single(),
        serviceClient.rpc('platform_maintenance_status'),
        serviceClient.from('platform_maintenance_windows')
          .select('id,scope,school_id,module_key,starts_at,ends_at,read_only,notice,cancelled_at,created_at,school:schools(name)')
          .is('cancelled_at', null)
          .order('starts_at', { ascending: true })
          .limit(100),
        serviceClient.from('schools').select('id,name').order('name').limit(1000),
      ]);
      if (maintenanceError) throw maintenanceError;
      if (statusError) throw statusError;
      if (windowsError) throw windowsError;
      if (schoolsError) throw schoolsError;
      return respond(200, { maintenance, status, windows, schools, modules: maintenanceModules });
    }

    if (payload.action === 'set-global-maintenance') {
      if (typeof payload.enabled !== 'boolean'
        || typeof payload.readOnly !== 'boolean'
        || typeof payload.emergency !== 'boolean'
        || !isShortText(payload.notice, 2000)) {
        return respond(400, { error: 'Provide a valid global maintenance state, access mode, and notice.' });
      }
      const enabled = payload.enabled;
      const { error } = await serviceClient.from('platform_maintenance').upsert({
        id: 1,
        global_enabled: enabled,
        global_read_only: enabled && payload.readOnly,
        emergency_enabled: enabled && payload.emergency,
        notice: payload.notice,
        updated_by: user.id,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });
      if (error) throw error;
      if (!enabled) {
        const { error: cancelError } = await serviceClient.from('platform_maintenance_windows')
          .update({ cancelled_at: new Date().toISOString() })
          .eq('scope', 'global')
          .is('cancelled_at', null);
        if (cancelError) throw cancelError;
      }
      const { error: activityError } = await serviceClient.from('platform_activity').insert({
        actor_id: user.id,
        action: enabled ? payload.emergency ? 'emergency_maintenance_activated' : 'global_maintenance_activated' : 'global_maintenance_disabled',
        target_type: 'platform_maintenance',
        details: { read_only: enabled && payload.readOnly, emergency: enabled && payload.emergency },
      });
      if (activityError) throw activityError;
      return respond(200, { enabled });
    }

    if (payload.action === 'schedule-maintenance') {
      if (!['global', 'school', 'module'].includes(String(payload.scope))
        || typeof payload.startsAt !== 'string'
        || !Number.isFinite(Date.parse(payload.startsAt))
        || (payload.endsAt !== null && payload.endsAt !== undefined
          && (typeof payload.endsAt !== 'string' || !Number.isFinite(Date.parse(payload.endsAt))))
        || (typeof payload.endsAt === 'string' && Date.parse(payload.endsAt) <= Date.parse(payload.startsAt))
        || (Date.parse(payload.startsAt) > Date.now() && !payload.endsAt)
        || typeof payload.readOnly !== 'boolean'
        || !isShortText(payload.notice, 2000)) {
        return respond(400, { error: 'Enter valid maintenance scope, start/end times, mode, and notice.' });
      }
      const scope = payload.scope as string;
      if ((scope === 'school' || scope === 'module') && !isUuid(payload.schoolId)) {
        return respond(400, { error: 'Choose a valid school for scoped maintenance.' });
      }
      if (scope === 'module' && (typeof payload.moduleKey !== 'string' || !maintenanceModules.includes(payload.moduleKey))) {
        return respond(400, { error: 'Choose a valid module for module-specific maintenance.' });
      }
      const { data, error } = await serviceClient.from('platform_maintenance_windows').insert({
        scope,
        school_id: scope === 'global' ? null : payload.schoolId,
        module_key: scope === 'module' ? payload.moduleKey : null,
        starts_at: new Date(payload.startsAt).toISOString(),
        ends_at: typeof payload.endsAt === 'string' ? new Date(payload.endsAt).toISOString() : null,
        read_only: payload.readOnly,
        notice: payload.notice,
        created_by: user.id,
      }).select('id').single();
      if (error) throw error;
      const { error: activityError } = await serviceClient.from('platform_activity').insert({
        actor_id: user.id,
        action: 'maintenance_scheduled',
        target_type: 'maintenance_window',
        target_id: data.id,
        details: { scope, school_id: scope === 'global' ? null : payload.schoolId, module: scope === 'module' ? payload.moduleKey : null },
      });
      if (activityError) throw activityError;
      return respond(200, { windowId: data.id });
    }

    if (payload.action === 'set-scoped-maintenance') {
      if ((payload.scope !== 'school' && payload.scope !== 'module')
        || !isUuid(payload.schoolId)
        || typeof payload.enabled !== 'boolean'
        || typeof payload.readOnly !== 'boolean'
        || !isShortText(payload.notice, 2000)
        || (payload.scope === 'module' && (typeof payload.moduleKey !== 'string' || !maintenanceModules.includes(payload.moduleKey)))) {
        return respond(400, { error: 'Provide a valid school/module maintenance scope and access mode.' });
      }
      if (!payload.enabled) {
        const updateQuery = serviceClient.from('platform_maintenance_windows')
          .update({ cancelled_at: new Date().toISOString() })
          .eq('scope', payload.scope)
          .eq('school_id', payload.schoolId)
          .is('cancelled_at', null)
          .lte('starts_at', new Date().toISOString())
          .is('ends_at', null);
        const { error } = payload.scope === 'module'
          ? await updateQuery.eq('module_key', payload.moduleKey)
          : await updateQuery;
        if (error) throw error;
      } else {
        const existingQuery = serviceClient.from('platform_maintenance_windows')
          .select('id', { count: 'exact', head: true })
          .eq('scope', payload.scope)
          .eq('school_id', payload.schoolId)
          .is('cancelled_at', null)
          .lte('starts_at', new Date().toISOString())
          .is('ends_at', null);
        const { error: existingError, count } = payload.scope === 'module'
          ? await existingQuery.eq('module_key', payload.moduleKey)
          : await existingQuery;
        if (existingError) throw existingError;
        if (count) return respond(409, { error: 'This maintenance mode is already enabled.' });
        const { error } = await serviceClient.from('platform_maintenance_windows').insert({
          scope: payload.scope,
          school_id: payload.schoolId,
          module_key: payload.scope === 'module' ? payload.moduleKey : null,
          starts_at: new Date().toISOString(),
          ends_at: null,
          read_only: payload.readOnly,
          notice: payload.notice,
          created_by: user.id,
        });
        if (error) throw error;
      }
      const { error: activityError } = await serviceClient.from('platform_activity').insert({
        actor_id: user.id,
        action: `${payload.scope}_maintenance_${payload.enabled ? 'activated' : 'disabled'}`,
        target_type: payload.scope,
        target_id: payload.schoolId,
        details: { module: payload.scope === 'module' ? payload.moduleKey : null, read_only: payload.enabled && payload.readOnly },
      });
      if (activityError) throw activityError;
      return respond(200, { enabled: payload.enabled });
    }

    if (payload.action === 'cancel-maintenance') {
      if (!isUuid(payload.windowId)) return respond(400, { error: 'Choose a valid scheduled maintenance window.' });
      const { data, error } = await serviceClient.from('platform_maintenance_windows')
        .update({ cancelled_at: new Date().toISOString() })
        .eq('id', payload.windowId)
        .is('cancelled_at', null)
        .select('id,scope,school_id,module_key')
        .maybeSingle();
      if (error) throw error;
      if (!data) return respond(404, { error: 'The maintenance window has already ended or been cancelled.' });
      const { error: activityError } = await serviceClient.from('platform_activity').insert({
        actor_id: user.id,
        action: 'maintenance_cancelled',
        target_type: 'maintenance_window',
        target_id: data.id,
        details: { scope: data.scope, school_id: data.school_id, module: data.module_key },
      });
      if (activityError) throw activityError;
      return respond(200, { cancelled: true });
    }

    if (payload.action === 'list-schools') {
      const sortFields = ['created_at', 'name', 'status', 'subscription'];
      const statusFilter = payload.statusFilter === 'active' || payload.statusFilter === 'suspended' ? payload.statusFilter : '';
      const typeFilter = typeof payload.typeFilter === 'string' && schoolTypes.includes(payload.typeFilter) ? payload.typeFilter : '';
      const { data, error } = await serviceClient.rpc('platform_owner_school_list', {
        search_text: typeof payload.search === 'string' ? payload.search.trim().slice(0, 120) : '',
        status_filter: statusFilter,
        type_filter: typeFilter,
        sort_field: typeof payload.sortField === 'string' && sortFields.includes(payload.sortField) ? payload.sortField : 'created_at',
        sort_ascending: payload.sortAscending === true,
        page_number: typeof payload.page === 'number' ? Math.max(1, Math.floor(payload.page)) : 1,
        page_size: typeof payload.pageSize === 'number' ? Math.min(50, Math.max(1, Math.floor(payload.pageSize))) : 20,
      });
      if (error) throw error;
      const { data: platformSettings, error: settingsError } = await serviceClient
        .from('platform_settings')
        .select('supported_school_types')
        .eq('id', 1)
        .single();
      if (settingsError) throw settingsError;
      return respond(200, {
        result: data,
        supportedSchoolTypes: platformSettings.supported_school_types,
      });
    }

    if (payload.action === 'get-platform-settings') {
      const { data, error } = await serviceClient.from('platform_settings')
        .select('platform_name,logo_url,favicon_url,contact_email,contact_phone,default_language,default_timezone,default_date_format,supported_school_types,default_academic_configuration,global_feature_availability,maintenance_notice,default_notification_settings')
        .eq('id', 1)
        .single();
      if (error) throw error;
      return respond(200, { settings: data });
    }

    if (payload.action === 'save-platform-settings') {
      if (!isRecord(payload.settings)) return respond(400, { error: 'Platform settings are required.' });
      const settings = payload.settings;
      const textLimits: Record<string, number> = {
        platform_name: 120, logo_url: 2000, favicon_url: 2000, contact_email: 320,
        contact_phone: 40, default_language: 20, default_timezone: 100,
        default_date_format: 40, maintenance_notice: 2000,
      };
      for (const [key, limit] of Object.entries(textLimits)) {
        if (!isShortText(settings[key], limit)) return respond(400, { error: `Invalid platform setting: ${key}.` });
      }
      if (!Array.isArray(settings.supported_school_types)
        || settings.supported_school_types.length === 0
        || new Set(settings.supported_school_types).size !== settings.supported_school_types.length
        || !settings.supported_school_types.every((value) => typeof value === 'string' && schoolTypes.includes(value))) {
        return respond(400, { error: 'Choose valid supported school types.' });
      }
      if (!['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD.MM.YYYY'].includes(String(settings.default_date_format))) {
        return respond(400, { error: 'Choose a supported date format.' });
      }
      for (const key of ['default_academic_configuration', 'global_feature_availability', 'default_notification_settings']) {
        if (!isRecord(settings[key])) return respond(400, { error: `Invalid platform setting: ${key}.` });
      }
      const academic = settings.default_academic_configuration as Record<string, unknown>;
      if (!Number.isInteger(academic.academicYearStartMonth) || Number(academic.academicYearStartMonth) < 1 || Number(academic.academicYearStartMonth) > 12
        || !Number.isInteger(academic.academicYearStartDay) || Number(academic.academicYearStartDay) < 1 || Number(academic.academicYearStartDay) > 28
        || !Number.isInteger(academic.termCount) || Number(academic.termCount) < 1 || Number(academic.termCount) > 6) {
        return respond(400, { error: 'Academic year and term defaults are invalid.' });
      }
      const features = settings.global_feature_availability as Record<string, unknown>;
      if (Object.values(features).some((value) => typeof value !== 'boolean')) {
        return respond(400, { error: 'Global feature availability values must be enabled or disabled.' });
      }
      const notifications = settings.default_notification_settings as Record<string, unknown>;
      if (['email', 'inApp', 'maintenanceNotices'].some((key) => typeof notifications[key] !== 'boolean')) {
        return respond(400, { error: 'Default notification settings are invalid.' });
      }
      const { error } = await serviceClient.rpc('platform_owner_save_settings', {
        settings_value: settings,
        actor: user.id,
      });
      if (error) throw error;
      const { error: activityError } = await serviceClient.from('platform_activity').insert({
        actor_id: user.id,
        action: 'platform_settings_updated',
        target_type: 'platform_settings',
        details: {},
      });
      if (activityError) throw activityError;
      return respond(200, { saved: true });
    }

    if (payload.action === 'register-school' || payload.action === 'update-school') {
      if (!isRecord(payload.school)) return respond(400, { error: 'School information is required.' });
      const school = payload.school;
      if (typeof school.name !== 'string' || school.name.trim().length < 2 || school.name.trim().length > 120) {
        return respond(400, { error: 'School name must be between 2 and 120 characters.' });
      }
      const optionalTextLimits: Record<string, number> = {
        contact_email: 320, contact_phone: 40, address: 500, website: 2000,
        timezone: 100, default_language: 20, logo_path: 2000, favicon_path: 2000,
        subscription_plan: 100,
      };
      for (const [key, limit] of Object.entries(optionalTextLimits)) {
        if (school[key] !== undefined && school[key] !== null && !isShortText(school[key], limit)) {
          return respond(400, { error: `Invalid school field: ${key}.` });
        }
      }
      if (school.school_type !== null && school.school_type !== '' && !schoolTypes.includes(String(school.school_type))) {
        return respond(400, { error: 'Choose a supported school type.' });
      }
      if (school.subscription_status !== undefined && !subscriptionStatuses.includes(String(school.subscription_status))) {
        return respond(400, { error: 'Choose a valid school subscription status.' });
      }
      if (school.subscription_ends_at !== null && school.subscription_ends_at !== undefined
        && (typeof school.subscription_ends_at !== 'string' || !Number.isFinite(Date.parse(school.subscription_ends_at)))) {
        return respond(400, { error: 'Enter a valid subscription end date.' });
      }
      if (school.date_format !== undefined && !['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD.MM.YYYY'].includes(String(school.date_format))) {
        return respond(400, { error: 'Choose a supported school date format.' });
      }
      let schoolDefaults: { default_timezone: string; default_language: string; default_date_format: string; supported_school_types: string[] } | null = null;
      if (payload.action === 'register-school') {
        const { data, error } = await serviceClient.from('platform_settings')
          .select('default_timezone,default_language,default_date_format,supported_school_types')
          .eq('id', 1)
          .single();
        if (error) throw error;
        schoolDefaults = data;
        if (school.school_type && !data.supported_school_types.includes(school.school_type)) {
          return respond(400, { error: 'This school type is not currently supported by the platform.' });
        }
      }
      const schoolFields = {
        name: school.name.trim(),
        school_type: school.school_type || null,
        contact_email: isShortText(school.contact_email, 320) ? school.contact_email.trim() || null : null,
        contact_phone: isShortText(school.contact_phone, 40) ? school.contact_phone.trim() || null : null,
        address: isShortText(school.address, 500) ? school.address.trim() || null : null,
        website: isShortText(school.website, 2000) ? school.website.trim() || null : null,
        timezone: isShortText(school.timezone, 100) ? school.timezone.trim() || schoolDefaults?.default_timezone || 'UTC' : schoolDefaults?.default_timezone || 'UTC',
        default_language: isShortText(school.default_language, 20) ? school.default_language.trim() || schoolDefaults?.default_language || 'en' : schoolDefaults?.default_language || 'en',
        date_format: typeof school.date_format === 'string' ? school.date_format : schoolDefaults?.default_date_format || 'YYYY-MM-DD',
        logo_path: isShortText(school.logo_path, 2000) ? school.logo_path.trim() || null : null,
        favicon_path: isShortText(school.favicon_path, 2000) ? school.favicon_path.trim() || null : null,
        subscription_status: subscriptionStatuses.includes(String(school.subscription_status)) ? school.subscription_status : 'free',
        subscription_plan: isShortText(school.subscription_plan, 100) ? school.subscription_plan.trim() || 'phase_1_free' : 'phase_1_free',
        subscription_ends_at: typeof school.subscription_ends_at === 'string' && school.subscription_ends_at ? school.subscription_ends_at : null,
      };
      let schoolId: string;
      if (payload.action === 'register-school') {
        const { data, error } = await serviceClient.from('schools')
          .insert({ ...schoolFields, created_by: user.id })
          .select('id,name')
          .single();
        if (error) throw error;
        schoolId = data.id;
      } else {
        if (!isUuid(payload.schoolId)) return respond(400, { error: 'Choose a valid school.' });
        const { data, error } = await serviceClient.from('schools')
          .update(schoolFields)
          .eq('id', payload.schoolId)
          .select('id,name')
          .maybeSingle();
        if (error) throw error;
        if (!data) return respond(404, { error: 'The school was not found.' });
        schoolId = data.id;
      }
      const { error: activityError } = await serviceClient.from('platform_activity').insert({
        actor_id: user.id,
        action: payload.action === 'register-school' ? 'school_registered_by_platform' : 'school_information_updated',
        target_type: 'school',
        target_id: schoolId,
        details: { school_name: schoolFields.name },
      });
      if (activityError) throw activityError;
      return respond(200, { schoolId });
    }

    if (payload.action === 'assign-school-admin') {
      if (!isUuid(payload.schoolId) || typeof payload.adminEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.adminEmail)) {
        return respond(400, { error: 'Enter the email address of an existing Campus Connect user.' });
      }
      const { data: school, error: schoolError } = await serviceClient.from('schools').select('id,name').eq('id', payload.schoolId).maybeSingle();
      if (schoolError) throw schoolError;
      if (!school) return respond(404, { error: 'The school was not found.' });
      const { data: profile, error: profileError } = await serviceClient.from('profiles')
        .select('id,email,full_name')
        .eq('email', payload.adminEmail.trim().toLowerCase())
        .maybeSingle();
      if (profileError) throw profileError;
      if (!profile) return respond(404, { error: 'No Campus Connect account was found for that email. The administrator must sign up first.' });
      const { error: membershipError } = await serviceClient.from('school_memberships')
        .upsert({ school_id: school.id, profile_id: profile.id, role: 'school_admin' }, { onConflict: 'school_id,profile_id' });
      if (membershipError) throw membershipError;
      const { error: activityError } = await serviceClient.from('platform_activity').insert({
        actor_id: user.id,
        action: 'school_administrator_assigned',
        target_type: 'school',
        target_id: school.id,
        details: { school_name: school.name, administrator_email: profile.email },
      });
      if (activityError) throw activityError;
      return respond(200, { administrator: { id: profile.id, name: profile.full_name, email: profile.email } });
    }

    if (payload.action === 'set-school-status') {
      if (!isUuid(payload.schoolId) || (payload.status !== 'active' && payload.status !== 'suspended')) {
        return respond(400, { error: 'Choose a valid school and platform status.' });
      }
      const { data: school, error: updateError } = await serviceClient
        .from('schools')
        .update({ platform_status: payload.status })
        .eq('id', payload.schoolId)
        .select('id,name,platform_status')
        .maybeSingle();
      if (updateError) throw updateError;
      if (!school) return respond(404, { error: 'The school was not found.' });
      const { error: activityError } = await serviceClient.from('platform_activity').insert({
        actor_id: user.id,
        action: payload.status === 'suspended' ? 'school_suspended' : 'school_reactivated',
        target_type: 'school',
        target_id: school.id,
        details: { school_name: school.name },
      });
      if (activityError) throw activityError;
      return respond(200, { school });
    }

    if (payload.action === 'review-storage-request') {
      if (!isUuid(payload.requestId) || (payload.decision !== 'approved' && payload.decision !== 'denied')) {
        return respond(400, { error: 'Choose a valid storage request and decision.' });
      }
      if (payload.decision === 'approved' && !(
        Deno.env.get('R2_ACCOUNT_ID')
        && Deno.env.get('R2_BUCKET_NAME')
        && Deno.env.get('R2_ACCESS_KEY_ID')
        && Deno.env.get('R2_SECRET_ACCESS_KEY')
      )) {
        return respond(503, { error: 'Managed R2 storage is not configured on the platform yet. Configure its Edge Function secrets before approving requests.' });
      }
      const { data: storageRequest, error: requestError } = await serviceClient
        .from('managed_storage_requests')
        .update({
          status: payload.decision,
          reviewed_by: user.id,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', payload.requestId)
        .eq('status', 'pending')
        .select('id,school_id,status')
        .maybeSingle();
      if (requestError) throw requestError;
      if (!storageRequest) return respond(409, { error: 'This request is no longer pending.' });

      if (payload.decision === 'approved') {
        const { error: enableError } = await serviceClient.from('schools')
          .update({ managed_storage_enabled: true }).eq('id', storageRequest.school_id);
        if (enableError) throw enableError;
      }
      const { error: activityError } = await serviceClient.from('platform_activity').insert({
        actor_id: user.id,
        action: `managed_storage_${payload.decision}`,
        target_type: 'managed_storage_request',
        target_id: storageRequest.id,
        details: { school_id: storageRequest.school_id },
      });
      if (activityError) throw activityError;
      return respond(200, { request: storageRequest });
    }

    return respond(400, { error: 'Unsupported system owner action.' });
  } catch (error) {
    console.error('Campus Connect system owner request failed.', error);
    return respond(500, {
      error: error instanceof Error ? error.message : 'The system owner request could not be completed.',
    });
  }
});
