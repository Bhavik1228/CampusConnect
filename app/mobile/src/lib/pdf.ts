import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

export async function printOrSharePdf(html: string, filename: string) {
  const { uri } = await Print.printToFileAsync({ html });
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new Error(`PDF created at ${uri}, but sharing is not available on this device.`);
  await Sharing.shareAsync(uri, {
    mimeType: 'application/pdf',
    dialogTitle: filename,
    UTI: 'com.adobe.pdf',
  });
}

export function htmlDocument(title: string, content: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{font-family:Arial,sans-serif;color:#172033;margin:24px}h1{color:#30205e;font-size:22px}h2{font-size:15px;margin:16px 0 4px}.brand{color:#326b57;font-weight:700;font-size:14px}.card{border:1px solid #d8dbe5;border-radius:12px;padding:16px;margin:12px 0}.muted{color:#566170;font-size:14px}table{width:100%;border-collapse:collapse}td{padding:6px 0;vertical-align:top}td:first-child{font-weight:700;width:38%}img{max-width:100%}.qr{width:160px;height:160px}</style></head><body><div class="brand">Campus Connect</div><h1>${escapeHtml(title)}</h1>${content}</body></html>`;
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}
