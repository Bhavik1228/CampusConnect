import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { CalendarClock, Plus, Save, Trash2 } from 'lucide-react';
import { EmptyState, ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type Props = { schoolId: string; section: 'configuration' | 'enquiries' | 'appointments'; canConfigure: boolean };
type ApplicationField = { key: string; label: string; type: 'text' | 'email' | 'tel' | 'date' | 'select' | 'textarea'; required: boolean; options: string[] };
type RequiredDocument = { key: string; label: string };
type Stage = { id: string; stage_key: string; label: string; status: string; sort_order: number; required_role: string; approval_required: boolean; active: boolean };
type Slot = { id: string; slot_type: 'appointment' | 'open_day'; title: string; starts_at: string; ends_at: string; capacity: number; location: string; active: boolean };
type Enquiry = { id: string; guardian_name: string; guardian_email: string; guardian_phone: string; student_name: string; applying_for: string; message: string; status: string; application_id: string | null; created_at: string };
type Booking = { id: string; slot_id: string; guardian_name: string; guardian_email: string; guardian_phone: string; student_name: string; note: string; status: string; created_at: string; slot?: { title: string; starts_at: string } | { title: string; starts_at: string }[] | null };

const defaultStatuses = ['submitted', 'under_review', 'accepted', 'rejected', 'waitlisted', 'withdrawn', 'registered'];

export function AdmissionsOperationsPanel({ schoolId, section, canConfigure }: Props) {
  const [fields, setFields] = useState<ApplicationField[]>([]);
  const [documents, setDocuments] = useState<RequiredDocument[]>([]);
  const [appointmentsEnabled, setAppointmentsEnabled] = useState(false);
  const [stages, setStages] = useState<Stage[]>([]);
  const [enquiries, setEnquiries] = useState<Enquiry[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [newFieldLabel, setNewFieldLabel] = useState('');
  const [newDocumentLabel, setNewDocumentLabel] = useState('');
  const [newStageLabel, setNewStageLabel] = useState('');
  const [newStageStatus, setNewStageStatus] = useState('under_review');
  const [slotTitle, setSlotTitle] = useState('');
  const [slotType, setSlotType] = useState<'appointment' | 'open_day'>('appointment');
  const [slotStart, setSlotStart] = useState('');
  const [slotEnd, setSlotEnd] = useState('');
  const [slotCapacity, setSlotCapacity] = useState(1);
  const [slotLocation, setSlotLocation] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      if (section === 'configuration') {
        const [settings, stageRows] = await Promise.all([
          client.from('admission_school_settings').select('application_fields,required_documents,appointments_enabled').eq('school_id', schoolId).maybeSingle(),
          client.from('admission_workflow_stages').select('id,stage_key,label,status,sort_order,required_role,approval_required,active').eq('school_id', schoolId).order('sort_order'),
        ]);
        if (settings.error) throw settings.error;
        if (stageRows.error) throw stageRows.error;
        const config = settings.data;
        setFields((config?.application_fields ?? []) as ApplicationField[]);
        setDocuments((config?.required_documents ?? []) as RequiredDocument[]);
        setAppointmentsEnabled(config?.appointments_enabled ?? false);
        setStages((stageRows.data ?? []) as Stage[]);
      } else if (section === 'enquiries') {
        const { data, error: queryError } = await client.from('admission_enquiries').select('*').eq('school_id', schoolId).order('created_at', { ascending: false }).limit(200);
        if (queryError) throw queryError;
        setEnquiries((data ?? []) as Enquiry[]);
      } else {
        const [settings, slotResult, bookingResult] = await Promise.all([
          client.from('admission_school_settings').select('appointments_enabled').eq('school_id', schoolId).maybeSingle(),
          client.from('admission_appointment_slots').select('*').eq('school_id', schoolId).order('starts_at'),
          client.from('admission_appointment_bookings').select('*,slot:admission_appointment_slots(title,starts_at)').eq('school_id', schoolId).order('created_at', { ascending: false }).limit(300),
        ]);
        if (settings.error) throw settings.error;
        if (slotResult.error) throw slotResult.error;
        if (bookingResult.error) throw bookingResult.error;
        setAppointmentsEnabled(settings.data?.appointments_enabled ?? false);
        setSlots((slotResult.data ?? []) as Slot[]);
        setBookings((bookingResult.data ?? []) as Booking[]);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load admissions operations.');
    } finally {
      setLoading(false);
    }
  }, [schoolId, section]);

  useEffect(() => { void load(); }, [load]);

  async function saveConfiguration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: saveError } = await requireSupabase().rpc('save_admission_configuration', {
        target_school: schoolId,
        fields,
        required_documents: documents,
        appointments_enabled: appointmentsEnabled,
      });
      if (saveError) throw saveError;
      setSuccess('Application fields and document requirements saved.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save admissions configuration.');
    } finally {
      setSaving(false);
    }
  }

  async function saveStages() {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: stageError } = await requireSupabase().rpc('save_admission_workflow_stages', {
        target_school: schoolId,
        stage_config: stages,
      });
      if (stageError) throw stageError;
      setSuccess('Admissions workflow stages saved.');
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save workflow stages.');
    } finally {
      setSaving(false);
    }
  }

  function addStage() {
    const label = newStageLabel.trim();
    if (!label || stages.length >= 30) return;
    const stageKey = `custom_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    setStages((current) => [...current, {
      id: '',
      stage_key: stageKey,
      label,
      status: newStageStatus,
      sort_order: current.reduce((max, stage) => Math.max(max, stage.sort_order), 0) + 10,
      required_role: 'admissions_officer',
      approval_required: false,
      active: true,
    }]);
    setNewStageLabel('');
  }

  async function addField() {
    const label = newFieldLabel.trim();
    if (!label || fields.length >= 30) return;
    const keyBase = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'custom_field';
    const key = `field_${keyBase}_${crypto.randomUUID().slice(0, 6).replace(/-/g, '')}`;
    setFields((current) => [...current, { key, label, type: 'text', required: false, options: [] }]);
    setNewFieldLabel('');
  }

  async function updateEnquiry(enquiry: Enquiry, status: 'contacted' | 'closed' | 'convert') {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      if (status === 'convert') {
        const { error: convertError } = await requireSupabase().rpc('convert_admission_enquiry', { target_enquiry: enquiry.id });
        if (convertError) throw convertError;
        setSuccess('Enquiry converted to an application.');
      } else {
        const { error: updateError } = await requireSupabase().rpc('set_admission_enquiry_status', { target_enquiry: enquiry.id, next_status: status });
        if (updateError) throw updateError;
        setSuccess(`Enquiry marked ${status}.`);
      }
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Could not update the enquiry.');
    } finally {
      setSaving(false);
    }
  }

  async function saveSlot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: slotError } = await requireSupabase().rpc('manage_admission_appointment_slot', {
        target_school: schoolId,
        target_slot: null,
        slot_type: slotType,
        slot_title: slotTitle.trim(),
        slot_starts_at: new Date(slotStart).toISOString(),
        slot_ends_at: new Date(slotEnd).toISOString(),
        slot_capacity: slotCapacity,
        slot_location: slotLocation.trim(),
        slot_active: true,
      });
      if (slotError) throw slotError;
      setSlotTitle('');
      setSlotStart('');
      setSlotEnd('');
      setSlotCapacity(1);
      setSlotLocation('');
      setSuccess('Appointment slot published.');
      await load();
    } catch (slotError) {
      setError(slotError instanceof Error ? slotError.message : 'Could not create the appointment slot.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleSlot(slot: Slot) {
    setSaving(true);
    setError('');
    try {
      const { error: slotError } = await requireSupabase().rpc('manage_admission_appointment_slot', {
        target_school: schoolId,
        target_slot: slot.id,
        slot_type: slot.slot_type,
        slot_title: slot.title,
        slot_starts_at: slot.starts_at,
        slot_ends_at: slot.ends_at,
        slot_capacity: slot.capacity,
        slot_location: slot.location,
        slot_active: !slot.active,
      });
      if (slotError) throw slotError;
      await load();
    } catch (slotError) {
      setError(slotError instanceof Error ? slotError.message : 'Could not update the appointment slot.');
    } finally {
      setSaving(false);
    }
  }

  async function updateBooking(booking: Booking, status: 'booked' | 'cancelled' | 'attended' | 'no_show') {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: updateError } = await requireSupabase().rpc('set_admission_appointment_booking_status', {
        target_booking: booking.id,
        next_status: status,
      });
      if (updateError) throw updateError;
      setSuccess(`Booking marked ${status.replace(/_/g, ' ')}.`);
      await load();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Could not update the appointment booking.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingState label="Loading admissions workspace…" />;

  return <section className="content-card admissions-operations-panel">
    {error && <ErrorState message={error} />}
    {success && <SuccessMessage message={success} />}
    {section === 'configuration' && <div className="admissions-config-grid">
      <form className="admissions-config-card" onSubmit={(event) => void saveConfiguration(event)}>
        <div className="section-heading"><div><span className="eyebrow">Online form</span><h2>Application fields</h2></div></div>
        <p className="settings-readonly">Add school-specific questions. Keep student and guardian contact fields on the standard form.</p>
        {fields.map((field, index) => <div className="admissions-config-row" key={field.key}>
          <input aria-label="Field label" value={field.label} maxLength={100} onChange={(event) => setFields((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, label: event.target.value } : item))} />
          <select aria-label="Field type" value={field.type} onChange={(event) => setFields((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, type: event.target.value as ApplicationField['type'] } : item))}>
            {['text', 'email', 'tel', 'date', 'select', 'textarea'].map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
          <label><input type="checkbox" checked={field.required} onChange={(event) => setFields((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, required: event.target.checked } : item))} />Required</label>
          {field.type === 'select' && <input aria-label="Dropdown options, comma separated" value={field.options.join(', ')} onChange={(event) => setFields((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, options: event.target.value.split(',').map((option) => option.trim()).filter(Boolean).slice(0, 20) } : item))} placeholder="Choices separated by commas" />}
          <button type="button" className="button button-quiet" aria-label={`Remove ${field.label}`} onClick={() => setFields((current) => current.filter((_, currentIndex) => currentIndex !== index))}><Trash2 size={14} /></button>
        </div>)}
        <div className="admissions-inline-add"><input value={newFieldLabel} maxLength={100} onChange={(event) => setNewFieldLabel(event.target.value)} placeholder="New question label" /><button className="button button-quiet" type="button" onClick={() => void addField()} disabled={!newFieldLabel.trim() || fields.length >= 30}><Plus size={14} />Add field</button></div>
        <div className="section-heading admissions-config-subheading"><div><span className="eyebrow">Checklist</span><h2>Required documents</h2></div></div>
        {documents.map((document, index) => <div className="admissions-config-row" key={document.key}><input value={document.label} aria-label="Required document label" maxLength={120} onChange={(event) => setDocuments((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, label: event.target.value } : item))} /><button className="button button-quiet" type="button" aria-label={`Remove ${document.label}`} onClick={() => setDocuments((current) => current.filter((_, currentIndex) => currentIndex !== index))}><Trash2 size={14} /></button></div>)}
        <div className="admissions-inline-add"><input value={newDocumentLabel} maxLength={120} onChange={(event) => setNewDocumentLabel(event.target.value)} placeholder="New required document" /><button className="button button-quiet" type="button" onClick={() => {
          const label = newDocumentLabel.trim();
          if (!label) return;
          const keyBase = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'document';
          const key = `document_${keyBase}_${crypto.randomUUID().slice(0, 6).replace(/-/g, '')}`;
          setDocuments((current) => [...current, { key, label }]);
          setNewDocumentLabel('');
        }} disabled={!newDocumentLabel.trim() || documents.length >= 30}><Plus size={14} />Add document</button></div>
        <label className="admissions-config-toggle"><input type="checkbox" checked={appointmentsEnabled} onChange={(event) => setAppointmentsEnabled(event.target.checked)} />Allow public appointment and open-day booking</label>
        <button className="button button-primary" type="submit" disabled={saving || !canConfigure}><Save size={14} />Save application settings</button>
      </form>
      <section className="admissions-config-card">
        <div className="section-heading"><div><span className="eyebrow">Workflow</span><h2>Stages and approvals</h2></div></div>
        <p className="settings-readonly">Select who may move applications into each stage; school-admin approval is required for approval stages.</p>
        {stages.map((stage, index) => <div className="admissions-stage-row" key={stage.id}>
          <input type="number" aria-label="Stage order" min={0} max={10000} value={stage.sort_order} onChange={(event) => setStages((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, sort_order: Number(event.target.value) } : item))} />
          <input value={stage.label} aria-label="Stage name" maxLength={80} onChange={(event) => setStages((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, label: event.target.value } : item))} />
          <select aria-label="Stage status" value={stage.status} onChange={(event) => setStages((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, status: event.target.value } : item))}>
            {defaultStatuses.map((status) => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}
          </select>
          <select aria-label="Required role" value={stage.required_role} onChange={(event) => setStages((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, required_role: event.target.value } : item))}>
            <option value="admissions_officer">Admissions staff</option><option value="school_admin">School administrator</option>
          </select>
          <label><input type="checkbox" checked={stage.approval_required} onChange={(event) => setStages((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, approval_required: event.target.checked } : item))} />Approval</label>
          <label><input type="checkbox" checked={stage.active} onChange={(event) => setStages((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, active: event.target.checked } : item))} />Active</label>
        </div>)}
        <div className="admissions-inline-add"><input value={newStageLabel} maxLength={80} onChange={(event) => setNewStageLabel(event.target.value)} placeholder="New workflow stage" /><select aria-label="New stage status" value={newStageStatus} onChange={(event) => setNewStageStatus(event.target.value)}>{defaultStatuses.filter((status) => status !== 'registered').map((status) => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}</select><button className="button button-quiet" type="button" onClick={addStage} disabled={!newStageLabel.trim() || stages.length >= 30}><Plus size={14} />Add stage</button></div>
        <button className="button button-primary" type="button" onClick={() => void saveStages()} disabled={saving || !canConfigure}><Save size={14} />Save workflow</button>
      </section>
    </div>}

    {section === 'enquiries' && (enquiries.length ? <div className="admissions-operations-list">{enquiries.map((enquiry) => <article key={enquiry.id}>
      <div><strong>{enquiry.student_name} · {enquiry.guardian_name}</strong><small>{enquiry.guardian_email}{enquiry.guardian_phone ? ` · ${enquiry.guardian_phone}` : ''} · {new Date(enquiry.created_at).toLocaleString()}</small><p>{enquiry.message}</p><small>Applying for: {enquiry.applying_for || 'Not specified'} · {enquiry.status.replace(/_/g, ' ')}</small></div>
      {enquiry.status !== 'converted' && <div className="admissions-operation-actions">
        <button className="button button-quiet" type="button" onClick={() => void updateEnquiry(enquiry, 'contacted')} disabled={saving}>Mark contacted</button>
        <button className="button button-primary" type="button" onClick={() => void updateEnquiry(enquiry, 'convert')} disabled={saving}>Convert to application</button>
        <button className="button button-quiet" type="button" onClick={() => void updateEnquiry(enquiry, 'closed')} disabled={saving}>Close</button>
      </div>}
    </article>)}</div> : <EmptyState title="No enquiries yet" detail="Public admissions enquiries will appear here." />)}

    {section === 'appointments' && <div className="admissions-config-grid">
      <form className="admissions-config-card" onSubmit={(event) => void saveSlot(event)}>
        <div className="section-heading"><div><span className="eyebrow">Schedule</span><h2>Publish an appointment or open day</h2></div><CalendarClock size={17} /></div>
        <label className="field"><span>Event name</span><input required minLength={2} maxLength={120} value={slotTitle} onChange={(event) => setSlotTitle(event.target.value)} /></label>
        <label className="field"><span>Type</span><select value={slotType} onChange={(event) => setSlotType(event.target.value as typeof slotType)}><option value="appointment">Admissions appointment</option><option value="open_day">Open day</option></select></label>
        <label className="field"><span>Starts</span><input type="datetime-local" required value={slotStart} onChange={(event) => setSlotStart(event.target.value)} /></label>
        <label className="field"><span>Ends</span><input type="datetime-local" required value={slotEnd} onChange={(event) => setSlotEnd(event.target.value)} /></label>
        <label className="field"><span>Capacity</span><input type="number" min={1} max={500} required value={slotCapacity} onChange={(event) => setSlotCapacity(Number(event.target.value))} /></label>
        <label className="field"><span>Location or meeting instructions</span><input maxLength={240} value={slotLocation} onChange={(event) => setSlotLocation(event.target.value)} /></label>
        <button className="button button-primary" type="submit" disabled={saving || !appointmentsEnabled}><Plus size={14} />Publish slot</button>
        {!appointmentsEnabled && <p className="settings-readonly">Enable booking under Application settings first.</p>}
      </form>
      <div className="admissions-config-card">
        <div className="section-heading"><div><span className="eyebrow">Published slots</span><h2>Appointments and open days</h2></div></div>
        {slots.length ? <div className="admissions-operations-list">{slots.map((slot) => <article key={slot.id}><div><strong>{slot.title} · {slot.slot_type.replace(/_/g, ' ')}</strong><small>{new Date(slot.starts_at).toLocaleString()}–{new Date(slot.ends_at).toLocaleTimeString()} · Capacity {slot.capacity} · {slot.location || 'Location to be confirmed'}</small><small>{slot.active ? 'Visible for booking' : 'Not visible'}</small></div><button className="button button-quiet" type="button" onClick={() => void toggleSlot(slot)} disabled={saving}>{slot.active ? 'Unpublish' : 'Publish'}</button></article>)}</div> : <EmptyState title="No slots scheduled" detail="Create appointment slots or an open-day event for families to book." />}
      </div>
      <section className="admissions-config-card">
        <div className="section-heading"><div><span className="eyebrow">Bookings</span><h2>Family reservations</h2></div></div>
        {bookings.length ? <div className="admissions-operations-list">{bookings.map((booking) => {
          const slot = Array.isArray(booking.slot) ? booking.slot[0] : booking.slot;
          return <article key={booking.id}><div><strong>{booking.student_name} · {booking.guardian_name}</strong><small>{slot?.title ?? 'Appointment'} · {slot?.starts_at ? new Date(slot.starts_at).toLocaleString() : ''}</small><small>{booking.guardian_email} · {booking.status.replace(/_/g, ' ')}</small></div>
            <div className="admissions-operation-actions">{booking.status === 'booked' ? <>
              <button className="button button-quiet" type="button" onClick={() => void updateBooking(booking, 'attended')} disabled={saving}>Mark attended</button>
              <button className="button button-quiet" type="button" onClick={() => void updateBooking(booking, 'no_show')} disabled={saving}>No show</button>
              <button className="button button-quiet" type="button" onClick={() => void updateBooking(booking, 'cancelled')} disabled={saving}>Cancel</button>
            </> : booking.status === 'cancelled' && <button className="button button-quiet" type="button" onClick={() => void updateBooking(booking, 'booked')} disabled={saving}>Restore booking</button>}</div>
          </article>;
        })}</div> : <EmptyState title="No bookings yet" detail="Public reservations will appear here." />}
      </section>
    </div>}
  </section>;
}
