import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Plus, X } from 'lucide-react';
import { ErrorState } from './Feedback';
import { useAuth } from '../contexts/AuthContext';
import {
  createPrerequisiteRecord,
  ensurePrerequisiteEligibility,
  findPrerequisiteDuplicates,
  type CreatePrerequisiteInput,
  type PrerequisiteEntity,
  type PrerequisiteRecord,
} from '../lib/prerequisite-records';
import { requireSupabase } from '../lib/supabase';

type CalendarChoice = { id: string; name: string; division_name: string | null; is_default: boolean };
type YearChoice = { id: string; name: string; calendar_id: string; is_current: boolean };
type DepartmentChoice = { id: string; name: string };

type Props = {
  entity: PrerequisiteEntity;
  open: boolean;
  schoolId: string;
  role: string;
  contextClassId?: string;
  contextSubjectId?: string;
  calendarId?: string;
  academicYearId?: string | null;
  onClose: () => void;
  onCreated: (record: PrerequisiteRecord, selectedExisting: boolean) => void;
};

function canCreate(entity: PrerequisiteEntity, role: string) {
  if (entity === 'teacher') return role === 'school_admin';
  return role === 'school_admin' || role === 'academic_coordinator';
}

export function PrerequisiteQuickCreate({
  entity,
  open,
  schoolId,
  role,
  contextClassId,
  contextSubjectId,
  calendarId,
  academicYearId,
  onClose,
  onCreated,
}: Props) {
  const { activeMembership } = useAuth();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [gradeLevel, setGradeLevel] = useState('');
  const [subjectCode, setSubjectCode] = useState('');
  const [calendarChoices, setCalendarChoices] = useState<CalendarChoice[]>([]);
  const [yearChoices, setYearChoices] = useState<YearChoice[]>([]);
  const [departmentChoices, setDepartmentChoices] = useState<DepartmentChoice[]>([]);
  const [selectedCalendarId, setSelectedCalendarId] = useState(calendarId ?? '');
  const [selectedYearId, setSelectedYearId] = useState(academicYearId ?? '');
  const [departmentId, setDepartmentId] = useState('');
  const [referencesLoading, setReferencesLoading] = useState(false);
  const [referenceError, setReferenceError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [hasEdits, setHasEdits] = useState(false);
  const [duplicates, setDuplicates] = useState<PrerequisiteRecord[]>([]);
  const [pendingInput, setPendingInput] = useState<CreatePrerequisiteInput | null>(null);
  const [duplicateChecked, setDuplicateChecked] = useState(false);
  const savingRef = useRef(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const dirty = hasEdits;

  useEffect(() => {
    if (!open) return;
    setFirstName('');
    setLastName('');
    setEmail('');
    setName('');
    setGradeLevel('');
    setSubjectCode('');
    setSelectedCalendarId(calendarId ?? '');
    setSelectedYearId(academicYearId ?? '');
    setDepartmentId('');
    setError('');
    setHasEdits(false);
    setReferenceError('');
    setDuplicates([]);
    setPendingInput(null);
    setDuplicateChecked(false);
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    window.requestAnimationFrame(() => closeButtonRef.current?.focus());

    if (entity === 'class' || entity === 'subject') {
      let alive = true;
      setReferencesLoading(true);
      void (async () => {
        try {
          const client = requireSupabase();
          if (entity === 'class') {
            const [calendarResult, yearResult] = await Promise.all([
              client.from('academic_calendars').select('id,name,division_name,is_default').eq('school_id', schoolId).order('name'),
              client.from('academic_years').select('id,name,calendar_id,is_current').eq('school_id', schoolId).order('start_date', { ascending: false }),
            ]);
            if (calendarResult.error) throw calendarResult.error;
            if (yearResult.error) throw yearResult.error;
            if (!alive) return;
            const calendars = (calendarResult.data ?? []) as CalendarChoice[];
            const years = (yearResult.data ?? []) as YearChoice[];
            setCalendarChoices(calendars);
            setYearChoices(years);
            setSelectedCalendarId((current) => calendars.some((item) => item.id === current)
              ? current
              : calendars.find((item) => item.is_default)?.id ?? calendars[0]?.id ?? '');
            setSelectedYearId((current) => years.some((item) => item.id === current)
              ? current
              : years.find((item) => item.is_current)?.id ?? '');
          } else {
            const { data, error: departmentError } = await client.from('school_departments')
              .select('id,name').eq('school_id', schoolId).order('name');
            if (departmentError) throw departmentError;
            if (alive) setDepartmentChoices((data ?? []) as DepartmentChoice[]);
          }
        } catch (loadError) {
          if (alive) setReferenceError(loadError instanceof Error ? loadError.message : 'Could not load the required school settings.');
        } finally {
          if (alive) setReferencesLoading(false);
        }
      })();
      return () => { alive = false; };
    }
  }, [open, entity, schoolId, calendarId, academicYearId]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !saving) {
        if (dirty && !window.confirm('Discard the quick-create details? Your original form will remain unchanged.')) return;
        closeDrawer();
      }
      if (event.key === 'Tab') {
        const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]',
        );
        if (!focusable?.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, saving, dirty, onClose]);

  function closeDrawer() {
    onClose();
    window.requestAnimationFrame(() => returnFocusRef.current?.focus());
  }

  function markEdited() {
    setHasEdits(true);
    setDuplicateChecked(false);
    setDuplicates([]);
    setPendingInput(null);
  }

  if (!open) return null;
  if (!canCreate(entity, role)) {
    return <div className="prerequisite-drawer-backdrop" role="presentation">
      <section className="prerequisite-drawer" role="dialog" aria-modal="true" aria-labelledby="prerequisite-drawer-title">
        <div className="modal-heading"><div><span className="eyebrow">School records</span><h2 id="prerequisite-drawer-title">Creation access required</h2></div>
          <button type="button" className="icon-button" onClick={closeDrawer} aria-label="Close"><X size={18} /></button></div>
        <p>You do not have permission to create {entity === 'teacher' ? 'teachers' : `${entity}s`}. Contact your School Administrator.</p>
        <button type="button" className="button button-quiet" onClick={closeDrawer}>Close</button>
      </section>
    </div>;
  }

  const title = entity === 'teacher' ? 'Create teacher' : entity === 'class' ? 'Create class' : 'Create subject';
  const selectionLabel = entity === 'teacher' ? 'teacher' : entity;
  const canSave = entity === 'teacher'
    ? Boolean(firstName.trim() && lastName.trim())
    : entity === 'class'
      ? Boolean(name.trim() && selectedCalendarId)
      : Boolean(name.trim());

  function getInput(): CreatePrerequisiteInput {
    if (entity === 'teacher') {
      return {
        entity,
        schoolId,
        firstName,
        lastName,
        email,
        classId: contextClassId,
        subjectId: contextSubjectId,
      };
    }
    if (entity === 'class') {
      return {
        entity,
        schoolId,
        name,
        gradeLevel,
        calendarId: selectedCalendarId,
        academicYearId: selectedYearId,
      };
    }
    return {
      entity,
      schoolId,
      name,
      code: subjectCode,
      departmentId,
      classId: contextClassId,
    };
  }

  async function save(input = pendingInput ?? getInput(), allowDuplicate = false) {
    if (!input || savingRef.current) return;
    const invalidField = drawerRef.current?.querySelector<HTMLInputElement | HTMLSelectElement>(':invalid');
    if (invalidField) {
      invalidField.reportValidity();
      invalidField.focus();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      if (!duplicateChecked && !allowDuplicate) {
        const found = await findPrerequisiteDuplicates(input);
        setDuplicateChecked(true);
        if (found.length) {
          setDuplicates(found);
          setPendingInput(input);
          return;
        }
      }
      const record = await createPrerequisiteRecord(input);
      onCreated(record, false);
      closeDrawer();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : `Could not create the ${selectionLabel}.`);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function selectExisting(record: PrerequisiteRecord) {
    if (entity === 'teacher' && record.status !== 'active') return;
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      await ensurePrerequisiteEligibility(entity, schoolId, record.id, contextClassId, contextSubjectId);
      onCreated(record, true);
      closeDrawer();
    } catch (selectionError) {
      setError(selectionError instanceof Error ? selectionError.message : `Could not make this ${selectionLabel} eligible.`);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return <div className="prerequisite-drawer-backdrop" role="presentation"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) {
        if (!dirty || window.confirm('Discard the quick-create details? Your original form will remain unchanged.')) closeDrawer();
      }
    }}>
    <section ref={drawerRef} className="prerequisite-drawer" role="dialog" aria-modal="true" aria-labelledby="prerequisite-drawer-title">
      <div className="modal-heading"><div><span className="eyebrow">{activeMembership?.school.name ?? 'School records'}</span><h2 id="prerequisite-drawer-title">{title}</h2></div>
        <button ref={closeButtonRef} type="button" className="icon-button" onClick={() => {
          if (!dirty || window.confirm('Discard the quick-create details? Your original form will remain unchanged.')) closeDrawer();
        }} disabled={saving} aria-label="Close quick-create drawer"><X size={18} /></button></div>
      <p className="prerequisite-drawer-context">Create this {selectionLabel} without leaving the form you were completing.</p>
      {referencesLoading && <p role="status">Loading school settings…</p>}
      {referenceError && <ErrorState message={referenceError} />}
      {entity === 'teacher' && <div className="modal-form">
        <div className="form-row">
          <label className="field"><span>First name <b aria-hidden="true">*</b></span><input autoComplete="given-name" required maxLength={80} value={firstName} onChange={(event) => { setFirstName(event.target.value); markEdited(); }} /></label>
          <label className="field"><span>Last name <b aria-hidden="true">*</b></span><input autoComplete="family-name" required maxLength={80} value={lastName} onChange={(event) => { setLastName(event.target.value); markEdited(); }} /></label>
        </div>
        <label className="field"><span>Email <small>(optional; does not create sign-in access)</small></span><input autoComplete="email" type="email" maxLength={254} value={email} onChange={(event) => { setEmail(event.target.value); markEdited(); }} /></label>
      </div>}
      {entity === 'class' && <div className="modal-form">
        <label className="field"><span>Class name <b aria-hidden="true">*</b></span><input required maxLength={100} value={name} onChange={(event) => { setName(event.target.value); markEdited(); }} placeholder="e.g. Grade 7 Blue" /></label>
        <label className="field"><span>Grade level <small>(optional)</small></span><input maxLength={50} value={gradeLevel} onChange={(event) => { setGradeLevel(event.target.value); markEdited(); }} placeholder="e.g. Grade 7" /></label>
        <label className="field"><span>Academic calendar <b aria-hidden="true">*</b></span><select required value={selectedCalendarId} onChange={(event) => {
          const nextCalendarId = event.target.value;
          setSelectedCalendarId(nextCalendarId);
          setSelectedYearId((current) => yearChoices.some((year) => year.id === current && year.calendar_id === nextCalendarId)
            ? current
            : yearChoices.find((year) => year.calendar_id === nextCalendarId && year.is_current)?.id ?? '');
          markEdited();
        }} disabled={referencesLoading || calendarChoices.length === 0}>
          <option value="">Choose calendar</option>{calendarChoices.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}{calendar.division_name ? ` · ${calendar.division_name}` : calendar.is_default ? ' · Default' : ''}</option>)}
        </select></label>
        <label className="field"><span>Academic year <small>(optional)</small></span><select value={selectedYearId} onChange={(event) => { setSelectedYearId(event.target.value); markEdited(); }} disabled={referencesLoading}>
          <option value="">Not assigned</option>{yearChoices.filter((year) => year.calendar_id === selectedCalendarId).map((year) => <option key={year.id} value={year.id}>{year.name}{year.is_current ? ' · Current' : ''}</option>)}
        </select></label>
        {!referencesLoading && !yearChoices.length && <p className="prerequisite-inline-note">No academic year is configured. You can continue without one, or ask an administrator to configure the school calendar first.</p>}
      </div>}
      {entity === 'subject' && <div className="modal-form">
        <label className="field"><span>Subject name <b aria-hidden="true">*</b></span><input required maxLength={100} value={name} onChange={(event) => { setName(event.target.value); markEdited(); }} placeholder="e.g. Mathematics" /></label>
        <label className="field"><span>Subject code <small>(optional)</small></span><input maxLength={20} value={subjectCode} onChange={(event) => { setSubjectCode(event.target.value); markEdited(); }} /></label>
        {departmentChoices.length > 0 && <label className="field"><span>Department <small>(optional)</small></span><select value={departmentId} onChange={(event) => { setDepartmentId(event.target.value); markEdited(); }}><option value="">No department</option>{departmentChoices.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label>}
        {contextClassId && <p className="prerequisite-inline-note">This subject will be made eligible for the selected class.</p>}
      </div>}
      {duplicates.length > 0 && <div className="prerequisite-duplicate" role="alert">
        <strong><AlertCircle size={16} /> A possible duplicate was found</strong>
        <p>Select an existing record, or continue only if this is genuinely a separate {selectionLabel}.</p>
        {duplicates.map((record) => <div className="prerequisite-duplicate-row" key={record.id}>
          <span>{record.name}{entity === 'teacher' && record.status !== 'active' ? ` · ${record.status}` : ''}</span>
          <button type="button" className="button button-quiet" onClick={() => void selectExisting(record)} disabled={saving || (entity === 'teacher' && record.status !== 'active')}>Select existing</button>
        </div>)}
        <button type="button" className="button button-quiet" onClick={() => { if (pendingInput) void save(pendingInput, true); }} disabled={saving}>
          {saving ? 'Creating…' : `Create another ${selectionLabel}`}
        </button>
      </div>}
      {error && <ErrorState message={error} />}
      <div className="modal-actions">
        <button type="button" className="button button-quiet" onClick={() => {
          if (!dirty || window.confirm('Discard the quick-create details? Your original form will remain unchanged.')) closeDrawer();
        }} disabled={saving}>Cancel</button>
        {!duplicates.length && <button type="button" className="button button-primary" onClick={() => void save()} disabled={saving || !canSave || referencesLoading || Boolean(referenceError) || (entity === 'class' && !calendarChoices.length)}>
          <Plus size={15} />{saving ? 'Saving…' : `Create ${selectionLabel}`}
        </button>}
      </div>
    </section>
  </div>;
}
