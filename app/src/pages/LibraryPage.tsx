import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Archive, BookCopy, Check, Download, Edit3, Plus, QrCode, Search, Sparkles, Trash2, Undo2, X,
} from 'lucide-react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { ErrorState, LoadingState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type Book = {
  id: string;
  school_id: string;
  barcode: string;
  isbn: string | null;
  title: string;
  authors: string[];
  publisher: string | null;
  edition: string | null;
  publication_year: number | null;
  cover_url: string | null;
  description: string | null;
  total_copies: number;
  available_copies: number;
  archived_at: string | null;
  created_at: string;
};
type LibraryRequest = {
  id: string;
  book_id: string;
  requester_id: string;
  requester_name: string;
  requester_email: string | null;
  request_type: 'request' | 'preorder';
  status: 'pending' | 'approved' | 'denied';
  note: string;
  decision_note: string;
  created_at: string;
  book: { title: string; barcode: string } | null;
};
type BookForm = {
  title: string;
  isbn: string;
  authors: string;
  publisher: string;
  edition: string;
  publication_year: string;
  cover_url: string;
  description: string;
  total_copies: string;
  available_copies: string;
};
type StudentOption = { id: string; student_number: string; first_name: string; last_name: string; school_class: { name: string } | null };
type Checkout = {
  id: string;
  book_id: string;
  student_id: string;
  checked_out_at: string;
  returned_at: string | null;
  book: { title: string; barcode: string } | null;
  student: { student_number: string; first_name: string; last_name: string; school_class: { name: string } | null } | null;
};
type CheckoutSlip = { code: string; book: Book; student: StudentOption; schoolName: string; checkedOutAt: string };

