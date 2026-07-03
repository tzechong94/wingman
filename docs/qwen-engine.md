# Qwen Code engine (Engram)

Engram swaps NanoClaw's embedded engine from Claude to **Qwen Code** (the Gemini-CLI
fork that runs Qwen models), with no routing/middle layer — Qwen Code talks straight to
Model Studio / DashScope. It plugs into the existing provider registry exactly like
`claude` / `opencode` / `codex`.

## How it's wired

- **Provider:** `container/agent-runner/src/providers/qwen.ts`, registered as `qwen` in
  `providers/index.ts`. Implements the standard `AgentProvider` interface.
- **Binary:** `@qwen-code/qwen-code` (bin `qwen`) is installed into the image via
  `container/cli-tools.json` (pinned `0.18.1`), the same pinned-global mechanism used for
  `claude-code`.
- **Select it per agent group:** `ncl groups config update --id <group> --provider qwen`
  (and optionally `--model qwen-max`).

## Invocation modes

Set `QWEN_MODE` (env on the container):

| mode | how | when |
|------|-----|------|
| `acp` (default) | `qwen --experimental-acp` — a persistent agent process speaking the **Agent Client Protocol** (JSON-RPC over stdio). Real streaming → `activity` events, session continuity (`continuation` = ACP `sessionId`), native MCP. | the faithful "like Claude Code" path; what the brief points at |
| `oneshot` | `qwen --yolo -p "<prompt>"`, one process per turn | fallback if the daemon misbehaves |

The provider auto-maps ACP `session/update` chunks → result text + activity, auto-allows
`session/request_permission` (the host already gates credentialed actions via OneCLI), and
resumes via `session/load` (falling back to `session/new` on an invalid session).

## Talking to Model Studio (no middle layer)

The provider forwards env to the `qwen` child and ensures it points at DashScope's
OpenAI-compatible endpoint:

```
DASHSCOPE_API_KEY → OPENAI_API_KEY   (if OPENAI_API_KEY unset)
DASHSCOPE_BASE_URL → OPENAI_BASE_URL (if unset)
model → QWEN_MODEL
```

Set `DASHSCOPE_API_KEY` (and a chat model, e.g. `qwen-max`). With OneCLI, inject the key
as a secret matching `dashscope`/`modelstudio` hosts instead of an env var.

## Memory over MCP

The cloud memory server is handed to Qwen Code as an MCP server in `session/new`
(`mcpServers`), built from the agent group's `container.json` `mcpServers` map. The
conversational system preamble tells the agent to `mcp__memory__search` before personal
answers and `mcp__memory__write` when the user shares something durable. See
`docs/engram-memory-wiring.md`.

## Live validation checklist (first run with a key)

The provider is correct-by-construction and typechecks, but ACP wire details vary by
qwen-code version. On the first live run, confirm:

1. `qwen --experimental-acp` starts and speaks newline-delimited JSON-RPC 2.0 on stdio.
   If it uses Content-Length (LSP-style) framing instead, adjust `JsonRpcPeer.onData` /
   `send` (isolated for this reason).
2. Method names: `initialize`, `session/new`, `session/load`, `session/prompt`, and the
   `session/update` notification + `session/request_permission` request. Adjust if the
   installed version differs (`qwen --experimental-acp --help` / the qwen-code ACP docs).
3. `mcpServers` shape in `session/new` (we send `{name, command, args, env:[{name,value}]}`).

If ACP needs work, set `QWEN_MODE=oneshot` to get a working round-trip immediately while
ACP is tuned.
