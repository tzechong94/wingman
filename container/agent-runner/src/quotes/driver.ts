/**
 * Deterministic quote driver — the trusted code between the model and the
 * customer. Same pattern as the provider's captureTurn/maybeSchedule: qwen
 * won't reliably invoke MCP tools on its own, so the model only DRAFTS (a
 * fenced QUOTE_JSON block in its output) and this module does everything else.
 *
 *   result text ──▶ extractQuoteBlock ──▶ cleanedText (prose → dispatch as usual)
 *                        │
 *                        ▼ QuoteDraft
 *                  handleQuoteDraft
 *                        │ evaluateQuote (rules.ts, house-rules.json)
 *          ┌─────────────┴──────────────┐
 *          ▼ autoSend                   ▼ escalate
 *   quote-card chat row           "checking with the boss" chat row
 *   (+ PDF via outbox)            request_quote_approval system row
 *   persist_quote system row      reasoning events
 *   schedule follow-up task
 *   reasoning events
 *
 * The QuoteRecord's sessionId is stamped '' here — the host delivery handler
 * fills it from the session it polls (the container doesn't know its id).
 */
import fs from 'fs';
import path from 'path';

import { writeMessageOut } from '../db/messages-out.js';
import {
  CONTRACT_VERSION,
  QUOTE_BLOCK_FENCE,
  subtotalCents,
  type QuoteDraft,
  type QuoteRecord,
  type ReasoningEvent,
  type RetrievalInfo,
} from './contracts.js';
import type { HouseRules } from './contracts.js';
import { evaluateQuote, fmtCents, parseHouseRules, DEFAULT_HOUSE_RULES } from './rules.js';

const HOUSE_RULES_PATH = '/workspace/agent/house-rules.json';
const OUTBOX_DIR = '/workspace/outbox';

export interface QuoteRouting {
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  inReplyTo: string | null;
}

