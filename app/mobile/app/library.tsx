import { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import * as Crypto from 'expo-crypto';
import QRCode from 'qrcode';
import { BodyText, Button, Card, Field, Heading, Loading, Message, Page, colors } from '../src/components/ui';
import { useCampusAuth } from '../src/lib/auth-context';
import { escapeHtml, htmlDocument, printOrSharePdf } from '../src/lib/pdf';
import { requireSupabase } from '../src/lib/supabase';
import type { LibraryBook } from '../src/lib/types';
import { canUseModule, isValidIsbn, normalizeIsbn } from '../src/lib/validation';

interface StudentChoice {
  id: string;
  student_number: string;
  first_name: string;
  last_name: string;
  school_classes: { name: string } | null;
}

interface BookForm {
  isbn: string;
  title: string;
  authors: string;
  publisher: string;
  edition: string;
  publication_year: string;
  cover_url: string;
  copies: string;
}

const emptyForm: BookForm = { isbn: '', title: '', authors: '', publisher: '', edition: '', publication_year: '', cover_url: '', copies: '1' };

export default function LibraryScreen() {
  const { selectedSchool } = useCampusAuth();
  const params = useLocalSearchParams<{ isbn?: string; barcode?: string; returnCode?: string }>();
  const [books, setBooks] = useState<LibraryBook[]>([]);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState<BookForm>(emptyForm);
  const [students, setStudents] = useState<StudentChoice[]>([]);
  const [studentSearch, setStudentSearch] = useState('');
  const [selectedStudent, setSelectedStudent] = useState<StudentChoice | null>(null);
  const [selectedBook, setSelectedBook] = useState<LibraryBook | null>(null);
  const [returnCode, setReturnCode] = useState('');
  const [issuedCode, setIssuedCode] = useState('');
  const [copiesForPdf, setCopiesForPdf] = useState('1');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fetchingIsbn, setFetchingIsbn] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canManageLibrary = selectedSchool?.role === 'school_admin' || selectedSchool?.role === 'academic_coordinator';

  const loadBooks = useCallback(async () => {
    if (!selectedSchool) return;
    setLoading(true);
    setError('');
    try {
      const { data, error: queryError } = await requireSupabase().from('school_books')
        .select('id,school_id,barcode,isbn,title,authors,publisher,edition,publication_year,cover_url,total_copies,available_copies,archived_at')
        .eq('school_id', selectedSchool.school_id)
        .is('archived_at', null)
        .order('title')
        .limit(200);
      if (queryError) throw queryError;
      setBooks((data ?? []) as LibraryBook[]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load the library catalogue.');
    } finally {
      setLoading(false);
    }
  }, [selectedSchool]);

  useEffect(() => { void loadBooks(); }, [loadBooks]);

  useEffect(() => {
    if (params.isbn) {
      const isbn = normalizeIsbn(params.isbn);
      setForm((current) => ({ ...current, isbn }));
      setSearch(isbn);
      void fetchIsbn(isbn);
    } else if (params.barcode) {
      setSearch(params.barcode);
    } else if (params.returnCode) {
      setReturnCode(params.returnCode);
    }
  }, [params.barcode, params.isbn, params.returnCode]);

  const filteredBooks = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return books;
    return books.filter((book) => [
      book.title, book.isbn ?? '', book.barcode, book.publisher ?? '', ...(book.authors ?? []),
    ].some((value) => value.toLowerCase().includes(needle)));
  }, [books, search]);

  async function fetchIsbn(value = form.isbn) {
    const isbn = normalizeIsbn(value);
    if (!isValidIsbn(isbn)) {
      setError('Enter a valid ISBN-10 or ISBN-13.');
      return;
    }
    setFetchingIsbn(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&format=json&jscmd=data`);
      if (!response.ok) throw new Error(`Book metadata lookup failed with HTTP ${response.status}.`);
      const payload = await response.json() as Record<string, {
        title?: string;
        authors?: { name?: string }[];
        publishers?: { name?: string }[];
        publish_date?: string;
        cover?: { large?: string; medium?: string };
      }>;
      const details = payload[`ISBN:${isbn}`];
      if (!details) throw new Error('No book details were found. Enter the information manually.');
      setForm((current) => ({
        ...current,
        isbn,
        title: details.title ?? current.title,
        authors: details.authors?.map((author) => author.name).filter(Boolean).join(', ') ?? current.authors,
        publisher: details.publishers?.[0]?.name ?? current.publisher,
        publication_year: details.publish_date?.match(/\d{4}/)?.[0] ?? current.publication_year,
        cover_url: details.cover?.large ?? details.cover?.medium ?? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`,
      }));
      setNotice('Metadata loaded. Review and edit it before saving.');
    } catch (lookupError) {
      setError(lookupError instanceof Error ? lookupError.message : 'Book metadata lookup failed.');
    } finally {
      setFetchingIsbn(false);
    }
  }

  async function saveBook() {
    if (!selectedSchool) return;
    const isbn = normalizeIsbn(form.isbn);
    const copies = Number(form.copies);
    if (!form.title.trim() || !Number.isInteger(copies) || copies < 1 || copies > 10000) {
      setError('Enter a title and a whole number of copies between 1 and 10,000.');
      return;
    }
    if (isbn && !isValidIsbn(isbn)) {
      setError('Enter a valid ISBN or clear the ISBN field.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const client = requireSupabase();
      if (isbn) {
        const { data: duplicate, error: duplicateError } = await client.from('school_books')
          .select('id,title')
          .eq('school_id', selectedSchool.school_id)
          .eq('isbn', isbn)
          .is('archived_at', null)
          .maybeSingle();
        if (duplicateError) throw duplicateError;
        if (duplicate) throw new Error(`This ISBN is already in the catalogue as “${duplicate.title}”.`);
      }
      const barcode = `LIB-${Crypto.randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
      const { error: insertError } = await client.from('school_books').insert({
        school_id: selectedSchool.school_id,
        barcode,
        isbn: isbn || null,
        title: form.title.trim(),
        authors: form.authors.split(',').map((author) => author.trim()).filter(Boolean),
        publisher: form.publisher.trim() || null,
        edition: form.edition.trim() || null,
        publication_year: form.publication_year ? Number(form.publication_year) : null,
        cover_url: form.cover_url.trim() || null,
        total_copies: copies,
        available_copies: copies,
        created_by: (await client.auth.getUser()).data.user?.id,
        updated_by: (await client.auth.getUser()).data.user?.id,
      });
      if (insertError) throw insertError;
      setNotice('Book added to the school catalogue.');
      setForm(emptyForm);
      await loadBooks();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The book could not be added.');
    } finally {
      setSaving(false);
    }
  }

  async function findStudents() {
    if (!selectedSchool || studentSearch.trim().length < 2) return;
    setError('');
    try {
      const { data, error: queryError } = await requireSupabase().from('students')
        .select('id,student_number,first_name,last_name,school_classes(name)')
        .eq('school_id', selectedSchool.school_id)
        .eq('status', 'active')
        .or(`student_number.ilike.%${studentSearch.trim()}%,first_name.ilike.%${studentSearch.trim()}%,last_name.ilike.%${studentSearch.trim()}%`)
        .limit(10);
      if (queryError) throw queryError;
      setStudents((data ?? []) as unknown as StudentChoice[]);
      if (!data?.length) setNotice('No active students matched that search.');
    } catch (queryError) {
      setError(queryError instanceof Error ? queryError.message : 'Student search failed.');
    }
  }

  async function checkout() {
    if (!selectedSchool || !selectedBook || !selectedStudent) {
      setError('Select a book and an active student before checking out.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const code = Crypto.randomUUID().replace(/[^A-Za-z0-9]/g, '').slice(0, 16).toUpperCase();
      const requestedCodeHash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, code);
      const { error: checkoutError } = await requireSupabase().rpc('checkout_library_book', {
        target_book: selectedBook.id,
        target_student: selectedStudent.id,
        requested_code_hash: requestedCodeHash,
      });
      if (checkoutError) throw checkoutError;
      setIssuedCode(code);
      setNotice(`Checked out ${selectedBook.title} to ${selectedStudent.first_name} ${selectedStudent.last_name}. Give them this one-time return code.`);
      await loadBooks();
    } catch (checkoutError) {
      setError(checkoutError instanceof Error ? checkoutError.message : 'The book could not be checked out.');
    } finally {
      setSaving(false);
    }
  }

  async function processReturn() {
    if (!returnCode.trim()) {
      setError('Scan or enter the 16-character return code.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { data, error: returnError } = await requireSupabase().rpc('return_library_book', { return_code: returnCode.trim() });
      if (returnError) throw returnError;
      setNotice(`Returned: ${data.book_title}.`);
      setReturnCode('');
      await loadBooks();
    } catch (returnError) {
      setError(returnError instanceof Error ? returnError.message : 'The return could not be processed.');
    } finally {
      setSaving(false);
    }
  }

  async function exportSticker(book: LibraryBook) {
    setError('');
    try {
      const count = Math.max(1, Math.min(100, Number(copiesForPdf) || 1));
      const stickers = await Promise.all(Array.from({ length: count }, async () => {
        const svg = await QRCode.toString(book.barcode, { type: 'svg', margin: 1, width: 140 });
        return `<section class="card" style="display:inline-block;width:44%;min-height:230px;text-align:center;box-sizing:border-box">
          <h2>${escapeHtml(book.title)}</h2><div class="qr">${svg}</div><p>${escapeHtml(book.barcode)}</p>
          ${book.isbn ? `<p class="muted">ISBN ${escapeHtml(book.isbn)}</p>` : ''}</section>`;
      }));
      await printOrSharePdf(htmlDocument(`${count} Library Sticker${count === 1 ? '' : 's'}`, stickers.join('')), `${book.barcode}-stickers.pdf`);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : 'Sticker PDF could not be created.');
    }
  }

  async function exportReturnCode() {
    if (!issuedCode || !selectedBook || !selectedStudent) return;
    try {
      const qrSvg = await QRCode.toString(issuedCode, { type: 'svg', margin: 1, width: 200 });
      await printOrSharePdf(htmlDocument('Library Return Pass', `<section class="card"><h2>${escapeHtml(selectedBook.title)}</h2>
        <p>Borrower: ${escapeHtml(`${selectedStudent.first_name} ${selectedStudent.last_name}`)} (${escapeHtml(selectedStudent.student_number)})</p>
        <div class="qr">${qrSvg}</div><p><b>Return code: ${escapeHtml(issuedCode)}</b></p></section>`), 'library-return-pass.pdf');
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : 'Return pass PDF could not be created.');
    }
  }

  if (!selectedSchool) return null;
  if (!canUseModule(selectedSchool, 'library')) return <Page title="Library"><Message variant="error">This role does not have mobile library access.</Message></Page>;

  return (
    <Page title="Library" subtitle="Search and manage books using the existing school catalogue.">
      {error ? <Message variant="error">{error}</Message> : null}
      {notice ? <Message variant="success">{notice}</Message> : null}
      <Button title="Refresh catalogue" variant="secondary" onPress={() => void loadBooks()} />
      <Card>
        <Heading>Search catalogue</Heading>
        <Field label="Title, author, ISBN, or accession barcode" value={search} onChangeText={setSearch} autoCapitalize="none" />
        {loading ? <Loading label="Loading books…" /> : filteredBooks.length === 0
          ? <BodyText muted>No matching books are available.</BodyText>
          : filteredBooks.map((book) => <View key={book.id} style={{ borderTopWidth: 1, borderColor: colors.border, paddingTop: 10, gap: 6 }}>
            <Text style={{ color: colors.text, fontWeight: '700' }}>{book.title}</Text>
            <BodyText muted>{book.authors.join(', ') || 'Author not listed'} · {book.available_copies}/{book.total_copies} available</BodyText>
            {book.cover_url ? <Image source={{ uri: book.cover_url }} style={{ width: 64, height: 88, borderRadius: 6 }} resizeMode="cover" /> : null}
            <BodyText>Barcode: {book.barcode}{book.isbn ? ` · ISBN ${book.isbn}` : ''}</BodyText>
            <View style={{ gap: 8 }}>
              <Button title={selectedBook?.id === book.id ? 'Selected for checkout' : 'Select for checkout'} variant="secondary" onPress={() => setSelectedBook(book)} />
              <Button title="Create sticker PDF" variant="secondary" onPress={() => void exportSticker(book)} />
            </View>
          </View>)}
      </Card>

      {canManageLibrary ? <Card>
        <Heading>Add a book by ISBN</Heading>
        <Field label="ISBN-10 or ISBN-13" value={form.isbn} onChangeText={(isbn) => setForm((current) => ({ ...current, isbn: normalizeIsbn(isbn) }))} autoCapitalize="characters" />
        <Button title={fetchingIsbn ? 'Looking up…' : 'Fetch book details'} variant="secondary" disabled={fetchingIsbn} onPress={() => void fetchIsbn()} />
        <Field label="Title" value={form.title} onChangeText={(title) => setForm((current) => ({ ...current, title }))} />
        <Field label="Authors (comma separated)" value={form.authors} onChangeText={(authors) => setForm((current) => ({ ...current, authors }))} />
        <Field label="Publisher" value={form.publisher} onChangeText={(publisher) => setForm((current) => ({ ...current, publisher }))} />
        <Field label="Edition" value={form.edition} onChangeText={(edition) => setForm((current) => ({ ...current, edition }))} />
        <Field label="Publication year" value={form.publication_year} onChangeText={(publication_year) => setForm((current) => ({ ...current, publication_year }))} keyboardType="number-pad" />
        <Field label="Number of copies" value={form.copies} onChangeText={(copies) => setForm((current) => ({ ...current, copies }))} keyboardType="number-pad" />
        <Button title={saving ? 'Saving…' : 'Add to catalogue'} disabled={saving} onPress={() => void saveBook()} />
      </Card> : null}

      {canManageLibrary ? <Card>
        <Heading>Check out a book</Heading>
        {selectedBook ? <BodyText>Book: {selectedBook.title}</BodyText> : <BodyText muted>Select a book from the catalogue first.</BodyText>}
        <Field label="Find active student by name or student number" value={studentSearch} onChangeText={setStudentSearch} />
        <Button title="Search students" variant="secondary" onPress={() => void findStudents()} />
        {students.map((student) => <Button key={student.id} title={`${student.first_name} ${student.last_name} · ${student.student_number}${student.school_classes?.name ? ` · ${student.school_classes.name}` : ''}`} variant={selectedStudent?.id === student.id ? 'primary' : 'secondary'} onPress={() => setSelectedStudent(student)} />)}
        <Button title={saving ? 'Processing…' : 'Confirm checkout'} disabled={saving || !selectedBook || !selectedStudent} onPress={() => void checkout()} />
        {issuedCode ? <View style={{ gap: 8 }}>
          <Text selectable style={{ textAlign: 'center', color: colors.navy, fontSize: 22, fontWeight: '800', letterSpacing: 2 }}>{issuedCode}</Text>
          <BodyText muted>Show or print this one-time code for the borrower. It is not stored in plain text by the system.</BodyText>
          <Button title="Print / share return pass PDF" variant="secondary" onPress={() => void exportReturnCode()} />
        </View> : null}
      </Card> : null}

      {canManageLibrary ? <Card>
        <Heading>Process a return</Heading>
        <Field label="Return code" value={returnCode} onChangeText={setReturnCode} autoCapitalize="characters" maxLength={32} />
        <Button title={saving ? 'Processing…' : 'Verify and return'} disabled={saving || !returnCode.trim()} onPress={() => void processReturn()} />
      </Card> : null}
      <Card>
        <Heading>Book stickers</Heading>
        <BodyText muted>The current school catalogue stores barcodes at title level, not as individual copy records. Stickers generated here use that existing barcode for each printed label.</BodyText>
        {selectedBook ? <Field label="Sticker count (1-100)" value={copiesForPdf} onChangeText={setCopiesForPdf} keyboardType="number-pad" /> : <BodyText muted>Select a book above to create its sticker PDF.</BodyText>}
      </Card>
    </Page>
  );
}
