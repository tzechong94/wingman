# Engram: Agent Setup & Cloud Deployment

How to run the full conversational agent (Qwen Code + memory on Telegram/WhatsApp), and
how it deploys to Alibaba. The hero (memory + viewer) is `./engram.sh`; this is the agent
half built on the NanoClaw runtime.

## What's reused vs new
- **Reused from nanoclaw (we build none of this):** Telegram + WhatsApp (Baileys) adapters,
 routing, per-session containers, multi-tenancy, the `ncl` admin CLI.
- **Engram-specific:** the Qwen Code engine (`qwen` provider), the memory MCP wiring, the
 viewer. That's all.

## Credentials (the model)
One **operator-held** DashScope key for the whole service, users enter nothing, they just
message the bot. No OneCLI, nothing exposed to users. We use nanoclaw's **native credential
proxy** so the agent reads `DASHSCOPE_API_KEY` from `.env` (cloud: from KMS).
- Run once: nanoclaw's `/use-native-credential-proxy` skill (or set the env it expects).
- OneCLI stays an optional, operator-side, server-only add-on for later per-user tool OAuth
 (Gmail etc.), never user-facing, never an exposed localhost.

## Local agent bring-up

`./engram.sh agent` automates the deterministic parts and guides the human bits:
1. ensures the hero infra is up (Postgres etc.) + migrations + build
2. installs nanoclaw runtime deps
3. builds the agent container image (bakes in Qwen Code)
4. ensures `DASHSCOPE_API_KEY` is wired for the container (native proxy)
5. prints the guided steps below and offers to start the host

The guided steps (need human input / are agent-driven skills in nanoclaw):
- **Install a channel:** in the nanoclaw agent, run `/add-telegram` (paste a bot token from @BotFather)
 and/or `/add-whatsapp` (scan the QR). These fetch nanoclaw's adapter code + build.
- **Create the agent + wire it:** `/init-first-agent` (picks the channel, creates the agent
 group, wires the DM). Then set the engine: `ncl groups config update --id <group> --provider qwen --model qwen-max`.
- **Attach memory:** `bash scripts/install-engram-memory.sh <group-id> <tenant-id>`, wires
 the Engram memory MCP into that agent group (stdio transport; see below).
- **Start the host:** `cd nanoclaw-v2 && pnpm run dev` (or the launchd/systemd service).

DM the bot → it reasons on Qwen, recalls/writes via Engram memory, and consolidates during
downtime (watch it in the viewer at :8080).

## How the agent reaches memory (stdio now, HTTP later)
- **Now (stdio):** the memory MCP server runs as a subprocess inside each agent container
 (`{command, args, env}` in `container.json`), connecting to Postgres, scoped by
 `ENGRAM_TENANT_ID`. Simplest; fine up to modest concurrency. Like `add-mnemon`.
- **At scale (HTTP):** one long-lived memory service; agents connect over HTTP with a
 per-tenant token; it pools DB connections. Same MCP protocol, same memory core, same
 schema, switching is a transport/config swap, not a rewrite. The installer writes the
 config in a transport-agnostic way so this is a drop-in upgrade.

## Cloud deployment (Alibaba): v1 shape

```
 Telegram (poll, outbound) ─┐ ┌─────────────────────────────┐
 WhatsApp (Baileys WS) ─┤ │ AnalyticDB for PostgreSQL │
 ▼ │ (pgvector) = MEMORY (moat) │◀─ the scored hero
 ┌──────────────────────────────────┐ └──────────────┬──────────────┘
 │ ECS VM (Docker) │──MCP (stdio)───▶│
 │ nanoclaw host → per-session │ per container │
 │ Qwen Code agent containers │ │
 │ DashScope key from KMS │ ┌─────────────▼──────────────┐
 │ state = SQLite on ESSD (+snaps) │ │ Sleep worker (FC+EventBridge│
 └───────────────┬───────────────────┘ │ or VM cron) → REM cycle │
 │ └─────────────────────────────┘
 ┌────────▼─────────┐ OSS = cold archive + WhatsApp session creds
 │ Viewer (SLB+token)│ KMS = DashScope key + encryption key + channel tokens
 └───────────────────┘ Tair (optional hot tier)
```

**Why a VM, not serverless:** nanoclaw spawns a Docker container per session, so the runtime
needs Docker → an ECS VM. Function Compute can't spawn sibling containers. The VM runs
exactly like local, scales vertically. (Horizontal scale = nanoclaw spawning k8s pods on
ACK, a real change, deferred.)

**Multi-tenant:** each end user = a nanoclaw user → own agent group → own memory tenant, all
on the shared VM, isolated by per-session containers + tenant-scoped memory. One operator
DashScope key.

**Steps:** provision ECS (Docker) + AnalyticDB (enable `vector`) + OSS + KMS → put secrets in
KMS → `DATABASE_URL` at AnalyticDB, run migrations → build/push the agent image → deploy the
viewer (SLB + token) → EventBridge→FC (or cron) for the sleep cycle → start the nanoclaw host
on the VM → install channels + wire the first agent + memory. `deploy/alibaba/` has the
config-swap scaffold.

## Decisions locked (this iteration)
- Single ECS VM + Docker; ESSD + snapshots for nanoclaw state durability.
- Memory: stdio MCP now; HTTP service is the documented scale-out upgrade.
- WhatsApp: Baileys (demo/personal). For a public product, switch to WhatsApp Business
 Cloud API (`/add-whatsapp-cloud`), official, webhook via API Gateway, no ToS/ban risk.
- Credentials: native `.env`/KMS, one operator key, no OneCLI, nothing exposed to users.

## Honest gates (need your inputs / a live run)
- A real DashScope key (the Qwen Code engine needs it; the memory layer can mock, the agent
 cannot).
- A Telegram bot token / WhatsApp QR scan (human steps).
- The agent container build + one Qwen Code ACP validation pass (`QWEN_MODE=oneshot`
 fallback documented in `nanoclaw-v2/docs/qwen-engine.md`).
