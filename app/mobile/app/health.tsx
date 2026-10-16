import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { BodyText, Button, Card, Field, Heading, Loading, Message, Page, colors } from '../src/components/ui';
import { useCampusAuth } from '../src/lib/auth-context';
import { requireSupabase } from '../src/lib/supabase';
import type { HealthVisit } from '../src/lib/types';
import { canUseModule } from '../src/lib/validation';

interface StudentRow {
  id: string;
  student_number: string;
  first_name: string;
  last_name: string;
  class_id: string | null;
  school_classes: { name: string } | null;
}

interface Prescription {
  medication_name: string;
  dosage: string;
  frequency: string;
  duration: string;
  instructions: string;
}

const emptyPrescription: Prescription = {
  medication_name: '',
  dosage: '',
  frequency: '',
  duration: '',
  instructions: '',
};

const vitalFields = [
  ['temperature_c', 'Temperature (°C)'],
  ['heart_rate_bpm', 'Heart rate (bpm)'],
  ['blood_pressure_systolic', 'Blood pressure systolic (mmHg)'],
  ['blood_pressure_diastolic', 'Blood pressure diastolic (mmHg)'],
  ['weight_kg', 'Weight (kg)'],
  ['height_cm', 'Height (cm)'],
] as const;

export default function HealthScreen() {
  const { selectedSchool } = useCampusAuth();
  const [search, setSearch] = useState('');
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [student, setStudent] = useState<StudentRow | null>(null);
  const [history, setHistory] = useState<HealthVisit[]>([]);
  const [symptoms, setSymptoms] = useState('');
  const [clinicalNotes, setClinicalNotes] = useState('');
  const [assessment, setAssessment] = useState('');
  const [diagnosis, setDiagnosis] = useState('');
  const [allergies, setAllergies] = useState('');
  const [vitals, setVitals] = useState<Record<string, string>>({});
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const isDoctor = selectedSchool?.role === 'doctor';

  const findStudents = useCallback(async () => {
    if (!selectedSchool || search.trim().length < 2) return;
    setLoading(true);
    setError('');
    try {
      const { data, error: queryError } = await requireSupabase().from('students')
        .select('id,student_number,first_name,last_name,class_id,school_classes(name)')
        .eq('school_id', selectedSchool.school_id)
        .eq('status', 'active')
        .or(`student_number.ilike.%${search.trim()}%,first_name.ilike.%${search.trim()}%,last_name.ilike.%${search.trim()}%`)
        .order('last_name')
        .limit(20);
      if (queryError) throw queryError;
      setStudents((data ?? []) as unknown as StudentRow[]);
      if (!data?.length) setNotice('No active students matched the search.');
    } catch (queryError) {
      setError(queryError instanceof Error ? queryError.message : 'Student search failed.');
    } finally {
      setLoading(false);
    }
  }, [selectedSchool, search]);

  const loadHistory = useCallback(async (studentId: string) => {
    if (!selectedSchool) return;
    setLoading(true);
    setError('');
    try {
      const { data, error: queryError } = await requireSupabase().from('student_health_visits')
        .select('id,student_id,visit_at,symptoms,clinical_notes,assessment,diagnosis,allergies,vitals,prescriptions')
        .eq('school_id', selectedSchool.school_id)
        .eq('student_id', studentId)
        .order('visit_at', { ascending: false })
        .limit(50);
      if (queryError) throw queryError;
      setHistory((data ?? []) as HealthVisit[]);
    } catch (historyError) {
      setError(historyError instanceof Error ? historyError.message : 'Could not load the protected health history.');
    } finally {
      setLoading(false);
    }
  }, [selectedSchool]);

  useEffect(() => {
    if (student) void loadHistory(student.id);
  }, [student, loadHistory]);

  async function saveVisit() {
    if (!selectedSchool || !student) {
      setError('Select a student before saving a health visit.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const vitalValues = Object.fromEntries(Object.entries(vitals)
        .filter(([, value]) => value.trim() !== '')
        .map(([key, value]) => [key, Number(value)]));
      if (Object.values(vitalValues).some((value) => !Number.isFinite(value))) {
        throw new Error('Vital sign values must be numeric, or left blank.');
      }
      const activePrescriptions = prescriptions.filter((item) => item.medication_name.trim());
      const { error: saveError } = await requireSupabase().rpc('save_student_health_visit', {
        target_school: selectedSchool.school_id,
        target_visit: null,
        visit_data: {
          student_id: student.id,
          visit_at: new Date().toISOString(),
          symptoms: symptoms.trim(),
          clinical_notes: clinicalNotes.trim(),
          assessment: assessment.trim(),
          diagnosis: isDoctor ? diagnosis.trim() : '',
          allergies: allergies.trim(),
          vitals: vitalValues,
          prescriptions: activePrescriptions.map((item) => ({
            medication_name: item.medication_name.trim(),
            dosage: item.dosage.trim(),
            frequency: item.frequency.trim(),
            duration: item.duration.trim(),
            instructions: item.instructions.trim(),
          })),
        },
      });
      if (saveError) throw saveError;
      setNotice('Clinic visit saved to the selected student’s confidential history.');
      setSymptoms('');
      setClinicalNotes('');
      setAssessment('');
      setDiagnosis('');
      setAllergies('');
      setVitals({});
      setPrescriptions([]);
      await loadHistory(student.id);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The health record could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  if (!selectedSchool) return null;
  if (!canUseModule(selectedSchool, 'health') || !['nurse', 'doctor'].includes(selectedSchool.role)) {
    return <Page title="Student health"><Message variant="error">Health records are available only to authorised school nurses and doctors.</Message></Page>;
  }

  return (
    <Page title="Student health" subtitle="Confidential clinic workflows for authorised healthcare staff.">
      <Message>Clinical records are protected and are not available to teachers or general school staff. Vital signs remain optional.</Message>
      {error ? <Message variant="error">{error}</Message> : null}
      {notice ? <Message variant="success">{notice}</Message> : null}
      <Card>
        <Heading>Find a student</Heading>
        <Field label="Student name or student number" value={search} onChangeText={setSearch} />
        <Button title="Search school records" variant="secondary" onPress={() => void findStudents()} />
        {loading && students.length === 0 ? <Loading label="Searching school roster…" /> : null}
        {students.map((item) => <Button key={item.id}
          title={`${item.first_name} ${item.last_name} · ${item.student_number}${item.school_classes?.name ? ` · ${item.school_classes.name}` : ''}`}
          variant={student?.id === item.id ? 'primary' : 'secondary'}
          onPress={() => setStudent(item)} />)}
      </Card>

      {student ? <>
        <Card>
          <Heading>Selected student</Heading>
          <Text style={{ color: colors.text, fontSize: 18, fontWeight: '800' }}>{student.first_name} {student.last_name}</Text>
          <BodyText>Student ID: {student.student_number}</BodyText>
          <BodyText>Class: {student.school_classes?.name ?? 'Not assigned'}</BodyText>
        </Card>
        <Card>
          <Heading>Register clinic visit</Heading>
          <BodyText muted>Visit time is recorded when saved. Leave unmeasured vital fields empty.</BodyText>
          <Field label="Symptoms" value={symptoms} onChangeText={setSymptoms} multiline maxLength={5000} />
          <Field label="Clinical notes" value={clinicalNotes} onChangeText={setClinicalNotes} multiline maxLength={10000} />
          <Field label="Assessment" value={assessment} onChangeText={setAssessment} multiline maxLength={5000} />
          {isDoctor ? <Field label="Diagnosis (doctor only)" value={diagnosis} onChangeText={setDiagnosis} multiline maxLength={5000} /> : null}
          <Field label="Known allergies / allergy notes" value={allergies} onChangeText={setAllergies} multiline maxLength={5000} />
        </Card>
        <Card>
          <Heading>Vital signs (all optional)</Heading>
          {vitalFields.map(([key, label]) => <Field key={key} label={label}
            keyboardType="decimal-pad"
            value={vitals[key] ?? ''}
            onChangeText={(value) => setVitals((current) => ({ ...current, [key]: value }))} />)}
        </Card>
        <Card>
          <Heading>Prescriptions</Heading>
          {prescriptions.map((prescription, index) => <View key={`prescription-${index}`} style={{ gap: 9, borderTopWidth: 1, borderColor: colors.border, paddingTop: 10 }}>
            <Field label="Medication name" value={prescription.medication_name} onChangeText={(value) => setPrescriptions((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, medication_name: value } : item))} />
            <Field label="Dosage" value={prescription.dosage} onChangeText={(value) => setPrescriptions((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, dosage: value } : item))} />
            <Field label="Frequency" value={prescription.frequency} onChangeText={(value) => setPrescriptions((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, frequency: value } : item))} />
            <Field label="Duration" value={prescription.duration} onChangeText={(value) => setPrescriptions((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, duration: value } : item))} />
            <Field label="Instructions" value={prescription.instructions} onChangeText={(value) => setPrescriptions((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, instructions: value } : item))} multiline />
            <Button title="Remove prescription" variant="secondary" onPress={() => setPrescriptions((current) => current.filter((_, itemIndex) => itemIndex !== index))} />
          </View>)}
          <Button title="Add prescription" variant="secondary" onPress={() => setPrescriptions((current) => [...current, { ...emptyPrescription }])} />
        </Card>
        <Button title={saving ? 'Saving confidential record…' : 'Save health visit'} disabled={saving} onPress={() => void saveVisit()} />

        <Heading>Visit history</Heading>
        {loading ? <Loading label="Loading confidential visit history…" />
          : history.length === 0 ? <Card><BodyText muted>No previous clinic visits are recorded for this student.</BodyText></Card>
            : history.map((visit) => <Card key={visit.id}>
              <Text style={{ color: colors.text, fontWeight: '700' }}>{new Date(visit.visit_at).toLocaleString()}</Text>
              {visit.symptoms ? <BodyText>Symptoms: {visit.symptoms}</BodyText> : null}
              {visit.clinical_notes ? <BodyText>Notes: {visit.clinical_notes}</BodyText> : null}
              {visit.assessment ? <BodyText>Assessment: {visit.assessment}</BodyText> : null}
              {visit.diagnosis ? <BodyText>Diagnosis: {visit.diagnosis}</BodyText> : null}
              {visit.allergies ? <BodyText>Allergies: {visit.allergies}</BodyText> : null}
              {Object.entries(visit.vitals ?? {}).length ? <BodyText>Vitals: {Object.entries(visit.vitals).map(([key, value]) => `${key.replaceAll('_', ' ')} ${value}`).join(' · ')}</BodyText> : null}
              {visit.prescriptions?.length ? <BodyText>Prescriptions: {visit.prescriptions.map((item) => `${item.medication_name}${item.dosage ? ` · ${item.dosage}` : ''}`).join('; ')}</BodyText> : null}
            </Card>)}
      </> : <Card><BodyText muted>Select a student to register a visit or review their medical history.</BodyText></Card>}
    </Page>
  );
}
