/**
 * Central-DB accessors for the Wingman quote pipeline (migration 017).
 *
 * quotes + conversation_events are the dashboard's ONLY query surface —
 * mirror-on-delivery writes here; the web layer never opens session DBs.
 */
import type { QuoteRecord, QuoteStatus, ReasoningEvent } from '../modules/quotes/contracts.js';

import { getDb } from './connection.js';

export interface QuoteRow {
  id: string;
  session_id: string;
  customer_name: string | null;
  status: string;
  line_items: string;
  discount_pct: number | null;
  total_cents: number;
  currency: string;
  escalation_reason: string | null;
  escalation_details: string | null;
  confidence: number | null;
  notes: string | null;
  approval_id: string | null;
  pdf_file: string | null;
  created_at: string;
  resolved_at: string | null;
}

export function insertQuote(q: QuoteRecord, approvalId?: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO quotes (id, session_id, customer_name, status, line_items, discount_pct, total_cents, currency,
                           escalation_reason, escalation_details, confidence, notes, approval_id, pdf_file, created_at)
       VALUES (@id, @session_id, @customer_name, @status, @line_items, @discount_pct, @total_cents, @currency,
               @escalation_reason, @escalation_details, @confidence, @notes, @approval_id, @pdf_file, @created_at)
       ON CONFLICT (id) DO NOTHING`,
    )
    .run({
      id: q.id,
      session_id: q.sessionId,
      customer_name: q.customerName,
      status: q.status,
      line_items: JSON.stringify(q.lineItems),
      discount_pct: q.discountPct,
      total_cents: q.totalCents,
      currency: q.currency,
      escalation_reason: q.escalationReason,
      escalation_details: q.escalationDetails,
      confidence: q.confidence,
      notes: q.notes,
      approval_id: approvalId ?? null,
      created_at: q.createdAt,
      pdf_file: q.pdfFile,
    });
}

export function setQuoteStatus(id: string, status: QuoteStatus, approvalId?: string): void {
  getDb()
    .prepare(`UPDATE quotes SET status = ?, resolved_at = ?, approval_id = COALESCE(?, approval_id) WHERE id = ?`)
    .run(status, new Date().toISOString(), approvalId ?? null, id);
}

export function getQuote(id: string): QuoteRow | undefined {
  return getDb().prepare('SELECT * FROM quotes WHERE id = ?').get(id) as QuoteRow | undefined;
}

export function getQuoteByApprovalId(approvalId: string): QuoteRow | undefined {
  return getDb().prepare('SELECT * FROM quotes WHERE approval_id = ?').get(approvalId) as QuoteRow | undefined;
}

export function listQuotes(limit = 100): QuoteRow[] {
  return getDb().prepare('SELECT * FROM quotes ORDER BY created_at DESC LIMIT ?').all(limit) as QuoteRow[];
}

/* ── conversation_events ── */

export type ConvEventType = 'msg_in' | 'msg_out' | 'reasoning' | 'quote' | 'approval' | 'followup' | 'error';
export type ConvActor = 'customer' | 'agent' | 'owner' | 'system';

export interface ConvEventRow {
  id: number;
  session_id: string;
  ts: string;
  type: string;
  actor: string | null;
  payload: string;
}

export function insertConvEvent(
  sessionId: string,
  type: ConvEventType,
  actor: ConvActor | null,
  payload: unknown,
  ts?: string,
): number {
  const res = getDb()
    .prepare('INSERT INTO conversation_events (session_id, ts, type, actor, payload) VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, ts ?? new Date().toISOString(), type, actor, JSON.stringify(payload));
  return Number(res.lastInsertRowid);
}

export function insertReasoningEvent(sessionId: string, event: ReasoningEvent): number {
  return insertConvEvent(sessionId, 'reasoning', 'system', event, event.ts);
}

/** Replay for SSE reconnect (last-event-id) and transcript endpoint. */
export function getConvEvents(sessionId: string, afterId = 0, limit = 500): ConvEventRow[] {
  return getDb()
    .prepare('SELECT * FROM conversation_events WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
    .all(sessionId, afterId, limit) as ConvEventRow[];
}

/** Firehose for the owner cockpit (all sessions). */
export function getRecentConvEvents(afterId = 0, limit = 500): ConvEventRow[] {
  return getDb()
    .prepare('SELECT * FROM conversation_events WHERE id > ? ORDER BY id ASC LIMIT ?')
    .all(afterId, limit) as ConvEventRow[];
}

/* ── web_visitors ── */

export interface WebVisitorRow {
  visitor_id: string;
  messaging_group_id: string;
  session_id: string | null;
  created_at: string;
  last_seen: string;
  message_count: number;
}

export function upsertWebVisitor(visitorId: string, messagingGroupId: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO web_visitors (visitor_id, messaging_group_id, created_at, last_seen)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (visitor_id) DO UPDATE SET last_seen = excluded.last_seen`,
    )
    .run(visitorId, messagingGroupId, now, now);
}

