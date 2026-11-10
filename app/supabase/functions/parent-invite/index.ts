import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type ParentInviteRequest = {
  schoolId?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  email?: unknown;
  phone?: unknown;
  studentIds?: unknown;
  relationship?: unknown;
};

function respond(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return respond(405, { error: 'Method not allowed.' });

  let newUserId: string | null = null;
  let membershipAdded = false;
  let schoolId = '';
  let profileId = '';
  let serviceClient: ReturnType<typeof createClient> | null = null;
  try {
    const accessToken = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!accessToken) return respond(401, { error: 'Sign in as a school administrator to manage parent access.' });

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      throw new Error('Parent invitation service configuration is incomplete.');
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser(accessToken);
    if (authError || !user) return respond(401, { error: 'Your session is invalid. Sign in again and retry.' });

    const payload = await request.json() as ParentInviteRequest;
    schoolId = typeof payload.schoolId === 'string' ? payload.schoolId.trim() : '';
    const firstName = typeof payload.firstName === 'string' ? payload.firstName.trim() : '';
    const lastName = typeof payload.lastName === 'string' ? payload.lastName.trim() : '';
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    const phone = typeof payload.phone === 'string' ? payload.phone.trim() : '';
    const relationship = typeof payload.relationship === 'string' ? payload.relationship.trim() : '';
    const studentIds = Array.isArray(payload.studentIds) ? payload.studentIds : [];

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(schoolId)) {
      return respond(400, { error: 'Choose a valid school.' });
    }
    if (firstName.length < 1 || firstName.length > 80 || lastName.length < 1 || lastName.length > 80) {
      return respond(400, { error: 'Enter first and last names of at most 80 characters each.' });
    }
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return respond(400, { error: 'Enter a valid parent or guardian email address.' });
    }
    if (phone.length > 40 || relationship.length < 1 || relationship.length > 60) {
      return respond(400, { error: 'Enter a relationship and a phone number of at most 40 characters.' });
    }
    if (studentIds.length < 1 || studentIds.length > 25
      || studentIds.some((id) => typeof id !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      || new Set(studentIds).size !== studentIds.length) {
      return respond(400, { error: 'Select between 1 and 25 different students from this school.' });
    }

    serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: adminMembership, error: adminError } = await serviceClient
      .from('school_memberships')
      .select('id')
      .eq('school_id', schoolId)
      .eq('profile_id', user.id)
      .eq('role', 'school_admin')
      .maybeSingle();
    if (adminError) throw adminError;
    if (!adminMembership) return respond(403, { error: 'Only a school administrator can manage parent access.' });

    const { data: maintenance, error: maintenanceError } = await serviceClient.rpc('platform_maintenance_status', {
      target_school: schoolId,
      target_module: 'students',
    });
    if (maintenanceError) throw maintenanceError;
    if (maintenance?.active) return respond(423, { error: 'Parent access changes are paused during student-record maintenance.' });

    const { data: students, error: studentsError } = await serviceClient
      .from('students')
      .select('id')
      .eq('school_id', schoolId)
      .eq('status', 'active')
      .in('id', studentIds);
    if (studentsError) throw studentsError;
    if ((students ?? []).length !== studentIds.length) {
      return respond(400, { error: 'One or more selected students are inactive or do not belong to this school.' });
    }

    const { data: existingProfile, error: profileError } = await serviceClient
      .from('profiles')
      .select('id')
      .eq('email', email)
      .maybeSingle();
    if (profileError) throw profileError;

    if (existingProfile) {
      profileId = existingProfile.id;
      const { data: existingMembership, error: existingMembershipError } = await serviceClient
        .from('school_memberships')
        .select('role')
        .eq('school_id', schoolId)
        .eq('profile_id', profileId)
        .maybeSingle();
      if (existingMembershipError) throw existingMembershipError;
      if (existingMembership && existingMembership.role !== 'parent') {
        return respond(409, { error: 'This account already has a different role at this school. Do not change its role for parent testing.' });
      }
      if (!existingMembership) {
        const { error: membershipError } = await serviceClient
          .from('school_memberships')
          .insert({ school_id: schoolId, profile_id: profileId, role: 'parent' });
        if (membershipError) throw membershipError;
        membershipAdded = true;
      }
    } else {
      const { data: invitation, error: invitationError } = await serviceClient.auth.admin.inviteUserByEmail(email, {
        data: { full_name: `${firstName} ${lastName}` },
      });
      if (invitationError) return respond(400, { error: `Could not invite this email. If the person already has an account, ensure its profile email matches, then retry: ${invitationError.message}` });
      if (!invitation.user) throw new Error('Supabase did not return the invited parent account.');
      profileId = invitation.user.id;
      newUserId = profileId;

      const { error: membershipError } = await serviceClient
        .from('school_memberships')
        .insert({ school_id: schoolId, profile_id: profileId, role: 'parent' });
      if (membershipError) throw membershipError;
      membershipAdded = true;
    }

    const { error: linkError } = await serviceClient.rpc('manage_parent_student_links', {
      target_school: schoolId,
      actor_profile: user.id,
      target_profile: profileId,
      parent_first_name: firstName,
      parent_last_name: lastName,
      parent_email: email,
      parent_phone: phone || null,
      target_student_ids: studentIds,
      target_relationship: relationship,
    });
    if (linkError) throw linkError;

    return respond(200, {
      status: newUserId ? 'invited' : 'linked',
      message: newUserId
        ? 'Invitation sent. The parent can set a password from the secure email link.'
        : 'Parent account and student links saved.',
    });
  } catch (error) {
    if (serviceClient && newUserId) {
      const { error: cleanupError } = await serviceClient.auth.admin.deleteUser(newUserId);
      if (cleanupError) console.error('Could not revoke an incomplete parent invitation.', cleanupError.message);
    } else if (serviceClient && membershipAdded && schoolId && profileId) {
      const { error: cleanupError } = await serviceClient.from('school_memberships')
        .delete().eq('school_id', schoolId).eq('profile_id', profileId).eq('role', 'parent');
      if (cleanupError) console.error('Could not remove incomplete parent membership.', cleanupError.message);
    }
    console.error('Campus Connect could not invite or link a parent.', error);
    return respond(500, { error: error instanceof Error ? error.message : 'Could not invite or link this parent.' });
  }
});
