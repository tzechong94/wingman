/**
 * Reset the demo to a clean judging state: remove all LIVE web-visitor
 * conversations (test residue), keep the coherent seeded history.
 *
 *   - deletes conversation_events + quotes for non-seed sessions
 *   - clears web_visitors, closes their sessions
 *   - kills running demo containers
 *
 * Seeded history (seed-sess-*) and business config are untouched. Run
 * scripts/seed-coolbreeze.ts after if you also want seeds regenerated.
 *
 * Usage: pnpm exec tsx scripts/reset-demo.ts
 */
import { execSync } from 'child_process';
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';

const db = initDb(path.join(DATA_DIR, 'v2.db'));
runMigrations(db);

const events = db.prepare("DELETE FROM conversation_events WHERE session_id NOT LIKE 'seed-sess-%'").run().changes;
const quotes = db.prepare("DELETE FROM quotes WHERE session_id NOT LIKE 'seed-sess-%'").run().changes;
const approvals = db
  .prepare("UPDATE pending_approvals SET status = 'expired' WHERE status = 'pending' AND action IN ('send_quote','send_nudge')")
  .run().changes;
const sessions = db
  .prepare(
    `UPDATE sessions SET status = 'closed'
     WHERE status = 'active' AND messaging_group_id IN (SELECT id FROM messaging_groups WHERE channel_type = 'web')`,
  )
  .run().changes;
const visitors = db.prepare('DELETE FROM web_visitors').run().changes;

try {
  execSync("docker ps --format '{{.Names}}' | grep coolbreeze | xargs -I{} docker kill {} 2>/dev/null || true", {
    stdio: 'ignore',
    shell: '/bin/bash',
  });
} catch {
  /* no containers running */
}

console.log(
  `✓ Demo reset: ${events} events, ${quotes} quotes removed; ${approvals} stale approvals expired; ${sessions} web sessions closed; ${visitors} visitors cleared.`,
);
console.log('  Seeded history untouched. Judges start from a clean, coherent inbox.');
