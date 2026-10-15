import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  BadgeCheck, Camera, Check, Download, IdCard, LogIn, LogOut, MailPlus, Pencil, Plus,
  Printer, QrCode, Search, ShieldCheck, UserRound, Users, X,
} from 'lucide-react';
import jsPDF from 'jspdf';
import QRCode from 'qrcode';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type VisitStatus = 'expected' | 'checked_in' | 'checked_out' | 'cancelled';
type VisitorRecord = {
  id: string;
  school_id: string;
  badge_number: string;
  visitor_name: string;
  phone: string;
  organization: string;
  purpose: string;
  host_name: string;
  host_department: string;
  id_type: string;
  id_number: string;
  photo_path: string | null;
  visit_date: string;
  valid_until: string;
  status: VisitStatus;
  arrived_at: string | null;
  departed_at: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
};
type AuditEntry = {
  id: number;
  visitor_id: string;
  actor_id: string | null;
  action: string;
  changed_fields: string[];
  created_at: string;
};
type VisitorForm = {
  visitor_name: string;
  phone: string;
  organization: string;
  purpose: string;
  host_name: string;
  host_department: string;
  id_type: string;
  id_number: string;
  visit_date: string;
  valid_until: string;
};
type SchoolBrand = { name: string; logo_path: string | null };

const today = () => {
  const date = new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const emptyForm = (): VisitorForm => ({
  visitor_name: '',
  phone: '',
  organization: '',
  purpose: '',
  host_name: '',
  host_department: '',
  id_type: '',
  id_number: '',
  visit_date: today(),
  valid_until: today(),
});
const statusLabels: Record<VisitStatus, string> = {
  expected: 'Expected',
  checked_in: 'Checked In',
  checked_out: 'Checked Out',
  cancelled: 'Cancelled',
};
const allowedPhotoTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function formatTimestamp(value: string | null) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
}

function imageDataUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('Could not prepare a badge image.'));
        return;
      }
      context.drawImage(image, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    image.onerror = () => reject(new Error('Could not load the badge image.'));
    image.src = url;
  });
}

