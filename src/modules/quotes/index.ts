/**
 * Wingman quotes module — approval-native quote pipeline.
 *
 * Registers:
 *   - Four delivery actions written by the container's quote driver
 *     (container/agent-runner/src/quotes/driver.ts): persist_quote,
 *     reasoning_event, request_quote_approval, request_nudge_approval.
 *   - Approval handlers for 'send_quote' / 'send_nudge' — on approve the
 *     HOST delivers to the customer directly (model out of the critical
 *     path); on reject the agent is coached to re-draft within house rules.
 *
 * Tables: migration 017 (quotes, conversation_events, web_visitors).
 * Load order: after approvals (barrel guarantees this).
 */
import { registerDeliveryAction } from '../../delivery.js';
import {
  handleOwnerFyi,
  handlePersistQuote,
  handleReasoningEvent,
  handleRequestNudgeApproval,
  handleRequestQuoteApproval,
} from './actions.js';
import './approval-handlers.js';
import { setMessageInterceptor } from '../../router.js';
import { ownerCommandInterceptor } from './owner-commands.js';

setMessageInterceptor(ownerCommandInterceptor);

registerDeliveryAction('persist_quote', handlePersistQuote);
registerDeliveryAction('reasoning_event', handleReasoningEvent);
registerDeliveryAction('owner_fyi', handleOwnerFyi);
registerDeliveryAction('request_quote_approval', handleRequestQuoteApproval);
registerDeliveryAction('request_nudge_approval', handleRequestNudgeApproval);
