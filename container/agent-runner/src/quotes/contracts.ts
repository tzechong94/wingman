/**
 * Wingman quote contracts — container copy.
 *
 * MIRRORED FILE: src/modules/quotes/contracts.ts (host tree) must stay
 * byte-identical below the header. Host (Node) and container (Bun) share no
 * modules; these shapes are the wire protocol between them, carried as JSON in
 * `messages_out` rows (kind='system', content.action) and in the model's
 * fenced QUOTE_JSON block.
 *
 *   model output ──QUOTE_JSON──▶ driver.ts ──rules.ts──▶ auto-send │ escalate
 *                                    │                        │         │
 *                                    ▼                        ▼         ▼
 *                            reasoning_event         persist_quote  request_quote_approval
 *                                    └──────── messages_out (kind='system') ────────┘
 */

export const QUOTE_BLOCK_FENCE = 'QUOTE_JSON';
export const CONTRACT_VERSION = 1;

export interface QuoteLineItem {
  description: string;
  qty: number;
  unitPriceCents: number;
  /** Rate-card line this item was grounded in (e.g. "RC-07"). Absent = off-card. */
  rateCardRef?: string;
}

/** What the model emits inside the fenced QUOTE_JSON block. */
export interface QuoteDraft {
  v: number; // CONTRACT_VERSION
  customerName?: string;
  lineItems: QuoteLineItem[];
  /** Discount the customer asked for / the model applied, in percent (0-100). */
  discountPct?: number;
  /** Total AFTER discount, in cents. Recomputed and verified by the driver. */
  totalCents: number;
  currency: string;
  notes?: string;
}

/** Persona-as-data. Lives at /workspace/agent/house-rules.json. */
export interface HouseRules {
  businessName: string;
  currency: string;
  /** Discounts above this always escalate to the owner. */
  maxAutoDiscountPct: number;
  /** Totals above this always escalate (0 disables the check). */
  maxAutoTotalCents: number;
  /** Engram search relevance below this escalates (0 disables; used only when scores exist). */
  minRetrievalConfidence: number;
  /** Hours of customer silence after a quote before a follow-up is drafted. */
  followUpAfterHours: number;
}

export type EscalationReason =
  | 'discount_exceeds_limit'
  | 'off_card'
  | 'low_confidence'
  | 'total_exceeds_limit';

export interface RetrievalInfo {
  /** Best Engram/rate-card relevance score for this quote, 0..1. Null = scores unavailable. */
  confidence: number | null;
}

export interface RuleDecision {
  autoSend: boolean;
  reason?: EscalationReason;
  /** Human-readable, shown on the approval card ("15% > 10% house limit"). */
  details: string;
}

export type QuoteStatus =
  | 'auto_sent'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'superseded';

/** Persisted quote record (central DB `quotes` table; JSON payload on the wire). */
export interface QuoteRecord {
  id: string;
  sessionId: string;
  customerName: string | null;
  status: QuoteStatus;
  lineItems: QuoteLineItem[];
  discountPct: number | null;
  totalCents: number;
  currency: string;
  escalationReason: EscalationReason | null;
  escalationDetails: string | null;
  confidence: number | null;
  notes: string | null;
  /** Outbox-relative PDF filename, if rendered. */
  pdfFile: string | null;
  createdAt: string;
}

/** Reasoning-feed event (glass cockpit). Emitted by driver code, never the model. */
export interface ReasoningEvent {
  ts: string;
  type: 'retrieval' | 'memory' | 'rule' | 'escalation' | 'vision' | 'followup' | 'info' | 'error';
  summary: string;
  detail?: string;
}

/* ── System-action payloads (messages_out.content, kind='system') ── */

export interface ReasoningEventAction {
  action: 'reasoning_event';
  event: ReasoningEvent;
}

export interface PersistQuoteAction {
  action: 'persist_quote';
  quote: QuoteRecord;
}

export interface RequestQuoteApprovalAction {
  action: 'request_quote_approval';
  quote: QuoteRecord;
  /** Why this needs the owner — rendered on the approval card. */
  why: string;
}

export interface RequestNudgeApprovalAction {
  action: 'request_nudge_approval';
  quoteId: string;
  draftText: string;
  why: string;
}

export type WingmanSystemAction =
  | ReasoningEventAction
  | PersistQuoteAction
  | RequestQuoteApprovalAction
  | RequestNudgeApprovalAction;

/** Compute the pre-discount subtotal of a draft. */
export function subtotalCents(items: QuoteLineItem[]): number {
  return items.reduce((sum, li) => sum + Math.round(li.qty * li.unitPriceCents), 0);
}

/** True when any line item lacks a rate-card grounding reference. */
export function hasOffCardItems(items: QuoteLineItem[]): boolean {
  return items.some((li) => !li.rateCardRef || !li.rateCardRef.trim());
}

export function fmtCents(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}