export function VisitorsPage() {
  const { activeMembership } = useAuth();
  const { visitId: verifiedVisitId } = useParams<{ visitId: string }>();
  const navigate = useNavigate();
  const schoolId = activeMembership?.school_id;
  const isAdmin = activeMembership?.role === 'school_admin';
  const canManageVisitors = isAdmin || activeMembership?.role === 'secretary';
  const [school, setSchool] = useState<SchoolBrand | null>(null);
  const [records, setRecords] = useState<VisitorRecord[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [form, setForm] = useState<VisitorForm>(emptyForm);
  const [formOpen, setFormOpen] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<VisitStatus | 'all'>('all');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState('');
  const [schoolLogoUrl, setSchoolLogoUrl] = useState('');
  const [badgeQr, setBadgeQr] = useState('');
  const [showBadgePreview, setShowBadgePreview] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [success, setSuccess] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);

  const selected = records.find((record) => record.id === selectedId) ?? null;
  const verifiedVisit = verifiedVisitId ? records.find((record) => record.id === verifiedVisitId) ?? null : null;
  const filteredRecords = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return records.filter((record) => (statusFilter === 'all' || record.status === statusFilter)
      && (!needle || `${record.visitor_name} ${record.phone} ${record.organization} ${record.host_name} ${record.badge_number}`
        .toLowerCase().includes(needle)));
  }, [records, query, statusFilter]);
  const checkedIn = records.filter((record) => record.status === 'checked_in');
  const isSelectedBadgeValid = Boolean(selected && selected.valid_until >= today()
    && (selected.status === 'expected' || selected.status === 'checked_in'));
  const isVerifiedBadgeValid = Boolean(verifiedVisit && verifiedVisit.valid_until >= today()
    && (verifiedVisit.status === 'expected' || verifiedVisit.status === 'checked_in'));

  const loadRecords = useCallback(async () => {
    if (!schoolId || !canManageVisitors) {
      setRecords([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [recordsResult, schoolResult] = await Promise.all([
        client.from('visitor_records')
          .select('id,school_id,badge_number,visitor_name,phone,organization,purpose,host_name,host_department,id_type,id_number,photo_path,visit_date,valid_until,status,arrived_at,departed_at,created_by,updated_by,created_at,updated_at')
          .eq('school_id', schoolId)
          .order('visit_date', { ascending: false }).order('created_at', { ascending: false })
          .limit(1000),
        client.from('schools').select('name,logo_path').eq('id', schoolId).single(),
      ]);
      if (recordsResult.error) throw recordsResult.error;
      if (schoolResult.error) throw schoolResult.error;
      const rows = (recordsResult.data ?? []) as VisitorRecord[];
      setRecords(rows);
      setSchool(schoolResult.data as SchoolBrand);
      setSelectedId((current) => rows.some((record) => record.id === current)
        ? current
        : verifiedVisitId && rows.some((record) => record.id === verifiedVisitId)
          ? verifiedVisitId
          : rows[0]?.id ?? '');
    } catch (loadError) {
      setError(errorMessage(loadError, 'Could not load visitor records.'));
    } finally {
      setLoading(false);
    }
  }, [schoolId, canManageVisitors, verifiedVisitId]);

  useEffect(() => { void loadRecords(); }, [loadRecords, refreshKey]);

  useEffect(() => {
    if (!school?.logo_path || !/^https?:\/\//i.test(school.logo_path)) {
      setSchoolLogoUrl('');
      return;
    }
    setSchoolLogoUrl(school.logo_path);
  }, [school?.logo_path]);

  useEffect(() => {
    let active = true;
    if (!selected?.photo_path) {
      setPhotoUrl('');
      return () => { active = false; };
    }
    void (async () => {
      try {
        const { data, error: signError } = await requireSupabase().storage.from('visitor-photos')
          .createSignedUrl(selected.photo_path as string, 300);
        if (signError) throw signError;
        if (active) setPhotoUrl(data.signedUrl);
      } catch (photoError) {
        if (active) setError(errorMessage(photoError, 'Could not load the visitor photo.'));
      }
    })();
    return () => { active = false; };
  }, [selected?.photo_path]);

  useEffect(() => {
    let active = true;
    if (!schoolId || !selectedId || !canManageVisitors) {
      setAudit([]);
      return () => { active = false; };
    }
    void (async () => {
      try {
        const { data, error: auditError } = await requireSupabase().from('visitor_audit_events')
          .select('id,visitor_id,actor_id,action,changed_fields,created_at')
          .eq('school_id', schoolId).eq('visitor_id', selectedId)
          .order('created_at', { ascending: false }).limit(50);
        if (auditError) throw auditError;
        if (active) setAudit((data ?? []) as AuditEntry[]);
      } catch (auditError) {
        if (active) setError(errorMessage(auditError, 'Could not load visitor record history.'));
      }
    })();
    return () => { active = false; };
  }, [schoolId, selectedId, canManageVisitors, refreshKey]);

  useEffect(() => {
    let active = true;
    if (!selected || !showBadgePreview) {
      setBadgeQr('');
      return () => { active = false; };
    }
    const badgeUrl = new URL(`/visitors/verify/${selected.id}`, window.location.origin).toString();
    void QRCode.toDataURL(badgeUrl, { errorCorrectionLevel: 'Q', margin: 1, width: 300 })
      .then((code) => { if (active) setBadgeQr(code); })
      .catch((qrError: unknown) => {
        if (active) setError(errorMessage(qrError, 'Could not generate the visitor badge QR code.'));
      });
    return () => { active = false; };
  }, [selected?.id, showBadgePreview]);

  useEffect(() => {
    if (!verifiedVisitId || !records.some((record) => record.id === verifiedVisitId)) return;
    setSelectedId(verifiedVisitId);
    setShowBadgePreview(true);
  }, [verifiedVisitId, records]);

  useEffect(() => {
    if (!scanning) return;
    let active = true;
    let stream: MediaStream | null = null;
    let timeout = 0;
    const Detector = (window as Window & {
      BarcodeDetector?: new (options: { formats: string[] }) => {
        detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]>
      };
    }).BarcodeDetector;

    async function startCamera() {
      try {
        if (!Detector) throw new Error('QR scanning is not supported by this browser. Open the badge QR link or search by badge number.');
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access requires a secure HTTPS connection.');
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } }, audio: false,
        });
        if (!active) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        const video = videoRef.current;
        if (!video) throw new Error('The QR scanner could not be initialized.');
        video.srcObject = stream;
        await video.play();
        const detector = new Detector({ formats: ['qr_code'] });
        const scan = async () => {
          if (!active || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes[0]?.rawValue) {
              const scannedUrl = new URL(codes[0].rawValue, window.location.origin);
              const match = scannedUrl.pathname.match(/^\/visitors\/verify\/([0-9a-f-]{36})$/i);
              if (!match) throw new Error('This QR code is not a valid Campus Connect visitor badge.');
              setScanning(false);
              setScanError('');
              navigate(`/visitors/verify/${match[1]}`);
              return;
            }
          } catch (scanFailure) {
            if (scanFailure instanceof Error && scanFailure.message.includes('not a valid Campus Connect')) {
              setScanError(scanFailure.message);
              setScanning(false);
              return;
            }
            console.error('Visitor badge QR scan failed.', scanFailure);
          }
          timeout = window.setTimeout(() => { void scan(); }, 350);
        };
        void scan();
      } catch (cameraError) {
        if (active) {
          setScanError(errorMessage(cameraError, 'Could not start the badge QR scanner.'));
          setScanning(false);
        }
      }
    }

    void startCamera();
    return () => {
      active = false;
      window.clearTimeout(timeout);
      stream?.getTracks().forEach((track) => track.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [scanning, navigate]);

  function startNewRecord() {
    setSelectedId('');
    setFormOpen(true);
    setForm(emptyForm());
    setPhotoFile(null);
    setShowBadgePreview(false);
    setFormError('');
    setSuccess('');
  }

  function editRecord(record: VisitorRecord) {
    setSelectedId(record.id);
    setFormOpen(true);
    setForm({
      visitor_name: record.visitor_name,
      phone: record.phone,
      organization: record.organization,
      purpose: record.purpose,
      host_name: record.host_name,
      host_department: record.host_department,
      id_type: record.id_type,
      id_number: record.id_number,
      visit_date: record.visit_date,
      valid_until: record.valid_until,
    });
    setPhotoFile(null);
    setShowBadgePreview(false);
    setFormError('');
    setSuccess('');
  }

  async function saveRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !canManageVisitors) return;
    const formElement = event.currentTarget;
    const visitId = selectedId || crypto.randomUUID();
    let uploadedPhotoPath = '';
    setSaving(true);
    setFormError('');
    setSuccess('');
    try {
      if (photoFile) {
        if (!allowedPhotoTypes.has(photoFile.type) || photoFile.size > 5 * 1024 * 1024) {
          throw new Error('Choose a JPEG, PNG or WebP photo up to 5 MB.');
        }
        const extension = photoFile.type === 'image/jpeg' ? 'jpg' : photoFile.type === 'image/png' ? 'png' : 'webp';
        uploadedPhotoPath = `${schoolId}/${visitId}/${crypto.randomUUID()}.${extension}`;
        const { error: uploadError } = await requireSupabase().storage.from('visitor-photos')
          .upload(uploadedPhotoPath, photoFile, { contentType: photoFile.type, upsert: false });
        if (uploadError) throw uploadError;
      }

      const { data, error: saveError } = await requireSupabase().rpc('save_visitor_record', {
        target_school: schoolId,
        target_visit: visitId,
        visitor_data: {
          ...form,
          photo_path: uploadedPhotoPath || selected?.photo_path || null,
        },
      });
      if (saveError) throw saveError;
      if (typeof data !== 'string') throw new Error('The visitor record was saved without returning its badge ID.');
      setSelectedId(data);
      setFormOpen(false);
      setPhotoFile(null);
      setSuccess('Visitor record saved. Preview and print the badge before giving it to the visitor.');
      setShowBadgePreview(true);
      setRefreshKey((value) => value + 1);
      formElement.reset();
    } catch (saveError) {
      if (uploadedPhotoPath) {
        const { error: cleanupError } = await requireSupabase().storage.from('visitor-photos').remove([uploadedPhotoPath]);
        if (cleanupError) console.error('Could not remove the unused visitor photo.', cleanupError);
      }
      setFormError(errorMessage(saveError, 'Could not save the visitor record.'));
    } finally {
      setSaving(false);
    }
  }

  async function updateStatus(record: VisitorRecord, nextStatus: 'checked_in' | 'checked_out' | 'cancelled') {
    if (!schoolId) return;
    setError('');
    setSuccess('');
    try {
      const { data, error: statusError } = await requireSupabase().rpc('transition_visitor_status', {
        target_school: schoolId,
        target_visit: record.id,
        next_status: nextStatus,
      });
      if (statusError) throw statusError;
      if (!data) throw new Error('Visitor status was not returned after update.');
      setSuccess(`${record.visitor_name} marked ${statusLabels[nextStatus].toLowerCase()}.`);
      setRefreshKey((value) => value + 1);
    } catch (statusError) {
      setError(errorMessage(statusError, 'Could not update visitor status.'));
    }
  }

  async function inviteSecretary(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId) return;
    const formElement = event.currentTarget;
    setInviting(true);
    setFormError('');
    setSuccess('');
    const data = new FormData(event.currentTarget);
    try {
      const response = await requireSupabase().functions.invoke('staff-invite', {
        body: {
          schoolId,
          fullName: String(data.get('full_name') ?? '').trim(),
          email: String(data.get('email') ?? '').trim(),
          role: 'secretary',
        },
      });
      if (response.error) {
        const body = response.error.context instanceof Response
          ? await response.error.context.json() as { error?: string }
          : null;
        throw new Error(body?.error ?? response.error.message);
      }
      if (response.data?.error) throw new Error(response.data.error);
      formElement.reset();
      setSuccess('Secretary invitation sent by email.');
    } catch (inviteError) {
      setFormError(errorMessage(inviteError, 'Could not invite the school secretary.'));
    } finally {
      setInviting(false);
    }
  }

  async function openBadgePreview(record: VisitorRecord) {
    setSelectedId(record.id);
    setFormOpen(false);
    setShowBadgePreview(true);
  }

  async function downloadBadge(record: VisitorRecord) {
    if (!school) return;
    setError('');
    try {
      const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: [90, 60] });
      const width = 90;
      const height = 60;
      pdf.setFillColor(248, 249, 253);
      pdf.roundedRect(2, 2, width - 4, height - 4, 3, 3, 'F');
      pdf.setDrawColor(91, 80, 163);
      pdf.setLineWidth(0.7);
      pdf.roundedRect(2, 2, width - 4, height - 4, 3, 3);
      pdf.setFillColor(65, 57, 126);
      pdf.roundedRect(2, 2, width - 4, 13, 3, 3, 'F');
      pdf.rect(2, 10, width - 4, 5, 'F');
      if (schoolLogoUrl) {
        try {
          const logo = await imageDataUrl(schoolLogoUrl);
          pdf.addImage(logo, 'PNG', 6, 4, 8, 8);
        } catch (logoError) {
          console.warn('School logo could not be added to the visitor badge.', logoError);
        }
      }
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.setTextColor(255, 255, 255);
      pdf.text(school.name.slice(0, 42), 17, 8.5);
      pdf.setFontSize(6);
      pdf.text('VISITOR PASS', 17, 12);

      pdf.setTextColor(42, 45, 63);
      pdf.setFontSize(10);
      pdf.text(record.visitor_name.slice(0, 34), 7, 22);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(6.5);
      const details = [
        `Host: ${record.host_name}${record.host_department ? ` · ${record.host_department}` : ''}`,
        `Purpose: ${record.purpose}`,
        `Visit date: ${record.visit_date}  ·  Valid through: ${record.valid_until}`,
        `Badge: ${record.badge_number}  ·  ${statusLabels[record.status]}`,
      ];
      let y = 28;
      for (const detail of details) {
        const lines = pdf.splitTextToSize(detail, 53) as string[];
        pdf.text(lines.slice(0, 2), 7, y);
        y += lines.length > 1 ? 6 : 4;
      }
      if (badgeQr && record.id === selectedId) {
        pdf.addImage(badgeQr, 'PNG', 66, 20, 18, 18);
      } else {
        const url = new URL(`/visitors/verify/${record.id}`, window.location.origin).toString();
        const qr = await QRCode.toDataURL(url, { errorCorrectionLevel: 'Q', margin: 1, width: 260 });
        pdf.addImage(qr, 'PNG', 66, 20, 18, 18);
      }
      if (photoUrl && record.photo_path && record.id === selectedId) {
        try {
          const photo = await imageDataUrl(photoUrl);
          pdf.addImage(photo, 'PNG', 66, 40, 15, 15);
        } catch (photoError) {
          console.warn('Visitor photo could not be added to the badge.', photoError);
        }
      }
      pdf.setFontSize(5.5);
      pdf.setTextColor(110, 113, 128);
      pdf.text('Show this badge to school staff. QR verification requires authorized sign-in.', 7, 56);
      pdf.save(`visitor-badge-${record.badge_number.toLowerCase()}.pdf`);
    } catch (pdfError) {
      setError(errorMessage(pdfError, 'Could not create the visitor badge PDF.'));
    }
  }

  function printBadge() {
    if (!selected) return;
    window.print();
  }

  if (!canManageVisitors) {
    return <div className="page-stack"><ErrorState message="Visitor records are available only to this school’s administrator and assigned secretary." /></div>;
  }

  if (loading) return <div className="page-stack"><LoadingState label="Loading visitor management…" /></div>;

  return (
    <div className="page-stack visitor-page">
      <header className="page-heading">
        <div><span className="eyebrow">School reception</span><h1>Visitor management</h1><p>Register visitors, manage check-in and check-out, and issue secure QR badges.</p></div>
        <div className="visitor-heading-actions">
          <button className="button button-secondary" type="button" onClick={() => { setScanError(''); setScanning(true); }}><Camera size={16} />Scan badge</button>
          <button className="button button-primary" type="button" onClick={startNewRecord}><Plus size={16} />Register visitor</button>
        </div>
      </header>

      {error && <ErrorState message={error} />}
      {success && <SuccessMessage message={success} />}
      {scanError && <ErrorState message={scanError} />}

      {isAdmin && <section className="content-card visitor-secretary-invite">
        <div className="section-heading"><div><span className="eyebrow">Role access</span><h2>Invite a school secretary</h2></div><MailPlus size={20} className="muted-icon" /></div>
        <p>Secretaries can access visitor registration, badges and the reception check-in desk only.</p>
        {formError && <ErrorState message={formError} />}
        <form className="visitor-invite-form" onSubmit={(event) => void inviteSecretary(event)}>
          <label className="field"><span>Full name</span><input name="full_name" required minLength={2} maxLength={120} disabled={inviting} /></label>
          <label className="field"><span>Work email</span><input name="email" type="email" required maxLength={320} disabled={inviting} /></label>
          <button className="button button-quiet" type="submit" disabled={inviting}><MailPlus size={15} />{inviting ? 'Sending…' : 'Invite secretary'}</button>
        </form>
      </section>}

      <section className="visitor-summary-grid">
        <article className="content-card visitor-summary-card"><span className="visitor-summary-icon"><Users size={19} /></span><div><span className="eyebrow">Checked in now</span><strong>{checkedIn.length}</strong><small>Active visitors on campus</small></div></article>
        <article className="content-card visitor-summary-card"><span className="visitor-summary-icon"><BadgeCheck size={19} /></span><div><span className="eyebrow">Visits recorded</span><strong>{records.length}</strong><small>Recent visitor records</small></div></article>
      </section>

      <section className="visitor-desk-grid">
        <article className="content-card visitor-records-card">
          <div className="section-heading"><div><span className="eyebrow">Reception desk</span><h2>Visitor records</h2></div><IdCard size={19} className="muted-icon" /></div>
          <div className="visitor-tools">
            <label className="visitor-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search visitor, phone, host or badge" /></label>
            <select aria-label="Filter by visitor status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as VisitStatus | 'all')}>
              <option value="all">All statuses</option><option value="expected">Expected</option><option value="checked_in">Checked In</option><option value="checked_out">Checked Out</option><option value="cancelled">Cancelled</option>
            </select>
          </div>
          {filteredRecords.length === 0 ? <EmptyState title="No visitor records found" detail="Register an expected visitor or change the search filters." /> : <div className="visitor-record-list">
            {filteredRecords.map((record) => <article className={`visitor-record-row${selectedId === record.id ? ' selected' : ''}`} key={record.id}>
              <button className="visitor-record-main" type="button" onClick={() => { setSelectedId(record.id); setFormOpen(false); setShowBadgePreview(false); }}>
                <span className="visitor-record-avatar">{record.visitor_name.slice(0, 1).toUpperCase()}</span>
                <span className="visitor-record-copy"><strong>{record.visitor_name}</strong><small>{record.phone} · {record.host_name}</small><small>{record.visit_date} · {record.badge_number}</small></span>
                <span className={`visitor-status visitor-status-${record.status}`}>{statusLabels[record.status]}</span>
              </button>
              <div className="visitor-record-actions">
                {(record.status === 'expected' || record.status === 'checked_in') && <button className="button button-quiet" type="button" onClick={() => editRecord(record)}><Pencil size={14} />Correct</button>}
                {record.status === 'expected' && <button className="button button-primary" type="button" onClick={() => void updateStatus(record, 'checked_in')}><LogIn size={14} />Check in</button>}
                {record.status === 'checked_in' && <button className="button button-secondary" type="button" onClick={() => void updateStatus(record, 'checked_out')}><LogOut size={14} />Check out</button>}
                {record.status === 'expected' && <button className="icon-button" type="button" title="Cancel expected visit" aria-label="Cancel expected visit" onClick={() => void updateStatus(record, 'cancelled')}><X size={15} /></button>}
                <button className="icon-button" type="button" title="Preview visitor badge" aria-label="Preview visitor badge" onClick={() => void openBadgePreview(record)}><QrCode size={15} /></button>
              </div>
              {record.status === 'checked_in' && <small className="visitor-arrival-line">Arrived {formatTimestamp(record.arrived_at)}</small>}
            </article>)}
          </div>}
        </article>

        <div className="visitor-side-column">
          <article className="content-card visitor-current-card">
            <div className="section-heading"><div><span className="eyebrow">Live reception</span><h2>Currently checked in</h2></div><Check size={19} className="muted-icon" /></div>
            {checkedIn.length === 0 ? <p className="visitor-muted">No visitors are currently checked in.</p> : <div className="visitor-current-list">
              {checkedIn.map((record) => <div className="visitor-current-row" key={record.id}><div><strong>{record.visitor_name}</strong><span>{record.host_name}{record.host_department ? ` · ${record.host_department}` : ''}</span><small>Arrived {formatTimestamp(record.arrived_at)}</small></div><button className="button button-secondary" type="button" onClick={() => void updateStatus(record, 'checked_out')}><LogOut size={14} />Check out</button></div>)}
            </div>}
          </article>

          {selected && <article className="content-card visitor-detail-card">
            <div className="section-heading"><div><span className="eyebrow">Selected visit</span><h2>{selected.visitor_name}</h2></div><ShieldCheck size={19} className="muted-icon" /></div>
            <dl className="visitor-detail-list">
              <div><dt>Organization</dt><dd>{selected.organization || '—'}</dd></div>
              <div><dt>Purpose</dt><dd>{selected.purpose}</dd></div>
              <div><dt>Host</dt><dd>{selected.host_name}{selected.host_department ? ` · ${selected.host_department}` : ''}</dd></div>
              <div><dt>Visitor ID</dt><dd>{selected.id_type ? `${selected.id_type}: ${selected.id_number || '—'}` : 'Not provided'}</dd></div>
              <div><dt>Visit / validity</dt><dd>{selected.visit_date} · through {selected.valid_until}</dd></div>
              <div><dt>Arrival / departure</dt><dd>{formatTimestamp(selected.arrived_at)} / {formatTimestamp(selected.departed_at)}</dd></div>
            </dl>
            <div className="visitor-record-actions visitor-detail-actions">
              <button className="button button-secondary" type="button" onClick={() => void openBadgePreview(selected)}><QrCode size={14} />Preview badge</button>
              <button className="button button-quiet" type="button" onClick={() => navigate(`/visitors/verify/${selected.id}`)}><BadgeCheck size={14} />Verify</button>
            </div>
          </article>}

          {selected && audit.length > 0 && <article className="content-card visitor-audit-card">
            <div className="section-heading"><div><span className="eyebrow">Record history</span><h2>Changes logged</h2></div><ShieldCheck size={18} className="muted-icon" /></div>
            {audit.map((entry) => <div className="visitor-audit-row" key={entry.id}><strong>{entry.action.replace('_', ' ')}</strong><span>{entry.changed_fields.join(', ') || 'Record status'}</span><small>{formatTimestamp(entry.created_at)}</small></div>)}
          </article>}
        </div>
      </section>

      {formOpen && !verifiedVisitId && <section className="content-card visitor-form-card">
        <div className="section-heading"><div><span className="eyebrow">{selected ? 'Correct visitor record' : 'New visit'}</span><h2>{selected ? 'Edit visit details' : 'Register a visitor'}</h2></div><UserRound size={19} className="muted-icon" /></div>
        {formError && <ErrorState message={formError} />}
        <form className="visitor-form-grid" onSubmit={(event) => void saveRecord(event)}>
          <label className="field"><span>Visitor name *</span><input required maxLength={160} value={form.visitor_name} onChange={(event) => setForm({ ...form, visitor_name: event.target.value })} /></label>
          <label className="field"><span>Phone number *</span><input type="tel" required maxLength={40} value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
          <label className="field"><span>Organization</span><input maxLength={160} value={form.organization} onChange={(event) => setForm({ ...form, organization: event.target.value })} /></label>
          <label className="field"><span>Person being visited *</span><input required maxLength={160} value={form.host_name} onChange={(event) => setForm({ ...form, host_name: event.target.value })} /></label>
          <label className="field"><span>Department</span><input maxLength={120} value={form.host_department} onChange={(event) => setForm({ ...form, host_department: event.target.value })} /></label>
          <label className="field"><span>Visit date</span><input type="date" required value={form.visit_date} onChange={(event) => setForm({ ...form, visit_date: event.target.value, valid_until: form.valid_until < event.target.value ? event.target.value : form.valid_until })} /></label>
          <label className="field"><span>Badge valid through</span><input type="date" required min={form.visit_date} value={form.valid_until} onChange={(event) => setForm({ ...form, valid_until: event.target.value })} /></label>
          <label className="field"><span>ID type (optional)</span><input maxLength={80} placeholder="Passport, national ID…" value={form.id_type} onChange={(event) => setForm({ ...form, id_type: event.target.value })} /></label>
          <label className="field"><span>ID number (optional)</span><input maxLength={120} value={form.id_number} onChange={(event) => setForm({ ...form, id_number: event.target.value })} /></label>
          <label className="field visitor-span-two"><span>Purpose of visit *</span><textarea required maxLength={2000} value={form.purpose} onChange={(event) => setForm({ ...form, purpose: event.target.value })} /></label>
          <label className="field visitor-span-two"><span>Photo (optional, JPEG/PNG/WebP up to 5 MB)</span><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setPhotoFile(event.target.files?.[0] ?? null)} /></label>
          <div className="visitor-form-actions visitor-span-two"><button className="button button-primary" type="submit" disabled={saving}><Check size={15} />{saving ? 'Saving…' : selectedId ? 'Save correction' : 'Register expected visitor'}</button>{selectedId && <button className="button button-quiet" type="button" onClick={startNewRecord}><Plus size={15} />New visitor</button>}</div>
        </form>
      </section>}

      {showBadgePreview && selected && <section className="content-card visitor-badge-section">
        <div className="section-heading"><div><span className="eyebrow">Badge preview</span><h2>Visitor pass · {selected.badge_number}</h2></div><button className="icon-button" type="button" aria-label="Close badge preview" onClick={() => setShowBadgePreview(false)}><X size={16} /></button></div>
        <div className={`visitor-badge-preview${!isSelectedBadgeValid ? ' invalid' : ''}`}>
          <header>{schoolLogoUrl ? <img src={schoolLogoUrl} alt="" /> : <span className="visitor-badge-monogram">{school?.name.slice(0, 1) ?? 'S'}</span>}<div><strong>{school?.name ?? 'School'}</strong><span>VISITOR PASS</span></div></header>
          <div className="visitor-badge-content">
            {photoUrl ? <img className="visitor-badge-photo" src={photoUrl} alt={`${selected.visitor_name}`} /> : <span className="visitor-badge-photo-placeholder">{selected.visitor_name.slice(0, 1)}</span>}
            <div className="visitor-badge-data"><strong>{selected.visitor_name}</strong><span>Host: {selected.host_name}{selected.host_department ? ` · ${selected.host_department}` : ''}</span><span>Purpose: {selected.purpose}</span><span>Date: {selected.visit_date} · valid through {selected.valid_until}</span><span>Badge {selected.badge_number} · {statusLabels[selected.status]}</span></div>
            {badgeQr ? <img className="visitor-badge-qr" src={badgeQr} alt="Badge verification QR code" /> : <div className="visitor-badge-qr-placeholder">Generating QR…</div>}
          </div>
          {!isSelectedBadgeValid && <p className="visitor-expired-label">INVALID OR EXPIRED BADGE</p>}
          <small>QR verification requires authorized school sign-in.</small>
        </div>
        <div className="visitor-badge-actions"><button className="button button-primary" type="button" disabled={!badgeQr} onClick={() => void downloadBadge(selected)}><Download size={15} />Download badge PDF</button><button className="button button-secondary" type="button" disabled={!badgeQr} onClick={() => void printBadge()}><Printer size={15} />Print badge</button></div>
      </section>}

      {verifiedVisitId && <section className="content-card visitor-verification">
        <div className="section-heading"><div><span className="eyebrow">Authorized badge check</span><h2>QR badge verification</h2></div><BadgeCheck size={20} className="muted-icon" /></div>
        {!verifiedVisit ? <ErrorState message="Invalid visitor badge. The visit could not be found for this school." /> : <>
          <div className={`visitor-verification-status${isVerifiedBadgeValid ? ' valid' : ' invalid'}`}><strong>{isVerifiedBadgeValid ? 'Badge valid' : 'Badge invalid or expired'}</strong><span>{statusLabels[verifiedVisit.status]} · valid through {verifiedVisit.valid_until}</span></div>
          <dl className="visitor-detail-list">
            <div><dt>Visitor</dt><dd>{verifiedVisit.visitor_name}</dd></div>
            <div><dt>Host</dt><dd>{verifiedVisit.host_name}{verifiedVisit.host_department ? ` · ${verifiedVisit.host_department}` : ''}</dd></div>
            <div><dt>Purpose</dt><dd>{verifiedVisit.purpose}</dd></div>
            <div><dt>Badge</dt><dd>{verifiedVisit.badge_number}</dd></div>
            <div><dt>Arrival / departure</dt><dd>{formatTimestamp(verifiedVisit.arrived_at)} / {formatTimestamp(verifiedVisit.departed_at)}</dd></div>
          </dl>
          <div className="visitor-form-actions">
            {isVerifiedBadgeValid && verifiedVisit.status === 'expected' && verifiedVisit.visit_date <= today() && <button className="button button-primary" type="button" onClick={() => void updateStatus(verifiedVisit, 'checked_in')}><LogIn size={15} />Check in visitor</button>}
            {isVerifiedBadgeValid && verifiedVisit.status === 'expected' && verifiedVisit.visit_date > today() && <p className="visitor-muted">This visit is expected on {verifiedVisit.visit_date}. Check-in is available on that date.</p>}
            {isVerifiedBadgeValid && verifiedVisit.status === 'checked_in' && <button className="button button-secondary" type="button" onClick={() => void updateStatus(verifiedVisit, 'checked_out')}><LogOut size={15} />Check out visitor</button>}
          </div>
        </>}
      </section>}

      {scanning && <div className="visitor-scanner"><video ref={videoRef} muted playsInline /><p>Point the camera at a visitor badge QR code.</p><button className="button button-quiet" type="button" onClick={() => setScanning(false)}>Cancel scan</button></div>}
    </div>
  );
}
