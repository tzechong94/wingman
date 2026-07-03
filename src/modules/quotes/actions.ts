/**
 * Delivery-action handlers for the Wingman quote pipeline.
 *
 * The container's quote driver writes `kind='system'` rows; these handlers
 * apply them host-side: persist to the central DB (the dashboard's single
 * query surface), publish to the SSE bus, and route escalations through the
 * approvals primitive.
 *
 *   persist_quote          → quotes + conversation_events (auto-sent audit)
 *   reasoning_event        → conversation_events (glass cockpit feed)
 *   request_quote_approval → quotes(pending) + requestApproval('send_quote')
 *   request_nudge_approval → requestApproval('send_nudge')
 */
import type Database from 'better-sqlite3';

import { getConvEvents, insertConvEvent, insertQuote, type ConvActor, type ConvEventType } from '../../db/quotes.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { requestApproval } from '../approvals/primitive.js';
import { publishConvEvent } from './bus.js';
import { fmtCents, type QuoteRecord, type ReasoningEvent } from './contracts.js';

/** Insert a conversation event AND publish it to live SSE subscribers. */
export function recordConvEvent(
  sessionId: string,
  type: ConvEventType,
  actor: ConvActor | null,
  payload: unknown,
  ts?: string,
): void {
  const id = insertConvEvent(sessionId, type, actor, payload, ts);
  publishConvEvent({
    id,
    session_id: sessionId,
    ts: ts ?? new Date().toISOString(),
    type,
    actor,
    payload: JSON.stringify(payload),
  });
}

function stampSession(quote: QuoteRecord, session: Session): QuoteRecord {
  return { ...quote, sessionId: session.id };
}

export async function handlePersistQuote(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const quote = stampSession(content.quote as QuoteRecord, session);
  insertQuote(quote);
  recordConvEvent(session.id, 'quote', 'agent', quote, quote.createdAt);
  log.info('Quote persisted', { quoteId: quote.id, status: quote.status, totalCents: quote.totalCents });
}

export async function handleReasoningEvent(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const event = content.event as ReasoningEvent;
  recordConvEvent(session.id, 'reasoning', 'system', event, event.ts);
}

export async function handleRequestQuoteApproval(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const quote = stampSession(content.quote as QuoteRecord, session);
  const why = (content.why as string) || 'Outside house rules';

  insertQuote(quote);
  recordConvEvent(session.id, 'quote', 'agent', quote, quote.createdAt);
  recordConvEvent(session.id, 'approval', 'system', {
    state: 'requested',
    quoteId: quote.id,
    why,
  });

  const items = quote.lineItems.map((li) => `• ${li.description} ×${li.qty}`).join('\n');
  try {
    await requestApproval({
      session,
      agentName: 'Wingman',
      action: 'send_quote',
      payload: { quote: quote as unknown, why },
      title: `Quote needs you — ${fmtCents(quote.totalCents, quote.currency)}`,
      question:
        `${quote.customerName ? `Customer: ${quote.customerName}\n` : ''}` +
        `${items}\n` +
        `${quote.discountPct ? `Discount asked: ${quote.discountPct}%\n` : ''}` +
        `Total: ${fmtCents(quote.totalCents, quote.currency)}\n\n` +
        `Why this needs you: ${why}`,
    });
    // eslint-disable-next-line no-catch-all/no-catch-all -- approval-card delivery failing (no approver / no DM) is permanent for this message; the quote is persisted and resolvable from the dashboard, so retrying the whole action would only duplicate rows
  } catch (err) {
    log.error('Approval card delivery failed — quote remains pending on the dashboard', {
      quoteId: quote.id,
      err,
    });
  }
  log.info('Quote approval requested', { quoteId: quote.id, why });
}

export async function handleRequestNudgeApproval(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const quoteId = (content.quoteId as string) || '';
  const draftText = (content.draftText as string) || '';
  const why = (content.why as string) || 'Unsolicited follow-up to a customer';
  if (!draftText.trim()) {
    log.warn('request_nudge_approval with empty draft — dropped', { quoteId });
    return;
  }

  recordConvEvent(session.id, 'followup', 'system', { state: 'requested', quoteId, draftText });

  try {
    await requestApproval({
      session,
      agentName: 'Wingman',
      action: 'send_nudge',
      payload: { quoteId, draftText },
      title: 'Follow-up nudge needs you',
      question: `The customer hasn't replied since the quote went out. Send this follow-up?\n\n"${draftText}"`,
    });
    // eslint-disable-next-line no-catch-all/no-catch-all -- same permanent-failure reasoning as send_quote above
  } catch (err) {
    log.error('Nudge approval card delivery failed — pending on the dashboard only', { quoteId, err });
  }
  log.info('Nudge approval requested', { quoteId });
}

/** Transcript replay used by the web channel (kept here so web/ stays adapter-only). */
export function replayConvEvents(sessionId: string, afterId: number) {
  return getConvEvents(sessionId, afterId);
}