export function getWebVisitor(visitorId: string): WebVisitorRow | undefined {
  return getDb().prepare('SELECT * FROM web_visitors WHERE visitor_id = ?').get(visitorId) as WebVisitorRow | undefined;
}

export function setWebVisitorSession(visitorId: string, sessionId: string): void {
  getDb()
    .prepare('UPDATE web_visitors SET session_id = ?, last_seen = ? WHERE visitor_id = ?')
    .run(sessionId, new Date().toISOString(), visitorId);
}

/** Bump message count; returns the new count (for per-visitor caps). */
export function bumpWebVisitorMessages(visitorId: string): number {
  getDb()
    .prepare('UPDATE web_visitors SET message_count = message_count + 1, last_seen = ? WHERE visitor_id = ?')
    .run(new Date().toISOString(), visitorId);
  const row = getWebVisitor(visitorId);
  return row?.message_count ?? 0;
}

export function listIdleWebVisitors(idleMinutes: number): WebVisitorRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM web_visitors
       WHERE session_id IS NOT NULL
         AND last_seen < datetime('now', '-' || ? || ' minutes')`,
    )
    .all(idleMinutes) as WebVisitorRow[];
}

/* ── analytics tiles ── */

export interface AnalyticsTiles {
  quotesSent7d: number;
  autoSent7d: number;
  escalated7d: number;
  medianResponseSeconds: number | null;
  centsQuoted7d: number;
  currency: string;
}

export function getAnalyticsTiles(): AnalyticsTiles {
  const db = getDb();
  const counts = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'auto_sent' THEN 1 ELSE 0 END) AS auto_sent,
         SUM(CASE WHEN escalation_reason IS NOT NULL THEN 1 ELSE 0 END) AS escalated,
         COALESCE(SUM(CASE WHEN status IN ('auto_sent','approved') THEN total_cents ELSE 0 END), 0) AS cents,
         MAX(currency) AS currency
       FROM quotes WHERE created_at >= datetime('now', '-7 days')`,
    )
    .get() as {
    total: number;
    auto_sent: number | null;
    escalated: number | null;
    cents: number;
    currency: string | null;
  };

  // Median customer-message → agent-reply latency over mirrored events (7d).
  const deltas = db
    .prepare(
      `SELECT (julianday(o.ts) - julianday(i.ts)) * 86400.0 AS secs
       FROM conversation_events i
       JOIN conversation_events o
         ON o.session_id = i.session_id
        AND o.type = 'msg_out'
        AND o.id = (SELECT MIN(id) FROM conversation_events x
                    WHERE x.session_id = i.session_id AND x.type = 'msg_out' AND x.id > i.id)
       WHERE i.type = 'msg_in' AND i.ts >= datetime('now', '-7 days')
       ORDER BY secs`,
    )
    .all() as { secs: number }[];
  const median = deltas.length === 0 ? null : deltas[Math.floor((deltas.length - 1) / 2)].secs;

  return {
    quotesSent7d: counts.total,
    autoSent7d: counts.auto_sent ?? 0,
    escalated7d: counts.escalated ?? 0,
    medianResponseSeconds: median === null ? null : Math.round(median),
    centsQuoted7d: counts.cents,
    currency: counts.currency ?? 'SGD',
  };
}
