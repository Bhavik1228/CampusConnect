import { useEffect, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowRight, BookOpenCheck, CalendarDays, CheckCircle2, GraduationCap, MapPin, Search, ShieldCheck } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type PublicWebsite = {
  school_id: string;
  slug: string;
  public_results_enabled: boolean;
  hero_title: string;
  hero_message: string;
  about_title: string;
  about_text: string;
  admissions_open: boolean;
  admissions_title: string;
  admissions_text: string;
  admission_requirements: string;
  admissions_deadline: string | null;
  admissions_email: string | null;
  fees: { level: string; tuition: number; currency: string; frequency: string; additional: string }[];
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

export function PublicSchoolWebsitePage() {
  const { slug = '' } = useParams();
  const [website, setWebsite] = useState<PublicWebsite | null>(null);
  const [studentNumber, setStudentNumber] = useState('');
  const [results, setResults] = useState<PublicResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
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
      const records = (data ?? []) as PublicResult[];
      setResults(records);
      setSearched(true);
      if (records.length === 0) setSearchError('No published results were found for that student number. Check the number with the school and try again.');
    } catch (lookupError) {
      setSearchError(lookupError instanceof Error ? lookupError.message : 'Could not check results. Please try again.');
    } finally {
      setSearching(false);
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
          {website.fees.length > 0 && <a href="#fees">Fees</a>}
          {website.public_results_enabled && <a href="#results">Student results</a>}
        </nav>
        {website.admissions_open && website.admissions_email && <a className="public-school-header-cta" href={`mailto:${website.admissions_email}`}>Apply now <ArrowRight size={14} /></a>}
      </header>

      <section id="home" className="public-school-hero">
        <div className="public-school-hero-content">
          <span className="public-school-kicker"><span /> A place to learn and belong</span>
          <h1>{website.hero_title || `Welcome to ${website.name}`}</h1>
          {website.hero_message && <p>{website.hero_message}</p>}
          <div className="public-school-hero-actions">
            <a className="public-school-primary-action" href="#about">Discover our school <ArrowDown size={15} /></a>
            {website.admissions_open && website.admissions_email && <a className="public-school-secondary-action" href={`mailto:${website.admissions_email}`}>Admissions are open <ArrowRight size={14} /></a>}
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
          {website.admissions_email && <a className="public-school-primary-action" href={`mailto:${website.admissions_email}?subject=${encodeURIComponent(`Admissions enquiry - ${website.name}`)}`}>{website.admissions_open ? 'Contact admissions' : 'Make an enquiry'} <ArrowRight size={15} /></a>}
        </div>
      </section>

      {website.fees.length > 0 && <section id="fees" className="public-school-fees public-school-section">
        <div className="public-school-section-heading"><span className="public-school-section-kicker">Planning ahead</span><h2>Fee structure</h2><p>Published tuition information. Please contact the school to confirm the latest fees and payment options.</p></div>
        <div className="public-school-fees-table-wrap"><table className="public-school-fees-table"><thead><tr><th>Class / level</th><th>Tuition</th><th>Payment schedule</th><th>Additional information</th></tr></thead><tbody>{website.fees.map((fee, index) => <tr key={`${fee.level}-${index}`}><td><strong>{fee.level}</strong></td><td>{fee.currency} {Number(fee.tuition).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td><td>{fee.frequency}</td><td>{fee.additional || 'Contact the school for details'}</td></tr>)}</tbody></table></div>
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
