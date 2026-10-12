import { jsPDF } from 'jspdf';

export interface FinancePdfSection {
  title: string;
  columns: string[];
  rows: string[][];
}

interface FinancePdfOptions {
  title: string;
  schoolName: string;
  filename: string;
  details?: string[];
  sections: FinancePdfSection[];
}

const PAGE_WIDTH = 210;
const PAGE_HEIGHT = 297;
const MARGIN = 15;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const NAVY: [number, number, number] = [27, 38, 66];
const PURPLE: [number, number, number] = [103, 80, 164];
const INK: [number, number, number] = [38, 46, 62];
const MUTED: [number, number, number] = [111, 120, 137];
const BORDER: [number, number, number] = [226, 230, 237];
const PALE: [number, number, number] = [247, 248, 251];
const GREEN: [number, number, number] = [36, 123, 95];

function printable(value: string | undefined) {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(value: string) {
  return printable(value).replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function downloadFinancePdf({ title, schoolName, filename, details = [], sections }: FinancePdfOptions) {
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageBottom = PAGE_HEIGHT - 21;
  let y = 0;

  const drawRunningHeader = () => {
    pdf.setFillColor(...NAVY);
    pdf.rect(0, 0, PAGE_WIDTH, 19, 'F');
    pdf.setFillColor(...PURPLE);
    pdf.rect(0, 0, 3, 19, 'F');
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    pdf.setTextColor(255, 255, 255);
    pdf.text(printable(schoolName) || 'School', MARGIN, 8);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(218, 224, 237);
    pdf.text(printable(title), MARGIN, 14, { maxWidth: CONTENT_WIDTH - 24 });
  };

  const addPage = () => {
    pdf.addPage();
    drawRunningHeader();
    y = 28;
  };

  const keepSpace = (height: number) => {
    if (y + height > pageBottom) addPage();
  };

  pdf.setFillColor(...NAVY);
  pdf.rect(0, 0, PAGE_WIDTH, 59, 'F');
  pdf.setFillColor(...PURPLE);
  pdf.rect(0, 0, 4, 59, 'F');
  pdf.setDrawColor(255, 255, 255);
  pdf.setLineWidth(0.35);
  pdf.roundedRect(MARGIN, 13, 19, 19, 3, 3, 'S');
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.setTextColor(255, 255, 255);
  pdf.text('CC', MARGIN + 4.2, 25.3);
  pdf.setFontSize(9);
  pdf.text(printable(schoolName) || 'School', MARGIN + 26, 18);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7.5);
  pdf.setTextColor(205, 214, 231);
  pdf.text('STUDENT ACCOUNTS', MARGIN + 26, 24);
  pdf.setDrawColor(93, 105, 133);
  pdf.line(MARGIN + 26, 28, PAGE_WIDTH - MARGIN, 28);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(19);
  pdf.setTextColor(255, 255, 255);
  const titleLines = pdf.splitTextToSize(printable(title), CONTENT_WIDTH - 26);
  pdf.text(titleLines.slice(0, 2), MARGIN + 26, 38);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7.5);
  pdf.setTextColor(205, 214, 231);
  pdf.text('OFFICIAL FINANCIAL DOCUMENT', MARGIN + 26, 53);
  pdf.setFontSize(8);
  pdf.text(new Date().toLocaleDateString(), PAGE_WIDTH - MARGIN, 53, { align: 'right' });

  y = 67;
  if (details.length) {
    const detailLines = details.flatMap((detail) => pdf.splitTextToSize(printable(detail), CONTENT_WIDTH - 16));
    const detailHeight = Math.max(22, 12 + detailLines.length * 4.2);
    pdf.setFillColor(...PALE);
    pdf.setDrawColor(...BORDER);
    pdf.roundedRect(MARGIN, y, CONTENT_WIDTH, detailHeight, 3, 3, 'FD');
    pdf.setFillColor(...PURPLE);
    pdf.roundedRect(MARGIN + 7, y + 6, 1.2, detailHeight - 12, 0.5, 0.5, 'F');
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(...INK);
    let detailY = y + 9;
    detailLines.forEach((line: string) => {
      pdf.text(line, MARGIN + 12, detailY);
      detailY += 4.2;
    });
    y += detailHeight + 9;
  } else {
    y += 4;
  }

  const renderRow = (section: FinancePdfSection, row: string[]) => {
    const labels = section.columns.map((column) => titleCase(column));
    const values = labels.map((_, index) => printable(row[index]) || '-');
    const primaryIndex = /^date$/i.test(labels[0] ?? '') && values.length > 1 ? 1 : 0;
    const secondary = values
      .map((value, index) => ({ label: labels[index] ?? `Detail ${index + 1}`, value, index }))
      .filter((item) => item.index !== primaryIndex);
    const statusIndex = labels.findIndex((label) => /^(status|state)$/i.test(label));
    const status = statusIndex >= 0 ? values[statusIndex] : '';
    const statusPillWidth = status && status !== '-' ? Math.min(31, pdf.getTextWidth(status) + 8) : 0;
    const cardX = MARGIN;
    const cardWidth = CONTENT_WIDTH;
    const padding = 7;
    const fieldGap = 7;
    const fieldWidth = (cardWidth - padding * 2 - fieldGap) / 2;
    const fields = secondary.map((field) => {
      const fieldValueLines = pdf.splitTextToSize(field.value, fieldWidth);
      return { ...field, valueLines: fieldValueLines as string[] };
    });
    const fieldRows: typeof fields[] = [];
    for (let index = 0; index < fields.length; index += 2) fieldRows.push(fields.slice(index, index + 2));
    const titleLines = pdf.splitTextToSize(
      values[primaryIndex] || 'Account entry',
      cardWidth - padding * 2 - 4 - (statusPillWidth ? statusPillWidth + 4 : 0),
    ) as string[];
    const fieldHeights = fieldRows.map((fieldRow) => Math.max(...fieldRow.map((field) => 9 + field.valueLines.length * 4)));
    const titleHeight = 3 + Math.max(5, titleLines.length * 4.7);
    const cardHeight = padding + titleHeight + (fieldRows.length ? 5 + fieldHeights.reduce((total, height) => total + height + 2, 0) : 1) + 4;

    keepSpace(cardHeight + 3);
    pdf.setFillColor(255, 255, 255);
    pdf.setDrawColor(...BORDER);
    pdf.setLineWidth(0.25);
    pdf.roundedRect(cardX, y, cardWidth, cardHeight, 2.5, 2.5, 'FD');
    pdf.setFillColor(...PURPLE);
    pdf.roundedRect(cardX, y, 1.3, cardHeight, 0.5, 0.5, 'F');
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(6);
    pdf.setTextColor(...MUTED);
    pdf.text((labels[primaryIndex] ?? 'Entry').toUpperCase(), cardX + padding, y + padding + 2);
    pdf.setFontSize(9);
    pdf.setTextColor(...INK);
    pdf.text(titleLines, cardX + padding, y + padding + 7.5);

    if (status && status !== '-') {
      const pillX = cardX + cardWidth - padding - statusPillWidth;
      pdf.setFillColor(231, 244, 239);
      pdf.roundedRect(pillX, y + padding + 3, statusPillWidth, 6, 3, 3, 'F');
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(6.5);
      pdf.setTextColor(...GREEN);
      pdf.text(status, pillX + statusPillWidth / 2, y + padding + 7, { align: 'center' });
    }

    let fieldY = y + padding + titleHeight + 2;
    fieldRows.forEach((fieldRow, rowIndex) => {
      const rowHeight = fieldHeights[rowIndex];
      fieldRow.forEach((field, itemIndex) => {
        const x = cardX + padding + itemIndex * (fieldWidth + fieldGap);
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(6.5);
        pdf.setTextColor(...MUTED);
        pdf.text(field.label.toUpperCase(), x, fieldY + 2.5);
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(7.5);
        pdf.setTextColor(...INK);
        pdf.text(field.valueLines, x, fieldY + 7);
      });
      fieldY += rowHeight + 2;
    });
    y += cardHeight + 3;
  };

  sections.forEach((section, sectionIndex) => {
    const sectionTitle = printable(section.title) || `Section ${sectionIndex + 1}`;
    const sectionLines = pdf.splitTextToSize(sectionTitle, CONTENT_WIDTH - 16) as string[];
    keepSpace(17 + (section.rows.length ? 0 : 15));
    pdf.setFillColor(...PURPLE);
    pdf.roundedRect(MARGIN, y + 1, 7, 7, 2, 2, 'F');
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(7);
    pdf.setTextColor(255, 255, 255);
    pdf.text(String(sectionIndex + 1).padStart(2, '0'), MARGIN + 1.1, y + 5.8);
    pdf.setFontSize(11);
    pdf.setTextColor(...NAVY);
    pdf.text(sectionLines, MARGIN + 11, y + 6);
    y += Math.max(14, sectionLines.length * 5 + 7);

    if (section.rows.length) {
      section.rows.forEach((row) => renderRow(section, row));
    } else {
      keepSpace(14);
      pdf.setFillColor(...PALE);
      pdf.roundedRect(MARGIN, y, CONTENT_WIDTH, 11, 2, 2, 'F');
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(...MUTED);
      pdf.text('No activity to display.', MARGIN + 7, y + 7);
      y += 15;
    }
    y += 4;
  });

  for (let page = 1; page <= pdf.getNumberOfPages(); page += 1) {
    pdf.setPage(page);
    pdf.setDrawColor(...BORDER);
    pdf.setLineWidth(0.25);
    pdf.line(MARGIN, PAGE_HEIGHT - 15, PAGE_WIDTH - MARGIN, PAGE_HEIGHT - 15);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7);
    pdf.setTextColor(...MUTED);
    pdf.text(printable(schoolName) || 'School', MARGIN, PAGE_HEIGHT - 9);
    pdf.text(`${page} / ${pdf.getNumberOfPages()}`, PAGE_WIDTH - MARGIN, PAGE_HEIGHT - 9, { align: 'right' });
  }

  const safeFilename = printable(filename).replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, '-');
  pdf.save(`${safeFilename || 'finance-document'}.pdf`);
}
