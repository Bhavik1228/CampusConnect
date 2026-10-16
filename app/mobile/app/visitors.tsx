import { useCallback, useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import QRCode from 'qrcode';
import { BodyText, Button, Card, Field, Heading, Loading, Message, Page, colors } from '../src/components/ui';
import { useCampusAuth } from '../src/lib/auth-context';
import { escapeHtml, htmlDocument, printOrSharePdf } from '../src/lib/pdf';
import { requireSupabase } from '../src/lib/supabase';
import type { VisitorRecord } from '../src/lib/types';
import { canUseModule } from '../src/lib/validation';

const webUrl = process.env.EXPO_PUBLIC_WEB_URL ?? 'https://campusconnect-khaki-nine.vercel.app';

export default function VisitorsScreen() {
  const { selectedSchool } = useCampusAuth();
  const { visitId } = useLocalSearchParams<{ visitId?: string }>();
  const [records, setRecords] = useState<VisitorRecord[]>([]);
  const [selected, setSelected] = useState<VisitorRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingVisitId, setEditingVisitId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [visitorName, setVisitorName] = useState('');
  const [phone, setPhone] = useState('');
  const [organization, setOrganization] = useState('');
  const [purpose, setPurpose] = useState('');
  const [hostName, setHostName] = useState('');
  const [hostDepartment, setHostDepartment] = useState('');
  const [idType, setIdType] = useState('');
  const [idNumber, setIdNumber] = useState('');

  const load = useCallback(async () => {
    if (!selectedSchool) return;
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [listResult, selectedResult] = await Promise.all([
        client.from('visitor_records')
          .select('id,school_id,badge_number,visitor_name,phone,organization,purpose,host_name,host_department,id_type,id_number,photo_path,visit_date,valid_until,status,arrived_at,departed_at')
          .eq('school_id', selectedSchool.school_id)
          .order('visit_date', { ascending: false })
          .limit(100),
        visitId
          ? client.from('visitor_records')
            .select('id,school_id,badge_number,visitor_name,phone,organization,purpose,host_name,host_department,id_type,id_number,photo_path,visit_date,valid_until,status,arrived_at,departed_at')
            .eq('school_id', selectedSchool.school_id)
            .eq('id', visitId)
            .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);
      if (listResult.error) throw listResult.error;
      if (selectedResult.error) throw selectedResult.error;
      setRecords((listResult.data ?? []) as VisitorRecord[]);
      setSelected(selectedResult.data as VisitorRecord | null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load visitor records.');
    } finally {
      setLoading(false);
    }
  }, [selectedSchool, visitId]);

  useEffect(() => { void load(); }, [load]);

  async function saveVisitor() {
    if (!selectedSchool || !visitorName.trim() || !phone.trim() || !purpose.trim() || !hostName.trim()) {
      setError('Enter the visitor name, phone, purpose, and person being visited.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { data, error: saveError } = await requireSupabase().rpc('save_visitor_record', {
        target_school: selectedSchool.school_id,
        target_visit: editingVisitId || null,
        visitor_data: {
          visitor_name: visitorName.trim(),
          phone: phone.trim(),
          organization: organization.trim(),
          purpose: purpose.trim(),
          host_name: hostName.trim(),
          host_department: hostDepartment.trim(),
          id_type: idType.trim(),
          id_number: idNumber.trim(),
          photo_path: editingVisitId && selected ? selected.photo_path : null,
          ...(editingVisitId && selected ? { visit_date: selected.visit_date, valid_until: selected.valid_until } : {}),
        },
      });
      if (saveError) throw saveError;
      setNotice(editingVisitId ? 'Visitor record corrected; the change was recorded in the audit history.' : `Visitor saved. Badge ${data.badge_number ?? ''}`.trim());
      setEditingVisitId('');
      setVisitorName('');
      setPhone('');
      setOrganization('');
      setPurpose('');
      setHostName('');
      setHostDepartment('');
      setIdType('');
      setIdNumber('');
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The visitor record could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function transition(record: VisitorRecord, status: 'checked_in' | 'checked_out' | 'cancelled') {
    if (!selectedSchool) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: statusError } = await requireSupabase().rpc('transition_visitor_status', {
        target_school: selectedSchool.school_id,
        target_visit: record.id,
        next_status: status,
      });
      if (statusError) throw statusError;
      setNotice(`Visitor marked ${status.replace('_', ' ')}.`);
      await load();
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : 'Visitor status could not be updated.');
    } finally {
      setSaving(false);
    }
  }

  async function exportBadge(record: VisitorRecord) {
    if (!selectedSchool) return;
    setError('');
    try {
      const verificationUrl = `${webUrl.replace(/\/$/, '')}/visitors/verify/${encodeURIComponent(record.id)}`;
      const qrSvg = await QRCode.toString(verificationUrl, { type: 'svg', margin: 1, width: 220 });
      const content = `<section class="card"><h2>${escapeHtml(selectedSchool.school_name)} · Visitor badge</h2><p><b>${escapeHtml(record.visitor_name)}</b></p><p>${escapeHtml(record.purpose)}</p><table>
        <tr><td>Badge</td><td>${escapeHtml(record.badge_number)}</td></tr>
        <tr><td>Host</td><td>${escapeHtml(record.host_name)}${record.host_department ? ` · ${escapeHtml(record.host_department)}` : ''}</td></tr>
        <tr><td>Visit date</td><td>${escapeHtml(record.visit_date)}</td></tr>
        <tr><td>Valid until</td><td>${escapeHtml(record.valid_until)}</td></tr>
        </table><div class="qr">${qrSvg}</div><p class="muted">Campus Connect verifies this badge after authorised sign-in.</p></section>`;
      await printOrSharePdf(htmlDocument('Visitor Badge', content), `${record.badge_number}.pdf`);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : 'The badge PDF could not be generated.');
    }
  }

  function editVisitor(record: VisitorRecord) {
    setSelected(record);
    setEditingVisitId(record.id);
    setVisitorName(record.visitor_name);
    setPhone(record.phone);
    setOrganization(record.organization);
    setPurpose(record.purpose);
    setHostName(record.host_name);
    setHostDepartment(record.host_department);
    setIdType(record.id_type);
    setIdNumber(record.id_number);
  }

  if (!selectedSchool) return null;
  if (!canUseModule(selectedSchool, 'visitors')) {
    return <Page title="Visitor management"><Message variant="error">This role does not have mobile visitor access.</Message></Page>;
  }

  return (
    <Page title="Visitor management" subtitle="Register, verify, and process visitor badges.">
      {error ? <Message variant="error">{error}</Message> : null}
      {notice ? <Message variant="success">{notice}</Message> : null}
      <Button title="Refresh visitor records" variant="secondary" onPress={() => void load()} />
      {selected ? <Card>
        <Heading>Verified badge</Heading>
        <Text style={{ color: colors.text, fontSize: 18, fontWeight: '800' }}>{selected.visitor_name}</Text>
        <BodyText>{selected.badge_number} · {selected.status.replace('_', ' ')}</BodyText>
        <BodyText>Host: {selected.host_name}{selected.host_department ? ` · ${selected.host_department}` : ''}</BodyText>
        <BodyText>Purpose: {selected.purpose}</BodyText>
        <BodyText>Visit: {selected.visit_date} · valid until {selected.valid_until}</BodyText>
        {selected.status === 'expected' && selected.valid_until >= new Date().toISOString().slice(0, 10) ? <Button title="Check in visitor" disabled={saving} onPress={() => void transition(selected, 'checked_in')} /> : null}
        {selected.status === 'checked_in' ? <Button title="Check out visitor" disabled={saving} onPress={() => void transition(selected, 'checked_out')} /> : null}
        {selected.status === 'expected' ? <Button title="Cancel visit" variant="secondary" disabled={saving} onPress={() => void transition(selected, 'cancelled')} /> : null}
        <Button title="Download / print badge PDF" variant="secondary" onPress={() => void exportBadge(selected)} />
        <Button title="Correct visitor details" variant="secondary" onPress={() => editVisitor(selected)} />
      </Card> : visitId ? <Message variant="info">Badge reference loaded from the scanner but no matching accessible visit was found.</Message> : null}

      <Card>
        <Heading>{editingVisitId ? 'Correct visitor details' : 'Register expected visitor'}</Heading>
        <Field label="Visitor name" value={visitorName} onChangeText={setVisitorName} maxLength={160} />
        <Field label="Phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" maxLength={40} />
        <Field label="Organisation" value={organization} onChangeText={setOrganization} maxLength={160} />
        <Field label="Purpose of visit" value={purpose} onChangeText={setPurpose} multiline maxLength={2000} />
        <Field label="Person being visited" value={hostName} onChangeText={setHostName} maxLength={160} />
        <Field label="Host department" value={hostDepartment} onChangeText={setHostDepartment} maxLength={120} />
        <Field label="Visitor ID type (optional)" value={idType} onChangeText={setIdType} maxLength={80} />
        <Field label="Visitor ID number (optional)" value={idNumber} onChangeText={setIdNumber} maxLength={120} />
        <Button title={saving ? 'Saving…' : editingVisitId ? 'Save correction' : 'Save visitor'} disabled={saving} onPress={() => void saveVisitor()} />
        {editingVisitId ? <Button title="Cancel correction" variant="secondary" onPress={() => {
          setEditingVisitId('');
          setVisitorName('');
          setPhone('');
          setOrganization('');
          setPurpose('');
          setHostName('');
          setHostDepartment('');
        }} /> : null}
      </Card>

      <Heading>Recent visitors</Heading>
      {loading ? <Loading label="Loading visits…" />
        : records.length === 0 ? <Card><BodyText muted>No visits recorded yet.</BodyText></Card>
          : <View style={{ gap: 9 }}>{records.map((record) => (
            <Pressable key={record.id} onPress={() => setSelected(record)}>
            <Card>
              <Text style={{ color: colors.text, fontWeight: '700' }}>{record.visitor_name}</Text>
              <BodyText muted>{record.badge_number} · {record.status.replace('_', ' ')}</BodyText>
              <BodyText>{record.visit_date} · Host: {record.host_name}</BodyText>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {record.status === 'expected' ? <Button title="Check in" disabled={saving} onPress={() => void transition(record, 'checked_in')} /> : null}
                {record.status === 'checked_in' ? <Button title="Check out" disabled={saving} onPress={() => void transition(record, 'checked_out')} /> : null}
                <Button title="Badge PDF" variant="secondary" onPress={() => void exportBadge(record)} />
                {record.status === 'expected' ? <Button title="Cancel" variant="secondary" disabled={saving} onPress={() => void transition(record, 'cancelled')} /> : null}
              </View>
            </Card>
            </Pressable>
          ))}</View>}
    </Page>
  );
}
