import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const supportedStaffRoles = new Set([
  'teacher', 'finance_manager', 'accountant', 'bursar', 'cashier',
  'accounts_payable_officer', 'auditor', 'librarian',
  'website_editor', 'website_publisher', 'admissions_officer', 'hr_staff_administrator',
  'transport_manager', 'facilities_manager', 'it_support_technician', 'safeguarding_officer',
  'procurement_officer', 'compliance_audit_officer', 'nurse', 'doctor', 'secretary',
]);

interface InviteRequest {
  schoolId?: unknown;
  fullName?: unknown;
  email?: unknown;
  role?: unknown;
  employeeNumber?: unknown;
}

function respond(status: number, body: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return respond(405, { error: 'Method not allowed.' });

  try {
    const authorization = request.headers.get('Authorization');
    const accessToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!accessToken) return respond(401, { error: 'Sign in as a school administrator to invite staff.' });

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      throw new Error('Staff invitation service configuration is incomplete.');
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser(accessToken);
    if (authError || !user) return respond(401, { error: 'Your session is invalid. Sign in again and retry.' });

    const payload = await request.json() as InviteRequest;
    const schoolId = typeof payload.schoolId === 'string' ? payload.schoolId.trim() : '';
    const fullName = typeof payload.fullName === 'string' ? payload.fullName.trim() : '';
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    const role = typeof payload.role === 'string' ? payload.role : '';
    const employeeNumber = typeof payload.employeeNumber === 'string' ? payload.employeeNumber.trim() : '';

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(schoolId)) {
      return respond(400, { error: 'Choose a valid school.' });
    }
    if (fullName.length < 2 || fullName.length > 120) {
      return respond(400, { error: 'Enter a name between 2 and 120 characters.' });
    }
    if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return respond(400, { error: 'Enter a valid email address.' });
    }
    if (!supportedStaffRoles.has(role)) {
      return respond(400, { error: 'Choose a supported staff role.' });
    }
    if (role === 'teacher' && fullName.split(/\s+/).length < 2) {
      return respond(400, { error: 'Enter the teacher’s first and last name.' });
    }
    if (role !== 'teacher' && employeeNumber.length > 40) {
      return respond(400, { error: 'Employee number must be at most 40 characters.' });
    }
    if (role === 'teacher' && (employeeNumber.length < 1 || employeeNumber.length > 40)) {
      return respond(400, { error: 'Enter an employee number between 1 and 40 characters.' });
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: adminMembership, error: membershipCheckError } = await adminClient
      .from('school_memberships')
      .select('id')
      .eq('school_id', schoolId)
      .eq('profile_id', user.id)
      .eq('role', 'school_admin')
      .maybeSingle();
    if (membershipCheckError) throw membershipCheckError;
    if (!adminMembership) return respond(403, { error: 'Only a school administrator can invite staff.' });

    if (employeeNumber) {
      const { data: existingStaff, error: existingStaffError } = await adminClient
        .from('staff_profiles')
        .select('id')
        .eq('school_id', schoolId)
        .eq('employee_number', employeeNumber)
        .maybeSingle();
      if (existingStaffError) throw existingStaffError;
      if (existingStaff) return respond(409, { error: 'That employee number is already in use at this school.' });
    }

    const { data: maintenance, error: maintenanceError } = await adminClient.rpc('platform_maintenance_status', {
      target_school: schoolId,
      target_module: 'staff',
    });
    if (maintenanceError) throw maintenanceError;
    if (maintenance?.active) {
      return respond(423, { error: 'Staff changes are temporarily disabled during maintenance.' });
    }

    const { data: invitation, error: invitationError } = await adminClient.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName },
    });
    if (invitationError) {
      console.error('Campus Connect could not invite accounting staff.', invitationError.message);
      return respond(400, { error: invitationError.message });
    }
    if (!invitation.user) throw new Error('Supabase did not return the invited user.');

    const { error: createMembershipError } = await adminClient
      .from('school_memberships')
      .insert({ school_id: schoolId, profile_id: invitation.user.id, role });
    if (createMembershipError) {
      const { error: cleanupError } = await adminClient.auth.admin.deleteUser(invitation.user.id);
      if (cleanupError) console.error('Campus Connect could not revoke an incomplete staff invitation.', cleanupError.message);
      throw new Error(`The invitation email was sent, but school access could not be created: ${createMembershipError.message}`);
    }

    if (role === 'teacher') {
      const [firstName, ...lastNameParts] = fullName.split(/\s+/);
      let staffProfileId: string | null = null;
      let teacherProfileId: string | null = null;
      try {
        const { data: staffProfile, error: staffProfileError } = await adminClient
          .from('staff_profiles')
          .insert({
            school_id: schoolId,
            profile_id: invitation.user.id,
            employee_number: employeeNumber,
            first_name: firstName,
            last_name: lastNameParts.join(' '),
            email,
            job_title: 'Teacher',
            employment_status: 'active',
          })
          .select('id')
          .single();
        if (staffProfileError) throw staffProfileError;
        staffProfileId = staffProfile.id;

        const { data: teacherProfile, error: teacherProfileError } = await adminClient
          .from('teacher_profiles')
          .insert({
            school_id: schoolId,
            profile_id: invitation.user.id,
            staff_profile_id: staffProfileId,
            first_name: firstName,
            last_name: lastNameParts.join(' '),
            email,
            employee_number: employeeNumber,
            status: 'active',
            employment_status: 'active',
          })
          .select('id')
          .single();
        if (teacherProfileError) throw teacherProfileError;
        teacherProfileId = teacherProfile.id;
      } catch (profileError) {
        const cleanupErrors: string[] = [];
        if (teacherProfileId) {
          const { error: teacherCleanupError } = await adminClient.from('teacher_profiles').delete().eq('id', teacherProfileId);
          if (teacherCleanupError) cleanupErrors.push(teacherCleanupError.message);
        }
        if (staffProfileId) {
          const { error: staffCleanupError } = await adminClient.from('staff_profiles').delete().eq('id', staffProfileId);
          if (staffCleanupError) cleanupErrors.push(staffCleanupError.message);
        }
        const { error: membershipCleanupError } = await adminClient.from('school_memberships')
          .delete().eq('school_id', schoolId).eq('profile_id', invitation.user.id);
        if (membershipCleanupError) cleanupErrors.push(membershipCleanupError.message);
        const { error: userCleanupError } = await adminClient.auth.admin.deleteUser(invitation.user.id);
        if (userCleanupError) cleanupErrors.push(userCleanupError.message);
        if (cleanupErrors.length) console.error('Campus Connect could not fully revoke an incomplete teacher invitation.', cleanupErrors);
        throw new Error(`The invitation email was sent, but the teacher profile could not be created: ${profileError instanceof Error ? profileError.message : 'Unknown error.'}`);
      }
    } else {
      const [firstName, ...lastNameParts] = fullName.split(/\s+/);
      const { error: staffProfileError } = await adminClient.from('staff_profiles').insert({
        school_id: schoolId,
        profile_id: invitation.user.id,
        employee_number: employeeNumber || `CC-${invitation.user.id.replace(/-/g, '').slice(0, 12)}`,
        first_name: firstName,
        last_name: lastNameParts.join(' ') || firstName,
        email,
        job_title: role.replace(/_/g, ' '),
        employment_status: 'active',
      });
      if (staffProfileError) {
        const { error: membershipCleanupError } = await adminClient.from('school_memberships')
          .delete().eq('school_id', schoolId).eq('profile_id', invitation.user.id);
        const { error: userCleanupError } = await adminClient.auth.admin.deleteUser(invitation.user.id);
        if (membershipCleanupError) console.error('Campus Connect could not revoke an incomplete specialist invitation.', membershipCleanupError.message);
        if (userCleanupError) console.error('Campus Connect could not delete an incomplete specialist invitation.', userCleanupError.message);
        throw new Error(`The invitation email was sent, but the staff profile could not be created: ${staffProfileError.message}`);
      }
    }

    return respond(201, { status: 'invited' });
  } catch (error) {
    console.error('Campus Connect staff invitation failed.', error);
    return respond(500, {
      error: error instanceof Error ? error.message : 'The staff invitation could not be completed.',
    });
  }
});
