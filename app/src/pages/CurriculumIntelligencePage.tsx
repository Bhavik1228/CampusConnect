import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowLeftRight, BookOpenText, CalendarDays, Check, ChevronDown, CircleHelp, FileCheck2, FilePlus2, FileText,
  LoaderCircle, Plus, RefreshCw, ShieldCheck, Sparkles, Trash2, UploadCloud,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';
import { CurriculumAiPanel } from './CurriculumAiPanel';
import { CurriculumTemplatesPanel } from './CurriculumTemplatesPanel';
import { CurriculumVersionsPanel } from './CurriculumVersionsPanel';
import { CurriculumPlansPanel } from './CurriculumPlansPanel';
import { CurriculumCoveragePanel } from './CurriculumCoveragePanel';
import './CurriculumIntelligence.css';

const BUCKET = 'curriculum-temporary';
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const ACCEPTED_EXTENSIONS = new Set(['pdf', 'docx', 'doc', 'xlsx', 'xls', 'csv', 'pptx', 'txt']);

type AcademicYear = { id: string; name: string; is_current: boolean };
type Subject = { id: string; name: string; code: string | null; department_id: string | null };
type SchoolClass = { id: string; name: string; grade_level: string | null; academic_year_id: string | null };
type CurriculumJob = {
  id: string;
  document_id: string;
  status: string;
  attempt_count: number;
  manifest: Record<string, unknown>;
  error_message: string;
};
type CurriculumDocument = {
  id: string;
  academic_year_id: string;
  subject_id: string;
  title: string;
  curriculum_type: string;
  syllabus_code: string;
  category: string;
  teaching_language: string;
  notes: string;
  original_file_name: string | null;
  original_size_bytes: number | null;
  status: string;
  source_deleted_at: string | null;
  created_at: string;
  job: CurriculumJob | null;
};
type SourceUnit = {
  id: string;
  unit_kind: string;
  unit_reference: string;
  unit_number: number;
  extracted_text: string;
  extracted_tables: string[][][];
  extraction_method: string;
  extraction_confidence: number | null;
  needs_review: boolean;
  review_status: string;
  warnings: string[];
};
type CurriculumTopic = {
  id: string;
  source_unit_id: string | null;
  name: string;
  corrected_name: string;
  section_number: string;
  review_status: string;
};
type CurriculumObjective = {
  id: string;
  source_unit_id: string | null;
  topic_id: string | null;
  section_number: string;
  objective_type: string;
  original_text: string;
  corrected_text: string;
  simplified_text: string;
  extraction_confidence: number | null;
  review_status: string;
  origin: string;
};
type ReviewData = { units: SourceUnit[]; topics: CurriculumTopic[]; objectives: CurriculumObjective[] };
type UploadProgress = { stage: string; percent: number };
type ReviewDecision = 'approved' | 'rejected' | 'needs_correction';

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function safeFileName(fileName: string) {
  return fileName.replace(/[^A-Za-z0-9._-]/g, '_').slice(-180) || 'curriculum-file';
}

function mimeTypeFor(file: File) {
  return file.type || 'application/octet-stream';
}

async function validateFileInBrowser(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!ACCEPTED_EXTENSIONS.has(extension)) throw new Error('Choose a PDF, DOCX, DOC, XLSX, XLS, CSV, PPTX or TXT file.');
  if (!file.size || file.size > MAX_FILE_BYTES) throw new Error('The file must be between 1 byte and 50 MB.');
  const prefix = new Uint8Array(await file.slice(0, 2048).arrayBuffer());
  if (extension === 'pdf' && new TextDecoder().decode(prefix.slice(0, 8)).indexOf('%PDF-') !== 0) {
    throw new Error('The selected file does not have a PDF signature.');
  }
  if (['docx', 'xlsx', 'pptx'].includes(extension) && !(prefix[0] === 0x50 && prefix[1] === 0x4b)) {
    throw new Error('The selected Office file does not have a valid archive signature.');
  }
  if (['doc', 'xls'].includes(extension)
    && ![0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((value, index) => prefix[index] === value)) {
    throw new Error('The selected legacy Office file does not have a valid signature.');
  }
  if (['csv', 'txt'].includes(extension)) {
    let text = '';
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(prefix);
    } catch {
      throw new Error('CSV and TXT files must contain UTF-8 text.');
    }
    if (text.includes('\0')) throw new Error('The selected text file contains binary data.');
    if (extension === 'csv' && !/[;,\t|]/.test(text)) throw new Error('The selected CSV file has no recognizable delimiter.');
  }
}

async function sha256(file: File) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function uploadWithProgress(path: string, file: File, onProgress: (percent: number) => void) {
  const client = requireSupabase();
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw sessionError;
  const session = sessionData.session;
  if (!session) throw new Error('Your session expired. Sign in again before uploading.');
  const baseUrl = import.meta.env.VITE_SUPABASE_URL as string;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
  const encodedPath = path.split('/').map((part) => encodeURIComponent(part)).join('/');
  await new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `${baseUrl}/storage/v1/object/${BUCKET}/${encodedPath}`);
    request.setRequestHeader('apikey', anonKey);
    request.setRequestHeader('Authorization', `Bearer ${session.access_token}`);
    request.setRequestHeader('Content-Type', mimeTypeFor(file));
    request.setRequestHeader('x-upsert', 'false');
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onerror = () => reject(new Error('The upload connection failed. Check your connection and retry.'));
    request.onabort = () => reject(new Error('The upload was cancelled.'));
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(100);
        resolve();
        return;
      }
      let message = `Storage upload failed with HTTP ${request.status}.`;
      try {
        const body = JSON.parse(request.responseText) as { message?: string; error?: string };
        message = body.message || body.error || message;
      } catch {
        if (request.responseText) message = request.responseText.slice(0, 300);
      }
      reject(new Error(message));
    };
    request.send(file);
  });
}

function statusLabel(document: CurriculumDocument) {
  if (document.status === 'approved' && !document.source_deleted_at) return 'Approved · source cleanup pending';
  if (document.status === 'deletion_failed') return 'Approved · source cleanup failed';
  if (document.status === 'needs_review') return 'Needs review';
  if (document.status === 'source_deleted') return 'Source deleted';
  if (document.status === 'failed') return 'Processing failed';
  return document.job?.status.replaceAll('_', ' ') ?? document.status.replaceAll('_', ' ');
}

function jobManifest(job: CurriculumJob | null) {
  return job?.manifest && typeof job.manifest === 'object' ? job.manifest : {};
}

function sourceReference(unit: SourceUnit | undefined) {
  return unit?.unit_reference ?? 'Source reference unavailable';
}

