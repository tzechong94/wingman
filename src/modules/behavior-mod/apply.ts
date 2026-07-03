/**
 * Approval handlers for behaviour changes. Called when the owner clicks Approve
 * on a pending_approvals row whose action matches.
 *
 * set_engagement_mode → update every channel wiring for this agent group. The
 *   router re-reads the wiring on the next inbound message, so no restart.
 * save_preference → append to groups/<folder>/preferences.md. That folder is
 *   mounted into the container at /workspace/agent, and the provider re-reads
 *   preferences.md into context every turn — so it takes effect immediately,
 *   no restart.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import {
  getMessagingGroupAgentByPair,
  getMessagingGroupsByAgentGroup,
  updateMessagingGroupAgent,
} from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { ApprovalHandler } from '../approvals/index.js';

export const applySetEngagementMode: ApprovalHandler = async ({ session, payload, notify }) => {
  const mode = String(payload.mode || 'always');
  const pattern = (payload.pattern as string) || '';

  const messagingGroups = getMessagingGroupsByAgentGroup(session.agent_group_id);
  let updated = 0;
  for (const mg of messagingGroups) {
    // "only reply when mentioned / named" is a group concept — never gate a 1:1
    // DM behind it (the user expects a DM to always respond).
    if (mode !== 'always' && mg.is_group === 0) continue;
    const wiring = getMessagingGroupAgentByPair(mg.id, session.agent_group_id);
    if (!wiring) continue;
    if (mode === 'always') {
      updateMessagingGroupAgent(wiring.id, { engage_mode: 'pattern', engage_pattern: '.' });
    } else if (mode === 'pattern') {
      updateMessagingGroupAgent(wiring.id, { engage_mode: 'pattern', engage_pattern: pattern || '.' });
    } else if (mode === 'mention' || mode === 'mention-sticky') {
      updateMessagingGroupAgent(wiring.id, { engage_mode: mode, engage_pattern: null });
    }
    updated++;
  }

  log.info('Engagement mode updated', { agentGroupId: session.agent_group_id, mode, updated });
  notify(
    updated > 0
      ? `Done — replies are now set to "${mode}" on ${updated} channel(s). Briefly confirm to the user.`
      : 'Engagement change approved, but no channel wiring was found to update. Tell the user.',
  );
};

export const applySavePreference: ApprovalHandler = async ({ session, payload, notify }) => {
  const preference = String(payload.preference || '').trim();
  if (!preference) {
    notify('save_preference approved but the preference was empty.');
    return;
  }
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notify('save_preference approved but agent group is missing.');
    return;
  }

  const file = path.join(path.resolve(GROUPS_DIR, agentGroup.folder), 'preferences.md');
  let body = '';
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch {
    /* first preference — file doesn't exist yet */
  }
  if (body.split('\n').some((line) => line.trim() === `- ${preference}`)) {
    notify(`"${preference}" is already saved. Briefly confirm to the user.`);
    return;
  }
  const header = '# Standing preferences (always follow)\n\n';
  const next = (body.trim() ? body.replace(/\s*$/, '\n') : header) + `- ${preference}\n`;
  fs.writeFileSync(file, next);

  log.info('Preference saved', { agentGroupId: session.agent_group_id });
  notify(`Saved — you'll follow "${preference}" from now on. Briefly confirm to the user.`);
};
