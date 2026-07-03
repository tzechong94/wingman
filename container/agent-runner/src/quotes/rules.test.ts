import { describe, expect, test } from 'bun:test';

import type { HouseRules, QuoteDraft } from './contracts.js';
import { DEFAULT_HOUSE_RULES, evaluateQuote, parseHouseRules } from './rules.js';

const rules: HouseRules = {
  businessName: 'CoolBreeze Aircon Services',
  currency: 'SGD',
  maxAutoDiscountPct: 10,
  maxAutoTotalCents: 50_000, // SGD 500
  minRetrievalConfidence: 0.5,
  followUpAfterHours: 24,
};

function draft(overrides: Partial<QuoteDraft> = {}): QuoteDraft {
  return {
    v: 1,
    customerName: 'Mr. Tan',
    lineItems: [
      { description: 'General service, wall-mounted unit', qty: 3, unitPriceCents: 4_000, rateCardRef: 'RC-01' },
    ],
    totalCents: 12_000,
    currency: 'SGD',
    ...overrides,
  };
}

describe('evaluateQuote — auto-send path', () => {
  test('on-card quote with no discount auto-sends', () => {
    const d = evaluateQuote(draft(), rules, { confidence: 0.9 });
    expect(d.autoSend).toBe(true);
    expect(d.reason).toBeUndefined();
  });

  test('discount exactly AT the house limit auto-sends (limit is inclusive)', () => {
    const d = evaluateQuote(draft({ discountPct: 10, totalCents: 10_800 }), rules, { confidence: 0.9 });
    expect(d.autoSend).toBe(true);
    expect(d.details).toContain('10%');
  });

  test('total exactly AT maxAutoTotalCents auto-sends', () => {
    const d = evaluateQuote(draft({ totalCents: 50_000 }), rules, { confidence: 0.9 });
    expect(d.autoSend).toBe(true);
  });

  test('confidence exactly AT threshold auto-sends', () => {
    const d = evaluateQuote(draft(), rules, { confidence: 0.5 });
    expect(d.autoSend).toBe(true);
  });

  test('null confidence (scores unavailable) never triggers low_confidence', () => {
    const d = evaluateQuote(draft(), rules, { confidence: null });
    expect(d.autoSend).toBe(true);
  });

  test('zero-discount draft with undefined discountPct auto-sends', () => {
    const d = evaluateQuote(draft({ discountPct: undefined }), rules, { confidence: 1 });
    expect(d.autoSend).toBe(true);
  });
});

describe('evaluateQuote — escalation paths', () => {
  test('discount above limit escalates with discount_exceeds_limit', () => {
    const d = evaluateQuote(draft({ discountPct: 15 }), rules, { confidence: 0.9 });
    expect(d.autoSend).toBe(false);
    expect(d.reason).toBe('discount_exceeds_limit');
    expect(d.details).toContain('15%');
    expect(d.details).toContain('10%');
  });

  test('discount 10.01% (just over) escalates', () => {
    const d = evaluateQuote(draft({ discountPct: 10.01 }), rules, { confidence: 0.9 });
    expect(d.autoSend).toBe(false);
    expect(d.reason).toBe('discount_exceeds_limit');
  });

  test('any off-card line item escalates and names the item', () => {
    const d = evaluateQuote(
      draft({
        lineItems: [
          { description: 'General service', qty: 1, unitPriceCents: 4_000, rateCardRef: 'RC-01' },
          { description: 'Custom ducting for server room', qty: 1, unitPriceCents: 90_000 },
        ],
      }),
      rules,
      { confidence: 0.9 },
    );
    expect(d.autoSend).toBe(false);
    expect(d.reason).toBe('off_card');
    expect(d.details).toContain('Custom ducting');
    expect(d.details).not.toContain('General service');
  });

  test('whitespace-only rateCardRef counts as off-card', () => {
    const d = evaluateQuote(
      draft({ lineItems: [{ description: 'Chemical wash', qty: 1, unitPriceCents: 8_000, rateCardRef: '  ' }] }),
      rules,
      { confidence: 0.9 },
    );
    expect(d.reason).toBe('off_card');
  });

  test('total above maxAutoTotalCents escalates', () => {
    const d = evaluateQuote(draft({ totalCents: 50_001 }), rules, { confidence: 0.9 });
    expect(d.autoSend).toBe(false);
    expect(d.reason).toBe('total_exceeds_limit');
    expect(d.details).toContain('SGD 500.01');
  });

  test('maxAutoTotalCents=0 disables the total check', () => {
    const d = evaluateQuote(draft({ totalCents: 9_999_999 }), { ...rules, maxAutoTotalCents: 0 }, { confidence: 0.9 });
    expect(d.autoSend).toBe(true);
  });

  test('confidence below threshold escalates with low_confidence', () => {
    const d = evaluateQuote(draft(), rules, { confidence: 0.49 });
    expect(d.autoSend).toBe(false);
    expect(d.reason).toBe('low_confidence');
    expect(d.details).toContain('0.49');
  });

  test('minRetrievalConfidence=0 disables the confidence check', () => {
    const d = evaluateQuote(draft(), { ...rules, minRetrievalConfidence: 0 }, { confidence: 0.01 });
    expect(d.autoSend).toBe(true);
  });
});

describe('evaluateQuote — rule precedence (first match wins, most explainable first)', () => {
  test('discount beats off_card when both fire', () => {
    const d = evaluateQuote(
      draft({ discountPct: 20, lineItems: [{ description: 'Mystery job', qty: 1, unitPriceCents: 1_000 }] }),
      rules,
      { confidence: 0.1 },
    );
    expect(d.reason).toBe('discount_exceeds_limit');
  });

  test('off_card beats total and confidence', () => {
    const d = evaluateQuote(
      draft({ totalCents: 99_999, lineItems: [{ description: 'Mystery job', qty: 1, unitPriceCents: 99_999 }] }),
      rules,
      { confidence: 0.1 },
    );
    expect(d.reason).toBe('off_card');
  });

  test('total beats confidence', () => {
    const d = evaluateQuote(draft({ totalCents: 60_000 }), rules, { confidence: 0.1 });
    expect(d.reason).toBe('total_exceeds_limit');
  });
});

describe('parseHouseRules', () => {
  test('full file parses', () => {
    const r = parseHouseRules(JSON.stringify(rules));
    expect(r).toEqual(rules);
  });

  test('invalid JSON falls back to defaults', () => {
    expect(parseHouseRules('not json {')).toEqual(DEFAULT_HOUSE_RULES);
  });

  test('partial file fills gaps with defaults', () => {
    const r = parseHouseRules(JSON.stringify({ businessName: 'CoolBreeze', maxAutoDiscountPct: 5 }));
    expect(r.businessName).toBe('CoolBreeze');
    expect(r.maxAutoDiscountPct).toBe(5);
    expect(r.followUpAfterHours).toBe(DEFAULT_HOUSE_RULES.followUpAfterHours);
    expect(r.currency).toBe(DEFAULT_HOUSE_RULES.currency);
  });

  test('negative and non-numeric values are rejected to defaults', () => {
    const r = parseHouseRules(JSON.stringify({ maxAutoDiscountPct: -5, minRetrievalConfidence: 'high' }));
    expect(r.maxAutoDiscountPct).toBe(DEFAULT_HOUSE_RULES.maxAutoDiscountPct);
    expect(r.minRetrievalConfidence).toBe(DEFAULT_HOUSE_RULES.minRetrievalConfidence);
  });
});
