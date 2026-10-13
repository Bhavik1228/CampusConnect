import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Banknote, Download, FileText, Receipt, WalletCards } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';
import type { FinancePdfDocument, FinancePdfSection } from '../lib/finance-pdf';
import type { AppRole } from '../types/database';

type FinanceTab = 'overview' | 'structures' | 'invoices' | 'payments' | 'statements';
type PaymentMethod = 'cash' | 'bank_transfer' | 'card' | 'mobile_money' | 'cheque' | 'other';

interface FeeStructure {
  id: string;
  name: string;
  description: string | null;
  amount: number;
  currency_code: string;
  due_date: string | null;
  is_active: boolean;
}

interface FeeStudent {
  id: string;
  student_number: string;
  first_name: string;
  last_name: string;
}

interface FeeInvoice {
  id: string;
  student_id: string;
  fee_structure_id: string | null;
  invoice_number: string;
  description: string;
  amount: number;
  discount_amount: number;
  discount_reason: string | null;
  currency_code: string;
  issued_on: string;
  due_on: string;
  status: 'issued' | 'void';
}

interface FeeAdjustment {
  id: string;
  invoice_id: string;
  adjustment_type: 'charge' | 'credit';
  amount: number;
  reason: string;
  created_at: string;
}

interface FeePayment {
  id: string;
  student_id: string;
  receipt_number: string;
  amount: number;
  currency_code: string;
  payment_date: string;
  payment_method: PaymentMethod;
  reference: string | null;
}

interface PaymentAllocation {
  payment_id: string;
  invoice_id: string;
  amount: number;
}

const financeRoles: AppRole[] = ['school_admin', 'finance_manager', 'accountant', 'bursar', 'cashier'];
const managerRoles: AppRole[] = ['school_admin', 'finance_manager', 'accountant', 'bursar'];
const tabs: { id: FinanceTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'structures', label: 'Fee structures' },
  { id: 'invoices', label: 'Invoices' },
  { id: 'payments', label: 'Payments & receipts' },
  { id: 'statements', label: 'Account statements' },
];

function money(amount: number, currencyCode: string) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode }).format(amount);
}

function pdfMoney(amount: number, currencyCode: string) {
  return `${currencyCode} ${amount.toFixed(2)}`;
}

