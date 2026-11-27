import { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { BodyText, Button, Card, Field, Heading, Loading, Message, Page, colors } from '../src/components/ui';
import { useCampusAuth } from '../src/lib/auth-context';
import { requireSupabase } from '../src/lib/supabase';
import { canAccessScreen } from '../src/lib/validation';

interface FeeInvoice {
  id: string;
  student_id: string;
  amount: number;
  discount_amount: number;
  currency_code: string;
  status: string;
  due_date: string | null;
  students: { first_name: string; last_name: string; student_number: string } | null;
}

const PAYMENT_METHODS = ['cash', 'bank_transfer', 'card', 'mobile_money', 'cheque', 'other'] as const;

export default function FinanceScreen() {
  const { selectedSchool } = useCampusAuth();
  const [invoices, setInvoices] = useState<FeeInvoice[]>([]);
  const [payingInvoice, setPayingInvoice] = useState<FeeInvoice | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<typeof PAYMENT_METHODS[number]>('cash');
  const [date, setDate] = useState('');
  const [reference, setReference] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const today = new Date().toISOString().slice(0, 10);

  const loadInvoices = useCallback(async () => {
    if (!selectedSchool) return;
    setLoading(true);
    setError('');
    try {
      const { data, error: queryError } = await requireSupabase()
        .from('student_fee_invoices')
        .select('id,student_id,amount,discount_amount,currency_code,status,due_date,students(first_name,last_name,student_number)')
        .eq('school_id', selectedSchool.school_id)
        .order('due_date', { ascending: true })
        .limit(200);
      if (queryError) throw queryError;
      setInvoices((data ?? []) as unknown as FeeInvoice[]);
    } catch (queryError) {
      setError(queryError instanceof Error ? queryError.message : 'Could not load fee invoices.');
    } finally {
      setLoading(false);
    }
  }, [selectedSchool]);

  useEffect(() => { void loadInvoices(); }, [loadInvoices]);

  const balance = useMemo(() => {
    if (!payingInvoice) return 0;
    return Math.max(0, payingInvoice.amount - payingInvoice.discount_amount);
  }, [payingInvoice]);

  if (!selectedSchool) return null;
  if (!canAccessScreen(selectedSchool, 'finance')) {
    return (
      <Page title="Finance" subtitle="View fees and record payments.">
        <Message variant="error">Your role does not have mobile finance access on this device.</Message>
      </Page>
    );
  }

  return (
    <Page title="Finance" subtitle="Student fee invoices for your school.">
      {error ? <Message variant="error">{error}</Message> : null}
      {notice ? <Message variant="success">{notice}</Message> : null}
      {loading ? <Loading label="Loading invoices…" />
        : invoices.length === 0
          ? <Card><BodyText muted>No fee invoices are issued for this school.</BodyText></Card>
          : <>
            <View style={{ gap: 10 }}>
              {invoices.map((invoice) => (
                <Card key={invoice.id} style={{ borderColor: payingInvoice?.id === invoice.id ? colors.violet : colors.border }}>
                  <View style={{ gap: 6 }}>
                    <Text style={{ color: colors.text, fontWeight: '700' }}>{`${invoice.students?.first_name ?? 'Student'} ${invoice.students?.last_name ?? ''}`}</Text>
                    <BodyText muted>{invoice.students?.student_number ?? ''}</BodyText>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
                      <Text style={{ color: colors.text, fontWeight: '600' }}>
                        {invoice.amount.toFixed(2)} {invoice.currency_code}
                      </Text>
                      <BodyText muted>Status: {invoice.status}</BodyText>
                      {invoice.due_date ? <BodyText muted>Due: {invoice.due_date}</BodyText> : null}
                    </View>
                    <Button
                      title="Record payment"
                      variant="secondary"
                      disabled={saving}
                      onPress={() => {
                        setPayingInvoice(invoice);
                        setAmount(balance.toFixed(2));
                        setDate(today);
                      }}
                    />
                  </View>
                </Card>
              ))}
            </View>
            {payingInvoice ? (
              <Card>
                <Heading>Record payment</Heading>
                <BodyText muted>Student: {payingInvoice.students?.first_name} {payingInvoice.students?.last_name}</BodyText>
                <BodyText muted>Outstanding: {balance.toFixed(2)} {payingInvoice.currency_code}</BodyText>
                <Field label="Amount" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
                <Field label="Payment method" value={method} onChangeText={(m) => setMethod(m as typeof PAYMENT_METHODS[number])} />
                <Field label="Payment date" value={date} onChangeText={setDate} />
                <Field label="Reference (optional)" value={reference} onChangeText={setReference} />
                <Button
                  title={saving ? 'Recording…' : 'Record payment'}
                  disabled={saving || !amount || Number(amount) <= 0 || Number(amount) > balance}
                  onPress={async () => {
                    setSaving(true);
                    setError('');
                    try {
                      const paymentAmount = Number(amount);
                      const { error: rpcError } = await requireSupabase().rpc('record_student_fee_payment', {
                        target_school: selectedSchool!.school_id,
                        target_student: payingInvoice.student_id,
                        payment_amount: paymentAmount,
                        payment_currency_code: payingInvoice.currency_code,
                        payment_date: date || today,
                        payment_method: method,
                        payment_reference: reference || null,
                        invoice_allocations: [{ invoice_id: payingInvoice.id, amount: paymentAmount }],
                      });
                      if (rpcError) throw rpcError;
                      setNotice('Payment recorded.');
                      setPayingInvoice(null);
                      setAmount('');
                      setMethod('cash');
                      setDate('');
                      setReference('');
                      await loadInvoices();
                    } catch (rpcError) {
                      setError(rpcError instanceof Error ? rpcError.message : 'The payment could not be recorded.');
                    } finally {
                      setSaving(false);
                    }
                  }}
                />
                <Button title="Cancel" variant="secondary" onPress={() => {
                  setPayingInvoice(null);
                  setAmount('');
                  setDate('');
                  setReference('');
                }} />
              </Card>
            ) : null}
          </>}
    </Page>
  );
}
