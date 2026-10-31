import { requireSupabase } from './supabase';

export type PrerequisiteEntity = 'teacher' | 'class' | 'subject';

export type PrerequisiteRecord = {
  id: string;
  name: string;
  status?: string;
  first_name?: string;
  last_name?: string;
  email?: string | null;
  academic_year_id?: string | null;
};

export type CreatePrerequisiteInput =
  | {
    entity: 'teacher';
    schoolId: string;
    firstName: string;
    lastName: string;
    email?: string;
    classId?: string;
    subjectId?: string;
  }
  | {
    entity: 'class';
    schoolId: string;
    name: string;
    gradeLevel?: string;
    calendarId: string;
    academicYearId?: string;
  }
  | {
    entity: 'subject';
    schoolId: string;
    name: string;
    code?: string;
    departmentId?: string;
    classId?: string;
  };

export async function createPrerequisiteRecord(input: CreatePrerequisiteInput): Promise<PrerequisiteRecord> {
  const client = requireSupabase();

  if (input.entity === 'teacher') {
    const { data, error } = await client.from('teacher_profiles').insert({
      school_id: input.schoolId,
      first_name: input.firstName.trim(),
      last_name: input.lastName.trim(),
      email: input.email?.trim() || null,
    }).select('id,profile_id,first_name,last_name,email,status').single();
    if (error) throw error;

    try {
      if (input.classId) {
        const { error: classAssignmentError } = await client.from('teacher_class_assignments').insert({
          school_id: input.schoolId,
          teacher_id: data.id,
          class_id: input.classId,
        });
        if (classAssignmentError) throw classAssignmentError;
      }
      if (input.subjectId) {
        const { error: subjectAssignmentError } = await client.from('teacher_subjects').insert({
          school_id: input.schoolId,
          teacher_id: data.id,
          subject_id: input.subjectId,
        });
        if (subjectAssignmentError) throw subjectAssignmentError;
      }
    } catch (assignmentError) {
      const { error: cleanupError } = await client.from('teacher_profiles')
        .delete().eq('school_id', input.schoolId).eq('id', data.id);
      if (cleanupError) {
        throw new Error(`The teacher profile was created, but its class or subject assignment failed and cleanup could not be completed: ${cleanupError.message}`);
      }
      throw assignmentError;
    }

    return { ...data, name: `${data.first_name} ${data.last_name}` };
  }

  if (input.entity === 'class') {
    const { data, error } = await client.from('school_classes').insert({
      school_id: input.schoolId,
      name: input.name.trim(),
      grade_level: input.gradeLevel?.trim() || null,
      calendar_id: input.calendarId,
      academic_year_id: input.academicYearId || null,
    }).select('id,name,academic_year_id').single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await client.from('subjects').insert({
    school_id: input.schoolId,
    name: input.name.trim(),
    code: input.code?.trim() || null,
    department_id: input.departmentId || null,
  }).select('id,name').single();
  if (error) throw error;

  if (input.classId) {
    const { error: classSubjectError } = await client.from('class_subjects').insert({
      school_id: input.schoolId,
      class_id: input.classId,
      subject_id: data.id,
    });
    if (classSubjectError) {
      const { error: cleanupError } = await client.from('subjects')
        .delete().eq('school_id', input.schoolId).eq('id', data.id);
      if (cleanupError) {
        throw new Error(`The subject was created, but class eligibility could not be configured and cleanup could not be completed: ${cleanupError.message}`);
      }
      throw classSubjectError;
    }
  }

  return data;
}

export async function findPrerequisiteDuplicates(input: CreatePrerequisiteInput): Promise<PrerequisiteRecord[]> {
  const client = requireSupabase();

  if (input.entity === 'teacher') {
    const { data, error } = await client.from('teacher_profiles')
      .select('id,profile_id,first_name,last_name,email,status')
      .eq('school_id', input.schoolId)
      .ilike('first_name', input.firstName.trim())
      .ilike('last_name', input.lastName.trim())
      .limit(5);
    if (error) throw error;
    return (data ?? []).map((teacher) => ({ ...teacher, name: `${teacher.first_name} ${teacher.last_name}` }));
  }

  if (input.entity === 'class') {
    let query = client.from('school_classes').select('id,name,academic_year_id')
      .eq('school_id', input.schoolId)
      .ilike('name', input.name.trim());
    query = input.academicYearId
      ? query.eq('academic_year_id', input.academicYearId)
      : query.is('academic_year_id', null);
    const { data, error } = await query.limit(5);
    if (error) throw error;
    return data ?? [];
  }

  if (input.code?.trim()) {
    const { data, error } = await client.from('subjects').select('id,name')
      .eq('school_id', input.schoolId).ilike('code', input.code.trim()).limit(5);
    if (error) throw error;
    if (data?.length) return data;
  }

  const { data, error } = await client.from('subjects').select('id,name')
    .eq('school_id', input.schoolId).ilike('name', input.name.trim()).limit(5);
  if (error) throw error;
  return data ?? [];
}

export async function ensurePrerequisiteEligibility(
  entity: PrerequisiteEntity,
  schoolId: string,
  recordId: string,
  classId?: string,
  subjectId?: string,
) {
  const client = requireSupabase();
  if (entity === 'subject' && classId) {
    const { error } = await client.from('class_subjects').upsert({
      school_id: schoolId,
      class_id: classId,
      subject_id: recordId,
    }, { onConflict: 'class_id,subject_id', ignoreDuplicates: true });
    if (error) throw error;
  }
  if (entity === 'teacher' && classId) {
    const { error } = await client.from('teacher_class_assignments').upsert({
      school_id: schoolId,
      teacher_id: recordId,
      class_id: classId,
    }, { onConflict: 'teacher_id,class_id', ignoreDuplicates: true });
    if (error) throw error;
  }
  if (entity === 'teacher' && subjectId) {
    const { error } = await client.from('teacher_subjects').upsert({
      school_id: schoolId,
      teacher_id: recordId,
      subject_id: subjectId,
    }, { onConflict: 'teacher_id,subject_id', ignoreDuplicates: true });
    if (error) throw error;
  }
}
