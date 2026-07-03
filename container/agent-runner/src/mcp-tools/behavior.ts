/**
 * Behaviour-modification MCP tools: set_engagement_mode, save_preference.
 *
 * These let the assistant change how it behaves when the user asks ("only reply
 * when I mention you", "keep replies to one line"). Like self-mod, both are
 * fire-and-forget: the tool writes a `system` action row into messages_out and
 * returns immediately. The host validates the request, routes it through admin
 * approval (requestApproval → DMs the owner), and only on approval applies it:
 *
 *   set_engagement_mode → updates the agent group's channel wiring(s) so the
 *     router only wakes the agent under the chosen rule. No restart needed —
 *     the router re-reads the wiring on the next inbound message.
 *   save_preference → appends a durable preference to the group's
 *     preferences.md, which the agent re-reads into context on every turn.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const MODES = ['always', 'mention', 'mention-sticky', 'pattern'] as const;
type Mode = (typeof MODES)[number];

export const setEngagementMode: McpToolDefinition = {
  tool: {
    name: 'set_engagement_mode',
    description:
      'Change WHEN you reply in the current chat. Call this whenever the user asks you to respond only in certain cases — e.g. "only reply when I mention you", "always reply", or "only when a message matches X". Do NOT just say "okay"; call this tool. It is sent to the user for approval and takes effect once they approve. Modes: "always" = reply to every message; "mention" = only when you are @mentioned; "mention-sticky" = once mentioned in a thread, keep replying to that thread; "pattern" = reply only when the message text matches the regex in `pattern`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mode: { type: 'string', enum: [...MODES], description: 'always | mention | mention-sticky | pattern' },
        pattern: { type: 'string', description: 'Regex matched against the message text. Required when mode="pattern".' },
        reason: { type: 'string', description: 'Optional short note shown to the user in the approval card.' },
      },
      required: ['mode'],
    },
  },
  async handler(args) {
    const mode = String(args.mode || '') as Mode;
    if (!MODES.includes(mode)) return err(`invalid mode "${mode}". Use one of: ${MODES.join(', ')}`);
    const pattern = (args.pattern as string) || '';
    if (mode === 'pattern' && !pattern.trim()) return err('mode "pattern" requires a non-empty `pattern` regex.');

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'system',
      content: JSON.stringify({ action: 'set_engagement_mode', mode, pattern, reason: (args.reason as string) || '' }),
    });
    log(`set_engagement_mode: ${id} → ${mode}${pattern ? ` /${pattern}/` : ''}`);
    return ok(`Requested engagement change to "${mode}". The user will be asked to approve; it takes effect once they do.`);
  },
};

export const savePreference: McpToolDefinition = {
  tool: {
    name: 'save_preference',
    description:
      'Persist a durable behaviour/style preference about how you should act, so you honour it on every future turn — e.g. "keep replies to one line", "always answer in English", "never use emoji". Call this whenever the user states a lasting preference about your behaviour. Do NOT just acknowledge it; call this tool. Requires the user\'s approval; fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        preference: {
          type: 'string',
          description: 'The preference in clear imperative form, e.g. "Keep replies to a single line."',
        },
      },
      required: ['preference'],
    },
  },
  async handler(args) {
    const preference = String(args.preference || '').trim();
    if (!preference) return err('preference text is required');
    if (preference.length > 280) return err('preference too long (max 280 chars)');

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'system',
      content: JSON.stringify({ action: 'save_preference', preference }),
    });
    log(`save_preference: ${id} → ${preference.slice(0, 60)}`);
    return ok(`Requested to save the preference: "${preference}". The user will be asked to approve.`);
  },
};

registerTools([setEngagementMode, savePreference]);
