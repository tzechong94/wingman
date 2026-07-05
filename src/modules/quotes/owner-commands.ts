/**
 * Owner command channel — the boss texts the bot in natural language and
 * things happen. Any DM from a user holding an owner/admin role is
 * intercepted before normal routing and treated as a command:
 *
 *   "status" / "what's pending?"       → pending approvals + today's numbers
 *   "approve" / "approve the last one" → resolve the newest pending approval
 *   "reject, max 15%"                  → reject newest + binding instruction
 *   "tell mrs lim we're running late"  → barge-in reply to that customer
 *   (within 10min of a reject, plain text stays an instruction — unchanged)
 *
 * Deterministic-first parsing; a temperature-0 qwen-turbo classification
 * handles free-form phrasing (the fork's standard extraction pattern). The
 * ACTIONS are always deterministic dispatches — the classifier only picks
 * which one.
 */
import { getSession, getPendingApprovalsByAction, getPendingApproval } from '../../db/sessions.js';
import { getAnalyticsTiles, listQuotes, getRecentConvEvents } from '../../db/quotes.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import type { InboundEvent } from '../../channels/adapter.js';
import { getUserRoles } from '../permissions/db/user-roles.js';
import { fmtCents } from './contracts.js';

const CLASSIFY_MODEL = process.env.QWEN_EXTRACT_MODEL || 'qwen-turbo';

interface OwnerCommand {
  action: 'status' | 'approve_last' | 'reject_last' | 'message_customer' | 'none';
  note: string | null;
  customer: string | null;
  message: string | null;
}

function isPrivileged(userId: string): boolean {
  try {
    return getUserRoles(userId).some((r) => r.role === 'owner' || r.role === 'admin');
  } catch {
    return false;
  }
}

function pendingApprovals() {
  return [...getPendingApprovalsByAction('send_quote'), ...getPendingApprovalsByAction('send_nudge')]
    .filter((a) => a.status === 'pending')
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/* ── deterministic-first parse, LLM fallback ── */

function quickParse(text: string): OwnerCommand | null {
  const t = text.trim().toLowerCase();
  if (/^(status|pending|report|dashboard|numbers|summary)\b/.test(t) || /what'?s (pending|up|new|happening)/.test(t)) {
    return { action: 'status', note: null, customer: null, message: null };
  }
  if (/^(approve|yes|ok(ay)?|confirm|lgtm|✅|👍)\b/.test(t) && t.length < 40) {
    return { action: 'approve_last', note: null, customer: null, message: null };
  }
  const rej = t.match(/^(reject|no|deny|decline|❌)\b[,:.\s]*(.*)$/);
  if (rej && t.length < 120) {
    return { action: 'reject_last', note: rej[2]?.trim() || null, customer: null, message: null };
  }
  return null;
}

async function classify(text: string): Promise<OwnerCommand> {
  const env = readEnvFile(['DASHSCOPE_API_KEY', 'DASHSCOPE_BASE_URL', 'OPENAI_BASE_URL']);
  const key = process.env.DASHSCOPE_API_KEY || env.DASHSCOPE_API_KEY;
  const base = process.env.OPENAI_BASE_URL || process.env.DASHSCOPE_BASE_URL || env.DASHSCOPE_BASE_URL;
  if (!key || !base) return { action: 'none', note: null, customer: null, message: null };
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: CLASSIFY_MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              "You classify a BUSINESS OWNER's text message to their AI assistant. Reply STRICT flat JSON: " +
              '{"action":"status"|"approve_last"|"reject_last"|"message_customer"|"none","note":string|null,"customer":string|null,"message":string|null}. ' +
              'status = asking what is pending / how business is going. ' +
              'approve_last / reject_last = ruling on the most recent approval request; put any conditions in "note" (e.g. "max 15%"). ' +
              'message_customer = wants a message relayed to a customer: "customer" = the name/identifier mentioned, "message" = what to say (rewrite as the owner speaking to the customer, first person). ' +
              'none = anything else (greetings, questions you cannot map).',
          },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!res.ok) return { action: 'none', note: null, customer: null, message: null };
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? '{}') as Partial<OwnerCommand>;
    return {
      action: (parsed.action as OwnerCommand['action']) ?? 'none',
      note: parsed.note ?? null,
      customer: parsed.customer ?? null,
      message: parsed.message ?? null,
    };
  } catch {
    return { action: 'none', note: null, customer: null, message: null };
  }
}

/* ── action handlers ── */

async function replyToOwner(event: InboundEvent, text: string): Promise<void> {
  const { getDeliveryAdapter } = await import('../../delivery.js');
  const adapter = getDeliveryAdapter();
  if (!adapter) return;
  await adapter.deliver(
    event.channelType,
    event.platformId,
    event.threadId,
    'chat',
    JSON.stringify({ text }),
    undefined,
    event.instance,
  );
}

function statusText(): string {
  const pending = pendingApprovals();
  const tiles = getAnalyticsTiles();
  const lines: string[] = [];
  lines.push(`📊 CoolBreeze — last 7 days`);
  lines.push(
    `Quotes: ${tiles.quotesSent7d} (${tiles.autoSent7d} auto · ${tiles.escalated7d} needed you) · ${fmtCents(tiles.centsQuoted7d, tiles.currency)} quoted` +
      (tiles.medianResponseSeconds !== null ? ` · ${tiles.medianResponseSeconds}s median response` : ''),
  );
  if (pending.length === 0) {
    lines.push(`\n✅ Nothing needs you right now.`);
  } else {
    lines.push(`\n⏳ Needs you (${pending.length}):`);
    for (const a of pending.slice(0, 5)) {
      lines.push(`• ${a.title ?? a.action} — reply "approve" or "reject, <condition>"`);
    }
  }
  return lines.join('\n');
}