const emptyForm: BookForm = {
  title: '', isbn: '', authors: '', publisher: '', edition: '',
  publication_year: '', cover_url: '', description: '', total_copies: '1', available_copies: '1',
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function normalizeIsbn(value: string) {
  return value.replace(/[-\s]/g, '').toUpperCase();
}

function validIsbn(value: string) {
  return /^(?:\d{9}[\dX]|\d{13})$/.test(normalizeIsbn(value));
}

function createAccessCode() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

function formatAccessCode(value: string) {
  return value.replace(/[^A-Z0-9]/gi, '').toUpperCase().match(/.{1,4}/g)?.join('-') ?? '';
}

function extractAccessCode(value: string) {
  const payload = value.trim();
  const qrCode = payload.match(/CCLIB-RETURN:([A-Z0-9-]+)/i)?.[1];
  if (qrCode) return qrCode.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  try {
    const url = new URL(payload);
    const queryCode = url.searchParams.get('access_code');
    if (queryCode) return queryCode.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  } catch {
    // The scanned value is a code rather than a URL.
  }
  return payload.replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

async function hashAccessCode(code: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function publicBookUrl(slug: string, barcode: string, publicLibrary: boolean) {
  const path = publicLibrary
    ? `/school/${encodeURIComponent(slug)}/library/${encodeURIComponent(barcode)}`
    : `/book/${encodeURIComponent(slug)}/${encodeURIComponent(barcode)}`;
  return `${window.location.origin}${path}`;
}

export function LibraryPage() {
  const { activeMembership, user } = useAuth();
  const schoolId = activeMembership?.school_id;
  const role = activeMembership?.role;
  const canManage = role === 'school_admin' || role === 'academic_coordinator' || role === 'librarian';
  const [books, setBooks] = useState<Book[]>([]);
  const [requests, setRequests] = useState<LibraryRequest[]>([]);
  const [students, setStudents] = useState<StudentOption[]>([]);
  const [checkouts, setCheckouts] = useState<Checkout[]>([]);
  const [website, setWebsite] = useState<{ slug: string; enabled: boolean; public_library_enabled: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Book | null>(null);
  const [form, setForm] = useState<BookForm>(emptyForm);
  const [fetchingIsbn, setFetchingIsbn] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [activeCheckoutBook, setActiveCheckoutBook] = useState<Book | null>(null);
  const [checkoutStudentId, setCheckoutStudentId] = useState('');
  const [checkoutSlip, setCheckoutSlip] = useState<CheckoutSlip | null>(null);
  const [returnCode, setReturnCode] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scannerError, setScannerError] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);

  const load = useCallback(async () => {
    if (!schoolId) return;
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      let requestQuery = client.from('library_requests')
        .select('id,book_id,requester_id,requester_name,requester_email,request_type,status,note,decision_note,created_at,book:school_books(title,barcode)')
        .eq('school_id', schoolId)
        .order('created_at', { ascending: false });
      if (!canManage && user?.id) requestQuery = requestQuery.eq('requester_id', user.id);
      const [bookResult, websiteResult, requestResult] = await Promise.all([
        client.from('school_books').select('*').eq('school_id', schoolId).order('title'),
        client.rpc('get_school_library_publication_settings', { target_school: schoolId }),
        requestQuery,
      ]);
      if (bookResult.error) throw bookResult.error;
      if (websiteResult.error) throw websiteResult.error;
      if (requestResult.error) throw requestResult.error;
      setBooks((bookResult.data ?? []) as Book[]);
      setWebsite(websiteResult.data as typeof website);
      setRequests((requestResult.data ?? []) as unknown as LibraryRequest[]);
      if (canManage) {
        const [studentResult, checkoutResult] = await Promise.all([
          client.from('students').select('id,student_number,first_name,last_name,school_class:school_classes(name)')
            .eq('school_id', schoolId).eq('status', 'active')
            .order('last_name').order('first_name'),
          client.from('library_checkouts')
            .select('id,book_id,student_id,checked_out_at,returned_at,book:school_books(title,barcode),student:students(student_number,first_name,last_name,school_class:school_classes(name))')
            .eq('school_id', schoolId)
            .order('checked_out_at', { ascending: false })
            .limit(100),
        ]);
        if (studentResult.error) throw studentResult.error;
        if (checkoutResult.error) throw checkoutResult.error;
        setStudents((studentResult.data ?? []) as unknown as StudentOption[]);
        setCheckouts((checkoutResult.data ?? []) as unknown as Checkout[]);
      } else {
        setStudents([]);
        setCheckouts([]);
      }
    } catch (loadError) {
      setError(errorMessage(loadError, 'Could not load the school library.'));
    } finally {
      setLoading(false);
    }
  }, [schoolId, canManage, user?.id]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!scanning) return;
    let active = true;
    let stream: MediaStream | null = null;
    let timeout = 0;
    const Detector = (window as Window & {
      BarcodeDetector?: new (options: { formats: string[] }) => { detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
    }).BarcodeDetector;
    async function startCamera() {
      try {
        if (!Detector) throw new Error('QR scanning is not supported by this browser. Enter the printed access code instead.');
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access requires a secure HTTPS connection. Enter the printed access code instead.');
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
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
              setReturnCode(formatAccessCode(extractAccessCode(codes[0].rawValue)));
              setScanning(false);
              setScannerError('');
              return;
            }
          } catch (scanError) {
            console.error('Library QR scan failed.', scanError);
          }
          timeout = window.setTimeout(() => { void scan(); }, 350);
        };
        void scan();
      } catch (cameraError) {
        if (active) {
          setScannerError(errorMessage(cameraError, 'Could not start the QR scanner.'));
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
  }, [scanning]);

  const filteredBooks = useMemo(() => books.filter((book) => {
    if (!showArchived && book.archived_at) return false;
    if (showArchived && !book.archived_at) return false;
    const query = search.trim().toLowerCase();
    return !query || [
      book.title, book.isbn, book.publisher, book.barcode, book.edition, ...book.authors,
    ].some((value) => value?.toLowerCase().includes(query));
  }), [books, search, showArchived]);

  function beginAdd() {
    setEditing(null);
    setForm(emptyForm);
    setError('');
    setFormOpen(true);
  }

  function beginEdit(book: Book) {
    setEditing(book);
    setForm({
      title: book.title,
      isbn: book.isbn ?? '',
      authors: book.authors.join(', '),
      publisher: book.publisher ?? '',
      edition: book.edition ?? '',
      publication_year: book.publication_year?.toString() ?? '',
      cover_url: book.cover_url ?? '',
      description: book.description ?? '',
      total_copies: String(book.total_copies),
      available_copies: String(book.available_copies),
    });
    setError('');
    setFormOpen(true);
  }

  async function fetchIsbnDetails() {
    const isbn = normalizeIsbn(form.isbn);
    if (!validIsbn(isbn)) {
      setError('Enter a valid 10- or 13-character ISBN before fetching book details.');
      return;
    }
    setFetchingIsbn(true);
    setError('');
    setSuccess('');
    try {
      const response = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&format=json&jscmd=data`);
      if (!response.ok) throw new Error(`Book lookup failed (${response.status}).`);
      const data = await response.json() as Record<string, {
        title?: string;
        authors?: { name?: string }[];
        publishers?: { name?: string }[];
        publish_date?: string;
        edition_name?: string;
        cover?: { large?: string; medium?: string; small?: string };
        notes?: string | { value?: string };
      }>;
      const details = data[`ISBN:${isbn}`];
      if (!details) throw new Error('No matching book was found. Check the ISBN or enter the details manually.');
      const year = details.publish_date?.match(/\b(?:1[0-9]{3}|20[0-9]{2}|21[0-9]{2})\b/)?.[0] ?? '';
      const description = typeof details.notes === 'string' ? details.notes : details.notes?.value ?? '';
      setForm((current) => ({
        ...current,
        isbn,
        title: details.title ?? current.title,
        authors: (details.authors ?? []).map((author) => author.name).filter(Boolean).join(', ') || current.authors,
        publisher: details.publishers?.map((publisher) => publisher.name).filter(Boolean).join(', ') || current.publisher,
        edition: details.edition_name ?? current.edition,
        publication_year: year || current.publication_year,
        cover_url: details.cover?.large ?? details.cover?.medium ?? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`,
        description: description || current.description,
      }));
      setSuccess('Book details were fetched. Review them before saving.');
    } catch (lookupError) {
      setError(errorMessage(lookupError, 'Could not fetch book details. You can still enter them manually.'));
    } finally {
      setFetchingIsbn(false);
    }
  }

  async function saveBook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !user) return;
    const total = Number(form.total_copies);
    const available = Number(form.available_copies);
    const isbn = normalizeIsbn(form.isbn);
    if (form.isbn && !validIsbn(isbn)) {
      setError('Enter a valid ISBN or leave the ISBN field empty.');
      return;
    }
    if (!Number.isInteger(total) || !Number.isInteger(available) || total < 0 || available < 0 || available > total) {
      setError('Copy counts must be whole numbers, with available copies no greater than total copies.');
      return;
    }
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const values = {
        school_id: schoolId,
        title: form.title.trim(),
        isbn: isbn || null,
        authors: form.authors.split(',').map((author) => author.trim()).filter(Boolean),
        publisher: form.publisher.trim() || null,
        edition: form.edition.trim() || null,
        publication_year: form.publication_year ? Number(form.publication_year) : null,
        cover_url: form.cover_url.trim() || null,
        description: form.description.trim() || null,
        total_copies: total,
        available_copies: available,
        updated_by: user.id,
      };
      const result = editing
        ? await requireSupabase().from('school_books').update(values).eq('id', editing.id).eq('school_id', schoolId)
        : await requireSupabase().from('school_books').insert({
          ...values,
          barcode: `CC${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`,
          created_by: user.id,
        });
      if (result.error) throw result.error;
      setFormOpen(false);
      setSuccess(editing ? 'Book record updated.' : 'Book added to the library.');
      await load();
    } catch (saveError) {
      setError(errorMessage(saveError, 'Could not save the book.'));
    } finally {
      setSaving(false);
    }
  }

  async function archiveBook(book: Book) {
    if (!user) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: updateError } = await requireSupabase().from('school_books')
        .update({
          archived_at: book.archived_at ? null : new Date().toISOString(),
          archived_by: book.archived_at ? null : user.id,
          updated_by: user.id,
        })
        .eq('id', book.id);
      if (updateError) throw updateError;
      setSuccess(book.archived_at ? 'Book restored to the active catalogue.' : 'Book archived; its barcode now shows no public book details.');
      await load();
    } catch (archiveError) {
      setError(errorMessage(archiveError, 'Could not update the book record.'));
    } finally {
      setSaving(false);
    }
  }

  async function downloadCheckoutSlip(slip: CheckoutSlip) {
    try {
      const [{ jsPDF }, { default: QRCode }] = await Promise.all([
        import('jspdf'),
        import('qrcode'),
      ]);
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: [105, 148] });
      const formattedCode = formatAccessCode(slip.code);
      const qr = await QRCode.toDataURL(`CCLIB-RETURN:${formattedCode}`, {
        errorCorrectionLevel: 'H',
        margin: 2,
        width: 420,
        color: { dark: '#20243a', light: '#ffffff' },
      });
      pdf.setFillColor(101, 85, 217);
      pdf.rect(0, 0, 105, 31, 'F');
      pdf.setTextColor(255, 255, 255);
      pdf.setFont('helvetica', 'bold');
      const schoolLibraryTitle = `${slip.schoolName} Library`;
      let titleFontSize = 12;
      while (titleFontSize > 7 && pdf.getTextWidth(schoolLibraryTitle) > 89) {
        titleFontSize -= 0.5;
        pdf.setFontSize(titleFontSize);
      }
      pdf.text(schoolLibraryTitle, 8, 11);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(7);
      pdf.text('Campus Connect', 8, 18);
      pdf.setFontSize(8);
      pdf.text('Book checkout return slip', 8, 25);
      pdf.setTextColor(38, 42, 64);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(11);
      pdf.text(pdf.splitTextToSize(slip.book.title, 88).slice(0, 2), 8, 40);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.text(`${slip.student.first_name} ${slip.student.last_name}`, 8, 54);
      pdf.text(`Student number: ${slip.student.student_number}`, 8, 60);
      pdf.text(`Checked out: ${new Date(slip.checkedOutAt).toLocaleString()}`, 8, 66);
      pdf.addImage(qr, 'PNG', 34, 72, 37, 37);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(11);
      pdf.text(formattedCode, 52.5, 110, { align: 'center' });
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(7);
      pdf.text('Keep this slip safe. Return the book and present this QR code or access code.', 52.5, 119, { align: 'center', maxWidth: 89 });
      pdf.text('Library staff scan the QR or enter the code to record your return.', 52.5, 130, { align: 'center', maxWidth: 89 });
      pdf.save(`library-return-${slip.student.student_number}-${slip.book.barcode}.pdf`);
    } catch (pdfError) {
      throw new Error(`The book was checked out, but the return slip PDF could not be generated: ${errorMessage(pdfError, 'PDF generation failed.')}`);
    }
  }

  async function submitCheckout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeCheckoutBook || !checkoutStudentId || !schoolId) return;
    const student = students.find((item) => item.id === checkoutStudentId);
    if (!student) {
      setError('Choose an active student in this school.');
      return;
    }
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const rawCode = createAccessCode();
      const codeHash = await hashAccessCode(rawCode);
      const { data, error: checkoutError } = await requireSupabase().rpc('checkout_library_book', {
        target_book: activeCheckoutBook.id,
        target_student: student.id,
        requested_code_hash: codeHash,
      });
      if (checkoutError) throw checkoutError;
      const response = data as { checkout_id?: string; checked_out_at?: string } | null;
      if (!response?.checkout_id) throw new Error('The checkout was recorded, but no checkout reference was returned. Contact the library administrator.');
      const slip = {
        code: rawCode,
        book: activeCheckoutBook,
        student,
        schoolName: activeMembership?.school.name ?? 'School',
        checkedOutAt: response.checked_out_at ?? new Date().toISOString(),
      };
      setActiveCheckoutBook(null);
      setCheckoutSlip(slip);
      setSuccess(`“${activeCheckoutBook.title}” checked out to ${student.first_name} ${student.last_name}. Download and print the return slip now; the access code cannot be retrieved later.`);
      await load();
      try {
        await downloadCheckoutSlip(slip);
      } catch (pdfError) {
        setError(errorMessage(pdfError, 'The book was checked out, but the return slip could not be downloaded. Use the Download return slip button.'));
      }
    } catch (checkoutError) {
      setError(errorMessage(checkoutError, 'Could not check out this book.'));
    } finally {
      setSaving(false);
    }
  }

  async function processReturn(inputCode = returnCode) {
    const code = extractAccessCode(inputCode);
    if (code.length !== 16) {
      setError('Enter the 16-character access code shown under the return QR code.');
      return;
    }
    setSaving(true);
    setError('');
    setSuccess('');
    setScannerError('');
    setScanning(false);
    try {
      const { data, error: returnError } = await requireSupabase().rpc('return_library_book', {
        return_code: code,
      });
      if (returnError) {
        const rpcError = returnError as { code?: string; message?: string };
        if (rpcError.code === 'PGRST202' || rpcError.message?.includes('return_library_book')) {
          throw new Error('Book returns are not enabled in the database yet. Apply migration 202610140008_library_checkouts.sql to this Supabase project, then retry. If the migration is already applied, refresh the PostgREST schema cache.');
        }
        throw returnError;
      }
      const result = data as { book_title?: string } | null;
      setReturnCode('');
      setSuccess(`Return processed${result?.book_title ? `: “${result.book_title}”` : ''}. The available-copy count has been updated.`);
      await load();
    } catch (returnError) {
      setError(errorMessage(returnError, 'Could not process this return.'));
    } finally {
      setSaving(false);
    }
  }

  async function deleteBook(book: Book) {
    if (!window.confirm(`Permanently delete "${book.title}"? Use archive instead if you need to preserve request history.`)) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: deleteError } = await requireSupabase().from('school_books').delete().eq('id', book.id);
      if (deleteError) throw deleteError;
      setSuccess('Book record permanently deleted.');
      await load();
    } catch (deleteError) {
      setError(errorMessage(deleteError, 'Could not delete the book. Records with request history must be archived instead.'));
    } finally {
      setSaving(false);
    }
  }

  async function submitRequest(book: Book) {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { data, error: requestError } = await requireSupabase().rpc('request_school_library_book', {
        target_book: book.id,
        request_note: '',
      });
      if (requestError) throw requestError;
      const result = data as { request_type?: string } | null;
      setSuccess(result?.request_type === 'preorder' ? 'Preorder sent to the library for approval.' : 'Book request sent to the library for approval.');
      await load();
    } catch (requestError) {
      setError(errorMessage(requestError, 'Could not submit this book request.'));
    } finally {
      setSaving(false);
    }
  }

  async function reviewRequest(request: LibraryRequest, decision: 'approved' | 'denied') {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { error: reviewError } = await requireSupabase().rpc('review_library_request', {
        target_request: request.id,
        decision,
        decision_message: reviewNotes[request.id]?.trim() ?? '',
      });
      if (reviewError) throw reviewError;
      setSuccess(`Book ${request.request_type === 'preorder' ? 'preorder' : 'request'} ${decision}.`);
      await load();
    } catch (reviewError) {
      setError(errorMessage(reviewError, 'Could not review this request.'));
    } finally {
      setSaving(false);
    }
  }

  async function downloadStickers(targetBooks: Book[]) {
    const printableBooks = targetBooks.filter((book) => !book.archived_at);
    if (!website || printableBooks.length === 0) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const [{ jsPDF }, { default: QRCode }] = await Promise.all([
        import('jspdf'),
        import('qrcode'),
      ]);
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pageWidth = 210;
      const pageHeight = 297;
      const margin = 7;
      const columns = 3;
      const rows = 7;
      const gap = 2;
      const cellWidth = (pageWidth - margin * 2 - gap * (columns - 1)) / columns;
      const cellHeight = (pageHeight - margin * 2 - gap * (rows - 1)) / rows;
      for (let index = 0; index < printableBooks.length; index += 1) {
        if (index > 0 && index % (columns * rows) === 0) pdf.addPage();
        const slot = index % (columns * rows);
        const x = margin + (slot % columns) * (cellWidth + gap);
        const y = margin + Math.floor(slot / columns) * (cellHeight + gap);
        const book = printableBooks[index];
        const qr = await QRCode.toDataURL(publicBookUrl(website.slug, book.barcode, website.enabled && website.public_library_enabled), {
          errorCorrectionLevel: 'M',
          margin: 1,
          width: 256,
          color: { dark: '#20243a', light: '#ffffff' },
        });
        pdf.setDrawColor(218, 221, 233);
        pdf.setFillColor(255, 255, 255);
        pdf.roundedRect(x, y, cellWidth, cellHeight, 2, 2, 'FD');
        pdf.setFillColor(101, 85, 217);
        pdf.roundedRect(x, y, 2, cellHeight, 1, 1, 'F');
        pdf.addImage(qr, 'PNG', x + 4, y + 5, 24, 24);
        pdf.setTextColor(38, 42, 64);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(8);
        const title = pdf.splitTextToSize(book.title, cellWidth - 34).slice(0, 3);
        pdf.text(title, x + 31, y + 9);
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(6.5);
        const authors = pdf.splitTextToSize(book.authors.join(', ') || 'Author not listed', cellWidth - 34).slice(0, 2);
        pdf.text(authors, x + 31, y + 9 + title.length * 3.5 + 2);
        pdf.setTextColor(88, 94, 118);
        pdf.setFontSize(6.2);
        pdf.text(book.barcode, x + 31, y + cellHeight - 7);
        pdf.text(book.isbn ? `ISBN ${book.isbn}` : 'Scan for book information', x + 31, y + cellHeight - 3.5);
      }
      pdf.save(`${website.slug}-library-book-stickers.pdf`);
      setSuccess(`Downloaded ${printableBooks.length} book sticker${printableBooks.length === 1 ? '' : 's'} as a print-ready PDF.`);
    } catch (pdfError) {
      setError(errorMessage(pdfError, 'Could not generate the sticker PDF.'));
    } finally {
      setSaving(false);
    }
  }

  const pendingRequests = requests.filter((request) => request.status === 'pending');
  const ownRequests = requests.filter((request) => request.requester_id === user?.id);
  const activeCheckouts = checkouts.filter((checkout) => !checkout.returned_at);
  const recentReturns = checkouts.filter((checkout) => checkout.returned_at).slice(0, 20);

  if (loading) return <div className="page-stack"><LoadingState label="Loading library…" /></div>;

  return <div className="page-stack">
    <header className="page-heading library-heading">
      <div><span className="eyebrow">{activeMembership?.school.name}</span><h1>Library</h1><p>Maintain the book catalogue, print QR barcode stickers, and manage requests and preorders.</p></div>
      {canManage && <div className="library-heading-actions">
        <button className="button button-quiet" disabled={saving || filteredBooks.length === 0} onClick={() => void downloadStickers(filteredBooks)}><Download size={15} /> Download all stickers</button>
        <button className="button button-quiet" disabled={saving || selected.length === 0} onClick={() => void downloadStickers(books.filter((book) => selected.includes(book.id)))}><Download size={15} /> Selected ({selected.length})</button>
        <button className="button button-primary" onClick={beginAdd}><Plus size={15} /> Add book</button>
      </div>}
    </header>
    {error && <ErrorState message={error} />}
    {success && <p className="inline-success" role="status">{success}</p>}
    {canManage && !website?.enabled && <aside className="library-private-note">Public book scans will show a Campus Connect sign-in prompt until the school website is published.</aside>}
    {canManage && website?.enabled && !website.public_library_enabled && <aside className="library-private-note">The school website is published, but the public library catalogue is off. Scanned stickers will ask visitors to sign in to Campus Connect.</aside>}

    {canManage && <section className="content-card library-return-desk">
      <div className="library-section-heading"><div><span className="eyebrow">Circulation desk</span><h2>Process a book return</h2><p>Scan the student's printed QR slip, or enter the 16-character code printed under it.</p></div><span className="library-active-count">{activeCheckouts.length} currently checked out</span></div>
      <div className="library-return-controls">
        <label className="field"><span>Return access code</span><input autoComplete="off" value={returnCode} onChange={(event) => setReturnCode(event.target.value)} placeholder="ABCD-EFGH-JKLM-NPQR" maxLength={23} /></label>
        <button className="button button-quiet" disabled={saving} onClick={() => { setScannerError(''); setScanning(true); }}><QrCode size={15} /> Scan QR</button>
        <button className="button button-primary" disabled={saving || extractAccessCode(returnCode).length !== 16} onClick={() => void processReturn()}><Undo2 size={15} /> Process return</button>
      </div>
      {scannerError && <p className="library-scanner-error" role="alert">{scannerError}</p>}
      {scanning && <div className="library-scanner"><video ref={videoRef} muted playsInline /><p>Point the camera at the return slip QR code.</p><button className="button button-quiet" onClick={() => setScanning(false)}>Cancel scan</button></div>}
      {checkoutSlip && <aside className="library-slip-ready"><div><strong>New return slip ready</strong><span>{checkoutSlip.book.title} · {checkoutSlip.student.first_name} {checkoutSlip.student.last_name}</span><code>{formatAccessCode(checkoutSlip.code)}</code><small>This one-time code is shown only now. Download or print the slip before closing this page.</small></div><button className="button button-primary" disabled={saving} onClick={() => void downloadCheckoutSlip(checkoutSlip)}><Download size={15} /> Download return slip</button></aside>}
      {activeCheckouts.length > 0 && <div className="library-active-checkouts"><h3>Active checkouts</h3>{activeCheckouts.map((checkout) => <article className="library-active-checkout" key={checkout.id}><div><strong>{checkout.book?.title ?? 'Book record unavailable'}</strong><span>{checkout.student ? `${checkout.student.first_name} ${checkout.student.last_name} · ${checkout.student.student_number}` : 'Student record unavailable'}</span><small>{checkout.student?.school_class?.name ?? 'Class not set'} · checked out {new Date(checkout.checked_out_at).toLocaleString()}</small></div><span className="library-request-status pending">Awaiting return</span></article>)}</div>}
      {recentReturns.length > 0 && <div className="library-active-checkouts"><h3>Recent returns</h3>{recentReturns.map((checkout) => <article className="library-active-checkout" key={checkout.id}><div><strong>{checkout.book?.title ?? 'Book record unavailable'}</strong><span>{checkout.student ? `${checkout.student.first_name} ${checkout.student.last_name} · ${checkout.student.student_number}` : 'Student record unavailable'}</span><small>Returned {new Date(checkout.returned_at!).toLocaleString()}</small></div><span className="library-request-status approved">Returned</span></article>)}</div>}
    </section>}

    <section className="content-card library-catalogue">
      <div className="library-toolbar">
        <label className="library-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search title, author, ISBN, publisher or barcode" /></label>
        {canManage && <label className="library-archived-toggle"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived</label>}
      </div>
      {canManage && <div className="library-select-toolbar"><button className="button button-quiet" onClick={() => setSelected(filteredBooks.filter((book) => !book.archived_at).map((book) => book.id))}>Select active results</button><button className="button button-quiet" onClick={() => setSelected([])}>Clear selection</button><span>{filteredBooks.length} {filteredBooks.length === 1 ? 'book' : 'books'}</span></div>}
      {filteredBooks.length === 0
        ? <div className="library-empty"><BookCopy size={23} /><h2>{books.length ? 'No matching books' : 'Your library is ready'}</h2><p>{canManage ? 'Add a book manually or enter an ISBN to fetch its details and cover.' : 'No books are currently listed in this school library.'}</p></div>
        : <div className="library-book-grid">{filteredBooks.map((book) => <article className={`library-book-card${book.archived_at ? ' is-archived' : ''}`} key={book.id}>
          {canManage && <input className="library-book-select" aria-label={`Select ${book.title}`} type="checkbox" checked={selected.includes(book.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, book.id] : current.filter((id) => id !== book.id))} />}
          {book.cover_url ? <img className="library-book-cover" src={book.cover_url} alt={`Cover of ${book.title}`} loading="lazy" /> : <div className="library-book-cover library-cover-placeholder"><BookCopy size={28} /></div>}
          <div className="library-book-main"><div className="library-book-title-row"><h2>{book.title}</h2>{book.archived_at && <span className="library-status-badge">Archived</span>}</div>
            <p className="library-book-authors">{book.authors.join(', ') || 'Author not listed'}</p>
            <dl className="library-book-meta">
              {book.isbn && <><dt>ISBN</dt><dd>{book.isbn}</dd></>}
              {book.publisher && <><dt>Publisher</dt><dd>{book.publisher}</dd></>}
              {book.edition && <><dt>Edition</dt><dd>{book.edition}</dd></>}
              {book.publication_year && <><dt>Year</dt><dd>{book.publication_year}</dd></>}
              <dt>Copies</dt><dd>{book.available_copies} available of {book.total_copies}</dd>
              <dt>Barcode</dt><dd>{book.barcode}</dd>
            </dl>
            {book.description && <p className="library-book-description">{book.description}</p>}
            <div className="library-book-actions">
              {canManage ? <>
                {!book.archived_at && <button className="button button-quiet" disabled={saving} onClick={() => beginEdit(book)}><Edit3 size={14} /> Edit</button>}
                {!book.archived_at && <button className="button button-primary" disabled={saving || book.available_copies < 1} onClick={() => { setActiveCheckoutBook(book); setCheckoutStudentId(''); setError(''); }}><BookCopy size={14} /> Check out</button>}
                <button className="button button-quiet" disabled={saving} onClick={() => void archiveBook(book)}><Archive size={14} /> {book.archived_at ? 'Restore' : 'Archive'}</button>
                <button className="icon-button" disabled={saving} onClick={() => void deleteBook(book)} aria-label={`Delete ${book.title}`} title="Delete book"><Trash2 size={15} /></button>
              </> : !book.archived_at && <button className="button button-primary" disabled={saving} onClick={() => void submitRequest(book)}>{book.available_copies > 0 ? 'Request book' : 'Preorder book'}</button>}
            </div>
          </div>
        </article>)}</div>}
    </section>

    {!canManage && <section className="content-card library-own-requests"><div className="library-section-heading"><div><span className="eyebrow">My activity</span><h2>Book requests</h2></div></div>
      {ownRequests.length === 0 ? <p>You have not submitted any book requests yet.</p> : ownRequests.map((request) => <div className="library-request-row" key={request.id}><div><strong>{request.book?.title ?? 'Book'}</strong><small>{request.request_type === 'preorder' ? 'Preorder' : 'Request'} · {new Date(request.created_at).toLocaleDateString()}</small></div><span className={`library-request-status ${request.status}`}>{request.status}</span>{request.decision_note && <p>{request.decision_note}</p>}</div>)}
    </section>}

    {canManage && <section className="content-card library-requests">
      <div className="library-section-heading"><div><span className="eyebrow">Library desk</span><h2>Book requests & preorders</h2><p>{pendingRequests.length} awaiting review</p></div><button className="button button-quiet" onClick={() => void load()}>Refresh</button></div>
      {requests.length === 0 ? <p>No book requests have been submitted.</p> : <div className="library-request-list">{requests.map((request) => <article className="library-request-card" key={request.id}>
        <div className="library-request-summary"><div><strong>{request.book?.title ?? 'Book record unavailable'}</strong><small>{request.requester_name || request.requester_email || 'School member'} · {new Date(request.created_at).toLocaleString()}</small></div><span className={`library-request-status ${request.status}`}>{request.request_type === 'preorder' ? 'Preorder' : 'Request'} · {request.status}</span></div>
        {request.note && <p>{request.note}</p>}
        {request.status === 'pending' ? <><label className="field"><span>Decision note (optional)</span><input maxLength={1000} value={reviewNotes[request.id] ?? ''} onChange={(event) => setReviewNotes((current) => ({ ...current, [request.id]: event.target.value }))} /></label><div className="library-book-actions"><button className="button button-primary" disabled={saving} onClick={() => void reviewRequest(request, 'approved')}><Check size={14} /> Approve</button><button className="button button-quiet" disabled={saving} onClick={() => void reviewRequest(request, 'denied')}><X size={14} /> Deny</button></div></> : request.decision_note && <p className="library-decision-note">{request.decision_note}</p>}
      </article>)}</div>}
    </section>}

    {formOpen && <div className="library-modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget && !saving) setFormOpen(false); }}>
      <section className="content-card library-book-dialog" role="dialog" aria-modal="true" aria-labelledby="library-book-dialog-title">
        <div className="library-section-heading"><div><span className="eyebrow">Catalogue record</span><h2 id="library-book-dialog-title">{editing ? 'Edit book' : 'Add a book'}</h2><p>Enter book information manually or fetch available details by ISBN.</p></div><button className="icon-button" type="button" disabled={saving} onClick={() => setFormOpen(false)} aria-label="Close form"><X size={18} /></button></div>
        <form className="library-book-form" onSubmit={(event) => void saveBook(event)}>
          <div className="library-isbn-fetch"><label className="field"><span>ISBN</span><input value={form.isbn} maxLength={17} onChange={(event) => setForm((current) => ({ ...current, isbn: event.target.value }))} placeholder="ISBN-10 or ISBN-13" /></label><button className="button button-quiet" type="button" disabled={fetchingIsbn || saving} onClick={() => void fetchIsbnDetails()}><Sparkles size={14} /> {fetchingIsbn ? 'Looking up…' : 'Fetch details'}</button></div>
          <label className="field"><span>Title *</span><input required maxLength={240} value={form.title} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} /></label>
          <label className="field"><span>Author(s) <small>Separate multiple authors with commas</small></span><input maxLength={1000} value={form.authors} onChange={(event) => setForm((current) => ({ ...current, authors: event.target.value }))} /></label>
          <div className="library-form-grid"><label className="field"><span>Publisher</span><input maxLength={200} value={form.publisher} onChange={(event) => setForm((current) => ({ ...current, publisher: event.target.value }))} /></label><label className="field"><span>Edition</span><input maxLength={100} value={form.edition} onChange={(event) => setForm((current) => ({ ...current, edition: event.target.value }))} /></label><label className="field"><span>Publication year</span><input type="number" min={1000} max={2200} value={form.publication_year} onChange={(event) => setForm((current) => ({ ...current, publication_year: event.target.value }))} /></label><label className="field"><span>Total copies</span><input type="number" min={0} step={1} value={form.total_copies} onChange={(event) => setForm((current) => ({ ...current, total_copies: event.target.value }))} /></label><label className="field"><span>Available copies</span><input type="number" min={0} step={1} value={form.available_copies} onChange={(event) => setForm((current) => ({ ...current, available_copies: event.target.value }))} /></label></div>
          <label className="field"><span>Cover image URL</span><input type="url" maxLength={2000} value={form.cover_url} onChange={(event) => setForm((current) => ({ ...current, cover_url: event.target.value }))} placeholder="Automatically fetched from Open Library when available" /></label>
          <label className="field"><span>Description</span><textarea rows={3} maxLength={3000} value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} /></label>
          <div className="library-form-actions"><button className="button button-quiet" type="button" disabled={saving} onClick={() => setFormOpen(false)}>Cancel</button><button className="button button-primary" disabled={saving}>{saving ? 'Saving…' : editing ? 'Save changes' : 'Add book'}</button></div>
        </form>
      </section>
    </div>}

    {activeCheckoutBook && <div className="library-modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget && !saving) setActiveCheckoutBook(null); }}>
      <section className="content-card library-book-dialog library-checkout-dialog" role="dialog" aria-modal="true" aria-labelledby="library-checkout-title">
        <div className="library-section-heading"><div><span className="eyebrow">Library checkout</span><h2 id="library-checkout-title">Check out a copy</h2><p>{activeCheckoutBook.title} · {activeCheckoutBook.available_copies} available</p></div><button className="icon-button" type="button" disabled={saving} onClick={() => setActiveCheckoutBook(null)} aria-label="Close checkout"><X size={18} /></button></div>
        <form className="library-book-form" onSubmit={(event) => void submitCheckout(event)}>
          <label className="field"><span>Student *</span><select required value={checkoutStudentId} onChange={(event) => setCheckoutStudentId(event.target.value)}><option value="">Choose a student</option>{students.map((student) => <option key={student.id} value={student.id}>{student.first_name} {student.last_name} · {student.student_number}{student.school_class ? ` · ${student.school_class.name}` : ''}</option>)}</select></label>
          {students.length === 0 && <p className="library-scanner-error">There are no active students available to check out this book to.</p>}
          <p className="library-checkout-note">A unique one-time return QR and access code will be generated. Download and print the slip for the student. The code is saved only as a secure hash and cannot be downloaded again later.</p>
          <div className="library-form-actions"><button className="button button-quiet" type="button" disabled={saving} onClick={() => setActiveCheckoutBook(null)}>Cancel</button><button className="button button-primary" disabled={saving || students.length === 0}>{saving ? 'Checking out…' : 'Check out & create return slip'}</button></div>
        </form>
      </section>
    </div>}
  </div>;
}

