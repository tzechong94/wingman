/**
 * Owner instructions after a rejection — "it should take into account my
 * text instead of just the approve and reject button."
 *
 * When an owner REJECTS an approval, we remember it for a window. If they
 * then type free text (Telegram DM, or a note attached to the dashboard
 * reject), that text becomes a binding OWNER INSTRUCTION on the session:
 * the agent is briefed, the extractor sees an owner line in the transcript
 * (via the agent-notify path), and the customer conversation resumes with
 * the owner's terms (e.g. "max 20%") instead of re-escalating the same ask.
 */
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import type { InboundEvent } from '../../channels/adapter.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/primitive.js';
import { recordConvEvent } from './actions.js';

const INSTRUCTION_WINDOW_MS = 10 * 60_000;

interface PendingInstruction {
  sessionId: string;
  quoteId: string;
  rejectedAt: number;
}

/** approver userId (`telegram:123`) → their most recent rejection. */
const recentRejections = new Map<string, PendingInstruction>();

export function rememberRejection(approverUserId: string, sessionId: string, quoteId: string): void {
  if (!approverUserId) return;
  recentRejections.set(approverUserId, { sessionId, quoteId, rejectedAt: Date.now() });
}

/** Apply a free-text owner instruction to a session (both surfaces land here). */
export function applyOwnerInstruction(session: Session, text: string, quoteId: string): void {
  recordConvEvent(session.id, 'approval', 'owner', { state: 'instruction', quoteId, text });
  notifyAgent(
    session,
    `OWNER INSTRUCTION (binding) regarding the rejected quote ${quoteId}: "${text}". ` +
      `Re-engage the customer following this instruction exactly — e.g. if the owner set a maximum discount, ` +
      `offer precisely that. Do not re-submit the customer's original ask for approval.`,
  );
  log.info('Owner instruction applied', { sessionId: session.id, quoteId, chars: text.length });
}

/**
 * Router interceptor: a DM from an approver who rejected something in the
 * last 10 minutes is an instruction, not a chat message. One-shot per
 * rejection. Returns true to consume the message.
 */
export async function ownerInstructionInterceptor(event: InboundEvent): Promise<boolean> {
  if (recentRejections.size === 0) return false;
  let senderId = '';
  let text = '';
  try {
    const content = JSON.parse(event.message.content) as { senderId?: string; text?: string };
    senderId = String(content.senderId ?? '');
    text = String(content.text ?? '').trim();
  } catch {
    return false;
  }
  if (!senderId || !text) return false;
  const userId = senderId.includes(':') ? senderId : `${event.channelType}:${senderId}`;
  const pending = recentRejections.get(userId);
  if (!pending) return false;
  if (Date.now() - pending.rejectedAt > INSTRUCTION_WINDOW_MS) {
    recentRejections.delete(userId);
    return false;
  }
  // Commands are never instructions.
  if (text.startsWith('/')) return false;

  recentRejections.delete(userId);
  const session = getSession(pending.sessionId);
  if (!session) return false;
  applyOwnerInstruction(session, text, pending.quoteId);
  return true;
}
