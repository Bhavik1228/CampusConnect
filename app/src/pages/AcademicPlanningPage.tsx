import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarRange, Check, Save, Trash2, Users } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type AcademicYear = { id: string; name: string; start_date: string; end_date: string; calendar_id: string; is_current: boolean };
type SchoolClass = { id: string; name: string; grade_level: string | null; grade_level_id: string | null; capacity: number | null; academic_year_id: string | null };
type Subject = { id: string; name: string; code: string | null };
type Combination = {
  id: string; name: string; grade_level: string | null; academic_year_id: string | null;
  selection_rule: 'all_required' | 'choose_one' | 'choose_many'; minimum_selections: number;
  maximum_selections: number | null;
};
type CombinationOption = { combination_id: string; subject_id: string; is_required: boolean };
type Student = { id: string; student_number: string; first_name: string; last_name: string; class_id: string };
type Issue = { type: string; class_id?: string; message: string };
type RolloverPreview = {
  source_year_id: string; calendar_id: string; name: string; start_date: string; end_date: string;
  classes_to_copy: number; terms_to_copy: number; students_to_promote: number;
  conflicts: Issue[]; notes: string[];
};

export function AcademicPlanningPage() {
  const { activeMembership } = useAuth();
  const schoolId = activeMembership?.school_id;
  const canManage = activeMembership?.role === 'school_admin' || activeMembership?.role === 'academic_coordinator';
  const [years, setYears] = useState<AcademicYear[]>([]);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [combinations, setCombinations] = useState<Combination[]>([]);
  const [options, setOptions] = useState<CombinationOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [conflictYear, setConflictYear] = useState('');
  const [conflicts, setConflicts] = useState<Issue[]>([]);
  const [conflictsLoading, setConflictsLoading] = useState(false);

  const [combinationId, setCombinationId] = useState('');
  const [combinationName, setCombinationName] = useState('');
  const [combinationYear, setCombinationYear] = useState('');
  const [combinationGrade, setCombinationGrade] = useState('');
  const [selectionRule, setSelectionRule] = useState<Combination['selection_rule']>('choose_one');
  const [minimumSelections, setMinimumSelections] = useState(1);
  const [maximumSelections, setMaximumSelections] = useState(1);
  const [selectedOptions, setSelectedOptions] = useState<Record<string, boolean>>({});

  const [sourceYear, setSourceYear] = useState('');
  const [nextName, setNextName] = useState('');
  const [nextStart, setNextStart] = useState('');
  const [nextEnd, setNextEnd] = useState('');
  const [rolloverPreview, setRolloverPreview] = useState<RolloverPreview | null>(null);
  const [createdYearId, setCreatedYearId] = useState('');

  const [promotionSource, setPromotionSource] = useState('');
  const [promotionTarget, setPromotionTarget] = useState('');
  const [roster, setRoster] = useState<Student[]>([]);
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [allocationPreview, setAllocationPreview] = useState<{ student_count: number; conflicts: Issue[] } | null>(null);
  const [rosterLoading, setRosterLoading] = useState(false);

  const load = useCallback(async () => {
    if (!schoolId) return;
    if (!canManage) {
      setError('Only school administrators and academic coordinators can manage academic planning.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [yearResult, classResult, subjectResult, combinationResult, optionResult] = await Promise.all([
        client.from('academic_years')
          .select('id,name,start_date,end_date,calendar_id,is_current').eq('school_id', schoolId)
          .order('start_date', { ascending: false }),
        client.from('school_classes')
          .select('id,name,grade_level,grade_level_id,capacity,academic_year_id').eq('school_id', schoolId).order('name'),
        client.from('subjects').select('id,name,code').eq('school_id', schoolId).order('name'),
        client.from('academic_subject_combinations')
          .select('id,name,grade_level,academic_year_id,selection_rule,minimum_selections,maximum_selections')
          .eq('school_id', schoolId).order('name'),
        client.from('academic_subject_combination_options')
          .select('combination_id,subject_id,is_required').eq('school_id', schoolId),
      ]);
      for (const result of [yearResult, classResult, subjectResult, combinationResult, optionResult]) {
        if (result.error) throw result.error;
      }
      const loadedYears = (yearResult.data ?? []) as AcademicYear[];
      setYears(loadedYears);
      setClasses((classResult.data ?? []) as SchoolClass[]);
      setSubjects((subjectResult.data ?? []) as Subject[]);
      setCombinations((combinationResult.data ?? []) as Combination[]);
      setOptions((optionResult.data ?? []) as CombinationOption[]);
      setSourceYear((current) => current || loadedYears.find((year) => year.is_current)?.id || loadedYears[0]?.id || '');
      setConflictYear((current) => current || loadedYears.find((year) => year.is_current)?.id || loadedYears[0]?.id || '');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load academic planning data.');
    } finally {
      setLoading(false);
    }
  }, [canManage, schoolId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const targetClasses = useMemo(
    () => classes.filter((item) => item.academic_year_id === promotionTarget),
    [classes, promotionTarget],
  );
  const sourceClasses = useMemo(
    () => classes.filter((item) => item.academic_year_id === promotionSource),
    [classes, promotionSource],
  );
  useEffect(() => {
    if (!combinationId) return;
    const existing = combinations.find((item) => item.id === combinationId);
    if (!existing) return;
    setCombinationName(existing.name);
    setCombinationYear(existing.academic_year_id ?? '');
    setCombinationGrade(existing.grade_level ?? '');
    setSelectionRule(existing.selection_rule);
    setMinimumSelections(existing.minimum_selections);
    setMaximumSelections(existing.maximum_selections ?? 0);
    setSelectedOptions(Object.fromEntries(options.filter((option) => option.combination_id === existing.id)
      .map((option) => [option.subject_id, option.is_required])));
  }, [combinationId, combinations, options]);

  useEffect(() => {
    setRoster([]);
    setAllocations({});
    setAllocationPreview(null);
    setRosterLoading(false);
    if (!schoolId || !promotionSource || !sourceClasses.length) return;
    let active = true;
    void (async () => {
      setRosterLoading(true);
      setError('');
      try {
        const ids = sourceClasses.map((item) => item.id);
        const all: Student[] = [];
        for (let offset = 0; ; offset += 500) {
          const { data, error: queryError } = await requireSupabase().from('students')
            .select('id,student_number,first_name,last_name,class_id')
            .eq('school_id', schoolId).eq('status', 'active').in('class_id', ids)
            .is('merged_into_student_id', null).order('last_name').range(offset, offset + 499);
          if (queryError) throw queryError;
          const batch = (data ?? []) as Student[];
          all.push(...batch);
          if (batch.length < 500) break;
        }
        if (active) {
          setRoster(all);
          setAllocations(Object.fromEntries(all.map((student) => {
            const oldClass = sourceClasses.find((item) => item.id === student.class_id);
            const matching = targetClasses.find((item) => item.grade_level_id && item.grade_level_id === oldClass?.grade_level_id)
              ?? targetClasses.find((item) => item.name === oldClass?.name);
            return [student.id, matching?.id ?? ''];
          })));
        }
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Could not load students for promotion.');
      } finally {
        if (active) setRosterLoading(false);
      }
    })();
    return () => { active = false; };
  }, [promotionSource, sourceClasses, schoolId, targetClasses]);

  useEffect(() => {
    if (!schoolId) return;
    let active = true;
    setConflictsLoading(true);
    void (async () => {
      try {
        const { data, error: queryError } = await requireSupabase().rpc('get_academic_structure_conflicts', {
          target_school: schoolId,
          target_year: conflictYear || null,
        });
        if (queryError) throw queryError;
        if (active) setConflicts((data ?? []) as Issue[]);
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Could not check academic structure conflicts.');
      } finally {
        if (active) setConflictsLoading(false);
      }
    })();
    return () => { active = false; };
  }, [schoolId, conflictYear, refreshKey]);

  function resetCombination() {
    setCombinationId('');
    setCombinationName('');
    setCombinationYear('');
    setCombinationGrade('');
    setSelectionRule('choose_one');
    setMinimumSelections(1);
    setMaximumSelections(1);
    setSelectedOptions({});
  }

  async function saveCombination() {
    if (!schoolId) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const selectedSubjects = Object.entries(selectedOptions)
        .filter(([subjectId]) => selectedSubjectsSet.has(subjectId))
        .map(([subjectId, isRequired]) => ({ subject_id: subjectId, is_required: isRequired }));
      const { error: saveError } = await requireSupabase().rpc('save_academic_subject_combination', {
        target_school: schoolId,
        target_combination: combinationId || null,
        combination_name: combinationName.trim(),
        target_academic_year: combinationYear || null,
        target_grade_level: combinationGrade.trim() || null,
        target_selection_rule: selectionRule,
        target_minimum: selectionRule === 'choose_one' ? 1 : minimumSelections,
        target_maximum: selectionRule === 'choose_one' ? 1 : maximumSelections || null,
        target_options: selectedSubjects,
      });
      if (saveError) throw saveError;
      setSuccess(`Subject combination ${combinationId ? 'updated' : 'created'}.`);
      resetCombination();
      setRefreshKey((current) => current + 1);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save subject combination.');
    } finally {
      setSaving(false);
    }
  }

  async function deleteCombination(id: string, name: string) {
    if (!schoolId || !window.confirm(`Delete subject combination "${name}"?`)) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: deleteError } = await requireSupabase().rpc('delete_academic_subject_combination', {
        target_school: schoolId,
        target_combination: id,
      });
      if (deleteError) throw deleteError;
      if (combinationId === id) resetCombination();
      setSuccess(`Subject combination "${name}" deleted.`);
      setRefreshKey((current) => current + 1);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Could not delete subject combination.');
    } finally {
      setSaving(false);
    }
  }

  async function simulateRollover() {
    if (!schoolId || !sourceYear) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { data, error: previewError } = await requireSupabase().rpc('simulate_academic_year_rollover', {
        target_school: schoolId, source_year: sourceYear, next_name: nextName.trim(),
        next_start: nextStart, next_end: nextEnd,
      });
      if (previewError) throw previewError;
      const result = data as RolloverPreview;
      setRolloverPreview(result);
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : 'Could not simulate academic-year rollover.');
    } finally {
      setSaving(false);
    }
  }

  async function applyRollover() {
    if (!schoolId || !sourceYear || !rolloverPreview || rolloverPreview.conflicts.length) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { data, error: applyError } = await requireSupabase().rpc('apply_academic_year_rollover', {
        target_school: schoolId, source_year: sourceYear, next_name: nextName.trim(),
        next_start: nextStart, next_end: nextEnd,
      });
      if (applyError) throw applyError;
      const yearId = data as string;
      setCreatedYearId(yearId);
      setPromotionTarget(yearId);
      setSuccess(`Academic year ${nextName.trim()} created with copied classes, subjects, teacher assignments, and term dates. Students were not moved automatically.`);
      setRolloverPreview(null);
      setRefreshKey((current) => current + 1);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : 'Could not apply academic-year rollover.');
    } finally {
      setSaving(false);
    }
  }

  function allocationPayload() {
    return roster.flatMap((student) => allocations[student.id]
      ? [{ student_id: student.id, class_id: allocations[student.id] }]
      : []);
  }

  async function previewAllocations() {
    if (!schoolId || !promotionSource || !promotionTarget) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { data, error: previewError } = await requireSupabase().rpc('preview_student_class_allocations', {
        target_school: schoolId, source_year: promotionSource,
        destination_year: promotionTarget, allocations: allocationPayload(),
      });
      if (previewError) throw previewError;
      setAllocationPreview(data as { student_count: number; conflicts: Issue[] });
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : 'Could not validate student class allocations.');
    } finally {
      setSaving(false);
    }
  }

  async function applyAllocations() {
    if (!schoolId || !promotionSource || !promotionTarget || !allocationPreview || allocationPreview.conflicts.length) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { data, error: applyError } = await requireSupabase().rpc('apply_student_class_allocations', {
        target_school: schoolId, source_year: promotionSource,
        destination_year: promotionTarget, allocations: allocationPayload(),
      });
      if (applyError) throw applyError;
      setSuccess(`${data as number} student class allocations applied.`);
      setAllocationPreview(null);
      setRefreshKey((current) => current + 1);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : 'Could not apply student class allocations.');
    } finally {
      setSaving(false);
    }
  }

  const selectedSubjectsSet = useMemo(() => new Set(Object.keys(selectedOptions)), [selectedOptions]);
  const combinationsGrouped = useMemo(() => combinations.map((item) => ({
    ...item,
    subjects: options.filter((option) => option.combination_id === item.id)
      .map((option) => ({ ...option, subject: subjects.find((subject) => subject.id === option.subject_id) }))
      .filter((option) => option.subject),
  })), [combinations, options, subjects]);

  if (!schoolId) return <div className="page-stack"><ErrorState message="Select a school before opening academic planning." /></div>;
  if (!canManage) return <div className="page-stack"><ErrorState message="Only school administrators and academic coordinators can manage academic planning." /></div>;

  return (
    <div className="page-stack academic-planning-page">
      <div className="page-heading">
        <div><span className="eyebrow">Academic administration</span><h1>Academic planning</h1><p>Plan subject choices, roll academic years forward, allocate students, and review structural conflicts.</p></div>
        <button type="button" className="button button-quiet" onClick={() => setRefreshKey((current) => current + 1)} disabled={loading}><CalendarRange size={15} />Refresh</button>
      </div>
      {error && <ErrorState message={error} />}
      {success && <SuccessMessage message={success} />}
      {loading ? <LoadingState label="Loading academic planning…" /> : <>
        <section className="content-card academic-planning-section">
          <div className="section-heading"><div><span className="eyebrow">Curriculum</span><h2>Subject combinations and optional subjects</h2></div></div>
          <p className="settings-readonly">Define required subjects or student choice groups for a grade and (optionally) a specific academic year.</p>
          <div className="academic-combination-form">
            <label className="field"><span>Combination name</span><input value={combinationName} maxLength={120} onChange={(event) => setCombinationName(event.target.value)} placeholder="e.g. Senior science options" /></label>
            <label className="field"><span>Academic year</span><select value={combinationYear} onChange={(event) => setCombinationYear(event.target.value)}><option value="">All years</option>{years.map((year) => <option key={year.id} value={year.id}>{year.name}</option>)}</select></label>
            <label className="field"><span>Grade level (optional)</span><input value={combinationGrade} maxLength={60} onChange={(event) => setCombinationGrade(event.target.value)} placeholder="e.g. Grade 10" /></label>
            <label className="field"><span>Selection rule</span><select value={selectionRule} onChange={(event) => {
              const rule = event.target.value as Combination['selection_rule'];
              setSelectionRule(rule);
              if (rule === 'choose_one') { setMinimumSelections(1); setMaximumSelections(1); }
            }}><option value="all_required">All listed subjects required</option><option value="choose_one">Choose exactly one</option><option value="choose_many">Choose a number of subjects</option></select></label>
            {selectionRule === 'choose_many' && <div className="academic-selection-limits">
              <label className="field"><span>Minimum choices</span><input type="number" min={0} max={100} step={1} value={minimumSelections} onChange={(event) => setMinimumSelections(Number(event.target.value))} /></label>
              <label className="field"><span>Maximum choices (blank = any)</span><input type="number" min={1} max={100} step={1} value={maximumSelections || ''} onChange={(event) => setMaximumSelections(Number(event.target.value))} /></label>
            </div>}
            <fieldset className="academic-subject-options"><legend>Subjects in this group</legend>
              {subjects.length ? subjects.map((subject) => <div className="academic-subject-option" key={subject.id}>
                <label><input type="checkbox" checked={selectedSubjectsSet.has(subject.id)} onChange={(event) => setSelectedOptions((current) => {
                  const next = { ...current };
                  if (event.target.checked) next[subject.id] = selectionRule === 'all_required';
                  else delete next[subject.id];
                  return next;
                })} /><span>{subject.name}{subject.code ? ` · ${subject.code}` : ''}</span></label>
                {selectedSubjectsSet.has(subject.id) && selectionRule !== 'all_required' && <label className="academic-subject-required"><input type="checkbox" checked={selectedOptions[subject.id]} onChange={(event) => setSelectedOptions((current) => ({ ...current, [subject.id]: event.target.checked }))} />Required</label>}
              </div>) : <p>Add subjects before creating combinations.</p>}
            </fieldset>
            <div className="academic-form-actions">
              <button className="button button-primary" type="button" disabled={saving || combinationName.trim().length < 2 || selectedSubjectsSet.size === 0 || (selectionRule === 'choose_many' && (minimumSelections > selectedSubjectsSet.size || (maximumSelections > 0 && (maximumSelections < minimumSelections || maximumSelections > selectedSubjectsSet.size))))} onClick={() => void saveCombination()}><Save size={14} />{saving ? 'Saving…' : combinationId ? 'Save combination' : 'Create combination'}</button>
              {combinationId && <button className="button button-quiet" type="button" onClick={resetCombination}>Cancel edit</button>}
            </div>
          </div>
          {combinationsGrouped.length > 0 && <div className="academic-combination-list">{combinationsGrouped.map((item) => <article key={item.id}>
            <div><strong>{item.name}</strong><small>{item.grade_level || 'All grades'} · {years.find((year) => year.id === item.academic_year_id)?.name ?? 'All years'} · {item.selection_rule.replace(/_/g, ' ')}</small><small>{item.subjects.map((option) => `${option.subject?.name}${option.is_required ? ' (required)' : ''}`).join(' · ')}</small></div>
            <div className="academic-combination-actions">
              <button className="button button-quiet" type="button" onClick={() => setCombinationId(item.id)}>Edit</button>
              <button className="button button-quiet" type="button" onClick={() => void deleteCombination(item.id, item.name)} disabled={saving} aria-label={`Delete ${item.name}`}><Trash2 size={14} /></button>
            </div>
          </article>)}</div>}
        </section>

        <section className="content-card academic-planning-section">
          <div className="section-heading"><div><span className="eyebrow">Year setup</span><h2>Academic-year rollover</h2></div></div>
          <p className="settings-readonly">Simulate the next year first. Rollover copies classes, subject assignments, teacher assignments, and term dates; it does not move students or mark the year current.</p>
          <div className="academic-rollover-form">
            <label className="field"><span>Copy from</span><select value={sourceYear} onChange={(event) => { setSourceYear(event.target.value); setRolloverPreview(null); }}><option value="">Select source year</option>{years.map((year) => <option key={year.id} value={year.id}>{year.name}{year.is_current ? ' · Current' : ''}</option>)}</select></label>
            <label className="field"><span>New year name</span><input value={nextName} maxLength={100} onChange={(event) => { setNextName(event.target.value); setRolloverPreview(null); }} placeholder="e.g. 2027–2028" /></label>
            <label className="field"><span>Start date</span><input type="date" value={nextStart} onChange={(event) => { setNextStart(event.target.value); setRolloverPreview(null); }} /></label>
            <label className="field"><span>End date</span><input type="date" value={nextEnd} onChange={(event) => { setNextEnd(event.target.value); setRolloverPreview(null); }} /></label>
          </div>
          <button className="button button-secondary" type="button" onClick={() => void simulateRollover()} disabled={saving || !sourceYear || !nextName.trim() || !nextStart || !nextEnd}>Simulate rollover</button>
          {rolloverPreview && <div className="academic-preview-panel">
            <strong>Rollover preview: {rolloverPreview.name}</strong>
            <span>{rolloverPreview.classes_to_copy} classes · {rolloverPreview.terms_to_copy} terms · {rolloverPreview.students_to_promote} students need class allocation</span>
            {rolloverPreview.notes.map((note) => <small key={note}>{note}</small>)}
            {rolloverPreview.conflicts.map((issue, index) => <p className="academic-conflict" key={`${issue.type}-${index}`}><AlertTriangle size={14} />{issue.message}</p>)}
            <button className="button button-primary" type="button" onClick={() => void applyRollover()} disabled={saving || rolloverPreview.conflicts.length > 0}>Apply rollover</button>
          </div>}
        </section>

        <section className="content-card academic-planning-section">
          <div className="section-heading"><div><span className="eyebrow">Promotion</span><h2>Student promotion and class allocation</h2></div></div>
          <p className="settings-readonly">Review or change each active student’s next class. Preview validates student/year membership and destination class capacity before applying any assignments.</p>
          <div className="academic-promotion-filters">
            <label className="field"><span>From academic year</span><select value={promotionSource} onChange={(event) => setPromotionSource(event.target.value)}><option value="">Select source year</option>{years.map((year) => <option key={year.id} value={year.id}>{year.name}</option>)}</select></label>
            <label className="field"><span>To academic year</span><select value={promotionTarget} onChange={(event) => { setPromotionTarget(event.target.value); setAllocationPreview(null); }}><option value="">Select target year</option>{years.map((year) => <option key={year.id} value={year.id}>{year.name}{createdYearId === year.id ? ' · Newly rolled over' : ''}</option>)}</select></label>
          </div>
          {rosterLoading ? <LoadingState label="Loading active students…" /> : promotionSource && promotionTarget ? roster.length ? <>
            <div className="academic-roster-list">{roster.map((student) => <label key={student.id}>
              <span><strong>{student.first_name} {student.last_name}</strong><small>{student.student_number} · currently {sourceClasses.find((item) => item.id === student.class_id)?.name ?? 'unassigned'}</small></span>
              <select aria-label={`Next class for ${student.first_name} ${student.last_name}`} value={allocations[student.id] ?? ''} onChange={(event) => { setAllocations((current) => ({ ...current, [student.id]: event.target.value })); setAllocationPreview(null); }}>
                <option value="">Do not allocate</option>{targetClasses.map((schoolClass) => <option key={schoolClass.id} value={schoolClass.id}>{schoolClass.name}{schoolClass.capacity ? ` · capacity ${schoolClass.capacity}` : ''}</option>)}
              </select>
            </label>)}</div>
            <div className="academic-form-actions">
              <button className="button button-secondary" type="button" onClick={() => void previewAllocations()} disabled={saving || !targetClasses.length}>Preview allocations</button>
              {allocationPreview && <button className="button button-primary" type="button" onClick={() => void applyAllocations()} disabled={saving || allocationPreview.conflicts.length > 0}><Users size={14} />Apply {allocationPreview.student_count} allocations</button>}
            </div>
            {allocationPreview && <div className="academic-preview-panel">
              <strong>{allocationPreview.student_count} student allocations reviewed</strong>
              {allocationPreview.conflicts.length ? allocationPreview.conflicts.map((issue, index) => <p className="academic-conflict" key={`${issue.type}-${index}`}><AlertTriangle size={14} />{issue.message}</p>) : <p className="academic-success"><Check size={14} />No class capacity or allocation conflicts found.</p>}
            </div>}
          </> : <p className="settings-readonly">{sourceClasses.length ? 'No active students are enrolled in classes for the selected year.' : 'The selected source year has no classes to promote from.'}</p> : null}
        </section>

        <section className="content-card academic-planning-section">
          <div className="section-heading"><div><span className="eyebrow">Validation</span><h2>Class capacity and subject allocation conflicts</h2></div></div>
          <label className="field academic-conflict-year"><span>Academic year</span><select value={conflictYear} onChange={(event) => setConflictYear(event.target.value)}><option value="">All years</option>{years.map((year) => <option key={year.id} value={year.id}>{year.name}</option>)}</select></label>
          {conflictsLoading ? <LoadingState label="Checking academic structure…" /> : conflicts.length
            ? <div className="academic-conflict-list">{conflicts.map((issue, index) => <article key={`${issue.type}-${issue.class_id ?? index}`}><AlertTriangle size={15} /><span><strong>{issue.type.replace(/_/g, ' ')}</strong><small>{issue.message}</small></span></article>)}</div>
            : <p className="academic-success"><Check size={14} />No class-capacity or required-subject allocation conflicts found.</p>}
        </section>
      </>}
    </div>
  );
}
