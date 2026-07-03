import { describe, expect, test } from 'bun:test';

import type { WriteMessageOut } from '../db/messages-out.js';
import type { HouseRules, QuoteRecord } from './contracts.js';
import {
  extractNudgeBlock,
  extractQuoteBlock,
  handleNudgeDraft,
  handleQuoteDraft,
  type DriverDeps,
  type QuoteRouting,
} from './driver.js';

const rules: HouseRules = {
  businessName: 'CoolBreeze Aircon Services',
  currency: 'SGD',
  maxAutoDiscountPct: 10,
  maxAutoTotalCents: 0,
  minRetrievalConfidence: 0,
  followUpAfterHours: 24,
};

const routing: QuoteRouting = {
  platformId: 'visitor-abc',
  channelType: 'web',
  threadId: null,
  inReplyTo: 'msg-inbound-1',
};

function makeDeps(overrides: Partial<DriverDeps> = {}) {
  const written: WriteMessageOut[] = [];
  const deps: DriverDeps = {
    loadHouseRules: () => ({ ...rules }),
    retrieval: () => ({ confidence: null }),
    renderPdf: async (_msgId: string, _r: QuoteRecord, _ru: HouseRules) => 'quote.pdf',
    writeOut: (msg: WriteMessageOut) => {
      written.push(msg);
      return written.length;
    },
    now: () => new Date('2026-07-03T10:00:00.000Z'),
    ...overrides,
  };
  return { deps, written };
}

const ON_CARD_BLOCK = `\`\`\`QUOTE_JSON
{"v":1,"customerName":"Mr. Tan","currency":"SGD","lineItems":[
  {"description":"General service, wall unit","qty":3,"unitPriceCents":4000,"rateCardRef":"RC-01"}],
 "totalCents":12000}
\`\`\``;

describe('extractQuoteBlock', () => {
  test('no block → draft null, text untouched', () => {
    const r = extractQuoteBlock('<message to="cust">Hello!</message>');
    expect(r.draft).toBeNull();
    expect(r.cleanedText).toBe('<message to="cust">Hello!</message>');
  });

  test('block inside a <message> body is extracted and stripped', () => {
    const text = `<message to="cust">Here you go!\n${ON_CARD_BLOCK}\n</message>`;
    const r = extractQuoteBlock(text);
    expect(r.draft).not.toBeNull();
    expect(r.draft!.lineItems).toHaveLength(1);
    expect(r.cleanedText).not.toContain('QUOTE_JSON');
    expect(r.cleanedText).toContain('Here you go!');
  });

  test('block outside message blocks (scratchpad) still extracted', () => {
    const r = extractQuoteBlock(`<message to="cust">One sec.</message>\n${ON_CARD_BLOCK}`);
    expect(r.draft).not.toBeNull();
  });

  test('total is RECOMPUTED — model arithmetic is not trusted', () => {
    const lying = ON_CARD_BLOCK.replace('"totalCents":12000', '"totalCents":999');
    const r = extractQuoteBlock(lying);
    expect(r.draft!.totalCents).toBe(12000);
  });

  test('discount applied in recomputation', () => {
    const withDiscount = ON_CARD_BLOCK.replace('"totalCents":12000', '"discountPct":10,"totalCents":1');
    const r = extractQuoteBlock(withDiscount);
    expect(r.draft!.totalCents).toBe(10800);
  });

  test('malformed JSON → parseError, prose still cleaned', () => {
    const r = extractQuoteBlock('hi ```QUOTE_JSON\n{oops\n``` bye');
    expect(r.draft).toBeNull();
    expect(r.parseError).toContain('invalid JSON');
    expect(r.cleanedText).not.toContain('QUOTE_JSON');
  });

  test('empty lineItems rejected', () => {
    const r = extractQuoteBlock('```QUOTE_JSON\n{"lineItems":[],"totalCents":1}\n```');
    expect(r.draft).toBeNull();
    expect(r.parseError).toContain('lineItems');
  });

  test('multiple blocks: first wins, all stripped', () => {
    const r = extractQuoteBlock(`${ON_CARD_BLOCK}\nmiddle\n${ON_CARD_BLOCK.replace('12000', '5000')}`);
    expect(r.draft!.totalCents).toBe(12000);
    expect(r.cleanedText).not.toContain('QUOTE_JSON');
    expect(r.cleanedText).toContain('middle');
  });
});

