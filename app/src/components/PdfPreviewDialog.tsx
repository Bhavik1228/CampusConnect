import { Download, ExternalLink, Printer, X } from 'lucide-react';

export function PdfPreviewDialog({
  url,
  filename,
  onClose,
}: {
  url: string;
  filename: string;
  onClose: () => void;
}) {
  return (
    <div className="pdf-preview-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="pdf-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="pdf-preview-title">
        <header className="pdf-preview-toolbar">
          <div><span className="eyebrow">Official document</span><h2 id="pdf-preview-title">PDF preview</h2></div>
          <div className="pdf-preview-actions">
            <a className="button button-quiet" href={url} download={filename}><Download size={15} /> Download</a>
            <button className="button button-quiet" type="button" onClick={() => {
              const frame = window.document.querySelector<HTMLIFrameElement>('.pdf-preview-frame');
              frame?.contentWindow?.print();
            }}><Printer size={15} /> Print</button>
            <a className="icon-button" href={url} target="_blank" rel="noreferrer" aria-label="Open PDF in new tab"><ExternalLink size={16} /></a>
            <button className="icon-button" type="button" onClick={onClose} aria-label="Close preview"><X size={18} /></button>
          </div>
        </header>
        <iframe className="pdf-preview-frame" src={url} title="Generated PDF preview" />
      </section>
    </div>
  );
}
