import { useCallback, useEffect, useRef, useState } from 'react';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { Button, Card, Field, Loading, Message, Page, colors } from '../../src/components/ui';
import { useCampusAuth } from '../../src/lib/auth-context';
import { classifyScan, canUseModule } from '../../src/lib/validation';

export default function ScannerScreen() {
  const router = useRouter();
  const { selectedSchool } = useCampusAuth();
  const params = useLocalSearchParams<{ retry?: string }>();
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState('');
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(true);
  const [torchOn, setTorchOn] = useState(false);
  const lastScan = useRef('');

  const handleValue = useCallback((value: string) => {
    const scan = classifyScan(value);
    if (scan.type === 'visitor') {
      if (!canUseModule(selectedSchool, 'visitors')) return setError('Your school role does not have mobile visitor access.');
      setScanning(false);
      router.push({ pathname: '/visitors', params: { visitId: scan.value } });
    } else if (scan.type === 'isbn' || scan.type === 'library-barcode') {
      if (!canUseModule(selectedSchool, 'library')) return setError('Your school role does not have mobile library access.');
      setScanning(false);
      router.push({ pathname: '/library', params: scan.type === 'isbn' ? { isbn: scan.value } : { barcode: scan.value } });
    } else if (scan.type === 'library-return') {
      if (!canUseModule(selectedSchool, 'library')) return setError('Your school role does not have mobile library access.');
      setScanning(false);
      router.push({ pathname: '/library', params: { returnCode: scan.value } });
    } else {
      setError('This code is not a supported visitor badge, library ISBN, accession barcode, or return code.');
    }
  }, [router, selectedSchool]);

  useEffect(() => {
    if (params.retry) {
      lastScan.current = '';
      setScanning(true);
      setError('');
    }
  }, [params.retry]);

  if (!permission) return <Page title="Scanner"><Loading label="Checking camera permission…" /></Page>;

  return (
    <Page title="Scan" subtitle="Scan a visitor badge, ISBN, library barcode, or book return code.">
      {!permission.granted ? <Card>
        <Text style={{ color: colors.text, fontWeight: '700' }}>Camera access needed</Text>
        <Text style={{ color: colors.muted }}>Camera permission is used only while scanning. You can also enter a code manually below.</Text>
        <Button title="Allow camera access" onPress={() => void requestPermission()} />
      </Card> : <View style={{ height: 300, borderRadius: 18, overflow: 'hidden', backgroundColor: colors.navy }}>
        {scanning ? <CameraView
          style={{ flex: 1 }}
          facing="back"
          enableTorch={torchOn}
          barcodeScannerSettings={{ barcodeTypes: ['qr', 'ean13', 'ean8', 'upc_a', 'code128'] }}
          onBarcodeScanned={({ data }) => {
            if (!data || data === lastScan.current) return;
            lastScan.current = data;
            handleValue(data);
          }}
        /> : <Pressable onPress={() => { setScanning(true); setError(''); lastScan.current = ''; }} style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <Text style={{ color: colors.white, fontWeight: '700' }}>Scan handled. Tap to scan again.</Text>
        </Pressable>}
      </View>}
      {permission.granted ? <Button title={torchOn ? 'Turn flashlight off' : 'Turn flashlight on'} variant="secondary" onPress={() => setTorchOn((value) => !value)} /> : null}
      <Card>
        <Field label="Enter a code manually" value={manual} onChangeText={setManual} autoCapitalize="characters" autoCorrect={false} />
        <Button title="Verify code" disabled={!manual.trim()} onPress={() => {
          setError('');
          handleValue(manual);
        }} />
      </Card>
      {error ? <Message variant="error">{error}</Message> : null}
      <Text style={{ color: colors.muted, fontSize: 14 }}>Scans are verified with Campus Connect before any record can be changed.</Text>
    </Page>
  );
}
