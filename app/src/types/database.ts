export type AppRole = 'system_admin' | 'school_admin' | 'teacher' | 'student' | 'parent';

export interface SchoolMembership {
  school_id: string;
  role: AppRole;
  school: {
    id: string;
    name: string;
    timezone: string;
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
