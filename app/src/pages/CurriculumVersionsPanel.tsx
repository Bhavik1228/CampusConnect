import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, LoaderCircle } from 'lucide-react';
import { EmptyState, ErrorState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type DocumentVersion = {
  id: string;
  title: string;
  subject_id: string;
  syllabus_code: string;
  curriculum_type: string;
  status: string;
  created_at: string;
};
type Objective = { id: string; section_number: string; original_text: string; corrected_text: string; objective_type: string };
type Difference = { kind: 'added' | 'removed' | 'changed'; before?: Objective; after?: Objective };

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'Could not compare curriculum versions.';
}

function normalizedText(text: string) {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function compareObjectives(before: Objective[], after: Objective[]): Difference[] {
  const unmatchedBefore = new Set(before.map((item) => item.id));
  const unmatchedAfter = new Set(after.map((item) => item.id));
  const differences: Difference[] = [];
  const afterByText = new Map<string, Objective[]>();
  for (const item of after) {
    const key = normalizedText(item.corrected_text || item.original_text);
    afterByText.set(key, [...(afterByText.get(key) ?? []), item]);
  }
  for (const item of before) {
    const key = normalizedText(item.corrected_text || item.original_text);
    const match = afterByText.get(key)?.find((candidate) => unmatchedAfter.has(candidate.id));
    if (match) {
      unmatchedBefore.delete(item.id);
      unmatchedAfter.delete(match.id);
    }
  }
  const sectionKeys = new Set([
    ...before.filter((item) => unmatchedBefore.has(item.id)).map((item) => item.section_number.trim()),
    ...after.filter((item) => unmatchedAfter.has(item.id)).map((item) => item.section_number.trim()),
  ].filter(Boolean));
  for (const section of sectionKeys) {
    const oldItems = before.filter((item) => unmatchedBefore.has(item.id) && item.section_number.trim() === section);
    const newItems = after.filter((item) => unmatchedAfter.has(item.id) && item.section_number.trim() === section);
    const paired = Math.min(oldItems.length, newItems.length);
    for (let index = 0; index < paired; index += 1) {
      differences.push({ kind: 'changed', before: oldItems[index], after: newItems[index] });
      unmatchedBefore.delete(oldItems[index].id);
      unmatchedAfter.delete(newItems[index].id);
    }
  }
  differences.push(...before.filter((item) => unmatchedBefore.has(item.id)).map((item) => ({ kind: 'removed' as const, before: item })));
  differences.push(...after.filter((item) => unmatchedAfter.has(item.id)).map((item) => ({ kind: 'added' as const, after: item })));
  return differences;
}

export function CurriculumVersionsPanel({ schoolId, subjects }: { schoolId: string; subjects: Array<{ id: string; name: string }> }) {
  const [documents, setDocuments] = useState<DocumentVersion[]>([]);
  const [olderId, setOlderId] = useState('');
  const [newerId, setNewerId] = useState('');
  const [differences, setDifferences] = useState<Difference[]>([]);
  const [loading, setLoading] = useState(true);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState('');
  const [hasCompared, setHasCompared] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data, error: queryError } = await requireSupabase().from('curriculum_documents')
        .select('id,title,subject_id,syllabus_code,curriculum_type,status,created_at')
        .eq('school_id', schoolId)
        .in('status', ['approved', 'source_deleted'])
        .order('created_at', { ascending: false });
      if (queryError) throw queryError;
      const approved = (data ?? []) as DocumentVersion[];
      setDocuments(approved);
      setOlderId(approved.length > 1 ? approved[1].id : '');
      setNewerId(approved.length > 0 ? approved[0].id : '');
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      setLoading(false);
    }
  }, [schoolId]);

  useEffect(() => { void load(); }, [load]);

  const selectedOlder = documents.find((document) => document.id === olderId);
  const newerOptions = useMemo(() => selectedOlder
    ? documents.filter((document) => document.subject_id === selectedOlder.subject_id && document.id !== selectedOlder.id)
    : [], [documents, selectedOlder]);

  async function compare() {
    if (!selectedOlder || !newerId) return;
    const selectedNewer = documents.find((document) => document.id === newerId);
    if (!selectedNewer || selectedNewer.subject_id !== selectedOlder.subject_id) {
      setError('Choose two approved curriculum documents for the same subject.');
      return;
    }
    setComparing(true);
    setError('');
    setHasCompared(false);
    try {
      const { data, error: objectiveError } = await requireSupabase().from('curriculum_objectives')
        .select('id,document_id,section_number,original_text,corrected_text,objective_type')
        .eq('school_id', schoolId)
        .in('document_id', [selectedOlder.id, selectedNewer.id])
        .eq('review_status', 'approved')
        .order('sort_order');
      if (objectiveError) throw objectiveError;
      const objectives = (data ?? []) as (Objective & { document_id: string })[];
      setDifferences(compareObjectives(
        objectives.filter((item) => item.document_id === selectedOlder.id),
        objectives.filter((item) => item.document_id === selectedNewer.id),
      ));
      setHasCompared(true);
    } catch (compareError) {
      setError(messageOf(compareError));
    } finally {
      setComparing(false);
    }
  }

  function changeOlder(value: string) {
    setOlderId(value);
    const older = documents.find((document) => document.id === value);
    const next = documents.find((document) => document.id !== value && document.subject_id === older?.subject_id);
    setNewerId(next?.id ?? '');
    setHasCompared(false);
  }

  return (
    <div className="curriculum-version-layout">
      <section className="content-card">
        <div className="section-heading"><div><span className="eyebrow">History stays intact</span><h2>Compare curriculum versions</h2></div><ArrowLeftRight size={19} /></div>
        <p className="curriculum-section-intro">Compare reviewed objectives from two approved documents in the same subject. Comparisons are read-only and never change teaching or assessment links.</p>
        {error && <ErrorState message={error} />}
        {loading ? <LoaderCircle size={20} className="spin" /> : documents.length < 2
          ? <EmptyState title="Two approved versions are needed" detail="Approve a newer curriculum document for a subject to compare wording changes." />
          : <div className="curriculum-version-controls">
            <label className="field"><span>Older curriculum</span>
              <select value={olderId} onChange={(event) => changeOlder(event.target.value)}>
                {documents.map((document) => <option key={document.id} value={document.id}>{document.title} · {subjects.find((subject) => subject.id === document.subject_id)?.name ?? 'Subject'} · {new Date(document.created_at).toLocaleDateString()}</option>)}
              </select>
            </label>
            <label className="field"><span>Newer curriculum</span>
              <select value={newerId} onChange={(event) => { setNewerId(event.target.value); setHasCompared(false); }}>
                {newerOptions.map((document) => <option key={document.id} value={document.id}>{document.title} · {new Date(document.created_at).toLocaleDateString()}</option>)}
              </select>
            </label>
            <button type="button" className="button button-primary" disabled={comparing || !olderId || !newerId} onClick={() => void compare()}>
              {comparing ? <LoaderCircle size={16} className="spin" /> : <ArrowLeftRight size={16} />} Compare objectives
            </button>
          </div>}
      </section>
      {hasCompared && <section className="content-card curriculum-version-results">
        <div className="section-heading"><div><span className="eyebrow">Approved wording</span><h2>{differences.length} changes found</h2></div></div>
        {differences.length === 0
          ? <EmptyState title="No objective changes" detail="The approved objective wording matches between these documents." />
          : differences.map((difference, index) => <article className={`curriculum-version-difference curriculum-version-${difference.kind}`} key={`${difference.kind}-${difference.before?.id ?? difference.after?.id ?? index}`}>
            <span className="curriculum-version-badge">{difference.kind}</span>
            {difference.before && <div><small>Previous{difference.before.section_number ? ` · ${difference.before.section_number}` : ''}</small><p>{difference.before.corrected_text || difference.before.original_text}</p></div>}
            {difference.after && <div><small>Current{difference.after.section_number ? ` · ${difference.after.section_number}` : ''}</small><p>{difference.after.corrected_text || difference.after.original_text}</p></div>}
          </article>)}
      </section>}
    </div>
  );
}
