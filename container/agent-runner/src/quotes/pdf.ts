/**
 * Quote PDF renderer — HTML template printed to PDF via the headless Chromium
 * already baked into the agent image. Best-effort by design: callers treat a
 * null return as "send the quote without a PDF".
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import type { HouseRules, QuoteRecord } from './contracts.js';
import { fmtCents } from './rules.js';

const execFileAsync = promisify(execFile);

const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_BIN || '',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);

function findChromium(): string | null {
  for (const bin of CHROMIUM_CANDIDATES) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return bin;
    } catch {
      /* next */
    }
  }
  return null;
}

export async function renderQuotePdf(
  record: QuoteRecord,
  rules: HouseRules,
  outDir: string,
): Promise<string | null> {
  const chromium = findChromium();
  if (!chromium) return null;

  const filename = `quote-${record.id}.pdf`;
  const outPath = path.join(outDir, filename);
  const htmlPath = path.join(os.tmpdir(), `quote-${record.id}.html`);
  fs.writeFileSync(htmlPath, quoteHtml(record, rules), 'utf8');

  try {
    await execFileAsync(
      chromium,
      [
        '--headless',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        `--print-to-pdf=${outPath}`,
        '--no-pdf-header-footer',
        `file://${htmlPath}`,
      ],
      { timeout: 20_000 },
    );
    return fs.existsSync(outPath) ? filename : null;
  } catch {
    return null;
  } finally {
    fs.rmSync(htmlPath, { force: true });
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function quoteHtml(record: QuoteRecord, rules: HouseRules): string {
  const rows = record.lineItems
    .map(
      (li) => `<tr>
        <td>${esc(li.description)}${li.rateCardRef ? `<span class="ref">${esc(li.rateCardRef)}</span>` : ''}</td>
        <td class="num">${li.qty}</td>
        <td class="num">${fmtCents(li.unitPriceCents, record.currency)}</td>
        <td class="num">${fmtCents(Math.round(li.qty * li.unitPriceCents), record.currency)}</td>
      </tr>`,
    )
    .join('\n');

  const discountRow =
    record.discountPct && record.discountPct > 0
      ? `<tr class="totals"><td colspan="3">Discount</td><td class="num">−${record.discountPct}%</td></tr>`
      : '';

  const date = new Date(record.createdAt);
  const dateStr = Number.isNaN(date.getTime()) ? record.createdAt : date.toISOString().slice(0, 10);

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { --ink:#16302b; --accent:#0e7c66; --line:#d8e4e0; --muted:#5f7a73; }
    * { box-sizing:border-box; margin:0; }
    body { font:14px/1.5 "Helvetica Neue", Arial, sans-serif; color:var(--ink); padding:48px 56px; }
    header { display:flex; justify-content:space-between; align-items:baseline;
             border-bottom:3px solid var(--accent); padding-bottom:16px; margin-bottom:28px; }
    h1 { font-size:24px; letter-spacing:-0.02em; }
    .meta { text-align:right; color:var(--muted); font-size:12px; }
    .meta strong { display:block; color:var(--ink); font-size:14px; }
    h2 { font-size:12px; text-transform:uppercase; letter-spacing:0.08em; color:var(--muted); margin-bottom:8px; }
    table { width:100%; border-collapse:collapse; margin:12px 0 20px; }
    th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.06em;
         color:var(--muted); padding:8px 10px; border-bottom:1px solid var(--line); }
    td { padding:10px; border-bottom:1px solid var(--line); }
    .num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
    .ref { color:var(--muted); font-size:11px; margin-left:8px; }
    .grand { display:flex; justify-content:flex-end; gap:24px; font-size:18px; font-weight:600;
             padding:12px 10px; }
    .grand .amount { color:var(--accent); }
    footer { margin-top:36px; color:var(--muted); font-size:12px; border-top:1px solid var(--line); padding-top:12px; }
  </style></head><body>
    <header>
      <h1>${esc(rules.businessName)}</h1>
      <div class="meta"><strong>Quotation</strong>${esc(record.id)}<br>${dateStr}</div>
    </header>
    ${record.customerName ? `<h2>Prepared for</h2><p style="margin-bottom:20px">${esc(record.customerName)}</p>` : ''}
    <h2>Services</h2>
    <table>
      <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Amount</th></tr></thead>
      <tbody>${rows}${discountRow}</tbody>
    </table>
    <div class="grand"><span>Total</span><span class="amount">${fmtCents(record.totalCents, record.currency)}</span></div>
    ${record.notes ? `<p>${esc(record.notes)}</p>` : ''}
    <footer>Valid for 14 days from the date above. Reply in chat to confirm your booking — ${esc(rules.businessName)}.</footer>
  </body></html>`;
}
