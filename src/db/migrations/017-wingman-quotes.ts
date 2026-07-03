import type { Migration } from './index.js';

/**
 * Wingman quote pipeline tables.
 *
 * quotes              — every quote the agent drafted, auto-sent or escalated.
 *                       The audit trail's primary object.
 * conversation_events — mirror-on-delivery event log (messages, reasoning
 *                       events, quotes, approvals). Single query surface for
 *                       the dashboard + analytics; session DBs are never read
 *                       by the web layer.
 * web_visitors        — per-browser demo identities minted by the web channel.
 */
export const migration017: Migration = {
  version: 17,
  name: 'wingman-quotes',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS quotes (
        id                 TEXT PRIMARY KEY,
        session_id         TEXT NOT NULL,
        customer_name      TEXT,
        status             TEXT NOT NULL,
        line_items         TEXT NOT NULL,
        discount_pct       REAL,
        total_cents        INTEGER NOT NULL,
        currency           TEXT NOT NULL DEFAULT 'SGD',
        escalation_reason  TEXT,
        escalation_details TEXT,
        confidence         REAL,
        notes              TEXT,
        approval_id        TEXT,
        pdf_file           TEXT,
        created_at         TEXT NOT NULL,
        resolved_at        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_quotes_created ON quotes(created_at);
      CREATE INDEX IF NOT EXISTS idx_quotes_session ON quotes(session_id);

      CREATE TABLE IF NOT EXISTS conversation_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        ts         TEXT NOT NULL,
        type       TEXT NOT NULL,
        actor      TEXT,
        payload    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_convevents_session ON conversation_events(session_id, id);
      CREATE INDEX IF NOT EXISTS idx_convevents_ts ON conversation_events(ts);

      CREATE TABLE IF NOT EXISTS web_visitors (
        visitor_id         TEXT PRIMARY KEY,
        messaging_group_id TEXT NOT NULL,
        session_id         TEXT,
        created_at         TEXT NOT NULL,
        last_seen          TEXT NOT NULL,
        message_count      INTEGER NOT NULL DEFAULT 0
      );
    `);
  },
};
