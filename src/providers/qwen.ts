/**
 * Qwen provider host-side container config (Engram).
 *
 * The container-side QwenProvider (container/agent-runner/src/providers/qwen.ts)
 * talks to Qwen via the Model Studio / DashScope OpenAI-compatible endpoint. It
 * reads its credentials from the container's own env: DASHSCOPE_API_KEY,
 * DASHSCOPE_BASE_URL, QWEN_MODEL (and optional QWEN_MODE / QWEN_BIN). None of
 * those are NanoClaw-internal, so they don't live in container.json — they have
 * to be threaded in as `-e` vars at spawn time. That's this file's whole job.
 *
 * Unlike the OneCLI path (where the real secret never enters the container),
 * this passes the DashScope key straight into the container env. That's the
 * same tradeoff the use-native-credential-proxy skill makes for Anthropic keys,
 * and it's the simple, local-dev-friendly choice for the hackathon. The key
 * lives in .env on the host and is gitignored.
 *
 * Reads from .env (via core's readEnvFile, not process.env, so it works the
 * same whether or not the host shell exported these):
 *   - DASHSCOPE_API_KEY    (required for real Qwen)
 *   - DASHSCOPE_BASE_URL   (OpenAI-compatible base, e.g. .../compatible-mode/v1)
 *   - QWEN_MODEL           (falls back to QWEN_CHAT_MODEL, then qwen-turbo)
 *   - QWEN_MODE            (optional: "oneshot" forces the non-daemon path)
 *   - QWEN_BIN             (optional: override the qwen binary path)
 */
import path from 'path';

import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('qwen', () => {
  const dotenv = readEnvFile([
    'DASHSCOPE_API_KEY',
    'DASHSCOPE_BASE_URL',
    'QWEN_MODEL',
    'QWEN_CHAT_MODEL',
    'QWEN_MODE',
    'QWEN_BIN',
    'ENGRAM_REPO_ROOT',
    'CALCOM_API_KEY',
    'CALCOM_EVENT_TYPE_ID',
    'CALCOM_API_BASE',
    'CALCOM_TIMEZONE',
  ]);

  const env: Record<string, string> = {};

  if (dotenv.DASHSCOPE_API_KEY) env.DASHSCOPE_API_KEY = dotenv.DASHSCOPE_API_KEY;
  if (dotenv.DASHSCOPE_BASE_URL) env.DASHSCOPE_BASE_URL = dotenv.DASHSCOPE_BASE_URL;

  // The container provider keys on QWEN_MODEL; our .env standard is
  // QWEN_CHAT_MODEL. Bridge it so either works, defaulting to the cheap model.
  const model = dotenv.QWEN_MODEL || dotenv.QWEN_CHAT_MODEL || 'qwen-turbo';
  env.QWEN_MODEL = model;

  if (dotenv.QWEN_MODE) env.QWEN_MODE = dotenv.QWEN_MODE;
  if (dotenv.QWEN_BIN) env.QWEN_BIN = dotenv.QWEN_BIN;

  // cal.com real-availability tool (container-side driver call); unset = off.
  if (dotenv.CALCOM_API_KEY) env.CALCOM_API_KEY = dotenv.CALCOM_API_KEY;
  if (dotenv.CALCOM_EVENT_TYPE_ID) env.CALCOM_EVENT_TYPE_ID = dotenv.CALCOM_EVENT_TYPE_ID;
  if (dotenv.CALCOM_API_BASE) env.CALCOM_API_BASE = dotenv.CALCOM_API_BASE;
  if (dotenv.CALCOM_TIMEZONE) env.CALCOM_TIMEZONE = dotenv.CALCOM_TIMEZONE;

  // The Engram memory MCP server runs INSIDE the container (qwen-code spawns it
  // as a stdio subprocess) but its command is a host path —
  // `node <repo>/packages/memory/dist/mcp-server.js`. Mount the Engram repo at
  // the same path read-only so that path and its node_modules (pnpm workspace
  // symlinks resolve within the tree) exist in the container. Without this the
  // MCP server can't start and the memory tools silently do nothing.
  // ENGRAM_REPO_ROOT overrides the default (parent of the nanoclaw project dir)
  // for non-standard layouts / cloud.
  const repoRoot = dotenv.ENGRAM_REPO_ROOT || path.resolve(process.cwd(), '..');
  const mounts = [{ hostPath: repoRoot, containerPath: repoRoot, readonly: true }];

  return { env, mounts };
});
