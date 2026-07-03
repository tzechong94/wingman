import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getInboundDb, getOutboundDb } from '../db/connection.js';
import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';

/**
 * Qwen Code engine provider — the NanoClaw engine swapped from Claude to Qwen.
 *
 * Drives the Qwen Code terminal agent (a Gemini-CLI fork) directly, with NO
 * routing/middle layer: Qwen Code talks straight to Model Studio / DashScope
 * (configured via env it inherits). Two invocation modes behind one provider:
 *
 *   - acp (default): run `qwen --experimental-acp`, a persistent agent process
 *     speaking the Agent Client Protocol (JSON-RPC over stdio). This is the mode
 *     the build brief points at — real streaming (→ activity events), session
 *     continuity (continuation = ACP sessionId), and native MCP (the cloud memory
 *     server is handed to Qwen Code via session/new mcpServers).
 *   - oneshot: `qwen -p "<prompt>" --yolo`, one process per turn. Fallback for
 *     environments where the ACP daemon misbehaves. Set QWEN_MODE=oneshot.
 *
 *        host ──QUERY──▶ QwenProvider ──ACP/stdio──▶ qwen ──OpenAI API──▶ Model Studio
 *                              │                       │
 *                              │◀── session/update ────┘ (streaming chunks, tool calls)
 *                              └── mcp__memory__* tools reach the Engram memory MCP server
 *
 * NOTE: the ACP method names/framing below follow the Agent Client Protocol spec
 * (newline-delimited JSON-RPC 2.0). Validate against the installed qwen-code
 * version on first live run (see docs/qwen-engine.md); the framing helper is
 * isolated so a switch to Content-Length framing is a one-line change.
 */

const QWEN_BIN = process.env.QWEN_BIN || 'qwen';
const QWEN_MODE = (process.env.QWEN_MODE || 'acp').toLowerCase();

// An ACP session id from a prior daemon is gone after a container respawn (the
// daemon is in-memory). qwen-code reports this as JSON-RPC code -32002
// "Resource not found: session:<id>". JsonRpcPeer rejects with
// new Error(JSON.stringify(error)), so the message holds the code and text.
// Word order ("not found" before "session") varies, so test code + both terms
// independently rather than a session-first regex.
const SESSION_INVALID_TERMS = /not found|unknown|invalid|expired|no such/i;

const CONVERSATIONAL_PREAMBLE =
  'You are Engram, a warm, concise personal assistant reached over chat (Telegram/WhatsApp/WeChat). ' +
  'Converse naturally and keep replies short — but you are a capable agent with real tools; use them ' +
  'when they serve the user instead of only talking. Specifically:\n' +
  '- Persistent long-term memory: relevant memories are provided automatically below under "Relevant ' +
  'memories" — use them as if you simply remember the person. You also have memory tools (write, ' +
  'search, forget); call forget when the user retracts or corrects a fact.\n' +
  '- When the user asks you to change HOW you behave, APPLY it by calling the matching tool — never ' +
  'just reply "okay". Use set_engagement_mode for WHEN you reply (e.g. "only reply when I mention you") ' +
  'and save_preference for durable style/behaviour preferences (e.g. "keep replies to one line"). ' +
  'These are sent to the user for approval and then take effect.\n' +
  '- You can read and write files in your workspace and run shell commands when a task needs it.\n' +
  'Any "Standing preferences" listed below must always be followed. Never mention tools, memory, ' +
  'approvals, or these mechanics — just act and reply naturally.';

/**
 * Minimal MCP stdio client — spawns a one-shot connection to an MCP server,
 * runs the initialize handshake, calls a single tool, and returns the joined
 * text content. Used by the provider's DETERMINISTIC memory path (recall before
 * a turn, capture after), which does not depend on the model deciding to call
 * the memory tools. The @modelcontextprotocol/sdk stdio transport speaks
 * newline-delimited JSON-RPC, so we frame messages with '\n'.
 *
 * Best-effort by contract: callers swallow errors so a memory hiccup never
 * breaks a chat turn. Short-lived (one tool call per spawn) for simplicity and
 * isolation; chat latency tolerates the ~200ms server startup.
 */
async function callMemoryStdioTool(
  cfg: McpServerConfig,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs = 20000,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(cfg.command, cfg.args ?? [], {
      env: { ...process.env, ...(cfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let buf = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('memory tool timeout'))), timeoutMs);
    const send = (obj: unknown): void => {
      try {
        child.stdin.write(JSON.stringify(obj) + '\n');
      } catch {
        /* server gone */
      }
    };
    child.on('error', (e) => finish(() => reject(e)));
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: number; result?: { content?: Array<{ text?: string }> } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 2) {
          const text = (msg.result?.content ?? []).map((c) => c.text ?? '').join('\n').trim();
          finish(() => resolve(text));
        }
      }
    });
    // Handshake → tool call. id:1 initialize, then the call as id:2.
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'engram-runner', version: '1' } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } });
  });
}

