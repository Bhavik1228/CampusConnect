import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowRight, BookOpenCheck, CalendarDays, CheckCircle2, FileText, GraduationCap, MapPin, Search, ShieldCheck } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type PublicWebsite = {
  school_id: string;
  slug: string;
  public_results_enabled: boolean;
  public_library_enabled: boolean;
  hero_title: string;
  hero_message: string;
  about_title: string;
  about_text: string;
  admissions_open: boolean;
  admissions_applications_enabled: boolean;
  admissions_title: string;
  admissions_text: string;
  admission_requirements: string;
  admissions_deadline: string | null;
  admissions_email: string | null;
  fees?: { level: string; tuition: number; currency: string; frequency: string; additional: string }[] | null;
  name: string;
  address: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  website: string | null;
  logo_path: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  motto: string | null;
};
type PublicApplicationField = { key: string; label: string; type: 'text' | 'email' | 'tel' | 'date' | 'select' | 'textarea'; required: boolean; options?: string[] | null };
type PublicRequiredDocument = { key: string; label: string };
type PublicAppointmentSlot = { id: string; slot_type: 'appointment' | 'open_day'; title: string; starts_at: string; ends_at: string; location: string | null; remaining: number };
type PublicAdmissionsConfiguration = { application_fields?: PublicApplicationField[] | null; required_documents?: PublicRequiredDocument[] | null; appointments_enabled: boolean; appointment_slots?: PublicAppointmentSlot[] | null };

type PublicResult = {
  student_number: string;
  first_name: string;
  last_name: string;
  subject: string;
  assessment_title: string;
  assessment_date: string;
  marks_obtained: number;
  maximum_marks: number;
  percentage: number;
  teacher_comment: string;
};

interface PublicAdmissionStatus {
  application_reference: string;
  student_name: string;
  school_name: string;
  application_status: string;
  applying_for: string;
  decision_note: string | null;
  submitted_at: string;
  updated_at: string;
}

const allowedAdmissionTypes = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const maxAdmissionFileSize = 10 * 1024 * 1024;

function safeFileName(value: string) {
  const extension = value.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'bin';
  return `${crypto.randomUUID()}.${extension}`;
}

function displayDate(date: string) {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}

function safeWebsiteUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    const code = 'code' in error && typeof error.code === 'string' ? ` [${error.code}]` : '';
    return `${error.message}${code}`;
  }
  return fallback;
}

