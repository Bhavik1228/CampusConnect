import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { createPrerequisiteRecord } from '../lib/prerequisite-records';
import { requireSupabase } from '../lib/supabase';

type StructureTab = 'classes' | 'houses' | 'groups' | 'placements';

interface ClassRow {
  id: string;
  name: string;
  grade_level: string | null;
  calendar_id: string;
  academic_year_id: string | null;
}

interface CalendarRow {
  id: string;
  name: string;
  division_name: string | null;
  is_default: boolean;
}

interface YearRow {
  id: string;
  name: string;
  calendar_id: string;
  is_current: boolean;
}

interface TeacherRow {
  id: string;
  first_name: string;
  last_name: string;
}

interface HouseRow {
  id: string;
  name: string;
  color: string;
  house_lead_teacher_id: string | null;
}

interface RegistrationGroupRow {
  id: string;
  name: string;
  calendar_id: string;
  academic_year_id: string;
  tutor_teacher_id: string | null;
}

interface PlacementRow {
  student_id: string;
  student_number: string;
  first_name: string;
  last_name: string;
  class_id: string | null;
  class_name: string | null;
  house_id: string | null;
  registration_group_id: string | null;
}

const tabs: { id: StructureTab; label: string }[] = [
  { id: 'classes', label: 'Classes' },
  { id: 'houses', label: 'Houses' },
  { id: 'groups', label: 'Registration groups' },
  { id: 'placements', label: 'Student placement' },
];

