import { jsPDF } from 'jspdf';

export interface FinancePdfSection {
  title: string;
  columns: string[];
  rows: string[][];
  summary?: string[];
}

export interface FinancePdfDocument {
  kind: 'invoice' | 'receipt' | 'statement' | 'register' | 'catalog';
  number?: string;
  issuedOn?: string;
  dueOn?: string;
  recipientName?: string;
  recipientReference?: string;
  status?: string;
  currencyCode?: string;
  subtotal?: number;
  discount?: number;
  adjustments?: number;
  amountPaid?: number;
  balanceDue?: number;
  paymentAmount?: number;
  paymentMethod?: string;
  paymentReference?: string;
}

interface FinancePdfOptions {
  title: string;
  schoolName: string;
  issuerDetails?: string[];
  filename: string;
  details?: string[];
  document?: FinancePdfDocument;
  sections: FinancePdfSection[];
}

const PAGE_WIDTH = 210;
const PAGE_HEIGHT = 297;
const MARGIN = 17;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const NAVY: [number, number, number] = [31, 43, 69];
const PURPLE: [number, number, number] = [100, 78, 166];
const INK: [number, number, number] = [39, 47, 63];
const MUTED: [number, number, number] = [105, 114, 132];
const BORDER: [number, number, number] = [220, 225, 233];
const PALE: [number, number, number] = [246, 247, 250];
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

