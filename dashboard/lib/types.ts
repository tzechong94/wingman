export type ConvEventType =
  | "msg_in"
  | "msg_out"
  | "reasoning"
  | "quote"
  | "approval"
  | "followup"
  | "error";

/** A conversation event row, parsed from the SSE stream or the transcript endpoint. */
export interface ConvEvent {
  id: number;
  sessionId: string;
  /** epoch milliseconds */
  ts: number;
  type: ConvEventType;
  actor: string;
  payload: Record<string, unknown>;
}

export interface LineItem {
  description: string;
  qty: number;
  unitPriceCents: number;
  rateCardRef?: string;
}

export type QuoteStatus =
  | "auto_sent"
  | "pending_approval"
  | "approved"
  | "rejected";

export type EscalationReason =
  | "discount_exceeds_limit"
  | "off_card"
  | "low_confidence"
  | "total_exceeds_limit"
  | null;

export interface QuoteRecord {
  id: string;
  sessionId: string;
  customerName: string;
  status: QuoteStatus;
  lineItems: LineItem[];
  discountPct: number;
  totalCents: number;
  currency: string;
  escalationReason: EscalationReason;
  escalationDetails: string | null;
  confidence: number | null;
  notes: string | null;
  pdfFile: string | null;
  createdAt: number;
}

export interface FileRef {
  name: string;
  url: string;
}

export interface MsgOutPayload {
  text?: string;
  quote?: unknown;
  quotePending?: { quoteId?: string; reason?: string };
  files?: FileRef[];
  askQuestion?: unknown;
}

export interface MsgInPayload {
  text?: string;
  attachmentCount?: number;
}

export type ReasoningKind =
  | "retrieval"
  | "memory"
  | "rule"
  | "escalation"
  | "vision"
  | "followup"
  | "info"
  | "error";

export interface ReasoningPayload {
  ts?: number | string;
  type?: ReasoningKind;
  summary?: string;
  detail?: string;
}

export type ApprovalAction = "send_quote" | "send_nudge";

export interface ApprovalItem {
  approvalId: string;
  sessionId: string;
  action: ApprovalAction;
  status: string;
  title: string;
  createdAt: number;
  payload: Record<string, unknown>;
}

export interface Analytics {
  quotesSent7d: number;
  autoSent7d: number;
  escalated7d: number;
  medianResponseSeconds: number;
  centsQuoted7d: number;
  currency: string;
}

export interface ConversationSummary {
  sessionId: string;
  lastTs: number;
  lastType: string;
  preview: string;
}

// ---------------------------------------------------------------------------
// Engram memory (GET /webhook/web/memory)
// ---------------------------------------------------------------------------

export interface MemoryEpisode {
  content: string;
  sourceChannel: string;
  /** 0–1 */
  importance: number;
  accessCount: number;
  pinned: boolean;
  status: string;
  createdAt: number;
  lastAccessedAt: number;
}

export interface MemoryNote {
  title: string;
  body: string;
  /** 0–1 */
  confidence: number;
  kind: string;
  updatedAt: number;
}

export interface MemoryEntity {
  name: string;
  type: string;
  /** 0–1 */
  salience: number;
}

export interface MemorySnapshot {
  /** false = Engram Postgres container unreachable */
  available: boolean;
  tenant: string;
  episodes: MemoryEpisode[];
  notes: MemoryNote[];
  entities: MemoryEntity[];
}

// ---------------------------------------------------------------------------
// Parsing / normalization helpers
// The backend sometimes returns raw DB rows (snake_case) and sometimes typed
// records (camelCase); every reader below tolerates both.
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Normalize an epoch-seconds / epoch-ms / ISO-string timestamp to epoch ms. */
export function toMillis(ts: unknown): number {
  if (typeof ts === "number") {
    // Heuristic: values before ~2001 in ms terms are actually seconds.
    return ts < 1e12 ? ts * 1000 : ts;
  }
  if (typeof ts === "string") {
    const asNum = Number(ts);
    if (!Number.isNaN(asNum) && ts.trim() !== "") return toMillis(asNum);
    const parsed = Date.parse(ts);
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }
  return Date.now();
}

