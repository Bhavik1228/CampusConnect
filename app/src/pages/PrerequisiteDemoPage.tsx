import { useState } from 'react';
import { ArrowLeft, Check, Plus, RotateCcw, X } from 'lucide-react';
import { Link } from 'react-router-dom';

type DemoEntity = 'class' | 'subject' | 'teacher';
type DemoRecord = { id: string; name: string; entity: DemoEntity; classId?: string; subjectId?: string };
type DemoMode = 'assignment' | 'timetable';
type EmptyExample = 'empty' | 'filtered' | 'permission' | 'loading' | 'failed' | 'duplicate' | 'success' | 'cancelled';

const emptyExamples: Record<EmptyExample, { title: string; detail: string }> = {
  empty: { title: 'Truly empty', detail: 'No active teachers have been added to Greenfield Academy (Demo).' },
  filtered: { title: 'Filtered out', detail: 'Teachers exist, but none teach the selected subject in this class.' },
  permission: { title: 'Permission restricted', detail: 'You do not have permission to create teachers. Contact your School Administrator.' },
  loading: { title: 'Loading', detail: 'Teacher options are loading. No empty-list message is shown yet.' },
  failed: { title: 'Request failed', detail: 'We could not load teachers. Check your connection and retry.' },
  duplicate: { title: 'Possible duplicate', detail: 'A teacher with this name may already exist in this demo school.' },
  success: { title: 'Quick-create succeeded', detail: 'The demo record is selected in the form without a page change.' },
  cancelled: { title: 'Quick-create cancelled', detail: 'Cancel the drawer and the original demo form remains unchanged.' },
};

const labels: Record<DemoEntity, string> = { class: 'Class', subject: 'Subject', teacher: 'Teacher' };