function formatDate(value: string | undefined) {
  if (!value) return '-';
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? printable(value) : date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function money(amount: number, currencyCode: string) {
  return `${printable(currencyCode) || 'USD'} ${Math.abs(amount).toFixed(2)}`;
}

export function downloadFinancePdf({ title, schoolName, issuerDetails = [], filename, details = [], document, sections }: FinancePdfOptions) {
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageBottom = PAGE_HEIGHT - 21;
  let y = 0;
  const issuer = printable(schoolName) || 'School';

  const drawRunningHeader = () => {
    pdf.setFillColor(...NAVY);
    pdf.rect(0, 0, PAGE_WIDTH, 17, 'F');
    pdf.setFillColor(...PURPLE);
    pdf.rect(0, 0, 3, 17, 'F');
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    pdf.setTextColor(255, 255, 255);
    pdf.text(issuer, MARGIN, 8);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(218, 224, 237);
    pdf.text(printable(title), MARGIN, 13, { maxWidth: CONTENT_WIDTH });
  };

  const addPage = () => {
    pdf.addPage();
    drawRunningHeader();
    y = 25;
  };

  const keepSpace = (height: number) => {
    if (y + height > pageBottom) addPage();
  };

  const drawBusinessHeader = () => {
    pdf.setFillColor(...PURPLE);
    pdf.rect(0, 0, PAGE_WIDTH, 2.2, 'F');
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(12);
    pdf.setTextColor(...NAVY);
    const issuerLines = pdf.splitTextToSize(issuer, CONTENT_WIDTH * 0.46) as string[];
    pdf.text(issuerLines, MARGIN, 13);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7.5);
    pdf.setTextColor(...MUTED);
    let issuerY = 13 + issuerLines.length * 5 + 2;
    pdf.text('STUDENT ACCOUNTS', MARGIN, issuerY);
    issuerDetails.forEach((item) => {
      const lines = pdf.splitTextToSize(printable(item), CONTENT_WIDTH * 0.46) as string[];
      issuerY += 4;
      pdf.setFontSize(7);
      pdf.text(lines, MARGIN, issuerY);
      issuerY += Math.max(0, lines.length - 1) * 3;
    });

    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(15);
    pdf.setTextColor(...NAVY);
    const headingLines = pdf.splitTextToSize(printable(title).toUpperCase(), CONTENT_WIDTH * 0.47) as string[];
    pdf.text(headingLines, PAGE_WIDTH - MARGIN, 13, { align: 'right' });
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(...MUTED);
    if (document?.number) {
      pdf.text(`No. ${printable(document.number)}`, PAGE_WIDTH - MARGIN, 15 + headingLines.length * 5, { align: 'right' });
    }
    pdf.setDrawColor(...BORDER);
    pdf.setLineWidth(0.35);
    const dividerY = Math.max(29, issuerY + 4, 15 + headingLines.length * 5 + (document?.number ? 8 : 0));
    pdf.line(MARGIN, dividerY, PAGE_WIDTH - MARGIN, dividerY);
    y = dividerY + 7;
  };

  const drawPartyAndDates = () => {
    const leftWidth = CONTENT_WIDTH * 0.56;
    const rightX = MARGIN + leftWidth + 6;
    const rightWidth = CONTENT_WIDTH - leftWidth - 6;
    const fields = document?.kind === 'invoice'
      ? [['Invoice date', formatDate(document.issuedOn)], ['Due date', formatDate(document.dueOn)], ['Status', titleCase(document.status || 'Issued')]]
      : document?.kind === 'receipt'
        ? [['Payment date', formatDate(document.issuedOn)], ['Payment method', titleCase(document.paymentMethod || '-')], ['Reference', printable(document.paymentReference) || '-']]
        : [['Statement date', formatDate(document?.issuedOn)]];

    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(7);
    pdf.setTextColor(...MUTED);
    pdf.text(document?.kind === 'invoice' ? 'BILL TO' : document?.kind === 'receipt' ? 'RECEIVED FROM' : 'ACCOUNT HOLDER', MARGIN, y);
    if (document?.recipientName) {
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(10);
      pdf.setTextColor(...INK);
      pdf.text(pdf.splitTextToSize(printable(document.recipientName), leftWidth) as string[], MARGIN, y + 7);
    }
    if (document?.recipientReference) {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(...MUTED);
      pdf.text(printable(document.recipientReference), MARGIN, y + 13);
    }

    let fieldY = y;
    fields.forEach(([label, value]) => {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(7);
      pdf.setTextColor(...MUTED);
      pdf.text(label.toUpperCase(), rightX, fieldY);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(8);
      pdf.setTextColor(...INK);
      const valueLines = pdf.splitTextToSize(value, rightWidth) as string[];
      pdf.text(valueLines, PAGE_WIDTH - MARGIN, fieldY + 4, { align: 'right' });
      fieldY += Math.max(8, valueLines.length * 4 + 4);
    });
    y += Math.max(29, fieldY - y);
  };

  const drawInvoiceItems = (section: FinancePdfSection) => {
    const descriptionWidth = CONTENT_WIDTH - 38;
    const amountX = PAGE_WIDTH - MARGIN;
    const drawItemsHeader = () => {
      pdf.setFillColor(...NAVY);
      pdf.rect(MARGIN, y, CONTENT_WIDTH, 9, 'F');
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(7);
      pdf.setTextColor(255, 255, 255);
      pdf.text('DESCRIPTION', MARGIN + 4, y + 6);
      pdf.text('AMOUNT', amountX - 4, y + 6, { align: 'right' });
      y += 9;
    };
    drawItemsHeader();

    section.rows.forEach((row, index) => {
      const description = printable(row[0]) || 'Fee';
      const amountText = printable(row[1]) || '-';
      const descriptionLines = pdf.splitTextToSize(description, descriptionWidth) as string[];
      const rowHeight = Math.max(10, descriptionLines.length * 4 + 6);
      if (y + rowHeight > pageBottom) {
        addPage();
        drawItemsHeader();
      }
      if (index % 2 === 1) {
        pdf.setFillColor(...PALE);
        pdf.rect(MARGIN, y, CONTENT_WIDTH, rowHeight, 'F');
      }
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8.5);
      pdf.setTextColor(...INK);
      pdf.text(descriptionLines, MARGIN + 4, y + 6);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8.5);
      pdf.setTextColor(...INK);
      pdf.text(amountText, amountX - 4, y + 6, { align: 'right' });
      pdf.setDrawColor(...BORDER);
      pdf.setLineWidth(0.2);
      pdf.line(MARGIN, y + rowHeight, PAGE_WIDTH - MARGIN, y + rowHeight);
      y += rowHeight;
    });

    y += 5;
    const totalX = PAGE_WIDTH - MARGIN - 70;
    const totalWidth = 70;
    const totals: [string, string, boolean][] = [
      ['Subtotal', money(document?.subtotal ?? 0, document?.currencyCode ?? ''), false],
      ...(document?.discount ? [['Discount / scholarship', `-${money(document.discount, document.currencyCode ?? '')}`, false] as [string, string, boolean]] : []),
      ...(document?.adjustments ? [['Adjustments', `${document.adjustments < 0 ? '-' : ''}${money(document.adjustments, document.currencyCode ?? '')}`, false] as [string, string, boolean]] : []),
      [
        'Total due',
        money(
          document?.status?.toLowerCase() === 'void'
            ? 0
            : Math.max(0, (document?.subtotal ?? 0) - (document?.discount ?? 0) + (document?.adjustments ?? 0)),
          document?.currencyCode ?? '',
        ),
        true,
      ],
      ...(document?.amountPaid ? [['Payments received', `-${money(document.amountPaid, document.currencyCode ?? '')}`, false] as [string, string, boolean]] : []),
    ];
    totals.forEach(([label, amount, emphasized]) => {
      keepSpace(emphasized ? 13 : 8);
      if (emphasized) {
        pdf.setFillColor(...PALE);
        pdf.roundedRect(totalX - 3, y, totalWidth + 3, 11, 1.5, 1.5, 'F');
      }
      pdf.setFont('helvetica', emphasized ? 'bold' : 'normal');
      pdf.setFontSize(emphasized ? 8.5 : 8);
      pdf.setTextColor(...(emphasized ? NAVY : MUTED));
      pdf.text(label, totalX, y + 7);
      pdf.setTextColor(...INK);
      pdf.text(amount, PAGE_WIDTH - MARGIN - 3, y + 7, { align: 'right' });
      y += emphasized ? 13 : 8;
    });

    keepSpace(22);
    pdf.setFillColor(...NAVY);
    pdf.roundedRect(totalX - 3, y + 1, totalWidth + 3, 17, 1.5, 1.5, 'F');
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7);
    pdf.setTextColor(221, 226, 238);
    pdf.text('BALANCE DUE', totalX, y + 7);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(12);
    pdf.setTextColor(255, 255, 255);
    pdf.text(money(document?.balanceDue ?? 0, document?.currencyCode ?? ''), PAGE_WIDTH - MARGIN - 3, y + 14, { align: 'right' });
    y += 25;
  };

  const drawReceiptAmount = () => {
    const amount = money(document?.paymentAmount ?? 0, document?.currencyCode ?? '');
    const status = 'PAYMENT RECEIVED';
    pdf.setFillColor(241, 248, 245);
    pdf.roundedRect(MARGIN, y, CONTENT_WIDTH, 28, 2, 2, 'F');
    pdf.setFillColor(...GREEN);
    pdf.rect(MARGIN, y, 1.5, 28, 'F');
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(7);
    pdf.setTextColor(...GREEN);
    pdf.text(status, MARGIN + 7, y + 9);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(18);
    pdf.setTextColor(...NAVY);
    pdf.text(amount, PAGE_WIDTH - MARGIN - 7, y + 18, { align: 'right' });
    y += 37;
  };

  const drawSectionCards = (section: FinancePdfSection, sectionIndex: number) => {
    const heading = printable(section.title) || `Section ${sectionIndex + 1}`;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(10);
    pdf.setTextColor(...NAVY);
    keepSpace(14);
    pdf.text(heading, MARGIN, y + 4);
    pdf.setDrawColor(...BORDER);
    pdf.line(MARGIN, y + 7, PAGE_WIDTH - MARGIN, y + 7);
    y += 11;

    if (!section.rows.length) {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(...MUTED);
      pdf.text('No activity to display.', MARGIN, y + 4);
      y += 10;
      return;
    }

    section.rows.forEach((row) => {
      const labels = section.columns.map((column) => titleCase(column));
      const values = labels.map((_, index) => printable(row[index]) || '-');
      const primaryIndex = /^date$/i.test(labels[0] ?? '') && values.length > 1 ? 1 : 0;
      const secondary = values
        .map((value, index) => ({ label: labels[index] ?? `Detail ${index + 1}`, value, index }))
        .filter((item) => item.index !== primaryIndex);
      const cardX = MARGIN;
      const cardWidth = CONTENT_WIDTH;
      const padding = 6;
      const fieldGap = 6;
      const fieldWidth = (cardWidth - padding * 2 - fieldGap) / 2;
      const fields = secondary.map((field) => ({
        ...field,
        valueLines: pdf.splitTextToSize(field.value, fieldWidth) as string[],
      }));
      const fieldRows: typeof fields[] = [];
      for (let index = 0; index < fields.length; index += 2) fieldRows.push(fields.slice(index, index + 2));
      const primaryLabel = labels[primaryIndex] ?? 'Entry';
      const primaryLines = pdf.splitTextToSize(values[primaryIndex] || 'Account entry', CONTENT_WIDTH - padding * 2) as string[];
      const fieldHeights = fieldRows.map((fieldRow) => Math.max(...fieldRow.map((field) => 8 + field.valueLines.length * 4)));
      const cardHeight = padding + 8 + Math.max(5, primaryLines.length * 4.5) + (fieldRows.length ? 4 + fieldHeights.reduce((total, height) => total + height + 2, 0) : 1) + 3;
      keepSpace(cardHeight + 3);

      pdf.setFillColor(255, 255, 255);
      pdf.setDrawColor(...BORDER);
      pdf.setLineWidth(0.25);
      pdf.roundedRect(cardX, y, cardWidth, cardHeight, 1.5, 1.5, 'FD');
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(6);
      pdf.setTextColor(...MUTED);
      pdf.text(primaryLabel.toUpperCase(), cardX + padding, y + padding + 2);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(8.5);
      pdf.setTextColor(...INK);
      pdf.text(primaryLines, cardX + padding, y + padding + 7);

      let fieldY = y + padding + 8 + Math.max(5, primaryLines.length * 4.5) + 2;
      fieldRows.forEach((fieldRow, rowIndex) => {
        const rowHeight = fieldHeights[rowIndex];
        fieldRow.forEach((field, itemIndex) => {
          const x = cardX + padding + itemIndex * (fieldWidth + fieldGap);
          pdf.setFont('helvetica', 'normal');
          pdf.setFontSize(6);
          pdf.setTextColor(...MUTED);
          pdf.text(field.label.toUpperCase(), x, fieldY + 2.5);
          pdf.setFontSize(7.5);
          pdf.setTextColor(...INK);
          pdf.text(field.valueLines, x, fieldY + 7);
        });
        fieldY += rowHeight + 2;
      });
      y += cardHeight + 3;
    });
    if (section.summary?.length) {
      keepSpace(13 + section.summary.length * 5);
      const summaryHeight = 8 + section.summary.length * 5;
      pdf.setFillColor(...PALE);
      pdf.roundedRect(MARGIN, y, CONTENT_WIDTH, summaryHeight, 1.5, 1.5, 'F');
      section.summary.forEach((item, index) => {
        pdf.setFont('helvetica', index === 0 ? 'bold' : 'normal');
        pdf.setFontSize(8);
        pdf.setTextColor(...NAVY);
        pdf.text(printable(item), MARGIN + 5, y + 5 + index * 5);
      });
      y += summaryHeight + 3;
    }
    y += 3;
  };

  drawBusinessHeader();
  if (document?.kind === 'invoice' || document?.kind === 'receipt' || (document?.kind === 'statement' && document.recipientName)) {
    drawPartyAndDates();
  } else if (details.length) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(...MUTED);
    const lines = details.flatMap((detail) => pdf.splitTextToSize(printable(detail), CONTENT_WIDTH));
    lines.forEach((line: string) => {
      keepSpace(5);
      pdf.text(line, MARGIN, y);
      y += 4.5;
    });
    y += 5;
  }

  if (document?.kind === 'receipt') drawReceiptAmount();
  sections.forEach((section, index) => {
    if (document?.kind === 'invoice') {
      drawInvoiceItems(section);
    } else {
      drawSectionCards(section, index);
    }
  });

  if (document?.kind === 'invoice' && document.dueOn) {
    keepSpace(12);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(...MUTED);
    pdf.text(`Please arrange payment by ${formatDate(document.dueOn)}.`, MARGIN, y + 4);
    y += 9;
  } else if (document?.kind === 'receipt') {
    keepSpace(12);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(...GREEN);
    pdf.text('Thank you. This receipt confirms payment received.', MARGIN, y + 4);
    y += 9;
  }

  for (let page = 1; page <= pdf.getNumberOfPages(); page += 1) {
    pdf.setPage(page);
    pdf.setDrawColor(...BORDER);
    pdf.setLineWidth(0.25);
    pdf.line(MARGIN, PAGE_HEIGHT - 15, PAGE_WIDTH - MARGIN, PAGE_HEIGHT - 15);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7);
    pdf.setTextColor(...MUTED);
    pdf.text(issuer, MARGIN, PAGE_HEIGHT - 9);
    pdf.text(`${page} / ${pdf.getNumberOfPages()}`, PAGE_WIDTH - MARGIN, PAGE_HEIGHT - 9, { align: 'right' });
  }

  const safeFilename = printable(filename).replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, '-');
  pdf.save(`${safeFilename || 'finance-document'}.pdf`);
}
