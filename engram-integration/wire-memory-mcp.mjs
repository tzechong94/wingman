#!/usr/bin/env node
/**
 * Emit the exact `ncl` command + container.json mcpServers snippet to wire the
 * Engram memory MCP server into an agent group, scoped to a tenant. Does not
 * mutate anything — prints, so the operator runs the ncl command deliberately.
 *
 *   node scripts/wire-memory-mcp.mjs <agent-group-id> <tenant-id> [mcp-server-abs-path]
 */
import path from 'node:path';

const [, , groupId, tenantId, mcpPathArg] = process.argv;
if (!groupId || !tenantId) {
  console.error('usage: node scripts/wire-memory-mcp.mjs <agent-group-id> <tenant-id> [mcp-server-abs-path]');
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const mcpPath = mcpPathArg || path.join(repoRoot, 'packages/memory/dist/mcp-server.js');

const env = {
  ENGRAM_TENANT_ID: tenantId,
  DATABASE_URL: process.env.DATABASE_URL || 'postgres://engram:engram@host.docker.internal:5433/engram',
  QWEN_MOCK: process.env.QWEN_MOCK || 'false',
  DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY || '<set-or-use-onecli>',
  ENGRAM_ENCRYPTION_KEY: process.env.ENGRAM_ENCRYPTION_KEY || '<32-byte-hex>',
};

const snippet = { memory: { command: 'node', args: [mcpPath], env } };

console.log('# container.json mcpServers entry:');
console.log(JSON.stringify(snippet, null, 2));
console.log('\n# ncl command (run from the nanoclaw-v2 dir):');
console.log(
  `ncl groups config add-mcp-server --id ${groupId} --name memory \\\n` +
    `  --command node --args '${JSON.stringify([mcpPath])}' \\\n` +
    `  --env '${JSON.stringify(env)}'`,
);
console.log('\n# Then restart the group:  ncl groups restart --id ' + groupId);
