import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Activity, Download, FileHeart, HeartPulse, MailPlus, Plus, QrCode, Save, ShieldCheck, UserRound, X } from 'lucide-react';
import jsPDF from 'jspdf';
import QRCode from 'qrcode';
import { useParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';
import type { AppRole } from '../types/database';

type Prescription = { medication_name: string; dosage: string; frequency: string; duration: string; instructions: string };
type Vitals = {
  temperature_c: string;
  heart_rate_bpm: string;
  blood_pressure_systolic: string;
  blood_pressure_diastolic: string;
  weight_kg: string;
  height_cm: string;
  other_vitals: string;
};
type Student = {
  id: string;
  student_number: string;
  first_name: string;
  last_name: string;
  email: string | null;
  date_of_birth: string | null;
  status: string;
  class_id: string | null;
  school_classes: { name: string; grade_level: string | null } | { name: string; grade_level: string | null }[] | null;
};
type EmergencyContact = { contact_name: string; relationship: string | null; phone: string; email: string | null };
type Visit = {
  id: string;
  student_id: string;
  visit_at: string;
  symptoms: string;
  clinical_notes: string;
  assessment: string;
  diagnosis: string;
  allergies: string;
  vitals: Record<string, string | number | null>;
  prescriptions: Prescription[];
  recorded_by: string;
  created_at: string;
};
type MedicalReadiness = {
  id: string;
  student_id: string;
  allergy_status: 'unknown' | 'none_known' | 'known';
  allergy_details: string;
  medical_conditions: string;
  medication_status: 'unknown' | 'none' | 'on_file';
  medication_details: string;
  emergency_action_plan: string;
  reviewed_at: string;
  review_due_at: string | null;
  reviewed_by: string;
};
type MedicalReadinessDraft = Omit<MedicalReadiness, 'id' | 'student_id' | 'reviewed_at' | 'review_due_at' | 'reviewed_by'> & {
  review_due_at: string;
};
type StaffRole = Extract<AppRole, 'nurse' | 'doctor'>;

const emptyVitals: Vitals = {
  temperature_c: '',
  heart_rate_bpm: '',
  blood_pressure_systolic: '',
  blood_pressure_diastolic: '',
  weight_kg: '',
  height_cm: '',
  other_vitals: '',
};
const emptyPrescription = (): Prescription => ({
  medication_name: '',
  dosage: '',
  frequency: '',
  duration: '',
  instructions: '',
});
const emptyReadiness: MedicalReadinessDraft = {
  allergy_status: 'unknown',
  allergy_details: '',
  medical_conditions: '',
  medication_status: 'unknown',
  medication_details: '',
  emergency_action_plan: '',
  review_due_at: '',
};

function localDateTime() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function relation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function pdfSafe(value: string | number | null | undefined) {
  return String(value ?? 'Not recorded').trim() || 'Not recorded';
}

export function HealthPage() {
  const { activeMembership } = useAuth();
  const { visitId: reportVisitId } = useParams<{ visitId: string }>();
  const schoolId = activeMembership?.school_id;
  const role = activeMembership?.role;
  const isAdmin = role === 'school_admin';
  const canUseHealth = role === 'nurse' || role === 'doctor';
  const isDoctor = role === 'doctor';
  const [students, setStudents] = useState<Student[]>([]);
  const [selectedStudentId, setSelectedStudentId] = useState('');
  const [contacts, setContacts] = useState<EmergencyContact[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [readinessRecords, setReadinessRecords] = useState<MedicalReadiness[]>([]);
  const [readinessDraft, setReadinessDraft] = useState<MedicalReadinessDraft>({ ...emptyReadiness });
  const [readinessSearch, setReadinessSearch] = useState('');
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [readinessSaving, setReadinessSaving] = useState(false);
  const [readinessError, setReadinessError] = useState('');
  const [selectedVisitId, setSelectedVisitId] = useState('');
  const [visitAt, setVisitAt] = useState(localDateTime);
  const [symptoms, setSymptoms] = useState('');
  const [clinicalNotes, setClinicalNotes] = useState('');
  const [assessment, setAssessment] = useState('');
  const [diagnosis, setDiagnosis] = useState('');
  const [allergies, setAllergies] = useState('');
  const [vitals, setVitals] = useState<Vitals>({ ...emptyVitals });
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [success, setSuccess] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const selectedStudent = students.find((student) => student.id === selectedStudentId) ?? null;
  const selectedVisit = visits.find((visit) => visit.id === selectedVisitId) ?? null;
  const readinessByStudent = useMemo(() => new Map(readinessRecords.map((record) => [record.student_id, record])), [readinessRecords]);
  const selectedClass = relation(selectedStudent?.school_classes);
  const reportVisit = reportVisitId ? visits.find((visit) => visit.id === reportVisitId) ?? null : null;
  const showHealthData = canUseHealth;

  const loadStudents = useCallback(async () => {
    if (!schoolId || !showHealthData) {
      setStudents([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const { data, error: queryError } = await requireSupabase().from('students')
        .select('id,student_number,first_name,last_name,email,date_of_birth,status,class_id,school_classes(name,grade_level)')
        .eq('school_id', schoolId)
        .order('last_name').order('first_name');
      if (queryError) throw queryError;
      const records = (data ?? []) as unknown as Student[];
      setStudents(records);
      setSelectedStudentId((current) => records.some((student) => student.id === current) ? current : records[0]?.id ?? '');
    } catch (loadError) {
      setError(errorMessage(loadError, 'Could not load students for the health module.'));
    } finally {
      setLoading(false);
    }
  }, [schoolId, showHealthData]);

  useEffect(() => { void loadStudents(); }, [loadStudents, refreshKey]);

  const loadReadinessRegister = useCallback(async () => {
    if (!schoolId || !showHealthData) {
      setReadinessRecords([]);
      setReadinessLoading(false);
      return;
    }
    setReadinessLoading(true);
    setReadinessError('');
    try {
      const { data, error: queryError } = await requireSupabase().from('student_medical_readiness')
        .select('id,student_id,allergy_status,allergy_details,medical_conditions,medication_status,medication_details,emergency_action_plan,reviewed_at,review_due_at,reviewed_by')
        .eq('school_id', schoolId);
      if (queryError) throw queryError;
      setReadinessRecords((data ?? []) as MedicalReadiness[]);
    } catch (loadError) {
      setReadinessError(errorMessage(loadError, 'Could not load the medical readiness register.'));
    } finally {
      setReadinessLoading(false);
    }
  }, [schoolId, showHealthData]);

  useEffect(() => { void loadReadinessRegister(); }, [loadReadinessRegister, refreshKey]);

  const loadStudentDetails = useCallback(async () => {
    if (!schoolId || !selectedStudentId || !showHealthData) {
      setVisits([]);
      setContacts([]);
      return;
    }
    setDetailLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [visitResult, contactResult] = await Promise.all([
        client.from('student_health_visits')
          .select('id,student_id,visit_at,symptoms,clinical_notes,assessment,diagnosis,allergies,vitals,prescriptions,recorded_by,created_at')
          .eq('school_id', schoolId).eq('student_id', selectedStudentId)
          .order('visit_at', { ascending: false }),
        client.from('student_emergency_contacts')
          .select('contact_name,relationship,phone,email')
          .eq('school_id', schoolId).eq('student_id', selectedStudentId)
          .order('is_primary', { ascending: false }),
      ]);
      if (visitResult.error) throw visitResult.error;
      if (contactResult.error) throw contactResult.error;
      setVisits((visitResult.data ?? []) as unknown as Visit[]);
      setContacts((contactResult.data ?? []) as EmergencyContact[]);
    } catch (loadError) {
      setError(errorMessage(loadError, 'Could not load the student’s health history.'));
    } finally {
      setDetailLoading(false);
    }
  }, [schoolId, selectedStudentId, showHealthData]);

  useEffect(() => { void loadStudentDetails(); }, [loadStudentDetails, refreshKey]);

  useEffect(() => {
    if (!schoolId || !showHealthData || !reportVisitId) return;
    let active = true;
    void (async () => {
      try {
        const { data, error: queryError } = await requireSupabase().from('student_health_visits')
          .select('id,student_id')
          .eq('school_id', schoolId).eq('id', reportVisitId).maybeSingle();
        if (queryError) throw queryError;
        if (!data) throw new Error('This health report was not found or you do not have permission to view it.');
        if (active) {
          setSelectedStudentId(data.student_id);
          setSelectedVisitId(data.id);
        }
      } catch (loadError) {
        if (active) setError(errorMessage(loadError, 'Could not open this health report.'));
      }
    })();
    return () => { active = false; };
  }, [schoolId, showHealthData, reportVisitId]);

  useEffect(() => {
    if (!reportVisitId) return;
    setSelectedVisitId(reportVisitId);
  }, [reportVisitId]);

  useEffect(() => {
    if (!selectedVisit) return;
    setVisitAt(new Date(new Date(selectedVisit.visit_at).getTime() - new Date(selectedVisit.visit_at).getTimezoneOffset() * 60000).toISOString().slice(0, 16));
    setSymptoms(selectedVisit.symptoms);
    setClinicalNotes(selectedVisit.clinical_notes);
    setAssessment(selectedVisit.assessment);
    setDiagnosis(selectedVisit.diagnosis);
    setAllergies(selectedVisit.allergies);
    setVitals({
      temperature_c: String(selectedVisit.vitals.temperature_c ?? ''),
      heart_rate_bpm: String(selectedVisit.vitals.heart_rate_bpm ?? ''),
      blood_pressure_systolic: String(selectedVisit.vitals.blood_pressure_systolic ?? ''),
      blood_pressure_diastolic: String(selectedVisit.vitals.blood_pressure_diastolic ?? ''),
      weight_kg: String(selectedVisit.vitals.weight_kg ?? ''),
      height_cm: String(selectedVisit.vitals.height_cm ?? ''),
      other_vitals: String(selectedVisit.vitals.other_vitals ?? ''),
    });
    setPrescriptions(selectedVisit.prescriptions.length ? selectedVisit.prescriptions : []);
  }, [selectedVisit]);

  const historySummary = useMemo(() => ({
    total: visits.length,
    latest: visits[0]?.visit_at ?? null,
  }), [visits]);
  const readinessSummary = useMemo(() => {
    const records = students.map((student) => readinessByStudent.get(student.id));
    const today = new Date().toISOString().slice(0, 10);
    return {
      knownAllergies: records.filter((record) => record?.allergy_status === 'known').length,
      unknownAllergies: records.filter((record) => !record || record.allergy_status === 'unknown').length,
      missingPlans: records.filter((record) => record?.allergy_status === 'known' && !record.emergency_action_plan.trim()).length,
      overdueReviews: records.filter((record) => record?.review_due_at && record.review_due_at < today).length,
    };
  }, [readinessByStudent, students]);
  const filteredReadinessStudents = useMemo(() => {
    const needle = readinessSearch.trim().toLowerCase();
    return students.filter((student) => !needle
      || `${student.first_name} ${student.last_name} ${student.student_number} ${relation(student.school_classes)?.name ?? ''}`.toLowerCase().includes(needle));
  }, [readinessSearch, students]);

  useEffect(() => {
    const record = readinessByStudent.get(selectedStudentId);
    setReadinessDraft(record ? {
      allergy_status: record.allergy_status,
      allergy_details: record.allergy_details,
      medical_conditions: record.medical_conditions,
      medication_status: record.medication_status,
      medication_details: record.medication_details,
      emergency_action_plan: record.emergency_action_plan,
      review_due_at: record.review_due_at ?? '',
    } : { ...emptyReadiness });
  }, [readinessByStudent, selectedStudentId]);

  function resetVisitForm() {
    setSelectedVisitId('');
    setVisitAt(localDateTime());
    setSymptoms('');
    setClinicalNotes('');
    setAssessment('');
    setDiagnosis('');
    setAllergies('');
    setVitals({ ...emptyVitals });
    setPrescriptions([]);
    setFormError('');
    setSuccess('');
  }

  async function saveVisit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !selectedStudent) return;
    setSaving(true);
    setFormError('');
    setSuccess('');
    try {
      const visitData = {
        student_id: selectedStudent.id,
        visit_at: new Date(visitAt).toISOString(),
        symptoms: symptoms.trim(),
        clinical_notes: clinicalNotes.trim(),
        assessment: assessment.trim(),
        diagnosis: isDoctor ? diagnosis.trim() : selectedVisit?.diagnosis ?? '',
        allergies: allergies.trim(),
        vitals: Object.fromEntries(Object.entries(vitals).map(([key, value]) => [
          key,
          value.trim() === '' ? null : (key === 'other_vitals' ? value.trim() : Number(value)),
        ])),
        prescriptions: prescriptions.filter((prescription) => prescription.medication_name.trim()),
      };
      const { data, error: saveError } = await requireSupabase().rpc('save_student_health_visit', {
        target_school: schoolId,
        target_visit: selectedVisitId || null,
        visit_data: visitData,
      });
      if (saveError) throw saveError;
      if (typeof data !== 'string') throw new Error('The health record was saved without returning its visit ID.');
      setSelectedVisitId(data);
      setSuccess('Health visit saved.');
      setRefreshKey((key) => key + 1);
    } catch (saveError) {
      setFormError(errorMessage(saveError, 'Could not save the health visit.'));
    } finally {
      setSaving(false);
    }
  }

  async function saveMedicalReadiness(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !selectedStudent) return;
    setReadinessSaving(true);
    setReadinessError('');
    setSuccess('');
    try {
      const { error: saveError } = await requireSupabase().rpc('save_student_medical_readiness', {
        target_school: schoolId,
        target_student: selectedStudent.id,
        readiness_payload: readinessDraft,
      });
      if (saveError) throw saveError;
      setSuccess('Medical and allergy readiness details saved.');
      setRefreshKey((current) => current + 1);
    } catch (saveError) {
      setReadinessError(errorMessage(saveError, 'Could not save medical readiness details.'));
    } finally {
      setReadinessSaving(false);
    }
  }

  async function inviteMedicalStaff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId) return;
    setInviting(true);
    setFormError('');
    setSuccess('');
    const form = new FormData(event.currentTarget);
    try {
      const { data, error: inviteError } = await requireSupabase().functions.invoke('staff-invite', {
        body: {
          schoolId,
          fullName: String(form.get('full_name') ?? '').trim(),
          email: String(form.get('email') ?? '').trim(),
          role: String(form.get('role') ?? '') as StaffRole,
        },
      });
      if (inviteError) {
        const response = inviteError.context instanceof Response
          ? await inviteError.context.json() as { error?: string }
          : null;
        throw new Error(response?.error ?? inviteError.message);
      }
      if (data?.error) throw new Error(data.error);
      event.currentTarget.reset();
      setSuccess('Invitation sent. The healthcare professional will receive a secure sign-in link.');
    } catch (inviteError) {
      setFormError(errorMessage(inviteError, 'Could not invite the healthcare professional.'));
    } finally {
      setInviting(false);
    }
  }

  async function downloadVisitReport(visit: Visit) {
    if (!selectedStudent) return;
    setError('');
    try {
      await makeHealthPdf(selectedStudent, [visit], contacts, true);
    } catch (reportError) {
      setError(errorMessage(reportError, 'Could not create the health visit PDF.'));
    }
  }

  async function downloadStudentReport() {
    if (!selectedStudent) return;
    setError('');
    try {
      await makeHealthPdf(selectedStudent, visits, contacts, false);
    } catch (reportError) {
      setError(errorMessage(reportError, 'Could not create the student medical history PDF.'));
    }
  }

  async function makeHealthPdf(student: Student, reportVisits: Visit[], emergencyContacts: EmergencyContact[], includeQr: boolean) {
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const left = 16;
    const width = pageWidth - left * 2;
    let y = 17;

    const ensureSpace = (height: number) => {
      if (y + height > 280) {
        pdf.addPage();
        y = 17;
      }
    };
    const drawSection = (title: string) => {
      ensureSpace(14);
      pdf.setFillColor(242, 241, 252);
      pdf.roundedRect(left, y, width, 9, 2, 2, 'F');
      pdf.setTextColor(66, 54, 120);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(10);
      pdf.text(title, left + 3, y + 6);
      y += 13;
    };
    const drawField = (label: string, value: string | number | null | undefined) => {
      const lines = pdf.splitTextToSize(pdfSafe(value), width - 30) as string[];
      const lineHeight = 4.2;
      ensureSpace(Math.max(6, lines.length * lineHeight + 2));
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(8);
      pdf.setTextColor(93, 98, 117);
      pdf.text(label, left, y);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(40, 44, 59);
      pdf.text(lines, left + 30, y);
      y += Math.max(6, lines.length * lineHeight + 2);
    };
    const drawText = (label: string, value: string) => drawField(label, value);

    pdf.setFillColor(54, 48, 104);
    pdf.roundedRect(left, y, width, 28, 3, 3, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(16);
    pdf.text(includeQr ? 'Student Health Visit Report' : 'Student Medical History', left + 6, y + 10);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.text(pdfSafe(activeMembership?.school.name), left + 6, y + 18);
    pdf.text(`Generated ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date())}`, left + 6, y + 24);
    y += 35;

    drawSection('STUDENT DETAILS');
    drawField('Student name', `${student.first_name} ${student.last_name}`);
    drawField('Student ID', student.student_number);
    drawField('Class / stream', relation(student.school_classes)?.name ?? 'Not assigned');
    drawField('Grade', relation(student.school_classes)?.grade_level ?? 'Not recorded');
    drawField('Date of birth', student.date_of_birth ?? 'Not recorded');
    drawField('Student email', student.email ?? 'Not recorded');

    drawSection('EMERGENCY CONTACTS');
    if (!emergencyContacts.length) drawText('Contacts', 'No emergency contacts recorded.');
    emergencyContacts.forEach((contact, index) => {
      drawField(`Contact ${index + 1}`, `${contact.contact_name}${contact.relationship ? ` (${contact.relationship})` : ''}`);
      drawField('Phone / email', `${contact.phone}${contact.email ? ` · ${contact.email}` : ''}`);
    });

    if (!reportVisits.length) {
      drawSection('MEDICAL HISTORY');
      drawText('History', 'No health visits have been recorded.');
    }
    reportVisits.forEach((visit, index) => {
      drawSection(`${includeQr ? 'VISIT DETAILS' : `VISIT ${reportVisits.length - index}`} · ${formatDate(visit.visit_at)}`);
      drawField('Symptoms', visit.symptoms);
      drawField('Clinical notes', visit.clinical_notes);
      drawField('Assessment', visit.assessment);
      drawField('Diagnosis', visit.diagnosis);
      drawField('Allergies', visit.allergies);
      const vitalLines = [
        ['Temperature (°C)', visit.vitals.temperature_c],
        ['Heart rate (bpm)', visit.vitals.heart_rate_bpm],
        ['Blood pressure (mmHg)', `${visit.vitals.blood_pressure_systolic ?? '—'} / ${visit.vitals.blood_pressure_diastolic ?? '—'}`],
        ['Weight (kg)', visit.vitals.weight_kg],
        ['Height (cm)', visit.vitals.height_cm],
        ['Other vitals', visit.vitals.other_vitals],
      ].filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '');
      drawField('Vitals', vitalLines.length
        ? vitalLines.map(([label, value]) => `${label}: ${value}`).join('   ·   ')
        : 'No vital signs recorded.');
      if (visit.prescriptions.length) {
        visit.prescriptions.forEach((prescription, prescriptionIndex) => {
          drawField(`Prescription ${prescriptionIndex + 1}`, [
            prescription.medication_name,
            prescription.dosage && `Dosage: ${prescription.dosage}`,
            prescription.frequency && `Frequency: ${prescription.frequency}`,
            prescription.duration && `Duration: ${prescription.duration}`,
            prescription.instructions && `Instructions: ${prescription.instructions}`,
          ].filter(Boolean).join(' · '));
        });
      } else {
        drawText('Prescriptions', 'None recorded.');
      }
    });

    if (includeQr && reportVisits[0]) {
      ensureSpace(65);
      drawSection('SECURE ONLINE REPORT');
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(75, 80, 96);
      pdf.text('Scan to sign in and open this protected report in Campus Connect.', left, y);
      y += 4;
      const reportUrl = new URL(`/health/report/${reportVisits[0].id}`, window.location.origin).toString();
      const qr = await QRCode.toDataURL(reportUrl, { errorCorrectionLevel: 'Q', margin: 1, width: 280 });
      ensureSpace(38);
      pdf.addImage(qr, 'PNG', left, y, 34, 34);
      pdf.setFontSize(7);
      pdf.text('Medical information is confidential.', left + 40, y + 8);
      pdf.text('Authentication and school health-role access are required.', left + 40, y + 14);
      y += 39;
    }

    pdf.setTextColor(110, 114, 128);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7);
    pdf.text('Confidential student health information. Share and store securely.', left, 288);
    const safeStudentNumber = student.student_number.replace(/[^a-z0-9_-]/gi, '_');
    pdf.save(`${includeQr ? 'health-visit' : 'medical-history'}-${safeStudentNumber}.pdf`);
  }

  if (!canUseHealth && !isAdmin) {
    return <div className="page-stack"><ErrorState message="This confidential health workspace is available only to the school’s assigned nurse or doctor." /></div>;
  }

  if (isAdmin) {
    return (
      <div className="page-stack health-page">
        <header className="page-heading">
          <div><span className="eyebrow">Confidential student care</span><h1>Healthcare staff access</h1><p>Invite the school nurse or doctor. School administrators can provision access but cannot open student medical records.</p></div>
          <ShieldCheck size={24} className="muted-icon" />
        </header>
        {error && <ErrorState message={error} />}
        {success && <SuccessMessage message={success} />}
        <section className="content-card health-invite-card">
          <div className="section-heading"><div><span className="eyebrow">Least-privilege access</span><h2>Invite a healthcare professional</h2></div><MailPlus size={20} className="muted-icon" /></div>
          <p>Health records are restricted to members assigned the nurse or doctor role. Only doctors can record a diagnosis.</p>
          {formError && <ErrorState message={formError} />}
          <form className="health-invite-form" onSubmit={(event) => void inviteMedicalStaff(event)}>
            <label className="field"><span>Full name</span><input name="full_name" required minLength={2} maxLength={120} disabled={inviting} /></label>
            <label className="field"><span>Work email</span><input name="email" type="email" required maxLength={320} disabled={inviting} /></label>
            <label className="field"><span>Healthcare role</span><select name="role" disabled={inviting}><option value="nurse">School nurse</option><option value="doctor">School doctor</option></select></label>
            <button className="button button-primary" type="submit" disabled={inviting}><MailPlus size={16} />{inviting ? 'Sending invitation…' : 'Invite healthcare staff'}</button>
          </form>
        </section>
      </div>
    );
  }

  return (
    <div className="page-stack health-page">
      <header className="page-heading">
        <div><span className="eyebrow">Confidential student care</span><h1>Student health</h1><p>Record clinic visits and review each student’s protected medical history.</p></div>
        <HeartPulse size={24} className="muted-icon" />
      </header>
      {error && <ErrorState message={error} />}
      {success && <SuccessMessage message={success} />}
      {loading ? <LoadingState label="Loading school students…" /> : students.length === 0
        ? <section className="content-card"><p>No active students are available for health visits.</p></section>
        : <>
          <section className="content-card health-readiness-register">
            <div className="section-heading"><div><span className="eyebrow">Medical &amp; allergy readiness</span><h2>Readiness register</h2></div><ShieldCheck size={19} className="muted-icon" /></div>
            <p>Review known allergies, medication information, emergency action plans, and upcoming record reviews. New records remain marked unknown until healthcare staff assess them.</p>
            {readinessError && <ErrorState message={readinessError} />}
            <div className="health-readiness-metrics">
              <article><span>Known allergies</span><strong>{readinessSummary.knownAllergies}</strong></article>
              <article><span>Allergy status unknown</span><strong>{readinessSummary.unknownAllergies}</strong></article>
              <article><span>Action plan needed</span><strong>{readinessSummary.missingPlans}</strong></article>
              <article><span>Reviews overdue</span><strong>{readinessSummary.overdueReviews}</strong></article>
            </div>
            <label className="health-readiness-search"><UserRound size={14} /><input value={readinessSearch} onChange={(event) => setReadinessSearch(event.target.value)} placeholder="Find a student in the readiness register" aria-label="Search medical readiness register" /></label>
            {readinessLoading ? <LoadingState label="Loading medical readiness…" /> : <div className="health-readiness-list">
              {filteredReadinessStudents.map((student) => {
                const record = readinessByStudent.get(student.id);
                const allergyStatus = record?.allergy_status ?? 'unknown';
                const medicationStatus = record?.medication_status ?? 'unknown';
                const reviewOverdue = Boolean(record?.review_due_at && record.review_due_at < new Date().toISOString().slice(0, 10));
                return <button type="button" key={student.id} className={`health-readiness-row${selectedStudentId === student.id ? ' selected' : ''}`} onClick={() => {
                  if (student.id !== selectedStudentId) {
                    resetVisitForm();
                    setSelectedStudentId(student.id);
                  }
                }}>
                  <span><strong>{student.first_name} {student.last_name}</strong><small>{student.student_number} · {relation(student.school_classes)?.name ?? 'No class'}</small></span>
                  <span className={`health-readiness-badge ${allergyStatus}`}>{allergyStatus === 'known' ? 'Known allergy' : allergyStatus === 'none_known' ? 'No known allergies' : 'Allergy status unknown'}</span>
                  <span className={`health-readiness-badge ${medicationStatus}`}>{medicationStatus === 'on_file' ? 'Medication on file' : medicationStatus === 'none' ? 'No medication' : 'Medication unknown'}</span>
                  <small className={reviewOverdue ? 'overdue' : ''}>{reviewOverdue ? `Review overdue · ${record?.review_due_at}` : record?.review_due_at ? `Review due · ${record.review_due_at}` : 'No review date set'}</small>
                </button>;
              })}
              {filteredReadinessStudents.length === 0 && <p className="health-muted">No students match this search.</p>}
            </div>}
          </section>
          <section className="health-overview-grid">
            <article className="content-card health-student-picker">
              <label className="field"><span><UserRound size={14} /> Select student</span>
                <select value={selectedStudentId} onChange={(event) => { resetVisitForm(); setSelectedStudentId(event.target.value); }}>
                  {students.map((student) => <option key={student.id} value={student.id}>{student.last_name}, {student.first_name} · {student.student_number}</option>)}
                </select>
              </label>
              {selectedStudent && <div className="health-student-facts">
                <div><span>Student</span><strong>{selectedStudent.first_name} {selectedStudent.last_name}</strong></div>
                <div><span>Student ID</span><strong>{selectedStudent.student_number}</strong></div>
                <div><span>Class / stream</span><strong>{selectedClass?.name ?? 'Not assigned'}</strong></div>
                <div><span>Grade</span><strong>{selectedClass?.grade_level ?? 'Not recorded'}</strong></div>
                <div><span>Status</span><strong>{selectedStudent.status.replaceAll('_', ' ')}</strong></div>
                <div><span>Date of birth</span><strong>{selectedStudent.date_of_birth ?? 'Not recorded'}</strong></div>
                <div><span>Email</span><strong>{selectedStudent.email ?? 'Not recorded'}</strong></div>
              </div>}
            </article>
            <article className="content-card health-summary-card">
              <span className="health-summary-icon"><Activity size={20} /></span>
              <div><span className="eyebrow">Health visit history</span><strong>{historySummary.total}</strong><small>{historySummary.latest ? `Most recent: ${formatDate(historySummary.latest)}` : 'No prior visits'}</small></div>
            </article>
          </section>

          {selectedStudent && <section className="content-card health-readiness-editor">
            <div className="section-heading"><div><span className="eyebrow">Clinical readiness record</span><h2>{selectedStudent.first_name} {selectedStudent.last_name}</h2></div><ShieldCheck size={19} className="muted-icon" /></div>
            {readinessError && <ErrorState message={readinessError} />}
            {readinessByStudent.get(selectedStudent.id) && <p className="health-muted">Last reviewed {readinessByStudent.get(selectedStudent.id)?.reviewed_at}{readinessByStudent.get(selectedStudent.id)?.review_due_at ? ` · Next review due ${readinessByStudent.get(selectedStudent.id)?.review_due_at}` : ''}</p>}
            <form className="health-readiness-form" onSubmit={(event) => void saveMedicalReadiness(event)}>
              <label className="field"><span>Allergy status</span><select value={readinessDraft.allergy_status} disabled={readinessSaving} onChange={(event) => setReadinessDraft((current) => ({ ...current, allergy_status: event.target.value as MedicalReadinessDraft['allergy_status'], allergy_details: event.target.value === 'known' ? current.allergy_details : '' }))}>
                <option value="unknown">Unknown / not assessed</option><option value="none_known">No known allergies</option><option value="known">Known allergies</option>
              </select></label>
              {readinessDraft.allergy_status === 'known' && <label className="field"><span>Known allergies *</span><textarea required maxLength={5000} value={readinessDraft.allergy_details} disabled={readinessSaving} onChange={(event) => setReadinessDraft((current) => ({ ...current, allergy_details: event.target.value }))} /></label>}
              <label className="field"><span>Medical conditions</span><textarea maxLength={5000} value={readinessDraft.medical_conditions} disabled={readinessSaving} onChange={(event) => setReadinessDraft((current) => ({ ...current, medical_conditions: event.target.value }))} /></label>
              <label className="field"><span>Medication status</span><select value={readinessDraft.medication_status} disabled={readinessSaving} onChange={(event) => setReadinessDraft((current) => ({ ...current, medication_status: event.target.value as MedicalReadinessDraft['medication_status'], medication_details: event.target.value === 'on_file' ? current.medication_details : '' }))}>
                <option value="unknown">Unknown / not assessed</option><option value="none">No medication on file</option><option value="on_file">Medication on file</option>
              </select></label>
              {readinessDraft.medication_status === 'on_file' && <label className="field"><span>Medication and storage instructions *</span><textarea required maxLength={5000} value={readinessDraft.medication_details} disabled={readinessSaving} onChange={(event) => setReadinessDraft((current) => ({ ...current, medication_details: event.target.value }))} /></label>}
              <label className="field"><span>Emergency action plan</span><textarea maxLength={5000} value={readinessDraft.emergency_action_plan} disabled={readinessSaving} onChange={(event) => setReadinessDraft((current) => ({ ...current, emergency_action_plan: event.target.value }))} /></label>
              <label className="field"><span>Next review due</span><input type="date" value={readinessDraft.review_due_at} disabled={readinessSaving} onChange={(event) => setReadinessDraft((current) => ({ ...current, review_due_at: event.target.value }))} /></label>
              <button className="button button-primary" type="submit" disabled={readinessSaving}><Save size={15} />{readinessSaving ? 'Saving…' : 'Save readiness record'}</button>
            </form>
          </section>}

          <section className="health-workspace-grid">
            <article className="content-card health-visit-form-card">
              <div className="section-heading"><div><span className="eyebrow">{selectedVisit ? 'Update saved visit' : 'New clinic visit'}</span><h2>{selectedVisit ? 'Health record' : 'Register health visit'}</h2></div><FileHeart size={20} className="muted-icon" /></div>
              {formError && <ErrorState message={formError} />}
              <form className="health-form" onSubmit={(event) => void saveVisit(event)}>
                <label className="field health-span-2"><span>Visit date and time</span><input type="datetime-local" required value={visitAt} onChange={(event) => setVisitAt(event.target.value)} disabled={saving} /></label>
                <label className="field health-span-2"><span>Symptoms reported</span><textarea maxLength={5000} value={symptoms} onChange={(event) => setSymptoms(event.target.value)} placeholder="Symptoms reported by the student" disabled={saving} /></label>
                <label className="field health-span-2"><span>Clinical notes and observations</span><textarea maxLength={10000} value={clinicalNotes} onChange={(event) => setClinicalNotes(event.target.value)} placeholder="Free-text clinical notes" disabled={saving} /></label>
                <label className="field health-span-2"><span>Assessment</span><textarea maxLength={5000} value={assessment} onChange={(event) => setAssessment(event.target.value)} placeholder="Assessment or observations" disabled={saving} /></label>
                <label className="field health-span-2"><span>Diagnosis <small>{isDoctor ? 'Recorded by an authorized doctor' : 'Doctor-only field'}</small></span><textarea maxLength={5000} value={diagnosis} onChange={(event) => setDiagnosis(event.target.value)} placeholder={isDoctor ? 'Diagnosis, when provided' : 'Only a school doctor can record a diagnosis'} disabled={!isDoctor || saving} /></label>
                <label className="field health-span-2"><span>Allergies</span><textarea maxLength={5000} value={allergies} onChange={(event) => setAllergies(event.target.value)} placeholder="Known or reported allergies, or note that none are known" disabled={saving} /></label>

                <fieldset className="health-fieldset health-span-2">
                  <legend>Vitals <small>All measurements are optional</small></legend>
                  <div className="health-vitals-grid">
                    <label className="field"><span>Temperature (°C)</span><input type="number" min="25" max="45" step="0.1" value={vitals.temperature_c} onChange={(event) => setVitals({ ...vitals, temperature_c: event.target.value })} disabled={saving} /></label>
                    <label className="field"><span>Heart rate (bpm)</span><input type="number" min="20" max="300" value={vitals.heart_rate_bpm} onChange={(event) => setVitals({ ...vitals, heart_rate_bpm: event.target.value })} disabled={saving} /></label>
                    <label className="field"><span>Systolic blood pressure</span><input type="number" min="40" max="300" value={vitals.blood_pressure_systolic} onChange={(event) => setVitals({ ...vitals, blood_pressure_systolic: event.target.value })} disabled={saving} /></label>
                    <label className="field"><span>Diastolic blood pressure</span><input type="number" min="20" max="200" value={vitals.blood_pressure_diastolic} onChange={(event) => setVitals({ ...vitals, blood_pressure_diastolic: event.target.value })} disabled={saving} /></label>
                    <label className="field"><span>Weight (kg)</span><input type="number" min="0.2" max="500" step="0.1" value={vitals.weight_kg} onChange={(event) => setVitals({ ...vitals, weight_kg: event.target.value })} disabled={saving} /></label>
                    <label className="field"><span>Height (cm)</span><input type="number" min="20" max="250" step="0.1" value={vitals.height_cm} onChange={(event) => setVitals({ ...vitals, height_cm: event.target.value })} disabled={saving} /></label>
                    <label className="field health-span-2"><span>Other vital signs</span><input maxLength={1000} value={vitals.other_vitals} onChange={(event) => setVitals({ ...vitals, other_vitals: event.target.value })} placeholder="Optional additional observations" disabled={saving} /></label>
                  </div>
                </fieldset>

                <fieldset className="health-fieldset health-span-2">
                  <legend>Prescriptions</legend>
                  {prescriptions.map((prescription, index) => <div className="health-prescription" key={`prescription-${index}`}>
                    <div className="health-prescription-heading"><strong>Medication {index + 1}</strong><button className="icon-button" type="button" aria-label={`Remove medication ${index + 1}`} onClick={() => setPrescriptions(prescriptions.filter((_, itemIndex) => itemIndex !== index))} disabled={saving}><X size={16} /></button></div>
                    <div className="health-vitals-grid">
                      {([
                        ['medication_name', 'Medication name'],
                        ['dosage', 'Dosage'],
                        ['frequency', 'Frequency'],
                        ['duration', 'Duration'],
                        ['instructions', 'Instructions'],
                      ] as const).map(([key, label]) => <label className={`field${key === 'instructions' ? ' health-span-2' : ''}`} key={key}><span>{label}{key === 'medication_name' ? ' *' : ''}</span>{key === 'instructions'
                        ? <textarea maxLength={2000} value={prescription[key]} onChange={(event) => setPrescriptions(prescriptions.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: event.target.value } : item))} disabled={saving} />
                        : <input required={key === 'medication_name'} maxLength={200} value={prescription[key]} onChange={(event) => setPrescriptions(prescriptions.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: event.target.value } : item))} disabled={saving} />}</label>)}
                    </div>
                  </div>)}
                  <button className="button button-quiet" type="button" onClick={() => setPrescriptions([...prescriptions, emptyPrescription()])} disabled={saving}><Plus size={15} />Add medication</button>
                </fieldset>
                <div className="health-form-actions health-span-2">
                  <button className="button button-primary" type="submit" disabled={saving}><Save size={16} />{saving ? 'Saving…' : selectedVisit ? 'Save changes' : 'Save health visit'}</button>
                  {selectedVisit && <button className="button button-quiet" type="button" onClick={resetVisitForm} disabled={saving}>New visit</button>}
                </div>
              </form>
            </article>

            <div className="health-history-column">
              <section className="content-card health-contacts-card">
                <div className="section-heading"><div><span className="eyebrow">For urgent contact</span><h2>Emergency contacts</h2></div><UserRound size={19} className="muted-icon" /></div>
                {contacts.length ? contacts.map((contact, index) => <div className="health-contact-row" key={`${contact.phone}-${index}`}>
                  <strong>{contact.contact_name}</strong><span>{contact.relationship || 'Contact'}</span><a href={`tel:${contact.phone}`}>{contact.phone}</a>{contact.email && <a href={`mailto:${contact.email}`}>{contact.email}</a>}
                </div>) : <p className="health-muted">No emergency contacts are recorded in the student profile.</p>}
              </section>
              <section className="content-card health-history-card">
                <div className="section-heading"><div><span className="eyebrow">Student medical history</span><h2>Previous visits</h2></div><FileHeart size={19} className="muted-icon" /></div>
                {detailLoading ? <LoadingState label="Loading health history…" /> : visits.length === 0
                  ? <p className="health-muted">No previous health visits recorded.</p>
                  : <div className="health-visit-list">{visits.map((visit) => <button className={`health-visit-item${selectedVisitId === visit.id ? ' selected' : ''}`} type="button" key={visit.id} onClick={() => { setSelectedVisitId(visit.id); setSuccess(''); }}>
                    <span className="health-visit-date">{formatDate(visit.visit_at)}</span>
                    <span>{visit.symptoms || visit.assessment || visit.diagnosis || 'Clinic visit'}</span>
                    <small>{visit.diagnosis ? `Diagnosis: ${visit.diagnosis}` : 'Open visit details'}</small>
                  </button>)}</div>}
                <div className="health-report-actions">
                  <button className="button button-secondary" type="button" onClick={() => void downloadStudentReport()}><Download size={15} />Detailed student report</button>
                  {selectedVisit && <button className="button button-quiet" type="button" onClick={() => void downloadVisitReport(selectedVisit)}><QrCode size={15} />Current visit PDF + QR</button>}
                </div>
              </section>
              {reportVisit && <section className="content-card health-secure-report-card">
                <div className="section-heading"><div><span className="eyebrow">Secure report link</span><h2>Report opened</h2></div><ShieldCheck size={19} className="muted-icon" /></div>
                <p>This report is protected by sign-in and the school’s healthcare role. Download the current visit PDF, including its secure QR link.</p>
                <button className="button button-primary" type="button" onClick={() => void downloadVisitReport(reportVisit)}><Download size={15} />Download this visit report</button>
              </section>}
            </div>
          </section>
        </>}
    </div>
  );
}
