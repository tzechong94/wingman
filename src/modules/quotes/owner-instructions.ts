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

/** quoteId → ts of the last applied instruction (suppresses generic coaching). */
const recentInstructions = new Map<string, number>();

export function instructionJustApplied(quoteId: string): boolean {
  const ts = recentInstructions.get(quoteId);
  return ts !== undefined && Date.now() - ts < 60_000;
}

/** Apply a free-text owner instruction to a session (both surfaces land here). */
export function applyOwnerInstruction(session: Session, text: string, quoteId: string): void {
  recentInstructions.set(quoteId, Date.now());
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
 * If `userId` rejected something in the last 10 minutes, consume their text
 * as the binding instruction for that rejection. One-shot per rejection.
 * Called by the owner-command interceptor before command parsing.
 */
export async function consumePendingInstructionFor(userId: string, text: string): Promise<boolean> {
  const pending = recentRejections.get(userId);
  if (!pending) return false;
  if (Date.now() - pending.rejectedAt > INSTRUCTION_WINDOW_MS) {
    recentRejections.delete(userId);
    return false;
  }
  // Bare re-approvals/status asks are commands, not instructions.
  if (/^(status|pending|approve|yes|ok(ay)?)\b/i.test(text.trim())) return false;
  recentRejections.delete(userId);
  const session = getSession(pending.sessionId);
  if (!session) return false;
  applyOwnerInstruction(session, text, pending.quoteId);
  return true;
}
