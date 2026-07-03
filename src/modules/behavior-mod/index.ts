/**
 * Behaviour-modification module — user-approved changes to how the agent
 * behaves. Depends on the approvals default module for the request/handler
 * plumbing (same pattern as self-mod). On import it registers:
 *   - Two delivery actions (set_engagement_mode, save_preference) that validate
 *     input and queue an approval via requestApproval().
 *   - Two matching approval handlers that apply the change on approve.
 *
 * Without this module the MCP tools still write the system actions, but
 * delivery logs "Unknown system action" and drops them — nothing changes.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { registerApprovalHandler } from '../approvals/index.js';
import { applySavePreference, applySetEngagementMode } from './apply.js';
import { handleSavePreference, handleSetEngagementMode } from './request.js';

registerDeliveryAction('set_engagement_mode', handleSetEngagementMode);
registerDeliveryAction('save_preference', handleSavePreference);

registerApprovalHandler('set_engagement_mode', applySetEngagementMode);
registerApprovalHandler('save_preference', applySavePreference);