function log(msg: string): void {
  console.error(`[quote-driver] ${msg}`);
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ── extraction ── */

export interface ExtractResult {
  draft: QuoteDraft | null;
  /** Input with every QUOTE_JSON block removed (model prose only). */
  cleanedText: string;
  parseError?: string;
}

// Models emit the block as a ``` fence OR as an XML-ish tag — accept both.
const BLOCK_RE = new RegExp(
  '(?:```' + QUOTE_BLOCK_FENCE + '\\s*([\\s\\S]*?)```|<' + QUOTE_BLOCK_FENCE + '>\\s*([\\s\\S]*?)</' + QUOTE_BLOCK_FENCE + '>)',
  'g',
);

/**
 * Find the first fenced QUOTE_JSON block anywhere in the model output
 * (models misplace it — inside <message> bodies, after them, anywhere) and
 * strip ALL occurrences from the prose.
 */
export function extractQuoteBlock(text: string): ExtractResult {
  const matches = [...text.matchAll(BLOCK_RE)];
  if (matches.length === 0) return { draft: null, cleanedText: text };

  const cleanedText = text.replace(BLOCK_RE, '').replace(/\n{3,}/g, '\n\n');
  const raw = (matches[0][1] ?? matches[0][2] ?? '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { draft: null, cleanedText, parseError: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }

  const draft = validateDraftObject(parsed);
  if (typeof draft === 'string') return { draft: null, cleanedText, parseError: draft };
  return { draft, cleanedText };
}

/** Validate + normalize a parsed draft object into a QuoteDraft, or return an error string. */
export function validateDraftObject(obj: unknown): QuoteDraft | string {
  if (typeof obj !== 'object' || obj === null) return 'block is not an object';
  const o = obj as Record<string, unknown>;

  if (!Array.isArray(o.lineItems) || o.lineItems.length === 0) return 'lineItems must be a non-empty array';
  const lineItems = [];
  for (const [i, itRaw] of (o.lineItems as unknown[]).entries()) {
    if (typeof itRaw !== 'object' || itRaw === null) return `lineItems[${i}] is not an object`;
    const it = itRaw as Record<string, unknown>;
    const description = typeof it.description === 'string' ? it.description.trim() : '';
    const qty = typeof it.qty === 'number' && Number.isFinite(it.qty) && it.qty > 0 ? it.qty : NaN;
    const unitPriceCents = typeof it.unitPriceCents === 'number' && Number.isFinite(it.unitPriceCents) && it.unitPriceCents >= 0 ? Math.round(it.unitPriceCents) : NaN;
    if (!description) return `lineItems[${i}].description missing`;
    if (Number.isNaN(qty)) return `lineItems[${i}].qty invalid`;
    if (Number.isNaN(unitPriceCents)) return `lineItems[${i}].unitPriceCents invalid`;
    lineItems.push({
      description,
      qty,
      unitPriceCents,
      ...(typeof it.rateCardRef === 'string' && it.rateCardRef.trim() ? { rateCardRef: it.rateCardRef.trim() } : {}),
    });
  }

  const discountPct =
    typeof o.discountPct === 'number' && Number.isFinite(o.discountPct) && o.discountPct > 0
      ? o.discountPct
      : undefined;

  // Never trust the model's arithmetic: recompute the total.
  const subtotal = subtotalCents(lineItems);
  const totalCents = Math.round(subtotal * (1 - (discountPct ?? 0) / 100));

  return {
    v: typeof o.v === 'number' ? o.v : CONTRACT_VERSION,
    customerName: typeof o.customerName === 'string' && o.customerName.trim() ? o.customerName.trim() : undefined,
    lineItems,
    discountPct,
    totalCents,
    currency: typeof o.currency === 'string' && o.currency.trim() ? o.currency.trim() : 'SGD',
    notes: typeof o.notes === 'string' && o.notes.trim() ? o.notes.trim() : undefined,
  };
}

/* ── side-effect seams (injectable for tests) ── */

export interface DriverDeps {
  loadHouseRules(): HouseRules;
  retrieval(): RetrievalInfo;
  /** Render a PDF into the outbox dir for message `msgId`; returns filename or null. */
  renderPdf(msgId: string, record: QuoteRecord, rules: HouseRules): Promise<string | null>;
  writeOut: typeof writeMessageOut;
  now(): Date;
}

export function defaultDeps(): DriverDeps {
  return {
    loadHouseRules() {
      try {
        return parseHouseRules(fs.readFileSync(HOUSE_RULES_PATH, 'utf8'));
      } catch {
        log(`no ${HOUSE_RULES_PATH} — using defaults`);
        return { ...DEFAULT_HOUSE_RULES };
      }
    },
    retrieval() {
      // Engram search scores aren't exposed to the driver today (day-1 probe d).
      // Null disables the low_confidence rule; off_card still covers grounding.
      return { confidence: null };
    },
    async renderPdf(msgId, record, rules) {
      try {
        const { renderQuotePdf } = await import('./pdf.js');
        const outDir = path.join(OUTBOX_DIR, msgId);
        fs.mkdirSync(outDir, { recursive: true });
        return await renderQuotePdf(record, rules, outDir);
      } catch (e) {
        log(`PDF render failed (quote still sends): ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
    writeOut: writeMessageOut,
    now: () => new Date(),
  };
}

/* ── deferred context notes ─────────────────────────────────────────────────
 * Notes for the MODEL about what the quoting system did. Delivered by
 * prepending to the NEXT prompt (not query.push) — an immediate push makes
 * the model produce a stray visible reply ("one moment!") after the card. */

let pendingQuoteNote = '';

export function setPendingQuoteNote(note: string): void {
  pendingQuoteNote = note;
}

export function consumePendingQuoteNote(): string {
  const n = pendingQuoteNote;
  pendingQuoteNote = '';
  return n ? `${n}\n` : '';
}

/* ── the driver ── */

export interface DriveResult {
  handled: boolean;
  autoSent?: boolean;
  quoteId?: string;
}

/**
 * Act on a parsed QuoteDraft. Deterministic; the model is not consulted again.
 * Never throws — a failure here must not kill the poll loop.
 */
export async function handleQuoteDraft(
  draft: QuoteDraft,
  routing: QuoteRouting,
  deps: DriverDeps = defaultDeps(),
): Promise<DriveResult> {
  try {
    const rules = deps.loadHouseRules();
    const retrieval = deps.retrieval();
    const decision = evaluateQuote(draft, rules, retrieval);
    const nowIso = deps.now().toISOString();
    const quoteId = generateId('qt');

    const record: QuoteRecord = {
      id: quoteId,
      sessionId: '', // host stamps
      customerName: draft.customerName ?? null,
      status: decision.autoSend ? 'auto_sent' : 'pending_approval',
      lineItems: draft.lineItems,
      discountPct: draft.discountPct ?? null,
      totalCents: draft.totalCents,
      currency: draft.currency,
      escalationReason: decision.reason ?? null,
      escalationDetails: decision.autoSend ? null : decision.details,
      confidence: retrieval.confidence,
      notes: draft.notes ?? null,
      pdfFile: null,
      createdAt: nowIso,
    };

    emitReasoning(deps, {
      ts: nowIso,
      type: 'rule',
      summary: decision.autoSend ? `Quote within house rules — auto-sending` : `Escalating to owner`,
      detail: decision.details,
    });

    if (decision.autoSend) {
      // Deterministic dedup: an auto-send identical to the last card we sent
      // (same items, discount, total) is a re-statement, not new information
      // — sending it again reads as a broken bot. Suppress with a reasoning
      // event; the prose (if any) still goes out.
      if (isDuplicateOfLastQuote(record)) {
        emitReasoning(deps, {
          ts: deps.now().toISOString(),
          type: 'rule',
          summary: 'Identical re-quote suppressed',
          detail: 'Draft matches the last quote card already sent — nothing changed',
        });
        log(`duplicate quote suppressed (${fmtCents(record.totalCents, record.currency)})`);
        return { handled: false };
      }
      const msgId = generateId('msg');
      record.pdfFile = await deps.renderPdf(msgId, record, rules);

      deps.writeOut({
        id: msgId,
        in_reply_to: routing.inReplyTo,
        kind: 'chat',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({
          text: formatQuoteText(record, rules),
          quote: record,
          ...(record.pdfFile ? { files: [record.pdfFile] } : {}),
        }),
      });

      deps.writeOut({
        id: generateId('sys'),
        kind: 'system',
        content: JSON.stringify({ action: 'persist_quote', quote: record }),
      });

      scheduleFollowUp(deps, record, rules, routing);
      log(`auto-sent quote ${quoteId} (${fmtCents(record.totalCents, record.currency)})`);
      return { handled: true, autoSent: true, quoteId };
    }

    // Escalation path — the customer hears "checking with the boss"; the owner
    // gets the approval card (host side, via request_quote_approval).
    deps.writeOut({
      id: generateId('msg'),
      in_reply_to: routing.inReplyTo,
      kind: 'chat',
      platform_id: routing.platformId,
      channel_type: routing.channelType,
      thread_id: routing.threadId,
      content: JSON.stringify({
        text: `Let me check with the boss on that — one moment! I'll come back to you shortly.`,
        quotePending: { quoteId, reason: record.escalationReason },
      }),
    });

    deps.writeOut({
      id: generateId('sys'),
      kind: 'system',
      content: JSON.stringify({ action: 'request_quote_approval', quote: record, why: decision.details }),
    });

    emitReasoning(deps, {
      ts: deps.now().toISOString(),
      type: 'escalation',
      summary: `Sent to owner for approval`,
      detail: decision.details,
    });

    log(`escalated quote ${quoteId}: ${decision.details}`);
    return { handled: true, autoSent: false, quoteId };
  } catch (e) {
    log(`driver error: ${e instanceof Error ? e.message : String(e)}`);
    emitReasoning(defaultDeps(), {
      ts: new Date().toISOString(),
      type: 'error',
      summary: 'Quote driver error',
      detail: e instanceof Error ? e.message : String(e),
    });
    return { handled: false };
  }
}

/** True when the draft matches the most recent quote card sent in this session. */
function isDuplicateOfLastQuote(record: QuoteRecord): boolean {
  try {
    const { getOutboundDb } = require('../db/connection.js') as typeof import('../db/connection.js');
    const rows = getOutboundDb()
      .prepare("SELECT content FROM messages_out WHERE kind = 'chat' ORDER BY seq DESC LIMIT 20")
      .all() as Array<{ content: string }>;
    for (const r of rows) {
      const c = JSON.parse(r.content) as { quote?: QuoteRecord };
      if (!c.quote) continue;
      const q = c.quote;
      const sameItems =
        q.lineItems.length === record.lineItems.length &&
        q.lineItems.every(
          (li, i) =>
            li.description === record.lineItems[i].description &&
            li.qty === record.lineItems[i].qty &&
            li.unitPriceCents === record.lineItems[i].unitPriceCents,
        );
      return sameItems && (q.discountPct ?? 0) === (record.discountPct ?? 0) && q.totalCents === record.totalCents;
    }
  } catch {
    /* dedup is best-effort */
  }
  return false;
}

function emitReasoning(deps: DriverDeps, event: ReasoningEvent): void {
  try {
    deps.writeOut({
      id: generateId('sys'),
      kind: 'system',
      content: JSON.stringify({ action: 'reasoning_event', event }),
    });
  } catch {
    /* reasoning feed is best-effort */
  }
}

function scheduleFollowUp(deps: DriverDeps, record: QuoteRecord, rules: HouseRules, routing: QuoteRouting): void {
  const hours = rules.followUpAfterHours;
  if (!hours || hours <= 0) return;
  const processAfter = new Date(deps.now().getTime() + hours * 3_600_000).toISOString();
  const taskId = generateId('task');
  deps.writeOut({
    id: generateId('sys'),
    kind: 'system',
    content: JSON.stringify({
      action: 'schedule_task',
      taskId,
      prompt:
        `Follow-up check for quote ${record.id} (${fmtCents(record.totalCents, record.currency)}, ` +
        `customer: ${record.customerName ?? 'unknown'}). If the customer has NOT replied since the quote was sent, ` +
        `draft a short, warm follow-up nudge and emit it as a NUDGE_JSON block per your instructions. ` +
        `If they replied or booked, do nothing and output only <internal>done</internal>.`,
      script: null,
      processAfter,
      recurrence: null,
      platformId: routing.platformId,
      channelType: routing.channelType,
      threadId: routing.threadId,
    }),
  });
  emitReasoning(deps, {
    ts: deps.now().toISOString(),
    type: 'followup',
    summary: `Follow-up scheduled in ${hours}h`,
    detail: `Task ${taskId} fires at ${processAfter} unless the customer replies`,
  });
}

/** Customer-facing quote text (channel-agnostic plain text; card rendering is per-surface). */
export function formatQuoteText(record: QuoteRecord, rules: HouseRules): string {
  const lines = record.lineItems.map(
    (li) => `• ${li.description} — ${li.qty} × ${fmtCents(li.unitPriceCents, record.currency)}`,
  );
  const discount =
    record.discountPct && record.discountPct > 0 ? `\nDiscount: ${record.discountPct}%` : '';
  return (
    `📋 Quote from ${rules.businessName}\n\n` +
    lines.join('\n') +
    discount +
    `\n\nTotal: ${fmtCents(record.totalCents, record.currency)}` +
    (record.notes ? `\n${record.notes}` : '') +
    `\n\nValid for 14 days. Reply here to confirm a booking!`
  );
}

/* ── nudge drafts (follow-up turns) ── */

const NUDGE_RE = /(?:```NUDGE_JSON\s*([\s\S]*?)```|<NUDGE_JSON>\s*([\s\S]*?)<\/NUDGE_JSON>)/g;

export interface NudgeExtract {
  nudge: { quoteId: string; text: string } | null;
  cleanedText: string;
}

export function extractNudgeBlock(text: string): NudgeExtract {
  const matches = [...text.matchAll(NUDGE_RE)];
  if (matches.length === 0) return { nudge: null, cleanedText: text };
  const cleanedText = text.replace(NUDGE_RE, '').replace(/\n{3,}/g, '\n\n');
  try {
    const o = JSON.parse((matches[0][1] ?? matches[0][2] ?? '').trim()) as Record<string, unknown>;
    const quoteId = typeof o.quoteId === 'string' ? o.quoteId : '';
    const textVal = typeof o.text === 'string' ? o.text.trim() : '';
    if (!textVal) return { nudge: null, cleanedText };
    return { nudge: { quoteId, text: textVal }, cleanedText };
  } catch {
    return { nudge: null, cleanedText };
  }
}

/**
 * One-call seam for the poll loop: extract + act on QUOTE_JSON / NUDGE_JSON
 * in a turn's result text. Returns the prose with blocks stripped, plus
 * whether the driver performed a delivery (so the caller can skip the
 * "unwrapped output" nudge — the customer already got a message from us).
 */
export async function runQuoteDrivers(
  text: string,
  routing: QuoteRouting,
  deps: DriverDeps = defaultDeps(),
): Promise<{ cleanedText: string; acted: boolean }> {
  let acted = false;
  let cleanedText = text;

  const q = extractQuoteBlock(cleanedText);
  cleanedText = q.cleanedText;
  if (q.parseError) {
    log(`QUOTE_JSON parse error: ${q.parseError}`);
    emitReasoning(deps, {
      ts: deps.now().toISOString(),
      type: 'error',
      summary: 'Malformed QUOTE_JSON from model — no quote sent',
      detail: q.parseError,
    });
  }
  if (q.draft) {
    const res = await handleQuoteDraft(q.draft, routing, deps);
    acted = acted || res.handled;
  }

  const n = extractNudgeBlock(cleanedText);
  cleanedText = n.cleanedText;
  if (n.nudge) {
    handleNudgeDraft(n.nudge, deps);
    acted = true;
  }

  return { cleanedText, acted };
}

/** Nudges ALWAYS escalate (unsolicited outbound = consequential). */
export function handleNudgeDraft(
  nudge: { quoteId: string; text: string },
  deps: DriverDeps = defaultDeps(),
): void {
  try {
    deps.writeOut({
      id: generateId('sys'),
      kind: 'system',
      content: JSON.stringify({
        action: 'request_nudge_approval',
        quoteId: nudge.quoteId,
        draftText: nudge.text,
        why: 'Unsolicited follow-up to a customer always needs the owner',
      }),
    });
    emitReasoning(deps, {
      ts: deps.now().toISOString(),
      type: 'followup',
      summary: 'Follow-up nudge drafted — sent to owner for approval',
      detail: nudge.text.slice(0, 200),
    });
  } catch (e) {
    log(`nudge error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
