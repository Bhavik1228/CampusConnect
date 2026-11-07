import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Check, ExternalLink, FileSearch, Plus, RefreshCw } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { ErrorState, LoadingState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type Source = {
  id: string;
  name: string;
  listing_url: string;
  terms_url: string | null;
  rights_basis: string | null;
  metadata_discovery_allowed: boolean;
  question_extraction_allowed: boolean;
  question_reuse_allowed: boolean;
  document_download_allowed: boolean;
  document_storage_allowed: boolean;
  ocr_allowed: boolean;
  curriculum: string | null;
  subject_name: string | null;
  syllabus_code: string | null;
  syllabus_version: string | null;
  schedule_enabled: boolean;
  schedule_interval_hours: number;
  document_max_bytes: number;
  status: 'active' | 'paused';
  last_discovery_at: string | null;
};
type Job = {
  id: string;
  source_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  discovered_count: number;
  failure_reason: string | null;
  created_at: string;
};
type DiscoveryItem = {
  id: string;
  source_id: string;
  canonical_url: string;
  title: string;
  link_text: string;
  review_status: 'pending' | 'approved' | 'rejected';
  pipeline_status: string;
  failure_reason: string | null;
};
type CatalogueQuestion = {
  id: string;
  source_id: string;
  discovery_item_id: string;
  created_by: string;
  question_text: string;
  topic: string;
  subtopic: string;
  syllabus_code: string;
  marks: number;
  difficulty: string;
  mark_scheme: string;
  review_status: 'pending' | 'approved' | 'rejected';
  reviewer_note: string;
  validation_status: string;
  validation_reasons: string[];
  content_use_status: string;
  curriculum: string | null;
  subject_name: string | null;
  syllabus_version: string | null;
  examination_year: number | null;
  examination_session: string | null;
  paper_number: string | null;
  variant: string | null;
  question_number: string | null;
  page_start: number | null;
  page_end: number | null;
  classification_status: string;
  document_id: string | null;
  syllabus_topic_id: string | null;
  extraction_status: string;
};
type SyllabusTopic = {
  id: string;
  curriculum: string;
  subject_name: string;
  syllabus_code: string;
  syllabus_version: string;
  topic: string;
  subtopic: string;
  approved_phrases: string[];
  source_url: string;
};
type RestrictedQuestion = {
  id: string;
  learning_question_id: string | null;
  question_text: string;
  source_name: string;
  registered_source_name: string;
  source_status: string;
  question_reuse_allowed: boolean;
  catalogue_review_status: string;
  item_review_status: string;
};
type PipelineState = {
  sources: Source[];
  jobs: Job[];
  items: DiscoveryItem[];
  questions: CatalogueQuestion[];
  restrictedQuestions: RestrictedQuestion[];
  syllabusTopics: SyllabusTopic[];
};
type SourceForm = {
  name: string;
  listingUrl: string;
  rightsConfirmed: boolean;
  metadataDiscoveryAllowed: boolean;
  questionExtractionAllowed: boolean;
  questionReuseAllowed: boolean;
  documentDownloadAllowed: boolean;
  documentStorageAllowed: boolean;
  ocrAllowed: boolean;
  curriculum: string;
  subjectName: string;
  syllabusCode: string;
  syllabusVersion: string;
  scheduleEnabled: boolean;
  scheduleIntervalHours: number;
  documentMaxBytes: number;
};
type QuestionForm = {
  questionText: string;
  topic: string;
  subtopic: string;
  syllabusCode: string;
  marks: string;
  difficulty: string;
  markScheme: string;
};

const EMPTY_STATE: PipelineState = { sources: [], jobs: [], items: [], questions: [], restrictedQuestions: [], syllabusTopics: [] };
const EMPTY_SOURCE: SourceForm = {
  name: '',
  listingUrl: '',
  rightsConfirmed: false,
  metadataDiscoveryAllowed: true,
  questionExtractionAllowed: false,
  questionReuseAllowed: false,
  documentDownloadAllowed: false,
  documentStorageAllowed: false,
  ocrAllowed: false,
  curriculum: '',
  subjectName: '',
  syllabusCode: '',
  syllabusVersion: '',
  scheduleEnabled: false,
  scheduleIntervalHours: 24,
  documentMaxBytes: 25 * 1024 * 1024,
};
const EMPTY_QUESTION: QuestionForm = {
  questionText: '',
  topic: '',
  subtopic: '',
  syllabusCode: '',
  marks: '1',
  difficulty: 'Standard',
  markScheme: '',
};

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function PastPaperPipelinePage() {
  const { activeMembership, user } = useAuth();
  const schoolId = activeMembership?.school_id;
  const isAcademicLead = activeMembership?.role === 'school_admin' || activeMembership?.role === 'academic_coordinator';
  const [state, setState] = useState(EMPTY_STATE);
  const [sourceForm, setSourceForm] = useState(EMPTY_SOURCE);
  const [questionForm, setQuestionForm] = useState(EMPTY_QUESTION);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [syllabusForm, setSyllabusForm] = useState({
    curriculum: 'IGCSE',
    subjectName: '',
    syllabusCode: '',
    syllabusVersion: '',
    topic: '',
    subtopic: '',
    approvedPhrases: '',
    sourceUrl: '',
  });
  const [previewUrl, setPreviewUrl] = useState('');
  const [editingSyllabusTopicId, setEditingSyllabusTopicId] = useState('');

  const request = useCallback(async <T,>(action: string, values: Record<string, unknown> = {}) => {
    if (!schoolId) throw new Error('Choose a school before using the past-paper pipeline.');
    const { data, error: invokeError } = await requireSupabase().functions.invoke('past-paper-pipeline', {
      body: { action, schoolId, ...values },
    });
    if (invokeError) {
      if (invokeError.context instanceof Response) {
        const responseBody = await invokeError.context.clone().text();
        if (responseBody) {
          let errorMessage = responseBody;
          try {
            const parsedBody: unknown = JSON.parse(responseBody);
            if (typeof parsedBody === 'object' && parsedBody !== null && !Array.isArray(parsedBody)
              && 'error' in parsedBody && typeof parsedBody.error === 'string') {
              errorMessage = parsedBody.error;
            }
          } catch {
            errorMessage = responseBody;
          }
          throw new Error(errorMessage);
        }
      }
      throw invokeError;
    }
    return data as T;
  }, [schoolId]);

  const load = useCallback(async () => {
    if (!schoolId) {
      setState(EMPTY_STATE);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await request<PipelineState>('list');
      setState(result);
    } catch (loadError) {
      setError(messageOf(loadError, 'Could not load the past-paper pipeline.'));
    } finally {
      setLoading(false);
    }
  }, [request, schoolId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const eligibleItems = state.items.filter((item) => item.review_status === 'approved'
      && state.sources.some((source) => source.id === item.source_id
        && source.question_extraction_allowed && source.question_reuse_allowed));
    setSelectedItemId((current) => eligibleItems.some((item) => item.id === current)
      ? current
      : eligibleItems[0]?.id ?? '');
  }, [state.items, state.sources]);

  async function submitSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await request('register-source', {
        ...sourceForm,
      });
      setSourceForm(EMPTY_SOURCE);
      setNotice('Source registered. Discovery will check robots.txt before reading its listing page.');
      await load();
    } catch (saveError) {
      setError(messageOf(saveError, 'Could not register this source.'));
    } finally {
      setSaving(false);
    }
  }

  async function discover(source: Source) {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ discoveredCount: number; correlationId: string }>('discover', {
        sourceId: source.id,
        idempotencyKey: crypto.randomUUID(),
      });
      setNotice(`Discovery and processing queue updated: ${result.discoveredCount} new paper link(s). Correlation ID: ${result.correlationId}`);
      await load();
    } catch (discoverError) {
      await load();
      setError(messageOf(discoverError, 'Could not discover this source.'));
    } finally {
      setSaving(false);
    }
  }

  async function pauseSource(source: Source) {
    if (!window.confirm(`Pause ${source.name}? Discovery and future catalogue imports will stop. Previously imported questions remain in the school question library.`)) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await request('pause-source', { sourceId: source.id });
      setNotice('Source paused. Existing imported questions were not removed; review them in the school question library if rights have changed.');
      await load();
    } catch (pauseError) {
      setError(messageOf(pauseError, 'Could not pause this source.'));
    } finally {
      setSaving(false);
    }
  }

  async function removeRestrictedQuestion(question: RestrictedQuestion) {
    const impact = question.learning_question_id
      ? ' Its imported copy will be removed; saved tests that reference it will no longer display the question.'
      : '';
    if (!window.confirm(`Permanently remove this restricted question and its catalogue content?${impact}`)) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await request('remove-restricted-question', { questionId: question.id });
      setNotice('Restricted question removed from the school question library.');
      await load();
    } catch (removeError) {
      setError(messageOf(removeError, 'Could not remove this restricted question.'));
    } finally {
      setSaving(false);
    }
  }

  async function reviewItem(item: DiscoveryItem, decision: 'approved' | 'rejected') {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await request('review-item', { itemId: item.id, decision });
      setNotice(decision === 'approved' ? 'Paper metadata approved.' : 'Paper metadata rejected.');
      await load();
    } catch (reviewError) {
      setError(messageOf(reviewError, 'Could not review this metadata.'));
    } finally {
      setSaving(false);
    }
  }

  async function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const item = state.items.find((candidate) => candidate.id === selectedItemId);
    if (!item) {
      setError('Choose an approved paper metadata record first.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await request('submit-question', {
        sourceId: item.source_id,
        itemId: item.id,
        ...questionForm,
        marks: Number(questionForm.marks),
      });
      setQuestionForm(EMPTY_QUESTION);
      setNotice('Question passed validation and was sent for school review.');
      await load();
    } catch (submitError) {
      setError(messageOf(submitError, 'Could not submit this question.'));
    } finally {
      setSaving(false);
    }
  }

  async function reviewQuestion(
    question: CatalogueQuestion,
    decision: 'approved' | 'rejected',
    corrections: Record<string, unknown> = {},
    syllabusTopicId = '',
    contentUseEligible = false,
  ) {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ validationStatus: string; contentUseStatus: string }>('review-question', {
        questionId: question.id,
        decision,
        corrections,
        syllabusTopicId: syllabusTopicId || null,
        contentUseEligible,
      });
      setNotice(decision === 'approved'
        ? `Validation ${result.validationStatus}; content use ${result.contentUseStatus}.`
        : 'Question rejected and recorded in validation history.');
      await load();
    } catch (reviewError) {
      setError(messageOf(reviewError, 'Could not review this question.'));
    } finally {
      setSaving(false);
    }
  }

  async function previewDocument(itemId: string) {
    setError('');
    try {
      const result = await request<{ url: string }>('preview-document', { itemId });
      setPreviewUrl(result.url);
    } catch (previewError) {
      setError(messageOf(previewError, 'Could not open the authorized private document.'));
    }
  }

  async function submitSyllabusTopic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await request('upsert-syllabus-topic', {
        syllabusTopicId: editingSyllabusTopicId || null,
        syllabusTopic: {
          ...syllabusForm,
          approvedPhrases: syllabusForm.approvedPhrases.split(/\r?\n/).map((phrase) => phrase.trim()).filter(Boolean),
        },
      });
      setEditingSyllabusTopicId('');
      setSyllabusForm((current) => ({ ...current, subjectName: '', syllabusCode: '', syllabusVersion: '', topic: '', subtopic: '', approvedPhrases: '', sourceUrl: '' }));
      setNotice('Verified syllabus topic saved. Changes are retained in the syllabus history.');
      await load();
    } catch (saveError) {
      setError(messageOf(saveError, 'Could not save this verified syllabus topic.'));
    } finally {
      setSaving(false);
    }
  }

  const eligibleItems = state.items.filter((item) => item.review_status === 'approved'
    && state.sources.some((source) => source.id === item.source_id
      && source.question_extraction_allowed && source.question_reuse_allowed));
  const selectedItem = state.items.find((item) => item.id === selectedItemId);
  const selectedSource = state.sources.find((source) => source.id === selectedItem?.source_id);

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <span className="eyebrow">{activeMembership?.school.name}</span>
          <h1>Authorized past-paper pipeline</h1>
          <p>Discover source metadata, review links, and prepare only rights-cleared questions for Test Maker.</p>
        </div>
        <button className="button button-quiet" onClick={() => void load()} disabled={loading}><RefreshCw size={14} /> Refresh</button>
      </div>

      {error && <ErrorState message={error} />}
      {notice && <div className="feedback feedback-success" role="status"><Check size={15} />{notice}</div>}
      {previewUrl && <a className="button button-quiet" href={previewUrl} target="_blank" rel="noreferrer">Open private PDF preview (expires in 60 seconds)</a>}
      {loading ? <LoadingState label="Loading source and review records…" /> : (
        <>
          {isAcademicLead && <section className="content-card">
            <div className="section-heading"><div><span className="eyebrow">School-scoped source</span><h2>Register an authorized listing</h2></div></div>
            <form className="test-question-form" onSubmit={(event) => void submitSource(event)}>
              <div className="test-form-grid">
                <label>Source name<input required maxLength={120} value={sourceForm.name} onChange={(event) => setSourceForm((current) => ({ ...current, name: event.target.value }))} placeholder="Publisher or licensed collection" /></label>
                <label>Listing URL<input required type="url" value={sourceForm.listingUrl} onChange={(event) => setSourceForm((current) => ({ ...current, listingUrl: event.target.value }))} placeholder="https://approved-host.example/papers" /></label>
                <label>Curriculum<select value={sourceForm.curriculum} onChange={(event) => setSourceForm((current) => ({ ...current, curriculum: event.target.value }))}><option value="">Not specified</option>{['Cambridge Primary', 'Cambridge Lower Secondary', 'O Level', 'IGCSE', 'AS Level', 'A Level'].map((value) => <option key={value}>{value}</option>)}</select></label>
                <label>Subject<input maxLength={160} value={sourceForm.subjectName} onChange={(event) => setSourceForm((current) => ({ ...current, subjectName: event.target.value }))} /></label>
                <label>Syllabus code<input maxLength={40} value={sourceForm.syllabusCode} onChange={(event) => setSourceForm((current) => ({ ...current, syllabusCode: event.target.value }))} /></label>
                <label>Syllabus version<input maxLength={80} value={sourceForm.syllabusVersion} onChange={(event) => setSourceForm((current) => ({ ...current, syllabusVersion: event.target.value }))} /></label>
                <label>Schedule interval (hours)<input type="number" min={1} max={720} value={sourceForm.scheduleIntervalHours} onChange={(event) => setSourceForm((current) => ({ ...current, scheduleIntervalHours: Number(event.target.value) }))} /></label>
                <label>Maximum PDF size (MB)<input type="number" min={1} max={50} value={Math.round(sourceForm.documentMaxBytes / (1024 * 1024))} onChange={(event) => setSourceForm((current) => ({ ...current, documentMaxBytes: Number(event.target.value) * 1024 * 1024 }))} /></label>
              </div>
              <label className="draft-recovery-check"><input type="checkbox" required checked={sourceForm.rightsConfirmed} onChange={(event) => setSourceForm((current) => ({ ...current, rightsConfirmed: event.target.checked }))} />I have checked this source and confirm that the permissions selected below are accurate.</label>
              <label className="draft-recovery-check"><input type="checkbox" checked={sourceForm.metadataDiscoveryAllowed} onChange={(event) => setSourceForm((current) => ({ ...current, metadataDiscoveryAllowed: event.target.checked }))} />The source terms and robots policy permit metadata discovery.</label>
              <label className="draft-recovery-check"><input type="checkbox" checked={sourceForm.documentDownloadAllowed} onChange={(event) => setSourceForm((current) => ({ ...current, documentDownloadAllowed: event.target.checked, documentStorageAllowed: event.target.checked && current.documentStorageAllowed, ocrAllowed: event.target.checked && current.ocrAllowed }))} />The rights basis permits retrieving the PDF documents.</label>
              <label className="draft-recovery-check"><input type="checkbox" checked={sourceForm.documentStorageAllowed} disabled={!sourceForm.documentDownloadAllowed} onChange={(event) => setSourceForm((current) => ({ ...current, documentStorageAllowed: event.target.checked, ocrAllowed: event.target.checked && current.ocrAllowed }))} />The rights basis permits storing the documents in private school-scoped storage.</label>
              <label className="draft-recovery-check"><input type="checkbox" checked={sourceForm.questionExtractionAllowed} onChange={(event) => setSourceForm((current) => ({ ...current, questionExtractionAllowed: event.target.checked, questionReuseAllowed: event.target.checked && current.questionReuseAllowed, ocrAllowed: event.target.checked && current.ocrAllowed }))} />The recorded rights permit extracting question content.</label>
              <label className="draft-recovery-check"><input type="checkbox" checked={sourceForm.ocrAllowed} disabled={!sourceForm.documentDownloadAllowed || !sourceForm.documentStorageAllowed || !sourceForm.questionExtractionAllowed} onChange={(event) => setSourceForm((current) => ({ ...current, ocrAllowed: event.target.checked }))} />The recorded rights permit OCR processing of scanned pages.</label>
              <label className="draft-recovery-check"><input type="checkbox" checked={sourceForm.questionReuseAllowed} disabled={!sourceForm.questionExtractionAllowed} onChange={(event) => setSourceForm((current) => ({ ...current, questionReuseAllowed: event.target.checked }))} />The recorded rights permit storing and reusing question content in school assessments.</label>
              <label className="draft-recovery-check"><input type="checkbox" checked={sourceForm.scheduleEnabled} onChange={(event) => setSourceForm((current) => ({ ...current, scheduleEnabled: event.target.checked }))} />Enable scheduled discovery and processing (worker checks every 15 minutes).</label>
              <div className="test-form-actions"><button className="button button-primary" disabled={saving}><Plus size={14} /> Register source</button></div>
            </form>
          </section>}

          <section className="content-card">
            <div className="section-heading"><div><span className="eyebrow">Allowlisted sources</span><h2>Configured sources</h2></div><span className="test-count">{state.sources.length}</span></div>
            {state.sources.length ? <div className="authorized-paper-list">{state.sources.map((source) => (
              <article className="authorized-paper-item" key={source.id}>
                <div>
                  <strong>{source.name}</strong>
                  <p><a href={source.listing_url} target="_blank" rel="noreferrer">{source.listing_url} <ExternalLink size={12} /></a></p>
                  <small>{source.document_download_allowed && source.document_storage_allowed ? `PDF retrieval and private storage allowed (max ${Math.round(source.document_max_bytes / (1024 * 1024))} MB)` : 'PDF retrieval disabled'} · {source.question_extraction_allowed ? 'Extraction allowed' : 'Extraction disabled'} · {source.question_reuse_allowed ? 'Reuse permitted' : 'Reuse not authorized'} · {source.schedule_enabled ? `Scheduled every ${source.schedule_interval_hours}h` : 'Manual discovery'} · {source.status}</small>
                </div>
                {isAcademicLead && <div className="test-form-actions">
                  <button className="button button-quiet" disabled={saving || source.status !== 'active'} onClick={() => void discover(source)}><FileSearch size={14} /> Discover metadata</button>
                  {source.status === 'active' && <button className="button button-quiet" disabled={saving} onClick={() => void pauseSource(source)}>Pause source</button>}
                </div>}
              </article>
            ))}</div> : <p>No source has been registered. A school academic lead must document the rights basis and permitted uses first.</p>}
          </section>

          <section className="content-card">
            <div className="section-heading"><div><span className="eyebrow">Metadata review</span><h2>Discovered paper links</h2></div><span className="test-count">{state.items.length}</span></div>
            {state.jobs.length > 0 && <div className="authorized-paper-list">{state.jobs.slice(0, 5).map((job) => (
              <div className="authorized-paper-item" key={job.id}>
                <div><strong>{state.sources.find((source) => source.id === job.source_id)?.name ?? 'Source'} · {job.status}</strong><p>{job.discovered_count} new link(s){job.failure_reason ? ` · ${job.failure_reason}` : ''}</p></div>
                <time dateTime={job.created_at}>{new Date(job.created_at).toLocaleString()}</time>
              </div>
            ))}</div>}
            {state.items.length ? <div className="authorized-paper-list">{state.items.map((item) => {
              const source = state.sources.find((candidate) => candidate.id === item.source_id);
              return <article className="authorized-paper-item" key={item.id}>
                <div>
                  <strong>{item.title}</strong>
                  <p><a href={item.canonical_url} target="_blank" rel="noreferrer">{item.canonical_url} <ExternalLink size={12} /></a></p>
                  <small>{source?.name ?? 'Source'} · Metadata: {item.review_status} · Pipeline: {item.pipeline_status}{item.failure_reason ? ` · ${item.failure_reason}` : ''}</small>
                </div>
                {isAcademicLead && item.review_status === 'pending' && <div className="test-form-actions">
                  <button className="button button-quiet" disabled={saving} onClick={() => void reviewItem(item, 'approved')}>Approve metadata</button>
                  <button className="button button-quiet" disabled={saving} onClick={() => void reviewItem(item, 'rejected')}>Reject</button>
                </div>}
                {isAcademicLead && item.pipeline_status !== 'DISCOVERED'
                  && item.pipeline_status !== 'PERMISSION_BLOCKED' && item.pipeline_status !== 'DUPLICATE'
                  && <button className="button button-quiet" disabled={saving} onClick={() => void previewDocument(item.id)}>Preview private PDF</button>}
              </article>;
            })}</div> : <p>Run a permitted discovery job to add metadata links for review.</p>}
          </section>

          {selectedSource?.question_extraction_allowed && selectedSource.question_reuse_allowed
            && selectedItem?.review_status === 'approved' && <>
          {isAcademicLead && <section className="content-card">
            <div className="section-heading"><div><span className="eyebrow">Verified classification catalogue</span><h2>Manage syllabus topics</h2></div></div>
            <p>Classification only matches a unique administrator-verified phrase within this exact curriculum, subject, syllabus code, and version. Ambiguous or unmatched questions remain in review.</p>
            <form className="test-question-form" onSubmit={(event) => void submitSyllabusTopic(event)}>
              <div className="test-form-grid">
                <label>Curriculum<select value={syllabusForm.curriculum} onChange={(event) => setSyllabusForm((current) => ({ ...current, curriculum: event.target.value }))}>{['Cambridge Primary', 'Cambridge Lower Secondary', 'O Level', 'IGCSE', 'AS Level', 'A Level'].map((value) => <option key={value}>{value}</option>)}</select></label>
                <label>Subject<input required maxLength={160} value={syllabusForm.subjectName} onChange={(event) => setSyllabusForm((current) => ({ ...current, subjectName: event.target.value }))} /></label>
                <label>Syllabus code<input required maxLength={40} value={syllabusForm.syllabusCode} onChange={(event) => setSyllabusForm((current) => ({ ...current, syllabusCode: event.target.value }))} /></label>
                <label>Syllabus version<input required maxLength={80} value={syllabusForm.syllabusVersion} onChange={(event) => setSyllabusForm((current) => ({ ...current, syllabusVersion: event.target.value }))} /></label>
                <label>Topic<input required maxLength={200} value={syllabusForm.topic} onChange={(event) => setSyllabusForm((current) => ({ ...current, topic: event.target.value }))} /></label>
                <label>Subtopic<input maxLength={200} value={syllabusForm.subtopic} onChange={(event) => setSyllabusForm((current) => ({ ...current, subtopic: event.target.value }))} /></label>
                <label className="span-2">Verified syllabus source URL<input required type="url" value={syllabusForm.sourceUrl} onChange={(event) => setSyllabusForm((current) => ({ ...current, sourceUrl: event.target.value }))} /></label>
                <label className="span-2">Approved exact phrases (one per line)<textarea value={syllabusForm.approvedPhrases} onChange={(event) => setSyllabusForm((current) => ({ ...current, approvedPhrases: event.target.value }))} /></label>
              </div>
              <button className="button button-primary" disabled={saving}><Plus size={14} /> {editingSyllabusTopicId ? 'Update verified topic' : 'Save verified topic'}</button>
            </form>
            {state.syllabusTopics.length > 0 && <div className="authorized-paper-list">{state.syllabusTopics.map((topic) => (
              <article className="authorized-paper-item" key={topic.id}>
                <div><strong>{topic.curriculum} · {topic.subject_name} · {topic.syllabus_code} ({topic.syllabus_version})</strong><p>{topic.topic}{topic.subtopic ? ` · ${topic.subtopic}` : ''}</p><small>{topic.approved_phrases.join(' · ') || 'No automatic matching phrases'} · <a href={topic.source_url} target="_blank" rel="noreferrer">Verification source <ExternalLink size={10} /></a></small></div>
                <button className="button button-quiet" onClick={() => {
                  setEditingSyllabusTopicId(topic.id);
                  setSyllabusForm({
                    curriculum: topic.curriculum,
                    subjectName: topic.subject_name,
                    syllabusCode: topic.syllabus_code,
                    syllabusVersion: topic.syllabus_version,
                    topic: topic.topic,
                    subtopic: topic.subtopic,
                    approvedPhrases: topic.approved_phrases.join('\n'),
                    sourceUrl: topic.source_url,
                  });
                }}>Edit</button>
              </article>
            ))}</div>}
          </section>}

          <section className="content-card">
            <div className="section-heading"><div><span className="eyebrow">Manual extraction</span><h2>Submit a question for review</h2></div></div>
            <form className="test-question-form" onSubmit={(event) => void submitQuestion(event)}>
              <label>Approved source paper<select required value={selectedItemId} onChange={(event) => setSelectedItemId(event.target.value)}>{state.items.filter((item) => item.review_status === 'approved' && state.sources.some((source) => source.id === item.source_id && source.question_extraction_allowed && source.question_reuse_allowed)).map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label>
              <div className="test-form-grid">
                <label className="span-2">Question text<textarea required minLength={10} maxLength={12000} value={questionForm.questionText} onChange={(event) => setQuestionForm((current) => ({ ...current, questionText: event.target.value }))} /></label>
                <label>Topic<input required maxLength={160} value={questionForm.topic} onChange={(event) => setQuestionForm((current) => ({ ...current, topic: event.target.value }))} /></label>
                <label>Subtopic<input maxLength={160} value={questionForm.subtopic} onChange={(event) => setQuestionForm((current) => ({ ...current, subtopic: event.target.value }))} /></label>
                <label>Syllabus code<input maxLength={40} value={questionForm.syllabusCode} onChange={(event) => setQuestionForm((current) => ({ ...current, syllabusCode: event.target.value }))} /></label>
                <label>Marks<input required type="number" min="0.01" max="1000" step="0.01" value={questionForm.marks} onChange={(event) => setQuestionForm((current) => ({ ...current, marks: event.target.value }))} /></label>
                <label>Difficulty<select value={questionForm.difficulty} onChange={(event) => setQuestionForm((current) => ({ ...current, difficulty: event.target.value }))}><option>Foundation</option><option>Standard</option><option>Challenging</option></select></label>
                <label className="span-2">Answer / mark scheme<textarea maxLength={12000} value={questionForm.markScheme} onChange={(event) => setQuestionForm((current) => ({ ...current, markScheme: event.target.value }))} /></label>
              </div>
              <p>Questions are not published or added to school tests until a school academic lead reviews them.</p>
              <div className="test-form-actions"><button className="button button-primary" disabled={saving}><Plus size={14} /> Submit for review</button></div>
            </form>
          </section></>}
          {!eligibleItems.length && <section className="content-card">
            <p>To submit a question, an academic lead must first approve a discovered paper from a source that permits question extraction and assessment reuse. Once approved, select that paper in the form above to link the question to it.</p>
          </section>}

          <section className="content-card">
            <div className="section-heading"><div><span className="eyebrow">Question review</span><h2>School catalogue candidates</h2></div><span className="test-count">{state.questions.length}</span></div>
            {state.questions.length ? <div className="question-library-list">{state.questions.map((question) => (
              <article className="library-question" key={question.id}>
                <div className="library-question-main">
                  <div className="library-question-meta"><span>{question.topic ?? 'Topic needs review'}{question.subtopic ? `, ${question.subtopic}` : ''}</span><span>{question.marks ?? 'Marks n/a'}</span><span>{question.validation_status}, {question.content_use_status}</span><span>{question.question_number ?? 'Question number n/a'}, pages {question.page_start ?? '?'} to {question.page_end ?? '?'}</span></div>
                  <p>{question.question_text}</p>
                  <small>Curriculum: {question.curriculum ?? 'Missing'}, subject: {question.subject_name ?? 'Missing'}, syllabus: {question.syllabus_code}, year: {question.examination_year ?? 'n/a'}, session: {question.examination_session ?? 'n/a'}, paper: {question.paper_number ?? 'n/a'}, variant: {question.variant ?? 'n/a'}</small>
                  {question.validation_reasons.length > 0 && <small>Validation: {question.validation_reasons.join('; ')}</small>}
                  {question.document_id && <small>Extraction: {question.extraction_status}, classification: {question.classification_status}</small>}
                  {question.mark_scheme && <small>Mark scheme: {question.mark_scheme}</small>}
                  {question.reviewer_note && <small>Review note: {question.reviewer_note}</small>}
                </div>
                {isAcademicLead && (question.review_status === 'pending'
                  || (question.validation_status === 'APPROVED' && question.content_use_status !== 'ELIGIBLE'
                    && state.sources.some((source) => source.id === question.source_id && source.question_reuse_allowed))) && <div className="test-form-actions">
                  <details>
                    <summary className="button button-quiet">Correct and review</summary>
                    <form className="test-question-form" onSubmit={(event) => {
                      event.preventDefault();
                      const fields = new FormData(event.currentTarget);
                      const yearValue = String(fields.get('examinationYear') ?? '');
                      void reviewQuestion(question, 'approved', {
                        questionText: fields.get('questionText'),
                        topic: fields.get('topic'),
                        subtopic: fields.get('subtopic'),
                        questionSyllabusCode: fields.get('questionSyllabusCode'),
                        marks: fields.get('marks'),
                        curriculum: fields.get('curriculum'),
                        subjectName: fields.get('subjectName'),
                        syllabusCode: fields.get('syllabusCode'),
                        syllabusVersion: fields.get('syllabusVersion'),
                        examinationYear: yearValue ? Number(yearValue) : null,
                        examinationSession: fields.get('examinationSession'),
                        paperNumber: fields.get('paperNumber'),
                        variant: fields.get('variant'),
                      }, String(fields.get('syllabusTopicId') ?? ''), fields.get('contentUseEligible') === 'on');
                    }}>
                      <label>Question text<textarea name="questionText" required minLength={10} maxLength={12000} defaultValue={question.question_text} /></label>
                      <div className="test-form-grid">
                        <label>Topic<input name="topic" maxLength={160} defaultValue={question.topic ?? ''} /></label>
                        <label>Subtopic<input name="subtopic" maxLength={160} defaultValue={question.subtopic ?? ''} /></label>
                        <label>Question syllabus code<input name="questionSyllabusCode" maxLength={40} defaultValue={question.syllabus_code} /></label>
                        <label>Marks<input name="marks" type="number" min="0.01" max="1000" step="0.01" defaultValue={question.marks ?? ''} /></label>
                        <label>Curriculum<select name="curriculum" defaultValue={question.curriculum ?? ''}><option value="">Missing</option>{['Cambridge Primary', 'Cambridge Lower Secondary', 'O Level', 'IGCSE', 'AS Level', 'A Level'].map((value) => <option key={value}>{value}</option>)}</select></label>
                        <label>Subject<input name="subjectName" defaultValue={question.subject_name ?? ''} /></label>
                        <label>Syllabus code<input name="syllabusCode" defaultValue={question.syllabus_code ?? ''} /></label>
                        <label>Syllabus version<input name="syllabusVersion" defaultValue={question.syllabus_version ?? ''} /></label>
                        <label>Year<input name="examinationYear" type="number" min="1900" max="2200" defaultValue={question.examination_year ?? ''} /></label>
                        <label>Session<select name="examinationSession" defaultValue={question.examination_session ?? ''}><option value="">Missing</option><option value="m">March</option><option value="s">June</option><option value="w">November</option></select></label>
                        <label>Paper number<input name="paperNumber" defaultValue={question.paper_number ?? ''} /></label>
                        <label>Variant<input name="variant" defaultValue={question.variant ?? ''} /></label>
                        <label className="span-2">Verified syllabus topic<select name="syllabusTopicId" defaultValue={question.syllabus_topic_id ?? ''}><option value="">Needs review / no verified match</option>{state.syllabusTopics.map((topic) => <option value={topic.id} key={topic.id}>{topic.curriculum} · {topic.subject_name} · {topic.syllabus_code} · {topic.topic}{topic.subtopic ? ` / ${topic.subtopic}` : ''}</option>)}</select></label>
                      </div>
                      <label className="draft-recovery-check"><input type="checkbox" name="contentUseEligible" />I separately verified that this content may be reused in school assessments.</label>
                      <button className="button button-primary" disabled={saving}>{question.validation_status === 'APPROVED' ? 'Update content-use review' : 'Approve validation'}</button>
                    </form>
                  </details>
                  <button className="button button-quiet" disabled={saving} onClick={() => void reviewQuestion(question, 'rejected')}>Reject</button>
                </div>}
              </article>
            ))}</div> : <p>There are no question candidates to review.</p>}
          </section>
          {isAcademicLead && state.restrictedQuestions.length > 0 && <section className="content-card">
            <div className="section-heading"><div><span className="eyebrow">Rights status</span><h2>Questions no longer eligible for reuse</h2></div><span className="test-count">{state.restrictedQuestions.length}</span></div>
            <p>These questions are hidden from normal catalogue search. Removing one deletes its restricted catalogue content; imported copies and their saved-test rendering are also removed if present.</p>
            <div className="question-library-list">{state.restrictedQuestions.map((question) => (
              <article className="library-question" key={question.id}>
                <div className="library-question-main">
                  <div className="library-question-meta"><span>{question.registered_source_name}</span><span>{question.source_status}</span><span>{question.catalogue_review_status}</span></div>
                  <p>{question.question_text}</p>
                  <small>{question.source_name}</small>
                </div>
                <button className="button button-quiet" disabled={saving} onClick={() => void removeRestrictedQuestion(question)}>Remove restricted copy</button>
              </article>
            ))}</div>
          </section>}
          <p className="import-hint">Only approved and currently licensed questions appear in Test Maker’s catalogue search. Imports create school-scoped question records and retain their catalogue provenance.</p>
        </>
      )}
      {!user && <ErrorState message="Sign in to manage school paper sources." />}
    </div>
  );
}
