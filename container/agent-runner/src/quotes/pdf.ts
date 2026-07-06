/**
 * Quote PDF renderer — pure-JS via pdf-lib. Best-effort by design: callers
 * treat a null return as "send the quote without a PDF".
 *
 * History: v1 printed an HTML template through the image's headless
 * Chromium. That worked on arm64 (macOS dev) but the amd64 Debian Chromium
 * build SIGTRAPs at startup inside containers regardless of sandbox/seccomp
 * flags — silently killing PDFs in production. pdf-lib has no native code
 * and no browser, so it renders identically everywhere.
 */
import fs from 'fs';
import path from 'path';

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

import type { HouseRules, QuoteRecord } from './contracts.js';
import { fmtCents } from './rules.js';

const INK = rgb(0.086, 0.188, 0.169); // #16302b
const ACCENT = rgb(0.055, 0.486, 0.4); // #0e7c66
const MUTED = rgb(0.373, 0.478, 0.451); // #5f7a73
const LINE = rgb(0.847, 0.894, 0.878); // #d8e4e0

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN = 56;

/** Helvetica is WinAnsi-only — strip anything it can't encode. */
function latin1(s: string): string {
  return s.replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export async function renderQuotePdf(
  record: QuoteRecord,
  rules: HouseRules,
  outDir: string,
): Promise<string | null> {
  try {
    const doc = await PDFDocument.create();
    const page = doc.addPage([PAGE_W, PAGE_H]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);

    const rightX = PAGE_W - MARGIN;
    const drawRight = (p: PDFPage, text: string, x: number, y: number, f: PDFFont, size: number, color = INK) => {
      p.drawText(text, { x: x - f.widthOfTextAtSize(text, size), y, size, font: f, color });
    };

    let y = PAGE_H - 76;

    // ── header ──
    page.drawText(latin1(truncate(rules.businessName, 38)), { x: MARGIN, y, size: 20, font: bold, color: INK });
    drawRight(page, 'QUOTATION', rightX, y + 4, bold, 11, MUTED);
    const date = new Date(record.createdAt);
    const dateStr = Number.isNaN(date.getTime()) ? String(record.createdAt).slice(0, 10) : date.toISOString().slice(0, 10);
    drawRight(page, latin1(`${record.id}  ·  ${dateStr}`), rightX, y - 10, font, 9, MUTED);
    y -= 26;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: rightX, y }, thickness: 2.5, color: ACCENT });
    y -= 30;

    // ── prepared for ──
    if (record.customerName) {
      page.drawText('PREPARED FOR', { x: MARGIN, y, size: 8, font: bold, color: MUTED });
      y -= 14;
      page.drawText(latin1(truncate(record.customerName, 60)), { x: MARGIN, y, size: 12, font, color: INK });
      y -= 28;
    }

    // ── table ──
    const colQty = 390;
    const colUnit = 468;
    const colAmt = rightX;
    page.drawText('DESCRIPTION', { x: MARGIN, y, size: 8, font: bold, color: MUTED });
    drawRight(page, 'QTY', colQty, y, bold, 8, MUTED);
    drawRight(page, 'UNIT', colUnit, y, bold, 8, MUTED);
    drawRight(page, 'AMOUNT', colAmt, y, bold, 8, MUTED);
    y -= 8;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: rightX, y }, thickness: 0.75, color: LINE });
    y -= 20;

    for (const li of record.lineItems) {
      const desc = truncate(latin1(li.description), 52) + (li.rateCardRef ? `   ${latin1(li.rateCardRef)}` : '');
      page.drawText(desc, { x: MARGIN, y, size: 10.5, font, color: INK });
      drawRight(page, String(li.qty), colQty, y, font, 10.5);
      drawRight(page, latin1(fmtCents(li.unitPriceCents, record.currency)), colUnit, y, font, 10.5);
      drawRight(page, latin1(fmtCents(Math.round(li.qty * li.unitPriceCents), record.currency)), colAmt, y, font, 10.5);
      y -= 10;
      page.drawLine({ start: { x: MARGIN, y }, end: { x: rightX, y }, thickness: 0.5, color: LINE });
      y -= 18;
    }

    if (record.discountPct && record.discountPct > 0) {
      page.drawText('Discount', { x: MARGIN, y, size: 10.5, font, color: INK });
      drawRight(page, `-${record.discountPct}%`, colAmt, y, font, 10.5, ACCENT);
      y -= 10;
      page.drawLine({ start: { x: MARGIN, y }, end: { x: rightX, y }, thickness: 0.5, color: LINE });
      y -= 18;
    }

    // ── total ──
    y -= 8;
    page.drawText('Total', { x: colUnit - 90, y, size: 15, font: bold, color: INK });
    drawRight(page, latin1(fmtCents(record.totalCents, record.currency)), colAmt, y, bold, 15, ACCENT);
    y -= 34;

    if (record.notes) {
      page.drawText(truncate(latin1(record.notes), 110), { x: MARGIN, y, size: 9.5, font, color: MUTED });
      y -= 22;
    }

    // ── footer ──
    const footY = Math.min(y, 110);
    page.drawLine({ start: { x: MARGIN, y: footY + 14 }, end: { x: rightX, y: footY + 14 }, thickness: 0.75, color: LINE });
    page.drawText(
      latin1(`Valid for 14 days from the date above. Reply in chat to confirm your booking — ${truncate(rules.businessName, 40)}.`),
      { x: MARGIN, y: footY, size: 9, font, color: MUTED },
    );

    const filename = `quote-${record.id}.pdf`;
    fs.writeFileSync(path.join(outDir, filename), await doc.save());
    return filename;
  } catch (err) {
    console.error(`[pdf] render failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