export function PublicSchoolWebsitePage() {
  const { slug = '' } = useParams();
  const applicationFormRef = useRef<HTMLFormElement>(null);
  const [website, setWebsite] = useState<PublicWebsite | null>(null);
  const [admissionsConfiguration, setAdmissionsConfiguration] = useState<PublicAdmissionsConfiguration | null>(null);
  const [resumeToken, setResumeToken] = useState('');
  const [resumeTokenEntry, setResumeTokenEntry] = useState('');
  const [draftSuccess, setDraftSuccess] = useState('');
  const [draftError, setDraftError] = useState('');
  const [savingDraft, setSavingDraft] = useState(false);
  const [enquiryBusy, setEnquiryBusy] = useState(false);
  const [enquiryResult, setEnquiryResult] = useState('');
  const [appointmentBusy, setAppointmentBusy] = useState(false);
  const [appointmentResult, setAppointmentResult] = useState('');
  const [studentNumber, setStudentNumber] = useState('');
  const [results, setResults] = useState<PublicResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [submittingApplication, setSubmittingApplication] = useState(false);
  const [applicationReference, setApplicationReference] = useState('');
  const [applicationError, setApplicationError] = useState('');
  const [applicationSuccess, setApplicationSuccess] = useState('');
  const [statusReference, setStatusReference] = useState('');
  const [statusEmail, setStatusEmail] = useState('');
  const [statusResult, setStatusResult] = useState<PublicAdmissionStatus | null>(null);
  const [checkingApplicationStatus, setCheckingApplicationStatus] = useState(false);
  const [error, setError] = useState('');
  const [searchError, setSearchError] = useState('');

  useEffect(() => {
    let alive = true;
    async function loadWebsite() {
      setLoading(true);
      setError('');
      setWebsite(null);
      setResults([]);
      setSearched(false);
      try {
        const { data, error: queryError } = await requireSupabase()
          .rpc('get_public_school_website', { target_slug: slug });
        if (queryError) throw queryError;
        if (alive && data) setWebsite(data as PublicWebsite);
      } catch (loadError) {
        if (alive) setError(loadError instanceof Error ? loadError.message : 'Could not load this school website.');
      } finally {
        if (alive) setLoading(false);
      }
    }
    void loadWebsite();
    return () => { alive = false; };
  }, [slug]);

  useEffect(() => {
    if (!website?.admissions_open || !website.admissions_applications_enabled) {
      setAdmissionsConfiguration(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const { data, error: configError } = await requireSupabase().rpc('get_public_admission_configuration', { target_slug: website.slug });
        if (configError) throw configError;
        if (alive && data) setAdmissionsConfiguration(data as PublicAdmissionsConfiguration);
      } catch (configError) {
        if (alive) setApplicationError(configError instanceof Error ? configError.message : 'Could not load online application requirements.');
      }
    })();
    const savedToken = window.localStorage.getItem(`admission-resume:${website.slug}`);
    if (savedToken) {
      setResumeToken(savedToken);
      setResumeTokenEntry(savedToken);
    }
    return () => { alive = false; };
  }, [website]);

  async function checkResults(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedNumber = studentNumber.trim();
    if (!normalizedNumber || !website) return;
    setSearching(true);
    setSearchError('');
    setResults([]);
    setSearched(false);
    try {
      const { data, error: queryError } = await requireSupabase()
        .rpc('lookup_public_student_results', {
          target_slug: website.slug,
          target_student_number: normalizedNumber,
        });
      if (queryError) throw queryError;
      const records = Array.isArray(data) ? data as PublicResult[] : [];
      setResults(records);
      setSearched(true);
      if (records.length === 0) setSearchError('No published results were found for that student number. Check the number with the school and try again.');
    } catch (lookupError) {
      setSearchError(lookupError instanceof Error ? lookupError.message : 'Could not check results. Please try again.');
    } finally {
      setSearching(false);
    }
  }

  function collectAdmissionPayload(form: FormData) {
    const payload: Record<string, string | Record<string, string>> = {};
    for (const [key, value] of form.entries()) {
      if (value instanceof File || key === 'admission_documents') continue;
      if (key.startsWith('custom_')) {
        const customFields = (payload.custom_fields ?? {}) as Record<string, string>;
        customFields[key.slice('custom_'.length)] = String(value).trim();
        payload.custom_fields = customFields;
      } else {
        payload[key] = String(value).trim();
      }
    }
    return payload;
  }

  async function saveAdmissionDraft() {
    if (!website || !applicationFormRef.current) return;
    setSavingDraft(true);
    setDraftError('');
    setDraftSuccess('');
    try {
      const token = resumeToken || `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');
      const payload = collectAdmissionPayload(new FormData(applicationFormRef.current));
      const { data, error: saveError } = await requireSupabase().rpc('save_public_admission_draft', {
        target_slug: website.slug,
        resume_token: token,
        draft_payload: payload,
      });
      if (saveError) throw saveError;
      setResumeToken(token);
      setResumeTokenEntry(token);
      window.localStorage.setItem(`admission-resume:${website.slug}`, token);
      setDraftSuccess(`Draft saved until ${new Date(data as string).toLocaleDateString()}. Keep this resume code to continue on another device: ${token}`);
    } catch (saveError) {
      setDraftError(saveError instanceof Error ? saveError.message : 'Could not save your application draft.');
    } finally {
      setSavingDraft(false);
    }
  }

  async function resumeAdmissionDraft() {
    if (!website || !applicationFormRef.current) return;
    setDraftError('');
    setDraftSuccess('');
    try {
      const token = resumeTokenEntry.trim();
      const { data, error: loadError } = await requireSupabase().rpc('get_public_admission_draft', {
        target_slug: website.slug,
        resume_token: token,
      });
      if (loadError) throw loadError;
      if (!data || typeof data !== 'object') throw new Error('No active application draft was found for that code.');
      const payload = data as Record<string, string | Record<string, string>>;
      const customFields = (payload.custom_fields ?? {}) as Record<string, string>;
      for (const [name, value] of Object.entries(payload)) {
        if (name === 'custom_fields' || typeof value !== 'string') continue;
        const control = applicationFormRef.current.elements.namedItem(name);
        if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) control.value = value;
      }
      for (const [key, value] of Object.entries(customFields)) {
        const control = applicationFormRef.current.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name="custom_${key}"]`);
        if (control) control.value = value;
      }
      setResumeToken(token);
      setResumeTokenEntry(token);
      window.localStorage.setItem(`admission-resume:${website.slug}`, token);
      setDraftSuccess('Your saved application has been restored.');
    } catch (loadError) {
      setDraftError(loadError instanceof Error ? loadError.message : 'Could not resume your application.');
    }
  }

  async function submitAdmission(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!website) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const uploadedFiles = form.getAll('admission_documents').filter((value): value is File => value instanceof File && value.size > 0);
    setSubmittingApplication(true);
    setApplicationError('');
    setApplicationSuccess('');
    setApplicationReference('');
    try {
      if (uploadedFiles.length > 5) throw new Error('You can attach up to five supporting documents per application.');
      for (const file of uploadedFiles) {
        if (!allowedAdmissionTypes.has(file.type)) throw new Error(`${file.name} is not a supported file type.`);
        if (file.size > maxAdmissionFileSize) throw new Error(`${file.name} exceeds the 10 MB per-file limit.`);
        if (file.name.length > 200) throw new Error('Document file names must be 200 characters or fewer.');
      }
      const payload = collectAdmissionPayload(form);
      if (resumeToken) payload.resume_token = resumeToken;
      const { data, error: submitError } = await requireSupabase().rpc('submit_public_admission_application_v2', {
        target_slug: website.slug,
        application_payload: payload,
      });
      if (submitError) throw submitError;
      const submitted = data as { id?: string; reference?: string } | null;
      if (!submitted?.id || !submitted.reference) throw new Error('The application was received but its confirmation number could not be generated. Contact the school before submitting again.');
      setApplicationReference(submitted.reference);

      const failedFiles: string[] = [];
      for (const file of uploadedFiles) {
        const path = `${website.school_id}/${submitted.id}/${safeFileName(file.name)}`;
        try {
          const { error: uploadError } = await requireSupabase().storage.from('admission-documents').upload(path, file, {
            contentType: file.type,
            upsert: false,
          });
          if (uploadError) throw uploadError;
          const { error: metadataError } = await requireSupabase().rpc('add_public_admission_document', {
            target_application: submitted.id,
            target_file_name: file.name,
            target_storage_path: path,
            target_content_type: file.type,
            target_file_size: file.size,
          });
          if (metadataError) throw metadataError;
        } catch (documentError) {
          const { error: removeError } = await requireSupabase().storage.from('admission-documents').remove([path]);
          if (removeError) console.error('Could not remove an unregistered application document.', removeError);
          failedFiles.push(file.name);
          if (documentError instanceof Error) console.error(`Could not attach application document ${file.name}.`, documentError);
        }
      }

      formElement.reset();
      if (resumeToken) window.localStorage.removeItem(`admission-resume:${website.slug}`);
      setResumeToken('');
      setResumeTokenEntry('');
      if (failedFiles.length) {
        setApplicationError(`Your application was received as ${submitted.reference}, but these files could not be attached: ${failedFiles.join(', ')}. Please contact admissions and quote your reference.`);
      } else {
        setApplicationSuccess('Your application has been submitted. Keep this reference number to check its status with your guardian email.');
      }
    } catch (submitError) {
      setApplicationError(getErrorMessage(submitError, 'Could not submit the application. Please try again.'));
    } finally {
      setSubmittingApplication(false);
    }
  }

  async function checkAdmissionStatus(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCheckingApplicationStatus(true);
    setApplicationError('');
    setStatusResult(null);
    try {
      const { data, error: statusError } = await requireSupabase().rpc('get_public_admission_status', {
        target_reference: statusReference.trim(),
        target_guardian_email: statusEmail.trim(),
      });
      if (statusError) throw statusError;
      const record = (data as PublicAdmissionStatus[] | null)?.[0] ?? null;
      setStatusResult(record);
      if (!record) setApplicationError('No application matched that reference and guardian email. Check both details and try again.');
    } catch (statusError) {
      setApplicationError(statusError instanceof Error ? statusError.message : 'Could not check application status.');
    } finally {
      setCheckingApplicationStatus(false);
    }
  }

  async function submitAdmissionEnquiry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!website) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setEnquiryBusy(true);
    setEnquiryResult('');
    setApplicationError('');
    try {
      const { error: enquiryError } = await requireSupabase().rpc('submit_public_admission_enquiry', {
        target_slug: website.slug,
        guardian_name: form.get('enquiry_guardian_name'),
        guardian_email: form.get('enquiry_guardian_email'),
        guardian_phone: form.get('enquiry_guardian_phone'),
        student_name: form.get('enquiry_student_name'),
        applying_for: form.get('enquiry_applying_for'),
        enquiry_message: form.get('enquiry_message'),
      });
      if (enquiryError) throw enquiryError;
      formElement.reset();
      setEnquiryResult('Your enquiry has been sent to the admissions team.');
    } catch (enquiryError) {
      setApplicationError(enquiryError instanceof Error ? enquiryError.message : 'Could not send your enquiry.');
    } finally {
      setEnquiryBusy(false);
    }
  }

  async function bookAdmissionAppointment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!website) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setAppointmentBusy(true);
    setAppointmentResult('');
    setApplicationError('');
    try {
      const { error: bookingError } = await requireSupabase().rpc('book_admission_appointment', {
        target_slug: website.slug,
        target_slot: form.get('slot_id'),
        guardian_name: form.get('booking_guardian_name'),
        guardian_email: form.get('booking_guardian_email'),
        guardian_phone: form.get('booking_guardian_phone'),
        student_name: form.get('booking_student_name'),
        booking_note: form.get('booking_note'),
      });
      if (bookingError) throw bookingError;
      formElement.reset();
      setAppointmentResult('Your booking request has been confirmed.');
      setApplicationError('');
      try {
        const { data, error: slotsError } = await requireSupabase().rpc('get_public_admission_appointment_slots', { target_slug: website.slug });
        if (slotsError) throw slotsError;
        setAdmissionsConfiguration((current) => current ? { ...current, appointment_slots: (data ?? []) as PublicAppointmentSlot[] } : current);
      } catch (slotsError) {
        setApplicationError(slotsError instanceof Error ? `Your booking is confirmed, but availability could not be refreshed: ${slotsError.message}` : 'Your booking is confirmed, but availability could not be refreshed.');
      }
    } catch (bookingError) {
      setApplicationError(bookingError instanceof Error ? bookingError.message : 'Could not book this appointment.');
    } finally {
      setAppointmentBusy(false);
    }
  }

  if (loading) return <main className="public-school-loading"><LoadingState label="Loading school website..." /></main>;
  if (error) return <main className="public-school-unavailable"><ErrorState message={error} /></main>;
  if (!website) return <main className="public-school-unavailable"><BookOpenCheck size={28} /><h1>School website unavailable</h1><p>This website is not published or the address is incorrect.</p><a href="/">Return to Campus Connect</a></main>;

  const accent = website.primary_color || '#5147c7';
  const secondary = website.secondary_color || '#20243a';
  const logoUrl = safeWebsiteUrl(website.logo_path);
  const schoolUrl = safeWebsiteUrl(website.website);
  const visibleResults = results;
  const schoolFees = Array.isArray(website.fees) ? website.fees : [];
  const applicationFields = Array.isArray(admissionsConfiguration?.application_fields) ? admissionsConfiguration.application_fields : [];
  const requiredDocuments = Array.isArray(admissionsConfiguration?.required_documents) ? admissionsConfiguration.required_documents : [];
  const appointmentSlots = Array.isArray(admissionsConfiguration?.appointment_slots) ? admissionsConfiguration.appointment_slots : [];
  const totalMarks = visibleResults.reduce((total, result) => total + Number(result.marks_obtained), 0);
  const possibleMarks = visibleResults.reduce((total, result) => total + Number(result.maximum_marks), 0);
  const average = possibleMarks ? totalMarks / possibleMarks * 100 : 0;

  return (
    <main className="public-school-site" style={{ '--school-accent': accent, '--school-secondary': secondary } as React.CSSProperties}>
      <header className="public-school-header">
        <a className="public-school-brand" href="#home" aria-label={`${website.name} home`}>
          {logoUrl ? <img src={logoUrl} alt="" /> : <span className="public-school-monogram">{website.name.slice(0, 1).toUpperCase()}</span>}
          <span><strong>{website.name}</strong>{website.motto && <small>{website.motto}</small>}</span>
        </a>
        <nav aria-label="School website">
          <a href="#about">About</a>
          <a href="#admissions">Admissions</a>
          {schoolFees.length > 0 && <a href="#fees">Fees</a>}
          {website.public_results_enabled && <a href="#results">Student results</a>}
        </nav>
        {website.admissions_open && website.admissions_applications_enabled && <a className="public-school-header-cta" href="#admission-application">Apply now <ArrowRight size={14} /></a>}
      </header>

      <section id="home" className="public-school-hero">
        <div className="public-school-hero-content">
          <span className="public-school-kicker"><span /> A place to learn and belong</span>
          <h1>{website.hero_title || `Welcome to ${website.name}`}</h1>
          {website.hero_message && <p>{website.hero_message}</p>}
          <div className="public-school-hero-actions">
            <a className="public-school-primary-action" href="#about">Discover our school <ArrowDown size={15} /></a>
            {website.admissions_open && website.admissions_applications_enabled && <a className="public-school-secondary-action" href="#admission-application">Apply online <ArrowRight size={14} /></a>}
          </div>
          <div className="public-school-hero-location"><MapPin size={14} />{website.address || 'A welcoming community for every learner'}</div>
        </div>
        <div className="public-school-hero-art" aria-hidden="true">
          <div className="public-school-art-circle public-school-art-circle-one" />
          <div className="public-school-art-circle public-school-art-circle-two" />
          <div className="public-school-art-card"><GraduationCap size={33} /><span>Curious minds.<br />Bright futures.</span></div>
          <div className="public-school-art-star">+</div>
        </div>
      </section>

      <section id="about" className="public-school-about public-school-section">
        <div><span className="public-school-section-kicker">Our school</span><h2>{website.about_title}</h2></div>
        <div className="public-school-about-copy">
          <p>{website.about_text || 'We are proud to build a welcoming learning community where students are encouraged to explore their interests, develop confidence, and reach their potential.'}</p>
          {schoolUrl && <a href={schoolUrl} target="_blank" rel="noreferrer">Visit our main website <ArrowRight size={14} /></a>}
        </div>
      </section>

      <section id="admissions" className="public-school-admissions public-school-section">
        <div className="public-school-section-heading"><span className="public-school-section-kicker">Join our community</span><h2>{website.admissions_title}</h2><p>{website.admissions_text || 'We welcome families who are looking for a supportive place for their children to learn and grow.'}</p></div>
        <div className="public-school-admissions-card">
          <span className={`public-school-admissions-status${website.admissions_open ? ' open' : ''}`}>{website.admissions_open ? 'Applications open' : 'Enquiries welcome'}</span>
          {website.admissions_deadline && <p className="public-school-deadline"><CalendarDays size={15} />Application deadline: {displayDate(website.admissions_deadline)}</p>}
          {website.admission_requirements && <div className="public-school-requirements"><strong>What to prepare</strong><p>{website.admission_requirements}</p></div>}
          {website.admissions_open && website.admissions_applications_enabled
            ? <a className="public-school-primary-action" href="#admission-application">Apply online <ArrowRight size={15} /></a>
            : website.admissions_email && <a className="public-school-primary-action" href={`mailto:${website.admissions_email}?subject=${encodeURIComponent(`Admissions enquiry - ${website.name}`)}`}>{website.admissions_open ? 'Contact admissions' : 'Make an enquiry'} <ArrowRight size={15} /></a>}
        </div>
      </section>

      {website.admissions_email && <section className="public-admission-status public-school-section">
        <div><span className="public-school-section-kicker">Questions about admissions?</span><h3>Send an enquiry</h3><p>Share your contact details and the admissions team will follow up.</p></div>
        <form className="public-admission-fields" onSubmit={(event) => void submitAdmissionEnquiry(event)}>
          <label><span>Guardian name *</span><input name="enquiry_guardian_name" required minLength={2} maxLength={160} /></label>
          <label><span>Email *</span><input name="enquiry_guardian_email" required type="email" maxLength={254} /></label>
          <label><span>Phone</span><input name="enquiry_guardian_phone" type="tel" maxLength={40} /></label>
          <label><span>Student name *</span><input name="enquiry_student_name" required minLength={2} maxLength={160} /></label>
          <label><span>Applying for</span><input name="enquiry_applying_for" maxLength={100} /></label>
          <label className="public-admission-wide"><span>How can we help? *</span><textarea name="enquiry_message" required minLength={2} maxLength={2000} rows={3} /></label>
          <button type="submit" disabled={enquiryBusy}>{enquiryBusy ? 'Sending…' : 'Send enquiry'}<ArrowRight size={14} /></button>
          {applicationError && <p className="public-school-lookup-error" role="alert">{applicationError}</p>}
          {enquiryResult && <p role="status">{enquiryResult}</p>}
        </form>
      </section>}

      {admissionsConfiguration?.appointments_enabled && appointmentSlots.length > 0 && <section className="public-admission-status public-school-section">
        <div><span className="public-school-section-kicker">Meet the school</span><h3>Book an admissions appointment</h3><p>Choose an available appointment or open day. Remaining places update as families book.</p></div>
        <form className="public-admission-fields" onSubmit={(event) => void bookAdmissionAppointment(event)}>
          <label className="public-admission-wide"><span>Available event *</span><select name="slot_id" required defaultValue=""><option value="" disabled>Select a date</option>{appointmentSlots.map((slot) => <option key={slot.id} value={slot.id}>{slot.title}, {slot.slot_type === 'open_day' ? 'Open day' : 'Appointment'}, {new Date(slot.starts_at).toLocaleString()}, {slot.remaining} place(s)</option>)}</select></label>
          <label><span>Guardian name *</span><input name="booking_guardian_name" required minLength={2} maxLength={160} /></label>
          <label><span>Email *</span><input name="booking_guardian_email" required type="email" maxLength={254} /></label>
          <label><span>Phone</span><input name="booking_guardian_phone" type="tel" maxLength={40} /></label>
          <label><span>Student name *</span><input name="booking_student_name" required minLength={2} maxLength={160} /></label>
          <label className="public-admission-wide"><span>Notes</span><textarea name="booking_note" maxLength={1000} rows={2} /></label>
          <button type="submit" disabled={appointmentBusy}>{appointmentBusy ? 'Booking…' : 'Book place'}<CalendarDays size={14} /></button>
          {applicationError && <p className="public-school-lookup-error" role="alert">{applicationError}</p>}
          {appointmentResult && <p role="status">{appointmentResult}</p>}
        </form>
      </section>}

      {website.admissions_open && website.admissions_applications_enabled && <section id="admission-application" className="public-school-admission-application public-school-section">
        <div className="public-school-section-heading"><span className="public-school-section-kicker">Start your application</span><h2>Apply to {website.name}</h2><p>Complete the student and parent/guardian details below. The school’s admissions team will review the application.</p></div>
        <form ref={applicationFormRef} className="public-admission-form" onSubmit={(event) => void submitAdmission(event)}>
          {applicationError && <div className="public-school-lookup-error" role="alert">{applicationError}</div>}
          {applicationSuccess && <div className="public-admission-success" role="status"><CheckCircle2 size={20} /><div><strong>Application received · {applicationReference}</strong><p>{applicationSuccess}</p></div></div>}
          <div className="public-admission-status-resume"><div><label><span>Resume code</span><input value={resumeTokenEntry} onChange={(event) => setResumeTokenEntry(event.target.value)} minLength={40} maxLength={160} placeholder="Enter your saved application code" /></label><button type="button" onClick={() => void resumeAdmissionDraft()} disabled={!resumeTokenEntry.trim()}>Resume application</button></div>
            {draftError && <p className="public-school-lookup-error" role="alert">{draftError}</p>}
            {draftSuccess && <p role="status">{draftSuccess}</p>}
          </div>
          <div className="public-admission-form-section"><h3>Student information</h3><div className="public-admission-fields">
            <label><span>First name *</span><input name="student_first_name" required maxLength={80} autoComplete="given-name" disabled={submittingApplication} /></label>
            <label><span>Last name *</span><input name="student_last_name" required maxLength={80} autoComplete="family-name" disabled={submittingApplication} /></label>
            <label><span>Date of birth</span><input name="date_of_birth" type="date" max={new Date().toISOString().slice(0, 10)} disabled={submittingApplication} /></label>
            <label><span>Gender</span><select name="gender" defaultValue="" disabled={submittingApplication}><option value="">Prefer not to say</option><option>Female</option><option>Male</option><option>Non-binary</option><option>Other</option></select></label>
            <label><span>Applying for grade / level *</span><input name="applying_for" required maxLength={100} placeholder="For example, Grade 4" disabled={submittingApplication} /></label>
            <label><span>Academic year / intake</span><input name="academic_year" maxLength={100} placeholder="For example, 2027" disabled={submittingApplication} /></label>
            <label><span>Previous school</span><input name="previous_school" maxLength={160} disabled={submittingApplication} /></label>
            <label><span>Student email</span><input name="student_email" type="email" maxLength={254} autoComplete="email" disabled={submittingApplication} /></label>
            <label><span>Student phone</span><input name="student_phone" type="tel" maxLength={40} autoComplete="tel" disabled={submittingApplication} /></label>
            <label className="public-admission-wide"><span>Home address</span><input name="address" maxLength={500} autoComplete="street-address" disabled={submittingApplication} /></label>
          </div></div>
          {applicationFields.length ? <div className="public-admission-form-section"><h3>Additional information</h3><div className="public-admission-fields">
            {applicationFields.map((field) => <label key={field.key} className={field.type === 'textarea' ? 'public-admission-wide' : ''}>
              <span>{field.label}{field.required ? ' *' : ''}</span>
              {field.type === 'textarea' ? <textarea name={`custom_${field.key}`} required={field.required} maxLength={2000} rows={3} disabled={submittingApplication} />
                : field.type === 'select' ? <select name={`custom_${field.key}`} required={field.required} defaultValue="" disabled={submittingApplication}><option value="">Select an option</option>{(Array.isArray(field.options) ? field.options : []).map((option) => <option key={option} value={option}>{option}</option>)}</select>
                  : <input name={`custom_${field.key}`} type={field.type} required={field.required} maxLength={2000} disabled={submittingApplication} />}
            </label>)}
          </div></div> : null}
          <div className="public-admission-form-section"><h3>Parent or guardian</h3><div className="public-admission-fields">
            <label><span>Full name *</span><input name="guardian_name" required minLength={2} maxLength={160} autoComplete="name" disabled={submittingApplication} /></label>
            <label><span>Relationship *</span><input name="guardian_relationship" required maxLength={60} placeholder="Parent, guardian..." disabled={submittingApplication} /></label>
            <label><span>Email *</span><input name="guardian_email" required type="email" maxLength={254} autoComplete="email" disabled={submittingApplication} /></label>
            <label><span>Phone *</span><input name="guardian_phone" required type="tel" minLength={5} maxLength={40} autoComplete="tel" disabled={submittingApplication} /></label>
          </div></div>
          <div className="public-admission-form-section"><h3>Supporting information</h3>
            <label className="public-admission-wide"><span>Notes for the admissions team</span><textarea name="notes" rows={4} maxLength={3000} disabled={submittingApplication} placeholder="Share anything the admissions team should know." /></label>
            <label className="public-admission-upload"><FileText size={18} /><span><strong>Supporting documents</strong><small>PDF, JPG, PNG, DOC or DOCX · up to five files, 10 MB each</small></span><input name="admission_documents" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" disabled={submittingApplication} /></label>
            {!!requiredDocuments.length && <div className="public-admission-required-documents"><strong>Required documents checklist</strong><ul>{requiredDocuments.map((document) => <li key={document.key}>{document.label}</li>)}</ul></div>}
            <p className="public-admission-privacy">Application details and uploaded documents are only available to this school’s authorized admissions administrator.</p>
          </div>
          <div className="public-admission-form-actions"><button className="public-school-secondary-action" type="button" onClick={() => void saveAdmissionDraft()} disabled={savingDraft || submittingApplication}>{savingDraft ? 'Saving draft…' : 'Save and resume later'}</button><button className="public-school-primary-action public-admission-submit" type="submit" disabled={submittingApplication}>{submittingApplication ? 'Submitting application…' : 'Submit application'}<ArrowRight size={16} /></button></div>
        </form>
        <section className="public-admission-status">
          <div><span className="public-school-section-kicker">Already applied?</span><h3>Check application status</h3><p>Enter the reference number and guardian email used in the application.</p></div>
          <form onSubmit={(event) => void checkAdmissionStatus(event)}>
            <label><span>Application reference</span><input value={statusReference} onChange={(event) => setStatusReference(event.target.value)} required maxLength={30} placeholder="ADM-1234567890" /></label>
            <label><span>Guardian email</span><input value={statusEmail} onChange={(event) => setStatusEmail(event.target.value)} required type="email" maxLength={254} /></label>
            <button type="submit" disabled={checkingApplicationStatus}>{checkingApplicationStatus ? 'Checking…' : 'Check status'}</button>
          </form>
          {statusResult && <div className="public-admission-status-result"><strong>{statusResult.student_name} · {statusResult.application_status.replace(/_/g, ' ')}</strong><span>{statusResult.application_reference} · {statusResult.applying_for}</span>{statusResult.decision_note && <p>{statusResult.decision_note}</p>}<small>Last updated {displayDate(statusResult.updated_at)}</small></div>}
        </section>
      </section>}

      {schoolFees.length > 0 && <section id="fees" className="public-school-fees public-school-section">
        <div className="public-school-section-heading"><span className="public-school-section-kicker">Planning ahead</span><h2>Fee structure</h2><p>Published tuition information. Please contact the school to confirm the latest fees and payment options.</p></div>
        <div className="public-school-fees-table-wrap"><table className="public-school-fees-table"><thead><tr><th>Class / level</th><th>Tuition</th><th>Payment schedule</th><th>Additional information</th></tr></thead><tbody>{schoolFees.map((fee, index) => <tr key={`${fee.level}-${index}`}><td><strong>{fee.level}</strong></td><td>{fee.currency} {Number(fee.tuition).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td><td>{fee.frequency}</td><td>{fee.additional || 'Contact the school for details'}</td></tr>)}</tbody></table></div>
      </section>}

      {website.public_results_enabled && <section id="results" className="public-school-results public-school-section">
        <div className="public-school-results-intro"><span className="public-school-section-kicker">Student portal</span><h2>Check student results</h2><p>Enter the student number provided by the school to view published assessment results.</p><div className="public-school-results-privacy"><ShieldCheck size={16} />Only results the school has approved and published are shown.</div></div>
        <div className="public-school-results-card">
          <form onSubmit={(event) => void checkResults(event)}>
            <label htmlFor="public-student-number">Student number</label>
            <div className="public-school-search-field"><input id="public-student-number" required maxLength={80} autoComplete="off" value={studentNumber} onChange={(event) => setStudentNumber(event.target.value)} placeholder="Enter student number" /><button type="submit" disabled={searching}><Search size={16} />{searching ? 'Checking...' : 'Check results'}</button></div>
          </form>
          <p className="public-school-lookup-disclaimer">Anyone who knows this student number can view the student's published results. Keep student numbers private.</p>
          {searchError && <div className="public-school-lookup-error" role="status">{searchError}</div>}
          {searched && visibleResults.length > 0 && <div className="public-school-result-summary" aria-live="polite">
            <div className="public-school-result-student"><span><CheckCircle2 size={16} />Published results</span><strong>{visibleResults[0].first_name} {visibleResults[0].last_name}</strong><small>Student number · {visibleResults[0].student_number}</small></div>
            <div className="public-school-result-overview"><span>Assessments<strong>{visibleResults.length}</strong></span><span>Total marks<strong>{totalMarks.toFixed(1)} / {possibleMarks.toFixed(1)}</strong></span><span>Overall<strong>{average.toFixed(1)}%</strong></span></div>
            <div className="public-school-result-list">{visibleResults.map((result, index) => <article key={`${result.assessment_date}-${result.subject}-${result.assessment_title}-${index}`}><div><span>{result.subject || 'Assessment'} · {displayDate(result.assessment_date)}</span><strong>{result.assessment_title}</strong>{result.teacher_comment && <p>{result.teacher_comment}</p>}</div><strong>{Number(result.marks_obtained).toFixed(1)} / {Number(result.maximum_marks).toFixed(1)}<small>{Number(result.percentage).toFixed(1)}%</small></strong></article>)}</div>
          </div>}
        </div>
      </section>}

      <footer className="public-school-footer">
        <div><a className="public-school-brand" href="#home"><span className="public-school-monogram">{website.name.slice(0, 1).toUpperCase()}</span><span><strong>{website.name}</strong>{website.motto && <small>{website.motto}</small>}</span></a><p>{website.motto || 'Learning, belonging, growing.'}</p></div>
        <div className="public-school-footer-contact">{website.address && <span><MapPin size={14} />{website.address}</span>}{website.contact_email && <a href={`mailto:${website.contact_email}`}>{website.contact_email}</a>}{website.contact_phone && <a href={`tel:${website.contact_phone}`}>{website.contact_phone}</a>}</div>
        <span className="public-school-footer-credit">School website · Campus Connect</span>
      </footer>
    </main>
  );
}
