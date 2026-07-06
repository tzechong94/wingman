/**
 * Deterministic quote extraction sidecar — the reliability backstop.
 *
 * The agentic model (qwen-code) converses well but emits QUOTE_JSON
 * unreliably (narrates instead — the same failure the fork already patched
 * for memory/reminders/behavior with focused API extraction). So when a
 * customer turn ends with NO quote block, we run a temperature-0 JSON
 * extraction over the recent transcript + rate card + house rules:
 *
 *   "Is this request fully scoped and quotable? If yes → QuoteDraft."
 *
 * The result feeds the same driver (rules → auto-send/escalate). The main
 * model's prose still carries the conversation; money never depends on it.
 *
 * All model calls here go to Alibaba Cloud Model Studio (DashScope) —
 * qwen-max at temperature 0 via the OpenAI-compatible endpoint
 * (DASHSCOPE_BASE_URL, e.g. https://dashscope-intl.aliyuncs.com/compatible-mode/v1).
 * The host itself runs on an Alibaba Cloud ECS instance; see
 * deploy/alibaba/bootstrap.sh + deploy.sh.
 */
import fs from 'fs';

import { getInboundDb, getOutboundDb } from '../db/connection.js';
import type { QuoteDraft } from './contracts.js';
import { validateDraftObject } from './driver.js';
import { parseHouseRules, DEFAULT_HOUSE_RULES } from './rules.js';

const EXTRACT_MODEL = process.env.QWEN_EXTRACT_MODEL || 'qwen-max';
const EXTRACT_TIMEOUT_MS = 20_000;
const TRANSCRIPT_ROWS = 22;

function log(msg: string): void {
  console.error(`[quote-extractor] ${msg}`);
}

