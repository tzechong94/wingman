/**
 * Delivery-action handlers for agent-initiated behaviour changes.
 *
 * Two actions the container can write into messages_out (via the behaviour MCP
 * tools): set_engagement_mode, save_preference. Each validates input and queues
 * an approval via requestApproval() — the owner gets a Telegram card. On
 * approve, the matching handler in ./apply.ts performs the change.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';

const MODES = ['always', 'mention', 'mention-sticky', 'pattern'];

const HUMAN: Record<string, (p: string) => string> = {
  always: () => 'reply to every message in this chat',
  mention: () => 'reply only when you mention it',
  'mention-sticky': () => 'reply when mentioned, then stay engaged in that thread',
  pattern: (p) => `reply only when a message matches /${p}/`,
};

export async function handleSetEngagementMode(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'set_engagement_mode failed: agent group not found.');
    return;
  }
  const mode = String(content.mode || '');
  const pattern = (content.pattern as string) || '';
  const reason = (content.reason as string) || '';
  if (!MODES.includes(mode)) {
    notifyAgent(session, `set_engagement_mode failed: invalid mode "${mode}".`);
    return;
  }
  if (mode === 'pattern' && !pattern.trim()) {
    notifyAgent(session, 'set_engagement_mode failed: mode "pattern" needs a regex.');
    return;
  }

  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'set_engagement_mode',
    payload: { mode, pattern },
    title: 'Change when the assistant replies',
    question: `${agentGroup.name} wants to ${HUMAN[mode]!(pattern)}${reason ? `.\nReason: ${reason}` : '.'}`,
  });
}

export async function handleSavePreference(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'save_preference failed: agent group not found.');
    return;
  }
  const preference = String(content.preference || '').trim();
  if (!preference) {
    notifyAgent(session, 'save_preference failed: empty preference.');
    return;
  }

  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'save_preference',
    payload: { preference },
    title: 'Save a standing preference',
    question: `${agentGroup.name} wants to always follow this preference:\n"${preference}"`,
  });
}