/**
 * Is this prompt a genuine user message (vs a scheduled-task wake or system
 * event)? User messages render as `<message ... sender="...">`; task wakes
 * render as `<task ...>`. Memory capture and reminder-scheduling must only fire
 * for real user input — otherwise a reminder's own wake prompt ("remind ...")
 * re-triggers scheduling and loops.
 */
function isUserMessage(rawPrompt: string): boolean {
  return /<message\b[^>]*\bsender=/.test(rawPrompt);
}

export class QwenProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = true;
  readonly usesMemoryScaffold = false; // durable memory is the cloud MCP, not a local tree

  private model?: string;
  private mcpServers: Record<string, McpServerConfig>;
  private env: Record<string, string | undefined>;
  private assistantName?: string;

  constructor(options: ProviderOptions = {}) {
    this.model = options.model;
    this.mcpServers = options.mcpServers ?? {};
    this.env = options.env ?? {};
    this.assistantName = options.assistantName;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('-32002')) return true;
    return /session/i.test(msg) && SESSION_INVALID_TERMS.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    return QWEN_MODE === 'oneshot' ? this.queryOneShot(input) : this.queryAcp(input);
  }

  // ── Deterministic memory (recall before a turn, capture after) ───────────────
  // The conversational model cannot be relied on to call the memory tools, so
  // Engram drives memory itself: search for relevant context and inject it, then
  // write the user's turn into the pipeline. Reuses the same `memory` MCP server
  // the agent is wired to, so there is one source of truth. All best-effort.

  private get memoryCfg(): McpServerConfig | undefined {
    return this.mcpServers['memory'];
  }

  /**
   * Strip NanoClaw's inbound envelope to the user's actual words. The prompt
   * arrives as `<context .../>\n<message ...>BODY</message>`; we store/search on
   * BODY so memory stays clean (better embeddings, readable viewer, better
   * sleep consolidation). Falls back to tag-stripping if the shape changes.
   */
  private cleanUserText(raw: string): string {
    if (!raw) return '';
    const bodies: string[] = [];
    const re = /<message\b[^>]*>([\s\S]*?)<\/message>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) bodies.push(m[1]);
    const text = bodies.length ? bodies.join('\n') : raw.replace(/<[^>]+>/g, ' ');
    return text.replace(/\s+/g, ' ').trim();
  }

  /**
   * Recall relevant memories for the user's message and inject them CLEANLY.
   * The MCP `search` returns JSON `{memories, trace}`; we extract just the memory
   * contents (the budgeter already ranked + packed them within the token budget)
   * and present a tight bullet list, so the model answers from facts rather than
   * digging through a raw JSON blob. Returns a context block or ''.
   */
  private async recallContext(userText: string): Promise<string> {
    const cfg = this.memoryCfg;
    if (!cfg || !userText.trim()) return '';
    try {
      const raw = await callMemoryStdioTool(cfg, 'search', { query: userText, token_budget: 1500 });
      if (!raw) return '';
      let memories: Array<{ kind?: string; content?: string }> | null = null;
      try {
        memories = (JSON.parse(raw) as { memories?: Array<{ kind?: string; content?: string }> }).memories ?? [];
      } catch {
        // Older/raw server output — fall back to injecting the text as-is.
        return `Relevant memories about the user (use them to answer accurately; never say you looked them up):\n${raw}`;
      }
      const lines = memories
        .map((m) => (m.content ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .map((c) => `- ${c}`);
      if (!lines.length) return '';
      return `Relevant memories about the user (use them to answer accurately; never say you looked them up):\n${lines.join('\n')}`;
    } catch {
      return '';
    }
  }

  /**
   * Standing preferences the user has approved (set via the save_preference
   * tool → host writes preferences.md into the agent group folder, mounted at
   * the cwd). Re-read every turn so a freshly-approved preference takes effect
   * immediately, with no container restart. Returns a context block or ''.
   */
  private prefsBlock(cwd: string): string {
    try {
      const body = fs.readFileSync(path.join(cwd, 'preferences.md'), 'utf8').trim();
      if (!body) return '';
      return `Standing preferences you must always follow:\n${body}`;
    } catch {
      return '';
    }
  }

  /**
   * Expose the MCP tools to the model. Qwen Code (0.18.1) loads MCP servers from
   * `settings.json` — it does NOT read the `mcpServers` we pass in the ACP
   * session/new request. Without this, the model has no callable tools and
   * hallucinates tool use as plain text (so set_engagement_mode etc. never
   * actually fire). We write a project-scope `.qwen/settings.json` (merged with
   * any existing one) before launching qwen so its tools reach the model. The
   * entry shape ({command,args,env}) already matches our mcpServers map.
   */
  private writeQwenSettings(cwd: string): void {
    try {
      const dir = path.join(cwd, '.qwen');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'settings.json');
      let existing: Record<string, unknown> = {};
      try {
        existing = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      } catch {
        /* new file */
      }
      // `trust: true` per server bypasses qwen-code's per-call confirmation
      // prompts, so the tools are live for the model immediately. (Our own
      // important changes are still gated by the host approval flow — this only
      // skips qwen-code's redundant prompt.) folderTrust disabled because there
      // is no TTY in ACP mode to answer the trust dialog.
      const mcpServers: Record<string, unknown> = {};
      for (const [name, cfg] of Object.entries(this.mcpServers)) {
        mcpServers[name] = { ...cfg, trust: true };
      }
      const security = { ...((existing.security as Record<string, unknown>) ?? {}), folderTrust: { enabled: false } };
      fs.writeFileSync(file, JSON.stringify({ ...existing, security, mcpServers }, null, 2));

      // Also pre-trust the workspace in the central trust store, so a fresh
      // qwen-code start never blocks project config (and its MCP servers) on the
      // interactive "trust this folder?" dialog.
      const qwenHome = path.join(process.env.HOME || '/home/node', '.qwen');
      fs.mkdirSync(qwenHome, { recursive: true });
      const tfFile = path.join(qwenHome, 'trustedFolders.json');
      let folders: Record<string, string> = {};
      try {
        folders = JSON.parse(fs.readFileSync(tfFile, 'utf8')) as Record<string, string>;
      } catch {
        /* new file */
      }
      folders[cwd] = 'TRUST_FOLDER';
      fs.writeFileSync(tfFile, JSON.stringify(folders, null, 2));
    } catch (e) {
      console.error(`[qwen] failed to write .qwen/settings.json: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Reconstruct recent conversation history from the session DBs so the model
   * has context every turn — independent of ACP session continuity (which is
   * lost whenever the container respawns: the in-memory daemon is gone and
   * session/load fails with -32002). This mirrors how the Claude provider
   * resumes a transcript. User turns = inbound chat messages; assistant turns =
   * outbound chat messages; system notifications are skipped. Ordered by the
   * global seq the host/container share.
   */
  private recentHistory(currentClean: string, maxTurns = 12): string {
    const textOf = (content: string): string => {
      try {
        const j = JSON.parse(content) as { text?: string; sender?: string };
        if (j.sender === 'system') return ''; // skip system notifications
        return String(j.text ?? '').trim();
      } catch {
        return '';
      }
    };
    try {
      const inRows = getInboundDb()
        .prepare("SELECT seq, content FROM messages_in WHERE seq IS NOT NULL AND kind IN ('chat','chat-sdk') ORDER BY seq DESC LIMIT 40")
        .all() as Array<{ seq: number; content: string }>;
      const outRows = getOutboundDb()
        .prepare("SELECT seq, content FROM messages_out WHERE seq IS NOT NULL AND kind IN ('chat','chat-sdk') ORDER BY seq DESC LIMIT 40")
        .all() as Array<{ seq: number; content: string }>;
      const turns = [
        ...inRows.map((r) => ({ seq: r.seq, role: 'User' as const, text: textOf(r.content) })),
        ...outRows.map((r) => ({ seq: r.seq, role: 'You' as const, text: textOf(r.content) })),
      ]
        .filter((t) => t.text)
        .sort((a, b) => a.seq - b.seq);
      // Drop trailing user turn(s) equal to the message we're about to answer
      // (it's already the prompt) so it isn't duplicated.
      while (turns.length && turns[turns.length - 1]!.role === 'User' && turns[turns.length - 1]!.text === currentClean) {
        turns.pop();
      }
      const recent = turns.slice(-maxTurns);
      if (!recent.length) return '';
      return `Recent conversation (most recent last — use it for context):\n${recent.map((t) => `${t.role}: ${t.text}`).join('\n')}`;
    } catch {
      return '';
    }
  }

  /**
   * Normalise the model's reply to nanoclaw's delivery contract and route it to
   * the SOURCE destination. Qwen-max is unreliable with the `<message to="…">`
   * multi-destination protocol: it replies to the wrong destination (a DM
   * instead of the group the message came from), sends to several at once, or
   * emits stray `<internal>`/`<scratchpad>`/`<action>` tags so the poll-loop
   * sends nothing. We deterministically: (1) pull the human reply text out of
   * whatever the model produced, (2) drop the thinking/fake-action tags, and
   * (3) wrap it in a single `<message to="<from>">` targeting the destination the
   * inbound message came from — exactly nanoclaw's "reply where it came from"
   * default (see destinations.ts). Falls back to the raw output if it can't
   * determine a destination or salvage text, so a turn is never silently lost.
   */
  private formatReply(rawOutput: string, sourcePrompt: string): string {
    const raw = (rawOutput ?? '').trim();
    // Source destination = the `from` of the most recent inbound <message>.
    const froms = [...sourcePrompt.matchAll(/<message\b[^>]*\bfrom="([^"]+)"/gi)].map((m) => m[1]!);
    const dest = froms.length ? froms[froms.length - 1] : undefined;
    if (!dest || dest.startsWith('unknown:')) return raw;

    // Prefer the text the model put inside <message> blocks; else the whole output.
    const blocks = [...raw.matchAll(/<message\b[^>]*>([\s\S]*?)<\/message>/gi)]
      .map((m) => (m[1] ?? '').trim())
      .filter(Boolean);
    let body = blocks.length ? blocks.join('\n\n') : raw;

    // Strip thinking / fake-action noise and any stray protocol tags.
    body = body
      .replace(/<internal>[\s\S]*?<\/internal>/gi, ' ')
      .replace(/<scratchpad>[\s\S]*?<\/scratchpad>/gi, ' ')
      .replace(/<action\b[^>]*>[\s\S]*?<\/action>/gi, ' ')
      .replace(/<\/?(?:internal|scratchpad|action|message|messages)\b[^>]*>/gi, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .trim();

    if (!body) return raw; // nothing salvageable — don't drop the turn
    return `<message to="${dest}">${body}</message>`;
  }

  /**
   * Explicit "now" anchor. The inbound envelope only carries a timezone, not the
   * current date/time, so the model can't reliably resolve relative dates
   * ("tomorrow", "next week"). We compute the current local date/time in the
   * user's timezone and tell the model to treat it as now.
   */
  private nowBlock(rawPrompt: string): string {
    const tz = rawPrompt.match(/timezone="([^"]+)"/)?.[1] || process.env.TZ || 'UTC';
    try {
      const now = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      }).format(new Date());
      return `Current date and time: ${now} (${tz}). Treat this as "now" — resolve relative dates like "today", "tomorrow", "tonight", "next week" against it.`;
    } catch {
      return '';
    }
  }

  /** Write the user's message into memory. Fire-and-forget; never blocks a turn. */
  private captureTurn(userText: string, channel?: string): void {
    const cfg = this.memoryCfg;
    if (!cfg || !userText.trim()) return;
    void callMemoryStdioTool(cfg, 'write', {
      content: userText,
      ...(channel ? { source_channel: channel } : {}),
    }).catch(() => {
      /* best-effort capture */
    });
  }

  // ── Deterministic reminders ──────────────────────────────────────────────────
  // Qwen won't reliably call schedule_task on its own (same proactive-tool-call
  // gap as memory). So Engram detects reminder intent and schedules it itself:
  // a cheap regex gate, then a focused JSON extraction, then a real call to the
  // nanoclaw schedule_task tool — which writes the system action with full
  // session context (inherited env). Fire-and-forget; never blocks a turn.

  private maybeSchedule(userText: string, rawPrompt: string): void {
    const cfg = this.mcpServers['nanoclaw'];
    if (!cfg || !userText.trim()) return;
    // Cheap gate — only spend an extraction call on plausibly-schedule messages.
    if (!/\b(remind|reminder|wake me|ping me|don'?t let me forget|schedule|every\s+(day|week|morning|night|mon|tue|wed|thu|fri|sat|sun)|tomorrow|tonight|later|in\s+\d+\s*(s|sec|second|min|minute|hour|hr|h|day)|at\s+\d{1,2}([:.]?\d{2})?\s*(am|pm)?)/i.test(userText)) return;
    const tz = rawPrompt.match(/timezone="([^"]+)"/)?.[1] || process.env.TZ || 'UTC';
    void (async () => {
      try {
        const spec = await this.extractScheduleJson(userText, tz);
        if (!spec?.schedule || !spec.processAfter) return;
        await callMemoryStdioTool(cfg, 'schedule_task', {
          prompt: spec.prompt || `Remind the user about: ${userText}`,
          processAfter: spec.processAfter,
          ...(spec.recurrence ? { recurrence: spec.recurrence } : {}),
        });
      } catch {
        /* best-effort */
      }
    })();
  }

  /** Focused JSON extraction of a reminder spec via Model Studio (qwen-turbo). */
  private async extractScheduleJson(
    text: string,
    tz: string,
  ): Promise<{ schedule: boolean; prompt: string; processAfter: string; recurrence: string | null } | null> {
    const key = this.env.DASHSCOPE_API_KEY || this.env.OPENAI_API_KEY;
    const base = this.env.OPENAI_BASE_URL || this.env.DASHSCOPE_BASE_URL;
    if (!key || !base) return null;
    // Current time AS NAIVE LOCAL in the user's timezone, so the model does
    // simple local arithmetic ("in 1 minute" = localNow + 60s) and returns a
    // naive-local timestamp, which schedule_task interprets in the same zone.
    let localNow = new Date().toISOString();
    try {
      const p = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).formatToParts(new Date());
      const g = (t: string) => p.find((x) => x.type === t)?.value ?? '00';
      localNow = `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}`;
    } catch {
      /* fall back to UTC iso */
    }
    const sys =
      `You convert a chat message into a reminder spec. The user's local time right now is ${localNow} ` +
      `(timezone ${tz}). Reply with STRICT JSON only: ` +
      `{"schedule": boolean, "prompt": string, "processAfter": string, "recurrence": string|null}. ` +
      `Set schedule=true ONLY if the user is asking to be reminded or to schedule/repeat something. ` +
      `"prompt" = a short instruction telling a future assistant what to remind the user (e.g. "Remind them to check the oven."). ` +
      `"processAfter" = ISO 8601 NAIVE LOCAL timestamp (no timezone offset) for the first run, computed from the local time above ` +
      `(e.g. "in 1 minute" → add 60 seconds; "9pm" → today or tomorrow at 21:00). ` +
      `"recurrence" = a cron expression (in the user's timezone) for repeating reminders, else null.`;
    try {
      const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: 'qwen-turbo',
          messages: [{ role: 'system', content: sys }, { role: 'user', content: text }],
          response_format: { type: 'json_object' },
          temperature: 0,
        }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content;
      return content ? JSON.parse(content) : null;
    } catch {
      return null;
    }
  }

  // ── Deterministic behaviour changes (engagement mode + preferences) ──────────
  // Qwen won't reliably make a real MCP tool call through qwen-code's ACP layer
  // (it narrates "I've changed my settings" as text instead). So — exactly like
  // memory and reminders — Engram drives it: detect the intent, extract the
  // structured change via the API, then call the real nanoclaw MCP tool, which
  // writes the system action → host approval → Telegram card. Reliable.

  private maybeBehaviorChange(userText: string): void {
    const cfg = this.mcpServers['nanoclaw'];
    if (!cfg || !userText.trim()) return;
    // Cheap gate — only spend an extraction call on plausibly behaviour-change messages.
    if (
      !/\b(only\s+(reply|respond|answer)|reply\s+only|when\s+(i\s+)?(mention|tag|say|call)|mention\s+me|say\s+your\s+name|call\s+you|your\s+name|don'?t\s+(reply|respond|answer)|always\s+(reply|respond)|stop\s+(replying|responding)|keep\s+(your\s+)?(replies|responses|answers)|be\s+(more\s+)?(concise|brief|short)|one[\s-]?line|in\s+english|no\s+emoji|short(er)?\s+(replies|responses|answers)|from\s+now\s+on)/i.test(
        userText,
      )
    ) {
      return;
    }
    void (async () => {
      try {
        const spec = await this.extractBehaviorJson(userText);
        if (!spec || spec.action === 'none') return;
        if (spec.action === 'set_engagement_mode' && spec.mode) {
          await callMemoryStdioTool(cfg, 'set_engagement_mode', {
            mode: spec.mode,
            ...(spec.pattern ? { pattern: spec.pattern } : {}),
            reason: userText.slice(0, 120),
          });
        } else if (spec.action === 'save_preference' && spec.preference) {
          await callMemoryStdioTool(cfg, 'save_preference', { preference: spec.preference });
        }
      } catch {
        /* best-effort — never blocks a chat turn */
      }
    })();
  }

  /** Focused JSON classification of a behaviour-change request via the API. */
  private async extractBehaviorJson(
    text: string,
  ): Promise<{ action: 'set_engagement_mode' | 'save_preference' | 'none'; mode?: string; pattern?: string; preference?: string } | null> {
    const key = this.env.DASHSCOPE_API_KEY || this.env.OPENAI_API_KEY;
    const base = this.env.OPENAI_BASE_URL || this.env.DASHSCOPE_BASE_URL;
    if (!key || !base) return null;
    const name = this.assistantName || 'Engram';
    const sys =
      `You classify whether a chat message asks the assistant (named "${name}", also addressed as "qwenny") to change its OWN behaviour. ` +
      'Reply STRICT JSON only: ' +
      '{"action":"set_engagement_mode"|"save_preference"|"none","mode":"always"|"mention"|"mention-sticky"|"pattern"|null,"pattern":string|null,"preference":string|null}. ' +
      '- "set_engagement_mode" when the user controls WHEN the bot replies: "only reply when I @mention you" → mode "mention"; "always reply" → "always"; ' +
      '"reply when a message matches X" → "pattern" with the regex in "pattern". ' +
      `- When the user wants you to respond whenever they say your NAME (with or without @) — e.g. "reply when I say your name", "respond when I call you ${name}" — use mode "pattern" and put a CASE-TOLERANT regex matching your name(s) in "pattern", e.g. "[${name[0]!.toUpperCase()}${name[0]!.toLowerCase()}]${name.slice(1)}|[Qq]wenny". Never use inline flags like (?i). ` +
      '- "save_preference" when the user states a lasting style/behaviour preference: "keep replies short" / "answer in English" / "no emoji". ' +
      'Put a clear imperative in "preference" (e.g. "Keep replies to a single line."). ' +
      '- "none" if it is not a request to change the assistant\'s behaviour.';
    try {
      const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: 'qwen-max',
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: text },
          ],
          response_format: { type: 'json_object' },
          temperature: 0,
        }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content;
      return content ? JSON.parse(content) : null;
    } catch {
      return null;
    }
  }

  // ── ACP daemon mode ────────────────────────────────────────────────────────

  private queryAcp(input: QueryInput): AgentQuery {
    const queue = new EventQueue();
    this.writeQwenSettings(input.cwd); // MCP tools reach the model via settings.json, not ACP
    const child = spawn(QWEN_BIN, ['--experimental-acp'], {
      cwd: input.cwd,
      env: this.childEnv(input),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Workspace root — file tools are confined to this subtree (the agent's
    // own /workspace/agent mount), so read/write can't escape into the host.
    const root = path.resolve(input.cwd);
    const confined = (p: string): string => {
      const abs = path.resolve(root, String(p ?? ''));
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        throw new Error(`path outside workspace: ${p}`);
      }
      return abs;
    };

    const rpc = new JsonRpcPeer(child, {
      // The agent asks permission before tool calls; we auto-allow (the host
      // already gates credentialed actions via OneCLI, and runs bypass mode).
      // Note: important host-level changes (engagement mode, preferences,
      // packages) go through approval-gated MCP tools, NOT raw shell — so
      // auto-allowing the agent's own sandboxed tools mirrors Claude's Bash.
      'session/request_permission': async (params) => {
        const options = (params?.options as Array<{ optionId: string; kind?: string }>) ?? [];
        const allow =
          options.find((o) => o.kind === 'allow_always') ??
          options.find((o) => o.kind === 'allow_once') ??
          options[0];
        return { outcome: { outcome: 'selected', optionId: allow?.optionId ?? 'allow' } };
      },
      // Client-side filesystem bridge for Qwen Code's read/write/edit tools,
      // confined to the workspace. Advertised via clientCapabilities.fs below.
      'fs/read_text_file': async (params) => {
        const abs = confined(params?.path as string);
        let text = await fs.promises.readFile(abs, 'utf8');
        const line = Number(params?.line ?? 0);
        const limit = Number(params?.limit ?? 0);
        if (line > 0 || limit > 0) {
          const lines = text.split('\n');
          const start = line > 0 ? line - 1 : 0;
          text = lines.slice(start, limit > 0 ? start + limit : undefined).join('\n');
        }
        return { content: text };
      },
      'fs/write_text_file': async (params) => {
        const abs = confined(params?.path as string);
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, String(params?.content ?? ''), 'utf8');
        return null;
      },
    });

    let aborted = false;
    const instructions = [CONVERSATIONAL_PREAMBLE, input.systemContext?.instructions].filter(Boolean).join('\n\n');

    const run = async () => {
      child.on('error', (e) => queue.push({ type: 'error', message: `qwen spawn failed: ${e.message}`, retryable: false }));
      child.stderr.on('data', (d) => {
        const s = d.toString().trim();
        if (s) {
          // Surface qwen-code's own logs (MCP connection, tool registration,
          // errors) into the container log for diagnosis.
          console.error(`[qwen] ${s}`);
          queue.push({ type: 'activity' });
        }
      });

      try {
        const initRes = (await rpc.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        })) as { authMethods?: Array<{ id?: string }> };

        // ACP requires selecting an auth method before opening a session when
        // the agent advertises any. Qwen Code talks to Model Studio's
        // OpenAI-compatible endpoint via OPENAI_API_KEY (mapped from
        // DASHSCOPE_API_KEY in childEnv) — that's the "openai" method.
        const authMethods = initRes?.authMethods ?? [];
        if (authMethods.length > 0) {
          const methodId =
            authMethods.find((m) => m.id === 'openai')?.id ?? authMethods[0]?.id ?? 'openai';
          await rpc.request('authenticate', { methodId });
        }

        // session/update notifications stream the turn; bridge them to events.
        rpc.onNotification('session/update', (params) => {
          const update = (params?.update ?? {}) as { sessionUpdate?: string; content?: { text?: string } };
          queue.push({ type: 'activity' });
          if (update.sessionUpdate === 'agent_message_chunk' && update.content?.text) {
            queue.pushText(update.content.text);
          } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
            queue.push({ type: 'progress', message: 'working…' });
          }
        });

        const mcpServers = this.acpMcpServers();
        let sessionId: string;
        if (input.continuation) {
          try {
            const loaded = (await rpc.request('session/load', { sessionId: input.continuation, cwd: input.cwd, mcpServers })) as { sessionId?: string };
            sessionId = loaded?.sessionId ?? input.continuation;
          } catch (err) {
            if (this.isSessionInvalid(err)) {
              const created = (await rpc.request('session/new', { cwd: input.cwd, mcpServers })) as { sessionId: string };
              sessionId = created.sessionId;
            } else {
              throw err;
            }
          }
        } else {
          const created = (await rpc.request('session/new', { cwd: input.cwd, mcpServers })) as { sessionId: string };
          sessionId = created.sessionId;
        }
        queue.push({ type: 'init', continuation: sessionId });

        const promptOnce = async (text: string) => {
          queue.beginTurn();
          const clean = this.cleanUserText(text);
          const memory = await this.recallContext(clean);
          const prefs = this.prefsBlock(input.cwd);
          const history = this.recentHistory(clean);
          const now = this.nowBlock(text);
          console.error(`[qwen] ctx → now:${now ? 'y' : 'n'} prefs:${prefs ? 'y' : 'n'} history:${history.split('\n').length - 1}turns memory:${memory.split('\n').length - 1}items`);
          const fullPrompt = [instructions, now, prefs, history, memory, text].filter(Boolean).join('\n\n');
          const res = (await rpc.request('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: fullPrompt }],
          })) as { stopReason?: string };
          queue.endTurn(res?.stopReason, this.formatReply(queue.peekTurn(), text));
          // Only capture/schedule from genuine user messages (rendered as
          // `<message ... sender="...">`). Scheduled-task wakes render as
          // `<task ...>` — capturing them would pollute memory and, worse,
          // re-trigger scheduling (the wake prompt says "remind ..."), looping.
          if (isUserMessage(text)) {
            this.captureTurn(clean, 'telegram');
            this.maybeSchedule(clean, text);
            this.maybeBehaviorChange(clean);
          }
        };

        await promptOnce(input.prompt);
        // Follow-ups via push(); resolved when end()/abort() closes the input.
        for await (const next of queue.inputs()) {
          if (aborted) break;
          await promptOnce(next);
        }
      } catch (err) {
        queue.push({ type: 'error', message: err instanceof Error ? err.message : String(err), retryable: true });
      } finally {
        queue.close();
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      }
    };

    void run();

    return {
      push: (m) => queue.pushInput(m),
      end: () => queue.endInput(),
      events: queue.events(),
      abort: () => {
        aborted = true;
        queue.endInput();
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      },
    };
  }

  // ── one-shot fallback mode ───────────────────────────────────────────────────

  private queryOneShot(input: QueryInput): AgentQuery {
    const queue = new EventQueue();
    this.writeQwenSettings(input.cwd); // MCP tools reach the model via settings.json, not ACP
    let aborted = false;
    let current: ChildProcess | null = null;
    const instructions = [CONVERSATIONAL_PREAMBLE, input.systemContext?.instructions].filter(Boolean).join('\n\n');

    const runPrompt = async (text: string): Promise<void> => {
      const clean = this.cleanUserText(text);
      const memory = await this.recallContext(clean);
      const prefs = this.prefsBlock(input.cwd);
      const history = this.recentHistory(clean);
      const now = this.nowBlock(text);
      const composed = [instructions, now, prefs, history, memory, text].filter(Boolean).join('\n\n');
      await new Promise<void>((resolve) => {
        const args = ['--yolo', '-p', composed];
        if (this.model) args.push('-m', this.model);
        const proc = spawn(QWEN_BIN, args, { cwd: input.cwd, env: this.childEnv(input), stdio: ['ignore', 'pipe', 'pipe'] });
        current = proc;
        let out = '';
        proc.stdout?.on('data', (d) => {
          out += d.toString();
          queue.push({ type: 'activity' });
        });
        proc.on('error', (e) => queue.push({ type: 'error', message: `qwen spawn failed: ${e.message}`, retryable: false }));
        proc.on('close', () => {
          queue.push({ type: 'result', text: this.formatReply(out, text) || null });
          resolve();
        });
      });
      if (isUserMessage(text)) {
        this.captureTurn(clean, 'telegram');
        this.maybeSchedule(clean, text);
        this.maybeBehaviorChange(clean);
      }
    };

    const run = async () => {
      // No persistent session in one-shot; continuation is a synthetic marker.
      queue.push({ type: 'init', continuation: input.continuation ?? `qwen-oneshot-${process.pid}` });
      await runPrompt(input.prompt);
      for await (const next of queue.inputs()) {
        if (aborted) break;
        await runPrompt(next);
      }
      queue.close();
    };
    void run();

    return {
      push: (m) => queue.pushInput(m),
      end: () => queue.endInput(),
      events: queue.events(),
      abort: () => {
        aborted = true;
        queue.endInput();
        current?.kill('SIGKILL');
      },
    };
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private childEnv(input: QueryInput): NodeJS.ProcessEnv {
    // Pass env through (DashScope creds live here, injected by the host/OneCLI).
    // Force Qwen Code to talk to Model Studio's OpenAI-compatible endpoint.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(this.env)) if (v !== undefined) env[k] = v;
    if (env.DASHSCOPE_API_KEY && !env.OPENAI_API_KEY) env.OPENAI_API_KEY = env.DASHSCOPE_API_KEY;
    if (!env.OPENAI_BASE_URL && env.DASHSCOPE_BASE_URL) env.OPENAI_BASE_URL = env.DASHSCOPE_BASE_URL;
    if (this.model) env.QWEN_MODEL = this.model;
    // Qwen Code auto-selects the "openai" auth type ONLY when all three of
    // OPENAI_API_KEY, OPENAI_MODEL, and OPENAI_BASE_URL are present in the env
    // (getAuthTypeFromEnv in modelConfigUtils). The ACP daemon, unlike the
    // oneshot `-p` path, won't fall back to QWEN_MODEL for this check — so we
    // must set OPENAI_MODEL explicitly. Fall back to the group model, then the
    // host-threaded QWEN_MODEL, so a group with no explicit model still works.
    if (!env.OPENAI_MODEL) env.OPENAI_MODEL = this.model || env.QWEN_MODEL;
    void input;
    return env;
  }

  /** Convert the nanoclaw mcpServers map into the ACP session/new shape. */
  private acpMcpServers(): Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }> {
    return Object.entries(this.mcpServers).map(([name, cfg]) => ({
      name,
      command: cfg.command,
      args: cfg.args ?? [],
      env: Object.entries(cfg.env ?? {}).map(([k, v]) => ({ name: k, value: v })),
    }));
  }
}

