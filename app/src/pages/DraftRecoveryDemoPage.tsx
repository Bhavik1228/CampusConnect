import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Clock3, Eye, RotateCcw, Save } from 'lucide-react';
import { Link } from 'react-router-dom';

type DemoKind = 'assessment' | 'lesson' | 'report' | 'website';
type DemoDraft = Record<string, string>;
type DemoVersion = { id: string; createdAt: string; payload: DemoDraft };

const examples: Record<DemoKind, { label: string; fields: DemoDraft }> = {
  assessment: {
    label: 'Test builder',
    fields: {
      title: 'Cell structure and function (Demo)',
      subject: 'Biology',
      topic: 'Cell organelles',
      instructions: 'Answer every question. Use diagrams where they help explain your reasoning.',
    },
  },
  lesson: {
    label: 'Lesson planner',
    fields: {
      title: 'Comparing plant and animal cells (Demo)',
      description: 'Learners compare prepared diagrams and identify shared structures.',
      objectives: 'Identify the nucleus, membrane and cytoplasm; explain two differences between plant and animal cells.',
    },
  },
  report: {
    label: 'Report comment',
    fields: {
      student: 'Amara Ndlovu (Fictional student)',
      marks: '18',
      comment: 'Amara explains scientific ideas clearly and is developing confidence when interpreting unfamiliar data.',
    },
  },
  website: {
    label: 'Website editor',
    fields: {
      headline: 'Learning with curiosity (Demo)',
      welcome: 'A welcoming fictional school community where every learner can grow.',
      about: 'Greenfield Academy (Demo) brings learners, families and teachers together.',
    },
  },
};

function clone(value: DemoDraft): DemoDraft {
  return { ...value };
}

function fieldLabel(value: string) {
  return value.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase());
}

export function DraftRecoveryDemoPage() {
  const [kind, setKind] = useState<DemoKind>('assessment');
  const [form, setForm] = useState<DemoDraft>(() => clone(examples.assessment.fields));
  const [drafts, setDrafts] = useState<Partial<Record<DemoKind, DemoDraft>>>({});
  const [history, setHistory] = useState<Record<DemoKind, DemoVersion[]>>({
    assessment: [], lesson: [], report: [], website: [],
  });
  const [saveState, setSaveState] = useState<'saved' | 'saving'>('saved');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const pauseNextSave = useRef(false);

  useEffect(() => {
    if (pauseNextSave.current) {
      pauseNextSave.current = false;
      setSaveState('saved');
      return;
    }
    setSaveState('saving');
    const timer = window.setTimeout(() => {
      setDrafts((current) => ({ ...current, [kind]: clone(form) }));
      setHistory((current) => {
        const versions = current[kind];
        if (versions[0] && JSON.stringify(versions[0].payload) === JSON.stringify(form)) return current;
        return {
          ...current,
          [kind]: [{ id: crypto.randomUUID(), createdAt: new Date().toISOString(), payload: clone(form) }, ...versions].slice(0, 5),
        };
      });
      setSaveState('saved');
    }, 650);
    return () => window.clearTimeout(timer);
  }, [form, kind]);

  function changeKind(next: DemoKind) {
    setDrafts((current) => ({ ...current, [kind]: clone(form) }));
    setHistory((current) => {
      const versions = current[kind];
      if (versions[0] && JSON.stringify(versions[0].payload) === JSON.stringify(form)) return current;
      return {
        ...current,
        [kind]: [{ id: crypto.randomUUID(), createdAt: new Date().toISOString(), payload: clone(form) }, ...versions].slice(0, 5),
      };
    });
    setKind(next);
    setForm(clone(drafts[next] ?? examples[next].fields));
    setPreviewOpen(false);
    setHistoryOpen(false);
  }

  function simulateInterruption() {
    pauseNextSave.current = true;
    setForm(Object.fromEntries(Object.keys(examples[kind].fields).map((field) => [field, ''])));
    setPreviewOpen(false);
  }

  function restore(value: DemoDraft) {
    setForm(clone(value));
    setPreviewOpen(false);
  }

  const savedDraft = drafts[kind];

  return <div className="page-stack">
    <div className="page-heading">
      <div>
        <span className="eyebrow">Signed-in app shell · fictional data only</span>
        <h1>Draft recovery demo</h1>
        <p>Explore autosave, recovery previews and version history for the four MVP builders.</p>
      </div>
      <Link className="button button-quiet" to="/dashboard"><ArrowLeft size={15} />Back to dashboard</Link>
    </div>

    <div className="prerequisite-demo-banner" role="note">
      <strong>Concept demo — fictional Greenfield Academy data only.</strong>
      <span>No Supabase calls or production records. Demo drafts live only in this page's memory.</span>
    </div>

    <section className="content-card draft-demo-card">
      <div className="draft-demo-toolbar">
        <label className="field"><span>Builder</span><select value={kind} onChange={(event) => changeKind(event.target.value as DemoKind)}>
          {(Object.keys(examples) as DemoKind[]).map((key) => <option key={key} value={key}>{examples[key].label}</option>)}
        </select></label>
        <div className={`draft-demo-save ${saveState}`} role="status"><Save size={15} />{saveState === 'saving' ? 'Saving draft…' : 'Saved locally · Demo'}</div>
      </div>

      <div className="draft-demo-fields">
        {Object.entries(form).map(([field, value]) => <label className="field" key={field}>
          <span>{fieldLabel(field)} <small>Fictional demo field</small></span>
          <textarea rows={field === 'comment' || field === 'instructions' || field === 'objectives' || field === 'description' || field === 'about' ? 3 : 2}
            value={value}
            onChange={(event) => setForm((current) => ({ ...current, [field]: event.target.value }))} />
        </label>)}
      </div>

      <div className="draft-demo-actions">
        <button className="button button-quiet" type="button" onClick={simulateInterruption}><RotateCcw size={14} />Simulate interruption</button>
        <button className="button button-quiet" type="button" disabled={!savedDraft} onClick={() => setPreviewOpen(true)}><Eye size={14} />Preview saved draft</button>
        <button className="button button-quiet" type="button" onClick={() => setHistoryOpen((open) => !open)}><Clock3 size={14} />{historyOpen ? 'Hide history' : 'Version history'}</button>
      </div>

      {previewOpen && savedDraft && <section className="draft-demo-preview" aria-label="Saved draft preview">
        <div className="section-heading"><div><span className="eyebrow">Recovery preview</span><h2>Restore {examples[kind].label.toLowerCase()}?</h2></div></div>
        <p>Review the saved fields. Restore only replaces this demo form.</p>
        <dl>{Object.entries(savedDraft).map(([field, value]) => <div key={field}><dt>{fieldLabel(field)}</dt><dd>{value || '—'}</dd></div>)}</dl>
        <div className="draft-demo-actions"><button className="button button-quiet" type="button" onClick={() => setPreviewOpen(false)}>Keep current form</button>
          <button className="button button-primary" type="button" onClick={() => restore(savedDraft)}><RotateCcw size={14} />Restore demo draft</button></div>
      </section>}

      {historyOpen && <section className="draft-demo-history" aria-label="Fictional version history">
        <h2>Version history <small>Demo only</small></h2>
        {!history[kind].length ? <p>Version snapshots appear after autosave.</p> : history[kind].map((version) => <article key={version.id}>
          <span><Clock3 size={13} />{new Date(version.createdAt).toLocaleString()}</span>
          <button className="button button-quiet" type="button" onClick={() => restore(version.payload)}>Preview &amp; restore</button>
        </article>)}
      </section>}
    </section>
  </div>;
}
