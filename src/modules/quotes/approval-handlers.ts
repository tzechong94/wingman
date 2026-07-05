/**
 * Approval outcomes for quotes and nudges.
 *
 * THE MODEL IS OUT OF THE CRITICAL PATH: on approve, the HOST delivers the
 * quote/nudge directly to the customer via the delivery adapter — the agent
 * is notified for context only. On reject, the agent is asked to re-draft
 * at the house limit (that re-draft goes through the normal driver gate).
 */
import { setQuoteStatus } from '../../db/quotes.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import {
  notifyAgent,
  registerApprovalHandler,
  registerApprovalResolvedHandler,
  type ApprovalHandlerContext,
} from '../approvals/primitive.js';
import { recordConvEvent } from './actions.js';
import { rememberRejection } from './owner-instructions.js';
import { fmtCents, type QuoteRecord } from './contracts.js';

/** Resolve the customer-facing routing for a session's origin chat. */
function customerRouting(session: Session) {
  const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  if (!mg) return null;
  return { channelType: mg.channel_type, platformId: mg.platform_id, instance: mg.instance };
}

async function deliverToCustomer(session: Session, content: Record<string, unknown>): Promise<void> {
  const routing = customerRouting(session);
  const adapter = getDeliveryAdapter();
  if (!routing || !adapter) {
    throw new Error(`cannot deliver to customer: ${!routing ? 'no origin messaging group' : 'no delivery adapter'}`);
  }
  await adapter.deliver(
    routing.channelType,
    routing.platformId,
    null,
    'chat',
    JSON.stringify(content),
    undefined,
    routing.instance,
  );
  // The web adapter mirrors deliveries itself — recording here too produced
  // duplicate bubbles. Only mirror for channels that don't self-mirror.
  if (routing.channelType !== 'web') {
    recordConvEvent(session.id, 'msg_out', 'agent', content);
  }
}

function formatApprovedQuoteText(quote: QuoteRecord): string {
  const lines = quote.lineItems.map(
    (li) => `• ${li.description} — ${li.qty} × ${fmtCents(li.unitPriceCents, quote.currency)}`,
  );
  const discount = quote.discountPct && quote.discountPct > 0 ? `\nDiscount: ${quote.discountPct}% ✅` : '';
  return (
    `Good news — the boss approved! 🎉\n\n📋 Your quote:\n\n` +
    lines.join('\n') +
    discount +
    `\n\nTotal: ${fmtCents(quote.totalCents, quote.currency)}` +
    (quote.notes ? `\n${quote.notes}` : '') +
    `\n\nValid for 14 days. Reply here to confirm a booking!`
  );
}

async function onQuoteApproved(ctx: ApprovalHandlerContext): Promise<void> {
  const quote = ctx.payload.quote as QuoteRecord;
  await deliverToCustomer(ctx.session, {
    text: formatApprovedQuoteText(quote),
    quote: { ...quote, status: 'approved' },
  });
  setQuoteStatus(quote.id, 'approved');
  recordConvEvent(ctx.session.id, 'approval', 'owner', {
    state: 'approved',
    quoteId: quote.id,
    by: ctx.userId,
  });
  notifyAgent(
    ctx.session,
    `Owner approved quote ${quote.id} (${fmtCents(quote.totalCents, quote.currency)}); it has been sent to the customer. No action needed.`,
  );
  log.info('Approved quote delivered to customer', { quoteId: quote.id, by: ctx.userId });
}

async function onNudgeApproved(ctx: ApprovalHandlerContext): Promise<void> {
  const draftText = ctx.payload.draftText as string;
  const quoteId = (ctx.payload.quoteId as string) || '';
  await deliverToCustomer(ctx.session, { text: draftText });
  recordConvEvent(ctx.session.id, 'followup', 'owner', { state: 'sent', quoteId, by: ctx.userId });
  notifyAgent(
    ctx.session,
    `Owner approved the follow-up nudge for quote ${quoteId}; it has been sent. No action needed.`,
  );
  log.info('Approved nudge delivered to customer', { quoteId, by: ctx.userId });
}

registerApprovalHandler('send_quote', onQuoteApproved);
registerApprovalHandler('send_nudge', onNudgeApproved);

/** Rejections: mark status, tell the customer we'll revert, coach the agent to re-draft. */
registerApprovalResolvedHandler(async ({ approval, session, outcome, userId }) => {
  if (outcome !== 'reject') return;
  if (approval.action === 'send_quote') {
    const payload = JSON.parse(approval.payload || '{}') as { quote?: QuoteRecord };
    const quote = payload.quote;
    if (!quote) return;
    setQuoteStatus(quote.id, 'rejected');
    recordConvEvent(session.id, 'approval', 'owner', { state: 'rejected', quoteId: quote.id, by: userId });
    // The owner's next free-text message (Telegram DM or dashboard note)
    // becomes a binding instruction for this rejection.
    rememberRejection(userId, session.id, quote.id);
    try {
      await deliverToCustomer(session, {
        text: `Thanks for waiting! We can't do that exact arrangement, but let me put together our best alternative for you — one moment.`,
      });
    } catch (err) {
      log.warn('Could not notify customer of rejection', { quoteId: quote.id, err });
    }
    notifyAgent(
      session,
      `Owner REJECTED quote ${quote.id}${quote.discountPct ? ` (${quote.discountPct}% discount asked)` : ''}. ` +
        `The customer's original ask is DECLINED — never re-submit it. Unless the owner sends a follow-up ` +
        `instruction with different terms, re-offer at the house-rules limit.`,
    );
  } else if (approval.action === 'send_nudge') {
    const payload = JSON.parse(approval.payload || '{}') as { quoteId?: string };
    recordConvEvent(session.id, 'followup', 'owner', {
      state: 'rejected',
      quoteId: payload.quoteId ?? '',
      by: userId,
    });
    notifyAgent(
      session,
      `Owner declined the follow-up nudge. Do not contact the customer about it again unless they reply.`,
    );
  }
});
