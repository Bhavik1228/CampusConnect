import { Fragment, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { jsPDF } from 'jspdf';
import QRCode from 'qrcode';
import {
  Award, Check, Download, FileText, GraduationCap, History, LockKeyhole, MessageSquare,
  Pencil, Plus, Save, Settings2, ShieldCheck, Sparkles, X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { DraftRecoveryControls } from '../components/DraftRecoveryControls';
import { requireSupabase } from '../lib/supabase';
import { useRecoverableDraft } from '../lib/recoverable-drafts';
import { PdfPreviewDialog } from '../components/PdfPreviewDialog';
import {
  documentVerificationUrl,
  prepareOfficialDocument,
  savePdfBlob,
  storeOfficialDocument,
} from '../lib/official-documents';

type ResultStatus = 'draft' | 'approved' | 'published';
type Result = {
  id: string;
  student_id: string;
  assessment_id: string;
  created_by: string;
  marks_obtained: number;
  maximum_marks: number;
  percentage: number;
  assessment_date: string;
  notes: string;
  teacher_comment: string;
  status: ResultStatus;
  correction_reason: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
};
type ResultRevision = {
  result_id: string;
  previous_marks: number;
  previous_comment: string;
  reason: string;
  created_at: string;
};
type Student = {
  id: string;
  student_number: string;
  first_name: string;
  last_name: string;
  status: string;
};
type Assessment = {
  id: string;
  title: string;
  subject: string;
  total_marks: number;
};
type ReportTemplate = {
  id: string;
  school_id: string;
  name: string;
  layout: TemplateLayout;
  title: string;
  subtitle: string;
  accent_color: string;
  footer: string;
};
type TemplateLayout = 'classic' | 'modern' | 'minimal' | 'academic' | 'vibrant';
type GradingScale = {
  grading_scale: 'percentage' | 'letter' | 'gpa' | 'custom';
  grade_boundaries: Record<string, number>;
};
type ResultForm = {
  student_id: string;
  assessment_id: string;
  marks_obtained: string;
  assessment_date: string;
  teacher_comment: string;
  correction_reason: string;
};

const BUILT_IN_TEMPLATES: Omit<ReportTemplate, 'id' | 'school_id'>[] = [
  { name: 'Classic', layout: 'classic', title: 'STUDENT REPORT', subtitle: 'Academic achievement & progress', accent_color: '#5147c7', footer: 'Prepared by the school administration' },
  { name: 'Modern', layout: 'modern', title: 'LEARNING REPORT', subtitle: 'A clear view of progress this term', accent_color: '#167b82', footer: 'Every step forward matters.' },
  { name: 'Minimal', layout: 'minimal', title: 'ACADEMIC RECORD', subtitle: 'Student assessment summary', accent_color: '#344256', footer: 'Official student record' },
  { name: 'Academic', layout: 'academic', title: 'TERM RESULTS', subtitle: 'Assessment results & teacher feedback', accent_color: '#8c612d', footer: 'Learning with purpose' },
  { name: 'Vibrant', layout: 'vibrant', title: 'MY PROGRESS', subtitle: 'Celebrating achievement and growth', accent_color: '#d35476', footer: 'Keep curious. Keep growing.' },
];
const DEFAULT_BOUNDARIES: Record<string, number> = {
  'A*': 90, A: 80, B: 70, C: 60, D: 50, E: 40, U: 0,
};
const EMPTY_FORM: ResultForm = {
  student_id: '', assessment_id: '', marks_obtained: '', assessment_date: new Date().toISOString().slice(0, 10),
  teacher_comment: '', correction_reason: '',
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

async function loadReportLogo(url: string | null) {
  if (!url || !/^https:\/\//i.test(url)) return null;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`School logo request failed (${response.status}).`);
  const blob = await response.blob();
  if (!['image/png', 'image/jpeg'].includes(blob.type) || blob.size > 2_000_000) {
    throw new Error('School logo must be a PNG or JPEG under 2 MB.');
  }
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the school logo.'));
    reader.readAsDataURL(blob);
  });
  return { data, format: blob.type === 'image/png' ? 'PNG' as const : 'JPEG' as const };
}

function formatDate(date: string) {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

function gradeFor(percentage: number, boundaries: Record<string, number>) {
  const entry = Object.entries(boundaries)
    .filter(([, boundary]) => Number.isFinite(Number(boundary)))
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .find(([, boundary]) => percentage >= Number(boundary));
  return entry?.[0] ?? '—';
}

function hexRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function drawReportPage(
  pdf: jsPDF,
  student: Student,
  studentResults: Result[],
  assessmentsById: Map<string, Assessment>,
  template: Omit<ReportTemplate, 'id' | 'school_id'>,
  school: {
    name: string;
    address?: string | null;
    motto?: string | null;
    primary_color?: string | null;
    contact_email?: string | null;
    contact_phone?: string | null;
    website?: string | null;
    logo_path?: string | null;
  },
  boundaries: Record<string, number>,
  pageIndex = 0,
  reportPageCount = 1,
  verificationQr?: string,
  documentReference?: string,
  logoData?: { data: string; format: 'PNG' | 'JPEG' },
) {
  const width = pdf.internal.pageSize.getWidth();
  const height = pdf.internal.pageSize.getHeight();
  const [red, green, blue] = hexRgb(template.accent_color || school.primary_color || '#5147c7');
  const margin = 42;
  const headerHeight = template.layout === 'minimal' ? 90 : 116;
  const lightHeader = template.layout === 'minimal' || template.layout === 'academic';
  if (logoData) {
    try {
      const image = pdf.getImageProperties(logoData.data);
      const scale = Math.min(42 / image.width, 42 / image.height);
      pdf.addImage(logoData.data, logoData.format, margin + 16, 37,
        image.width * scale, image.height * scale);
    } catch (imageError) {
      console.warn('School logo could not be embedded in the student report.', imageError);
    }
  }
  if (template.layout === 'minimal') {
    pdf.setDrawColor(red, green, blue);
    pdf.setLineWidth(2);
    pdf.line(margin + 12, 39, margin + 12, 28 + headerHeight - 6);
  } else if (template.layout === 'academic') {
    pdf.setFillColor(250, 246, 237);
    pdf.roundedRect(margin, 28, width - margin * 2, headerHeight, 12, 12, 'F');
    pdf.setFillColor(red, green, blue);
    pdf.rect(margin, 28 + headerHeight - 4, width - margin * 2, 4, 'F');
  } else {
    pdf.setFillColor(red, green, blue);
    pdf.roundedRect(margin, 28, width - margin * 2, headerHeight, 12, 12, 'F');
    pdf.rect(margin, 28 + headerHeight - 12, width - margin * 2, 12, 'F');
    if (template.layout === 'vibrant') {
      pdf.setDrawColor(255, 255, 255);
      pdf.setLineWidth(1.5);
      pdf.circle(width - margin - 48, 63, 18, 'S');
      pdf.circle(width - margin - 48, 63, 10, 'S');
    }
  }
  pdf.setTextColor(lightHeader ? 43 : 255, lightHeader ? 48 : 255, lightHeader ? 66 : 255);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  const schoolNameX = margin + (logoData ? 64 : template.layout === 'minimal' ? 22 : 24);
  pdf.text(school.name.toUpperCase(), schoolNameX, 54, {
    maxWidth: width - schoolNameX - margin - 210,
  });
  pdf.setFontSize(template.layout === 'vibrant' ? 20 : 18);
  pdf.text(pageIndex > 0 ? `${template.title} - CONTINUED` : template.title, schoolNameX, 80, {
    maxWidth: width - schoolNameX - margin - 20,
  });
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.text(template.subtitle || 'Academic achievement & progress', schoolNameX, 98, {
    maxWidth: width - schoolNameX - margin - 20,
  });
  const schoolDetails = [school.address, school.contact_phone, school.contact_email, school.website]
    .filter((detail): detail is string => Boolean(detail?.trim()));
  if (schoolDetails.length) {
    pdf.setFontSize(8);
    pdf.setTextColor(lightHeader ? 113 : 255, lightHeader ? 120 : 255, lightHeader ? 140 : 255);
    const contactLines = pdf.splitTextToSize(schoolDetails.join(' · '), 180).slice(0, 2);
    pdf.text(contactLines, width - margin - 24, 54, { align: 'right', maxWidth: 180 });
  }

  let y = 28 + headerHeight + 26;
  pdf.setTextColor(39, 43, 67);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(15);
  pdf.text(`${student.first_name} ${student.last_name}`, margin + 10, y);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(113, 120, 140);
  pdf.text(`Student ID  ${student.student_number}`, margin + 10, y + 17);
  pdf.text(`Report date  ${new Date().toLocaleDateString()}`, width - margin - 10, y + 17, { align: 'right' });
  y += 38;

  const totalMarks = studentResults.reduce((total, result) => total + Number(result.marks_obtained), 0);
  const possibleMarks = studentResults.reduce((total, result) => total + Number(result.maximum_marks), 0);
  const average = possibleMarks ? (totalMarks / possibleMarks) * 100 : 0;
  const cards = [
    ['ASSESSMENTS', String(studentResults.length)],
    ['TOTAL MARKS', `${totalMarks.toFixed(1)} / ${possibleMarks.toFixed(1)}`],
    ['OVERALL', `${average.toFixed(1)}%`],
    ['GRADE', gradeFor(average, boundaries)],
  ];
  const cardGap = 9;
  const cardWidth = (width - margin * 2 - 20 - cardGap * 3) / 4;
  cards.forEach(([label, value], index) => {
    const x = margin + 10 + index * (cardWidth + cardGap);
    pdf.setFillColor(index === 2 ? red : 246, index === 2 ? green : 247, index === 2 ? blue : 251);
    pdf.roundedRect(x, y, cardWidth, 48, 7, 7, 'F');
    pdf.setTextColor(index === 2 ? 255 : 135, index === 2 ? 255 : 139, index === 2 ? 255 : 158);
    pdf.setFontSize(7);
    pdf.setFont('helvetica', 'bold');
    pdf.text(label, x + 9, y + 15);
    pdf.setTextColor(index === 2 ? 255 : 46, index === 2 ? 255 : 51, index === 2 ? 255 : 73);
    pdf.setFontSize(value.length > 13 ? 10 : 13);
    pdf.text(value, x + 9, y + 35);
  });
  y += 68;

  pdf.setTextColor(44, 49, 70);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  pdf.text('ASSESSMENT RESULTS', margin + 10, y);
  y += 12;
  const columns = [
    { title: 'SUBJECT / ASSESSMENT', x: margin + 12, width: 205 },
    { title: 'DATE', x: margin + 226, width: 72 },
    { title: 'MARK', x: margin + 306, width: 72 },
    { title: 'RESULT', x: margin + 385, width: 70 },
  ];
  pdf.setFillColor(246, 247, 251);
  pdf.roundedRect(margin + 8, y, width - margin * 2 - 16, 23, 4, 4, 'F');
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(7);
  pdf.setTextColor(117, 123, 143);
  for (const column of columns) pdf.text(column.title, column.x, y + 15);
  y += 23;

  const rowsPerPage = 10;
  const pageResults = studentResults.slice(pageIndex * rowsPerPage, (pageIndex + 1) * rowsPerPage);
  pageResults.forEach((result, index) => {
    const assessment = assessmentsById.get(result.assessment_id);
    if (index % 2 === 1) {
      pdf.setFillColor(250, 250, 252);
      pdf.rect(margin + 8, y, width - margin * 2 - 16, 31, 'F');
    }
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    pdf.setTextColor(47, 52, 73);
    pdf.text((assessment?.subject || 'Assessment').slice(0, 31), columns[0].x, y + 12);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(111, 117, 137);
    pdf.setFontSize(7);
    pdf.text((assessment?.title || 'Assessment').slice(0, 42), columns[0].x, y + 24);
    pdf.text(formatDate(result.assessment_date), columns[1].x, y + 18);
    pdf.text(`${Number(result.marks_obtained).toFixed(1)} / ${Number(result.maximum_marks).toFixed(1)}`, columns[2].x, y + 18);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(red, green, blue);
    pdf.text(`${Number(result.percentage).toFixed(1)}% · ${gradeFor(Number(result.percentage), boundaries)}`, columns[3].x, y + 18);
    y += 31;
  });

  const commentResults = pageResults.filter((result) => result.teacher_comment.trim());
  if (commentResults.length && y < height - 120) {
    y += 8;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.setTextColor(44, 49, 70);
    pdf.text('TEACHER FEEDBACK', margin + 10, y);
    y += 14;
    for (const result of commentResults.slice(0, 3)) {
      const assessment = assessmentsById.get(result.assessment_id);
      const lines = pdf.splitTextToSize(`${assessment?.subject || 'Assessment'}: ${result.teacher_comment}`, width - margin * 2 - 34);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(105, 111, 132);
      pdf.text(lines.slice(0, 2), margin + 12, y);
      y += 11 * Math.min(lines.length, 2) + 5;
      if (y > height - 78) break;
    }
  }

  if (school.motto && pageIndex === 0 && y < height - 65) {
    pdf.setFont('helvetica', 'italic');
    pdf.setFontSize(8);
    pdf.setTextColor(125, 130, 147);
    pdf.text(school.motto.slice(0, 110), width / 2, height - 65, { align: 'center', maxWidth: width - 120 });
  }
  pdf.setDrawColor(232, 234, 241);
  pdf.line(margin + 10, height - 52, width - margin - 10, height - 52);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7);
  pdf.setTextColor(144, 149, 164);
  pdf.text(template.footer || 'Confidential student report', margin + 10, height - 39);
  pdf.text(`PAGE ${pageIndex + 1} OF ${reportPageCount}`, width - margin - 10, height - 39, { align: 'right' });
  if (verificationQr) {
    pdf.addImage(verificationQr, 'PNG', width - margin - 47, height - 101, 34, 34);
    pdf.setFontSize(5.5);
    pdf.text('SCAN TO VERIFY', width - margin - 30, height - 62, { align: 'center' });
    if (documentReference) {
      pdf.setFontSize(6);
      pdf.text(documentReference, width - margin - 30, height - 56, { align: 'center', maxWidth: 62 });
    }
  }
}

export function GradesResultsPage() {
  const { activeMembership, user } = useAuth();
  const schoolId = activeMembership?.school_id;
  const role = activeMembership?.role;
  const isSchoolAdmin = role === 'school_admin';
  const canManage = isSchoolAdmin || role === 'academic_coordinator';
  const canRecordResults = canManage || role === 'teacher';
  const [results, setResults] = useState<Result[]>([]);
  const [revisions, setRevisions] = useState<ResultRevision[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState(BUILT_IN_TEMPLATES[0].name);
  const [templateDraft, setTemplateDraft] = useState({ ...BUILT_IN_TEMPLATES[0], name: 'My school report' });
  const [boundaries, setBoundaries] = useState<Record<string, number>>(DEFAULT_BOUNDARIES);
  const [gradingScale, setGradingScale] = useState<GradingScale['grading_scale']>('percentage');
  const [activeView, setActiveView] = useState<'results' | 'reports' | 'settings'>('results');
  const [form, setForm] = useState<ResultForm>(EMPTY_FORM);
  const [editingResult, setEditingResult] = useState<Result | null>(null);
  const [search, setSearch] = useState('');
  const [studentFilter, setStudentFilter] = useState('');
  const [assessmentFilter, setAssessmentFilter] = useState('');
  const [expandedAuditResult, setExpandedAuditResult] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [documentBranding, setDocumentBranding] = useState<{
    logo_path: string | null;
    primary_color: string | null;
    motto: string | null;
    contact_email: string | null;
    contact_phone: string | null;
    website: string | null;
  }>({ logo_path: null, primary_color: null, motto: null, contact_email: null, contact_phone: null, website: null });
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewFilename, setPreviewFilename] = useState('');
  const reportDraft = useRecoverableDraft({
    schoolId,
    userId: user?.id,
    entity: 'report_comment',
    entityId: editingResult?.id ?? (form.student_id && form.assessment_id
      ? `${form.student_id}:${form.assessment_id}`
      : 'new-result'),
    payload: { form, editingResultId: editingResult?.id ?? null },
    enabled: !loading && canRecordResults && Boolean(schoolId && user),
  });

  function restoreReportDraft(value: { form: ResultForm; editingResultId: string | null }) {
    setEditingResult(results.find((result) => result.id === value.editingResultId) ?? null);
    setForm(value.form);
    setActiveView('results');
    setNotice('Saved report draft restored. Review the student, marks, and comment before saving.');
  }

  useEffect(() => {
    if (!schoolId) return;
    let alive = true;
    async function load() {
      setLoading(true);
      setError('');
      try {
        const client = requireSupabase();
        const [resultResponse, studentResponse, assessmentResponse, scaleResponse, templateResponse, brandingResponse] = await Promise.all([
          client.from('learning_assessment_results').select('*').eq('school_id', schoolId).order('assessment_date', { ascending: false }),
          client.from('students').select('id, student_number, first_name, last_name, status').eq('school_id', schoolId).order('last_name').order('first_name'),
          client.from('learning_assessments').select('id, title, subject, total_marks').eq('school_id', schoolId).order('title'),
          client.from('school_academic_policies').select('grading_scale, grade_boundaries, report_card_template').eq('school_id', schoolId).maybeSingle(),
          client.from('school_report_templates').select('*').eq('school_id', schoolId).order('created_at', { ascending: false }),
          client.from('schools').select('logo_path,primary_color,motto,contact_email,contact_phone,website').eq('id', schoolId).single(),
        ]);
        for (const response of [resultResponse, studentResponse, assessmentResponse, scaleResponse, templateResponse, brandingResponse]) {
          if (response.error) throw response.error;
        }
        if (!brandingResponse.data) throw new Error('School document branding could not be loaded.');
        const revisionResponse = canManage
          ? await client.from('learning_result_revisions').select('result_id, previous_marks, previous_comment, reason, created_at').eq('school_id', schoolId).order('created_at', { ascending: false })
          : null;
        if (revisionResponse?.error) throw revisionResponse.error;
        if (!alive) return;
        setResults((resultResponse.data ?? []) as Result[]);
        setRevisions((revisionResponse?.data ?? []) as ResultRevision[]);
        setStudents((studentResponse.data ?? []) as Student[]);
        setAssessments((assessmentResponse.data ?? []) as Assessment[]);
        setTemplates((templateResponse.data ?? []) as ReportTemplate[]);
        setDocumentBranding(brandingResponse.data);
        const scale = scaleResponse.data as (GradingScale & { report_card_template: string | null }) | null;
        if (scale) {
          setGradingScale(scale.grading_scale);
          setBoundaries(scale.grade_boundaries);
          setSelectedTemplate(scale.report_card_template || BUILT_IN_TEMPLATES[0].name);
        }
      } catch (loadError) {
        if (alive) setError(errorMessage(loadError, 'Could not load grades and results.'));
      } finally {
        if (alive) setLoading(false);
      }
    }
    void load();
    return () => { alive = false; };
  }, [schoolId, canManage]);

  const studentsById = useMemo(() => new Map(students.map((student) => [student.id, student])), [students]);
  const assessmentsById = useMemo(() => new Map(assessments.map((assessment) => [assessment.id, assessment])), [assessments]);
  const activeTemplate = templates.find((template) => template.id === selectedTemplate)
    ?? BUILT_IN_TEMPLATES.find((template) => template.name === selectedTemplate)
    ?? BUILT_IN_TEMPLATES[0];
  const filteredResults = results.filter((result) => {
    const student = studentsById.get(result.student_id);
    const assessment = assessmentsById.get(result.assessment_id);
    const searchText = `${student?.first_name ?? ''} ${student?.last_name ?? ''} ${student?.student_number ?? ''} ${assessment?.title ?? ''} ${assessment?.subject ?? ''}`.toLowerCase();
    return searchText.includes(search.trim().toLowerCase())
      && (!studentFilter || result.student_id === studentFilter)
      && (!assessmentFilter || result.assessment_id === assessmentFilter);
  });
  const publishedResults = results.filter((result) => result.status === 'published');
  const recordableAssessments = assessments.filter((assessment) => Number(assessment.total_marks) > 0);
  const selectedAssessment = assessmentsById.get(form.assessment_id);
  const selectedMaximum = editingResult
    ? Number(editingResult.maximum_marks)
    : Number(selectedAssessment?.total_marks ?? 0);
  const pdfSchool = {
    name: activeMembership?.school.name ?? 'School',
    address: activeMembership?.school.address,
    ...documentBranding,
    motto: documentBranding.motto ?? activeMembership?.school.motto,
    primary_color: documentBranding.primary_color ?? activeMembership?.school.primary_color,
    contact_email: documentBranding.contact_email ?? activeMembership?.school.contact_email,
    contact_phone: documentBranding.contact_phone ?? activeMembership?.school.contact_phone,
    website: documentBranding.website ?? activeMembership?.school.website,
  };

  function editResult(result: Result) {
    setEditingResult(result);
    setForm({
      student_id: result.student_id,
      assessment_id: result.assessment_id,
      marks_obtained: String(result.marks_obtained),
      assessment_date: result.assessment_date,
      teacher_comment: result.teacher_comment || result.notes || '',
      correction_reason: '',
    });
    setActiveView('results');
    setError('');
    setNotice('');
  }

  function cancelEdit() {
    setEditingResult(null);
    setForm({ ...EMPTY_FORM, assessment_date: new Date().toISOString().slice(0, 10) });
  }

  async function saveResult(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !user) return;
    const marks = Number(form.marks_obtained);
    if (!form.student_id || !form.assessment_id || !form.assessment_date) {
      setError('Choose a student, an assessment, and an assessment date.');
      return;
    }
    if (!Number.isFinite(marks) || marks < 0 || marks > selectedMaximum) {
      setError(`Marks must be between 0 and ${selectedMaximum}.`);
      return;
    }
    if (editingResult && editingResult.status !== 'draft' && !canManage) {
      setError('Approved results can only be corrected by a school administrator or academic coordinator.');
      return;
    }
    if (editingResult && editingResult.status !== 'draft' && form.correction_reason.trim().length < 5) {
      setError('Enter a correction reason of at least five characters.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        marks_obtained: marks,
        assessment_date: form.assessment_date,
        teacher_comment: form.teacher_comment.trim(),
        correction_reason: form.correction_reason.trim(),
        updated_at: new Date().toISOString(),
      };
      const response = editingResult
        ? await requireSupabase().from('learning_assessment_results').update(payload).eq('id', editingResult.id).eq('school_id', schoolId).select().single()
        : await requireSupabase().from('learning_assessment_results').insert({
          ...payload,
          correction_reason: '',
          school_id: schoolId,
          created_by: user.id,
          student_id: form.student_id,
          assessment_id: form.assessment_id,
          maximum_marks: selectedMaximum,
          status: 'draft',
        }).select().single();
      if (response.error) throw response.error;
      const saved = response.data as Result;
      setResults((current) => [saved, ...current.filter((result) => result.id !== saved.id)]);
      await reportDraft.clearDraft();
      cancelEdit();
      setNotice(editingResult ? 'Result updated and the correction was recorded.' : 'Assessment marks recorded as a draft.');
    } catch (saveError) {
      setError(errorMessage(saveError, 'Could not save this result.'));
    } finally {
      setSaving(false);
    }
  }

  async function updateStatus(result: Result, status: ResultStatus) {
    if (!schoolId || !user || !canManage) return;
    setError('');
    setNotice('');
    try {
      const update = status === 'approved'
        ? { status, approved_by: user.id, approved_at: new Date().toISOString() }
        : { status };
      const response = await requireSupabase().from('learning_assessment_results')
        .update(update).eq('id', result.id).eq('school_id', schoolId).select().single();
      if (response.error) throw response.error;
      const saved = response.data as Result;
      setResults((current) => current.map((item) => item.id === saved.id ? saved : item));
      setNotice(status === 'approved' ? 'Result approved. It is ready to publish.' : 'Result published to the student report.');
    } catch (statusError) {
      setError(errorMessage(statusError, `Could not ${status} this result.`));
    }
  }

  async function saveGradingAndReportSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !user || !isSchoolAdmin) return;
    const entries = Object.entries(boundaries);
    if (!entries.length || entries.some(([name, value]) => !name.trim() || !Number.isFinite(Number(value)) || value < 0 || value > 100)
      || new Set(entries.map(([, value]) => Number(value))).size !== entries.length) {
      setError('Grade boundaries must be unique percentages between 0 and 100.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const client = requireSupabase();
      const scaleResponse = await client.from('school_academic_policies').upsert({
        school_id: schoolId,
        grading_scale: gradingScale,
        grade_boundaries: boundaries,
        report_card_template: selectedTemplate,
        updated_by: user.id,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'school_id' });
      if (scaleResponse.error) throw scaleResponse.error;
      const customTemplate = templates.find((template) => template.id === selectedTemplate);
      if (customTemplate) setTemplateDraft({
        name: customTemplate.name,
        layout: customTemplate.layout,
        title: customTemplate.title,
        subtitle: customTemplate.subtitle,
        accent_color: customTemplate.accent_color,
        footer: customTemplate.footer,
      });
      setNotice('Grading scale and report template settings saved.');
    } catch (settingsError) {
      setError(errorMessage(settingsError, 'Could not save grading and report settings.'));
    } finally {
      setSaving(false);
    }
  }

  async function saveCustomTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !user || !isSchoolAdmin) return;
    if (templateDraft.name.trim().length < 2 || templateDraft.title.trim().length < 2) {
      setError('A custom template needs a name and report title.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    let savedTemplate: ReportTemplate | null = null;
    try {
      const response = await requireSupabase().from('school_report_templates').insert({
        ...templateDraft,
        school_id: schoolId,
        created_by: user.id,
      }).select().single();
      if (response.error) throw response.error;
      savedTemplate = response.data as ReportTemplate;
      const settingsResponse = await requireSupabase().from('school_academic_policies').upsert({
        school_id: schoolId,
        grading_scale: gradingScale,
        grade_boundaries: boundaries,
        report_card_template: savedTemplate.id,
        updated_by: user.id,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'school_id' });
      if (settingsResponse.error) throw settingsResponse.error;
      setTemplates((current) => [savedTemplate as ReportTemplate, ...current]);
      setSelectedTemplate(savedTemplate.id);
      setNotice('Custom report template saved and selected for the school.');
    } catch (templateError) {
      if (savedTemplate) {
        setTemplates((current) => [savedTemplate as ReportTemplate, ...current]);
        setError(`The template was created, but could not be selected as the school default: ${errorMessage(templateError, 'Settings could not be saved.')}`);
      } else {
        setError(errorMessage(templateError, 'Could not save this report template.'));
      }
    } finally {
      setSaving(false);
    }
  }

  async function downloadStudentReport(studentId: string) {
    const student = studentsById.get(studentId);
    if (!student) {
      setError('Select a student with published results before downloading a report.');
      return;
    }
    const rows = publishedResults
      .filter((result) => result.student_id === studentId)
      .sort((left, right) => left.assessment_date.localeCompare(right.assessment_date));
    if (!rows.length) {
      setError('This student has no published results to include in a report.');
      return;
    }
    try {
      const { jsPDF: PdfDocument } = await import('jspdf');
      const pdf = new PdfDocument({ unit: 'pt', format: 'a4' });
      const reportTemplate = activeTemplate;
      const pageCount = Math.ceil(rows.length / 10);
      if (!schoolId) throw new Error('Choose an active school before issuing a student report.');
      const prepared = await prepareOfficialDocument(schoolId, 'academic_report', studentId);
      const verificationUrl = documentVerificationUrl(prepared.token);
      const verificationQr = await QRCode.toDataURL(verificationUrl, {
        errorCorrectionLevel: 'Q', margin: 1, width: 280,
      });
      let reportLogo: { data: string; format: 'PNG' | 'JPEG' } | null = null;
      try {
        reportLogo = await loadReportLogo(pdfSchool.logo_path ?? null);
      } catch (logoError) {
        console.warn('School logo was omitted from the academic report.', logoError);
      }
      for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
        if (pageIndex > 0) pdf.addPage();
        drawReportPage(
          pdf, student, rows, assessmentsById, reportTemplate, pdfSchool,
          boundaries, pageIndex, pageCount, verificationQr, prepared.reference, reportLogo ?? undefined,
        );
      }
      const output = pdf.output('blob');
      await storeOfficialDocument(prepared, output);
      const filename = `student-report-${student.student_number}.pdf`;
      savePdfBlob(output, filename);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(output));
      setPreviewFilename(filename);
      setError('');
      setNotice(`Issued ${prepared.reference} · version ${prepared.version}. Report downloaded and its authenticity QR is active.`);
    } catch (pdfError) {
      setError(errorMessage(pdfError, 'Could not create the student PDF report.'));
    }
  }

  async function downloadAllReports() {
    const grouped = new Map<string, Result[]>();
    for (const result of publishedResults) {
      const studentResults = grouped.get(result.student_id) ?? [];
      studentResults.push(result);
      grouped.set(result.student_id, studentResults);
    }
    const reportStudents = [...grouped.keys()]
      .map((id) => studentsById.get(id))
      .filter((student): student is Student => Boolean(student))
      .sort((left, right) => left.last_name.localeCompare(right.last_name) || left.first_name.localeCompare(right.first_name));
    if (!reportStudents.length) {
      setError('There are no published student results to include in a report download.');
      return;
    }
    try {
      const { jsPDF: PdfDocument } = await import('jspdf');
      const pdf = new PdfDocument({ unit: 'pt', format: 'a4' });
      reportStudents.forEach((student, studentIndex) => {
        if (studentIndex > 0) pdf.addPage();
        const rows = (grouped.get(student.id) ?? []).sort((left, right) => left.assessment_date.localeCompare(right.assessment_date));
        const pageCount = Math.ceil(rows.length / 10);
        for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
          if (pageIndex > 0) pdf.addPage();
          drawReportPage(pdf, student, rows, assessmentsById, activeTemplate, pdfSchool, boundaries, pageIndex, pageCount);
        }
      });
      pdf.save('school-student-reports.pdf');
      setError('');
      setNotice(`Downloaded ${reportStudents.length} student report${reportStudents.length === 1 ? '' : 's'} in one PDF.`);
    } catch (pdfError) {
      setError(errorMessage(pdfError, 'Could not create the school PDF reports.'));
    }
  }

  function updateBoundary(name: string, value: number) {
    setBoundaries((current) => ({ ...current, [name]: value }));
  }

  if (loading) return <LoadingState />;

  return (
    <>
    <div className="page-stack grades-page">
      <header className="page-heading">
        <div><span className="eyebrow">Academic workspace</span><h1>Grades &amp; results</h1><p>Record marks, review achievement, and publish polished student reports.</p></div>
        {activeView === 'reports' && <button className="button button-primary" onClick={() => void downloadAllReports()} disabled={!publishedResults.length}><Download size={15} />Download all reports</button>}
      </header>
      {error && <ErrorState message={error} />}
      {notice && <SuccessMessage message={notice} />}
      <div className="grades-tabs" role="tablist" aria-label="Grades and reports">
        <button className={activeView === 'results' ? 'active' : ''} onClick={() => setActiveView('results')}><GraduationCap size={15} />Results</button>
        {canRecordResults && <button className={activeView === 'reports' ? 'active' : ''} onClick={() => setActiveView('reports')}><FileText size={15} />PDF reports</button>}
        {isSchoolAdmin && <button className={activeView === 'settings' ? 'active' : ''} onClick={() => setActiveView('settings')}><Settings2 size={15} />Grading &amp; templates</button>}
      </div>

      {activeView === 'results' && (
        <>
          <div className="grades-summary-grid">
            <article className="grades-stat"><span><FileText size={16} /></span><small>ASSESSMENTS RECORDED</small><strong>{results.length}</strong></article>
            <article className="grades-stat"><span><ShieldCheck size={16} /></span><small>AWAITING APPROVAL</small><strong>{results.filter((result) => result.status === 'draft').length}</strong></article>
            <article className="grades-stat"><span><Award size={16} /></span><small>PUBLISHED RESULTS</small><strong>{publishedResults.length}</strong></article>
          </div>
          {canRecordResults && <section className="content-card grades-entry-card">
            <div className="section-heading"><div><span className="eyebrow">{editingResult ? 'Update record' : 'New assessment mark'}</span><h2>{editingResult ? 'Edit student result' : 'Record student marks'}</h2></div>{editingResult && <button className="button button-quiet" onClick={cancelEdit}><X size={14} />Cancel</button>}</div>
            <form className="grades-entry-form" onSubmit={(event) => void saveResult(event)}>
              <DraftRecoveryControls entity="report_comment" draft={reportDraft} onRestore={restoreReportDraft} />
              <label className="field"><span>Student</span><select required value={form.student_id} disabled={Boolean(editingResult)} onChange={(event) => setForm((current) => ({ ...current, student_id: event.target.value }))}><option value="">Choose a student</option>{students.filter((student) => student.status === 'active' || student.id === form.student_id).map((student) => <option key={student.id} value={student.id}>{student.last_name}, {student.first_name} · {student.student_number}</option>)}</select></label>
              <label className="field"><span>Assessment</span><select required value={form.assessment_id} disabled={Boolean(editingResult)} onChange={(event) => setForm((current) => ({ ...current, assessment_id: event.target.value, marks_obtained: '' }))}><option value="">Choose an assessment</option>{recordableAssessments.map((assessment) => <option key={assessment.id} value={assessment.id}>{assessment.subject || 'Assessment'} · {assessment.title} ({assessment.total_marks} marks)</option>)}{editingResult && !recordableAssessments.some((assessment) => assessment.id === editingResult.assessment_id) && <option value={editingResult.assessment_id}>{assessmentsById.get(editingResult.assessment_id)?.title ?? 'Saved assessment'} · {editingResult.maximum_marks} marks</option>}</select></label>
              <label className="field"><span>Marks earned</span><input required type="number" min="0" max={selectedMaximum || undefined} step="0.01" value={form.marks_obtained} onChange={(event) => setForm((current) => ({ ...current, marks_obtained: event.target.value }))} placeholder="0.00" /></label>
              <label className="field"><span>Out of</span><input readOnly value={selectedMaximum || ''} placeholder="Select an assessment" /></label>
              <label className="field"><span>Assessment date</span><input required type="date" value={form.assessment_date} onChange={(event) => setForm((current) => ({ ...current, assessment_date: event.target.value }))} /></label>
              <label className="field grades-comment-field"><span>Teacher comment</span><textarea rows={2} maxLength={1000} value={form.teacher_comment} onChange={(event) => setForm((current) => ({ ...current, teacher_comment: event.target.value }))} placeholder="Personalized feedback for the student" /></label>
              {editingResult && editingResult.status !== 'draft' && <label className="field grades-comment-field correction-field"><span>Correction reason (required)</span><textarea required minLength={5} maxLength={500} rows={2} value={form.correction_reason} onChange={(event) => setForm((current) => ({ ...current, correction_reason: event.target.value }))} placeholder="Explain why this approved mark or comment needs correction" /></label>}
              {editingResult?.status !== 'draft' && editingResult && <p className="grades-permission-note"><LockKeyhole size={14} />Only a school administrator or academic coordinator can correct an approved or published result. Corrections are audited.</p>}
              {!recordableAssessments.length && !editingResult && <p className="grades-permission-note">Create an assessment with a total mark greater than zero in Learning before recording results.</p>}
              <div className="grades-entry-actions"><span>Percentage is calculated automatically from the marks entered.</span><button className="button button-primary" disabled={saving || (!recordableAssessments.length && !editingResult)}><Save size={14} />{saving ? 'Saving…' : editingResult ? 'Save correction' : 'Record draft result'}</button></div>
            </form>
          </section>}
          <section className="content-card grades-list-card">
            <div className="section-heading"><div><span className="eyebrow">Assessment history</span><h2>Student results</h2></div><span className="table-count">{filteredResults.length} records</span></div>
            <div className="grades-filters">
              <label className="table-search"><FileText size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search students and assessments" /></label>
              <select aria-label="Filter by student" value={studentFilter} onChange={(event) => setStudentFilter(event.target.value)}><option value="">All students</option>{students.map((student) => <option key={student.id} value={student.id}>{student.first_name} {student.last_name}</option>)}</select>
              <select aria-label="Filter by assessment" value={assessmentFilter} onChange={(event) => setAssessmentFilter(event.target.value)}><option value="">All assessments</option>{assessments.map((assessment) => <option key={assessment.id} value={assessment.id}>{assessment.title}</option>)}</select>
            </div>
            <div className="table-scroll"><table className="grades-table"><thead><tr><th>Student / assessment</th><th>Date</th><th>Marks</th><th>Grade</th><th>Status</th><th>Teacher comment</th><th>Actions</th></tr></thead><tbody>
              {filteredResults.map((result) => {
                const student = studentsById.get(result.student_id);
                const assessment = assessmentsById.get(result.assessment_id);
                const resultPercentage = Number(result.percentage);
                const canCorrect = result.status === 'draft' || canManage;
                const resultRevisions = revisions.filter((revision) => revision.result_id === result.id);
                return <Fragment key={result.id}><tr>
                  <td><strong>{student ? `${student.first_name} ${student.last_name}` : 'Student record unavailable'}</strong><small>{assessment?.subject || 'Assessment'} · {assessment?.title ?? 'Saved assessment'}</small></td>
                  <td>{formatDate(result.assessment_date)}</td>
                  <td><strong>{Number(result.marks_obtained).toFixed(1)} / {Number(result.maximum_marks).toFixed(1)}</strong><small>{resultPercentage.toFixed(1)}%</small></td>
                  <td><span className="grades-letter">{gradeFor(resultPercentage, boundaries)}</span></td>
                  <td><span className={`grades-status status-${result.status}`}>{result.status}</span></td>
                  <td className="grades-comment-cell">{result.teacher_comment || result.notes || <span className="muted-cell">No comment</span>}</td>
                  <td><div className="grades-row-actions">
                    {canCorrect && <button className="icon-button" aria-label={result.status === 'draft' ? 'Edit result' : 'Correct result'} title={result.status === 'draft' ? 'Edit result' : 'Correct result'} onClick={() => editResult(result)}><Pencil size={14} /></button>}
                    {canManage && result.status === 'draft' && <button className="icon-button grades-approve" aria-label="Approve result" title="Approve result" onClick={() => void updateStatus(result, 'approved')}><Check size={15} /></button>}
                    {canManage && result.status === 'approved' && <button className="icon-button grades-publish" aria-label="Publish result" title="Publish result" onClick={() => void updateStatus(result, 'published')}><Sparkles size={14} /></button>}
                    {canRecordResults && result.status === 'published' && <button className="icon-button" aria-label="Download student report" title="Download student report" onClick={() => void downloadStudentReport(result.student_id)}><Download size={14} /></button>}
                    {canManage && resultRevisions.length > 0 && <button className="icon-button" aria-label="View correction history" title="View correction history" onClick={() => setExpandedAuditResult((current) => current === result.id ? '' : result.id)}><History size={14} /></button>}
                  </div></td>
                </tr>{expandedAuditResult === result.id && <tr className="grades-audit-row"><td colSpan={7}><div className="grades-audit-history"><strong><History size={14} /> Correction history</strong>{resultRevisions.map((revision, index) => <article key={`${revision.result_id}-${revision.created_at}-${index}`}><span>{formatDate(revision.created_at.slice(0, 10))}</span><span>Previous mark: {Number(revision.previous_marks).toFixed(1)}</span><span>{revision.previous_comment ? `Previous comment: ${revision.previous_comment}` : 'No previous teacher comment'}</span><em>Reason: {revision.reason}</em></article>)}</div></td></tr>}</Fragment>;
              })}
            </tbody></table>{filteredResults.length === 0 && <div className="grades-empty"><Award size={22} /><strong>No matching student results</strong><span>Record assessment marks or adjust the selected filters.</span></div>}</div>
          </section>
        </>
      )}

      {activeView === 'reports' && (
        <div className="grades-reports-layout">
          <section className="content-card grades-report-intro"><span className="grades-report-icon"><FileText size={20} /></span><span className="eyebrow">Print-ready PDF exports</span><h2>Reports that reflect your school</h2><p>Download an individual student report or a single combined PDF containing every student with published results. Each report includes student details, marks, percentages, grades, and teacher feedback.</p>
            <div className="grades-report-actions"><label className="field"><span>Individual student</span><select value={studentFilter} onChange={(event) => setStudentFilter(event.target.value)}><option value="">Choose a student</option>{students.filter((student) => publishedResults.some((result) => result.student_id === student.id)).map((student) => <option key={student.id} value={student.id}>{student.first_name} {student.last_name} · {student.student_number}</option>)}</select></label><button className="button button-quiet" disabled={!studentFilter} onClick={() => downloadStudentReport(studentFilter)}><Download size={14} />Download student PDF</button><button className="button button-primary" disabled={!publishedResults.length} onClick={downloadAllReports}><Download size={14} />Download all published reports</button></div>
          </section>
          <section className="content-card grades-template-preview">
            <div className="section-heading"><div><span className="eyebrow">Selected design</span><h2>{activeTemplate.name}</h2></div><span className="template-color-dot" style={{ backgroundColor: activeTemplate.accent_color }} /></div>
            <div className={`report-preview report-preview-${activeTemplate.layout}`} style={{ '--report-accent': activeTemplate.accent_color } as React.CSSProperties}>
              <div className="report-preview-header"><small>{pdfSchool.name}</small><strong>{activeTemplate.title}</strong><span>{activeTemplate.subtitle}</span></div>
              <div className="report-preview-student"><strong>Generated from published school results</strong><small>Student and assessment details appear in the downloaded PDF.</small></div>
              <div className="report-preview-stats"><span>ASSESSMENTS<strong>Published</strong></span><span>TOTAL MARKS<strong>Verified</strong></span><span>OVERALL<strong>Calculated</strong></span><span>GRADE<strong>Configured</strong></span></div>
              <div className="report-preview-row"><span>Subject and assessment</span><strong>Marks and grade</strong></div>
              <div className="report-preview-row"><span>Teacher feedback</span><strong>Included when available</strong></div>
              <div className="report-preview-footer">{activeTemplate.footer}</div>
            </div>
            <p className="grades-template-note"><Check size={14} /> {templates.some((template) => template.id === selectedTemplate) ? 'Your school template' : 'One of five original Campus Connect designs'} · A4 PDF · Optimized for print</p>
          </section>
        </div>
      )}

      {activeView === 'settings' && isSchoolAdmin && (
        <div className="grades-settings-layout">
          <section className="content-card">
            <div className="section-heading"><div><span className="eyebrow">School-wide settings</span><h2>Grading scale &amp; report template</h2></div><Award size={18} className="muted-icon" /></div>
            <form onSubmit={(event) => void saveGradingAndReportSettings(event)}>
              <label className="field"><span>Grading style</span><select value={gradingScale} onChange={(event) => setGradingScale(event.target.value as GradingScale['grading_scale'])}><option value="percentage">Percentage bands</option><option value="letter">Letter grades</option><option value="gpa">GPA bands</option><option value="custom">Custom school scale</option></select></label>
              <label className="field"><span>Report template</span><select value={selectedTemplate} onChange={(event) => setSelectedTemplate(event.target.value)}>{BUILT_IN_TEMPLATES.map((template) => <option key={template.name} value={template.name}>{template.name} · Campus Connect original</option>)}{templates.length > 0 && <optgroup label="My school templates">{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</optgroup>}</select></label>
              <div className="grade-boundaries-heading"><strong>Grade boundaries</strong><span>Set the minimum percentage for each grade.</span></div>
              <div className="grade-boundaries-grid">{Object.entries(boundaries).map(([grade, percentage]) => <label className="field" key={grade}><span>{grade} and above</span><input type="number" min="0" max="100" step="0.5" value={percentage} onChange={(event) => updateBoundary(grade, Number(event.target.value))} /></label>)}</div>
              <button type="button" className="button button-quiet add-grade-boundary" onClick={() => {
                const name = window.prompt('Enter the new grade label (for example, C+):');
                if (!name?.trim()) return;
                if (Object.hasOwn(boundaries, name.trim())) {
                  setError('That grade label already exists.');
                  return;
                }
                setBoundaries((current) => ({ ...current, [name.trim()]: 0 }));
                setError('');
              }}><Plus size={14} />Add grade boundary</button>
              <div className="grade-scale-preview"><strong>Live scale preview</strong>{Object.entries(boundaries).sort((left, right) => right[1] - left[1]).map(([grade, percentage]) => <span key={grade}><b>{grade}</b>{percentage}% and above</span>)}</div>
              <div className="grades-settings-save"><button className="button button-primary" disabled={saving}><Save size={14} />{saving ? 'Saving…' : 'Save school settings'}</button></div>
            </form>
          </section>
          <section className="content-card">
            <div className="section-heading"><div><span className="eyebrow">Make it yours</span><h2>Create a school template</h2></div><MessageSquare size={17} className="muted-icon" /></div>
            <p className="grades-custom-help">Start from one of our five original layouts, then save a school-branded version with your own title, colors, and message.</p>
            <form onSubmit={(event) => void saveCustomTemplate(event)}>
              <label className="field"><span>Template name</span><input required maxLength={60} value={templateDraft.name} onChange={(event) => setTemplateDraft((current) => ({ ...current, name: event.target.value }))} placeholder="e.g. Senior school report" /></label>
              <label className="field"><span>Base design</span><select value={templateDraft.layout} onChange={(event) => {
                const selected = BUILT_IN_TEMPLATES.find((template) => template.layout === event.target.value);
                if (selected) setTemplateDraft((current) => ({ ...current, ...selected, name: current.name }));
              }}>{BUILT_IN_TEMPLATES.map((template) => <option key={template.layout} value={template.layout}>{template.name}</option>)}</select></label>
              <label className="field"><span>Report title</span><input required maxLength={100} value={templateDraft.title} onChange={(event) => setTemplateDraft((current) => ({ ...current, title: event.target.value }))} /></label>
              <label className="field"><span>Subtitle</span><input maxLength={160} value={templateDraft.subtitle} onChange={(event) => setTemplateDraft((current) => ({ ...current, subtitle: event.target.value }))} placeholder="A message beneath the title" /></label>
              <label className="field grades-color-field"><span>Accent color</span><input type="color" value={templateDraft.accent_color} onChange={(event) => setTemplateDraft((current) => ({ ...current, accent_color: event.target.value }))} /><small>Choose a color that represents your school.</small></label>
              <label className="field"><span>Report footer</span><input maxLength={200} value={templateDraft.footer} onChange={(event) => setTemplateDraft((current) => ({ ...current, footer: event.target.value }))} placeholder="School message or confidentiality note" /></label>
              <button className="button button-primary" disabled={saving}><Save size={14} />{saving ? 'Saving…' : 'Save & select template'}</button>
            </form>
            <div className="grades-originals-list"><strong><Sparkles size={14} /> Five original designs included</strong><span>Classic · Modern · Minimal · Academic · Vibrant</span></div>
          </section>
        </div>
      )}
      <section className="grades-privacy-note"><LockKeyhole size={15} /><span>Only approved results can be published. Students and parents see published results only. Corrections to approved marks are restricted to authorized academic staff and written to an audit history.</span></section>
    </div>
    {previewUrl && <PdfPreviewDialog
      url={previewUrl}
      filename={previewFilename || 'student-report.pdf'}
      onClose={() => {
        URL.revokeObjectURL(previewUrl);
        setPreviewUrl('');
      }}
    />}
    </>
  );
}
