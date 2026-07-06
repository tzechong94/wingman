#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Wingman — deploy/redeploy on the Alibaba Cloud ECS VM.
#
# Idempotent. Brings up: Engram stack (Postgres+pgvector, Redis, MinIO) →
# agent container image → migrations + CoolBreeze seed → host (systemd) →
# dashboard (next build + systemd) → Caddy (one origin: / → dashboard,
# /webhook/* → host) → smoke check → behavioral evals (optional).
#
#   bash deploy/alibaba/deploy.sh [--skip-evals] [--domain your.domain.tld]
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

DOMAIN=""
SKIP_EVALS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --skip-evals) SKIP_EVALS=1; shift ;;
    *) echo "unknown flag $1"; exit 2 ;;
  esac
done

log()  { printf "\033[36m▸ %s\033[0m\n" "$1"; }
fail() { printf "\033[31m✗ %s\033[0m\n" "$1"; exit 1; }

[ -f .env ] || fail ".env missing — run bootstrap.sh first"
grep -q '^DASHSCOPE_API_KEY=.' .env || fail "DASHSCOPE_API_KEY not set in .env"

log "1/8 Engram stack (Postgres+pgvector, Redis, MinIO)"
( cd ~/engram
  [ -f .env ] || cp .env.example .env 2>/dev/null || touch .env
  docker compose up -d
  pnpm install --frozen-lockfile
  # workspace build order matters: memory imports types from shared/dist
  pnpm --filter @engram/shared build
  pnpm --filter @engram/memory build
)
# encryption key shared via wingman/.env (bootstrap may not have set engram's)
grep -q '^ENGRAM_ENCRYPTION_KEY=.' .env || printf "ENGRAM_ENCRYPTION_KEY=%s\n" "$(openssl rand -hex 32)" >> .env

log "2/8 Wingman host dependencies + build"
pnpm install --frozen-lockfile
pnpm run build
( cd container/agent-runner && bun install )

log "3/8 Agent container image"
./container/build.sh

log "4/8 Migrations + CoolBreeze seed (persona-as-data + Engram histories)"
pnpm exec tsx scripts/seed-coolbreeze.ts

log "5/8 systemd units (host + dashboard)"
sudo tee /etc/systemd/system/wingman-host.service >/dev/null <<UNIT
[Unit]
Description=Wingman host (NanoClaw fork)
After=network-online.target docker.service
[Service]
User=$USER
WorkingDirectory=$HOME/wingman
ExecStart=$(command -v pnpm) exec tsx src/index.ts
Restart=always
RestartSec=5
Environment=NODE_ENV=production
[Install]
WantedBy=multi-user.target
UNIT

log "5b/8 Dashboard build"
pnpm --filter dashboard build
sudo tee /etc/systemd/system/wingman-dashboard.service >/dev/null <<UNIT
[Unit]
Description=Wingman dashboard (Next.js)
After=network-online.target
[Service]
User=$USER
WorkingDirectory=$HOME/wingman/dashboard
ExecStart=$(command -v pnpm) exec next start -p 3101
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=WINGMAN_HOST_ORIGIN=http://127.0.0.1:3000
[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now wingman-host wingman-dashboard
sudo systemctl restart wingman-host wingman-dashboard

log "6/8 Caddy (one origin — cookies + SSE just work)"
SITE="${DOMAIN:-:80}"
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
$SITE {
  encode gzip
  # SSE + API straight to the host — never buffered through Next.js
  handle /webhook/* {
    reverse_proxy 127.0.0.1:3000 {
      flush_interval -1
    }
  }
  handle {
    reverse_proxy 127.0.0.1:3101
  }
}
CADDY
sudo systemctl reload caddy || sudo systemctl restart caddy

log "7/8 Smoke check"
sleep 8
curl -sf http://127.0.0.1:3000/webhook/web/health >/dev/null || fail "host health check failed"
curl -sf http://127.0.0.1:3101/ >/dev/null || fail "dashboard not serving"
curl -sf "http://127.0.0.1:${DOMAIN:+443}${DOMAIN:-80}/" >/dev/null 2>&1 || curl -sf http://127.0.0.1/ >/dev/null || true

if [ "$SKIP_EVALS" = "0" ]; then
  log "8/8 Behavioral evals against this deployment (13 scenarios, ~8 min)"
  pnpm exec tsx scripts/evals.ts || fail "evals failed — do not submit until green"
else
  log "8/8 Evals skipped (--skip-evals)"
fi

echo
log "DEPLOYED ✅  ${DOMAIN:+https://$DOMAIN}${DOMAIN:-http://<this-vm-ip>}"
echo "  Judge script: see README.md → 'Try it in 90 seconds'"
