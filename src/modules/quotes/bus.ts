/**
 * In-process event bus for conversation_events.
 *
 * Writers: the quotes module (reasoning/quote/approval events) and the web
 * channel (msg_in/msg_out mirrors). Reader: the web channel's SSE fan-out.
 * Lives in its own file so neither side imports the other (no cycles).
 *
 * Durable truth is the conversation_events table — the bus only exists so
 * SSE clients don't poll. A subscriber that missed events replays from the
 * table via last-event-id.
 */
import type { ConvEventRow } from '../../db/quotes.js';

export type BusListener = (event: ConvEventRow) => void;

const listeners = new Set<BusListener>();

export function subscribeConvEvents(listener: BusListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishConvEvent(event: ConvEventRow): void {
  for (const l of listeners) {
    try {
      l(event);
    } catch {
      /* one bad SSE socket must not affect the rest */
    }
  }
}