export function PublicLibraryBookPage({ websitePath = false }: { websitePath?: boolean }) {
  const { slug = '', barcode = '' } = useParams();
  const { user } = useAuth();
  const [result, setResult] = useState<{
    public_enabled: boolean;
    school_name: string;
    school_slug: string;
    book: Omit<Book, 'id' | 'school_id' | 'created_at' | 'archived_at'> | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    let active = true;
    async function loadBook() {
      setLoading(true);
      setError('');
      try {
        const { data, error: queryError } = await requireSupabase().rpc('lookup_public_library_book', {
          target_slug: slug,
          target_barcode: barcode,
        });
        if (queryError) throw queryError;
        if (active) setResult(data as typeof result);
      } catch (loadError) {
        if (active) setError(errorMessage(loadError, 'Could not load this book.'));
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadBook();
    return () => { active = false; };
  }, [slug, barcode]);

  async function requestBook() {
    setRequesting(true);
    setError('');
    setSuccess('');
    try {
      const { data, error: requestError } = await requireSupabase().rpc('request_public_library_book', {
        target_slug: slug,
        target_barcode: barcode,
        request_note: '',
      });
      if (requestError) throw requestError;
      const response = data as { request_type?: string } | null;
      setSuccess(response?.request_type === 'preorder' ? 'Your preorder was sent to the library for approval.' : 'Your request was sent to the library for approval.');
    } catch (requestError) {
      setError(errorMessage(requestError, 'Could not submit your request.'));
    } finally {
      setRequesting(false);
    }
  }

  if (loading) return <main className="public-library-page"><LoadingState label="Loading book information…" /></main>;
  const isPublic = result?.public_enabled === true;
  const book = isPublic ? result?.book : null;
  const loginUrl = `/login?redirect=${encodeURIComponent(window.location.pathname)}`;
  return <main className={`public-library-page${websitePath ? ' school-library-page' : ''}`}>
    <header className="public-library-header"><a className="public-library-brand" href="/"><span className="brand-mark"><BookCopy size={19} /></span>Campus Connect</a><a className="button button-quiet" href={user ? '/dashboard' : loginUrl}>{user ? 'Open workspace' : 'Log in'}</a></header>
    {error && <ErrorState message={error} />}
    {success && <p className="inline-success" role="status">{success}</p>}
    {!isPublic && <section className="public-library-notice"><span className="eyebrow">{result?.school_name || 'Campus Connect'}</span><h1>Please log in to Campus Connect</h1><p>This school has not enabled its public library catalogue. Sign in with an account connected to the school to view library information and place book requests.</p><a className="button button-primary" href={loginUrl}>Log in to Campus Connect</a></section>}
    {isPublic && !book && <section className="public-library-notice"><span className="eyebrow">{result.school_name}</span><h1>Book not found</h1><p>This barcode does not match an active book in the school's public library catalogue.</p></section>}
    {book && <article className="public-library-book">
      <span className="eyebrow">{result?.school_name} · Library catalogue</span>
      <div className="public-library-book-layout">{book.cover_url ? <img src={book.cover_url} alt={`Cover of ${book.title}`} /> : <div className="public-library-cover-placeholder"><BookCopy size={48} /></div>}
        <div><h1>{book.title}</h1><p className="public-library-authors">{book.authors.join(', ') || 'Author not listed'}</p><dl className="library-book-meta">{book.isbn && <><dt>ISBN</dt><dd>{book.isbn}</dd></>}{book.publisher && <><dt>Publisher</dt><dd>{book.publisher}</dd></>}{book.edition && <><dt>Edition</dt><dd>{book.edition}</dd></>}{book.publication_year && <><dt>Publication year</dt><dd>{book.publication_year}</dd></>}<dt>Availability</dt><dd>{book.available_copies > 0 ? `${book.available_copies} copies available` : 'Currently unavailable · preorder permitted'}</dd></dl>
          {book.description && <p>{book.description}</p>}
          {user ? <button className="button button-primary" disabled={requesting || Boolean(success)} onClick={() => void requestBook()}>{requesting ? 'Submitting…' : book.available_copies > 0 ? 'Request this book' : 'Preorder this book'}</button> : <a className="button button-primary" href={loginUrl}>Log in to request or preorder</a>}
          <p className="public-library-auth-note">Requests are sent to the school library for approval. A submitted request is not a confirmed loan.</p>
        </div>
      </div>
    </article>}
  </main>;
}
