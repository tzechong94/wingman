/**
 * Web channel adapter — the dashboard's customer chat is a REAL channel:
 * inbound goes through onInbound → router → session → container → Qwen →
 * Engram, identical to Telegram. Outbound arrives here via the normal
 * delivery poll and fans out over SSE.
 *
 * Per-visitor identity: each browser session mints `web:<visitorId>` with its
 * own messaging group (unknown_sender_policy='allow'), wiring, and session —
 * minted on page load so the container is warm before the judge types.
 *
 * Files (quote PDFs) land as OutboundFile buffers; we persist them under
 * data/web-files/<visitorId>/ and hand the browser a same-origin URL that
 * routes.ts serves back with cookie checks.
 */
import fs from 'fs';
import path from 'path';

import { wakeContainer } from '../../container-runner.js';
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { createMessagingGroup, getMessagingGroup } from '../../db/messaging-groups.js';
import { getWebVisitor, setWebVisitorSession, upsertWebVisitor } from '../../db/quotes.js';
import { createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import { recordConvEvent } from '../../modules/quotes/actions.js';
import { resolveSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { getSession, updateSession } from '../../db/sessions.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from '../adapter.js';
import { registerChannelAdapter } from '../channel-registry.js';

export const WEB_CHANNEL = 'web';
export const DEMO_OWNER_USER_ID = 'web:demo-owner';

const DATA_DIR = process.env.NANOCLAW_DATA_DIR || path.join(process.cwd(), 'data');
export const WEB_FILES_DIR = path.join(DATA_DIR, 'web-files');

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The agent group the web demo wires to (seeded by scripts/seed-coolbreeze.ts). */
export function demoAgentGroupId(): string | null {
  const folder = process.env.WINGMAN_GROUP_FOLDER || 'coolbreeze';
  return getAgentGroupByFolder(folder)?.id ?? null;
}

let setupConfig: ChannelSetup | null = null;

class WebAdapter implements ChannelAdapter {
  name = 'Web';
  channelType = WEB_CHANNEL;
  supportsThreads = false;

  async setup(config: ChannelSetup): Promise<void> {
    setupConfig = config;
    // Routes are registered lazily here so the webhook server only starts
    // when the web channel is actually active.
    const { registerWebRoutes } = await import('./routes.js');
    registerWebRoutes();
    log.info('Web channel ready', { filesDir: WEB_FILES_DIR });
  }

  async teardown(): Promise<void> {
    setupConfig = null;
  }

  isConnected(): boolean {
    return setupConfig !== null;
  }

  /**
   * Outbound delivery: persist files, mirror into conversation_events (which
   * also pushes to live SSE clients via the bus). platformId = visitorId.
   */
  async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
    const visitor = getWebVisitor(platformId);
    const sessionId = visitor?.session_id;
    if (!sessionId) {
      log.warn('Web deliver: unknown visitor — dropping', { platformId });
      return undefined;
    }

    const content = (message.content ?? {}) as Record<string, unknown>;
    const files: Array<{ name: string; url: string }> = [];
    if (message.files?.length) {
      const dir = path.join(WEB_FILES_DIR, platformId);
      fs.mkdirSync(dir, { recursive: true });
      for (const f of message.files) {
        const safeName = `${Date.now()}-${f.filename.replace(/[^\w.-]/g, '_')}`;
        fs.writeFileSync(path.join(dir, safeName), f.data);
        files.push({ name: f.filename, url: `/webhook/web/file/${platformId}/${safeName}` });
      }
    }

    const payload: Record<string, unknown> = {
      text: typeof content.text === 'string' ? content.text : '',
      ...(content.fromOwner ? { fromOwner: true } : {}),
      ...(content.quote ? { quote: content.quote } : {}),
      ...(content.quotePending ? { quotePending: content.quotePending } : {}),
      ...(content.type === 'ask_question' ? { askQuestion: content } : {}),
      ...(files.length ? { files } : {}),
    };
    recordConvEvent(sessionId, 'msg_out', content.fromOwner ? 'owner' : 'agent', payload);
    return undefined;
  }
}

/* ── visitor lifecycle (used by routes.ts) ── */

export interface MintResult {
  visitorId: string;
  sessionId: string;
}

/** Mint a browser visitor: messaging group + wiring + session + warm container. */
export function mintVisitor(): MintResult {
  const agentGroupId = demoAgentGroupId();
  if (!agentGroupId) {
    throw new Error(
      `no demo agent group found (folder "${process.env.WINGMAN_GROUP_FOLDER || 'coolbreeze'}") — run scripts/seed-coolbreeze.ts`,
    );
  }

  const visitorId = generateId('v');
  const now = new Date().toISOString();
  const mgId = generateId('mg-web');

  createMessagingGroup({
    id: mgId,
    channel_type: WEB_CHANNEL,
    platform_id: visitorId,
    instance: WEB_CHANNEL,
    name: `Web visitor ${visitorId.slice(-6)}`,
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now,
  });

  createMessagingGroupAgent({
    id: generateId('mga'),
    messaging_group_id: mgId,
    agent_group_id: agentGroupId,
    engage_mode: 'pattern',
    engage_pattern: '.', // always engage — it's a DM-style chat
    sender_scope: 'all',
    ignored_message_policy: 'accumulate',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  });

  const { session } = resolveSession(agentGroupId, mgId, null, 'shared');
  upsertWebVisitor(visitorId, mgId);
  setWebVisitorSession(visitorId, session.id);

  // Warm the container now so the first message doesn't pay cold-start.
  void wakeContainer(session).catch((err) => log.warn('Web mint: container warm-up failed', { visitorId, err }));

  log.info('Web visitor minted', { visitorId, mgId, sessionId: session.id });
  return { visitorId, sessionId: session.id };
}

/** Fresh session for the same visitor (Reset demo). Old session is left to idle-reap. */
export function resetVisitor(visitorId: string): MintResult | null {
  const visitor = getWebVisitor(visitorId);
  const agentGroupId = demoAgentGroupId();
  if (!visitor || !agentGroupId) return null;

  // Close the old session so resolveSession mints a fresh one; the old
  // container gets reaped by the idle sweep.
  if (visitor.session_id) {
    const old = getSession(visitor.session_id);
    if (old) updateSession(old.id, { status: 'closed' });
  }

  const { session } = resolveSession(agentGroupId, visitor.messaging_group_id, null, 'shared');
  setWebVisitorSession(visitorId, session.id);
  void wakeContainer(session).catch(() => {});
  log.info('Web visitor reset', { visitorId, sessionId: session.id });
  return { visitorId, sessionId: session.id };
}

/** Route an inbound customer message through the real pipeline. */
export function inboundFromVisitor(
  visitorId: string,
  text: string,
  attachments?: Array<{ mimeType: string; data: string }>,
): void {
  if (!setupConfig) throw new Error('web channel not set up');
  const visitor = getWebVisitor(visitorId);
  if (!visitor) throw new Error('unknown visitor');

  const msgId = generateId('web-msg');
  void setupConfig.onInbound(visitorId, null, {
    id: msgId,
    kind: 'chat',
    content: {
      text,
      sender: 'Web customer',
      senderId: visitorId,
      ...(attachments?.length
        ? { attachments: attachments.map((a) => ({ type: 'photo', mimeType: a.mimeType, data: a.data })) }
        : {}),
    },
    timestamp: new Date().toISOString(),
    isMention: true,
    isGroup: false,
  });

  if (visitor.session_id) {
    recordConvEvent(visitor.session_id, 'msg_in', 'customer', {
      text,
      ...(attachments?.length ? { attachmentCount: attachments.length } : {}),
    });
  }
}

/**
 * Owner barge-in: deliver a human reply into a customer conversation.
 * Delivered through the normal adapter path (mirrors into conversation_events
 * with actor='owner'), and the AGENT is told the boss spoke — so it doesn't
 * repeat or contradict the human on the next turn.
 */
export async function ownerReplyToSession(sessionId: string, text: string): Promise<void> {
  const session = getSession(sessionId);
  if (!session || session.status !== 'active') throw new Error('session not active');
  const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  if (!mg) throw new Error('session has no origin messaging group');

  const { getDeliveryAdapter } = await import('../../delivery.js');
  const adapter = getDeliveryAdapter();
  if (!adapter) throw new Error('no delivery adapter');
  await adapter.deliver(
    mg.channel_type,
    mg.platform_id,
    null,
    'chat',
    JSON.stringify({ text, fromOwner: true }),
    undefined,
    mg.instance,
  );

  const { notifyAgent } = await import('../../modules/approvals/primitive.js');
  notifyAgent(
    session,
    `The business owner personally replied to the customer in this conversation: "${text}". ` +
      `Treat it as authoritative — do not repeat, rephrase, or contradict it. Only respond to what the customer says next.`,
  );
  log.info('Owner barge-in delivered', { sessionId, chars: text.length });
}

/** Dashboard approval resolution — same dispatch path as a Telegram button tap. */
export function resolveApprovalFromDashboard(questionId: string, decision: 'approve' | 'reject'): void {
  if (!setupConfig) throw new Error('web channel not set up');
  setupConfig.onAction(questionId, decision, DEMO_OWNER_USER_ID);
}

export function currentSessionOf(visitorId: string): Session | undefined {
  const visitor = getWebVisitor(visitorId);
  if (!visitor?.session_id) return undefined;
  return getSession(visitor.session_id);
}

registerChannelAdapter(WEB_CHANNEL, {
  factory: () => new WebAdapter(),
});
