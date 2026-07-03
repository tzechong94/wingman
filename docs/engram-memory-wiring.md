# Wiring the Engram memory MCP server into an agent group

The agent (Qwen Code) reaches the cloud memory layer as an **MCP server** configured in
its agent group's `container.json` `mcpServers`. The server runs inside the agent
container as a stdio subprocess; durable state lives in shared Postgres, so all of a
user's sessions and channels share one memory (cross-channel recall falls out for free).

## The MCP server entry

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/opt/engram/packages/memory/dist/mcp-server.js"],
      "env": {
        "ENGRAM_TENANT_ID": "<owner-user-id>",
        "DATABASE_URL": "postgres://engram:engram@host.docker.internal:5433/engram",
        "QWEN_MOCK": "false",
        "DASHSCOPE_API_KEY": "<key or via OneCLI>",
        "ENGRAM_ENCRYPTION_KEY": "<32-byte hex>"
      }
    }
  }
}
```

Tools exposed: `mcp__memory__write`, `mcp__memory__search`, `mcp__memory__forget`.

**Isolation:** the tenant is taken from `ENGRAM_TENANT_ID` (set per agent group to the
group's owner user id), never from tool arguments. The agent cannot read another tenant's
memory. Set it when provisioning the group.

## Two ways to set it

- `ncl`:
  ```bash
  ncl groups config add-mcp-server --id <group-id> --name memory \
    --command node --args '["/opt/engram/packages/memory/dist/mcp-server.js"]' \
    --env '{"ENGRAM_TENANT_ID":"<tenant>","DATABASE_URL":"...","DASHSCOPE_API_KEY":"...","ENGRAM_ENCRYPTION_KEY":"..."}'
  ```
- Generate the snippet: `node scripts/wire-memory-mcp.mjs <agent-group-id> <tenant-id>`
  from the engram repo prints the exact `ncl` command + JSON for the group.

## Making the package reachable inside the container

The memory package must exist inside the agent container at the `args` path, and
`DATABASE_URL` must reach the shared DB.

- **Local:** add a read-only mount of `packages/memory` (built `dist/` + its
  `node_modules`) via the agent group's `additionalMounts`, and point `DATABASE_URL` at
  `host.docker.internal:5433`. Build the memory package first (`pnpm --filter
  @engram/memory build`).
- **Cloud:** bake the built memory package into the agent image (or publish it to a
  private registry and `pnpm add` it in the image), and point `DATABASE_URL` at AnalyticDB.

## Sleep phase

The sleep worker is **not** wired here — it runs out-of-band (a scheduled process /
Function Compute), operating on the same Postgres. See `deploy/alibaba/README.md`. The
agent only ever touches the online path (write/search/forget) over MCP.
