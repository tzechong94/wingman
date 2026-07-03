/**
 * SSE fan-out for the web channel.
 *
 * Durable truth is conversation_events (central DB); the bus feeds live
 * sockets. Reconnects replay via Last-Event-ID (the conversation_events
 * rowid). Sockets are tracked and destroyed on shutdown — a bare
 * server.close() would hang forever on open SSE connections.
 */
import type http from 'http';

import { getConvEvents, getRecentConvEvents, type ConvEventRow } from '../../db/quotes.js';
import { log } from '../../log.js';
import { subscribeConvEvents } from '../../modules/quotes/bus.js';
import { onShutdown } from '../../response-registry.js';

const HEARTBEAT_MS = 25_000;

interface SseClient {
  res: http.ServerResponse;
  /** Session filter; null = owner firehose (all sessions). */
  sessionId: string | null;
}

const clients = new Set<SseClient>();
let wired = false;

function writeEvent(client: SseClient, event: ConvEventRow): void {
  try {
    client.res.write(`id: ${event.id}\nevent: conv\ndata: ${JSON.stringify(event)}\n\n`);
  } catch {
    clients.delete(client);
  }
}

function ensureWired(): void {
  if (wired) return;
  wired = true;
  subscribeConvEvents((event) => {
    for (const client of clients) {
      if (client.sessionId === null || client.sessionId === event.session_id) {
        writeEvent(client, event);
      }
    }
  });
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      try {
        client.res.write(`: hb\n\n`);
      } catch {
        clients.delete(client);
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  onShutdown(() => {
    for (const client of clients) {
      try {
        client.res.end();
        client.res.destroy();
      } catch {
        /* already gone */
      }
    }
    clients.clear();
  });
}

/** Attach an SSE stream to this response. Replays missed events, then goes live. */
export function attachSse(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string | null): void {
  ensureWired();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const lastIdRaw = req.headers['last-event-id'];
  const lastId = typeof lastIdRaw === 'string' ? parseInt(lastIdRaw, 10) || 0 : 0;
  const client: SseClient = { res, sessionId };

  const replay = sessionId === null ? getRecentConvEvents(lastId) : getConvEvents(sessionId, lastId);
  for (const event of replay) writeEvent(client, event);

  clients.add(client);
  req.on('close', () => {
    clients.delete(client);
  });
  log.debug('SSE client attached', { sessionId, replayed: replay.length, clients: clients.size });
}

export function sseClientCount(): number {
  return clients.size;
}
