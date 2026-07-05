/**
 * HTTP surface for the web channel + dashboard, registered as ONE raw
 * handler at /webhook/web (the webhook server routes on the first path
 * segment only — sub-routing happens here).
 *
 *   POST /webhook/web/session            mint visitor (sets visitor cookie)
 *   POST /webhook/web/message            { text, attachments? } from the visitor
 *   GET  /webhook/web/events             SSE — visitor: own session; owner: firehose
 *   GET  /webhook/web/transcript         replay own session (visitor) or ?sessionId= (owner)
 *   POST /webhook/web/auth               { token } → owner cookie
 *   GET  /webhook/web/approvals          pending + recent approvals (owner)
 *   POST /webhook/web/approvals/:id      { decision: approve|reject } (owner)
 *   GET  /webhook/web/analytics          stat tiles (owner)
 *   GET  /webhook/web/conversations      visitor list + latest activity (owner)
 *   GET  /webhook/web/quotes             recent quotes (owner)
 *   POST /webhook/web/reset              fresh session for this visitor
 *   POST /webhook/web/timewarp           { sessionId } pull follow-up tasks due now (owner)
 *   GET  /webhook/web/file/:visitor/:f   served files (owning visitor or owner)
 *   GET  /webhook/web/health             smoke check
 *
 * Security model (demo-grade, honestly labeled): owner routes need the
 * WINGMAN_DEMO_TOKEN exchanged for an httpOnly cookie; visitor routes need
 * the httpOnly visitor cookie minted with the session. Body size capped
 * BEFORE buffering. Production swaps the token for real login mapped to
 * user_roles — the approval dispatch underneath already enforces roles.
 */
import fs from 'fs';
import type http from 'http';
import path from 'path';

import { getSession } from '../../db/sessions.js';
import { getPendingApproval, getPendingApprovalsByAction } from '../../db/sessions.js';
import {
  bumpWebVisitorMessages,
  getAnalyticsTiles,
  getConvEvents,
  getRecentConvEvents,
  getWebVisitor,
  listQuotes,
} from '../../db/quotes.js';
import { getDb } from '../../db/connection.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { openInboundDb } from '../../session-manager.js';
import { wakeContainer } from '../../container-runner.js';
import { registerWebhookHandler } from '../../webhook-server.js';
import {
  DEMO_OWNER_USER_ID,
  WEB_FILES_DIR,
  currentSessionOf,
  inboundFromVisitor,
  mintVisitor,
  ownerReplyToSession,
  resetVisitor,
  resolveApprovalFromDashboard,
} from './adapter.js';
import { getMemorySnapshot } from './memory-view.js';
import { attachSse } from './sse.js';

const MAX_BODY_BYTES = 6 * 1024 * 1024; // images ≤5MB + JSON envelope
const VISITOR_MSG_CAP = parseInt(process.env.WINGMAN_VISITOR_MSG_CAP || '30', 10);
const VISITOR_COOKIE = 'wingman_visitor';
const OWNER_COOKIE = 'wingman_owner';

type Req = http.IncomingMessage;
type Res = http.ServerResponse;

/* ── small helpers ── */