async function resolveLast(
  event: InboundEvent,
  userId: string,
  decision: 'approve' | 'reject',
  note: string | null,
): Promise<void> {
  const latest = pendingApprovals()[0];
  if (!latest) {
    await replyToOwner(event, 'Nothing is pending approval right now.');
    return;
  }
  // Reject-note becomes a binding instruction BEFORE resolution (same
  // ordering as the dashboard path — the agent must see both together).
  if (decision === 'reject' && note) {
    const session = latest.session_id ? getSession(latest.session_id) : undefined;
    if (session) {
      const { applyOwnerInstruction } = await import('./owner-instructions.js');
      const payload = JSON.parse(latest.payload || '{}') as { quote?: { id?: string }; quoteId?: string };
      applyOwnerInstruction(session, note, payload.quote?.id ?? payload.quoteId ?? latest.approval_id);
    }
  }
  const { getResponseHandlers } = await import('../../response-registry.js');
  for (const handler of getResponseHandlers()) {
    const claimed = await handler({
      questionId: latest.approval_id,
      value: decision,
      userId,
      channelType: event.channelType,
      platformId: '',
      threadId: null,
    });
    if (claimed) break;
  }
  await replyToOwner(
    event,
    decision === 'approve'
      ? `✅ Approved: ${latest.title ?? latest.action}. The customer has their quote.`
      : `❌ Rejected: ${latest.title ?? latest.action}.${note ? ` Instruction applied: "${note}".` : ' The agent will re-offer within house rules.'}`,
  );
}

/** Find the most recent session for a customer name (quotes, then previews). */
function findCustomerSession(name: string): { sessionId: string; label: string } | null {
  const needle = name.toLowerCase();
  for (const q of listQuotes(200)) {
    if (q.session_id.startsWith('seed-sess-')) continue;
    if ((q.customer_name ?? '').toLowerCase().includes(needle)) {
      return { sessionId: q.session_id, label: q.customer_name ?? q.session_id };
    }
  }
  const events = getRecentConvEvents(0, 1000).reverse();
  for (const e of events) {
    if (e.session_id.startsWith('seed-sess-')) continue;
    if (e.payload.toLowerCase().includes(needle)) return { sessionId: e.session_id, label: name };
  }
  return null;
}

async function messageCustomer(event: InboundEvent, customer: string, message: string): Promise<void> {
  const target = findCustomerSession(customer);
  if (!target) {
    await replyToOwner(
      event,
      `Couldn't find a recent conversation matching "${customer}". Check the cockpit inbox for the exact name.`,
    );
    return;
  }
  const { ownerReplyToSession } = await import('../../channels/web/adapter.js');
  try {
    await ownerReplyToSession(target.sessionId, message);
    await replyToOwner(event, `📨 Sent to ${target.label}: "${message}"`);
  } catch (err) {
    await replyToOwner(
      event,
      `Couldn't deliver to ${target.label}: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
}

/* ── the interceptor ── */

export async function ownerCommandInterceptor(event: InboundEvent): Promise<boolean> {
  // Only direct messages, only privileged senders. Web-channel visitors are
  // customers even if an admin cookie exists — never intercept web.
  if (event.channelType === 'web' || event.message.isGroup) return false;
  let senderId = '';
  let text = '';
  try {
    const content = JSON.parse(event.message.content) as { senderId?: string; text?: string };
    senderId = String(content.senderId ?? '');
    text = String(content.text ?? '').trim();
  } catch {
    return false;
  }
  if (!senderId || !text || text.startsWith('/')) return false;
  const userId = senderId.includes(':') ? senderId : `${event.channelType}:${senderId}`;
  if (!isPrivileged(userId)) return false;

  // Rejection-window instructions win first (existing behavior).
  const { consumePendingInstructionFor } = await import('./owner-instructions.js');
  if (await consumePendingInstructionFor(userId, text)) {
    await replyToOwner(event, `Got it — instruction applied: "${text}". The agent is re-quoting on your terms.`);
    return true;
  }

  const cmd = quickParse(text) ?? (await classify(text));
  log.info('Owner command', { userId, action: cmd.action });
  switch (cmd.action) {
    case 'status':
      await replyToOwner(event, statusText());
      return true;
    case 'approve_last':
      await resolveLast(event, userId, 'approve', null);
      return true;
    case 'reject_last':
      await resolveLast(event, userId, 'reject', cmd.note);
      return true;
    case 'message_customer':
      if (cmd.customer && cmd.message) {
        await messageCustomer(event, cmd.customer, cmd.message);
        return true;
      }
      await replyToOwner(event, `Who should I send that to? Try: "tell <customer name>: <message>"`);
      return true;
    default:
      await replyToOwner(
        event,
        `I'm your Wingman assistant. You can text me:\n` +
          `• "status" — what's pending + this week's numbers\n` +
          `• "approve" / "reject, max 15%" — rule on the latest request\n` +
          `• "tell <customer>: <message>" — I'll relay it as you`,
      );
      return true;
  }
}