async function fetchAllRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
) {
  const rows: T[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

export function FinancePage() {
  const { activeMembership, user } = useAuth();
  const schoolId = activeMembership?.school_id;
  const canManage = managerRoles.includes(activeMembership?.role ?? 'student');
  const canRecordPayment = financeRoles.includes(activeMembership?.role ?? 'student');
  const [tab, setTab] = useState<FinanceTab>('overview');
  const [structures, setStructures] = useState<FeeStructure[]>([]);
  const [students, setStudents] = useState<FeeStudent[]>([]);
  const [invoices, setInvoices] = useState<FeeInvoice[]>([]);
  const [adjustments, setAdjustments] = useState<FeeAdjustment[]>([]);
  const [payments, setPayments] = useState<FeePayment[]>([]);
  const [allocations, setAllocations] = useState<PaymentAllocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedStructureId, setSelectedStructureId] = useState('');
  const [selectedPaymentStudent, setSelectedPaymentStudent] = useState('');
  const [paymentAllocations, setPaymentAllocations] = useState<Record<string, string>>({});
  const [paymentCurrency, setPaymentCurrency] = useState('USD');
  const [statementStudent, setStatementStudent] = useState('');

  const loadFinance = useCallback(async () => {
    if (!schoolId) return;
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [structureResult, studentResult, invoiceResult, adjustmentResult, paymentResult, allocationResult] = await Promise.all([
        fetchAllRows((from, to) => client.from('fee_structures').select('id,name,description,amount,currency_code,due_date,is_active').eq('school_id', schoolId).order('name').range(from, to)),
        fetchAllRows((from, to) => client.from('finance_student_directory').select('id,student_number,first_name,last_name').eq('school_id', schoolId).order('last_name').range(from, to)),
        fetchAllRows((from, to) => client.from('student_fee_invoices').select('id,student_id,fee_structure_id,invoice_number,description,amount,discount_amount,discount_reason,currency_code,issued_on,due_on,status').eq('school_id', schoolId).order('issued_on', { ascending: false }).range(from, to)),
        fetchAllRows((from, to) => client.from('student_fee_adjustments').select('id,invoice_id,adjustment_type,amount,reason,created_at').eq('school_id', schoolId).order('created_at').range(from, to)),
        fetchAllRows((from, to) => client.from('student_fee_payments').select('id,student_id,receipt_number,amount,currency_code,payment_date,payment_method,reference').eq('school_id', schoolId).order('payment_date', { ascending: false }).range(from, to)),
        fetchAllRows((from, to) => client.from('student_fee_payment_allocations').select('payment_id,invoice_id,amount').eq('school_id', schoolId).range(from, to)),
      ]);
      setStructures(structureResult as FeeStructure[]);
      setStudents(studentResult as FeeStudent[]);
      setInvoices(invoiceResult as FeeInvoice[]);
      setAdjustments(adjustmentResult as FeeAdjustment[]);
      setPayments(paymentResult as FeePayment[]);
      setAllocations(allocationResult as PaymentAllocation[]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load school fee records.');
    } finally {
      setLoading(false);
    }
  }, [schoolId]);

  useEffect(() => { void loadFinance(); }, [loadFinance, refreshKey]);

  const studentsById = useMemo(() => new Map(students.map((student) => [student.id, student])), [students]);
  const outstandingByInvoice = useMemo(() => {
    const balances = new Map<string, number>();
    for (const invoice of invoices) {
      const adjustmentTotal = adjustments
        .filter((adjustment) => adjustment.invoice_id === invoice.id)
        .reduce((sum, adjustment) => sum + (adjustment.adjustment_type === 'charge' ? adjustment.amount : -adjustment.amount), 0);
      const allocatedTotal = allocations
        .filter((allocation) => allocation.invoice_id === invoice.id)
        .reduce((sum, allocation) => sum + allocation.amount, 0);
      balances.set(invoice.id, invoice.status === 'issued'
        ? Math.max(0, invoice.amount - invoice.discount_amount + adjustmentTotal - allocatedTotal)
        : 0);
    }
    return balances;
  }, [invoices, adjustments, allocations]);

  const openInvoices = useMemo(
    () => invoices.filter((invoice) => invoice.status === 'issued' && (outstandingByInvoice.get(invoice.id) ?? 0) > 0),
    [invoices, outstandingByInvoice],
  );
  const selectedStructure = structures.find((structure) => structure.id === selectedStructureId);
  const selectedStudentInvoices = openInvoices.filter((invoice) => invoice.student_id === selectedPaymentStudent);
  const selectedStatementStudent = statementStudent || students[0]?.id || '';
  const statementInvoices = invoices.filter((invoice) => invoice.student_id === selectedStatementStudent && invoice.status === 'issued');
  const statementPayments = payments.filter((payment) => payment.student_id === selectedStatementStudent);

  async function runPdfExport(createPdf: (pdf: typeof import('../lib/finance-pdf')) => void) {
    setFormError('');
    try {
      createPdf(await import('../lib/finance-pdf'));
    } catch (exportError) {
      setFormError(exportError instanceof Error ? exportError.message : 'The PDF could not be created.');
    }
  }

  function invoiceSections(invoice: FeeInvoice): FinancePdfSection[] {
    const invoiceAdjustments = adjustments.filter((adjustment) => adjustment.invoice_id === invoice.id);
    const rows = [
      [invoice.description, pdfMoney(invoice.amount, invoice.currency_code)],
      ...(invoice.discount_amount > 0 ? [[
        `Discount / scholarship${invoice.discount_reason ? ` — ${invoice.discount_reason}` : ''}`,
        `-${pdfMoney(invoice.discount_amount, invoice.currency_code)}`,
      ]] : []),
      ...invoiceAdjustments.map((adjustment) => [
        `${adjustment.adjustment_type === 'charge' ? 'Additional charge' : 'Credit adjustment'} — ${adjustment.reason}`,
        `${adjustment.adjustment_type === 'credit' ? '-' : ''}${pdfMoney(adjustment.amount, invoice.currency_code)}`,
      ]),
    ];
    return [{ title: 'Invoice items', columns: ['Description', 'Amount'], rows }];
  }

  function statementSections(studentId: string): FinancePdfSection[] {
    const events: { date: string; order: number; entry: string; reference: string; currency: string; debit: number; credit: number }[] = [];
    const studentInvoices = invoices.filter((invoice) => invoice.student_id === studentId && invoice.status === 'issued');
    const studentInvoiceIds = new Set(studentInvoices.map((invoice) => invoice.id));
    for (const invoice of studentInvoices) {
      events.push({ date: invoice.issued_on, order: 0, entry: invoice.description, reference: invoice.invoice_number, currency: invoice.currency_code, debit: invoice.amount, credit: 0 });
      if (invoice.discount_amount > 0) {
        events.push({ date: invoice.issued_on, order: 1, entry: `Discount / scholarship${invoice.discount_reason ? `: ${invoice.discount_reason}` : ''}`, reference: invoice.invoice_number, currency: invoice.currency_code, debit: 0, credit: invoice.discount_amount });
      }
    }
    for (const adjustment of adjustments.filter((item) => studentInvoiceIds.has(item.invoice_id))) {
      const invoice = studentInvoices.find((item) => item.id === adjustment.invoice_id);
      if (!invoice) continue;
      events.push({
        date: adjustment.created_at.slice(0, 10),
        order: adjustment.adjustment_type === 'charge' ? 2 : 3,
        entry: `${adjustment.adjustment_type === 'charge' ? 'Additional charge' : 'Credit adjustment'}: ${adjustment.reason}`,
        reference: invoice.invoice_number,
        currency: invoice.currency_code,
        debit: adjustment.adjustment_type === 'charge' ? adjustment.amount : 0,
        credit: adjustment.adjustment_type === 'credit' ? adjustment.amount : 0,
      });
    }
    for (const payment of payments.filter((item) => item.student_id === studentId)) {
      const paymentAllocations = allocations.filter((allocation) => allocation.payment_id === payment.id);
      const allocatedTotal = paymentAllocations.reduce((total, allocation) => total + allocation.amount, 0);
      for (const allocation of paymentAllocations) {
        const invoice = studentInvoices.find((item) => item.id === allocation.invoice_id);
        if (!invoice) continue;
        events.push({
          date: payment.payment_date,
          order: 4,
          entry: `Payment allocation (${payment.payment_method.replace(/_/g, ' ')})`,
          reference: `${payment.receipt_number} / ${invoice.invoice_number}`,
          currency: payment.currency_code,
          debit: 0,
          credit: allocation.amount,
        });
      }
      const unapplied = Math.max(0, payment.amount - allocatedTotal);
      if (unapplied > 0) {
        events.push({
          date: payment.payment_date,
          order: 5,
          entry: 'Unallocated payment on account',
          reference: payment.receipt_number,
          currency: payment.currency_code,
          debit: 0,
          credit: unapplied,
        });
      }
    }
    events.sort((left, right) => left.date.localeCompare(right.date) || left.order - right.order || left.reference.localeCompare(right.reference));
    const balances = new Map<string, number>();
    const rows = events.map((item) => {
      const balance = (balances.get(item.currency) ?? 0) + item.debit - item.credit;
      balances.set(item.currency, balance);
      return [
        item.date,
        item.entry,
        item.reference,
        item.currency,
        item.debit ? pdfMoney(item.debit, item.currency) : '-',
        item.credit ? pdfMoney(item.credit, item.currency) : '-',
        pdfMoney(balance, item.currency),
      ];
    });
    const summary = [...balances.entries()].map(([currency, balance]) => (
      balance < 0
        ? `Credit on account · ${pdfMoney(Math.abs(balance), currency)}`
        : `Closing balance · ${pdfMoney(balance, currency)}`
    ));
    return [{
      title: 'Account activity',
      columns: ['Date', 'Entry', 'Reference', 'Currency', 'Debit', 'Credit', 'Balance'],
      rows,
      summary,
    }];
  }

  function downloadInvoice(invoice: FeeInvoice) {
    const invoiceAllocations = allocations.filter((allocation) => allocation.invoice_id === invoice.id);
    const invoiceAdjustments = adjustments.filter((adjustment) => adjustment.invoice_id === invoice.id);
    const adjustmentTotal = invoiceAdjustments.reduce(
      (total, adjustment) => total + (adjustment.adjustment_type === 'charge' ? adjustment.amount : -adjustment.amount),
      0,
    );
    const amountPaid = invoiceAllocations.reduce((total, allocation) => total + allocation.amount, 0);
    const balanceDue = outstandingByInvoice.get(invoice.id) ?? 0;
    const student = studentsById.get(invoice.student_id);
    const document: FinancePdfDocument = {
      kind: 'invoice',
      number: invoice.invoice_number,
      issuedOn: invoice.issued_on,
      dueOn: invoice.due_on,
      recipientName: student ? `${student.first_name} ${student.last_name}` : 'Unknown student',
      recipientReference: student ? `Student number: ${student.student_number}` : undefined,
      status: invoice.status === 'void'
        ? 'Void'
        : balanceDue === 0
          ? 'Paid'
          : amountPaid > 0
            ? 'Partially paid'
            : 'Unpaid',
      currencyCode: invoice.currency_code,
      subtotal: invoice.amount,
      discount: invoice.discount_amount,
      adjustments: adjustmentTotal,
      amountPaid,
      balanceDue,
    };
    void runPdfExport(({ downloadFinancePdf }) => downloadFinancePdf({
      title: 'Invoice',
      schoolName: activeMembership?.school.name ?? 'School',
      issuerDetails: getIssuerDetails(),
      filename: invoice.invoice_number,
      document,
      sections: invoiceSections(invoice),
    }));
  }

  function downloadAllInvoices() {
    const rows = invoices.map((invoice) => [
      invoice.invoice_number,
      displayStudent(invoice.student_id),
      invoice.description,
      invoice.issued_on,
      invoice.due_on,
      pdfMoney(invoice.amount, invoice.currency_code),
      pdfMoney(invoice.discount_amount, invoice.currency_code),
      pdfMoney(outstandingByInvoice.get(invoice.id) ?? 0, invoice.currency_code),
      invoice.status,
    ]);
    void runPdfExport(({ downloadFinancePdf }) => downloadFinancePdf({
      title: 'All student fee invoices',
      schoolName: activeMembership?.school.name ?? 'School',
      issuerDetails: getIssuerDetails(),
      filename: `all-invoices-${new Date().toISOString().slice(0, 10)}`,
      document: { kind: 'register', issuedOn: new Date().toISOString().slice(0, 10) },
      details: [`Invoices included: ${rows.length}`],
      sections: [{ title: 'Invoice register', columns: ['Invoice', 'Student', 'Description', 'Issued', 'Due', 'Amount', 'Discount', 'Outstanding', 'Status'], rows }],
    }));
  }

  function downloadReceipt(payment: FeePayment) {
    const receiptAllocations = allocations.filter((allocation) => allocation.payment_id === payment.id);
    const allocatedTotal = receiptAllocations.reduce((total, allocation) => total + allocation.amount, 0);
    const student = studentsById.get(payment.student_id);
    void runPdfExport(({ downloadFinancePdf }) => downloadFinancePdf({
      title: 'Payment receipt',
      schoolName: activeMembership?.school.name ?? 'School',
      issuerDetails: getIssuerDetails(),
      filename: payment.receipt_number,
      document: {
        kind: 'receipt',
        number: payment.receipt_number,
        issuedOn: payment.payment_date,
        recipientName: student ? `${student.first_name} ${student.last_name}` : 'Unknown student',
        recipientReference: student ? `Student number: ${student.student_number}` : undefined,
        currencyCode: payment.currency_code,
        paymentAmount: payment.amount,
        paymentMethod: payment.payment_method,
        paymentReference: payment.reference || undefined,
      },
      sections: [
        { title: 'Invoice allocation', columns: ['Invoice', 'Invoice description', 'Allocated'], rows: receiptAllocations.length
          ? receiptAllocations.map((allocation) => {
            const invoice = invoices.find((item) => item.id === allocation.invoice_id);
            return [invoice?.invoice_number ?? 'Invoice', invoice?.description ?? '-', pdfMoney(allocation.amount, payment.currency_code)];
          })
          : [['Unallocated advance payment', '-', pdfMoney(0, payment.currency_code)]] },
        ...(payment.amount > allocatedTotal ? [{ title: 'Unallocated amount', columns: ['Available credit'], rows: [[pdfMoney(payment.amount - allocatedTotal, payment.currency_code)]] }] : []),
      ],
    }));
  }

  function downloadAllReceipts() {
    const rows = payments.map((payment) => {
      const paymentAllocations = allocations.filter((allocation) => allocation.payment_id === payment.id);
      const allocatedTotal = paymentAllocations.reduce((total, allocation) => total + allocation.amount, 0);
      return [
        payment.receipt_number,
        displayStudent(payment.student_id),
        payment.payment_date,
        payment.payment_method.replace(/_/g, ' '),
        payment.reference || '-',
        pdfMoney(payment.amount, payment.currency_code),
        pdfMoney(Math.max(0, payment.amount - allocatedTotal), payment.currency_code),
      ];
    });
    void runPdfExport(({ downloadFinancePdf }) => downloadFinancePdf({
      title: 'All payment receipts',
      schoolName: activeMembership?.school.name ?? 'School',
      issuerDetails: getIssuerDetails(),
      filename: `all-receipts-${new Date().toISOString().slice(0, 10)}`,
      document: { kind: 'register', issuedOn: new Date().toISOString().slice(0, 10) },
      details: [`Receipts included: ${rows.length}`],
      sections: [{ title: 'Receipt register', columns: ['Receipt', 'Student', 'Date', 'Method', 'Reference', 'Amount', 'Unallocated'], rows }],
    }));
  }

  function downloadStudentStatement(studentId: string) {
    const student = studentsById.get(studentId);
    if (!student) {
      setFormError('Choose a student before downloading an account statement.');
      return;
    }
    const sections = statementSections(studentId);
    const statementStudent = studentsById.get(studentId);
    void runPdfExport(({ downloadFinancePdf }) => downloadFinancePdf({
      title: 'Account statement',
      schoolName: activeMembership?.school.name ?? 'School',
      issuerDetails: getIssuerDetails(),
      filename: `statement-${student.student_number}-${new Date().toISOString().slice(0, 10)}`,
      document: {
        kind: 'statement',
        issuedOn: new Date().toISOString().slice(0, 10),
        recipientName: statementStudent ? `${statementStudent.first_name} ${statementStudent.last_name}` : 'Unknown student',
        recipientReference: `Student number: ${student.student_number}`,
      },
      sections: sections.map((section) => section.rows.length ? section : {
        ...section,
        rows: [['-', 'No account activity', '-', '-', '-', '-', '0.00']],
      }),
    }));
  }

  function downloadAllStatements() {
    const sections = students.map((student) => {
      const ledger = statementSections(student.id)[0];
      return {
        ...ledger,
        title: `${student.first_name} ${student.last_name} (${student.student_number})`,
        rows: ledger.rows.length ? ledger.rows : [['-', 'No account activity', '-', '-', '-', '-', '0.00']],
      };
    });
    void runPdfExport(({ downloadFinancePdf }) => downloadFinancePdf({
      title: 'All student account statements',
      schoolName: activeMembership?.school.name ?? 'School',
      issuerDetails: getIssuerDetails(),
      filename: `all-statements-${new Date().toISOString().slice(0, 10)}`,
      document: { kind: 'statement', issuedOn: new Date().toISOString().slice(0, 10) },
      details: [`Students included: ${sections.length}`],
      sections,
    }));
  }

  function downloadFeeStructures() {
    const rows = structures.map((structure) => [
      structure.name,
      structure.description || '-',
      pdfMoney(structure.amount, structure.currency_code),
      structure.due_date || '-',
      structure.is_active ? 'Active' : 'Inactive',
    ]);
    void runPdfExport(({ downloadFinancePdf }) => downloadFinancePdf({
      title: 'Fee structure catalog',
      schoolName: activeMembership?.school.name ?? 'School',
      issuerDetails: getIssuerDetails(),
      filename: `fee-structures-${new Date().toISOString().slice(0, 10)}`,
      document: { kind: 'catalog', issuedOn: new Date().toISOString().slice(0, 10) },
      sections: [{ title: 'Fee structures', columns: ['Name', 'Description', 'Amount', 'Default due date', 'Status'], rows }],
    }));
  }

  function displayStudent(studentId: string) {
    const student = studentsById.get(studentId);
    return student ? `${student.first_name} ${student.last_name} · ${student.student_number}` : 'Unknown student';
  }

  function getIssuerDetails() {
    const school = activeMembership?.school;
    return [school?.address, school?.contact_phone, school?.contact_email, school?.website]
      .filter((detail): detail is string => Boolean(detail?.trim()));
  }

  function showSuccess(message: string) {
    setSuccess(message);
    setFormError('');
    setRefreshKey((key) => key + 1);
  }

  async function addFeeStructure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !user) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setSaving(true);
    setFormError('');
    setSuccess('');
    try {
      const { error: insertError } = await requireSupabase().from('fee_structures').insert({
        school_id: schoolId,
        name: String(form.get('name')).trim(),
        description: String(form.get('description')).trim() || null,
        amount: Number(form.get('amount')),
        currency_code: String(form.get('currency_code')).trim().toUpperCase(),
        due_date: String(form.get('due_date')) || null,
        created_by: user.id,
      });
      if (insertError) throw insertError;
      formElement.reset();
      showSuccess('Fee structure created.');
    } catch (saveError) {
      setFormError(saveError instanceof Error ? saveError.message : 'The fee structure could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function createInvoice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !user) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const amount = selectedStructure ? selectedStructure.amount : Number(form.get('amount'));
    const discount = Number(form.get('discount_amount') || 0);
    if (discount > amount) {
      setFormError('A discount cannot be greater than the invoice amount.');
      return;
    }
    if (discount > 0 && !String(form.get('discount_reason')).trim()) {
      setFormError('Enter a reason for the discount or scholarship.');
      return;
    }
    setSaving(true);
    setFormError('');
    setSuccess('');
    try {
      const invoiceNumber = `INV-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const { error: insertError } = await requireSupabase().from('student_fee_invoices').insert({
        school_id: schoolId,
        student_id: String(form.get('student_id')),
        fee_structure_id: selectedStructure?.id || null,
        invoice_number: invoiceNumber,
        description: selectedStructure?.name || String(form.get('description')).trim(),
        amount,
        discount_amount: discount,
        discount_reason: discount > 0 ? String(form.get('discount_reason')).trim() : null,
        currency_code: selectedStructure?.currency_code || String(form.get('currency_code')).trim().toUpperCase(),
        issued_on: String(form.get('issued_on')),
        due_on: selectedStructure?.due_date || String(form.get('due_on')),
        created_by: user.id,
      });
      if (insertError) throw insertError;
      formElement.reset();
      setSelectedStructureId('');
      showSuccess(`Invoice ${invoiceNumber} issued.`);
    } catch (saveError) {
      setFormError(saveError instanceof Error ? saveError.message : 'The invoice could not be created.');
    } finally {
      setSaving(false);
    }
  }

  async function addAdjustment(event: FormEvent<HTMLFormElement>, invoice: FeeInvoice) {
    event.preventDefault();
    if (!schoolId || !user) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const adjustmentType = String(form.get('adjustment_type'));
    const amount = Number(form.get('amount'));
    const reason = String(form.get('reason')).trim();
    const outstanding = outstandingByInvoice.get(invoice.id) ?? 0;
    if (!Number.isFinite(amount) || amount <= 0) {
      setFormError('Enter an adjustment amount greater than zero.');
      return;
    }
    if (adjustmentType === 'credit' && amount > outstanding) {
      setFormError(`A credit cannot exceed this invoice's outstanding balance of ${money(outstanding, invoice.currency_code)}.`);
      return;
    }
    if (reason.length < 2 || reason.length > 240) {
      setFormError('Enter an adjustment reason between 2 and 240 characters.');
      return;
    }
    setSaving(true);
    setFormError('');
    setSuccess('');
    try {
      const { error: insertError } = await requireSupabase().rpc('record_student_fee_adjustment', {
        target_school: schoolId,
        target_invoice: invoice.id,
        p_adjustment_type: adjustmentType,
        p_adjustment_amount: amount,
        p_adjustment_reason: reason,
      });
      if (insertError) throw insertError;
      formElement.reset();
      showSuccess(`Adjustment recorded for ${invoice.invoice_number}.`);
    } catch (saveError) {
      setFormError(saveError instanceof Error ? saveError.message : 'The adjustment could not be recorded.');
    } finally {
      setSaving(false);
    }
  }

  async function recordPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !selectedPaymentStudent) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const selectedAllocations = Object.entries(paymentAllocations)
      .filter(([invoiceId, amount]) => selectedStudentInvoices.some((invoice) => invoice.id === invoiceId && invoice.currency_code === paymentCurrency) && Number(amount) > 0)
      .map(([invoice_id, amount]) => ({ invoice_id, amount: Number(amount) }));
    const paymentAmount = Number(form.get('amount'));
    const allocatedAmount = selectedAllocations.reduce((sum, allocation) => sum + allocation.amount, 0);
    if (allocatedAmount > paymentAmount) {
      setFormError('Allocated amounts cannot exceed the payment received.');
      return;
    }
    setSaving(true);
    setFormError('');
    setSuccess('');
    try {
      const { data, error: recordError } = await requireSupabase().rpc('record_student_fee_payment', {
        target_school: schoolId,
        target_student: selectedPaymentStudent,
        payment_amount: paymentAmount,
        payment_currency_code: paymentCurrency.trim().toUpperCase(),
        payment_date: String(form.get('payment_date')),
        payment_method: String(form.get('payment_method')),
        payment_reference: String(form.get('reference')).trim(),
        invoice_allocations: selectedAllocations,
      });
      if (recordError) throw recordError;
      formElement.reset();
      setPaymentAllocations({});
      showSuccess(`Payment recorded. Receipt ${String(data)} is ready.`);
    } catch (saveError) {
      setFormError(saveError instanceof Error ? saveError.message : 'The payment could not be recorded.');
    } finally {
      setSaving(false);
    }
  }

  if (!canRecordPayment) {
    return <div className="page-stack"><div className="page-heading"><div><span className="eyebrow">School finance</span><h1>Student fees</h1><p>Fee management is available to school administrators and accounting staff.</p></div></div><ErrorState message="Your school role does not have access to student fee records." /></div>;
  }

  return (
    <div className="page-stack">
      <div className="page-heading"><div><span className="eyebrow">School finance</span><h1>Student fees</h1><p>Manage fee structures, student accounts, invoices, and payments.</p></div></div>
      {error && <ErrorState message={error} />}
      {formError && <ErrorState message={formError} />}
      {success && <SuccessMessage message={success} />}
      <div className="accounting-tabs" role="tablist" aria-label="Student fee management">{tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} onClick={() => { setTab(item.id); setFormError(''); }}>{item.label}</button>)}</div>
      {loading ? <LoadingState label="Loading student fee records…" /> : <>
        {tab === 'overview' && <>
          <section className="stat-grid accounting-stat-grid" aria-label="Fee summary">
            <article className="stat-card"><div className="stat-card-top"><span>Open invoices</span><span className="stat-icon purple"><WalletCards size={19} /></span></div><strong>{openInvoices.length.toLocaleString()}</strong><span className="stat-caption">Outstanding amounts are shown per invoice and currency</span></article>
            <article className="stat-card"><div className="stat-card-top"><span>Payments recorded</span><span className="stat-icon green"><Banknote size={19} /></span></div><strong>{payments.length.toLocaleString()}</strong><span className="stat-caption">View individual receipts by currency</span></article>
            <article className="stat-card"><div className="stat-card-top"><span>Discounts & scholarships</span><span className="stat-icon blue"><FileText size={19} /></span></div><strong>{invoices.filter((invoice) => invoice.discount_amount > 0).length.toLocaleString()}</strong><span className="stat-caption">Invoice discounts and scholarships applied</span></article>
          </section>
          <section className="dashboard-grid">
            <article className="content-card"><div className="section-heading"><div><span className="eyebrow">Needs attention</span><h2>Outstanding invoices</h2></div></div>
              {openInvoices.length === 0 ? <EmptyState title="All caught up" detail="There are no outstanding student fee balances." /> : <div className="accounting-list">{openInvoices.slice(0, 8).map((invoice) => <div className="accounting-list-row" key={invoice.id}><div><strong>{displayStudent(invoice.student_id)}</strong><span>{invoice.invoice_number} · due {invoice.due_on}</span></div><strong>{money(outstandingByInvoice.get(invoice.id) ?? 0, invoice.currency_code)}</strong></div>)}</div>}
            </article>
            <article className="content-card"><div className="section-heading"><div><span className="eyebrow">Recent receipts</span><h2>Latest payments</h2></div><Receipt size={19} className="muted-icon" /></div>
              {payments.length === 0 ? <EmptyState title="No payments recorded" detail="Recorded student fee payments and receipts will appear here." /> : <div className="accounting-list">{payments.slice(0, 8).map((payment) => <div className="accounting-list-row" key={payment.id}><div><strong>{payment.receipt_number}</strong><span>{displayStudent(payment.student_id)} · {payment.payment_date}</span></div><strong>{money(payment.amount, payment.currency_code)}</strong></div>)}</div>}
            </article>
          </section>
        </>}
        {tab === 'structures' && <section className="content-card accounting-content-card">
          <div className="section-heading"><div><span className="eyebrow">Tuition & charges</span><h2>Fee structures</h2></div><button type="button" className="button button-quiet accounting-download-button" onClick={downloadFeeStructures}><Download size={15} />Download catalog PDF</button></div>
          {canManage && <form className="accounting-form accounting-inline-form" onSubmit={(event) => void addFeeStructure(event)}>
            <label className="field"><span>Fee name</span><input name="name" required minLength={2} maxLength={120} disabled={saving} /></label>
            <label className="field"><span>Amount</span><input name="amount" type="number" min="0" step="0.01" required disabled={saving} /></label>
            <label className="field"><span>Currency (ISO code)</span><input name="currency_code" defaultValue="USD" minLength={3} maxLength={3} pattern="[A-Za-z]{3}" required disabled={saving} /></label>
            <label className="field"><span>Default due date (optional)</span><input name="due_date" type="date" disabled={saving} /></label>
            <label className="field accounting-field-wide"><span>Description (optional)</span><input name="description" maxLength={240} disabled={saving} /></label>
            <button className="button button-primary" type="submit" disabled={saving}>Add fee structure</button>
          </form>}
          <div className="accounting-table-wrap"><table className="accounting-table"><thead><tr><th>Fee</th><th>Amount</th><th>Default due</th><th>Status</th>{canManage && <th>Manage</th>}</tr></thead><tbody>{structures.map((structure) => <tr key={structure.id}><td><strong>{structure.name}</strong>{structure.description && <small>{structure.description}</small>}</td><td>{money(structure.amount, structure.currency_code)}</td><td>{structure.due_date || '—'}</td><td><span className="accounting-status">{structure.is_active ? 'Active' : 'Inactive'}</span></td>{canManage && <td><button type="button" className="button button-quiet accounting-structure-action" disabled={saving} onClick={async () => { if (!schoolId) return; setSaving(true); setFormError(''); try { const { error: updateError } = await requireSupabase().from('fee_structures').update({ is_active: !structure.is_active }).eq('school_id', schoolId).eq('id', structure.id); if (updateError) throw updateError; showSuccess(`Fee structure ${structure.is_active ? 'deactivated' : 'activated'}.`); } catch (updateError) { setFormError(updateError instanceof Error ? updateError.message : 'The fee structure could not be updated.'); } finally { setSaving(false); } }}>{structure.is_active ? 'Deactivate' : 'Activate'}</button></td>}</tr>)}</tbody></table></div>
          {structures.length === 0 && <EmptyState title="No fee structures yet" detail="Add a fee structure before issuing invoices." />}
        </section>}
        {tab === 'invoices' && <section className="content-card accounting-content-card">
          <div className="section-heading"><div><span className="eyebrow">Student billing</span><h2>Issue an invoice</h2></div><div className="accounting-document-actions"><button type="button" className="button button-quiet accounting-download-button" onClick={downloadAllInvoices}><Download size={15} />Download all invoices PDF</button><FileText size={19} className="muted-icon" /></div></div>
          {canManage && <form className="accounting-form accounting-invoice-form" onSubmit={(event) => void createInvoice(event)}>
            <label className="field"><span>Student</span><select name="student_id" required defaultValue="" disabled={saving}><option value="" disabled>Select a student</option>{students.map((student) => <option key={student.id} value={student.id}>{student.first_name} {student.last_name} · {student.student_number}</option>)}</select></label>
            <label className="field"><span>Use a fee structure (optional)</span><select value={selectedStructureId} disabled={saving} onChange={(event) => setSelectedStructureId(event.target.value)}><option value="">Custom invoice</option>{structures.filter((structure) => structure.is_active).map((structure) => <option key={structure.id} value={structure.id}>{structure.name} · {money(structure.amount, structure.currency_code)}</option>)}</select></label>
            {!selectedStructure && <label className="field"><span>Description</span><input name="description" required minLength={2} maxLength={240} disabled={saving} /></label>}
            <label className="field"><span>Amount</span><input name="amount" type="number" min="0.01" step="0.01" required value={selectedStructure ? selectedStructure.amount : undefined} readOnly={Boolean(selectedStructure)} disabled={saving} /></label>
            {!selectedStructure && <label className="field"><span>Currency (ISO code)</span><input name="currency_code" defaultValue="USD" minLength={3} maxLength={3} pattern="[A-Za-z]{3}" required disabled={saving} /></label>}
            <label className="field"><span>Issued on</span><input name="issued_on" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} disabled={saving} /></label>
            {!selectedStructure?.due_date && <label className="field"><span>Due date</span><input name="due_on" type="date" required defaultValue={selectedStructure?.due_date ?? ''} disabled={saving} />{selectedStructure && <small>No default due date is set for this fee.</small>}</label>}
            <label className="field"><span>Discount / scholarship</span><input name="discount_amount" type="number" min="0" step="0.01" defaultValue="0" disabled={saving} /></label>
            <label className="field"><span>Discount reason</span><input name="discount_reason" maxLength={240} placeholder="Required when discount is greater than zero" disabled={saving} /></label>
            <button className="button button-primary accounting-field-wide" type="submit" disabled={saving || students.length === 0}>{saving ? 'Issuing…' : 'Issue student invoice'}</button>
          </form>}
          <div className="accounting-table-wrap"><table className="accounting-table"><thead><tr><th>Invoice</th><th>Student</th><th>Due</th><th>Original</th><th>Discount</th><th>Outstanding</th><th>Adjustment</th><th>PDF</th></tr></thead><tbody>{invoices.map((invoice) => {
            const outstanding = outstandingByInvoice.get(invoice.id) ?? 0;
            return <tr key={invoice.id}><td><strong>{invoice.invoice_number}</strong><small>{invoice.description}{invoice.discount_reason ? ` · ${invoice.discount_reason}` : ''}</small></td><td>{displayStudent(invoice.student_id)}</td><td>{invoice.due_on}</td><td>{money(invoice.amount, invoice.currency_code)}</td><td>{invoice.discount_amount > 0 ? money(invoice.discount_amount, invoice.currency_code) : '—'}</td><td>{money(outstanding, invoice.currency_code)}</td><td>{canManage && invoice.status === 'issued' ? <details className="accounting-adjustment"><summary>Adjust</summary><form onSubmit={(event) => void addAdjustment(event, invoice)}><select name="adjustment_type" aria-label="Adjustment type" defaultValue={outstanding > 0 ? 'credit' : 'charge'}><option value="credit" disabled={outstanding <= 0}>Credit adjustment{outstanding <= 0 ? ' (no outstanding balance)' : ''}</option><option value="charge">Additional charge</option></select><input name="amount" type="number" aria-label="Adjustment amount" placeholder="Amount" min="0.01" step="0.01" required disabled={saving} /><input name="reason" aria-label="Adjustment reason" placeholder="Reason" minLength={2} maxLength={240} required disabled={saving} /><button className="button button-primary" type="submit" disabled={saving}>Save</button></form></details> : invoice.status === 'void' ? 'Voided' : '—'}</td><td><button type="button" className="button button-quiet accounting-row-download" onClick={() => downloadInvoice(invoice)} aria-label={`Download invoice ${invoice.invoice_number} PDF`} title="Download invoice PDF"><Download size={15} /></button></td></tr>;
          })}</tbody></table></div>
          {invoices.length === 0 && <EmptyState title="No invoices yet" detail="Choose a student and issue an invoice for their school fees." />}
        </section>}
        {tab === 'payments' && <section className="content-card accounting-content-card">
          <div className="section-heading"><div><span className="eyebrow">Cash collection</span><h2>Record a fee payment</h2></div><div className="accounting-document-actions"><button type="button" className="button button-quiet accounting-download-button" onClick={downloadAllReceipts}><Download size={15} />Download all receipts PDF</button><Banknote size={19} className="muted-icon" /></div></div>
          {canRecordPayment && <form className="accounting-form accounting-payment-form" onSubmit={(event) => void recordPayment(event)}>
            <label className="field"><span>Student</span><select name="student" value={selectedPaymentStudent} required onChange={(event) => { const studentId = event.target.value; setSelectedPaymentStudent(studentId); setPaymentAllocations({}); const firstInvoice = openInvoices.find((invoice) => invoice.student_id === studentId); setPaymentCurrency(firstInvoice?.currency_code ?? 'USD'); }} disabled={saving}><option value="" disabled>Select a student</option>{students.map((student) => <option key={student.id} value={student.id}>{student.first_name} {student.last_name} · {student.student_number}</option>)}</select></label>
            <label className="field"><span>Amount received</span><input name="amount" type="number" min="0.01" step="0.01" required disabled={saving} /></label>
            <label className="field"><span>Currency (ISO code)</span><input name="currency_code" value={paymentCurrency} minLength={3} maxLength={3} pattern="[A-Za-z]{3}" required onChange={(event) => setPaymentCurrency(event.target.value.toUpperCase())} disabled={saving} /></label>
            <label className="field"><span>Payment date</span><input name="payment_date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required disabled={saving} /></label>
            <label className="field"><span>Method</span><select name="payment_method" defaultValue="cash" disabled={saving}>{(['cash', 'bank_transfer', 'card', 'mobile_money', 'cheque', 'other'] as PaymentMethod[]).map((method) => <option key={method} value={method}>{method.replace(/_/g, ' ')}</option>)}</select></label>
            <label className="field"><span>Reference (optional)</span><input name="reference" maxLength={120} disabled={saving} /></label>
            <div className="accounting-allocation-list accounting-field-wide"><strong>Allocate to open invoices (optional)</strong>{selectedPaymentStudent ? selectedStudentInvoices.filter((invoice) => invoice.currency_code === paymentCurrency).length ? selectedStudentInvoices.filter((invoice) => invoice.currency_code === paymentCurrency).map((invoice) => <label key={invoice.id}><span>{invoice.invoice_number} · due {invoice.due_on} · {money(outstandingByInvoice.get(invoice.id) ?? 0, invoice.currency_code)}</span><input type="number" min="0" max={outstandingByInvoice.get(invoice.id) ?? 0} step="0.01" placeholder="0.00" value={paymentAllocations[invoice.id] ?? ''} onChange={(event) => setPaymentAllocations((current) => ({ ...current, [invoice.id]: event.target.value }))} disabled={saving} /></label>) : <p>No open invoices for this student in {paymentCurrency}. The payment will remain unallocated on their account.</p> : <p>Choose a student to see their open invoices. You can record an unallocated advance payment.</p>}</div>
            <button className="button button-primary accounting-field-wide" type="submit" disabled={saving || students.length === 0}>{saving ? 'Recording…' : 'Record payment and issue receipt'}</button>
          </form>}
          <div className="accounting-table-wrap"><table className="accounting-table"><thead><tr><th>Receipt</th><th>Student</th><th>Date</th><th>Method</th><th>Reference</th><th>Amount</th><th>PDF</th></tr></thead><tbody>{payments.map((payment) => <tr key={payment.id}><td><strong>{payment.receipt_number}</strong></td><td>{displayStudent(payment.student_id)}</td><td>{payment.payment_date}</td><td>{payment.payment_method.replace(/_/g, ' ')}</td><td>{payment.reference || '—'}</td><td>{money(payment.amount, payment.currency_code)}</td><td><button type="button" className="button button-quiet accounting-row-download" onClick={() => downloadReceipt(payment)} aria-label={`Download receipt ${payment.receipt_number} PDF`} title="Download receipt PDF"><Download size={15} /></button></td></tr>)}</tbody></table></div>
          {payments.length === 0 && <EmptyState title="No fee receipts yet" detail="Recorded payments will appear here with their receipt number." />}
        </section>}
        {tab === 'statements' && <section className="content-card accounting-content-card">
          <div className="section-heading"><div><span className="eyebrow">Student account</span><h2>Account statement</h2></div><div className="accounting-document-actions"><button type="button" className="button button-quiet accounting-download-button" onClick={downloadAllStatements}><Download size={15} />Download all statements PDF</button><WalletCards size={19} className="muted-icon" /></div></div>
          <label className="field accounting-statement-student"><span>Student</span><select value={selectedStatementStudent} onChange={(event) => setStatementStudent(event.target.value)}><option value="">Select a student</option>{students.map((student) => <option key={student.id} value={student.id}>{student.first_name} {student.last_name} · {student.student_number}</option>)}</select></label>
          {selectedStatementStudent && <><div className="accounting-statement-toolbar"><div className="accounting-statement-summary"><span>Open invoices <strong>{statementInvoices.filter((invoice) => (outstandingByInvoice.get(invoice.id) ?? 0) > 0).length}</strong></span><span>Invoices <strong>{statementInvoices.length}</strong></span><span>Payments <strong>{statementPayments.length}</strong></span></div><button type="button" className="button button-quiet accounting-download-button" onClick={() => downloadStudentStatement(selectedStatementStudent)}><Download size={15} />Download statement PDF</button></div>
            <div className="accounting-table-wrap"><table className="accounting-table"><thead><tr><th>Date</th><th>Entry</th><th>Reference</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead><tbody>
              {statementInvoices.map((invoice) => <tr key={invoice.id}><td>{invoice.issued_on}</td><td>{invoice.description}{invoice.discount_amount > 0 && <small>Discount/scholarship: -{money(invoice.discount_amount, invoice.currency_code)} ({invoice.discount_reason})</small>}</td><td>{invoice.invoice_number}</td><td>{money(invoice.amount, invoice.currency_code)}</td><td>{invoice.discount_amount > 0 ? money(invoice.discount_amount, invoice.currency_code) : '—'}</td><td>{money(outstandingByInvoice.get(invoice.id) ?? 0, invoice.currency_code)}</td></tr>)}
              {statementInvoices.flatMap((invoice) => adjustments.filter((adjustment) => adjustment.invoice_id === invoice.id).map((adjustment) => <tr key={adjustment.id}><td>{adjustment.created_at.slice(0, 10)}</td><td>{adjustment.adjustment_type === 'charge' ? 'Additional charge' : 'Credit adjustment'}<small>{adjustment.reason}</small></td><td>{invoice.invoice_number}</td><td>{adjustment.adjustment_type === 'charge' ? money(adjustment.amount, invoice.currency_code) : '—'}</td><td>{adjustment.adjustment_type === 'credit' ? money(adjustment.amount, invoice.currency_code) : '—'}</td><td>{money(outstandingByInvoice.get(invoice.id) ?? 0, invoice.currency_code)}</td></tr>))}
              {statementPayments.map((payment) => { const applied = allocations.filter((allocation) => allocation.payment_id === payment.id); return <tr key={payment.id}><td>{payment.payment_date}</td><td>Fee payment · {payment.payment_method.replace(/_/g, ' ')}{applied.map((allocation) => <small key={allocation.invoice_id}>{invoices.find((invoice) => invoice.id === allocation.invoice_id)?.invoice_number}: {money(allocation.amount, payment.currency_code)}</small>)}</td><td>{payment.receipt_number}</td><td>—</td><td>{money(payment.amount, payment.currency_code)}</td><td>Unallocated: {money(Math.max(0, payment.amount - applied.reduce((sum, allocation) => sum + allocation.amount, 0)), payment.currency_code)}</td></tr>; })}
            </tbody></table></div></>}
          {!selectedStatementStudent && <EmptyState title="Select a student" detail="Choose a student to view their invoices, discounts, payments, and current balances." />}
        </section>}
      </>}
      <div className="accounting-currency-note">Financial amounts display in each fee's selected currency. Balances are calculated per invoice and are not combined across currencies.</div>
    </div>
  );
}