function json(res: Res, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function cookies(req: Req): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function setCookie(name: string, value: string): string {
  // Path=/ so both the Next.js app and /webhook/web/* see it. SameSite=Lax
  // is enough — everything is same-origin behind Caddy.
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;
}

/** Buffer a request body with a hard cap enforced BEFORE buffering completes. */
function readBody(req: Req): Promise<Buffer | 'too_large'> {
  return new Promise((resolve, reject) => {
    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared > MAX_BODY_BYTES) {
      resolve('too_large');
      req.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve('too_large');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req: Req, res: Res): Promise<Record<string, unknown> | null> {
  const body = await readBody(req);
  if (body === 'too_large') {
    json(res, 413, { error: 'Request too large — photos up to 5MB only.' });
    return null;
  }
  try {
    return JSON.parse(body.toString('utf8') || '{}') as Record<string, unknown>;
  } catch {
    json(res, 400, { error: 'Invalid JSON body.' });
    return null;
  }
}

let cachedToken: string | null = null;
function ownerToken(): string {
  if (cachedToken === null) {
    cachedToken = process.env.WINGMAN_DEMO_TOKEN || readEnvFile(['WINGMAN_DEMO_TOKEN']).WINGMAN_DEMO_TOKEN || '';
  }
  return cachedToken;
}

let cachedOpenDemo: boolean | null = null;
/** Hackathon mode: WINGMAN_OPEN_DEMO=true makes the business view public —
 *  judges self-serve with zero friction. Customer chats stay per-visitor
 *  (the dashboard filters by its own session). Unset it after judging to
 *  restore the demo-token gate. */
function openDemo(): boolean {
  if (cachedOpenDemo === null) {
    const v = process.env.WINGMAN_OPEN_DEMO || readEnvFile(['WINGMAN_OPEN_DEMO']).WINGMAN_OPEN_DEMO || '';
    cachedOpenDemo = v.toLowerCase() === 'true';
  }
  return cachedOpenDemo;
}

function isOwner(req: Req): boolean {
  if (openDemo()) return true;
  const token = ownerToken();
  return token !== '' && cookies(req)[OWNER_COOKIE] === token;
}

function visitorId(req: Req): string | null {
  return cookies(req)[VISITOR_COOKIE] || null;
}

/* ── route handlers ── */

async function handle(req: Req, res: Res): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  // Path after /webhook/web — e.g. '/message', '/approvals/appr-1', '/file/v-1/q.pdf'
  const sub = url.pathname.replace(/^\/webhook\/web\/?/, '/');
  const method = req.method || 'GET';
  const route = `${method} ${sub.split('/')[1] || ''}`;

  try {
    switch (route) {
      case 'GET health': {
        json(res, 200, { ok: true, ts: new Date().toISOString() });
        return;
      }

      case 'POST auth': {
        const body = await readJson(req, res);
        if (!body) return;
        const token = ownerToken();
        if (!token) {
          json(res, 503, { error: 'WINGMAN_DEMO_TOKEN is not configured on the host.' });
          return;
        }
        if (body.token !== token) {
          json(res, 401, { error: 'Wrong demo token.' });
          return;
        }
        json(res, 200, { ok: true, userId: DEMO_OWNER_USER_ID }, { 'Set-Cookie': setCookie(OWNER_COOKIE, token) });
        return;
      }

      case 'POST session': {
        const existing = visitorId(req);
        const forceNew = url.searchParams.get('new') === '1';
        if (existing && getWebVisitor(existing) && forceNew) {
          const fresh = resetVisitor(existing);
          if (fresh) {
            json(res, 200, { ...fresh, existing: true });
            return;
          }
        }
        if (existing && getWebVisitor(existing)) {
          const session = currentSessionOf(existing);
          if (session && session.status === 'active') {
            json(res, 200, { visitorId: existing, sessionId: session.id, existing: true });
            return;
          }
          // Returning browser whose session was closed (idle reap, reset,
          // restart): mint a fresh session for the SAME visitor instead of
          // returning sessionId:null — which the client reads as an outage.
          const revived = resetVisitor(existing);
          if (revived) {
            json(res, 200, { ...revived, existing: true });
            return;
          }
        }
        const minted = mintVisitor();
        json(res, 201, minted, { 'Set-Cookie': setCookie(VISITOR_COOKIE, minted.visitorId) });
        return;
      }

      case 'POST message': {
        const vid = visitorId(req);
        if (!vid || !getWebVisitor(vid)) {
          json(res, 401, { error: 'No visitor session — reload the page.' });
          return;
        }
        const body = await readJson(req, res);
        if (!body) return;
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        const attachments = Array.isArray(body.attachments)
          ? (body.attachments as Array<{ mimeType?: unknown; data?: unknown }>)
              .filter((a) => typeof a.mimeType === 'string' && typeof a.data === 'string')
              .map((a) => ({ mimeType: a.mimeType as string, data: a.data as string }))
          : undefined;
        if (!text && !attachments?.length) {
          json(res, 400, { error: 'Say something (or attach a photo).' });
          return;
        }
        for (const a of attachments ?? []) {
          if (!a.mimeType.startsWith('image/') || a.mimeType === 'image/svg+xml') {
            json(res, 400, { error: 'Photos only (JPEG/PNG/WebP), up to 5MB.' });
            return;
          }
        }
        const count = bumpWebVisitorMessages(vid);
        if (count === 1 && text) {
          // First message of a new web conversation → owner heads-up.
          const session = currentSessionOf(vid);
          if (session) {
            const { notifyOwnerFyi } = await import('../../modules/quotes/actions.js');
            void notifyOwnerFyi(
              session,
              `\u{1F4AC} New web inquiry (chat #${session.id.slice(-6)})\n\u201c${text.slice(0, 240)}\u201d\n\nWingman is handling it \u2014 you'll hear from me if it needs you.`,
            );
          }
        }
        if (count > VISITOR_MSG_CAP) {
          json(res, 429, {
            error: `Demo limit reached (${VISITOR_MSG_CAP} messages). Use Reset demo to start a fresh conversation.`,
          });
          return;
        }
        inboundFromVisitor(vid, text, attachments);
        json(res, 202, { ok: true });
        return;
      }

      case 'GET events': {
        if (isOwner(req)) {
          attachSse(req, res, null);
          return;
        }
        const vid = visitorId(req);
        const session = vid ? currentSessionOf(vid) : undefined;
        if (!session) {
          json(res, 401, { error: 'No visitor session.' });
          return;
        }
        attachSse(req, res, session.id);
        return;
      }

      case 'GET transcript': {
        const afterId = parseInt(url.searchParams.get('after') || '0', 10) || 0;
        const requested = url.searchParams.get('sessionId');
        if (requested) {
          // Seeded demo history is public; visitors may also read their own
          // past sessions (same messaging group); owners read anything.
          let allowed = requested.startsWith('seed-sess-') || isOwner(req);
          if (!allowed) {
            const vid = visitorId(req);
            const visitor = vid ? getWebVisitor(vid) : undefined;
            if (visitor) {
              const row = getDb()
                .prepare('SELECT 1 FROM sessions WHERE id = ? AND messaging_group_id = ?')
                .get(requested, visitor.messaging_group_id);
              allowed = Boolean(row);
            }
          }
          if (!allowed) {
            json(res, 403, { error: 'Not your conversation.' });
            return;
          }
          json(res, 200, { events: getConvEvents(requested, afterId) });
          return;
        }
        const vid = visitorId(req);
        const session = vid ? currentSessionOf(vid) : undefined;
        if (!session) {
          json(res, 401, { error: 'No visitor session.' });
          return;
        }
        json(res, 200, { events: getConvEvents(session.id, afterId), sessionId: session.id });
        return;
      }

      case 'GET approvals': {
        if (!isOwner(req)) {
          json(res, 403, { error: 'Owner only.' });
          return;
        }
        const rows = [...getPendingApprovalsByAction('send_quote'), ...getPendingApprovalsByAction('send_nudge')]
          .map((a) => ({
            approvalId: a.approval_id,
            sessionId: a.session_id,
            action: a.action,
            status: a.status,
            title: a.title,
            createdAt: a.created_at,
            payload: safeParse(a.payload),
          }))
          .sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1));
        json(res, 200, { approvals: rows });
        return;
      }

      case 'POST approvals': {
        if (!isOwner(req)) {
          json(res, 403, { error: 'Owner only.' });
          return;
        }
        const id = sub.split('/')[2];
        if (!id) {
          json(res, 400, { error: 'Missing approval id.' });
          return;
        }
        const body = await readJson(req, res);
        if (!body) return;
        const decision = body.decision === 'approve' ? 'approve' : body.decision === 'reject' ? 'reject' : null;
        if (!decision) {
          json(res, 400, { error: 'decision must be "approve" or "reject".' });
          return;
        }
        // Optional owner note on reject ("max 20%") → binding instruction.
        // Applied BEFORE the resolution dispatch so the instruction and the
        // rejection land in the same agent batch — otherwise the agent races
        // ahead and re-quotes at the house-limit fallback before the note
        // arrives.
        const note = typeof body.note === 'string' ? body.note.trim() : '';
        if (decision === 'reject' && note) {
          const approvalRow = getPendingApproval(id);
          const noteSession = approvalRow?.session_id ? getSession(approvalRow.session_id) : undefined;
          if (noteSession) {
            const payload = safeParse(approvalRow!.payload) as { quote?: { id?: string }; quoteId?: string } | null;
            const { applyOwnerInstruction } = await import('../../modules/quotes/owner-instructions.js');
            try {
              applyOwnerInstruction(noteSession, note, payload?.quote?.id ?? payload?.quoteId ?? id);
            } catch (err) {
              log.warn('Owner note application failed', { id, err });
            }
          }
        }
        resolveApprovalFromDashboard(id, decision);
        json(res, 202, { ok: true });
        return;
      }

      case 'GET business': {
        if (!isOwner(req)) {
          json(res, 403, { error: 'Owner only.' });
          return;
        }
        // Grounding proof for judges: the exact persona-as-data files this
        // business runs on. Every quoted price traces to a rate-card line.
        const folder = process.env.WINGMAN_GROUP_FOLDER || 'coolbreeze';
        const groupDir = path.join(process.cwd(), 'groups', folder);
        const read = (f: string): string | null => {
          try {
            return fs.readFileSync(path.join(groupDir, f), 'utf8');
          } catch {
            return null;
          }
        };
        json(res, 200, {
          folder,
          provider: 'qwen (DashScope)',
          files: {
            persona: read('CLAUDE.local.md'),
            rateCard: read('rate-card.md'),
            houseRules: read('house-rules.json'),
            customers: read('customers.md'),
          },
        });
        return;
      }

      case 'GET demo-chats': {
        // Seeded demo conversations — public by design: judges browse them
        // from the customer perspective. Live visitor chats are NOT listed.
        const events = getRecentConvEvents(0, 2000).reverse();
        const seen = new Map<
          string,
          { sessionId: string; customerName: string | null; lastTs: string; preview: string }
        >();
        for (const e of events) {
          if (!e.session_id.startsWith('seed-sess-') || seen.has(e.session_id)) continue;
          const p = safeParse(e.payload) as { text?: string };
          seen.set(e.session_id, {
            sessionId: e.session_id,
            customerName: null,
            lastTs: e.ts,
            preview: (p.text || '').slice(0, 100),
          });
        }
        for (const q of listQuotes(200)) {
          const c = seen.get(q.session_id);
          if (c && q.customer_name) c.customerName = q.customer_name;
        }
        json(res, 200, { chats: [...seen.values()].sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1)) });
        return;
      }

      case 'GET my-chats': {
        const vid = visitorId(req);
        const visitor = vid ? getWebVisitor(vid) : undefined;
        if (!visitor) {
          json(res, 200, { chats: [], activeSessionId: null });
          return;
        }
        const rows = getDb()
          .prepare(
            `SELECT id, status, created_at FROM sessions WHERE messaging_group_id = ? ORDER BY created_at DESC LIMIT 20`,
          )
          .all(visitor.messaging_group_id) as Array<{ id: string; status: string; created_at: string }>;
        const chats = rows.map((r) => {
          const evs = getConvEvents(r.id, 0, 50);
          const lastChat = [...evs].reverse().find((e) => e.type === 'msg_in' || e.type === 'msg_out');
          const p = lastChat ? (safeParse(lastChat.payload) as { text?: string }) : {};
          return {
            sessionId: r.id,
            status: r.status,
            createdAt: r.created_at,
            lastTs: lastChat?.ts ?? r.created_at,
            preview: (p.text || '').slice(0, 100),
          };
        });
        json(res, 200, { chats, activeSessionId: visitor.session_id || null });
        return;
      }

      case 'GET memory': {
        if (!isOwner(req)) {
          json(res, 403, { error: 'Owner only.' });
          return;
        }
        const tenant = process.env.ENGRAM_TENANT_ID || process.env.WINGMAN_GROUP_FOLDER || 'coolbreeze';
        json(res, 200, await getMemorySnapshot(tenant));
        return;
      }

      case 'GET analytics': {
        if (!isOwner(req)) {
          json(res, 403, { error: 'Owner only.' });
          return;
        }
        json(res, 200, getAnalyticsTiles());
        return;
      }

      case 'GET quotes': {
        if (!isOwner(req)) {
          json(res, 403, { error: 'Owner only.' });
          return;
        }
        json(res, 200, { quotes: listQuotes(100).map((q) => ({ ...q, line_items: safeParse(q.line_items) })) });
        return;
      }

      case 'GET conversations': {
        if (!isOwner(req)) {
          json(res, 403, { error: 'Owner only.' });
          return;
        }
        // Latest ~1000 events grouped per session — demo scale by design.
        // Preview prefers the latest human-readable chat line over reasoning
        // noise; enriched with per-chat pending-approval badges and the
        // customer's name (from their quotes) for the WhatsApp-style list.
        const events = getRecentConvEvents(0, 1000).reverse();
        const seen = new Map<
          string,
          {
            sessionId: string;
            lastTs: string;
            lastType: string;
            preview: string;
            pendingApprovals: number;
            customerName: string | null;
          }
        >();
        for (const e of events) {
          const existing = seen.get(e.session_id);
          const p = safeParse(e.payload) as { text?: string; summary?: string };
          if (!existing) {
            seen.set(e.session_id, {
              sessionId: e.session_id,
              lastTs: e.ts,
              lastType: e.type,
              preview: (p.text || p.summary || e.type).slice(0, 120),
              pendingApprovals: 0,
              customerName: null,
            });
          } else if (
            !/[a-z]/i.test(existing.preview) ||
            (existing.lastType === 'reasoning' && (e.type === 'msg_in' || e.type === 'msg_out'))
          ) {
            // Upgrade a noisy preview to the most recent chat line we find.
            if (p.text) {
              existing.preview = p.text.slice(0, 120);
              existing.lastType = e.type;
            }
          }
        }
        const pending = [
          ...getPendingApprovalsByAction('send_quote'),
          ...getPendingApprovalsByAction('send_nudge'),
        ].filter((a) => a.status === 'pending');
        for (const a of pending) {
          const conv = a.session_id ? seen.get(a.session_id) : undefined;
          if (conv) conv.pendingApprovals++;
        }
        for (const q of listQuotes(200)) {
          const conv = seen.get(q.session_id);
          if (conv && !conv.customerName && q.customer_name) conv.customerName = q.customer_name;
        }
        json(res, 200, { conversations: [...seen.values()] });
        return;
      }

      case 'POST reset': {
        const vid = visitorId(req);
        if (!vid) {
          json(res, 401, { error: 'No visitor session.' });
          return;
        }
        const result = resetVisitor(vid);
        if (!result) {
          json(res, 404, { error: 'Unknown visitor.' });
          return;
        }
        json(res, 200, result);
        return;
      }

      case 'POST reply': {
        if (!isOwner(req)) {
          json(res, 403, { error: 'Owner only.' });
          return;
        }
        const body = await readJson(req, res);
        if (!body) return;
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!sessionId || !text) {
          json(res, 400, { error: 'sessionId and text are required.' });
          return;
        }
        if (text.length > 2000) {
          json(res, 400, { error: 'Reply too long (2000 chars max).' });
          return;
        }
        try {
          await ownerReplyToSession(sessionId, text);
          json(res, 202, { ok: true });
        } catch (err) {
          json(res, 409, { error: err instanceof Error ? err.message : 'Could not deliver reply.' });
        }
        return;
      }

      case 'POST timewarp': {
        if (!isOwner(req)) {
          json(res, 403, { error: 'Owner only.' });
          return;
        }
        const body = await readJson(req, res);
        if (!body) return;
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        const session = sessionId ? getSession(sessionId) : undefined;
        if (!session) {
          json(res, 404, { error: 'Unknown session.' });
          return;
        }
        const inDb = openInboundDb(session.agent_group_id, session.id);
        let warped = 0;
        try {
          const result = inDb
            .prepare(
              `UPDATE messages_in SET process_after = datetime('now', '-1 second')
               WHERE kind = 'task' AND status = 'pending' AND process_after > datetime('now')`,
            )
            .run();
          warped = result.changes;
        } finally {
          inDb.close();
        }
        if (warped > 0) {
          // Skip the up-to-60s sweep dead-air: wake the container directly.
          void wakeContainer(session).catch((err) => log.warn('timewarp wake failed', { sessionId, err }));
        }
        json(res, 200, { ok: true, warped });
        return;
      }

      case 'GET file': {
        const parts = sub.split('/'); // ['', 'file', visitorId, filename]
        const fileVisitor = parts[2] || '';
        const filename = parts[3] || '';
        if (!fileVisitor || !filename || filename.includes('..') || fileVisitor.includes('..')) {
          json(res, 400, { error: 'Bad file path.' });
          return;
        }
        if (!isOwner(req) && visitorId(req) !== fileVisitor) {
          json(res, 403, { error: 'Not your file.' });
          return;
        }
        const filePath = path.join(WEB_FILES_DIR, fileVisitor, filename);
        const resolved = path.resolve(filePath);
        if (!resolved.startsWith(path.resolve(WEB_FILES_DIR) + path.sep) || !fs.existsSync(resolved)) {
          json(res, 404, { error: 'File not found.' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': filename.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
          'Content-Disposition': `inline; filename="${filename.replace(/[^\w.-]/g, '_')}"`,
        });
        fs.createReadStream(resolved).pipe(res);
        return;
      }

      default: {
        json(res, 404, { error: `No route: ${route}` });
      }
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- HTTP boundary: every route error becomes a logged 500 instead of a hung socket
  } catch (err) {
    log.error('Web route error', { route, err });
    if (!res.headersSent) json(res, 500, { error: 'Something broke on our side — try again.' });
    else res.end();
  }
}

function safeParse(raw: string | null | undefined): unknown {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

let registered = false;

export function registerWebRoutes(): void {
  if (registered) return;
  registered = true;
  registerWebhookHandler('web', handle);
}