// ── A tiny event queue bridging callback-style RPC into an async-iterable ──────

class EventQueue {
  private events_: ProviderEvent[] = [];
  private inputs_: string[] = [];
  private resolveEvent: (() => void) | null = null;
  private resolveInput: (() => void) | null = null;
  private closed = false;
  private inputClosed = false;
  private turnText = '';

  push(e: ProviderEvent): void {
    this.events_.push(e);
    this.resolveEvent?.();
  }
  pushText(t: string): void {
    this.turnText += t;
  }
  beginTurn(): void {
    this.turnText = '';
  }
  peekTurn(): string {
    return this.turnText;
  }
  endTurn(stopReason?: string, overrideText?: string): void {
    void stopReason;
    const t = (overrideText ?? this.turnText).trim();
    this.push({ type: 'result', text: t || null });
  }
  close(): void {
    this.closed = true;
    this.resolveEvent?.();
  }

  pushInput(m: string): void {
    this.inputs_.push(m);
    this.resolveInput?.();
  }
  endInput(): void {
    this.inputClosed = true;
    this.resolveInput?.();
  }
  pushInputClose(): void {
    this.endInput();
  }

  events(): AsyncIterable<ProviderEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (self.events_.length > 0) yield self.events_.shift()!;
          if (self.closed) return;
          await new Promise<void>((r) => (self.resolveEvent = r));
          self.resolveEvent = null;
        }
      },
    };
  }

  inputs(): AsyncIterable<string> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (self.inputs_.length > 0) yield self.inputs_.shift()!;
          if (self.inputClosed) return;
          await new Promise<void>((r) => (self.resolveInput = r));
          self.resolveInput = null;
        }
      },
    };
  }
}

