import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import {
  bumpWebVisitorMessages,
  getAnalyticsTiles,
  getConvEvents,
  getQuote,
  getWebVisitor,
  insertQuote,
  listIdleWebVisitors,
  setQuoteStatus,
  setWebVisitorSession,
  upsertWebVisitor,
} from '../../db/quotes.js';
import { getDeliveryAction } from '../../delivery.js';
import type { Session } from '../../types.js';
import { getApprovalHandler } from '../approvals/primitive.js';
import { recordConvEvent } from './actions.js';
import { subscribeConvEvents } from './bus.js';
import type { QuoteRecord } from './contracts.js';
import './index.js'; // side-effect: registrations

function makeQuote(overrides: Partial<QuoteRecord> = {}): QuoteRecord {
  return {
    id: `qt-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 'sess-1',
    customerName: 'Mr. Tan',
    status: 'auto_sent',
    lineItems: [{ description: 'General service', qty: 3, unitPriceCents: 4000, rateCardRef: 'RC-01' }],
    discountPct: null,
    totalCents: 12000,
    currency: 'SGD',
    escalationReason: null,
    escalationDetails: null,
    confidence: null,
    notes: null,
    pdfFile: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const session = { id: 'sess-1', agent_group_id: 'ag-1', messaging_group_id: 'mg-1' } as unknown as Session;

beforeEach(() => {
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
});

describe('registrations', () => {
  it('all four delivery actions are registered', () => {
    for (const action of ['persist_quote', 'reasoning_event', 'request_quote_approval', 'request_nudge_approval']) {
      expect(getDeliveryAction(action), action).toBeTypeOf('function');
    }
  });

  it('approval handlers for send_quote and send_nudge are registered', () => {
    expect(getApprovalHandler('send_quote')).toBeTypeOf('function');
    expect(getApprovalHandler('send_nudge')).toBeTypeOf('function');
  });
});

describe('persist_quote delivery action', () => {
  it('stamps the session id, persists, and mirrors a conversation event', async () => {
    const quote = makeQuote({ sessionId: '' });
    await getDeliveryAction('persist_quote')!({ action: 'persist_quote', quote }, session, null as never);

    const row = getQuote(quote.id)!;
    expect(row.session_id).toBe('sess-1');
    expect(row.status).toBe('auto_sent');
    expect(JSON.parse(row.line_items)).toHaveLength(1);

    const events = getConvEvents('sess-1');
    expect(events.some((e) => e.type === 'quote')).toBe(true);
  });
});

describe('reasoning_event delivery action', () => {
  it('mirrors into conversation_events and publishes to the bus', async () => {
    const seen: string[] = [];
    const unsub = subscribeConvEvents((e) => seen.push(e.type));
    await getDeliveryAction('reasoning_event')!(
      { action: 'reasoning_event', event: { ts: new Date().toISOString(), type: 'rule', summary: 'auto' } },
      session,
      null as never,
    );
    unsub();
    expect(seen).toContain('reasoning');
    const events = getConvEvents('sess-1');
    expect(events.filter((e) => e.type === 'reasoning')).toHaveLength(1);
    expect(JSON.parse(events[0].payload).summary).toBe('auto');
  });

  it('a throwing subscriber does not break others', () => {
    const seen: number[] = [];
    const u1 = subscribeConvEvents(() => {
      throw new Error('bad socket');
    });
    const u2 = subscribeConvEvents((e) => seen.push(e.id));
    recordConvEvent('sess-1', 'msg_in', 'customer', { text: 'hi' });
    u1();
    u2();
    expect(seen).toHaveLength(1);
  });
});

describe('request_quote_approval delivery action', () => {
  it('persists the pending quote even when no approver is configured', async () => {
    const quote = makeQuote({ sessionId: '', status: 'pending_approval', escalationReason: 'discount_exceeds_limit' });
    // No users/roles seeded → requestApproval takes the "no approver" path; the
    // quote row and mirror must still land (the dashboard shows it either way).
    await getDeliveryAction('request_quote_approval')!(
      { action: 'request_quote_approval', quote, why: '15% > 10% limit' },
      session,
      null as never,
    );
    const row = getQuote(quote.id)!;
    expect(row.status).toBe('pending_approval');
    const events = getConvEvents('sess-1');
    expect(events.some((e) => e.type === 'approval' && JSON.parse(e.payload).state === 'requested')).toBe(true);
  });
});

describe('quote status + analytics', () => {
  it('setQuoteStatus transitions and stamps resolved_at', () => {
    const q = makeQuote({ status: 'pending_approval' });
    insertQuote(q);
    setQuoteStatus(q.id, 'approved');
    const row = getQuote(q.id)!;
    expect(row.status).toBe('approved');
    expect(row.resolved_at).toBeTruthy();
  });

  it('analytics tiles aggregate the last 7 days', () => {
    insertQuote(makeQuote({ totalCents: 10000 }));
    insertQuote(makeQuote({ totalCents: 5000, status: 'pending_approval', escalationReason: 'off_card' }));
    const old = makeQuote({ totalCents: 99999, createdAt: '2020-01-01T00:00:00.000Z' });
    insertQuote(old);

    const t = getAnalyticsTiles();
    expect(t.quotesSent7d).toBe(2);
    expect(t.autoSent7d).toBe(1);
    expect(t.escalated7d).toBe(1);
    expect(t.centsQuoted7d).toBe(10000); // pending quotes don't count as quoted-out money
    expect(t.medianResponseSeconds).toBeNull(); // no msg events yet
  });

  it('median response time computed from mirrored msg events', () => {
    recordConvEvent('sess-1', 'msg_in', 'customer', { text: 'hi' }, '2026-07-04T10:00:00.000Z');
    recordConvEvent('sess-1', 'msg_out', 'agent', { text: 'hello!' }, '2026-07-04T10:00:20.000Z');
    const t = getAnalyticsTiles();
    expect(t.medianResponseSeconds).toBe(20);
  });
});

describe('web_visitors', () => {
  it('upsert + session + message cap counting + idle listing', () => {
    upsertWebVisitor('v-1', 'mg-web-1');
    setWebVisitorSession('v-1', 'sess-9');
    expect(getWebVisitor('v-1')!.session_id).toBe('sess-9');
    expect(bumpWebVisitorMessages('v-1')).toBe(1);
    expect(bumpWebVisitorMessages('v-1')).toBe(2);
    // fresh visitor is not idle
    expect(listIdleWebVisitors(30)).toHaveLength(0);
  });
});
