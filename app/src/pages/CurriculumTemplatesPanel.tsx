import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { FilePlus2, LoaderCircle, RotateCcw, Save } from 'lucide-react';
import { EmptyState, ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type CurriculumTemplate = {
  id: string;
  template_key: string;
  version: number;
  name: string;
  description: string;
  category: string;
  subject_id: string | null;
  year_groups: string[];
  examination_board: string;
  document_format: 'html' | 'json' | 'pdf';
  sections: unknown[];
  settings: Record<string, unknown>;
  is_approved: boolean;
  created_at: string;
};
type Subject = { id: string; name: string };
const categories = [
  ['lesson_plan', 'Lesson plan'],
  ['lesson_notes', 'Lesson notes'],
  ['worksheet', 'Worksheet'],
  ['homework', 'Homework'],
  ['quiz', 'Quiz'],
  ['class_test', 'Class test'],
  ['midterm_exam', 'Midterm exam'],
  ['end_term_exam', 'End-of-term exam'],
  ['mock_exam', 'Mock exam'],
  ['revision', 'Revision'],
  ['practical', 'Practical'],
  ['mark_scheme', 'Mark scheme'],
  ['rubric', 'Rubric'],
  ['progress_report', 'Progress report'],
  ['department_report', 'Department report'],
];
const initialSections = JSON.stringify([
  { key: 'objectives', label: 'Learning objectives', required: true },
  { key: 'resources', label: 'Resources', required: false },
  { key: 'teaching_sequence', label: 'Teaching sequence', required: true },
  { key: 'assessment', label: 'Assessment', required: false },
], null, 2);

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function CurriculumTemplatesPanel({ schoolId, canApprove }: { schoolId: string; canApprove: boolean }) {
  const [templates, setTemplates] = useState<CurriculumTemplate[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sourceTemplate, setSourceTemplate] = useState<CurriculumTemplate | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('lesson_plan');
  const [subjectId, setSubjectId] = useState('');
  const [yearGroups, setYearGroups] = useState('');
  const [examinationBoard, setExaminationBoard] = useState('');
  const [documentFormat, setDocumentFormat] = useState<'html' | 'json' | 'pdf'>('html');
  const [sections, setSections] = useState(initialSections);
  const [settings, setSettings] = useState('{}');
  const [approved, setApproved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [templateResult, subjectResult] = await Promise.all([
        client.from('curriculum_templates').select('*').eq('school_id', schoolId).order('name').order('version', { ascending: false }),
        client.from('subjects').select('id,name').eq('school_id', schoolId).order('name'),
      ]);
      if (templateResult.error) throw templateResult.error;
      if (subjectResult.error) throw subjectResult.error;
      setTemplates((templateResult.data ?? []) as CurriculumTemplate[]);
      setSubjects((subjectResult.data ?? []) as Subject[]);
    } catch (loadError) {
      setError(messageOf(loadError, 'Could not load curriculum templates.'));
    } finally {
      setLoading(false);
    }
  }, [schoolId]);

  useEffect(() => { void load(); }, [load]);

  function resetForm() {
    setSourceTemplate(null);
    setName('');
    setDescription('');
    setCategory('lesson_plan');
    setSubjectId('');
    setYearGroups('');
    setExaminationBoard('');
    setDocumentFormat('html');
    setSections(initialSections);
    setSettings('{}');
    setApproved(false);
    setError('');
    setNotice('');
  }

  function startNewVersion(template: CurriculumTemplate) {
    const latestVersion = Math.max(...templates.filter((item) => item.template_key === template.template_key).map((item) => item.version));
    const latest = templates.find((item) => item.template_key === template.template_key && item.version === latestVersion) ?? template;
    setSourceTemplate(latest);
    setName(latest.name);
    setDescription(latest.description);
    setCategory(latest.category);
    setSubjectId(latest.subject_id ?? '');
    setYearGroups(latest.year_groups.join(', '));
    setExaminationBoard(latest.examination_board);
    setDocumentFormat(latest.document_format);
    setSections(JSON.stringify(latest.sections, null, 2));
    setSettings(JSON.stringify(latest.settings, null, 2));
    setApproved(canApprove && latest.is_approved);
    setError('');
    setNotice(`Creating version ${latest.version + 1}; version ${latest.version} will remain unchanged.`);
  }

  async function saveTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      let parsedSections: unknown;
      let parsedSettings: unknown;
      try {
        parsedSections = JSON.parse(sections);
        parsedSettings = JSON.parse(settings);
      } catch {
        throw new Error('Sections and settings must be valid JSON.');
      }
      if (!Array.isArray(parsedSections) || !parsedSections.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
        throw new Error('Sections must be a JSON array of section objects.');
      }
      if (!parsedSettings || typeof parsedSettings !== 'object' || Array.isArray(parsedSettings)) {
        throw new Error('Settings must be a JSON object.');
      }
      const yearGroupList = [...new Set(yearGroups.split(',').map((item) => item.trim()).filter(Boolean))];
      const latestVersion = sourceTemplate
        ? Math.max(...templates.filter((item) => item.template_key === sourceTemplate.template_key).map((item) => item.version))
        : 0;
      const row = {
        school_id: schoolId,
        ...(sourceTemplate ? { template_key: sourceTemplate.template_key, version: latestVersion + 1 } : {}),
        name: name.trim(),
        description: description.trim(),
        category,
        subject_id: subjectId || null,
        year_groups: yearGroupList,
        examination_board: examinationBoard.trim(),
        document_format: documentFormat,
        sections: parsedSections,
        settings: parsedSettings,
        is_approved: canApprove && approved,
        is_locked: false,
        created_by: (await requireSupabase().auth.getUser()).data.user?.id,
      };
      if (!row.created_by) throw new Error('Your session expired. Sign in again before saving.');
      const { error: insertError } = await requireSupabase().from('curriculum_templates').insert(row);
      if (insertError) throw insertError;
      const savedNotice = sourceTemplate ? `Created immutable template version ${latestVersion + 1}.` : 'Created curriculum template version 1.';
      resetForm();
      setNotice(savedNotice);
      await load();
    } catch (saveError) {
      setError(messageOf(saveError, 'Could not save this curriculum template.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="curriculum-templates-layout">
      <section className="content-card curriculum-template-list">
        <div className="section-heading"><div><span className="eyebrow">School library</span><h2>Academic templates</h2></div><FilePlus2 size={18} /></div>
        <p className="curriculum-section-intro">Each saved version is immutable. Create a new version to change its sections or settings.</p>
        {loading ? <LoadingState /> : templates.length
          ? <div className="curriculum-template-items">{templates.map((template) => (
            <article key={template.id} className="curriculum-template-item">
              <div><strong>{template.name}</strong><span>v{template.version} · {categories.find(([key]) => key === template.category)?.[1] ?? template.category} · {template.is_approved ? 'Approved' : 'Draft'}</span>
                <small>{template.subject_id ? subjects.find((subject) => subject.id === template.subject_id)?.name ?? 'Subject' : 'All subjects'}{template.year_groups.length ? ` · ${template.year_groups.join(', ')}` : ''}</small>
              </div>
              <button type="button" className="button button-secondary" disabled={saving} onClick={() => startNewVersion(template)}><RotateCcw size={14} /> New version</button>
            </article>
          ))}</div>
          : <EmptyState title="No academic templates yet" detail="Create a school template for lesson plans, assessments, reports, or other curriculum documents." />}
      </section>

      <section className="content-card curriculum-template-editor">
        <div className="section-heading"><div><span className="eyebrow">{sourceTemplate ? `New version after v${sourceTemplate.version}` : 'Template design'}</span><h2>{sourceTemplate ? 'Create a version' : 'Create a template'}</h2></div><FilePlus2 size={18} /></div>
        {(error || notice) && <div className="curriculum-feedback">{error && <ErrorState message={error} />}{notice && <SuccessMessage message={notice} />}</div>}
        <form className="curriculum-template-form" onSubmit={(event) => void saveTemplate(event)}>
          <div className="curriculum-ai-form-grid">
            <label className="field"><span>Template name</span><input value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={160} required /></label>
            <label className="field"><span>Document category</span><select value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            <label className="field"><span>Subject</span><select value={subjectId} onChange={(event) => setSubjectId(event.target.value)}><option value="">All subjects</option>{subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}</select></label>
            <label className="field"><span>Year groups</span><input value={yearGroups} onChange={(event) => setYearGroups(event.target.value)} placeholder="e.g. Year 10, Year 11" /></label>
            <label className="field"><span>Examination board</span><input value={examinationBoard} onChange={(event) => setExaminationBoard(event.target.value)} maxLength={120} /></label>
            <label className="field"><span>Document format</span><select value={documentFormat} onChange={(event) => setDocumentFormat(event.target.value as 'html' | 'json' | 'pdf')}><option value="html">HTML</option><option value="json">JSON</option><option value="pdf">PDF</option></select></label>
          </div>
          <label className="field"><span>Description</span><textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} /></label>
          <label className="field"><span>Sections JSON</span><textarea className="curriculum-json-editor" rows={8} value={sections} onChange={(event) => setSections(event.target.value)} spellCheck={false} /></label>
          <label className="field"><span>Settings JSON</span><textarea className="curriculum-json-editor" rows={5} value={settings} onChange={(event) => setSettings(event.target.value)} spellCheck={false} /></label>
          {canApprove && <label className="curriculum-template-approve"><input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} /> Approve this version for school use</label>}
          <div className="curriculum-template-actions">
            {sourceTemplate && <button type="button" className="button button-quiet" onClick={resetForm}>Start a new template</button>}
            <button type="submit" className="button button-primary" disabled={saving}>{saving ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />} Save immutable version</button>
          </div>
        </form>
      </section>
    </div>
  );
}
