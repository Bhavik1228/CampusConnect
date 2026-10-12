import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

export interface FinancePdfSection {
  title: string;
  columns: string[];
  rows: (string | number)[][];
}

function safeText(value: string) {
  return value
    .replace(/[–—−]/g, '-')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"');
}

export function formatPdfMoney(amount: number, currencyCode: string) {
  return `${currencyCode} ${amount.toFixed(2)}`;
}

export function downloadFinancePdf({
  title,
  schoolName,
  filename,
  details = [],
  sections,
}: {
  title: string;
  schoolName: string;
  filename: string;
  details?: string[];
  sections: FinancePdfSection[];
}) {
  if (!sections.some((section) => section.rows.length > 0)) {
    throw new Error('There is no financial information to include in this PDF.');
  }

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  doc.setProperties({ title: safeText(title), subject: safeText(schoolName), creator: 'Campus Connect' });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(17);
  doc.setTextColor(39, 43, 67);
  doc.text(safeText(schoolName), 14, 17);
  doc.setFontSize(12);
  doc.setTextColor(84, 70, 197);
  doc.text(safeText(title), 14, 25);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(120, 125, 145);
  doc.text(`Generated ${new Date().toISOString().slice(0, 10)}`, pageWidth - 14, 17, { align: 'right' });
  details.forEach((detail, index) => {
    doc.text(safeText(detail), 14, 32 + index * 4);
  });

  let cursorY = Math.max(39, 35 + details.length * 4);
  for (const section of sections) {
    if (cursorY > pageHeight - 25) {
      doc.addPage();
      cursorY = 16;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(55, 60, 81);
    doc.text(safeText(section.title), 14, cursorY);
    autoTable(doc, {
      startY: cursorY + 3,
      head: [section.columns.map(safeText)],
      body: section.rows.map((row) => row.map((cell) => typeof cell === 'string' ? safeText(cell) : cell)),
      theme: 'grid',
      margin: { left: 14, right: 14, bottom: 18 },
      styles: { font: 'helvetica', fontSize: 8, cellPadding: 2.2, overflow: 'linebreak', textColor: [67, 72, 91] },
      headStyles: { fillColor: [89, 76, 196], textColor: [255, 255, 255], fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [248, 248, 252] },
    });
    cursorY = (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 9;
  }

  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(140, 144, 159);
    doc.text('Campus Connect | Confidential school financial record', 14, pageHeight - 9);
    doc.text(`Page ${page} of ${pageCount}`, pageWidth - 14, pageHeight - 9, { align: 'right' });
  }

  const safeFilename = filename.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'financial-document';
  doc.save(`${safeFilename}.pdf`);
}
