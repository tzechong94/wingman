import { describe, expect, test } from 'bun:test';

import { parseRateCard, resolveFlatItems } from './extractor.js';

const CARD_MD = `| Ref   | Service                                        | Price (SGD) |
|-------|------------------------------------------------|-------------|
| RC-01 | General service — wall-mounted unit            | 40.00       |
| RC-07 | Leak troubleshooting & repair (per unit)       | 100.00      |`;

describe('parseRateCard', () => {
  test('parses refs, descriptions, prices in cents', () => {
    const card = parseRateCard(CARD_MD);
    expect(card.get('RC-07')!.priceCents).toBe(10000);
    expect(card.get('RC-01')!.description).toContain('General service');
    expect(card.size).toBe(2);
  });
});

describe('resolveFlatItems', () => {
  const card = parseRateCard(CARD_MD);

  test('on-card items priced from the card, never the model', () => {
    const items = resolveFlatItems('RC-07 x1; RC-01 x3', '', card);
    expect(items).not.toBeTypeOf('string');
    const li = items as Array<{ unitPriceCents: number; qty: number; rateCardRef?: string }>;
    expect(li).toHaveLength(2);
    expect(li[0].unitPriceCents).toBe(10000);
    expect(li[1].qty).toBe(3);
    expect(li[1].rateCardRef).toBe('RC-01');
  });

  test('off-card items parsed with estimate, no ref (→ escalation)', () => {
    const items = resolveFlatItems('', 'custom ducting for server room @ 900 x1', card);
    const li = items as Array<{ unitPriceCents: number; rateCardRef?: string }>;
    expect(li[0].unitPriceCents).toBe(90000);
    expect(li[0].rateCardRef).toBeUndefined();
  });

  test('qty defaults to 1; unknown ref is an error string', () => {
    const ok = resolveFlatItems('RC-07', '', card) as Array<{ qty: number }>;
    expect(ok[0].qty).toBe(1);
    expect(resolveFlatItems('RC-99 x1', '', card)).toContain('unknown rate-card ref');
  });

  test('empty everything is an error', () => {
    expect(resolveFlatItems('', '', card)).toBe('no items resolved');
  });
});
