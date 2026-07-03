/**
 * Deterministic quote gate. The LLM drafts; THIS decides.
 *
 *   QuoteDraft ──▶ evaluateQuote ──▶ { autoSend: true }                     → send now, audit
 *                       │
 *                       ├─ discountPct > maxAutoDiscountPct  → escalate 'discount_exceeds_limit'
 *                       ├─ any line item missing rateCardRef → escalate 'off_card'
 *                       ├─ totalCents > maxAutoTotalCents(>0)→ escalate 'total_exceeds_limit'
 *                       └─ confidence < minRetrievalConfidence(>0, score present)
 *                                                            → escalate 'low_confidence'
 *
 * Security property: a customer cannot talk the agent past these rules,
 * because the rules are not prompts. First matching rule wins (most
 * explainable ordering: explicit ask > grounding > size > fuzziness).
 */
import {
  fmtCents,
  hasOffCardItems,
  type HouseRules,
  type QuoteDraft,
  type RetrievalInfo,
  type RuleDecision,
} from './contracts.js';

export function evaluateQuote(
  draft: QuoteDraft,
  rules: HouseRules,
  retrieval: RetrievalInfo,
): RuleDecision {
  const discount = draft.discountPct ?? 0;
  if (discount > rules.maxAutoDiscountPct) {
    return {
      autoSend: false,
      reason: 'discount_exceeds_limit',
      details: `${discount}% discount requested — house limit for auto-send is ${rules.maxAutoDiscountPct}%`,
    };
  }

  if (hasOffCardItems(draft.lineItems)) {
    const offCard = draft.lineItems.filter((li) => !li.rateCardRef || !li.rateCardRef.trim());
    return {
      autoSend: false,
      reason: 'off_card',
      details: `Not on the rate card: ${offCard.map((li) => li.description).join('; ')}`,
    };
  }

  if (rules.maxAutoTotalCents > 0 && draft.totalCents > rules.maxAutoTotalCents) {
    return {
      autoSend: false,
      reason: 'total_exceeds_limit',
      details: `Quote total ${fmtCents(draft.totalCents, draft.currency)} exceeds the ${fmtCents(rules.maxAutoTotalCents, rules.currency)} auto-send limit`,
    };
  }

  if (
    rules.minRetrievalConfidence > 0 &&
    retrieval.confidence !== null &&
    retrieval.confidence < rules.minRetrievalConfidence
  ) {
    return {
      autoSend: false,
      reason: 'low_confidence',
      details: `Rate-card match confidence ${retrieval.confidence.toFixed(2)} below the ${rules.minRetrievalConfidence.toFixed(2)} threshold`,
    };
  }

  return {
    autoSend: true,
    details:
      discount > 0
        ? `All items on rate card; ${discount}% discount within the ${rules.maxAutoDiscountPct}% house limit`
        : 'All items on rate card, within house limits',
  };
}

export { fmtCents };

export const DEFAULT_HOUSE_RULES: HouseRules = {
  businessName: 'Wingman Demo Business',
  currency: 'SGD',
  maxAutoDiscountPct: 10,
  maxAutoTotalCents: 0,
  minRetrievalConfidence: 0,
  followUpAfterHours: 24,
};

/** Parse house-rules.json content, tolerating partial files (defaults fill gaps). */
export function parseHouseRules(raw: string): HouseRules {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ...DEFAULT_HOUSE_RULES };
  }
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
  const str = (v: unknown, fallback: string): string =>
    typeof v === 'string' && v.trim() ? v : fallback;
  return {
    businessName: str(obj.businessName, DEFAULT_HOUSE_RULES.businessName),
    currency: str(obj.currency, DEFAULT_HOUSE_RULES.currency),
    maxAutoDiscountPct: num(obj.maxAutoDiscountPct, DEFAULT_HOUSE_RULES.maxAutoDiscountPct),
    maxAutoTotalCents: num(obj.maxAutoTotalCents, DEFAULT_HOUSE_RULES.maxAutoTotalCents),
    minRetrievalConfidence: num(obj.minRetrievalConfidence, DEFAULT_HOUSE_RULES.minRetrievalConfidence),
    followUpAfterHours: num(obj.followUpAfterHours, DEFAULT_HOUSE_RULES.followUpAfterHours),
  };
}