// ── Minimal newline-delimited JSON-RPC 2.0 peer over a child process ───────────

type RpcHandler = (params: Record<string, unknown> | undefined) => Promise<unknown>;

class JsonRpcPeer {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private notificationHandlers = new Map<string, (params: Record<string, unknown> | undefined) => void>();
  private buffer = '';

  constructor(
    private child: ChildProcessWithoutNullStreams,
    private requestHandlers: Record<string, RpcHandler> = {},
  ) {
    this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk.toString()));
  }

  private onData(text: string): void {
    this.buffer += text;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore non-JSON log lines on stdout
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    if (typeof msg.id !== 'undefined' && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id as number);
      if (!p) return;
      this.pending.delete(msg.id as number);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string') {
      const params = msg.params as Record<string, unknown> | undefined;
      if (typeof msg.id !== 'undefined' && this.requestHandlers[msg.method]) {
        void this.requestHandlers[msg.method]!(params)
          .then((result) => this.send({ jsonrpc: '2.0', id: msg.id, result }))
          .catch((err) => this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(err) } }));
        return;
      }
      this.notificationHandlers.get(msg.method)?.(params);
    }
  }

  onNotification(method: string, handler: (params: Record<string, unknown> | undefined) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.send({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  private send(msg: Record<string, unknown>): void {
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }
}

registerProvider('qwen', (opts) => new QwenProvider(opts));
