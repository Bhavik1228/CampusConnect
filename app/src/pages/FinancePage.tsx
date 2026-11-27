import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Banknote, Download, FileText, Receipt, WalletCards } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { Tabs, TabList, Tab } from '../components/ui';
import { PdfPreviewDialog } from '../components/PdfPreviewDialog';
import { requireSupabase } from '../lib/supabase';
import type { FinancePdfDocument, FinancePdfSection } from '../lib/finance-pdf';
import type { AppRole } from '../types/database';
import {
  documentVerificationUrl,
  prepareOfficialDocument,
  savePdfBlob,
  storeOfficialDocument,
} from '../lib/official-documents';

type FinanceTab = 'overview' | 'structures' | 'invoices' | 'payments' | 'arrears' | 'statements';
type PaymentMethod = 'cash' | 'bank_transfer' | 'card' | 'mobile_money' | 'cheque' | 'other';
type ReminderChannel = 'email' | 'phone' | 'sms' | 'in_app';

interface FeeStructure {
  id: string;
  name: string;
  description: string | null;
  amount: number;
  currency_code: string;
  due_date: string | null;
  is_active: boolean;
}

interface FeeDiscountRule {
  id: string;
  fee_structure_id: string | null;
  name: string;
  discount_type: 'percentage' | 'fixed';
  discount_value: number;
  currency_code: string;
  minimum_active_siblings: number;
  is_active: boolean;
}

interface FeeDiscountPreview {
  rule_id: string | null;
  rule_name: string | null;
  discount_amount: number;
  active_sibling_count: number;
}

interface FeeRun {
  id: string;
  fee_structure_id: string;
  description: string;
  amount: number;
  currency_code: string;
  issued_on: string;
  due_on: string;
  status: 'draft' | 'issued' | 'cancelled';
  created_at: string;
  issued_at: string | null;
}

interface FeeRunItem {
  id: string;
  student_id: string;
  invoice_id: string | null;
  amount: number;
  discount_amount: number;
  discount_reason: string | null;
  currency_code: string;
}

interface PaymentPlan {
  id: string;
  invoice_id: string;
  balance_at_setup: number;
  installment_count: number;
  frequency: 'weekly' | 'biweekly' | 'monthly';
  status: 'active' | 'completed' | 'cancelled';
  created_at: string;
}

interface PaymentPlanScheduleItem {
  id: string;
  plan_id: string;
  invoice_id: string;
  installment_number: number;
  due_on: string;
  amount: number;
  paid_amount: number;
  balance_amount: number;
  status: 'scheduled' | 'paid' | 'overdue';
}

interface ReminderCadence {
  id: string;
  days_after_due: number;
  channel: ReminderChannel;
  is_active: boolean;
}

