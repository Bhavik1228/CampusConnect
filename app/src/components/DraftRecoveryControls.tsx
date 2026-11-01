import { useState } from 'react';
import { AlertTriangle, Check, Clock3, Cloud, History, Laptop, RotateCcw, Save, X } from 'lucide-react';
import type {
  DraftSaveState,
  DraftVersion,
  RecoverableDraftEntity,
} from '../lib/recoverable-drafts';

const stateLabels: Record<DraftSaveState, string> = {
  loading: 'Checking saved drafts…',
  saved: 'Saved and synced',
  saved_local: 'Saved on this device · syncing…',
  saving: 'Saving draft…',
  offline: 'Saved on this device · will sync when online',
  conflict: 'Draft conflict needs review',
  error: 'Could not sync draft · saved copy may remain on this device',
};

const entityLabels: Record<RecoverableDraftEntity, string> = {
  assessment: 'test',
  lesson_plan: 'lesson plan',
  report_comment: 'report comments',
  website_content: 'website draft',
};

function previewFields(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [['Draft', String(value ?? '')]];
  return Object.entries(value as Record<string, unknown>).map(([key, fieldValue]) => {
    const text = typeof fieldValue === 'string'
      ? fieldValue
      : JSON.stringify(fieldValue);
    return [key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' '), (text ?? '').slice(0, 180)] as [string, string];
  });
}

export function DraftRecoveryControls<T>({
  entity,
  draft,
  onRestore,
}: {
  entity: RecoverableDraftEntity;
  draft: {
    state: DraftSaveState;
    candidate: { source: 'device' | 'server' | 'version'; payload: T; updatedAt: string; versionId?: string } | null;
    conflict: { local: { payload: T }; server: { payload: T }; fields: string[] } | null;
    versions: DraftVersion<T>[];
    restorePreviewOpen: boolean;
    setRestorePreviewOpen: (open: boolean) => void;
    versionHistoryOpen: boolean;
    setVersionHistoryOpen: (open: boolean) => void;
    loadVersions: () => Promise<void>;
    acceptRestore: (restore: (value: T) => void, value?: T) => void;
    resolveConflict: (choice: 'use-device' | 'use-server', restore: (value: T) => void) => Promise<void>;
    restoreVersion: (version: DraftVersion<T>, restore: (value: T) => void) => void;
    keepCurrentForm: () => void;
  };
  onRestore: (value: T) => void;
}) {
  const [historyError, setHistoryError] = useState('');
  const candidate = draft.candidate;

  async function toggleHistory() {
    const opening = !draft.versionHistoryOpen;
    draft.setVersionHistoryOpen(opening);
    setHistoryError('');
    if (!opening) return;
    try {
      await draft.loadVersions();
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Could not load draft history.');
    }
  }

  function restoreCandidate(value = candidate?.payload) {
    if (value === undefined) return;
    draft.acceptRestore(onRestore, value);
    draft.setRestorePreviewOpen(false);
  }

  return <section className={`draft-recovery-controls draft-state-${draft.state}`} aria-live="polite">
    <div className="draft-recovery-status">
      {draft.state === 'offline' ? <Laptop size={15} /> : draft.state === 'conflict' ? <AlertTriangle size={15} /> : draft.state === 'saved' ? <Check size={15} /> : draft.state === 'saving' ? <Cloud size={15} /> : <Save size={15} />}
      <span>{stateLabels[draft.state]}</span>
      <span className="draft-recovery-correlation">Recovery is private to your account and school.</span>
    </div>
    <div className="draft-recovery-actions">
      {candidate && !draft.conflict && <button className="button button-quiet" type="button" onClick={() => draft.setRestorePreviewOpen(true)}>
        <RotateCcw size={14} />Review saved {entityLabels[entity]}
      </button>}
      {candidate && !draft.conflict && <button className="button button-quiet" type="button" onClick={draft.keepCurrentForm}>
        <X size={14} />Keep current form
      </button>}
      <button className="button button-quiet" type="button" onClick={() => void toggleHistory()}>
        <History size={14} />{draft.versionHistoryOpen ? 'Hide version history' : 'Version history'}
      </button>
    </div>
    {candidate && !draft.conflict && <p className="draft-recovery-choice-note">Choose the saved copy or keep the current form before autosave continues.</p>}
    {draft.conflict && <div className="draft-conflict-panel" role="alert">
      <strong><AlertTriangle size={15} />Another session has a newer server copy.</strong>
      <p>These fields changed in both copies: {draft.conflict.fields.join(', ') || 'Draft content'}. Choose which version to use; neither copy is overwritten until you decide.</p>
      <div className="draft-recovery-actions">
        <button className="button button-quiet" type="button" onClick={() => void draft.resolveConflict('use-server', onRestore)}>Use server copy</button>
        <button className="button button-primary" type="button" onClick={() => void draft.resolveConflict('use-device', onRestore)}>Keep this device copy</button>
      </div>
    </div>}
    {draft.versionHistoryOpen && <div className="draft-version-history">
      <strong>Version history</strong>
      {historyError && <p className="form-error" role="alert">{historyError}</p>}
      {!historyError && !draft.versions.length && <p>No synced versions yet.</p>}
      {draft.versions.map((version) => <div className="draft-version-row" key={version.id}>
        <span><Clock3 size={13} />{new Date(version.created_at).toLocaleString()}</span>
        <button className="button button-quiet" type="button" onClick={() => {
          draft.restoreVersion(version, onRestore);
          draft.setRestorePreviewOpen(true);
        }}>Preview &amp; restore</button>
      </div>)}
    </div>}
    {draft.restorePreviewOpen && candidate && <div className="modal-backdrop draft-recovery-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) draft.setRestorePreviewOpen(false);
    }}>
      <section className="modal-card draft-restore-dialog" role="dialog" aria-modal="true" aria-labelledby="draft-restore-title">
        <div className="modal-heading"><div><span className="eyebrow">{candidate.source === 'device' ? 'This device' : candidate.source === 'version' ? 'Version history' : 'Synced draft'}</span><h2 id="draft-restore-title">Preview saved {entityLabels[entity]}</h2></div>
          <button type="button" className="icon-button" onClick={() => draft.setRestorePreviewOpen(false)} aria-label="Close preview"><X size={18} /></button></div>
        <p>This draft was last saved {new Date(candidate.updatedAt).toLocaleString()}. Restoring replaces the current form fields only after confirmation.</p>
        <dl className="draft-restore-preview">{previewFields(candidate.payload).map(([field, value]) => <div key={field}><dt>{field}</dt><dd>{value || '—'}</dd></div>)}</dl>
        <div className="modal-actions"><button type="button" className="button button-quiet" onClick={draft.keepCurrentForm}>Keep current form</button>
          <button type="button" className="button button-primary" onClick={() => restoreCandidate()}><RotateCcw size={14} />Restore draft</button></div>
      </section>
    </div>}
  </section>;
}
