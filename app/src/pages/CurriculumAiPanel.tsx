import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { KeyRound, LoaderCircle, Plus, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';
import { EmptyState, ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { useAuth } from '../contexts/AuthContext';
import { requireSupabase } from '../lib/supabase';

type Provider = 'openai-compatible' | 'google-gemini' | 'anthropic';
type Scope = 'personal' | 'school';
type Configuration = {
  id: string;
  scope: Scope;
  provider: Provider;
  endpointId: string;
  model: string;
  updatedAt: string;
};
type ApprovedDocument = { id: string; title: string; status: string };
type GeneratedObjective = {
  id: string;
  objective_text: string;
  measurable_outcomes: string[];
  suggested_activities: string[];
  assessment_evidence: string[];
};
type GenerationResponse = {
  objectives: GeneratedObjective[];
  generationMode: 'ai' | 'deterministic';
  fallbackReason: string;
};

const providerLabels: Record<Provider, string> = {
  'openai-compatible': 'OpenAI-compatible',
  'google-gemini': 'Google Gemini',
  anthropic: 'Anthropic',
};
const endpointOptions = [
  ['openai', 'OpenAI'],
  ['openrouter', 'OpenRouter'],
  ['groq', 'Groq'],
  ['together', 'Together AI'],
  ['deepseek', 'DeepSeek'],
  ['mistral', 'Mistral'],
  ['fireworks', 'Fireworks AI'],
  ['cerebras', 'Cerebras'],
];
const defaultModels: Record<Provider, string> = {
  'openai-compatible': 'gpt-4o-mini',
  'google-gemini': 'gemini-2.0-flash',
  anthropic: 'claude-3-5-haiku-latest',
};

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function CurriculumAiPanel({ schoolId, canManageSchoolKeys }: { schoolId: string; canManageSchoolKeys: boolean }) {
  const { user } = useAuth();
  const [configurations, setConfigurations] = useState<Configuration[]>([]);
  const [documents, setDocuments] = useState<ApprovedDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [scope, setScope] = useState<Scope>('personal');
  const [provider, setProvider] = useState<Provider>('openai-compatible');
  const [endpointId, setEndpointId] = useState('openai');
  const [model, setModel] = useState(defaultModels['openai-compatible']);
  const [apiKey, setApiKey] = useState('');
  const [generationProvider, setGenerationProvider] = useState<Provider | ''>('');
  const [generationScope, setGenerationScope] = useState<Scope>('personal');
  const [documentId, setDocumentId] = useState('');
  const [generated, setGenerated] = useState<GeneratedObjective[]>([]);
  const [generationMode, setGenerationMode] = useState<'ai' | 'deterministic'>('deterministic');
  const [fallbackReason, setFallbackReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [configurationResult, documentResult] = await Promise.all([
        client.functions.invoke('curriculum-ai', { body: { action: 'list-configurations', schoolId } }),
        client.from('curriculum_documents')
          .select('id,title,status')
          .eq('school_id', schoolId)
          .in('status', ['approved', 'source_deleted'])
          .order('title'),
      ]);
      if (configurationResult.error) throw configurationResult.error;
      if (documentResult.error) throw documentResult.error;
      if (!Array.isArray(configurationResult.data?.configurations)) {
        throw new Error('The AI settings service returned an invalid configuration list.');
      }
      setConfigurations(configurationResult.data.configurations as Configuration[]);
      setDocuments((documentResult.data ?? []) as ApprovedDocument[]);
    } catch (loadError) {
      setError(messageOf(loadError, 'Could not load curriculum AI settings.'));
    } finally {
      setLoading(false);
    }
  }, [schoolId]);

  useEffect(() => { void load(); }, [load]);

  async function saveConfiguration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: saveError } = await requireSupabase().functions.invoke('curriculum-ai', {
        body: { action: 'save-configuration', schoolId, scope, provider, endpointId, model, apiKey },
      });
      if (saveError) throw saveError;
      setApiKey('');
      setNotice(`${providerLabels[provider]} key saved encrypted. The key is not available to the browser or other staff.`);
      await load();
    } catch (saveError) {
      setError(messageOf(saveError, 'Could not save this provider key.'));
    } finally {
      setSaving(false);
    }
  }

  async function removeConfiguration(configuration: Configuration) {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: deleteError } = await requireSupabase().functions.invoke('curriculum-ai', {
        body: { action: 'delete-configuration', schoolId, configurationId: configuration.id },
      });
      if (deleteError) throw deleteError;
      setNotice(`${providerLabels[configuration.provider]} ${configuration.scope} key removed.`);
      await load();
    } catch (deleteError) {
      setError(messageOf(deleteError, 'Could not remove this provider key.'));
    } finally {
      setSaving(false);
    }
  }

  async function generateDrafts() {
    if (!documentId) {
      setError('Choose an approved curriculum document.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    setGenerated([]);
    try {
      const { data, error: generateError } = await requireSupabase().functions.invoke('curriculum-ai', {
        body: {
          action: 'generate-objectives',
          schoolId,
          documentId,
          provider: generationProvider || undefined,
          scope: generationScope,
        },
      });
      if (generateError) throw generateError;
      if (!Array.isArray(data?.objectives)) throw new Error('The generation service returned an invalid draft.');
      const result = data as GenerationResponse;
      setGenerated(result.objectives);
      setGenerationMode(result.generationMode === 'ai' ? 'ai' : 'deterministic');
      setFallbackReason(typeof result.fallbackReason === 'string' ? result.fallbackReason : '');
      if (result.generationMode === 'ai') {
        setNotice(`Generated ${result.objectives.length} editable drafts with ${generationProvider ? providerLabels[generationProvider] : 'AI'}. Nothing has been published.`);
      } else {
        setNotice(`Created ${result.objectives.length} deterministic drafts. Nothing has been published.`);
      }
    } catch (generateError) {
      setError(messageOf(generateError, 'Could not generate lesson objective drafts.'));
    } finally {
      setSaving(false);
    }
  }

  async function saveDrafts() {
    if (!user || !generated.length) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const client = requireSupabase();
      const objectiveIds = generated.map((item) => item.id);
      const { data: existing, error: existingError } = await client.from('curriculum_lesson_objectives')
        .select('syllabus_objective_id')
        .eq('school_id', schoolId)
        .in('syllabus_objective_id', objectiveIds);
      if (existingError) throw existingError;
      const existingIds = new Set((existing ?? []).map((item) => item.syllabus_objective_id));
      const rows = generated.filter((item) => !existingIds.has(item.id)).map((item) => ({
        school_id: schoolId,
        syllabus_objective_id: item.id,
        objective_text: item.objective_text.trim(),
        measurable_outcomes: item.measurable_outcomes,
        suggested_activities: item.suggested_activities,
        assessment_evidence: item.assessment_evidence,
        origin: generationMode,
        review_status: 'draft',
        created_by: user.id,
      }));
      if (rows.length) {
        const { error: insertError } = await client.from('curriculum_lesson_objectives').insert(rows);
        if (insertError) throw insertError;
      }
      const preserved = generated.length - rows.length;
      setNotice(`${rows.length} draft objective${rows.length === 1 ? '' : 's'} saved. ${preserved ? `${preserved} existing objective${preserved === 1 ? ' was' : 's were'} left unchanged.` : 'Review and edit them before approval.'}`);
      setGenerated([]);
    } catch (saveError) {
      setError(messageOf(saveError, 'Could not save the lesson objective drafts.'));
    } finally {
      setSaving(false);
    }
  }

  function updateGenerated(id: string, value: string) {
    setGenerated((current) => current.map((item) => item.id === id ? { ...item, objective_text: value } : item));
  }

  const scopedConfigurations = configurations.filter((configuration) => configuration.scope === scope);
  const configuredForSelection = configurations.some((configuration) =>
    configuration.scope === generationScope && configuration.provider === generationProvider,
  );

  return (
    <div className="curriculum-ai-workspace">
      {(error || notice) && <div className="curriculum-feedback">{error && <ErrorState message={error} />}{notice && <SuccessMessage message={notice} />}</div>}
      <section className="content-card curriculum-ai-card">
        <div className="section-heading">
          <div><span className="eyebrow">Bring your own key</span><h2>AI provider keys</h2></div>
          <KeyRound size={19} aria-hidden="true" />
        </div>
        <p className="curriculum-section-intro">Keys are encrypted by the server and never displayed again. Only approved curriculum text is sent to the selected provider; student information is not sent.</p>
        {loading ? <LoadingState /> : <>
          <div className="curriculum-ai-scope-switch" role="group" aria-label="Key scope">
            <button type="button" className={scope === 'personal' ? 'active' : ''} onClick={() => setScope('personal')}>My personal keys</button>
            {canManageSchoolKeys && <button type="button" className={scope === 'school' ? 'active' : ''} onClick={() => setScope('school')}>School keys</button>}
          </div>
          <div className="curriculum-ai-key-list">
            {scopedConfigurations.length
              ? scopedConfigurations.map((configuration) => (
                <article className="curriculum-ai-key-row" key={configuration.id}>
                  <span className="curriculum-ai-key-icon"><ShieldCheck size={17} /></span>
                  <span><strong>{providerLabels[configuration.provider]}</strong><small>{configuration.model}{configuration.provider === 'openai-compatible' ? ` · ${endpointOptions.find(([id]) => id === configuration.endpointId)?.[1] ?? configuration.endpointId}` : ''} · Updated {new Date(configuration.updatedAt).toLocaleDateString()}</small></span>
                  <button type="button" className="button button-quiet" aria-label={`Remove ${providerLabels[configuration.provider]} key`} disabled={saving} onClick={() => void removeConfiguration(configuration)}><Trash2 size={15} /> Remove</button>
                </article>
              ))
              : <EmptyState title={`No ${scope} AI keys configured`} detail="Generation remains available in deterministic mode without a provider key." />}
          </div>
          <form className="curriculum-ai-key-form" onSubmit={(event) => void saveConfiguration(event)}>
            <div className="curriculum-ai-form-grid">
              <label className="field"><span>Provider</span>
                <select value={provider} onChange={(event) => {
                  const nextProvider = event.target.value as Provider;
                  setProvider(nextProvider);
                  setModel(defaultModels[nextProvider]);
                }}>
                  {Object.entries(providerLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
              </label>
              {provider === 'openai-compatible' && <label className="field"><span>Compatible API</span>
                <select value={endpointId} onChange={(event) => setEndpointId(event.target.value)}>
                  {endpointOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
              </label>}
              <label className="field"><span>Model identifier</span><input value={model} onChange={(event) => setModel(event.target.value)} maxLength={120} required /></label>
              <label className="field"><span>API key</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} minLength={16} maxLength={4096} autoComplete="new-password" required placeholder="Paste your provider key" /></label>
            </div>
            <button className="button button-primary" type="submit" disabled={saving || !apiKey.trim()}>{saving ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />} Save encrypted key</button>
          </form>
        </>}
      </section>

      <section className="content-card curriculum-ai-card">
        <div className="section-heading">
          <div><span className="eyebrow">Draft generation</span><h2>Generate lesson objectives</h2></div>
          <Sparkles size={19} aria-hidden="true" />
        </div>
        <p className="curriculum-section-intro">Start with approved syllabus objectives. Generation creates editable drafts only; it does not approve or publish them.</p>
        <div className="curriculum-ai-form-grid">
          <label className="field"><span>Approved curriculum</span>
            <select value={documentId} onChange={(event) => setDocumentId(event.target.value)}>
              <option value="">Choose a document</option>
              {documents.map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}
            </select>
          </label>
          <label className="field"><span>Generation mode</span>
            <select value={generationProvider} onChange={(event) => setGenerationProvider(event.target.value as Provider | '')}>
              <option value="">Deterministic (no AI key)</option>
              {Object.entries(providerLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          {generationProvider && <label className="field"><span>Key scope</span>
            <select value={generationScope} onChange={(event) => setGenerationScope(event.target.value as Scope)}>
              <option value="personal">My personal key</option>
              <option value="school">School key (managed by an administrator)</option>
            </select>
          </label>}
        </div>
        {generationProvider && !configuredForSelection && <p className="curriculum-ai-fallback-note">No matching key is configured. This request will use deterministic generation instead.</p>}
        {fallbackReason && <p className="curriculum-ai-fallback-note">{fallbackReason}</p>}
        <button type="button" className="button button-primary" disabled={saving || loading || !documents.length} onClick={() => void generateDrafts()}>
          {saving ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />} Generate editable drafts
        </button>
        {documents.length === 0 && !loading && <EmptyState title="No approved curriculum yet" detail="Approve curriculum and its objectives before generating lesson drafts." />}
        {generated.length > 0 && <div className="curriculum-generated-objectives">
          <div className="curriculum-generated-heading"><strong>{generated.length} {generationMode === 'ai' ? 'AI' : 'deterministic'} drafts</strong><span>Not published</span></div>
          {generated.map((item, index) => <label className="field" key={item.id}>
            <span>Draft {index + 1}</span>
            <textarea rows={3} value={item.objective_text} onChange={(event) => updateGenerated(item.id, event.target.value)} maxLength={2000} />
            {item.measurable_outcomes.length > 0 && <small>Suggested outcomes: {item.measurable_outcomes.join(' · ')}</small>}
          </label>)}
          <button type="button" className="button button-secondary" disabled={saving} onClick={() => void saveDrafts()}>
            {saving ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />} Save drafts
          </button>
        </div>}
      </section>
    </div>
  );
}