/** Interleaved recent transcript — seq spans both session DBs, so a union sort works. */
export function getRecentTranscript(
  limit = TRANSCRIPT_ROWS,
): Array<{ role: 'customer' | 'assistant' | 'owner_system'; text: string }> {
  const rows: Array<{ seq: number; role: 'customer' | 'assistant' | 'owner_system'; text: string }> = [];
  try {
    const ins = getInboundDb()
      .prepare("SELECT seq, content FROM messages_in WHERE kind IN ('chat','chat-sdk') ORDER BY seq DESC LIMIT ?")
      .all(limit) as Array<{ seq: number; content: string }>;
    for (const r of ins) {
      try {
        const c = JSON.parse(r.content) as { text?: string; sender?: string; senderId?: string };
        if (!c.text) continue;
        // Host system notices (owner decisions, instructions) arrive on the
        // inbound side with sender 'system' — labeling them CUSTOMER poisons
        // quotability judgments ("Owner REJECTED…" is not a customer ask).
        const isSystem = c.sender === 'system' || c.senderId === 'system';
        rows.push({ seq: r.seq, role: isSystem ? 'owner_system' : 'customer', text: c.text });
      } catch {
        /* skip */
      }
    }
    const outs = getOutboundDb()
      .prepare("SELECT seq, content FROM messages_out WHERE kind = 'chat' ORDER BY seq DESC LIMIT ?")
      .all(limit) as Array<{ seq: number; content: string }>;
    for (const r of outs) {
      try {
        const c = JSON.parse(r.content) as { text?: string };
        if (c.text) rows.push({ seq: r.seq, role: 'assistant', text: c.text });
      } catch {
        /* skip */
      }
    }
  } catch (err) {
    log(`transcript read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  rows.sort((a, b) => a.seq - b.seq);
  return rows.slice(-limit).map(({ role, text }) => ({ role, text }));
}

function readWorkspaceFile(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/* ── rate-card grounding (deterministic) ── */

export interface RateCardEntry {
  ref: string;
  description: string;
  priceCents: number;
}

/** Parse the markdown rate-card table: | RC-xx | description | price |. */
export function parseRateCard(md: string): Map<string, RateCardEntry> {
  const out = new Map<string, RateCardEntry>();
  for (const line of md.split('\n')) {
    const m = line.match(/^\|\s*(RC-\d+[A-Z]?)\s*\|\s*([^|]+?)\s*\|\s*([\d,.]+)\s*\|/);
    if (!m) continue;
    const priceCents = Math.round(parseFloat(m[3].replace(/,/g, '')) * 100);
    if (Number.isFinite(priceCents)) out.set(m[1], { ref: m[1], description: m[2], priceCents });
  }
  return out;
}

/**
 * Resolve the model's FLAT item strings into line items, priced from the
 * parsed rate card — the model never supplies prices for on-card work.
 *   items:   "RC-07 x1; RC-01 x3"
 *   offCard: "custom ducting for server room @ 900 x1"  (price = SGD estimate)
 */
export function resolveFlatItems(
  items: string,
  offCard: string,
  card: Map<string, RateCardEntry>,
): Array<{ description: string; qty: number; unitPriceCents: number; rateCardRef?: string }> | string {
  const lineItems: Array<{ description: string; qty: number; unitPriceCents: number; rateCardRef?: string }> = [];
  for (const part of items.split(/[;,]/).map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^(RC-\d+[A-Z]?)\s*(?:x\s*(\d+))?$/i);
    if (!m) return `unparseable item "${part}" (expected "RC-xx xN")`;
    const entry = card.get(m[1].toUpperCase());
    if (!entry) return `unknown rate-card ref ${m[1]}`;
    lineItems.push({
      description: entry.description,
      qty: m[2] ? parseInt(m[2], 10) : 1,
      unitPriceCents: entry.priceCents,
      rateCardRef: entry.ref,
    });
  }
  for (const part of offCard.split(';').map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^(.+?)\s*@\s*(?:SGD\s*)?([\d,.]+)\s*(?:x\s*(\d+))?$/i);
    if (!m) return `unparseable off-card item "${part}" (expected "description @ price xN")`;
    lineItems.push({
      description: m[1].trim(),
      qty: m[3] ? parseInt(m[3], 10) : 1,
      unitPriceCents: Math.round(parseFloat(m[2].replace(/,/g, '')) * 100),
      // no rateCardRef → the rules engine escalates as off_card
    });
  }
  return lineItems.length ? lineItems : 'no items resolved';
}

/**
 * Decide + draft. Returns null when: not enough info yet, already quoted,
 * API unavailable, or the response fails validation.
 */
export async function extractQuoteDraft(
  latestReply: string,
  transcript = getRecentTranscript(),
): Promise<QuoteDraft | null> {
  return (await extractQuoteDecision(latestReply, transcript)).draft;
}

/** Full decision: the draft when quotable, else the model's stated reason. */
export async function extractQuoteDecision(
  latestReply: string,
  transcript = getRecentTranscript(),
): Promise<{ draft: QuoteDraft | null; notQuotableReason: string | null }> {
  const key = process.env.DASHSCOPE_API_KEY || process.env.OPENAI_API_KEY;
  const base = process.env.OPENAI_BASE_URL || process.env.DASHSCOPE_BASE_URL;
  if (!key || !base) return { draft: null, notQuotableReason: null };

  const rateCard = readWorkspaceFile('/workspace/agent/rate-card.md');
  if (!rateCard) return { draft: null, notQuotableReason: null }; // no rate card → nothing to ground a quote in
  const rules = parseHouseRules(readWorkspaceFile('/workspace/agent/house-rules.json') || '{}');

  const convo =
    transcript
      .map((t) => `${t.role === 'customer' ? 'CUSTOMER' : t.role === 'owner_system' ? 'OWNER/SYSTEM' : 'ASSISTANT'}: ${t.text}`)
      .join('\n') + (latestReply ? `\nASSISTANT (latest): ${latestReply}` : '');

  const sys =
    `You are the quoting engine for ${rules.businessName || DEFAULT_HOUSE_RULES.businessName}. ` +
    `House rules: max auto-approved discount ${rules.maxAutoDiscountPct}%. ` +
    `Given the rate card and a conversation, decide if the customer's CURRENT request is fully scoped and quotable. ` +
    `Reply with STRICT JSON only — ALL FLAT STRING/NUMBER FIELDS, NO nested objects or arrays:\n` +
    `{"quotable": boolean, "reason": string, "customerName": string|null, ` +
    `"items": string, "offCard": string, "discountPct": number|null, "notes": string|null}\n\n` +
    `Field rules:\n` +
    `- "items": rate-card services as "REF xQTY" separated by "; ". Example: "RC-07 x1; RC-01 x3". NEVER include prices — the system prices refs itself.\n` +
    `- "offCard": services NOT on the rate card as "description @ SGD-estimate xQTY" separated by "; ". Empty string if none. Example: "custom ducting for server room @ 900 x1".\n` +
    `- "discountPct": the discount percentage the CUSTOMER asked for, else null. If the customer asks for a discount ` +
    `WITHOUT naming a number ("can I get a discount?"), use the house maximum (${rules.maxAutoDiscountPct}) — the business's ` +
    `standard gesture. A named number always wins over the default.\n` +
    `- NEVER emit a draft identical to the last formal quote card (same items, same discount): if nothing about the ` +
    `request changed the quote, quotable=false with reason "identical to last quote".\n` +
    `- Judge quotability ONLY from what the CUSTOMER has said (anywhere in the transcript). For RATE-CARD unit services: ` +
    `quotable=true when the customer's messages establish unit count, unit type (wall-mounted / ceiling cassette / window), and the needed service. ` +
    `For services NOT on the rate card (custom/commercial/structural work): quotable=true as soon as the JOB is clearly ` +
    `described — no unit count/type needed; include it in offCard with your best estimate so the boss can rule on it.\n` +
    `- Quantity discounts: when a rate card row exists for a bundle (e.g. RC-01B for 3+ units), you MUST use it when the quantity qualifies.\n` +
    `IGNORE the assistant's own questions — assistants over-ask; a redundant assistant question never blocks a quote.\n` +
    `- When the customer chose a service in answer to a which-service question, quote ONLY the chosen service — do not also add diagnostic/repair items they did not pick.\n` +
    `- OWNER/SYSTEM lines are the BUSINESS OWNER's decisions and outrank everything, INCLUDING every rule below. ` +
    `An OWNER INSTRUCTION with terms (e.g. "max 20%") IS ITSELF A NEW REQUEST: quotable=true immediately, ` +
    `re-quote the same items with EXACTLY the owner's terms (discountPct = the owner's stated max) — do NOT wait ` +
    `for the customer to ask again, and "already quoted / no new request" does NOT apply. ` +
    `Never re-submit a discount the owner rejected. If the owner rejected with NO instruction and the customer ` +
    `hasn't spoken since, re-quote at the house-rules discount limit. ` +
    `CRITICAL: owner decisions exist ONLY as OWNER/SYSTEM lines. The ASSISTANT's own prose ("we can't offer 50%") ` +
    `is NEVER a rejection or an owner decision. A customer discount ask with NO OWNER/SYSTEM ruling on it is ` +
    `simply quotable=true with that discountPct — routing it to the owner is exactly what the system does next.\n` +
    `- quotable=false if a FORMAL QUOTE CARD was already sent AND the customer has asked nothing new since — formal cards begin with "📋 Quote from" or "Good news — the boss approved". ` +
    `A price merely mentioned in assistant prose is NOT a formal quote. BUT if the customer asks anything new AFTER the card ` +
    `(a discount, more units, a different service), that IS quotable again: re-quote the same items with the change applied ` +
    `(e.g. discount ask → same items + discountPct set to what they asked).\n\n` +
    `EXAMPLE quotable: {"quotable":true,"reason":"1 wall unit, leak repair scoped","customerName":"Ms. Lee","items":"RC-07 x1","offCard":"","discountPct":null,"notes":null}\n` +
    `EXAMPLE not quotable: {"quotable":false,"reason":"unit type unknown","customerName":null,"items":"","offCard":"","discountPct":null,"notes":null}\n\n` +
    `RATE CARD:\n${rateCard}`;

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: sys },
    { role: 'user', content: convo },
  ];

  // Up to 2 attempts: the second feeds the validation error back so the
  // model can correct its own schema mistake (qwen sometimes returns
  // lineItems as strings on the first try).
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXTRACT_TIMEOUT_MS);
    try {
      const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        signal: controller.signal,
        body: JSON.stringify({
          model: EXTRACT_MODEL,
          messages,
          response_format: { type: 'json_object' },
          temperature: 0,
        }),
      });
      if (!res.ok) {
        log(`extraction HTTP ${res.status}`);
        return { draft: null, notQuotableReason: null };
      }
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const raw = body.choices?.[0]?.message?.content;
      if (!raw) return { draft: null, notQuotableReason: null };
      const parsed = JSON.parse(raw) as {
        quotable?: boolean;
        reason?: string;
        customerName?: string | null;
        items?: string;
        offCard?: string;
        discountPct?: number | null;
        notes?: string | null;
      };
      if (!parsed.quotable) {
        log(`not quotable: ${parsed.reason ?? 'no reason'}`);
        return { draft: null, notQuotableReason: parsed.reason ?? 'details still missing' };
      }
      const card = parseRateCard(rateCard);
      const lineItems = resolveFlatItems(parsed.items ?? '', parsed.offCard ?? '', card);
      if (typeof lineItems === 'string') {
        log(`extraction items invalid (attempt ${attempt}): ${lineItems} — raw: ${raw.slice(0, 300)}`);
        messages.push(
          { role: 'assistant', content: raw },
          {
            role: 'user',
            content:
              `Your items failed validation: ${lineItems}. Reply again with the full flat JSON. ` +
              `"items" is rate-card refs only like "RC-07 x1; RC-01 x3"; "offCard" is "description @ SGD-estimate xQTY" or "".`,
          },
        );
        continue;
      }
      const draft = validateDraftObject({
        customerName: parsed.customerName ?? null,
        lineItems,
        discountPct: parsed.discountPct ?? undefined,
        currency: rules.currency || 'SGD',
        notes: parsed.notes ?? undefined,
      });
      if (typeof draft === 'string') {
        log(`extraction draft invalid (attempt ${attempt}): ${draft}`);
        return { draft: null, notQuotableReason: null };
      }
      log(`extracted quote (attempt ${attempt}): ${draft.lineItems.length} item(s), total ${draft.totalCents}`);
      return { draft, notQuotableReason: null };
    } catch (err) {
      log(`extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      return { draft: null, notQuotableReason: null };
    } finally {
      clearTimeout(timer);
    }
  }
  return { draft: null, notQuotableReason: null };
}