export function CurriculumIntelligencePage() {
  const { activeMembership, user } = useAuth();
  const schoolId = activeMembership?.school_id;
  const role = activeMembership?.role;
  const canUse = role === 'school_admin' || role === 'academic_coordinator' || role === 'teacher';
  const [years, setYears] = useState<AcademicYear[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [documents, setDocuments] = useState<CurriculumDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [tab, setTab] = useState<'uploads' | 'review' | 'ai' | 'templates' | 'versions' | 'plans' | 'coverage'>('uploads');
  const [refreshKey, setRefreshKey] = useState(0);
  const [title, setTitle] = useState('');
  const [academicYearId, setAcademicYearId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [category, setCategory] = useState('syllabus');
  const [curriculumType, setCurriculumType] = useState('Cambridge');
  const [syllabusCode, setSyllabusCode] = useState('');
  const [teachingLanguage, setTeachingLanguage] = useState('');
  const [notes, setNotes] = useState('');
  const [selectedYearGroups, setSelectedYearGroups] = useState<string[]>([]);
  const [selectedClasses, setSelectedClasses] = useState<string[]>([]);
  const [customYearGroup, setCustomYearGroup] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [editingDraftId, setEditingDraftId] = useState('');
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [reviewDocumentId, setReviewDocumentId] = useState('');
  const [reviewData, setReviewData] = useState<ReviewData>({ units: [], topics: [], objectives: [] });
  const [reviewLoading, setReviewLoading] = useState(false);
  const [canApprove, setCanApprove] = useState(false);
  const [newObjective, setNewObjective] = useState('');
  const [newObjectiveType, setNewObjectiveType] = useState('core');
  const [newTopic, setNewTopic] = useState('');
  const [newSectionNumber, setNewSectionNumber] = useState('');
  const [newSourceUnitId, setNewSourceUnitId] = useState('');
  const [reviewText, setReviewText] = useState<Record<string, string>>({});

  const activeDocument = documents.find((document) => document.id === reviewDocumentId) ?? null;
  const yearGroupOptions = useMemo(() => [...new Set(
    classes.filter((item) => item.academic_year_id === academicYearId)
      .map((item) => item.grade_level?.trim() || item.name.trim())
      .filter(Boolean),
  )].sort((a, b) => a.localeCompare(b)), [classes, academicYearId]);

  const load = useCallback(async () => {
    if (!schoolId) return;
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [yearResult, subjectResult, classResult, documentResult] = await Promise.all([
        client.from('academic_years').select('id,name,is_current').eq('school_id', schoolId).order('start_date', { ascending: false }),
        client.from('subjects').select('id,name,code,department_id').eq('school_id', schoolId).order('name'),
        client.from('school_classes').select('id,name,grade_level,academic_year_id').eq('school_id', schoolId).order('name'),
        client.from('curriculum_documents')
          .select('id,academic_year_id,subject_id,title,curriculum_type,syllabus_code,category,teaching_language,notes,original_file_name,original_size_bytes,status,source_deleted_at,created_at')
          .eq('school_id', schoolId).order('created_at', { ascending: false }).limit(200),
      ]);
      for (const result of [yearResult, subjectResult, classResult, documentResult]) {
        if (result.error) throw result.error;
      }
      const loadedDocuments = (documentResult.data ?? []) as Omit<CurriculumDocument, 'job'>[];
      let jobs: CurriculumJob[] = [];
      if (loadedDocuments.length) {
        const jobResult = await client.from('curriculum_processing_jobs')
          .select('id,document_id,status,attempt_count,manifest,error_message')
          .eq('school_id', schoolId)
          .in('document_id', loadedDocuments.map((item) => item.id))
          .order('created_at', { ascending: false });
        if (jobResult.error) throw jobResult.error;
        jobs = (jobResult.data ?? []) as CurriculumJob[];
      }
      const latestJobs = new Map<string, CurriculumJob>();
      for (const job of jobs) {
        if (!latestJobs.has(job.document_id)) latestJobs.set(job.document_id, job);
      }
      setYears((yearResult.data ?? []) as AcademicYear[]);
      setSubjects((subjectResult.data ?? []) as Subject[]);
      setClasses((classResult.data ?? []) as SchoolClass[]);
      setDocuments(loadedDocuments.map((item) => ({ ...item, job: latestJobs.get(item.id) ?? null })));
      const defaultYear = (yearResult.data as AcademicYear[] | null)?.find((item) => item.is_current)?.id
        ?? (yearResult.data as AcademicYear[] | null)?.[0]?.id ?? '';
      setAcademicYearId((current) => current || defaultYear);
      setSubjectId((current) => current || (subjectResult.data as Subject[] | null)?.[0]?.id || '');
    } catch (loadError) {
      setError(getErrorMessage(loadError, 'Could not load curriculum intelligence data.'));
    } finally {
      setLoading(false);
    }
  }, [schoolId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  useEffect(() => {
    if (!schoolId) return;
    const hasPendingJobs = documents.some((document) =>
      ['queued', 'processing', 'ready_to_delete', 'source_deletion_failed'].includes(document.job?.status ?? ''),
    );
    if (!hasPendingJobs) return;
    const timer = window.setInterval(() => setRefreshKey((current) => current + 1), 15_000);
    return () => window.clearInterval(timer);
  }, [documents, schoolId]);

  useEffect(() => {
    if (!reviewDocumentId || !schoolId) {
      setReviewData({ units: [], topics: [], objectives: [] });
      setCanApprove(false);
      return;
    }
    let active = true;
    setReviewLoading(true);
    void (async () => {
      try {
        const client = requireSupabase();
        const [unitResult, topicResult, objectiveResult] = await Promise.all([
          client.from('curriculum_source_units')
            .select('id,unit_kind,unit_reference,unit_number,extracted_text,extracted_tables,extraction_method,extraction_confidence,needs_review,review_status,warnings')
            .eq('school_id', schoolId).eq('document_id', reviewDocumentId).order('unit_number'),
          client.from('curriculum_topics')
            .select('id,source_unit_id,name,corrected_name,section_number,review_status')
            .eq('school_id', schoolId).eq('document_id', reviewDocumentId).order('sort_order'),
          client.from('curriculum_objectives')
            .select('id,source_unit_id,topic_id,section_number,objective_type,original_text,corrected_text,simplified_text,extraction_confidence,review_status,origin')
            .eq('school_id', schoolId).eq('document_id', reviewDocumentId).order('sort_order'),
        ]);
        for (const result of [unitResult, topicResult, objectiveResult]) {
          if (result.error) throw result.error;
        }
        if (active) {
          const units = (unitResult.data ?? []) as SourceUnit[];
          const topics = (topicResult.data ?? []) as CurriculumTopic[];
          const objectives = (objectiveResult.data ?? []) as CurriculumObjective[];
          setReviewData({ units, topics, objectives });
          setNewSourceUnitId((current) => units.some((unit) => unit.id === current) ? current : units[0]?.id ?? '');
          setReviewText(Object.fromEntries(objectives.map((objective) => [
            objective.id, objective.corrected_text || objective.original_text,
          ])));
        }
      } catch (loadError) {
        if (active) setError(getErrorMessage(loadError, 'Could not load curriculum review data.'));
      } finally {
        if (active) setReviewLoading(false);
      }
    })();
    return () => { active = false; };
  }, [reviewDocumentId, schoolId, refreshKey]);

  useEffect(() => {
    if (!activeDocument || !schoolId) {
      setCanApprove(role === 'school_admin' || role === 'academic_coordinator');
      return;
    }
    let active = true;
    void requireSupabase().rpc('is_hod_for_subject', {
      target_school: schoolId,
      target_subject: activeDocument.subject_id,
    }).then(({ data, error: queryError }) => {
      if (queryError) throw queryError;
      if (active) setCanApprove(role === 'school_admin' || role === 'academic_coordinator' || data === true);
    }, (approvalError: unknown) => {
      if (active) {
        setCanApprove(role === 'school_admin' || role === 'academic_coordinator');
        console.error('Could not verify curriculum approval permission.', approvalError);
      }
    });
    return () => { active = false; };
  }, [activeDocument, role, schoolId]);

  function resetForm() {
    setEditingDraftId('');
    setTitle('');
    setSyllabusCode('');
    setTeachingLanguage('');
    setNotes('');
    setSelectedYearGroups([]);
    setSelectedClasses([]);
    setCustomYearGroup('');
    setFile(null);
    setCategory('syllabus');
    setCurriculumType('Cambridge');
  }

  async function continueDraft(document: CurriculumDocument) {
    if (document.status !== 'draft') return;
    setError('');
    setSuccess('');
    try {
      const { data, error: assignmentError } = await requireSupabase()
        .from('curriculum_document_assignments')
        .select('year_group,class_id')
        .eq('school_id', schoolId ?? '')
        .eq('document_id', document.id);
      if (assignmentError) throw assignmentError;
      const assignments = (data ?? []) as { year_group: string; class_id: string | null }[];
      setEditingDraftId(document.id);
      setTitle(document.title);
      setAcademicYearId(document.academic_year_id);
      setSubjectId(document.subject_id);
      setCurriculumType(document.curriculum_type);
      setSyllabusCode(document.syllabus_code);
      setCategory(document.category);
      setTeachingLanguage(document.teaching_language);
      setNotes(document.notes);
      setSelectedYearGroups([...new Set(assignments.filter((item) => !item.class_id).map((item) => item.year_group))]);
      setSelectedClasses(assignments.flatMap((item) => item.class_id ? [item.class_id] : []));
      setFile(null);
      setTab('uploads');
      setSuccess('Draft loaded. Select its source file to continue; saved document details are kept unchanged.');
    } catch (loadError) {
      setError(getErrorMessage(loadError, 'Could not load curriculum draft assignments.'));
    }
  }

  function toggleYearGroup(value: string) {
    setSelectedYearGroups((current) => current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value]);
  }

  function toggleClass(classId: string) {
    const selected = classes.find((item) => item.id === classId);
    setSelectedClasses((current) => current.includes(classId)
      ? current.filter((item) => item !== classId)
      : [...current, classId]);
    if (selected) {
      const group = selected.grade_level?.trim() || selected.name.trim();
      setSelectedYearGroups((current) => current.includes(group) ? current : [...current, group]);
    }
  }

  function assignmentRows(documentId: string) {
    if (!schoolId || !user) return [];
    const selectedYear = years.find((year) => year.id === academicYearId);
    if (!selectedYear) return [];
    const groups = selectedYearGroups.length ? selectedYearGroups : selectedClasses
      .map((id) => classes.find((item) => item.id === id))
      .filter((item): item is SchoolClass => Boolean(item))
      .map((item) => item.grade_level?.trim() || item.name.trim());
    const byKey = new Map<string, {
      school_id: string; document_id: string; academic_year_id: string; year_group: string;
      class_id: string | null; created_by: string;
    }>();
    for (const yearGroup of groups) {
      const row = {
        school_id: schoolId,
        document_id: documentId,
        academic_year_id: academicYearId,
        year_group: yearGroup,
        class_id: null,
        created_by: user.id,
      };
      byKey.set(`year:${yearGroup}`, row);
    }
    for (const classId of selectedClasses) {
      const classRecord = classes.find((item) => item.id === classId);
      if (!classRecord) continue;
      const yearGroup = classRecord.grade_level?.trim() || classRecord.name.trim();
      byKey.set(`class:${classId}`, {
        school_id: schoolId,
        document_id: documentId,
        academic_year_id: academicYearId,
        year_group: yearGroup,
        class_id: classId,
        created_by: user.id,
      });
    }
    return [...byKey.values()];
  }

  async function saveCurriculumDraft(submitForProcessing: boolean) {
    if (!schoolId || !user) return;
    if (!title.trim() || !academicYearId || !subjectId) {
      setError('Enter a document title and choose an academic year and subject.');
      return;
    }
    if (submitForProcessing && !file) {
      setError('Choose a curriculum document before starting extraction.');
      return;
    }
    if (selectedClasses.some((classId) => !classes.find((item) => item.id === classId && item.academic_year_id === academicYearId))) {
      setError('Every selected class must belong to the selected academic year.');
      return;
    }
    if (submitForProcessing && !selectedYearGroups.length && !selectedClasses.length) {
      setError('Assign the curriculum to at least one year group or class.');
      return;
    }
    setSaving(true);
    setError('');
    setSuccess('');
    setUploadProgress(submitForProcessing ? { stage: 'Validating source file', percent: 0 } : null);
    try {
      const client = requireSupabase();
      let digest = '';
      let storagePath = '';
      let documentId = editingDraftId;
      let resumeExistingDraft = Boolean(editingDraftId);
      if (file) {
        await validateFileInBrowser(file);
        setUploadProgress({ stage: 'Checking duplicate uploads', percent: 5 });
        digest = await sha256(file);
        const { data: duplicateRows, error: duplicateError } = await client.from('curriculum_documents')
          .select('id,status,temporary_storage_path,original_file_name,academic_year_id,subject_id')
          .eq('school_id', schoolId).eq('source_sha256', digest).limit(1);
        if (duplicateError) throw duplicateError;
        const duplicate = duplicateRows?.[0] as {
          id: string; status: string; temporary_storage_path: string | null; original_file_name: string | null;
          academic_year_id: string; subject_id: string;
        } | undefined;
        if (duplicate && duplicate.status !== 'draft') {
          throw new Error(`This file is already registered as "${duplicate.original_file_name || 'a curriculum document'}" (${duplicate.status.replaceAll('_', ' ')}).`);
        }
        if (duplicate && (duplicate.academic_year_id !== academicYearId || duplicate.subject_id !== subjectId)) {
          throw new Error('A matching unfinished upload exists for a different academic year or subject. Continue it from its original assignment.');
        }
        if (duplicate && editingDraftId && duplicate.id !== editingDraftId) {
          throw new Error('This file belongs to a different unfinished draft. Continue that draft instead.');
        }
        documentId = duplicate?.id ?? (editingDraftId || crypto.randomUUID());
        resumeExistingDraft = Boolean(duplicate || editingDraftId);
        storagePath = duplicate?.temporary_storage_path
          ?? `${schoolId}/${documentId}/${safeFileName(file.name)}`;
      } else {
        documentId = crypto.randomUUID();
      }

      const documentPayload = {
        id: documentId,
        school_id: schoolId,
        academic_year_id: academicYearId,
        subject_id: subjectId,
        uploaded_by: user.id,
        title: title.trim(),
        curriculum_type: curriculumType.trim() || 'Custom',
        syllabus_code: syllabusCode.trim(),
        category,
        teaching_language: teachingLanguage.trim(),
        notes: notes.trim(),
        status: 'draft',
        original_file_name: file?.name ?? null,
        original_content_type: file ? mimeTypeFor(file) : null,
        original_size_bytes: file?.size ?? null,
        source_sha256: digest || null,
        temporary_storage_path: storagePath || null,
      };
      if (file) {
        if (resumeExistingDraft) {
          const { error: attachError } = await client.rpc('attach_curriculum_source', {
            target_document: documentId,
            file_name: file.name,
            content_type: mimeTypeFor(file),
            size_bytes: file.size,
            source_hash: digest,
            storage_path: storagePath,
          });
          if (attachError) throw attachError;
        } else {
          const { error: saveError } = await client.from('curriculum_documents').insert(documentPayload);
          if (saveError) throw saveError;
        }
        setUploadProgress({ stage: 'Uploading temporary source', percent: 8 });
        const existingFiles = await client.storage.from(BUCKET).list(`${schoolId}/${documentId}`, {
          search: storagePath.split('/').pop() ?? '',
          limit: 5,
        });
        if (existingFiles.error) throw existingFiles.error;
        if (!existingFiles.data?.some((item) => item.name === safeFileName(file.name))) {
          await uploadWithProgress(storagePath, file, (percent) => {
            setUploadProgress({ stage: 'Uploading temporary source', percent: Math.min(78, 8 + Math.round(percent * 0.7)) });
          });
        } else if (editingDraftId) {
          const assignments = assignmentRows(editingDraftId);
          if (assignments.length) {
            const { error: assignmentError } = await client.from('curriculum_document_assignments')
              .upsert(assignments, { onConflict: 'school_id,document_id,academic_year_id,year_group,class_key', ignoreDuplicates: true });
            if (assignmentError) throw assignmentError;
          }
          setSuccess('Draft remains saved. Attach its source file when you are ready to start processing.');
        } else {
          setUploadProgress({ stage: 'Verifying saved temporary source', percent: 78 });
        }
        const { error: uploadedError } = await client.rpc('mark_curriculum_uploaded', { target_document: documentId });
        if (uploadedError) throw uploadedError;
        setUploadProgress({ stage: 'Saving year-group and class assignments', percent: 82 });
        const assignments = assignmentRows(documentId);
        if (assignments.length) {
          const { error: assignmentError } = await client.from('curriculum_document_assignments')
            .upsert(assignments, { onConflict: 'school_id,document_id,academic_year_id,year_group,class_key', ignoreDuplicates: true });
          if (assignmentError) throw assignmentError;
        }
        if (submitForProcessing) {
          setUploadProgress({ stage: 'Queuing document processing', percent: 92 });
          const { error: submitError } = await client.rpc('submit_curriculum_document', { target_document: documentId });
          if (submitError) throw submitError;
          setUploadProgress({ stage: 'Queued for processing', percent: 100 });
          setSuccess('Curriculum document uploaded and queued. Processing will continue in the background.');
        } else {
          setSuccess('Curriculum upload draft saved.');
        }
      } else {
        const { error: saveError } = await client.from('curriculum_documents').insert(documentPayload);
        if (saveError) throw saveError;
        const assignments = assignmentRows(documentId);
        if (assignments.length) {
          const { error: assignmentError } = await client.from('curriculum_document_assignments').insert(assignments);
          if (assignmentError) throw assignmentError;
        }
        setSuccess('Curriculum draft saved. Add a source file to start processing.');
      }
      resetForm();
      setRefreshKey((current) => current + 1);
    } catch (saveError) {
      setError(getErrorMessage(saveError, 'Could not save curriculum document.'));
    } finally {
      setSaving(false);
      setUploadProgress(null);
    }
  }

  async function retryProcessing(document: CurriculumDocument) {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: submitError } = await requireSupabase().rpc('submit_curriculum_document', {
        target_document: document.id,
      });
      if (submitError) throw submitError;
      setSuccess(`Processing restarted for "${document.title}".`);
      setRefreshKey((current) => current + 1);
    } catch (retryError) {
      setError(getErrorMessage(retryError, 'Could not retry curriculum processing.'));
    } finally {
      setSaving(false);
    }
  }

  async function saveObjectiveReview(objective: CurriculumObjective, decision: ReviewDecision) {
    const text = reviewText[objective.id]?.trim();
    if (!text) {
      setError('Corrected objective wording cannot be empty.');
      return;
    }
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: reviewError } = await requireSupabase().rpc('review_curriculum_objective', {
        target_objective: objective.id,
        new_text: text,
        new_review_status: decision,
        new_simplified_text: objective.simplified_text,
      });
      if (reviewError) throw reviewError;
      setSuccess(`Objective ${decision === 'approved' ? 'approved' : decision === 'rejected' ? 'rejected' : 'flagged for correction'}.`);
      setRefreshKey((current) => current + 1);
    } catch (reviewError) {
      setError(getErrorMessage(reviewError, 'Could not save the objective review.'));
    } finally {
      setSaving(false);
    }
  }

  async function saveTopicReview(topic: CurriculumTopic, decision: ReviewDecision) {
    const name = reviewText[`topic:${topic.id}`]?.trim() || topic.corrected_name || topic.name;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: reviewError } = await requireSupabase().rpc('review_curriculum_topic', {
        target_topic: topic.id,
        new_name: name,
        new_review_status: decision,
      });
      if (reviewError) throw reviewError;
      setSuccess(`Topic ${decision === 'approved' ? 'approved' : decision === 'rejected' ? 'rejected' : 'flagged for correction'}.`);
      setRefreshKey((current) => current + 1);
    } catch (reviewError) {
      setError(getErrorMessage(reviewError, 'Could not save the topic review.'));
    } finally {
      setSaving(false);
    }
  }

  async function saveSourceUnitReview(unit: SourceUnit, status: 'approved' | 'needs_correction') {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: reviewError } = await requireSupabase().rpc('review_curriculum_source_unit', {
        target_source_unit: unit.id,
        new_review_status: status,
      });
      if (reviewError) throw reviewError;
      setSuccess(`${unit.unit_reference} marked ${status === 'approved' ? 'reviewed' : 'for correction'}.`);
      setRefreshKey((current) => current + 1);
    } catch (reviewError) {
      setError(getErrorMessage(reviewError, 'Could not save the source-unit review.'));
    } finally {
      setSaving(false);
    }
  }

  async function addReviewRecord(kind: 'topic' | 'objective') {
    if (!activeDocument) return;
    const text = kind === 'topic' ? newTopic.trim() : newObjective.trim();
    if (!text) {
      setError(kind === 'topic' ? 'Enter a topic name.' : 'Enter an objective.');
      return;
    }
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const rpc = kind === 'topic' ? 'add_curriculum_topic' : 'add_curriculum_objective';
      const args = kind === 'topic'
        ? {
          target_document: activeDocument.id,
          target_source_unit: newSourceUnitId || null,
          new_name: text,
          new_section_number: newSectionNumber.trim(),
        }
        : {
          target_document: activeDocument.id,
          target_topic: null,
          target_source_unit: newSourceUnitId || null,
          new_text: text,
          new_section_number: newSectionNumber.trim(),
          new_objective_type: newObjectiveType,
        };
      const { error: addError } = await requireSupabase().rpc(rpc, args);
      if (addError) throw addError;
      if (kind === 'topic') setNewTopic('');
      else setNewObjective('');
      setNewSectionNumber('');
      setSuccess(`${kind === 'topic' ? 'Topic' : 'Objective'} added as teacher-created draft content.`);
      setRefreshKey((current) => current + 1);
    } catch (addError) {
      setError(getErrorMessage(addError, `Could not add the ${kind}.`));
    } finally {
      setSaving(false);
    }
  }

  async function approveDocument() {
    if (!activeDocument) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: approveError } = await requireSupabase().rpc('approve_curriculum_document', {
        target_document: activeDocument.id,
      });
      if (approveError) throw approveError;
      setSuccess('Curriculum approved. The background worker will now delete and verify the temporary source file.');
      setRefreshKey((current) => current + 1);
    } catch (approveError) {
      setError(getErrorMessage(approveError, 'Could not approve this curriculum.'));
    } finally {
      setSaving(false);
    }
  }

  function selectReviewDocument(documentId: string) {
    setReviewDocumentId(documentId);
    setCanApprove(role === 'school_admin' || role === 'academic_coordinator');
    setReviewText({});
    setError('');
    setSuccess('');
  }

  if (!canUse) {
    return <div className="page-stack"><ErrorState message="Curriculum Intelligence is available to teachers and academic administrators." /></div>;
  }

  const reviewableDocuments = documents.filter((document) =>
    ['needs_review', 'approved', 'source_deleted', 'deletion_failed'].includes(document.status),
  );
  const pendingTopics = reviewData.topics.filter((topic) => topic.review_status === 'pending' || topic.review_status === 'needs_correction').length;
  const pendingObjectives = reviewData.objectives.filter((objective) => objective.review_status === 'pending' || objective.review_status === 'needs_correction').length;
  const pendingUnits = reviewData.units.filter((unit) => unit.review_status !== 'approved').length;

  return (
    <div className="page-stack curriculum-intelligence-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">Academics / Curriculum Intelligence</span>
          <h1>Curriculum intelligence</h1>
          <p>Extract, review and approve your school's curriculum with traceable source references.</p>
        </div>
        <div className="curriculum-privacy-note"><ShieldCheck size={17} /><span>Sources stay temporary and are deleted only after approval.</span></div>
      </header>

      {(error || success) && <div className="curriculum-feedback">{error && <ErrorState message={error} />}{success && <SuccessMessage message={success} />}</div>}

      <nav className="automation-tabs curriculum-tabs" aria-label="Curriculum workspace">
        <button type="button" className={tab === 'uploads' ? 'active' : ''} onClick={() => setTab('uploads')}>
          <UploadCloud size={16} /> Uploads and drafts
        </button>
        <button type="button" className={tab === 'review' ? 'active' : ''} onClick={() => setTab('review')}>
          <FileCheck2 size={16} /> Review extracted curriculum
        </button>
        <button type="button" className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}>
          <Sparkles size={16} /> Objectives and AI
        </button>
        <button type="button" className={tab === 'templates' ? 'active' : ''} onClick={() => setTab('templates')}>
          <FilePlus2 size={16} /> Templates
        </button>
        <button type="button" className={tab === 'versions' ? 'active' : ''} onClick={() => setTab('versions')}>
          <ArrowLeftRight size={16} /> Compare versions
        </button>
        <button type="button" className={tab === 'plans' ? 'active' : ''} onClick={() => setTab('plans')}>
          <CalendarDays size={16} /> Planning
        </button>
        <button type="button" className={tab === 'coverage' ? 'active' : ''} onClick={() => setTab('coverage')}>
          <Activity size={16} /> Coverage and reports
        </button>
      </nav>

      {tab === 'uploads' && <>
        <section className="content-card curriculum-upload-card">
          <div className="section-heading">
            <div><span className="eyebrow">New curriculum</span><h2>Upload a source document</h2></div>
            <BookOpenText size={20} aria-hidden="true" />
          </div>
          <p className="curriculum-section-intro">Supported formats: PDF, DOCX, DOC, XLSX, XLS, CSV, PPTX and TXT. Scanned PDFs use OCR in the background worker.</p>
          {editingDraftId && <div className="curriculum-draft-hint">
            <CircleHelp size={15} /> Continuing a saved draft. Its school, year and subject are locked; you can add or adjust year-group and class assignments.
            <button type="button" className="button button-quiet" onClick={resetForm}>Cancel</button>
          </div>}
          <div className="curriculum-form-grid">
            <label className="field">
              <span>Document title</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={180} placeholder="e.g. Biology syllabus 2025–2027" disabled={Boolean(editingDraftId)} />
            </label>
            <label className="field">
              <span>Academic year</span>
              <select value={academicYearId} onChange={(event) => { setAcademicYearId(event.target.value); setSelectedClasses([]); setSelectedYearGroups([]); }} disabled={Boolean(editingDraftId)}>
                <option value="">Choose an academic year</option>
                {years.map((year) => <option key={year.id} value={year.id}>{year.name}{year.is_current ? ' · current' : ''}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Subject</span>
              <select value={subjectId} onChange={(event) => setSubjectId(event.target.value)} disabled={Boolean(editingDraftId)}>
                <option value="">Choose a subject</option>
                {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}{subject.code ? ` (${subject.code})` : ''}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Curriculum type</span>
              <input value={curriculumType} onChange={(event) => setCurriculumType(event.target.value)} maxLength={120} placeholder="Cambridge IGCSE" disabled={Boolean(editingDraftId)} />
            </label>
            <label className="field">
              <span>Syllabus code <small>Optional</small></span>
              <input value={syllabusCode} onChange={(event) => setSyllabusCode(event.target.value)} maxLength={40} placeholder="e.g. 0610" disabled={Boolean(editingDraftId)} />
            </label>
            <label className="field">
              <span>Document category</span>
              <select value={category} onChange={(event) => setCategory(event.target.value)} disabled={Boolean(editingDraftId)}>
                <option value="syllabus">Syllabus</option>
                <option value="scheme_of_work">Scheme of work</option>
                <option value="teaching_plan">Teaching plan</option>
                <option value="other">Other curriculum document</option>
              </select>
            </label>
            <label className="field">
              <span>Teaching language <small>Optional</small></span>
              <input value={teachingLanguage} onChange={(event) => setTeachingLanguage(event.target.value)} maxLength={80} placeholder="English" disabled={Boolean(editingDraftId)} />
            </label>
            <label className="field curriculum-notes-field">
              <span>Notes <small>Optional</small></span>
              <textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={5000} rows={3} placeholder="Add context for the curriculum reviewer" disabled={Boolean(editingDraftId)} />
            </label>
          </div>

          <div className="curriculum-assignment-grid">
            <section className="curriculum-choice-panel">
              <div className="curriculum-choice-heading"><div><strong>Year groups</strong><small>Choose every applicable year group.</small></div><span>{selectedYearGroups.length} selected</span></div>
              {yearGroupOptions.length
                ? <div className="curriculum-check-list">{yearGroupOptions.map((group) => (
                  <label key={group}><input type="checkbox" checked={selectedYearGroups.includes(group)} onChange={() => toggleYearGroup(group)} /><span>{group}</span></label>
                ))}</div>
                : <p className="curriculum-muted">Add a year group below to continue.</p>}
              <div className="curriculum-add-year-group">
                <input value={customYearGroup} onChange={(event) => setCustomYearGroup(event.target.value)} maxLength={80} placeholder="Add another year group" />
                <button type="button" className="button button-secondary" onClick={() => {
                  const value = customYearGroup.trim();
                  if (value) {
                    setSelectedYearGroups((current) => current.includes(value) ? current : [...current, value]);
                    setCustomYearGroup('');
                  }
                }}><Plus size={15} /> Add</button>
              </div>
              {selectedYearGroups.filter((group) => !yearGroupOptions.includes(group)).map((group) => (
                <button key={group} type="button" className="curriculum-custom-group" onClick={() => toggleYearGroup(group)}>{group}<span aria-hidden="true">×</span></button>
              ))}
            </section>
            <section className="curriculum-choice-panel">
              <div className="curriculum-choice-heading"><div><strong>Classes</strong><small>Optional; select one or more classes.</small></div><span>{selectedClasses.length} selected</span></div>
              {classes.filter((classRecord) => classRecord.academic_year_id === academicYearId).length
                ? <div className="curriculum-check-list curriculum-class-list">
                  {classes.filter((classRecord) => classRecord.academic_year_id === academicYearId).map((classRecord) => (
                    <label key={classRecord.id}>
                      <input type="checkbox" checked={selectedClasses.includes(classRecord.id)} onChange={() => toggleClass(classRecord.id)} />
                      <span>{classRecord.name}<small>{classRecord.grade_level || 'Year group not set'}</small></span>
                    </label>
                  ))}
                </div>
                : <p className="curriculum-muted">No classes are configured for this academic year. Year-group assignment still works.</p>}
            </section>
          </div>

          <label className="curriculum-file-picker">
            <input
              type="file"
              accept=".pdf,.docx,.doc,.xlsx,.xls,.csv,.pptx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            <span className="curriculum-file-icon"><UploadCloud size={21} /></span>
            <span className="curriculum-file-copy"><strong>{file?.name ?? 'Choose a curriculum file'}</strong><small>{file ? `${(file.size / (1024 * 1024)).toFixed(2)} MB · ${file.type || 'file type checked by content'}` : 'Maximum 50 MB · files are not retained after review and approval'}</small></span>
            <span className="button button-secondary">Browse</span>
          </label>
          {!file && !editingDraftId && <div className="curriculum-draft-hint"><CircleHelp size={15} /> You can save an incomplete metadata draft without uploading a file.</div>}

          {uploadProgress && <div className="curriculum-progress" role="status">
            <div><LoaderCircle size={16} className="spin" /><span>{uploadProgress.stage}</span><strong>{uploadProgress.percent}%</strong></div>
            <progress max={100} value={uploadProgress.percent} />
          </div>}
          <div className="curriculum-upload-actions">
            <button type="button" className="button button-secondary" disabled={saving} onClick={() => void saveCurriculumDraft(false)}>
              Save draft
            </button>
            <button type="button" className="button button-primary" disabled={saving || !file} onClick={() => void saveCurriculumDraft(true)}>
              {saving ? <LoaderCircle size={16} className="spin" /> : <UploadCloud size={16} />}
              Upload and process
            </button>
          </div>
        </section>

        <section className="content-card curriculum-history-card">
          <div className="section-heading">
            <div><span className="eyebrow">School documents</span><h2>Upload history</h2></div>
            <button type="button" className="icon-button" aria-label="Refresh upload history" onClick={() => setRefreshKey((current) => current + 1)}><RefreshCw size={16} /></button>
          </div>
          {loading ? <LoadingState label="Loading curriculum documents…" /> : documents.length
            ? <div className="curriculum-document-list">{documents.map((document) => {
              const details = jobManifest(document.job);
              const subject = subjects.find((item) => item.id === document.subject_id)?.name ?? 'Subject';
              const year = years.find((item) => item.id === document.academic_year_id)?.name ?? 'Academic year';
              const canRetry = ['uploaded', 'failed'].includes(document.status) && Boolean(document.original_file_name);
              return <article className="curriculum-document-row" key={document.id}>
                <div className="curriculum-document-icon"><FileText size={18} /></div>
                <div className="curriculum-document-main">
                  <div className="curriculum-document-title"><strong>{document.title}</strong><span className={`curriculum-status curriculum-status-${document.status}`}>{statusLabel(document)}</span></div>
                  <p>{subject} · {year}{document.syllabus_code ? ` · ${document.syllabus_code}` : ''}</p>
                  <div className="curriculum-document-meta">
                    <span>{document.original_file_name || 'Draft without source file'}</span>
                    {typeof details.total_units === 'number' && <span>{typeof details.processed_units === 'number' ? details.processed_units : 0}/{details.total_units} units processed</span>}
                    {typeof details.ocr_units === 'number' && details.ocr_units > 0 && <span>{details.ocr_units} OCR pages</span>}
                    {document.source_deleted_at && <span>Source deletion verified</span>}
                  </div>
                  {document.job?.error_message && <small className="curriculum-document-error"><AlertTriangle size={13} /> {document.job.error_message}</small>}
                </div>
                <div className="curriculum-document-actions">
                  {document.status === 'draft' && <button type="button" className="button button-secondary" disabled={saving} onClick={() => void continueDraft(document)}>Continue draft</button>}
                  {canRetry && <button type="button" className="button button-secondary" disabled={saving} onClick={() => void retryProcessing(document)}><RefreshCw size={14} /> {document.status === 'uploaded' ? 'Start extraction' : 'Retry'}</button>}
                  {['needs_review', 'approved', 'source_deleted', 'deletion_failed'].includes(document.status)
                    && <button type="button" className="button button-secondary" onClick={() => { selectReviewDocument(document.id); setTab('review'); }}>Review</button>}
                </div>
              </article>;
            })}</div>
            : <EmptyState title="No curriculum uploads yet" detail="Start by uploading a syllabus or save a draft to return to later." />}
        </section>
      </>}

      {tab === 'review' && <section className="curriculum-review-layout">
        <aside className="content-card curriculum-review-list">
          <div className="section-heading"><div><span className="eyebrow">Verification queue</span><h2>Documents</h2></div><FileCheck2 size={18} /></div>
          {loading ? <LoadingState /> : reviewableDocuments.length
            ? <div className="curriculum-review-document-list">{reviewableDocuments.map((document) => (
              <button type="button" key={document.id} className={`curriculum-review-document ${reviewDocumentId === document.id ? 'active' : ''}`} onClick={() => selectReviewDocument(document.id)}>
                <span><strong>{document.title}</strong><small>{subjects.find((item) => item.id === document.subject_id)?.name ?? 'Subject'} · {statusLabel(document)}</small></span>
                <ChevronDown size={15} />
              </button>
            ))}</div>
            : <EmptyState title="Nothing to review" detail="Documents appear here after the background worker finishes extracting them." />}
        </aside>

        <div className="curriculum-review-content">
          {!activeDocument
            ? <section className="content-card"><EmptyState title="Select a curriculum document" detail="Review extracted source text, topics and objectives side by side before approving." /></section>
            : reviewLoading
              ? <section className="content-card"><LoadingState label="Loading source evidence…" /></section>
              : <>
                <section className="content-card curriculum-review-summary">
                  <div className="section-heading">
                    <div><span className="eyebrow">{activeDocument.curriculum_type}{activeDocument.syllabus_code ? ` · ${activeDocument.syllabus_code}` : ''}</span><h2>{activeDocument.title}</h2></div>
                    <span className={`curriculum-status curriculum-status-${activeDocument.status}`}>{statusLabel(activeDocument)}</span>
                  </div>
                  <div className="curriculum-review-metrics">
                    <span><strong>{reviewData.units.length}</strong> source units</span>
                    <span><strong>{reviewData.topics.length}</strong> topics</span>
                    <span><strong>{reviewData.objectives.length}</strong> objectives</span>
                    <span><strong>{pendingUnits + pendingTopics + pendingObjectives}</strong> awaiting review</span>
                  </div>
                  <p>Extracted wording remains unchanged. Corrections and teacher-created material are stored separately from source text.</p>
                </section>

                <section className="content-card curriculum-review-records">
                  <div className="section-heading"><div><span className="eyebrow">Structured curriculum</span><h2>Topics and learning objectives</h2></div></div>
                  {!reviewData.topics.length && !reviewData.objectives.length && <div className="curriculum-review-warning"><AlertTriangle size={16} /> No structured records were recognized automatically. Add records below from the extracted source before approval.</div>}
                  {reviewData.topics.map((topic) => {
                    const unit = reviewData.units.find((item) => item.id === topic.source_unit_id);
                    return <article className="curriculum-review-record" key={topic.id}>
                      <div className="curriculum-record-topline"><span>Topic · {sourceReference(unit)}{topic.section_number ? ` · ${topic.section_number}` : ''}</span><span className={`curriculum-status curriculum-status-${topic.review_status}`}>{topic.review_status.replaceAll('_', ' ')}</span></div>
                      <label className="field"><span>Topic name <small>Original: {topic.name}</small></span>
                        <input value={reviewText[`topic:${topic.id}`] ?? topic.corrected_name ?? topic.name} onChange={(event) => setReviewText((current) => ({ ...current, [`topic:${topic.id}`]: event.target.value }))} />
                      </label>
                      {unit && <details className="curriculum-source-evidence"><summary>Show source text for {unit.unit_reference}</summary><pre>{unit.extracted_text || 'No text was extracted for this unit.'}</pre></details>}
                      <ReviewButtons disabled={saving || activeDocument.status !== 'needs_review'} status={topic.review_status} onDecision={(decision) => void saveTopicReview(topic, decision)} />
                    </article>;
                  })}
                  {reviewData.objectives.map((objective) => {
                    const unit = reviewData.units.find((item) => item.id === objective.source_unit_id);
                    const topic = reviewData.topics.find((item) => item.id === objective.topic_id);
                    const text = reviewText[objective.id] ?? (objective.corrected_text || objective.original_text);
                    return <article className="curriculum-review-record curriculum-objective-record" key={objective.id}>
                      <div className="curriculum-record-topline">
                        <span>{objective.origin === 'extracted' ? 'Syllabus objective' : `${objective.origin} objective`} · {sourceReference(unit)}{objective.section_number ? ` · ${objective.section_number}` : ''}</span>
                        <span className={`curriculum-status curriculum-status-${objective.review_status}`}>{objective.review_status.replaceAll('_', ' ')}</span>
                      </div>
                      <div className="curriculum-objective-meta">{objective.objective_type.replaceAll('_', ' ')}{topic ? ` · ${topic.corrected_name || topic.name}` : ''}{objective.extraction_confidence !== null ? ` · ${objective.extraction_confidence}% confidence` : ''}</div>
                      <label className="field"><span>Verified wording <small>{objective.origin === 'extracted' ? 'Source wording is preserved separately.' : 'Teacher-created content.'}</small></span>
                        <textarea rows={3} value={text} onChange={(event) => setReviewText((current) => ({ ...current, [objective.id]: event.target.value }))} />
                      </label>
                      {unit && <details className="curriculum-source-evidence"><summary>Show original source text for {unit.unit_reference}</summary><pre>{unit.extracted_text || 'No text was extracted for this unit.'}</pre></details>}
                      <ReviewButtons disabled={saving || activeDocument.status !== 'needs_review'} status={objective.review_status} onDecision={(decision) => void saveObjectiveReview(objective, decision)} />
                    </article>;
                  })}
                </section>

                <section className="content-card curriculum-source-units">
                  <div className="section-heading"><div><span className="eyebrow">Extraction manifest</span><h2>Source pages, slides and worksheets</h2></div></div>
                  <div className="curriculum-source-unit-list">{reviewData.units.map((unit) => (
                    <details className="curriculum-source-unit" key={unit.id}>
                      <summary><span><strong>{unit.unit_reference}</strong><small>{unit.extraction_method}{unit.extraction_confidence !== null ? ` · ${unit.extraction_confidence}% confidence` : ''}</small></span>
                        <span className={unit.review_status === 'approved' ? 'unit-ok' : 'needs-review'}>
                          {unit.review_status === 'approved' ? 'Page reviewed' : unit.review_status === 'needs_correction' ? 'Correction needed' : 'Review page'}
                        </span>
                      </summary>
                      {unit.warnings.length > 0 && <ul>{unit.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
                      <pre>{unit.extracted_text || 'No selectable text was extracted.'}</pre>
                      {unit.extracted_tables.map((table, tableIndex) => <div className="curriculum-table-wrap" key={`${unit.id}-${tableIndex}`}>
                        <table><tbody>{table.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => rowIndex === 0
                          ? <th key={cellIndex}>{cell}</th> : <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table>
                      </div>)}
                      {activeDocument.status === 'needs_review' && <div className="curriculum-review-actions">
                        <button type="button" className={`button ${unit.review_status === 'approved' ? 'button-primary' : 'button-secondary'}`} disabled={saving} onClick={() => void saveSourceUnitReview(unit, 'approved')}>
                          <Check size={14} /> Mark page reviewed
                        </button>
                        <button type="button" className="button button-secondary" disabled={saving} onClick={() => void saveSourceUnitReview(unit, 'needs_correction')}>
                          <AlertTriangle size={14} /> Needs correction
                        </button>
                      </div>}
                    </details>
                  ))}</div>
                  {reviewData.units.length === 0 && <EmptyState title="No source evidence available" detail="A successful document extraction is required before review." />}
                </section>

                {activeDocument.status === 'needs_review' && <>
                  <section className="content-card curriculum-add-record">
                    <div className="section-heading"><div><span className="eyebrow">Manual corrections</span><h2>Add a missing topic or objective</h2></div><Plus size={18} /></div>
                    <div className="curriculum-add-grid">
                      <label className="field"><span>Source reference</span>
                        <select value={newSourceUnitId} onChange={(event) => setNewSourceUnitId(event.target.value)}>
                          <option value="">No specific source unit</option>
                          {reviewData.units.map((unit) => <option key={unit.id} value={unit.id}>{unit.unit_reference}</option>)}
                        </select>
                      </label>
                      <label className="field"><span>Section identifier</span><input value={newSectionNumber} onChange={(event) => setNewSectionNumber(event.target.value)} maxLength={80} /></label>
                      <label className="field"><span>New topic</span><input value={newTopic} onChange={(event) => setNewTopic(event.target.value)} maxLength={500} /></label>
                      <button type="button" className="button button-secondary curriculum-add-button" disabled={saving} onClick={() => void addReviewRecord('topic')}><Plus size={14} /> Add topic</button>
                      <label className="field curriculum-objective-add"><span>New lesson / syllabus objective</span><textarea rows={2} value={newObjective} onChange={(event) => setNewObjective(event.target.value)} maxLength={5000} /></label>
                      <label className="field"><span>Objective type</span>
                        <select value={newObjectiveType} onChange={(event) => setNewObjectiveType(event.target.value)}>
                          <option value="core">Core</option><option value="supplement">Supplement</option><option value="practical">Practical</option><option value="assessment">Assessment</option><option value="teaching_guidance">Teaching guidance</option><option value="other">Other</option>
                        </select>
                      </label>
                      <button type="button" className="button button-secondary curriculum-add-button" disabled={saving} onClick={() => void addReviewRecord('objective')}><Plus size={14} /> Add objective</button>
                    </div>
                  </section>

                  <section className="content-card curriculum-approval-card">
                    <div><ShieldCheck size={20} /><span><strong>Approval is explicit</strong><small>Approval starts source-file deletion only after all pages, topics and objectives are reviewed and saved.</small></span></div>
                    <button type="button" className="button button-primary" disabled={saving || !canApprove || pendingUnits + pendingTopics + pendingObjectives > 0} onClick={() => void approveDocument()}>
                      {saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}
                      {canApprove ? 'Approve curriculum' : 'Head of Department approval required'}
                    </button>
                  </section>
                </>}
                {activeDocument.status === 'deletion_failed' && <div className="curriculum-review-warning"><AlertTriangle size={16} /> Approval is saved, but source deletion has not been verified. The worker will retry; the structured curriculum remains intact.</div>}
                {activeDocument.status === 'source_deleted' && <div className="curriculum-source-deleted"><Check size={16} /> Source deletion verified on {new Date(activeDocument.source_deleted_at ?? '').toLocaleString()}.</div>}
              </>}
        </div>
      </section>}

      {tab === 'ai' && schoolId && <CurriculumAiPanel schoolId={schoolId} canManageSchoolKeys={role === 'school_admin'} />}
      {tab === 'templates' && schoolId && <CurriculumTemplatesPanel schoolId={schoolId} canApprove={role === 'school_admin' || role === 'academic_coordinator'} />}
      {tab === 'versions' && schoolId && <CurriculumVersionsPanel schoolId={schoolId} subjects={subjects} />}
      {tab === 'plans' && schoolId && <CurriculumPlansPanel schoolId={schoolId} />}
      {tab === 'coverage' && schoolId && <CurriculumCoveragePanel schoolId={schoolId} />}
    </div>
  );
}

function ReviewButtons({
  disabled, status, onDecision,
}: {
  disabled: boolean; status: string; onDecision: (decision: ReviewDecision) => void;
}) {
  return <div className="curriculum-review-actions">
    <button type="button" className={`button ${status === 'approved' ? 'button-primary' : 'button-secondary'}`} disabled={disabled} onClick={() => onDecision('approved')}><Check size={14} /> Approve</button>
    <button type="button" className="button button-secondary" disabled={disabled} onClick={() => onDecision('needs_correction')}><AlertTriangle size={14} /> Needs correction</button>
    <button type="button" className="button button-secondary curriculum-reject-button" disabled={disabled} onClick={() => onDecision('rejected')}><Trash2 size={14} /> Reject</button>
  </div>;
}