export function ClassStructurePage() {
  const { activeMembership } = useAuth();
  const schoolId = activeMembership?.school_id;
  const role = activeMembership?.role;
  const canManage = role === 'school_admin' || role === 'academic_coordinator';
  const [tab, setTab] = useState<StructureTab>('classes');
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [calendars, setCalendars] = useState<CalendarRow[]>([]);
  const [years, setYears] = useState<YearRow[]>([]);
  const [teachers, setTeachers] = useState<TeacherRow[]>([]);
  const [houses, setHouses] = useState<HouseRow[]>([]);
  const [groups, setGroups] = useState<RegistrationGroupRow[]>([]);
  const [placements, setPlacements] = useState<PlacementRow[]>([]);
  const [classCalendarId, setClassCalendarId] = useState('');
  const [classYearId, setClassYearId] = useState('');
  const [groupCalendarId, setGroupCalendarId] = useState('');
  const [groupYearId, setGroupYearId] = useState('');
  const [houseName, setHouseName] = useState('');
  const [houseColor, setHouseColor] = useState('#2563EB');
  const [houseLead, setHouseLead] = useState('');
  const [groupName, setGroupName] = useState('');
  const [groupTutor, setGroupTutor] = useState('');
  const [className, setClassName] = useState('');
  const [gradeLevel, setGradeLevel] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingStudentId, setSavingStudentId] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    if (!schoolId) return;
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [classResult, calendarResult, yearResult, houseResult, groupResult, teacherResult, placementResult] = await Promise.all([
        client.from('school_classes')
          .select('id,name,grade_level,calendar_id,academic_year_id')
          .eq('school_id', schoolId).order('name').range(0, 999),
        client.from('academic_calendars')
          .select('id,name,division_name,is_default')
          .eq('school_id', schoolId).order('name'),
        client.from('academic_years')
          .select('id,name,calendar_id,is_current')
          .eq('school_id', schoolId).order('start_date', { ascending: false }),
        client.from('school_houses')
          .select('id,name,color,house_lead_teacher_id')
          .eq('school_id', schoolId).order('name').range(0, 999),
        client.from('school_registration_groups')
          .select('id,name,calendar_id,academic_year_id,tutor_teacher_id')
          .eq('school_id', schoolId).order('name').range(0, 999),
        client.from('teacher_profiles')
          .select('id,first_name,last_name')
          .eq('school_id', schoolId).eq('status', 'active').order('last_name'),
        canManage
          ? client.rpc('get_class_structure_roster', { target_school: schoolId })
          : Promise.resolve({ data: [], error: null }),
      ]);
      const failed = [classResult.error, calendarResult.error, yearResult.error, houseResult.error, groupResult.error, teacherResult.error, placementResult.error].find(Boolean);
      if (failed) throw failed;
      const calendarRows = (calendarResult.data ?? []) as CalendarRow[];
      const yearRows = (yearResult.data ?? []) as YearRow[];
      const defaultCalendarId = calendarRows.find((item) => item.is_default)?.id ?? calendarRows[0]?.id ?? '';
      const selectedClassCalendarId = calendarRows.some((item) => item.id === classCalendarId)
        ? classCalendarId
        : defaultCalendarId;
      const selectedGroupCalendarId = calendarRows.some((item) => item.id === groupCalendarId)
        ? groupCalendarId
        : defaultCalendarId;
      const classYears = yearRows.filter((item) => item.calendar_id === selectedClassCalendarId);
      const groupYears = yearRows.filter((item) => item.calendar_id === selectedGroupCalendarId);
      setClasses((classResult.data ?? []) as ClassRow[]);
      setCalendars(calendarRows);
      setYears(yearRows);
      setTeachers((teacherResult.data ?? []) as TeacherRow[]);
      setHouses((houseResult.data ?? []) as HouseRow[]);
      setGroups((groupResult.data ?? []) as RegistrationGroupRow[]);
      setPlacements((placementResult.data ?? []) as PlacementRow[]);
      setClassCalendarId(selectedClassCalendarId);
      setClassYearId((current) => yearRows.some((item) => item.id === current)
        && classYears.some((item) => item.id === current)
        ? current
        : classYears.find((item) => item.is_current)?.id ?? classYears[0]?.id ?? '');
      setGroupCalendarId(selectedGroupCalendarId);
      setGroupYearId((current) => groupYears.some((item) => item.id === current)
        ? current
        : groupYears.find((item) => item.is_current)?.id ?? groupYears[0]?.id ?? '');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load classes, houses, and registration groups.');
    } finally {
      setLoading(false);
    }
  }, [schoolId, canManage, classCalendarId, groupCalendarId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const groupsForSelectedCalendar = useMemo(
    () => years.filter((item) => item.calendar_id === groupCalendarId),
    [years, groupCalendarId],
  );

  async function createClass(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !classCalendarId || !className.trim()) return;
    if (classYearId && !years.some((item) => item.id === classYearId && item.calendar_id === classCalendarId)) {
      setError('Choose an academic year from the selected calendar.');
      return;
    }
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await createPrerequisiteRecord({
        entity: 'class',
        schoolId,
        name: className.trim(),
        gradeLevel,
        calendarId: classCalendarId,
        academicYearId: classYearId,
      });
      setClassName('');
      setGradeLevel('');
      setSuccess('Class created.');
      setRefreshKey((value) => value + 1);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not create the class.');
    } finally {
      setSaving(false);
    }
  }

  async function createHouse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !houseName.trim()) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: insertError } = await requireSupabase().from('school_houses').insert({
        school_id: schoolId,
        name: houseName.trim(),
        color: houseColor,
        house_lead_teacher_id: houseLead || null,
      });
      if (insertError) throw insertError;
      setHouseName('');
      setHouseLead('');
      setSuccess('House created.');
      setRefreshKey((value) => value + 1);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not create the house.');
    } finally {
      setSaving(false);
    }
  }

  async function createGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !groupName.trim() || !groupCalendarId || !groupYearId) return;
    if (!years.some((item) => item.id === groupYearId && item.calendar_id === groupCalendarId)) {
      setError('Choose an academic year from the selected calendar.');
      return;
    }
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: insertError } = await requireSupabase().from('school_registration_groups').insert({
        school_id: schoolId,
        calendar_id: groupCalendarId,
        academic_year_id: groupYearId,
        name: groupName.trim(),
        tutor_teacher_id: groupTutor || null,
      });
      if (insertError) throw insertError;
      setGroupName('');
      setGroupTutor('');
      setSuccess('Registration group created.');
      setRefreshKey((value) => value + 1);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not create the registration group.');
    } finally {
      setSaving(false);
    }
  }

  async function saveHouse(house: HouseRow) {
    if (!schoolId) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: updateError } = await requireSupabase().from('school_houses')
        .update({ name: house.name.trim(), color: house.color, house_lead_teacher_id: house.house_lead_teacher_id, updated_at: new Date().toISOString() })
        .eq('school_id', schoolId).eq('id', house.id);
      if (updateError) throw updateError;
      setSuccess(`${house.name} updated.`);
      setRefreshKey((value) => value + 1);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not update the house.');
    } finally {
      setSaving(false);
    }
  }

  async function deleteHouse(house: HouseRow) {
    if (!schoolId || !window.confirm(`Delete ${house.name}? Students assigned to it will become unassigned.`)) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: deleteError } = await requireSupabase().from('school_houses')
        .delete().eq('school_id', schoolId).eq('id', house.id);
      if (deleteError) throw deleteError;
      setSuccess(`${house.name} deleted.`);
      setRefreshKey((value) => value + 1);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Could not delete the house.');
    } finally {
      setSaving(false);
    }
  }

  async function saveGroup(group: RegistrationGroupRow) {
    if (!schoolId) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: updateError } = await requireSupabase().from('school_registration_groups')
        .update({ name: group.name.trim(), tutor_teacher_id: group.tutor_teacher_id, updated_at: new Date().toISOString() })
        .eq('school_id', schoolId).eq('id', group.id);
      if (updateError) throw updateError;
      setSuccess(`${group.name} updated.`);
      setRefreshKey((value) => value + 1);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not update the registration group.');
    } finally {
      setSaving(false);
    }
  }

  async function deleteGroup(group: RegistrationGroupRow) {
    if (!schoolId || !window.confirm(`Delete ${group.name}? Students assigned to it will become unassigned.`)) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: deleteError } = await requireSupabase().from('school_registration_groups')
        .delete().eq('school_id', schoolId).eq('id', group.id);
      if (deleteError) throw deleteError;
      setSuccess(`${group.name} deleted.`);
      setRefreshKey((value) => value + 1);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Could not delete the registration group.');
    } finally {
      setSaving(false);
    }
  }

  function updatePlacement(studentId: string, key: 'class_id' | 'house_id' | 'registration_group_id', value: string) {
    setPlacements((current) => current.map((item) => item.student_id === studentId
      ? {
        ...item,
        [key]: value || null,
        ...(key === 'class_id'
          ? { class_name: classes.find((schoolClass) => schoolClass.id === value)?.name ?? null }
          : {}),
      }
      : item));
  }

  async function savePlacement(placement: PlacementRow) {
    setSavingStudentId(placement.student_id);
    setError('');
    setSuccess('');
    try {
      const { error: saveError } = await requireSupabase().rpc('set_student_class_group_placement', {
        target_student: placement.student_id,
        next_class: placement.class_id,
        next_house: placement.house_id,
        next_registration_group: placement.registration_group_id,
      });
      if (saveError) throw saveError;
      setSuccess(`Placement updated for ${placement.first_name} ${placement.last_name}.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not update this student placement.');
    } finally {
      setSavingStudentId('');
    }
  }

  if (!schoolId) return <div className="page-stack"><ErrorState message="Select a school workspace to manage class structure." /></div>;

  return <div className="page-stack">
    <div className="page-heading">
      <div><span className="eyebrow">{activeMembership?.school.name} · Academics</span><h1>Classes, houses & registration groups</h1><p>Build the school’s class structure, configure pastoral groups, and assign students to houses and registration groups.</p></div>
      <button className="button button-quiet" type="button" onClick={() => setRefreshKey((value) => value + 1)} disabled={loading}><RefreshCw size={15} />Refresh</button>
    </div>
    {error && <ErrorState message={error} />}
    {success && <SuccessMessage message={success} />}
    <section className="calendar-management">
      <div className="calendar-tabs" role="tablist" aria-label="Class structure tools">
        {tabs.filter((item) => canManage || item.id !== 'placements').map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}</button>)}
      </div>
      {loading ? <LoadingState label="Loading class structure…" /> : <>
        {tab === 'classes' && <>
          {canManage && <form className="content-card calendar-config-form" onSubmit={(event) => void createClass(event)}>
            <h2>Create a class</h2>
            <label className="field"><span>Class name</span><input required minLength={1} maxLength={100} value={className} onChange={(event) => setClassName(event.target.value)} placeholder="e.g. Year 7 Blue" /></label>
            <label className="field"><span>Grade level</span><input maxLength={50} value={gradeLevel} onChange={(event) => setGradeLevel(event.target.value)} placeholder="e.g. Year 7" /></label>
            <label className="field"><span>Academic calendar</span><select required value={classCalendarId} onChange={(event) => { setClassCalendarId(event.target.value); setClassYearId(''); }}><option value="">Choose calendar</option>{calendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}{calendar.division_name ? ` · ${calendar.division_name}` : calendar.is_default ? ' · Default' : ''}</option>)}</select></label>
            <label className="field"><span>Academic year</span><select value={classYearId} onChange={(event) => setClassYearId(event.target.value)}><option value="">Not assigned</option>{years.filter((item) => item.calendar_id === classCalendarId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <button className="button button-primary" type="submit" disabled={saving || !calendars.length}><Plus size={15} />Create class</button>
          </form>}
          <section className="content-card">
            <div className="section-heading"><div><span className="eyebrow">Class catalogue</span><h2>{classes.length} class(es)</h2></div></div>
            {classes.length ? <div className="table-scroll"><table><thead><tr><th>Class</th><th>Grade</th><th>Calendar</th><th>Academic year</th><th>Active students</th></tr></thead><tbody>{classes.map((item) => <tr key={item.id}><td><strong>{item.name}</strong></td><td>{item.grade_level ?? '—'}</td><td>{calendars.find((calendar) => calendar.id === item.calendar_id)?.name ?? '—'}</td><td>{years.find((year) => year.id === item.academic_year_id)?.name ?? '—'}</td><td>{canManage ? placements.filter((student) => student.class_id === item.id).length : '—'}</td></tr>)}</tbody></table></div> : <EmptyState title="No classes configured" detail="Create an academic calendar first, then add classes to the relevant year." />}
          </section>
        </>}
        {tab === 'houses' && <>
          {canManage && <form className="content-card calendar-config-form" onSubmit={(event) => void createHouse(event)}>
            <h2>Create a house</h2>
            <label className="field"><span>House name</span><input required minLength={1} maxLength={80} value={houseName} onChange={(event) => setHouseName(event.target.value)} /></label>
            <label className="field"><span>House colour</span><input type="color" value={houseColor} onChange={(event) => setHouseColor(event.target.value)} /></label>
            <label className="field"><span>House lead</span><select value={houseLead} onChange={(event) => setHouseLead(event.target.value)}><option value="">Unassigned</option>{teachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.first_name} {teacher.last_name}</option>)}</select></label>
            <button className="button button-primary" type="submit" disabled={saving}><Plus size={15} />Create house</button>
          </form>}
          <section className="content-card">
            <div className="section-heading"><div><span className="eyebrow">House catalogue</span><h2>{houses.length} house(s)</h2></div></div>
            {houses.length ? <div className="table-scroll"><table><thead><tr><th>House</th><th>Colour</th><th>House lead</th>{canManage && <th>Actions</th>}</tr></thead><tbody>{houses.map((house) => <tr key={house.id}><td><input aria-label={`${house.name} house name`} value={house.name} maxLength={80} onChange={(event) => setHouses((current) => current.map((item) => item.id === house.id ? { ...item, name: event.target.value } : item))} disabled={!canManage} /></td><td><input aria-label={`${house.name} colour`} type="color" value={house.color} onChange={(event) => setHouses((current) => current.map((item) => item.id === house.id ? { ...item, color: event.target.value } : item))} disabled={!canManage} /></td><td><select aria-label={`${house.name} lead`} value={house.house_lead_teacher_id ?? ''} onChange={(event) => setHouses((current) => current.map((item) => item.id === house.id ? { ...item, house_lead_teacher_id: event.target.value || null } : item))} disabled={!canManage}><option value="">Unassigned</option>{teachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.first_name} {teacher.last_name}</option>)}</select></td>{canManage && <td><div className="attendance-session-actions"><button className="button button-quiet" type="button" onClick={() => void saveHouse(house)} disabled={saving}><Save size={14} />Save</button><button className="icon-button" type="button" onClick={() => void deleteHouse(house)} disabled={saving} aria-label={`Delete ${house.name}`}><Trash2 size={14} /></button></div></td>}</tr>)}</tbody></table></div> : <EmptyState title="No houses configured" detail="Add houses before assigning students to them." />}
          </section>
        </>}
        {tab === 'groups' && <>
          {canManage && <form className="content-card calendar-config-form" onSubmit={(event) => void createGroup(event)}>
            <h2>Create a registration group</h2>
            <label className="field"><span>Group name</span><input required minLength={1} maxLength={80} value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="e.g. 7A Tutor Group" /></label>
            <label className="field"><span>Academic calendar</span><select required value={groupCalendarId} onChange={(event) => { setGroupCalendarId(event.target.value); setGroupYearId(''); }}><option value="">Choose calendar</option>{calendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}{calendar.division_name ? ` · ${calendar.division_name}` : calendar.is_default ? ' · Default' : ''}</option>)}</select></label>
            <label className="field"><span>Academic year</span><select required value={groupYearId} onChange={(event) => setGroupYearId(event.target.value)}><option value="">Choose year</option>{groupsForSelectedCalendar.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label className="field"><span>Form tutor</span><select value={groupTutor} onChange={(event) => setGroupTutor(event.target.value)}><option value="">Unassigned</option>{teachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.first_name} {teacher.last_name}</option>)}</select></label>
            <button className="button button-primary" type="submit" disabled={saving || !groupsForSelectedCalendar.length}><Plus size={15} />Create group</button>
          </form>}
          <section className="content-card">
            <div className="section-heading"><div><span className="eyebrow">Registration groups</span><h2>{groups.length} group(s)</h2></div></div>
            {groups.length ? <div className="table-scroll"><table><thead><tr><th>Group name</th><th>Calendar</th><th>Academic year</th><th>Form tutor</th>{canManage && <th>Actions</th>}</tr></thead><tbody>{groups.map((group) => <tr key={group.id}><td><input aria-label={`${group.name} group name`} value={group.name} maxLength={80} onChange={(event) => setGroups((current) => current.map((item) => item.id === group.id ? { ...item, name: event.target.value } : item))} disabled={!canManage} /></td><td>{calendars.find((calendar) => calendar.id === group.calendar_id)?.name ?? '—'}</td><td>{years.find((year) => year.id === group.academic_year_id)?.name ?? '—'}</td><td><select aria-label={`${group.name} tutor`} value={group.tutor_teacher_id ?? ''} onChange={(event) => setGroups((current) => current.map((item) => item.id === group.id ? { ...item, tutor_teacher_id: event.target.value || null } : item))} disabled={!canManage}><option value="">Unassigned</option>{teachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.first_name} {teacher.last_name}</option>)}</select></td>{canManage && <td><div className="attendance-session-actions"><button className="button button-quiet" type="button" onClick={() => void saveGroup(group)} disabled={saving}><Save size={14} />Save</button><button className="icon-button" type="button" onClick={() => void deleteGroup(group)} disabled={saving} aria-label={`Delete ${group.name}`}><Trash2 size={14} /></button></div></td>}</tr>)}</tbody></table></div> : <EmptyState title="No registration groups configured" detail="Create registration groups for an academic year and assign students in Student placement." />}
          </section>
        </>}
        {tab === 'placements' && canManage && <section className="content-card">
          <div className="section-heading"><div><span className="eyebrow">Student structure</span><h2>Class, house & registration group placement</h2></div><span>{placements.length} active student(s)</span></div>
          <p className="calendar-muted-copy">Registration groups must match the student’s class calendar and academic year. Student assignment changes are saved through a school-scoped database function.</p>
          {placements.length ? <div className="table-scroll"><table><thead><tr><th>Student</th><th>Class</th><th>House</th><th>Registration group</th><th>Action</th></tr></thead><tbody>{placements.map((student) => {
            const schoolClass = classes.find((item) => item.id === student.class_id);
            const compatibleGroups = groups.filter((item) => !schoolClass
              || (item.calendar_id === schoolClass.calendar_id
                && (!schoolClass.academic_year_id || item.academic_year_id === schoolClass.academic_year_id)));
            return <tr key={student.student_id}>
              <td><strong>{student.first_name} {student.last_name}</strong><small className="calendar-muted-copy">{student.student_number}</small></td>
              <td><select aria-label={`${student.first_name} ${student.last_name} class`} value={student.class_id ?? ''} onChange={(event) => updatePlacement(student.student_id, 'class_id', event.target.value)}><option value="">Unassigned</option>{classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></td>
              <td><select aria-label={`${student.first_name} ${student.last_name} house`} value={student.house_id ?? ''} onChange={(event) => updatePlacement(student.student_id, 'house_id', event.target.value)}><option value="">Unassigned</option>{houses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></td>
              <td><select aria-label={`${student.first_name} ${student.last_name} registration group`} value={student.registration_group_id ?? ''} onChange={(event) => updatePlacement(student.student_id, 'registration_group_id', event.target.value)}><option value="">Unassigned</option>{compatibleGroups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></td>
              <td><button className="button button-quiet" type="button" onClick={() => void savePlacement(student)} disabled={savingStudentId === student.student_id}><Save size={14} />{savingStudentId === student.student_id ? 'Saving…' : 'Save placement'}</button></td>
            </tr>;
          })}</tbody></table></div> : <EmptyState title="No active students" detail="Active students will appear here for class and group assignment." />}
        </section>}
      </>}
    </section>
  </div>;
}