export function PrerequisiteDemoPage() {
  const [mode, setMode] = useState<DemoMode>('assignment');
  const [records, setRecords] = useState<DemoRecord[]>([]);
  const [selectedClassId, setSelectedClassId] = useState('');
  const [selectedSubjectId, setSelectedSubjectId] = useState('');
  const [selectedTeacherId, setSelectedTeacherId] = useState('');
  const [assignmentTitle, setAssignmentTitle] = useState('');
  const [description, setDescription] = useState('');
  const [drawerEntity, setDrawerEntity] = useState<DemoEntity | null>(null);
  const [quickCreateName, setQuickCreateName] = useState('');
  const [duplicateRecords, setDuplicateRecords] = useState<DemoRecord[]>([]);
  const [example, setExample] = useState<EmptyExample>('empty');
  const [message, setMessage] = useState('');

  const classes = records.filter((record) => record.entity === 'class');
  const subjects = records.filter((record) => record.entity === 'subject'
    && (!record.classId || !selectedClassId || record.classId === selectedClassId));
  const teachers = records.filter((record) => record.entity === 'teacher'
    && (!record.classId || record.classId === selectedClassId)
    && (!record.subjectId || record.subjectId === selectedSubjectId));

  function openCreate(entity: DemoEntity) {
    setDrawerEntity(entity);
    setQuickCreateName('');
    setDuplicateRecords([]);
    setMessage('');
  }

  function selectRecord(record: DemoRecord) {
    if (record.entity === 'class') {
      setSelectedClassId(record.id);
      setSelectedSubjectId('');
      setSelectedTeacherId('');
    }
    if (record.entity === 'subject') {
      setSelectedSubjectId(record.id);
      setSelectedTeacherId('');
    }
    if (record.entity === 'teacher') setSelectedTeacherId(record.id);
    setMessage(`Selected ${record.name}. The original demo form is still intact.`);
    setDrawerEntity(null);
    setDuplicateRecords([]);
  }

  function saveDemoRecord(force = false) {
    if (!drawerEntity || !quickCreateName.trim()) return;
    const duplicates = records.filter((record) => record.entity === drawerEntity
    && record.name.replace(/\s+\(Demo\)$/, '').toLocaleLowerCase() === quickCreateName.trim().toLocaleLowerCase());
    if (duplicates.length && !force) {
      setDuplicateRecords(duplicates);
      setExample('duplicate');
      return;
    }

    const record: DemoRecord = {
      id: `${drawerEntity}-${crypto.randomUUID()}`,
      name: `${quickCreateName.trim()} (Demo)`,
      entity: drawerEntity,
      ...(drawerEntity === 'subject' && selectedClassId ? { classId: selectedClassId } : {}),
      ...(drawerEntity === 'teacher' ? {
        classId: selectedClassId || undefined,
        subjectId: selectedSubjectId || undefined,
      } : {}),
    };
    setRecords((current) => [...current, record]);
    if (record.entity === 'class') {
      setSelectedClassId(record.id);
      setSelectedSubjectId('');
      setSelectedTeacherId('');
    }
    if (record.entity === 'subject') {
      setSelectedSubjectId(record.id);
      setSelectedTeacherId('');
    }
    if (record.entity === 'teacher') setSelectedTeacherId(record.id);
    setDrawerEntity(null);
    setDuplicateRecords([]);
    setExample('success');
    setMessage(`${labels[record.entity]} created and selected in this local demo only. No production record was saved.`);
  }

  function resetDemo() {
    setRecords([]);
    setSelectedClassId('');
    setSelectedSubjectId('');
    setSelectedTeacherId('');
    setAssignmentTitle('');
    setDescription('');
    setExample('empty');
    setMessage('Demo reset. The signed-in form is ready to try again.');
  }

  function closeDrawer() {
    setDrawerEntity(null);
    setDuplicateRecords([]);
    setExample('cancelled');
    setMessage('Quick-create cancelled. The original form values remain unchanged.');
  }

  return <div className="page-stack">
    <div className="page-heading">
      <div>
        <span className="eyebrow">Signed-in app shell · fictional data only</span>
        <h1>Prerequisite quick-create demo</h1>
        <p>Try the assignment and timetable flows without writing anything to the school database.</p>
      </div>
      <div className="timetable-heading-actions">
        <Link className="button button-quiet" to="/assignments"><ArrowLeft size={15} />Back to assignments</Link>
        <button className="button button-quiet" type="button" onClick={resetDemo}><RotateCcw size={15} />Reset demo</button>
      </div>
    </div>

    <div className="prerequisite-demo-banner" role="note">
      <strong>Concept demo — no production records are created.</strong>
      <span>Greenfield Academy (Demo) · School Administrator (Demo)</span>
    </div>

    <div className="prerequisite-demo-layout">
      <section className="content-card prerequisite-demo-form">
        <div className="settings-subheading">
          <h2>{mode === 'assignment' ? 'Create assignment' : 'Add timetable lesson'}</h2>
          <p>Open an empty field's quick-create drawer and watch its new demo record become selected.</p>
        </div>
        <div className="form-row">
          <label className="field"><span>Workflow</span><select value={mode} onChange={(event) => setMode(event.target.value as DemoMode)}><option value="assignment">Assignment</option><option value="timetable">Timetable</option></select></label>
          <label className="field"><span>Empty-state example</span><select value={example} onChange={(event) => setExample(event.target.value as EmptyExample)}>{Object.entries(emptyExamples).map(([key, item]) => <option key={key} value={key}>{item.title}</option>)}</select></label>
        </div>
        {mode === 'assignment' ? <>
          <label className="field"><span>Assignment title</span><input value={assignmentTitle} onChange={(event) => setAssignmentTitle(event.target.value)} placeholder="e.g. Fractions practice (Demo)" /></label>
          <label className="field"><span>Instructions</span><textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Your unsaved form text remains here while the drawer is open." /></label>
        </> : <div className="form-row">
          <label className="field"><span>Day</span><select defaultValue="Monday"><option>Monday</option><option>Tuesday</option><option>Wednesday</option></select></label>
          <label className="field"><span>Start time</span><input type="time" defaultValue="08:00" /></label>
        </div>}

        <DemoPrerequisiteField entity="class" records={classes} selectedId={selectedClassId} example={example} onSelect={(id) => { setSelectedClassId(id); setSelectedSubjectId(''); setSelectedTeacherId(''); }} onCreate={() => openCreate('class')} onRetry={() => setExample('empty')} />
        <DemoPrerequisiteField entity="subject" records={subjects} selectedId={selectedSubjectId} example={example} onSelect={(id) => { setSelectedSubjectId(id); setSelectedTeacherId(''); }} onCreate={() => openCreate('subject')} onRetry={() => setExample('empty')} />
        <DemoPrerequisiteField entity="teacher" records={teachers} selectedId={selectedTeacherId} example={example} onSelect={setSelectedTeacherId} onCreate={() => openCreate('teacher')} onRetry={() => setExample('empty')} />

        {message && <p className="inline-success" role="status">{message}</p>}
        <div className="prerequisite-demo-records"><strong>Local demo records</strong>
          {records.length ? <ul>{records.map((record) => <li key={record.id}>{labels[record.entity]}: {record.name}</li>)}</ul> : <p>No demo records yet.</p>}
        </div>
        <button className="button button-primary" type="button" onClick={() => setMessage('Ready to submit (demo). No Supabase request will be made.')} disabled={!selectedClassId || !selectedSubjectId || (mode === 'assignment' && !selectedTeacherId)}>
          <Check size={15} />Ready to submit (demo only)
        </button>
      </section>

      <aside className="content-card prerequisite-demo-examples">
        <h2>State examples</h2>
        <p>Use the selector to preview the kinds of explanations the live fields provide.</p>
        {Object.entries(emptyExamples).map(([key, item]) => <button type="button" key={key} className={example === key ? 'prerequisite-demo-example is-selected' : 'prerequisite-demo-example'} onClick={() => setExample(key as EmptyExample)}>
          <strong>{item.title}</strong><span>{item.detail}</span>
        </button>)}
      </aside>
    </div>

    {drawerEntity && <div className="prerequisite-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDrawer(); }}>
      <section className="prerequisite-drawer" role="dialog" aria-modal="true" aria-labelledby="demo-drawer-title">
        <div className="modal-heading"><div><span className="eyebrow">Greenfield Academy (Demo)</span><h2 id="demo-drawer-title">Create {labels[drawerEntity].toLocaleLowerCase()} (Demo)</h2></div>
          <button type="button" className="icon-button" onClick={closeDrawer} aria-label="Close demo drawer"><X size={18} /></button></div>
        <p className="prerequisite-drawer-context">This temporary demo record will be selected in the form. It will not be sent to Supabase.</p>
        <form className="modal-form" onSubmit={(event) => { event.preventDefault(); saveDemoRecord(); }}>
          <label className="field"><span>{drawerEntity === 'teacher' ? 'Full name' : `${labels[drawerEntity]} name`} <b aria-hidden="true">*</b></span><input required maxLength={100} value={quickCreateName} onChange={(event) => setQuickCreateName(event.target.value)} placeholder={`e.g. ${drawerEntity === 'class' ? 'Grade 7 Blue' : drawerEntity === 'subject' ? 'Mathematics' : 'Amina Yusuf'} (Demo)`} autoFocus /></label>
          {duplicateRecords.length > 0 && <div className="prerequisite-duplicate" role="alert">
            <strong>A possible duplicate was found</strong>
            {duplicateRecords.map((record) => <div className="prerequisite-duplicate-row" key={record.id}><span>{record.name}</span><button className="button button-quiet" type="button" onClick={() => selectRecord(record)}>Select existing</button></div>)}
            <button type="button" className="button button-quiet" onClick={() => saveDemoRecord(true)}>Create another demo record</button>
          </div>}
          <div className="modal-actions"><button type="button" className="button button-quiet" onClick={closeDrawer}>Cancel</button>{!duplicateRecords.length && <button className="button button-primary" type="submit"><Plus size={15} />Save demo record</button>}</div>
        </form>
      </section>
    </div>}
  </div>;
}