describe('handleQuoteDraft — auto-send', () => {
  test('on-card quote writes chat card + persist_quote + follow-up + reasoning', async () => {
    const { deps, written } = makeDeps();
    const { draft } = extractQuoteBlock(ON_CARD_BLOCK);
    const res = await handleQuoteDraft(draft!, routing, deps);

    expect(res.handled).toBe(true);
    expect(res.autoSent).toBe(true);

    const chat = written.filter((w) => w.kind === 'chat');
    expect(chat).toHaveLength(1);
    const content = JSON.parse(chat[0].content) as { text: string; quote: QuoteRecord; files?: string[] };
    expect(content.text).toContain('CoolBreeze');
    expect(content.text).toContain('SGD 120.00');
    expect(content.quote.status).toBe('auto_sent');
    expect(content.files).toEqual(['quote.pdf']);
    expect(chat[0].platform_id).toBe('visitor-abc');
    expect(chat[0].channel_type).toBe('web');

    const actions = written
      .filter((w) => w.kind === 'system')
      .map((w) => (JSON.parse(w.content) as { action: string }).action);
    expect(actions).toContain('persist_quote');
    expect(actions).toContain('schedule_task');
    expect(actions).toContain('reasoning_event');
    expect(actions).not.toContain('request_quote_approval');
  });

  test('follow-up task fires followUpAfterHours later with routing attached', async () => {
    const { deps, written } = makeDeps();
    const { draft } = extractQuoteBlock(ON_CARD_BLOCK);
    await handleQuoteDraft(draft!, routing, deps);
    const sched = written.find((w) => w.content.includes('"schedule_task"'))!;
    const c = JSON.parse(sched.content) as Record<string, unknown>;
    expect(c.processAfter).toBe('2026-07-04T10:00:00.000Z');
    expect(c.platformId).toBe('visitor-abc');
    expect(c.channelType).toBe('web');
    expect(String(c.prompt)).toContain('NUDGE_JSON');
  });

  test('followUpAfterHours=0 disables the follow-up', async () => {
    const { deps, written } = makeDeps({ loadHouseRules: () => ({ ...rules, followUpAfterHours: 0 }) });
    const { draft } = extractQuoteBlock(ON_CARD_BLOCK);
    await handleQuoteDraft(draft!, routing, deps);
    expect(written.some((w) => w.content.includes('"schedule_task"'))).toBe(false);
  });

  test('PDF failure does not block the quote', async () => {
    const { deps, written } = makeDeps({ renderPdf: async () => null });
    const { draft } = extractQuoteBlock(ON_CARD_BLOCK);
    const res = await handleQuoteDraft(draft!, routing, deps);
    expect(res.autoSent).toBe(true);
    const chat = written.find((w) => w.kind === 'chat')!;
    const content = JSON.parse(chat.content) as { files?: string[] };
    expect(content.files).toBeUndefined();
  });
});

describe('handleQuoteDraft — escalation', () => {
  test('15% discount → checking-with-boss message + request_quote_approval, NO quote card', async () => {
    const { deps, written } = makeDeps();
    const block = ON_CARD_BLOCK.replace('"totalCents":12000', '"discountPct":15,"totalCents":10200');
    const { draft } = extractQuoteBlock(block);
    const res = await handleQuoteDraft(draft!, routing, deps);

    expect(res.autoSent).toBe(false);

    const chat = written.filter((w) => w.kind === 'chat');
    expect(chat).toHaveLength(1);
    const content = JSON.parse(chat[0].content) as { text: string; quotePending?: { reason: string } };
    expect(content.text).toContain('check with the boss');
    expect(content.text).not.toContain('SGD'); // price never leaks pre-approval
    expect(content.quotePending?.reason).toBe('discount_exceeds_limit');

    const approval = written.find((w) => w.content.includes('request_quote_approval'))!;
    const a = JSON.parse(approval.content) as { quote: QuoteRecord; why: string };
    expect(a.quote.status).toBe('pending_approval');
    expect(a.quote.totalCents).toBe(10200);
    expect(a.why).toContain('15%');

    expect(written.some((w) => w.content.includes('"schedule_task"'))).toBe(false);
    expect(written.some((w) => w.content.includes('"persist_quote"'))).toBe(false);
  });

  test('off-card item escalates with the item named', async () => {
    const { deps, written } = makeDeps();
    const block = `\`\`\`QUOTE_JSON
{"lineItems":[{"description":"Custom ducting","qty":1,"unitPriceCents":90000}],"totalCents":90000}
\`\`\``;
    const { draft } = extractQuoteBlock(block);
    await handleQuoteDraft(draft!, routing, deps);
    const approval = written.find((w) => w.content.includes('request_quote_approval'))!;
    expect((JSON.parse(approval.content) as { why: string }).why).toContain('Custom ducting');
  });

  test('driver never throws — broken deps produce handled:false', async () => {
    const { deps } = makeDeps({
      loadHouseRules: () => {
        throw new Error('boom');
      },
    });
    const { draft } = extractQuoteBlock(ON_CARD_BLOCK);
    const res = await handleQuoteDraft(draft!, routing, deps);
    expect(res.handled).toBe(false);
  });
});

describe('nudges', () => {
  test('NUDGE_JSON extracted and always escalates', () => {
    const { deps, written } = makeDeps();
    const r = extractNudgeBlock('```NUDGE_JSON\n{"quoteId":"qt-1","text":"Hi Mr. Tan, just checking in!"}\n```');
    expect(r.nudge).not.toBeNull();
    handleNudgeDraft(r.nudge!, deps);
    const action = written.find((w) => w.content.includes('request_nudge_approval'))!;
    const c = JSON.parse(action.content) as { draftText: string; quoteId: string };
    expect(c.draftText).toContain('checking in');
    expect(c.quoteId).toBe('qt-1');
  });

  test('nudge with empty text rejected', () => {
    const r = extractNudgeBlock('```NUDGE_JSON\n{"quoteId":"qt-1","text":""}\n```');
    expect(r.nudge).toBeNull();
  });
});
