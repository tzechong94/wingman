#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Wingman — Alibaba Cloud ECS bootstrap (Ubuntu 22.04)
#
# PROOF OF ALIBABA CLOUD DEPLOYMENT for the Qwen Cloud Global AI Hackathon:
# Wingman runs on a single Alibaba Cloud ECS instance and calls Alibaba
# Cloud Model Studio (DashScope) for every model interaction —
#   qwen-max     conversation + quote extraction (container/agent-runner/src/quotes/extractor.ts)
#   qwen-vl-max  photo → unit identification     (container/agent-runner/src/quotes/vision.ts)
#   qwen-turbo   Engram memory operations        (~engram/packages/memory)
#
# One-shot setup — run as a sudo-capable user on a fresh ECS VM
# (8 vCPU / 16GB recommended; ESSD ≥60GB; security group: 22, 80, 443):
#
#   curl -fsSL https://raw.githubusercontent.com/tzechong94/wingman/main/deploy/alibaba/bootstrap.sh | bash
#
# Installs Docker + Node 22 + pnpm + Bun + Caddy, clones wingman AND engram
# (the memory layer), prepares both .env files. Then: edit ~/wingman/.env
# (DASHSCOPE_API_KEY, TELEGRAM_BOT_TOKEN) and run deploy.sh.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

WINGMAN_REPO="${WINGMAN_REPO:-https://github.com/tzechong94/wingman.git}"
ENGRAM_REPO="${ENGRAM_REPO:-https://github.com/tzechong94/engram.git}"

log() { printf "\033[36m▸ %s\033[0m\n" "$1"; }

log "Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER" || true
fi

log "Installing Node 22 + pnpm"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo corepack enable && corepack prepare pnpm@latest --activate || sudo npm i -g pnpm

log "Installing Bun (agent-runner runtime)"
command -v bun >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash

log "Installing Caddy (TLS + same-origin fronting)"
if ! command -v caddy >/dev/null 2>&1; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update && sudo apt-get install -y caddy
fi

log "Cloning Engram (memory layer)"
[ -d "$HOME/engram" ] || git clone "$ENGRAM_REPO" "$HOME/engram"

log "Cloning Wingman"
[ -d "$HOME/wingman" ] || git clone "$WINGMAN_REPO" "$HOME/wingman"

log "Preparing .env files"
[ -f "$HOME/wingman/.env" ] || cat > "$HOME/wingman/.env" <<'ENV'
# ── Alibaba Cloud Model Studio (DashScope) ──
DASHSCOPE_API_KEY=
DASHSCOPE_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
QWEN_CHAT_MODEL=qwen-max

# ── Channels ──
TELEGRAM_BOT_TOKEN=
NANOCLAW_NATIVE_CREDENTIALS=true

# ── Wingman demo ──
WINGMAN_OPEN_DEMO=true
WINGMAN_GROUP_FOLDER=coolbreeze
ENGRAM_REPO_ROOT=~/engram
# Linux: agent containers reach Engram's Postgres via the docker bridge
ENGRAM_DATABASE_URL=postgres://engram:engram@172.17.0.1:5433/engram
ENV

echo
log "Bootstrap complete. Next:"
echo "  1. nano ~/wingman/.env   # DASHSCOPE_API_KEY + TELEGRAM_BOT_TOKEN"
echo "  2. cd ~/wingman && bash deploy/alibaba/deploy.sh"
