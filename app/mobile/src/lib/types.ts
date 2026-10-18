export type MobileModule = 'visitors' | 'library' | 'health' | 'notifications';
export type MobileRole =
  | 'system_admin'
  | 'school_admin'
  | 'academic_coordinator'
  | 'teacher'
  | 'student'
  | 'parent'
  | 'finance_manager'
  | 'accountant'
  | 'bursar'
  | 'cashier'
  | 'nurse'
  | 'doctor'
  | 'secretary';

export interface MobileMembership {
  school_id: string;
  school_name: string;
  school_logo_path?: string | null;
  role: MobileRole;
  eligible: boolean;
  mobile_enabled: boolean;
  platform_enabled: boolean;
  school_active?: boolean;
  announcement: string;
  role_modules: MobileModule[];
  accessible_modules: MobileModule[];
}

export interface VisitorRecord {
  id: string;
  school_id: string;
  badge_number: string;
  visitor_name: string;
  phone: string;
  organization: string;
  purpose: string;
  host_name: string;
  host_department: string;
  id_type: string;
  id_number: string;
  photo_path: string | null;
  visit_date: string;
  valid_until: string;
  status: 'expected' | 'checked_in' | 'checked_out' | 'cancelled';
  arrived_at: string | null;
  departed_at: string | null;
}

export interface LibraryBook {
  id: string;
  school_id: string;
  barcode: string;
  isbn: string | null;
  title: string;
  authors: string[];
  publisher: string | null;
  edition: string | null;
  publication_year: number | null;
  cover_url: string | null;
  total_copies: number;
  available_copies: number;
  archived_at: string | null;
}

export interface HealthVisit {
  id: string;
  student_id: string;
  visit_at: string;
  symptoms: string;
  clinical_notes: string;
  assessment: string;
  diagnosis: string;
  allergies: string;
  vitals: Record<string, string | number>;
  prescriptions: {
    medication_name: string;
    dosage: string;
    frequency: string;
    duration: string;
    instructions: string;
  }[];
}