function DemoPrerequisiteField({
  entity,
  records,
  selectedId,
  example,
  onSelect,
  onCreate,
  onRetry,
}: {
  entity: DemoEntity;
  records: DemoRecord[];
  selectedId: string;
  example: EmptyExample;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRetry: () => void;
}) {
  const hasExample = ['empty', 'filtered', 'permission', 'loading', 'failed', 'duplicate', 'cancelled'].includes(example);
  const isEmpty = hasExample;
  return <div className="prerequisite-demo-field">
    <label className="field"><span>{labels[entity]}</span><select value={selectedId} onChange={(event) => onSelect(event.target.value)}><option value="">Choose {labels[entity].toLocaleLowerCase()}</option>{records.map((record) => <option key={record.id} value={record.id}>{record.name}</option>)}</select></label>
    {isEmpty && <div className="prerequisite-field-notice">
      <strong>{emptyExamples[example].title}</strong><p>{emptyExamples[example].detail}</p>
      {example === 'loading' ? <span role="status">Loading {labels[entity].toLocaleLowerCase()} options…</span>
        : example === 'failed' ? <button className="button button-quiet" type="button" onClick={onRetry}>Try again (demo)</button>
          : example === 'permission' ? <small>Creation is hidden when you do not have permission.</small>
            : <button className="button button-quiet" type="button" onClick={onCreate}><Plus size={14} />Create {labels[entity].toLocaleLowerCase()}</button>}
    </div>}
  </div>;
}
