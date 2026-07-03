/**
 * Wingman sweep pass — runs once per host-sweep tick.
 *
 *   1. Approval timeout: pending send_quote approvals older than N minutes
 *      get a customer-facing "the owner will confirm shortly" notice (once),
 *      so a judge never stares at a dead "waiting" chip. The card stays
 *      resolvable — this is a courtesy message, not an expiry.
 *   2. Idle web-visitor reaping: page-load spawning means visitors who never
 *      chat still hold a container; close their sessions after idleMinutes
 *      so an 8GB VPS survives a judging day.
 */
import { getPendingApprovalsByAction, getSession, updateSession } from '../../db/sessions.js';
import { getWebVisitor, listIdleWebVisitors, setWebVisitorSession } from '../../db/quotes.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { killContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { recordConvEvent } from './actions.js';

const APPROVAL_NOTICE_AFTER_MS = parseInt(process.env.WINGMAN_APPROVAL_NOTICE_MINUTES || '3', 10) * 60_000;
const WEB_IDLE_MINUTES = parseInt(process.env.WINGMAN_WEB_IDLE_MINUTES || '45', 10);

/** Approvals we've already sent the courtesy notice for (in-memory is fine — worst case after a restart is one repeat notice). */
const noticed = new Set<string>();

export async function sweepWingman(): Promise<void> {
  await approvalTimeoutPass().catch((err) => log.error('Wingman approval-timeout pass failed', { err }));
  await idleVisitorPass().catch((err) => log.error('Wingman idle-visitor pass failed', { err }));
}

async function approvalTimeoutPass(): Promise<void> {
  const now = Date.now();
  const pending = [...getPendingApprovalsByAction('send_quote'), ...getPendingApprovalsByAction('send_nudge')].filter(
    (a) => a.status === 'pending',
  );
  for (const approval of pending) {
    if (noticed.has(approval.approval_id)) continue;
    const age = now - new Date(approval.created_at).getTime();
    if (age < APPROVAL_NOTICE_AFTER_MS) continue;
    noticed.add(approval.approval_id);

    // Nudge approvals have no waiting customer — only quote approvals notify.
    if (approval.action !== 'send_quote' || !approval.session_id) continue;
    const session = getSession(approval.session_id);
    const mg = session?.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
    const adapter = getDeliveryAdapter();
    if (!session || !mg || !adapter) continue;
    try {
      await adapter.deliver(
        mg.channel_type,
        mg.platform_id,
        null,
        'chat',
        JSON.stringify({
          text: `Still checking with the boss — thanks for your patience! We've saved your request and will confirm shortly.`,
        }),
        undefined,
        mg.instance,
      );
      recordConvEvent(session.id, 'msg_out', 'system', { text: 'approval-delay notice sent' });
      log.info('Approval-delay notice sent', { approvalId: approval.approval_id, sessionId: session.id });
      // eslint-disable-next-line no-catch-all/no-catch-all -- courtesy notice only; the approval flow itself is unaffected by a delivery hiccup
    } catch (err) {
      log.warn('Approval-delay notice failed', { approvalId: approval.approval_id, err });
    }
  }
}

async function idleVisitorPass(): Promise<void> {
  for (const visitor of listIdleWebVisitors(WEB_IDLE_MINUTES)) {
    const fresh = getWebVisitor(visitor.visitor_id);
    if (!fresh?.session_id) continue;
    const session = getSession(fresh.session_id);
    if (!session || session.status !== 'active') {
      setWebVisitorSession(visitor.visitor_id, '');
      continue;
    }
    log.info('Reaping idle web visitor session', {
      visitorId: visitor.visitor_id,
      sessionId: session.id,
      idleMinutes: WEB_IDLE_MINUTES,
    });
    updateSession(session.id, { status: 'closed' });
    setWebVisitorSession(visitor.visitor_id, '');
    killContainer(session.id, 'idle web visitor reaped');
  }
}
