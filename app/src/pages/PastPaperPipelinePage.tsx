import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Check, ExternalLink, FileSearch, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { ErrorState, LoadingState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type Source = {
  id: string;
  name: string;
  listing_url: string;
  terms_url: string;
  rights_basis: string;
  metadata_discovery_allowed: boolean;
  question_extraction_allowed: boolean;
  question_reuse_allowed: boolean;
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
};
type SourceForm = {
  name: string;
  listingUrl: string;
  termsUrl: string;
  rightsBasis: string;
  metadataDiscoveryAllowed: boolean;
  questionExtractionAllowed: boolean;
  questionReuseAllowed: boolean;
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

const EMPTY_STATE: PipelineState = { sources: [], jobs: [], items: [], questions: [], restrictedQuestions: [] };
const EMPTY_SOURCE: SourceForm = {
  name: '',
  listingUrl: '',
  termsUrl: '',
  rightsBasis: '',
  metadataDiscoveryAllowed: true,
  questionExtractionAllowed: false,
  questionReuseAllowed: false,
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

  const request = useCallback(async <T,>(action: string, values: Record<string, unknown> = {}) => {
    if (!schoolId) throw new Error('Choose a school before using the past-paper pipeline.');
    const { data, error: invokeError } = await requireSupabase().functions.invoke('past-paper-pipeline', {
      body: { action, schoolId, ...values },
    });
    if (invokeError) throw invokeError;
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
      await request('register-source', sourceForm);
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
      setNotice(`Discovery finished: ${result.discoveredCount} new metadata link(s). Correlation ID: ${result.correlationId}`);
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

  async function reviewQuestion(question: CatalogueQuestion, decision: 'approved' | 'rejected') {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await request('review-question', { questionId: question.id, decision });
      setNotice(decision === 'approved' ? 'Question approved for the school question catalogue.' : 'Question rejected.');
      await load();
    } catch (reviewError) {
      setError(messageOf(reviewError, 'Could not review this question.'));
    } finally {
      setSaving(false);
    }
  }

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

      <section className="content-card">
        <div className="section-heading">
          <div><span className="eyebrow">Rights-first workflow</span><h2>Source and content safeguards</h2></div>
          <ShieldCheck size={20} />
        </div>
        <p>Only configured HTTPS hosts are contacted. Discovery checks robots.txt, reads one listing page, and stores matching links and titles only; it never downloads PDFs. Question text is entered for human review only when this school has recorded permission to extract and reuse it.</p>
        <p>Public availability does not grant copying rights. Do not register a source until its terms and permission basis have been checked.</p>
      </section>

      {error && <ErrorState message={error} />}
      {notice && <div className="feedback feedback-success" role="status"><Check size={15} />{notice}</div>}
      {loading ? <LoadingState label="Loading source and review records…" /> : (
        <>
          {isAcademicLead && <section className="content-card">
            <div className="section-heading"><div><span className="eyebrow">School-scoped source</span><h2>Register an authorized listing</h2></div></div>
            <form className="test-question-form" onSubmit={(event) => void submitSource(event)}>
              <div className="test-form-grid">
                <label>Source name<input required maxLength={120} value={sourceForm.name} onChange={(event) => setSourceForm((current) => ({ ...current, name: event.target.value }))} placeholder="Publisher or licensed collection" /></label>
                <label>Listing URL<input required type="url" value={sourceForm.listingUrl} onChange={(event) => setSourceForm((current) => ({ ...current, listingUrl: event.target.value }))} placeholder="https://approved-host.example/papers" /></label>
                <label>Terms / permission URL<input required type="url" value={sourceForm.termsUrl} onChange={(event) => setSourceForm((current) => ({ ...current, termsUrl: event.target.value }))} placeholder="https://approved-host.example/terms" /></label>
                <label className="span-2">Documented rights basis<textarea required minLength={8} maxLength={2000} value={sourceForm.rightsBasis} onChange={(event) => setSourceForm((current) => ({ ...current, rightsBasis: event.target.value }))} placeholder="Identify the license, written permission, or other basis and scope." /></label>
              </div>
              <label className="draft-recovery-check"><input type="checkbox" checked={sourceForm.metadataDiscoveryAllowed} onChange={(event) => setSourceForm((current) => ({ ...current, metadataDiscoveryAllowed: event.target.checked }))} />The source terms and robots policy permit metadata discovery.</label>
              <label className="draft-recovery-check"><input type="checkbox" checked={sourceForm.questionExtractionAllowed} onChange={(event) => setSourceForm((current) => ({ ...current, questionExtractionAllowed: event.target.checked, questionReuseAllowed: event.target.checked ? current.questionReuseAllowed : false }))} />The recorded rights permit extracting question content.</label>
              <label className="draft-recovery-check"><input type="checkbox" checked={sourceForm.questionReuseAllowed} disabled={!sourceForm.questionExtractionAllowed} onChange={(event) => setSourceForm((current) => ({ ...current, questionReuseAllowed: event.target.checked }))} />The recorded rights permit storing and reusing question content in school assessments.</label>
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
                  <small>{source.metadata_discovery_allowed ? 'Metadata discovery enabled' : 'Metadata discovery disabled'} · {source.question_extraction_allowed && source.question_reuse_allowed ? 'Question extraction and reuse permitted' : 'Question content disabled'} · {source.status}</small>
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
                  <small>{source?.name ?? 'Source'} · {item.review_status}</small>
                </div>
                {isAcademicLead && item.review_status === 'pending' && <div className="test-form-actions">
                  <button className="button button-quiet" disabled={saving} onClick={() => void reviewItem(item, 'approved')}>Approve metadata</button>
                  <button className="button button-quiet" disabled={saving} onClick={() => void reviewItem(item, 'rejected')}>Reject</button>
                </div>}
              </article>;
            })}</div> : <p>Run a permitted discovery job to add metadata links for review.</p>}
          </section>

          {selectedSource?.question_extraction_allowed && selectedSource.question_reuse_allowed && selectedItem?.review_status === 'approved' && <section className="content-card">
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
          </section>}
          {!selectedItemId && <section className="content-card">
            <p>Select an approved metadata item above to submit authorized question content for review.</p>
          </section>}

          <section className="content-card">
            <div className="section-heading"><div><span className="eyebrow">Question review</span><h2>School catalogue candidates</h2></div><span className="test-count">{state.questions.length}</span></div>
            {state.questions.length ? <div className="question-library-list">{state.questions.map((question) => (
              <article className="library-question" key={question.id}>
                <div className="library-question-main">
                  <div className="library-question-meta"><span>{question.topic}{question.subtopic ? ` · ${question.subtopic}` : ''}</span><span>{question.marks} marks</span><span>{question.difficulty}</span><span>{question.review_status}</span></div>
                  <p>{question.question_text}</p>
                  {question.mark_scheme && <small>Mark scheme: {question.mark_scheme}</small>}
                  {question.reviewer_note && <small>Review note: {question.reviewer_note}</small>}
                </div>
                {isAcademicLead && question.review_status === 'pending' && <div className="test-form-actions">
                  <button className="button button-quiet" disabled={saving} onClick={() => void reviewQuestion(question, 'approved')}>Approve for Test Maker</button>
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
