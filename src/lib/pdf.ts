import type { Response } from 'express';
import PDFDocument from 'pdfkit';
import { formatInr } from './money';

export interface InvoicePdfData {
  schoolName: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  status: string;
  studentName: string;
  parentName: string;
  periodStart: string | null;
  periodEnd: string | null;
  items: { description: string; quantity: number; unitAmountPaise: number; amountPaise: number }[];
  subtotalPaise: number;
  discountPaise: number;
  totalPaise: number;
  amountPaidPaise: number;
  notes?: string | null;
}

export interface ReceiptPdfData {
  schoolName: string;
  receiptNumber: string;
  paidOn: string;
  invoiceNumber: string;
  studentName: string;
  parentName: string;
  method: string;
  reference: string | null;
  amountPaise: number;
  invoiceTotalPaise: number;
  invoicePaidPaise: number;
}

function start(res: Response, filename: string) {
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  doc.pipe(res);
  return doc;
}

function row(doc: PDFKit.PDFDocument, label: string, value: string, y: number) {
  doc.fontSize(10).fillColor('#555').text(label, 50, y, { width: 140 });
  doc.fillColor('#000').text(value, 190, y, { width: 350 });
}

export function sendInvoicePdf(res: Response, d: InvoicePdfData) {
  const doc = start(res, `${d.invoiceNumber}.pdf`);
  doc.fontSize(20).text(d.schoolName, 50, 50);
  doc.fontSize(14).fillColor('#555').text('INVOICE', 50, 78);
  doc.fillColor('#000');

  let y = 120;
  const lines: [string, string][] = [
    ['Invoice no.', d.invoiceNumber],
    ['Status', d.status.toUpperCase()],
    ['Issue date', d.issueDate],
    ['Due date', d.dueDate],
    ['Student', d.studentName],
    ['Parent', d.parentName],
  ];
  if (d.periodStart && d.periodEnd) lines.push(['Period', `${d.periodStart} to ${d.periodEnd}`]);
  for (const [label, value] of lines) {
    row(doc, label, value, y);
    y += 18;
  }

  y += 12;
  doc.fontSize(10).fillColor('#555');
  doc.text('Description', 50, y, { width: 260 });
  doc.text('Qty', 315, y, { width: 40, align: 'right' });
  doc.text('Rate', 360, y, { width: 90, align: 'right' });
  doc.text('Amount', 455, y, { width: 90, align: 'right' });
  y += 16;
  doc.moveTo(50, y).lineTo(545, y).strokeColor('#ccc').stroke();
  y += 8;
  doc.fillColor('#000');
  for (const item of d.items) {
    doc.text(item.description, 50, y, { width: 260 });
    doc.text(String(item.quantity), 315, y, { width: 40, align: 'right' });
    doc.text(formatInr(item.unitAmountPaise), 360, y, { width: 90, align: 'right' });
    doc.text(formatInr(item.amountPaise), 455, y, { width: 90, align: 'right' });
    y += 20;
  }

  y += 10;
  doc.moveTo(300, y).lineTo(545, y).strokeColor('#ccc').stroke();
  y += 8;
  const total = (label: string, value: string, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').text(label, 300, y, { width: 150 });
    doc.text(value, 455, y, { width: 90, align: 'right' });
    y += 18;
  };
  total('Subtotal', formatInr(d.subtotalPaise));
  if (d.discountPaise > 0) total('Discount', `- ${formatInr(d.discountPaise)}`);
  total('Total', formatInr(d.totalPaise), true);
  total('Paid', formatInr(d.amountPaidPaise));
  total('Balance due', formatInr(Math.max(d.totalPaise - d.amountPaidPaise, 0)), true);

  if (d.notes) {
    doc.font('Helvetica').fillColor('#555').text(d.notes, 50, y + 20, { width: 495 });
  }
  doc.end();
}

export function sendReceiptPdf(res: Response, d: ReceiptPdfData) {
  const doc = start(res, `${d.receiptNumber}.pdf`);
  doc.fontSize(20).text(d.schoolName, 50, 50);
  doc.fontSize(14).fillColor('#555').text('PAYMENT RECEIPT', 50, 78);
  doc.fillColor('#000');

  let y = 120;
  const lines: [string, string][] = [
    ['Receipt no.', d.receiptNumber],
    ['Date', d.paidOn],
    ['Invoice no.', d.invoiceNumber],
    ['Student', d.studentName],
    ['Parent', d.parentName],
    ['Method', d.method.toUpperCase()],
    ['Reference', d.reference ?? '-'],
    ['Amount received', formatInr(d.amountPaise)],
    ['Invoice total', formatInr(d.invoiceTotalPaise)],
    ['Total paid so far', formatInr(d.invoicePaidPaise)],
    ['Balance', formatInr(Math.max(d.invoiceTotalPaise - d.invoicePaidPaise, 0))],
  ];
  for (const [label, value] of lines) {
    row(doc, label, value, y);
    y += 20;
  }
  doc.end();
}