interface ReminderLog {
  id: string;
  invoice_id: string;
  cadence_id: string;
  channel: ReminderChannel;
  contact_note: string;
  contacted_at: string;
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
const financeViewRoles: AppRole[] = [...financeRoles, 'auditor'];
const managerRoles: AppRole[] = ['school_admin', 'finance_manager', 'accountant', 'bursar'];
const tabs: { id: FinanceTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'structures', label: 'Fee structures' },
  { id: 'invoices', label: 'Invoices' },
  { id: 'payments', label: 'Payments & receipts' },
  { id: 'arrears', label: 'Arrears & plans' },
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
  const canViewFinance = financeViewRoles.includes(activeMembership?.role ?? 'student');
  const canRecordPayment = financeRoles.includes(activeMembership?.role ?? 'student');
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<FinanceTab>(() => {
    const requestedTab = new URLSearchParams(window.location.search).get('tab');
    return tabs.some((item) => item.id === requestedTab) ? requestedTab as FinanceTab : 'overview';
  });
  const [invoiceSearch, setInvoiceSearch] = useState(() => new URLSearchParams(window.location.search).get('search') ?? '');
  const [structures, setStructures] = useState<FeeStructure[]>([]);
  const [discountRules, setDiscountRules] = useState<FeeDiscountRule[]>([]);
  const [feeRuns, setFeeRuns] = useState<FeeRun[]>([]);
  const [feeRunItems, setFeeRunItems] = useState<FeeRunItem[]>([]);
  const [paymentPlans, setPaymentPlans] = useState<PaymentPlan[]>([]);
  const [paymentPlanSchedule, setPaymentPlanSchedule] = useState<PaymentPlanScheduleItem[]>([]);
  const [reminderCadences, setReminderCadences] = useState<ReminderCadence[]>([]);
  const [reminderLogs, setReminderLogs] = useState<ReminderLog[]>([]);
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
  const [feeRunStructureId, setFeeRunStructureId] = useState('');
  const [feeRunIssuedOn, setFeeRunIssuedOn] = useState(new Date().toISOString().slice(0, 10));
  const [feeRunDueOn, setFeeRunDueOn] = useState('');
  const [activeFeeRunId, setActiveFeeRunId] = useState('');
  const [arrearsSearch, setArrearsSearch] = useState('');
  const [invoiceStudentId, setInvoiceStudentId] = useState('');
  const [invoiceCustomAmount, setInvoiceCustomAmount] = useState('');
  const [invoiceCurrencyCode, setInvoiceCurrencyCode] = useState('USD');
  const [discountPreview, setDiscountPreview] = useState<FeeDiscountPreview | null>(null);
  const [discountPreviewError, setDiscountPreviewError] = useState('');
  const [selectedPaymentStudent, setSelectedPaymentStudent] = useState('');
  const [paymentAllocations, setPaymentAllocations] = useState<Record<string, string>>({});
  const [paymentCurrency, setPaymentCurrency] = useState('USD');
  const [allocationEditorPaymentId, setAllocationEditorPaymentId] = useState('');
  const [allocationDrafts, setAllocationDrafts] = useState<Record<string, Record<string, string>>>({});
  const [statementStudent, setStatementStudent] = useState('');
  const [documentBranding, setDocumentBranding] = useState<{
    logo_path: string | null;
    primary_color: string | null;
    motto: string | null;
  }>({ logo_path: null, primary_color: null, motto: null });
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewFilename, setPreviewFilename] = useState('');

  const loadFinance = useCallback(async () => {
    if (!schoolId) return;
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [structureResult, discountRuleResult, feeRunResult, planResult, scheduleResult, cadenceResult, reminderLogResult, studentResult, invoiceResult, adjustmentResult, paymentResult, allocationResult, brandingResult] = await Promise.all([
        fetchAllRows((from, to) => client.from('fee_structures').select('id,name,description,amount,currency_code,due_date,is_active').eq('school_id', schoolId).order('name').range(from, to)),
        fetchAllRows((from, to) => client.from('fee_discount_rules').select('id,fee_structure_id,name,discount_type,discount_value,currency_code,minimum_active_siblings,is_active').eq('school_id', schoolId).order('name').range(from, to)),
        fetchAllRows((from, to) => client.from('student_fee_runs').select('id,fee_structure_id,description,amount,currency_code,issued_on,due_on,status,created_at,issued_at').eq('school_id', schoolId).order('created_at', { ascending: false }).range(from, to)),
        fetchAllRows((from, to) => client.from('student_fee_payment_plans').select('id,invoice_id,balance_at_setup,installment_count,frequency,status,created_at').eq('school_id', schoolId).order('created_at', { ascending: false }).range(from, to)),
        fetchAllRows((from, to) => client.from('student_fee_payment_plan_schedule').select('id,plan_id,invoice_id,installment_number,due_on,amount,paid_amount,balance_amount,status').eq('school_id', schoolId).order('due_on').range(from, to)),
        fetchAllRows((from, to) => client.from('fee_reminder_cadences').select('id,days_after_due,channel,is_active').eq('school_id', schoolId).order('days_after_due').range(from, to)),
        fetchAllRows((from, to) => client.from('fee_reminder_logs').select('id,invoice_id,cadence_id,channel,contact_note,contacted_at').eq('school_id', schoolId).order('contacted_at', { ascending: false }).range(from, to)),
        fetchAllRows((from, to) => client.from('finance_student_directory').select('id,student_number,first_name,last_name').eq('school_id', schoolId).order('last_name').range(from, to)),
        fetchAllRows((from, to) => client.from('student_fee_invoices').select('id,student_id,fee_structure_id,invoice_number,description,amount,discount_amount,discount_reason,currency_code,issued_on,due_on,status').eq('school_id', schoolId).order('issued_on', { ascending: false }).range(from, to)),
        fetchAllRows((from, to) => client.from('student_fee_adjustments').select('id,invoice_id,adjustment_type,amount,reason,created_at').eq('school_id', schoolId).order('created_at').range(from, to)),
        fetchAllRows((from, to) => client.from('student_fee_payments').select('id,student_id,receipt_number,amount,currency_code,payment_date,payment_method,reference').eq('school_id', schoolId).order('payment_date', { ascending: false }).range(from, to)),
        fetchAllRows((from, to) => client.from('student_fee_payment_allocations').select('payment_id,invoice_id,amount').eq('school_id', schoolId).range(from, to)),
        client.from('schools').select('logo_path,primary_color,motto').eq('id', schoolId).single(),
      ]);
      if (brandingResult.error) throw brandingResult.error;
      setDocumentBranding(brandingResult.data);
      setStructures(structureResult as FeeStructure[]);
      setDiscountRules(discountRuleResult as FeeDiscountRule[]);
      setFeeRuns(feeRunResult as FeeRun[]);
      setPaymentPlans(planResult as PaymentPlan[]);
      setPaymentPlanSchedule(scheduleResult as PaymentPlanScheduleItem[]);
      setReminderCadences(cadenceResult as ReminderCadence[]);
      setReminderLogs(reminderLogResult as ReminderLog[]);
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

  const loadFeeRunItems = useCallback(async (runId: string) => {
    if (!schoolId) return;
    const { data, error: itemsError } = await requireSupabase().from('student_fee_run_items')
      .select('id,student_id,invoice_id,amount,discount_amount,discount_reason,currency_code')
      .eq('school_id', schoolId)
      .eq('run_id', runId);
    if (itemsError) throw itemsError;
    setFeeRunItems((data ?? []) as FeeRunItem[]);
  }, [schoolId]);

  useEffect(() => { void loadFinance(); }, [loadFinance, refreshKey]);

  useEffect(() => {
    const requestedTab = searchParams.get('tab');
    const command = searchParams.get('command');
    const recordId = searchParams.get('commandRecord');
    if (requestedTab && tabs.some((item) => item.id === requestedTab)) setTab(requestedTab as FinanceTab);
    if (searchParams.has('search')) setInvoiceSearch(searchParams.get('search') ?? '');
    if (recordId) setInvoiceSearch('');
    if (command === 'create' && canManage) {
      setTab('invoices');
      window.requestAnimationFrame(() => document.getElementById('finance-invoice-student')?.focus());
    }
    if (recordId && !loading) {
      if (!invoices.some((invoice) => invoice.id === recordId)) setFormError('That invoice is unavailable or your access has changed.');
      else window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-command-record="${CSS.escape(recordId)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    }
  }, [searchParams, canManage, invoices, loading]);

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
  const filteredInvoices = useMemo(() => {
    const needle = invoiceSearch.trim().toLocaleLowerCase();
    if (!needle) return invoices;
    return invoices.filter((invoice) => {
      const student = studentsById.get(invoice.student_id);
      return `${invoice.invoice_number} ${invoice.description} ${student?.first_name ?? ''} ${student?.last_name ?? ''} ${student?.student_number ?? ''}`.toLocaleLowerCase().includes(needle);
    });
  }, [invoices, invoiceSearch, studentsById]);
  const selectedStructure = structures.find((structure) => structure.id === selectedStructureId);
  const activeFeeRun = feeRuns.find((run) => run.id === activeFeeRunId);
  const feeRunTotals = useMemo(() => feeRunItems.reduce((totals, item) => ({
    amount: totals.amount + Number(item.amount),
    discount: totals.discount + Number(item.discount_amount),
  }), { amount: 0, discount: 0 }), [feeRunItems]);
  const invoiceAmount = selectedStructure?.amount ?? Number(invoiceCustomAmount);
  const invoiceCurrency = selectedStructure?.currency_code ?? invoiceCurrencyCode.trim().toUpperCase();
  const selectedStudentInvoices = openInvoices.filter((invoice) => invoice.student_id === selectedPaymentStudent);
  const selectedStatementStudent = statementStudent || students[0]?.id || '';
  const statementInvoices = invoices.filter((invoice) => invoice.student_id === selectedStatementStudent && invoice.status === 'issued');
  const statementPayments = payments.filter((payment) => payment.student_id === selectedStatementStudent);
  const allocationsByPayment = useMemo(() => {
    const result = new Map<string, PaymentAllocation[]>();
    for (const allocation of allocations) {
      const current = result.get(allocation.payment_id) ?? [];
      current.push(allocation);
      result.set(allocation.payment_id, current);
    }
    return result;
  }, [allocations]);
  const unmatchedPayments = payments.filter((payment) => {
    const allocated = (allocationsByPayment.get(payment.id) ?? [])
      .reduce((total, allocation) => total + Number(allocation.amount), 0);
    return payment.amount - allocated > 0.005;
  });
  const today = new Date().toISOString().slice(0, 10);
  const overdueInvoices = openInvoices.filter((invoice) => invoice.due_on < today
    && (!arrearsSearch.trim() || `${invoice.invoice_number} ${displayStudent(invoice.student_id)} ${invoice.description}`.toLocaleLowerCase().includes(arrearsSearch.trim().toLocaleLowerCase())));
  const remindersDue = overdueInvoices.flatMap((invoice) => {
    const daysOverdue = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${invoice.due_on}T00:00:00Z`)) / 86400000);
    return reminderCadences.filter((cadence) => cadence.is_active
      && daysOverdue >= cadence.days_after_due
      && !reminderLogs.some((log) => log.invoice_id === invoice.id && log.cadence_id === cadence.id))
      .map((cadence) => ({ invoice, cadence, daysOverdue }));
  });
  const arrearsTotalsByCurrency = overdueInvoices.reduce<Record<string, number>>((totals, invoice) => {
    const currency = invoice.currency_code;
    totals[currency] = (totals[currency] ?? 0) + (outstandingByInvoice.get(invoice.id) ?? 0);
    return totals;
  }, {});

  useEffect(() => {
    if (!schoolId || !canManage || tab !== 'invoices' || !invoiceStudentId || !Number.isFinite(invoiceAmount) || invoiceAmount <= 0) {
      setDiscountPreview(null);
      setDiscountPreviewError('');
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setDiscountPreview(null);
      setDiscountPreviewError('');
      try {
        const { data, error: previewError } = await requireSupabase().rpc('get_student_fee_discount', {
          target_school: schoolId,
          target_student: invoiceStudentId,
          target_fee_structure: selectedStructure?.id ?? null,
          invoice_amount: invoiceAmount,
          invoice_currency_code: invoiceCurrency,
        });
        if (previewError) throw previewError;
        const result = (Array.isArray(data) ? data[0] : data) as FeeDiscountPreview | null;
        if (!result) throw new Error('The student discount preview returned no result.');
        if (!cancelled) setDiscountPreview(result);
      } catch (previewError) {
        if (!cancelled) {
          setDiscountPreviewError(previewError instanceof Error ? previewError.message : 'Could not calculate the automatic fee discount.');
        }
      }
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [canManage, invoiceAmount, invoiceCurrency, invoiceStudentId, schoolId, selectedStructure?.id, tab]);

  async function runPdfExport(createPdf: (pdf: typeof import('../lib/finance-pdf')) => Promise<Blob | void>) {
    setFormError('');
    try {
      const output = await createPdf(await import('../lib/finance-pdf'));
      if (output instanceof Blob) {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPreviewUrl(URL.createObjectURL(output));
      }
    } catch (exportError) {
      setFormError(exportError instanceof Error ? exportError.message : 'The PDF could not be created.');
    }
  }

  async function issueFinancePdf(
    documentType: 'invoice' | 'receipt' | 'statement',
    sourceId: string,
    filename: string,
    createPdf: (verificationUrl: string, documentReference: string) => Promise<Blob>,
  ) {
    if (!schoolId) throw new Error('Choose an active school before issuing a document.');
    const prepared = await prepareOfficialDocument(schoolId, documentType, sourceId);
    const output = await createPdf(documentVerificationUrl(prepared.token), prepared.reference);
    await storeOfficialDocument(prepared, output);
    savePdfBlob(output, `${filename}.pdf`);
    setPreviewFilename(`${filename}.pdf`);
    setSuccess(`Issued ${prepared.reference} · version ${prepared.version}. The QR verifies authenticity without exposing account details.`);
    return output;
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
    void runPdfExport(({ downloadFinancePdf }) => issueFinancePdf('invoice', invoice.id, invoice.invoice_number, (verificationUrl) => downloadFinancePdf({
      title: 'Invoice',
      schoolName: activeMembership?.school.name ?? 'School',
      issuerDetails: getIssuerDetails(),
      brandColor: documentBranding.primary_color,
      motto: documentBranding.motto,
      logoUrl: documentBranding.logo_path,
      verificationUrl,
      deferDownload: true,
      filename: invoice.invoice_number,
      document,
      sections: invoiceSections(invoice),
    })));
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
    void runPdfExport(({ downloadFinancePdf }) => issueFinancePdf('receipt', payment.id, payment.receipt_number, (verificationUrl) => downloadFinancePdf({
      title: 'Payment receipt',
      schoolName: activeMembership?.school.name ?? 'School',
      issuerDetails: getIssuerDetails(),
      brandColor: documentBranding.primary_color,
      motto: documentBranding.motto,
      logoUrl: documentBranding.logo_path,
      verificationUrl,
      deferDownload: true,
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
    })));
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
    void runPdfExport(({ downloadFinancePdf }) => issueFinancePdf('statement', student.id, `statement-${student.student_number}`, (verificationUrl, reference) => downloadFinancePdf({
      title: 'Account statement',
      schoolName: activeMembership?.school.name ?? 'School',
      issuerDetails: getIssuerDetails(),
      brandColor: documentBranding.primary_color,
      motto: documentBranding.motto,
      logoUrl: documentBranding.logo_path,
      verificationUrl,
      deferDownload: true,
      filename: `statement-${student.student_number}-${new Date().toISOString().slice(0, 10)}`,
      document: {
        kind: 'statement',
        number: reference,
        issuedOn: new Date().toISOString().slice(0, 10),
        recipientName: statementStudent ? `${statementStudent.first_name} ${statementStudent.last_name}` : 'Unknown student',
        recipientReference: `Student number: ${student.student_number}`,
      },
      sections: sections.map((section) => section.rows.length ? section : {
        ...section,
        rows: [['-', 'No account activity', '-', '-', '-', '-', '0.00']],
      }),
    })));
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

  async function addDiscountRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !user) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const discountType = String(form.get('discount_type'));
    const discountValue = Number(form.get('discount_value'));
    const currencyCode = String(form.get('currency_code')).trim().toUpperCase();
    const minimumSiblings = Number(form.get('minimum_active_siblings'));
    if (!Number.isFinite(discountValue) || discountValue <= 0 || (discountType === 'percentage' && discountValue > 100)) {
      setFormError('Enter a percentage from 0.01 to 100, or a fixed discount greater than zero.');
      return;
    }
    if (!/^[A-Z]{3}$/.test(currencyCode) || !Number.isInteger(minimumSiblings) || minimumSiblings < 0 || minimumSiblings > 50) {
      setFormError('Enter a valid currency code and a sibling threshold from 0 to 50.');
      return;
    }
    setSaving(true);
    setFormError('');
    setSuccess('');
    try {
      const { error: insertError } = await requireSupabase().from('fee_discount_rules').insert({
        school_id: schoolId,
        fee_structure_id: String(form.get('fee_structure_id') || '') || null,
        name: String(form.get('name')).trim(),
        discount_type: discountType,
        discount_value: discountValue,
        currency_code: currencyCode,
        minimum_active_siblings: minimumSiblings,
        created_by: user.id,
      });
      if (insertError) throw insertError;
      formElement.reset();
      showSuccess('Fee discount rule created.');
    } catch (saveError) {
      setFormError(saveError instanceof Error ? saveError.message : 'The fee discount rule could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleDiscountRule(rule: FeeDiscountRule) {
    if (!schoolId) return;
    setSaving(true);
    setFormError('');
    setSuccess('');
    try {
      const { error: updateError } = await requireSupabase().from('fee_discount_rules')
        .update({ is_active: !rule.is_active }).eq('school_id', schoolId).eq('id', rule.id);
      if (updateError) throw updateError;
      showSuccess(`Discount rule ${rule.is_active ? 'deactivated' : 'activated'}.`);
    } catch (updateError) {
      setFormError(updateError instanceof Error ? updateError.message : 'The discount rule could not be updated.');
    } finally {
      setSaving(false);
    }
  }

  async function createFeeRunPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId) return;
    const form = new FormData(event.currentTarget);
    setSaving(true);
    setFormError('');
    setSuccess('');
    try {
      const { data, error: previewError } = await requireSupabase().rpc('preview_student_fee_run', {
        target_school: schoolId,
        target_fee_structure: String(form.get('fee_structure_id')),
        invoice_issued_on: String(form.get('issued_on')),
        invoice_due_on: String(form.get('due_on') || '') || null,
      });
      if (previewError) throw previewError;
      const runId = String(data ?? '');
      if (!runId) throw new Error('Fee run preview completed without a run reference.');
      setActiveFeeRunId(runId);
      await loadFeeRunItems(runId);
      setSuccess('Fee run preview created from the current active student roster. Review every row before issuing invoices.');
      setRefreshKey((key) => key + 1);
    } catch (previewError) {
      setFormError(previewError instanceof Error ? previewError.message : 'The fee run preview could not be created.');
    } finally {
      setSaving(false);
    }
  }

  async function selectFeeRun(runId: string) {
    setActiveFeeRunId(runId);
    setFeeRunItems([]);
    setFormError('');
    try {
      await loadFeeRunItems(runId);
    } catch (loadError) {
      setFormError(loadError instanceof Error ? loadError.message : 'The fee run preview could not be loaded.');
    }
  }

  async function issueFeeRun(run: FeeRun) {
    if (!canManage) return;
    setSaving(true);
    setFormError('');
    setSuccess('');
    try {
      const { data, error: issueError } = await requireSupabase().rpc('issue_student_fee_run', {
        target_run: run.id,
      });
      if (issueError) throw issueError;
      await loadFeeRunItems(run.id);
      setSuccess(`${Number(data)} invoices issued from ${run.description}.`);
      setRefreshKey((key) => key + 1);
    } catch (issueError) {
      setFormError(issueError instanceof Error ? issueError.message : 'The fee run could not be issued.');
    } finally {
      setSaving(false);
    }
  }

  async function cancelFeeRun(run: FeeRun) {
    if (!canManage) return;
    setSaving(true);
    setFormError('');
    setSuccess('');
    try {
      const { error: cancelError } = await requireSupabase().rpc('cancel_student_fee_run', {
        target_run: run.id,
      });
      if (cancelError) throw cancelError;
      setSuccess(`Draft fee run for ${run.description} cancelled.`);
      setRefreshKey((key) => key + 1);
    } catch (cancelError) {
      setFormError(cancelError instanceof Error ? cancelError.message : 'The fee run could not be cancelled.');
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
    const manualDiscount = Number(form.get('discount_amount') || 0);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(manualDiscount) || manualDiscount < 0) {
      setFormError('Enter a valid invoice amount and non-negative manual discount.');
      return;
    }
    if (manualDiscount > 0 && !String(form.get('discount_reason')).trim()) {
      setFormError('Enter a reason for the discount or scholarship.');
      return;
    }
    setSaving(true);
    setFormError('');
    setSuccess('');
    try {
      const currencyCode = selectedStructure?.currency_code || String(form.get('currency_code')).trim().toUpperCase();
      const { data, error: createError } = await requireSupabase().rpc('create_student_fee_invoice', {
        target_school: schoolId,
        target_student: String(form.get('student_id')),
        target_fee_structure: selectedStructure?.id ?? null,
        invoice_description: String(form.get('description') ?? '').trim(),
        custom_amount: amount,
        custom_currency_code: currencyCode,
        manual_discount: manualDiscount,
        manual_discount_reason: String(form.get('discount_reason') ?? '').trim(),
        invoice_issued_on: String(form.get('issued_on')),
        custom_due_on: selectedStructure?.due_date || String(form.get('due_on')),
      });
      if (createError) throw createError;
      const invoiceNumber = String(data ?? '');
      if (!invoiceNumber) throw new Error('Invoice creation completed without an invoice number.');
      formElement.reset();
      setSelectedStructureId('');
      setInvoiceStudentId('');
      setInvoiceCustomAmount('');
      setInvoiceCurrencyCode('USD');
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

  function editPaymentAllocation(payment: FeePayment) {
    const currentAllocations = allocationsByPayment.get(payment.id) ?? [];
    setAllocationDrafts((current) => ({
      ...current,
      [payment.id]: Object.fromEntries(currentAllocations.map((allocation) => [allocation.invoice_id, String(allocation.amount)])),
    }));
    setAllocationEditorPaymentId(payment.id);
    setFormError('');
  }

  async function savePaymentAllocations(event: FormEvent<HTMLFormElement>, payment: FeePayment) {
    event.preventDefault();
    if (!schoolId || !canManage) return;
    const draft = allocationDrafts[payment.id] ?? {};
    const selectedAllocations = Object.entries(draft)
      .filter(([, value]) => Number(value) > 0)
      .map(([invoice_id, value]) => ({ invoice_id, amount: Number(value) }));
    const total = selectedAllocations.reduce((sum, allocation) => sum + allocation.amount, 0);
    if (selectedAllocations.some((allocation) => !Number.isFinite(allocation.amount) || allocation.amount <= 0 || Math.round(allocation.amount * 100) !== allocation.amount * 100)) {
      setFormError('Each invoice allocation must be a positive amount with at most two decimal places.');
      return;
    }
    if (total > payment.amount) {
      setFormError(`Allocations cannot exceed the payment of ${money(payment.amount, payment.currency_code)}.`);
      return;
    }
    setSaving(true);
    setFormError('');
    setSuccess('');
    try {
      const { data, error: allocationError } = await requireSupabase().rpc('replace_student_fee_payment_allocations', {
        target_payment: payment.id,
        invoice_allocations: selectedAllocations,
      });
      if (allocationError) throw allocationError;
      setAllocationEditorPaymentId('');
      setSuccess(Number(data) > 0
        ? `Payment allocation updated. ${money(Number(data), payment.currency_code)} remains unmatched.`
        : 'Payment fully allocated to invoices.');
      setRefreshKey((key) => key + 1);
    } catch (allocationError) {
      setFormError(allocationError instanceof Error ? allocationError.message : 'The payment allocation could not be updated.');
    } finally {
      setSaving(false);
    }
  }

  async function createPaymentPlan(event: FormEvent<HTMLFormElement>, invoice: FeeInvoice) {
    event.preventDefault();
    if (!canManage) return;
    const form = new FormData(event.currentTarget);
    setSaving(true);
    setFormError('');
    setSuccess('');
    try {
      const { error: planError } = await requireSupabase().rpc('create_student_fee_payment_plan', {
        target_invoice: invoice.id,
        plan_installment_count: Number(form.get('installment_count')),
        plan_frequency: String(form.get('frequency')),
        first_due_date: String(form.get('first_due_date')),
      });
      if (planError) throw planError;
      setSuccess(`Payment plan created for ${invoice.invoice_number}. The schedule will reflect future payments allocated to this invoice.`);
      setRefreshKey((key) => key + 1);
    } catch (planError) {
      setFormError(planError instanceof Error ? planError.message : 'The payment plan could not be created.');
    } finally {
      setSaving(false);
    }
  }

  async function cancelPaymentPlan(plan: PaymentPlan) {
    if (!canManage) return;
    setSaving(true);
    setFormError('');
    setSuccess('');
    try {
      const { error: cancelError } = await requireSupabase().rpc('cancel_student_fee_payment_plan', {
        target_plan: plan.id,
      });
      if (cancelError) throw cancelError;
      setSuccess('Payment plan cancelled.');
      setRefreshKey((key) => key + 1);
    } catch (cancelError) {
      setFormError(cancelError instanceof Error ? cancelError.message : 'The payment plan could not be cancelled.');
    } finally {
      setSaving(false);
    }
  }

  async function saveReminderCadence(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !user) return;
    const form = new FormData(event.currentTarget);
    const daysAfterDue = Number(form.get('days_after_due'));
    const channel = String(form.get('channel')) as ReminderChannel;
    if (!Number.isInteger(daysAfterDue) || daysAfterDue < 0 || daysAfterDue > 365) {
      setFormError('Choose a reminder day from 0 to 365 days after the invoice due date.');
      return;
    }
    setSaving(true);
    setFormError('');
    setSuccess('');
    try {
      const { error: cadenceError } = await requireSupabase().from('fee_reminder_cadences').upsert({
        school_id: schoolId,
        days_after_due: daysAfterDue,
        channel,
        is_active: true,
        created_by: user.id,
      }, { onConflict: 'school_id,days_after_due,channel' });
      if (cadenceError) throw cadenceError;
      setSuccess('Reminder cadence saved.');
      setRefreshKey((key) => key + 1);
    } catch (cadenceError) {
      setFormError(cadenceError instanceof Error ? cadenceError.message : 'The reminder cadence could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleReminderCadence(cadence: ReminderCadence) {
    if (!schoolId || !canManage) return;
    setSaving(true);
    setFormError('');
    setSuccess('');
    try {
      const { error: cadenceError } = await requireSupabase().from('fee_reminder_cadences')
        .update({ is_active: !cadence.is_active }).eq('school_id', schoolId).eq('id', cadence.id);
      if (cadenceError) throw cadenceError;
      setSuccess(`Reminder cadence ${cadence.is_active ? 'paused' : 'activated'}.`);
      setRefreshKey((key) => key + 1);
    } catch (cadenceError) {
      setFormError(cadenceError instanceof Error ? cadenceError.message : 'The reminder cadence could not be updated.');
    } finally {
      setSaving(false);
    }
  }

  async function logReminderContact(event: FormEvent<HTMLFormElement>, invoice: FeeInvoice, cadence: ReminderCadence) {
    event.preventDefault();
    if (!canManage) return;
    const form = new FormData(event.currentTarget);
    setSaving(true);
    setFormError('');
    setSuccess('');
    try {
      const { error: reminderError } = await requireSupabase().rpc('record_fee_reminder_contact', {
        target_invoice: invoice.id,
        target_cadence: cadence.id,
        contact_channel: cadence.channel,
        contact_note: String(form.get('contact_note') ?? '').trim(),
      });
      if (reminderError) throw reminderError;
      setSuccess(`Reminder contact logged for ${invoice.invoice_number}.`);
      setRefreshKey((key) => key + 1);
    } catch (reminderError) {
      setFormError(reminderError instanceof Error ? reminderError.message : 'The reminder contact could not be logged.');
    } finally {
      setSaving(false);
    }
  }

  if (!canViewFinance) {
    return <div className="page-stack"><div className="page-heading"><div><span className="eyebrow">School finance</span><h1>Student fees</h1><p>Fee management is available to school administrators and accounting staff.</p></div></div><ErrorState message="Your school role does not have access to student fee records." /></div>;
  }

  return (
    <>
    <div className="page-stack">
      <div className="page-heading"><div><span className="eyebrow">School finance</span><h1>Student fees</h1><p>Manage fee structures, student accounts, invoices, and payments.</p></div></div>
      {error && <ErrorState message={error} />}
      {formError && <ErrorState message={formError} />}
      {success && <SuccessMessage message={success} />}
      <Tabs className="accounting-tabs">
        <TabList>
          {tabs.map((item) => (
            <Tab key={item.id} selected={tab === item.id} onClick={() => { setTab(item.id); setFormError(''); }}>
              {item.label}
            </Tab>
          ))}
        </TabList>
      </Tabs>
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
          {canManage && <>
            <div className="section-heading"><div><span className="eyebrow">Discount policy</span><h2>Discount &amp; sibling rules</h2></div></div>
            <p className="accounting-help">Rules are applied automatically at invoice time. Sibling eligibility uses active students linked to the same parent/guardian record; a threshold of zero makes a rule generally available.</p>
            <form className="accounting-form accounting-inline-form" onSubmit={(event) => void addDiscountRule(event)}>
              <label className="field"><span>Rule name</span><input name="name" required minLength={2} maxLength={120} disabled={saving} /></label>
              <label className="field"><span>Fee structure</span><select name="fee_structure_id" defaultValue="" disabled={saving}><option value="">All fee structures</option>{structures.map((structure) => <option key={structure.id} value={structure.id}>{structure.name}</option>)}</select></label>
              <label className="field"><span>Discount type</span><select name="discount_type" defaultValue="percentage" disabled={saving}><option value="percentage">Percentage</option><option value="fixed">Fixed amount</option></select></label>
              <label className="field"><span>Discount value</span><input name="discount_value" type="number" min="0.01" step="0.01" required disabled={saving} /></label>
              <label className="field"><span>Currency for fixed amount</span><input name="currency_code" defaultValue="USD" minLength={3} maxLength={3} pattern="[A-Za-z]{3}" required disabled={saving} /></label>
              <label className="field"><span>Minimum active siblings</span><input name="minimum_active_siblings" type="number" min="0" max="50" step="1" defaultValue="1" required disabled={saving} /></label>
              <button className="button button-primary" type="submit" disabled={saving}>Add discount rule</button>
            </form>
            {discountRules.length ? <div className="accounting-table-wrap"><table className="accounting-table"><thead><tr><th>Rule</th><th>Scope</th><th>Discount</th><th>Eligibility</th><th>Status</th><th>Manage</th></tr></thead><tbody>{discountRules.map((rule) => {
              const structure = structures.find((item) => item.id === rule.fee_structure_id);
              const ruleValue = rule.discount_type === 'percentage' ? `${Number(rule.discount_value)}%` : money(Number(rule.discount_value), rule.currency_code);
              return <tr key={rule.id}><td><strong>{rule.name}</strong></td><td>{structure?.name ?? 'All fee structures'}</td><td>{ruleValue}</td><td>{rule.minimum_active_siblings === 0 ? 'General' : `${rule.minimum_active_siblings}+ active sibling(s)`}</td><td><span className="accounting-status">{rule.is_active ? 'Active' : 'Inactive'}</span></td><td><button type="button" className="button button-quiet accounting-structure-action" disabled={saving} onClick={() => void toggleDiscountRule(rule)}>{rule.is_active ? 'Deactivate' : 'Activate'}</button></td></tr>;
            })}</tbody></table></div> : <EmptyState title="No discount rules yet" detail="Add a general discount, scholarship, or sibling rule to apply discounts automatically when issuing invoices." />}
          </>}
        </section>}
        {tab === 'invoices' && <section className="content-card accounting-content-card">
          <div className="section-heading"><div><span className="eyebrow">Student billing</span><h2>Invoices &amp; fee runs</h2></div><div className="accounting-document-actions"><button type="button" className="button button-quiet accounting-download-button" onClick={downloadAllInvoices}><Download size={15} />Download all invoices PDF</button><FileText size={19} className="muted-icon" /></div></div>
          {canManage && <div className="content-card accounting-content-card">
            <div className="section-heading"><div><span className="eyebrow">Batch billing</span><h2>Preview fee run</h2></div></div>
            <p className="accounting-help">Creates a saved draft using the current active student roster and applicable automatic sibling rules. Review the complete preview before issuing any invoices.</p>
            <form className="accounting-form accounting-inline-form" onSubmit={(event) => void createFeeRunPreview(event)}>
              <label className="field"><span>Fee structure</span><select name="fee_structure_id" value={feeRunStructureId} onChange={(event) => { const selected = structures.find((structure) => structure.id === event.target.value); setFeeRunStructureId(event.target.value); setFeeRunDueOn(selected?.due_date ?? ''); }} required disabled={saving}><option value="" disabled>Select an active fee structure</option>{structures.filter((structure) => structure.is_active).map((structure) => <option key={structure.id} value={structure.id}>{structure.name} · {money(structure.amount, structure.currency_code)}</option>)}</select></label>
              <label className="field"><span>Issue date</span><input name="issued_on" type="date" value={feeRunIssuedOn} onChange={(event) => setFeeRunIssuedOn(event.target.value)} required disabled={saving} /></label>
              <label className="field"><span>Due date override (optional)</span><input name="due_on" type="date" value={feeRunDueOn} onChange={(event) => setFeeRunDueOn(event.target.value)} disabled={saving} />{feeRunStructureId && !feeRunDueOn && <small>Uses the fee structure due date; set an override if it has none.</small>}</label>
              <button className="button button-primary" type="submit" disabled={saving || !structures.some((structure) => structure.is_active)}>{saving ? 'Preparing…' : 'Create full-roster preview'}</button>
            </form>
          </div>}
          {feeRuns.length > 0 && <div className="content-card accounting-content-card">
            <div className="section-heading"><div><span className="eyebrow">Saved batches</span><h2>Fee run history</h2></div></div>
            <div className="accounting-table-wrap"><table className="accounting-table"><thead><tr><th>Fee run</th><th>Issue / due</th><th>Base amount</th><th>Status</th><th>Created</th><th /></tr></thead><tbody>{feeRuns.map((run) => <tr key={run.id}><td><strong>{run.description}</strong><small>{run.id}</small></td><td>{run.issued_on} / {run.due_on}</td><td>{money(Number(run.amount), run.currency_code)}</td><td><span className="accounting-status">{run.status}</span></td><td>{run.created_at.slice(0, 10)}</td><td><button type="button" className="button button-quiet accounting-structure-action" onClick={() => void selectFeeRun(run.id)}>Review</button></td></tr>)}</tbody></table></div>
          </div>}
          {activeFeeRun && <div className="content-card accounting-content-card">
            <div className="section-heading"><div><span className="eyebrow">{activeFeeRun.status === 'draft' ? 'Approval required before issue' : 'Saved invoice batch'}</span><h2>{activeFeeRun.description} preview</h2></div><span className="accounting-status">{activeFeeRun.status}</span></div>
            <div className="accounting-statement-summary">
              <span>Students <strong>{feeRunItems.length.toLocaleString()}</strong></span>
              <span>Gross <strong>{money(feeRunTotals.amount, activeFeeRun.currency_code)}</strong></span>
              <span>Discounts <strong>{money(feeRunTotals.discount, activeFeeRun.currency_code)}</strong></span>
              <span>Net billed <strong>{money(feeRunTotals.amount - feeRunTotals.discount, activeFeeRun.currency_code)}</strong></span>
            </div>
            {activeFeeRun.status === 'draft' && canManage && <div className="staff-operation-actions">
              <button type="button" className="button button-primary" onClick={() => void issueFeeRun(activeFeeRun)} disabled={saving || feeRunItems.length === 0}>Issue {feeRunItems.length.toLocaleString()} invoices</button>
              <button type="button" className="button button-quiet" onClick={() => void cancelFeeRun(activeFeeRun)} disabled={saving}>Cancel draft</button>
            </div>}
            <div className="accounting-table-wrap"><table className="accounting-table"><thead><tr><th>Student</th><th>Base</th><th>Discount</th><th>Net invoice</th><th>Rule / invoice reference</th></tr></thead><tbody>{[...feeRunItems].sort((left, right) => displayStudent(left.student_id).localeCompare(displayStudent(right.student_id))).map((item) => <tr key={item.id}><td>{displayStudent(item.student_id)}</td><td>{money(Number(item.amount), item.currency_code)}</td><td>{item.discount_amount > 0 ? money(Number(item.discount_amount), item.currency_code) : '—'}</td><td>{money(Number(item.amount) - Number(item.discount_amount), item.currency_code)}</td><td>{item.discount_reason || (item.invoice_id ? invoices.find((invoice) => invoice.id === item.invoice_id)?.invoice_number ?? 'Invoice issued' : 'No automatic discount')}</td></tr>)}</tbody></table></div>
            {feeRunItems.length === 0 && <LoadingState label="Loading the complete fee run preview…" />}
          </div>}
          {canManage && <form className="accounting-form accounting-invoice-form" onSubmit={(event) => void createInvoice(event)}>
            <label className="field"><span>Student</span><select id="finance-invoice-student" name="student_id" required value={invoiceStudentId} onChange={(event) => setInvoiceStudentId(event.target.value)} disabled={saving}><option value="" disabled>Select a student</option>{students.map((student) => <option key={student.id} value={student.id}>{student.first_name} {student.last_name} · {student.student_number}</option>)}</select></label>
            <label className="field"><span>Use a fee structure (optional)</span><select value={selectedStructureId} disabled={saving} onChange={(event) => { const nextId = event.target.value; setSelectedStructureId(nextId); setInvoiceCustomAmount(''); setInvoiceCurrencyCode(structures.find((structure) => structure.id === nextId)?.currency_code ?? 'USD'); }}><option value="">Custom invoice</option>{structures.filter((structure) => structure.is_active).map((structure) => <option key={structure.id} value={structure.id}>{structure.name} · {money(structure.amount, structure.currency_code)}</option>)}</select></label>
            {!selectedStructure && <label className="field"><span>Description</span><input name="description" required minLength={2} maxLength={240} disabled={saving} /></label>}
            <label className="field"><span>Amount</span><input name="amount" type="number" min="0.01" step="0.01" required value={selectedStructure ? selectedStructure.amount : invoiceCustomAmount} onChange={(event) => setInvoiceCustomAmount(event.target.value)} readOnly={Boolean(selectedStructure)} disabled={saving} /></label>
            {!selectedStructure && <label className="field"><span>Currency (ISO code)</span><input name="currency_code" value={invoiceCurrencyCode} onChange={(event) => setInvoiceCurrencyCode(event.target.value)} minLength={3} maxLength={3} pattern="[A-Za-z]{3}" required disabled={saving} /></label>}
            <label className="field"><span>Issued on</span><input name="issued_on" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} disabled={saving} /></label>
            {!selectedStructure?.due_date && <label className="field"><span>Due date</span><input name="due_on" type="date" required defaultValue={selectedStructure?.due_date ?? ''} disabled={saving} />{selectedStructure && <small>No default due date is set for this fee.</small>}</label>}
            <div className="field accounting-field-wide">
              <span>Automatic discount preview</span>
              {discountPreviewError ? <small>{discountPreviewError}</small>
                : discountPreview ? <small>{discountPreview.rule_id
                  ? `${discountPreview.rule_name}: ${money(Number(discountPreview.discount_amount), invoiceCurrency)} · based on ${discountPreview.active_sibling_count} active sibling(s)`
                  : `No automatic rule applies (${discountPreview.active_sibling_count} active sibling(s) linked to this family).`}</small>
                  : invoiceStudentId && invoiceAmount > 0 ? <small>Checking eligible discount rules…</small> : <small>Select a student and enter an amount to check automatic discounts.</small>}
            </div>
            <label className="field"><span>Additional manual discount / scholarship</span><input name="discount_amount" type="number" min="0" step="0.01" defaultValue="0" disabled={saving} /></label>
            <label className="field"><span>Manual discount reason</span><input name="discount_reason" maxLength={200} placeholder="Required when a manual discount is entered" disabled={saving} /></label>
            <button className="button button-primary accounting-field-wide" type="submit" disabled={saving || students.length === 0 || Boolean(discountPreviewError)}>{saving ? 'Issuing…' : 'Issue student invoice'}</button>
          </form>}
          <label className="table-search command-invoice-search"><FileText size={16} /><input value={invoiceSearch} onChange={(event) => setInvoiceSearch(event.target.value)} placeholder="Search invoice number, student or account reference" aria-label="Search invoices" /></label>
          <div className="accounting-table-wrap"><table className="accounting-table"><thead><tr><th>Invoice</th><th>Student</th><th>Due</th><th>Original</th><th>Discount</th><th>Outstanding</th><th>Adjustment</th><th>PDF</th></tr></thead><tbody>{filteredInvoices.map((invoice) => {
            const outstanding = outstandingByInvoice.get(invoice.id) ?? 0;
            return <tr data-command-record={invoice.id} className={searchParams.get('commandRecord') === invoice.id ? 'command-selected-row' : ''} key={invoice.id}><td><strong>{invoice.invoice_number}</strong><small>{invoice.description}{invoice.discount_reason ? ` · ${invoice.discount_reason}` : ''}</small></td><td>{displayStudent(invoice.student_id)}</td><td>{invoice.due_on}</td><td>{money(invoice.amount, invoice.currency_code)}</td><td>{invoice.discount_amount > 0 ? money(invoice.discount_amount, invoice.currency_code) : '—'}</td><td>{money(outstanding, invoice.currency_code)}</td><td>{canManage && invoice.status === 'issued' ? <details className="accounting-adjustment"><summary>Adjust</summary><form onSubmit={(event) => void addAdjustment(event, invoice)}><select name="adjustment_type" aria-label="Adjustment type" defaultValue={outstanding > 0 ? 'credit' : 'charge'}><option value="credit" disabled={outstanding <= 0}>Credit adjustment{outstanding <= 0 ? ' (no outstanding balance)' : ''}</option><option value="charge">Additional charge</option></select><input name="amount" type="number" aria-label="Adjustment amount" placeholder="Amount" min="0.01" step="0.01" required disabled={saving} /><input name="reason" aria-label="Adjustment reason" placeholder="Reason" minLength={2} maxLength={240} required disabled={saving} /><button className="button button-primary" type="submit" disabled={saving}>Save</button></form></details> : invoice.status === 'void' ? 'Voided' : '—'}</td><td><button type="button" className="button button-quiet accounting-row-download" onClick={() => downloadInvoice(invoice)} aria-label={`Download invoice ${invoice.invoice_number} PDF`} title="Download invoice PDF"><Download size={15} /></button></td></tr>;
          })}</tbody></table></div>
          {filteredInvoices.length === 0 && <EmptyState title={invoiceSearch ? 'No matching invoices' : 'No invoices yet'} detail={invoiceSearch ? 'Try another invoice, student, or account reference.' : 'Choose a student and issue an invoice for their school fees.'} />}
        </section>}
        {tab === 'arrears' && <>
          <section className="stat-grid accounting-stat-grid" aria-label="Arrears overview">
            <article className="stat-card"><div className="stat-card-top"><span>Overdue invoices</span><span className="stat-icon purple"><WalletCards size={19} /></span></div><strong>{overdueInvoices.length.toLocaleString()}</strong><span className="stat-caption">Invoices with an outstanding balance past due</span></article>
            <article className="stat-card"><div className="stat-card-top"><span>Reminder actions due</span><span className="stat-icon blue"><FileText size={19} /></span></div><strong>{remindersDue.length.toLocaleString()}</strong><span className="stat-caption">Based on active cadence rules and logged contacts</span></article>
            <article className="stat-card"><div className="stat-card-top"><span>Active payment plans</span><span className="stat-icon green"><Banknote size={19} /></span></div><strong>{paymentPlans.filter((plan) => plan.status === 'active').length.toLocaleString()}</strong><span className="stat-caption">Installment schedules update as invoice payments are allocated</span></article>
          </section>
          <section className="content-card accounting-content-card">
            <div className="section-heading"><div><span className="eyebrow">Collections worklist</span><h2>Overdue accounts</h2></div></div>
            <label className="table-search command-invoice-search"><FileText size={16} /><input value={arrearsSearch} onChange={(event) => setArrearsSearch(event.target.value)} placeholder="Search invoice, student, or description" aria-label="Search overdue invoices" /></label>
            <div className="accounting-statement-summary">{Object.entries(arrearsTotalsByCurrency).map(([currency, amount]) => <span key={currency}>Overdue in {currency} <strong>{money(amount, currency)}</strong></span>)}</div>
            {overdueInvoices.length ? <div className="accounting-list">{overdueInvoices.map((invoice) => {
              const balance = outstandingByInvoice.get(invoice.id) ?? 0;
              const daysOverdue = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${invoice.due_on}T00:00:00Z`)) / 86400000);
              const plan = paymentPlans.find((item) => item.invoice_id === invoice.id && item.status === 'active');
              const schedule = plan ? paymentPlanSchedule.filter((item) => item.plan_id === plan.id) : [];
              return <article className="content-card" key={invoice.id}>
                <div className="section-heading"><div><strong>{displayStudent(invoice.student_id)} · {invoice.invoice_number}</strong><small>{invoice.description} · due {invoice.due_on} · {daysOverdue} day(s) overdue</small></div><strong>{money(balance, invoice.currency_code)}</strong></div>
                <details>
                  <summary>{plan ? `Payment plan · ${plan.frequency} · ${plan.installment_count} installments` : canManage ? 'Create payment plan' : 'No payment plan'}</summary>
                  {plan ? <div className="accounting-table-wrap"><table className="accounting-table"><thead><tr><th>Installment</th><th>Due</th><th>Planned</th><th>Paid</th><th>Remaining</th><th>Status</th></tr></thead><tbody>{schedule.map((item) => <tr key={item.id}><td>{item.installment_number} / {plan.installment_count}</td><td>{item.due_on}</td><td>{money(Number(item.amount), invoice.currency_code)}</td><td>{money(Number(item.paid_amount), invoice.currency_code)}</td><td>{money(Number(item.balance_amount), invoice.currency_code)}</td><td>{item.status}</td></tr>)}</tbody></table></div>
                    : canManage && <form className="accounting-form accounting-inline-form" onSubmit={(event) => void createPaymentPlan(event, invoice)}>
                      <label className="field"><span>Installments</span><input name="installment_count" type="number" min="2" max="24" step="1" defaultValue="3" required disabled={saving} /></label>
                      <label className="field"><span>Frequency</span><select name="frequency" defaultValue="monthly" disabled={saving}><option value="weekly">Weekly</option><option value="biweekly">Every two weeks</option><option value="monthly">Monthly</option></select></label>
                      <label className="field"><span>First due date</span><input name="first_due_date" type="date" min={today} defaultValue={new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)} required disabled={saving} /></label>
                      <button className="button button-primary" type="submit" disabled={saving}>Create payment plan</button>
                    </form>}
                  {plan && canManage && <button className="button button-quiet" type="button" onClick={() => void cancelPaymentPlan(plan)} disabled={saving}>Cancel payment plan</button>}
                </details>
              </article>;
            })}</div> : <EmptyState title="No overdue invoices" detail={arrearsSearch ? 'No overdue invoices match your search.' : 'Outstanding invoices past their due date will appear here.'} />}
          </section>
          <section className="content-card accounting-content-card">
            <div className="section-heading"><div><span className="eyebrow">Installment register</span><h2>Payment plans</h2></div></div>
            {paymentPlans.length ? <div className="accounting-list">{paymentPlans.map((plan) => {
              const invoice = invoices.find((item) => item.id === plan.invoice_id);
              const schedule = paymentPlanSchedule.filter((item) => item.plan_id === plan.id);
              const remaining = schedule.reduce((total, item) => total + Number(item.balance_amount), 0);
              const status = plan.status === 'active' && remaining <= 0.005 ? 'completed' : plan.status;
              return <article className="content-card" key={plan.id}>
                <div className="section-heading"><div><strong>{invoice ? `${displayStudent(invoice.student_id)} · ${invoice.invoice_number}` : 'Invoice unavailable'}</strong><small>{plan.frequency} · {plan.installment_count} installments · created {plan.created_at.slice(0, 10)}</small></div><span className="accounting-status">{status}</span></div>
                <div className="accounting-table-wrap"><table className="accounting-table"><thead><tr><th>Installment</th><th>Due</th><th>Planned</th><th>Paid</th><th>Remaining</th><th>Status</th></tr></thead><tbody>{schedule.map((item) => <tr key={item.id}><td>{item.installment_number} / {plan.installment_count}</td><td>{item.due_on}</td><td>{money(Number(item.amount), invoice?.currency_code ?? 'USD')}</td><td>{money(Number(item.paid_amount), invoice?.currency_code ?? 'USD')}</td><td>{money(Number(item.balance_amount), invoice?.currency_code ?? 'USD')}</td><td>{item.status}</td></tr>)}</tbody></table></div>
                {plan.status === 'active' && canManage && <button className="button button-quiet" type="button" onClick={() => void cancelPaymentPlan(plan)} disabled={saving}>Cancel payment plan</button>}
              </article>;
            })}</div> : <EmptyState title="No payment plans" detail="Create a plan from an overdue invoice to schedule installments." />}
          </section>
          <section className="content-card accounting-content-card">
            <div className="section-heading"><div><span className="eyebrow">Reminder policy</span><h2>Reminder cadence</h2></div></div>
            <p className="accounting-help">Cadences create a worklist; Campus Connect does not send emails or SMS here. Log contact after it has actually been sent or made through your configured channel.</p>
            {canManage && <form className="accounting-form accounting-inline-form" onSubmit={(event) => void saveReminderCadence(event)}>
              <label className="field"><span>Days after due date</span><input name="days_after_due" type="number" min="0" max="365" step="1" defaultValue="7" required disabled={saving} /></label>
              <label className="field"><span>Contact channel</span><select name="channel" defaultValue="email" disabled={saving}><option value="email">Email</option><option value="phone">Phone</option><option value="sms">SMS</option><option value="in_app">In-app</option></select></label>
              <button className="button button-primary" type="submit" disabled={saving}>Add / activate cadence</button>
            </form>}
            {reminderCadences.length ? <div className="accounting-table-wrap"><table className="accounting-table"><thead><tr><th>Schedule</th><th>Channel</th><th>Status</th>{canManage && <th>Manage</th>}</tr></thead><tbody>{reminderCadences.map((cadence) => <tr key={cadence.id}><td>{cadence.days_after_due} day(s) after due</td><td>{cadence.channel.replace(/_/g, ' ')}</td><td>{cadence.is_active ? 'Active' : 'Paused'}</td>{canManage && <td><button className="button button-quiet" type="button" onClick={() => void toggleReminderCadence(cadence)} disabled={saving}>{cadence.is_active ? 'Pause' : 'Activate'}</button></td>}</tr>)}</tbody></table></div> : <EmptyState title="No reminder cadences" detail="Add a cadence to create a reminder worklist for overdue invoices." />}
          </section>
          <section className="content-card accounting-content-card">
            <div className="section-heading"><div><span className="eyebrow">Follow-up queue</span><h2>Reminders ready to log</h2></div></div>
            {remindersDue.length ? <div className="accounting-list">{remindersDue.map(({ invoice, cadence, daysOverdue }) => <article className="content-card" key={`${invoice.id}-${cadence.id}`}>
              <div className="section-heading"><div><strong>{displayStudent(invoice.student_id)} · {invoice.invoice_number}</strong><small>{daysOverdue} day(s) overdue · {cadence.days_after_due}-day {cadence.channel.replace(/_/g, ' ')} cadence</small></div><strong>{money(outstandingByInvoice.get(invoice.id) ?? 0, invoice.currency_code)}</strong></div>
              {canManage && <form className="accounting-form accounting-inline-form" onSubmit={(event) => void logReminderContact(event, invoice, cadence)}>
                <label className="field accounting-field-wide"><span>Contact notes (optional)</span><input name="contact_note" maxLength={1000} placeholder="Record the outcome after contacting the family" disabled={saving} /></label>
                <button className="button button-primary" type="submit" disabled={saving}>Log contact made</button>
              </form>}
            </article>)}</div> : <EmptyState title="No reminder actions due" detail={reminderCadences.some((cadence) => cadence.is_active) ? 'No unlogged cadence actions match current overdue invoices.' : 'Configure an active cadence to create follow-up actions.'} />}
            {reminderLogs.length > 0 && <div className="accounting-table-wrap"><table className="accounting-table"><thead><tr><th>Invoice</th><th>Channel</th><th>Contact logged</th><th>Notes</th></tr></thead><tbody>{reminderLogs.slice(0, 20).map((log) => <tr key={log.id}><td>{invoices.find((invoice) => invoice.id === log.invoice_id)?.invoice_number ?? 'Invoice'}</td><td>{log.channel.replace(/_/g, ' ')}</td><td>{log.contacted_at.slice(0, 10)}</td><td>{log.contact_note || '—'}</td></tr>)}</tbody></table></div>}
          </section>
        </>}
        {tab === 'payments' && <section className="content-card accounting-content-card">
          <div className="section-heading"><div><span className="eyebrow">Cash collection</span><h2>Record a fee payment</h2></div><div className="accounting-document-actions"><button type="button" className="button button-quiet accounting-download-button" onClick={downloadAllReceipts}><Download size={15} />Download all receipts PDF</button><Banknote size={19} className="muted-icon" /></div></div>
          <section className="content-card accounting-content-card">
            <div className="section-heading"><div><span className="eyebrow">Reconciliation inbox</span><h2>Unmatched payments <span className="table-count">{unmatchedPayments.length}</span></h2></div></div>
            <p className="accounting-help">Unallocated amounts remain as student account credit until matched. Reallocations preserve the original receipt and are validated against invoice balances and currency.</p>
            {unmatchedPayments.length ? <div className="accounting-list">{unmatchedPayments.map((payment) => {
              const currentAllocations = allocationsByPayment.get(payment.id) ?? [];
              const allocatedAmount = currentAllocations.reduce((total, allocation) => total + Number(allocation.amount), 0);
              const unmatchedAmount = Number(payment.amount) - allocatedAmount;
              const editableInvoices = invoices.filter((invoice) => invoice.student_id === payment.student_id
                && invoice.currency_code === payment.currency_code
                && invoice.status === 'issued'
                && ((outstandingByInvoice.get(invoice.id) ?? 0) > 0
                  || currentAllocations.some((allocation) => allocation.invoice_id === invoice.id)));
              const isEditing = allocationEditorPaymentId === payment.id;
              return <article className="content-card" key={`unmatched-${payment.id}`}>
                <div className="section-heading"><div><strong>{payment.receipt_number} · {displayStudent(payment.student_id)}</strong><small>{payment.payment_date} · {payment.payment_method.replace(/_/g, ' ')}{payment.reference ? ` · ${payment.reference}` : ''}</small></div><strong>{money(unmatchedAmount, payment.currency_code)} unmatched</strong></div>
                {canManage && <button type="button" className="button button-quiet" onClick={() => editPaymentAllocation(payment)} disabled={saving}>{isEditing ? 'Refresh allocation form' : 'Match to invoices'}</button>}
                {!canManage && <small>Finance manager access is required to change allocations.</small>}
                {isEditing && canManage && <form className="accounting-allocation-list" onSubmit={(event) => void savePaymentAllocations(event, payment)}>
                  <strong>Invoice allocation for {payment.receipt_number}</strong>
                  {editableInvoices.length ? editableInvoices.map((invoice) => {
                    const existingAmount = currentAllocations.find((allocation) => allocation.invoice_id === invoice.id)?.amount ?? 0;
                    const availableBalance = (outstandingByInvoice.get(invoice.id) ?? 0) + Number(existingAmount);
                    return <label key={invoice.id}><span>{invoice.invoice_number} · due {invoice.due_on} · balance {money(availableBalance, invoice.currency_code)}</span><input aria-label={`Amount to allocate to invoice ${invoice.invoice_number}`} type="number" min="0" max={availableBalance} step="0.01" value={allocationDrafts[payment.id]?.[invoice.id] ?? ''} onChange={(event) => setAllocationDrafts((current) => ({ ...current, [payment.id]: { ...(current[payment.id] ?? {}), [invoice.id]: event.target.value } }))} disabled={saving} /></label>;
                  }) : <p>No open invoices in {payment.currency_code} are available for this student.</p>}
                  <div className="staff-operation-actions"><button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save allocation'}</button><button className="button button-quiet" type="button" onClick={() => setAllocationEditorPaymentId('')} disabled={saving}>Cancel</button></div>
                </form>}
              </article>;
            })}</div> : <EmptyState title="No unmatched payments" detail="All recorded payments are allocated to invoices or there are no payments yet." />}
          </section>
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
              {statementPayments.map((payment) => { const applied = allocations.filter((allocation) => allocation.payment_id === payment.id); return <tr key={payment.id}><td>{payment.payment_date}</td><td>Fee payment, {payment.payment_method.replace(/_/g, ' ')}{applied.map((allocation) => <small key={allocation.invoice_id}>{invoices.find((invoice) => invoice.id === allocation.invoice_id)?.invoice_number}: {money(allocation.amount, payment.currency_code)}</small>)}</td><td>{payment.receipt_number}</td><td aria-label="No debit" /><td>{money(payment.amount, payment.currency_code)}</td><td>Unallocated: {money(Math.max(0, payment.amount - applied.reduce((sum, allocation) => sum + allocation.amount, 0)), payment.currency_code)}</td></tr>; })}
            </tbody></table></div></>}
          {!selectedStatementStudent && <EmptyState title="Select a student" detail="Choose a student to view their invoices, discounts, payments, and current balances." />}
        </section>}
      </>}
      <div className="accounting-currency-note">Financial amounts display in each fee's selected currency. Balances are calculated per invoice and are not combined across currencies.</div>
    </div>
    {previewUrl && <PdfPreviewDialog
      url={previewUrl}
      filename={previewFilename || 'school-finance-document.pdf'}
      onClose={() => {
        URL.revokeObjectURL(previewUrl);
        setPreviewUrl('');
      }}
    />}
    </>
  );
}