function pick(r: Record<string, unknown>, camel: string, snake: string): unknown {
  return r[camel] !== undefined ? r[camel] : r[snake];
}

/** Parse the `data:` field of an SSE `conv` event (or a transcript row). */
export function parseConvEvent(raw: unknown): ConvEvent | null {
  let row: unknown = raw;
  if (typeof raw === "string") {
    try {
      row = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(row)) return null;

  let payload: Record<string, unknown> = {};
  const rawPayload = row.payload;
  if (typeof rawPayload === "string") {
    try {
      const parsed = JSON.parse(rawPayload);
      if (isRecord(parsed)) payload = parsed;
    } catch {
      payload = { text: rawPayload };
    }
  } else if (isRecord(rawPayload)) {
    payload = rawPayload;
  }

  const type = String(row.type ?? "");
  const known: ConvEventType[] = [
    "msg_in",
    "msg_out",
    "reasoning",
    "quote",
    "approval",
    "followup",
    "error",
  ];
  if (!known.includes(type as ConvEventType)) return null;

  return {
    id: Number(row.id ?? 0),
    sessionId: String(pick(row, "sessionId", "session_id") ?? ""),
    ts: toMillis(row.ts),
    type: type as ConvEventType,
    actor: String(row.actor ?? ""),
    payload,
  };
}

function normalizeLineItem(raw: unknown): LineItem {
  const r = isRecord(raw) ? raw : {};
  const ref = pick(r, "rateCardRef", "rate_card_ref");
  return {
    description: String(r.description ?? ""),
    qty: Number(r.qty ?? 1),
    unitPriceCents: Number(pick(r, "unitPriceCents", "unit_price_cents") ?? 0),
    ...(typeof ref === "string" && ref ? { rateCardRef: ref } : {}),
  };
}

/** Accepts a QuoteRecord (camelCase) or a raw quotes-table row (snake_case). */
export function normalizeQuote(raw: unknown): QuoteRecord | null {
  if (!isRecord(raw)) return null;
  const r = raw;
  const itemsRaw = pick(r, "lineItems", "line_items");
  let items: unknown = itemsRaw;
  if (typeof itemsRaw === "string") {
    try {
      items = JSON.parse(itemsRaw);
    } catch {
      items = [];
    }
  }
  const escalationReason = pick(r, "escalationReason", "escalation_reason");
  const escalationDetails = pick(r, "escalationDetails", "escalation_details");
  const confidence = r.confidence;
  const notes = r.notes;
  const pdfFile = pick(r, "pdfFile", "pdf_file");
  return {
    id: String(r.id ?? ""),
    sessionId: String(pick(r, "sessionId", "session_id") ?? ""),
    customerName: String(pick(r, "customerName", "customer_name") ?? ""),
    status: (String(r.status ?? "auto_sent") as QuoteStatus) || "auto_sent",
    lineItems: Array.isArray(items) ? items.map(normalizeLineItem) : [],
    discountPct: Number(pick(r, "discountPct", "discount_pct") ?? 0),
    totalCents: Number(pick(r, "totalCents", "total_cents") ?? 0),
    currency: String(r.currency ?? "SGD"),
    escalationReason: (escalationReason ?? null) as EscalationReason,
    escalationDetails:
      typeof escalationDetails === "string" && escalationDetails
        ? escalationDetails
        : null,
    confidence: typeof confidence === "number" ? confidence : null,
    notes: typeof notes === "string" && notes ? notes : null,
    pdfFile: typeof pdfFile === "string" && pdfFile ? pdfFile : null,
    createdAt: toMillis(pick(r, "createdAt", "created_at")),
  };
}

export function normalizeApproval(raw: unknown): ApprovalItem | null {
  if (!isRecord(raw)) return null;
  const r = raw;
  const payload = isRecord(r.payload) ? r.payload : {};
  return {
    approvalId: String(pick(r, "approvalId", "approval_id") ?? r.id ?? ""),
    sessionId: String(pick(r, "sessionId", "session_id") ?? ""),
    action: (String(r.action ?? "send_quote") as ApprovalAction) || "send_quote",
    status: String(r.status ?? "pending"),
    title: String(r.title ?? "Approval request"),
    createdAt: toMillis(pick(r, "createdAt", "created_at")),
    payload,
  };
}

export function normalizeConversation(raw: unknown): ConversationSummary | null {
  if (!isRecord(raw)) return null;
  const r = raw;
  return {
    sessionId: String(pick(r, "sessionId", "session_id") ?? ""),
    lastTs: toMillis(pick(r, "lastTs", "last_ts")),
    lastType: String(pick(r, "lastType", "last_type") ?? ""),
    preview: String(r.preview ?? ""),
  };
}

/** Clamp an arbitrary value into the [0, 1] range (importance / confidence / salience). */
function toFraction(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function normalizeMemoryEpisode(raw: unknown): MemoryEpisode | null {
  if (!isRecord(raw)) return null;
  const r = raw;
  return {
    content: String(r.content ?? ""),
    sourceChannel: String(pick(r, "sourceChannel", "source_channel") ?? ""),
    importance: toFraction(r.importance),
    accessCount: Number(pick(r, "accessCount", "access_count") ?? 0) || 0,
    pinned: Boolean(r.pinned),
    status: String(r.status ?? ""),
    createdAt: toMillis(pick(r, "createdAt", "created_at")),
    lastAccessedAt: toMillis(pick(r, "lastAccessedAt", "last_accessed_at")),
  };
}

function normalizeMemoryNote(raw: unknown): MemoryNote | null {
  if (!isRecord(raw)) return null;
  const r = raw;
  return {
    title: String(r.title ?? ""),
    body: String(r.body ?? ""),
    confidence: toFraction(r.confidence),
    kind: String(r.kind ?? ""),
    updatedAt: toMillis(pick(r, "updatedAt", "updated_at")),
  };
}

function normalizeMemoryEntity(raw: unknown): MemoryEntity | null {
  if (!isRecord(raw)) return null;
  const r = raw;
  const name = String(r.name ?? "");
  if (!name) return null;
  return {
    name,
    type: String(r.type ?? ""),
    salience: toFraction(r.salience),
  };
}

/** Normalize the /memory endpoint response (tolerates missing sections). */
export function normalizeMemory(raw: unknown): MemorySnapshot {
  const r = isRecord(raw) ? raw : {};
  const episodes = Array.isArray(r.episodes) ? r.episodes : [];
  const notes = Array.isArray(r.notes) ? r.notes : [];
  const entities = Array.isArray(r.entities) ? r.entities : [];
  return {
    available: Boolean(r.available),
    tenant: String(r.tenant ?? ""),
    episodes: episodes
      .map(normalizeMemoryEpisode)
      .filter((e): e is MemoryEpisode => e !== null),
    notes: notes
      .map(normalizeMemoryNote)
      .filter((n): n is MemoryNote => n !== null),
    entities: entities
      .map(normalizeMemoryEntity)
      .filter((e): e is MemoryEntity => e !== null),
  };
}

/** True when an approval is still waiting on a decision. */
export function isApprovalPending(a: ApprovalItem): boolean {
  return !["approved", "rejected", "resolved", "expired"].includes(a.status);
}

/** Extract every quote id referenced by an event (used to clear "waiting" chips). */
export function referencedQuoteIds(e: ConvEvent): string[] {
  const ids: string[] = [];
  const p = e.payload;
  if (typeof p.quoteId === "string") ids.push(p.quoteId);
  const q = normalizeQuote(p.quote);
  if (q?.id) ids.push(q.id);
  if (e.type === "quote") {
    const self = normalizeQuote(p);
    if (self?.id) ids.push(self.id);
  }
  return ids;
}
