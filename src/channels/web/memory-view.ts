/**
 * Read-only window into Engram memory for the dashboard's Memory page —
 * judges see WHAT the agent remembers (episodes, consolidated semantic
 * notes, salient entities) for the demo tenant.
 *
 * Engram's Postgres runs as a sibling Docker container; the host has no pg
 * client dependency, so we shell `docker exec … psql` with json_agg output.
 * Read-only queries, demo-scale, cached briefly. If the container is absent
 * the page degrades to an explanatory empty state.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

import { log } from '../../log.js';

const execFileAsync = promisify(execFile);

const PG_CONTAINER = process.env.ENGRAM_PG_CONTAINER || 'engram-postgres-1';
const CACHE_MS = 5_000;

export interface MemorySnapshot {
  available: boolean;
  tenant: string;
  episodes: Array<{
    content: string;
    source_channel: string;
    importance: number;
    access_count: number;
    pinned: boolean;
    status: string;
    created_at: string;
    last_accessed_at: string;
  }>;
  notes: Array<{
    title: string;
    body: string;
    confidence: number;
    kind: string;
    updated_at: string;
  }>;
  entities: Array<{ name: string; type: string; salience: number }>;
}

let cache: { at: number; tenant: string; snap: MemorySnapshot } | null = null;

async function pgJson(sql: string): Promise<unknown> {
  const { stdout } = await execFileAsync(
    'docker',
    ['exec', PG_CONTAINER, 'psql', '-U', 'engram', '-d', 'engram', '-t', '-A', '-c', sql],
    { timeout: 10_000 },
  );
  const raw = stdout.trim();
  return raw ? JSON.parse(raw) : [];
}

/** $-free string literal for the tenant (it comes from our own config, but be tidy). */
function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export async function getMemorySnapshot(tenant: string): Promise<MemorySnapshot> {
  if (cache && cache.tenant === tenant && Date.now() - cache.at < CACHE_MS) return cache.snap;

  try {
    const [episodes, notes, entities] = await Promise.all([
      pgJson(
        `SELECT COALESCE(json_agg(t), '[]'::json) FROM (
           SELECT content, source_channel, importance, access_count, pinned, status,
                  created_at, last_accessed_at
           FROM episodes WHERE tenant_id = ${lit(tenant)} AND status != 'deleted'
           ORDER BY last_accessed_at DESC LIMIT 100) t`,
      ),
      pgJson(
        `SELECT COALESCE(json_agg(t), '[]'::json) FROM (
           SELECT title, body, confidence, kind, updated_at
           FROM semantic_notes WHERE tenant_id = ${lit(tenant)} AND superseded_by IS NULL
           ORDER BY updated_at DESC LIMIT 50) t`,
      ),
      pgJson(
        `SELECT COALESCE(json_agg(t), '[]'::json) FROM (
           SELECT name, type, salience FROM entities WHERE tenant_id = ${lit(tenant)}
           ORDER BY salience DESC LIMIT 40) t`,
      ),
    ]);

    const snap: MemorySnapshot = {
      available: true,
      tenant,
      episodes: episodes as MemorySnapshot['episodes'],
      notes: notes as MemorySnapshot['notes'],
      entities: entities as MemorySnapshot['entities'],
    };
    cache = { at: Date.now(), tenant, snap };
    return snap;
    // eslint-disable-next-line no-catch-all/no-catch-all -- the memory page must degrade to an empty state, not 500, when the Engram container is absent
  } catch (err) {
    log.warn('Memory snapshot unavailable', { container: PG_CONTAINER, err });
    return { available: false, tenant, episodes: [], notes: [], entities: [] };
  }
}
