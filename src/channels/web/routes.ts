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
import { getPendingApprovalsByAction } from '../../db/sessions.js';
import {
  bumpWebVisitorMessages,
  getAnalyticsTiles,
  getConvEvents,
  getRecentConvEvents,
  getWebVisitor,
  listQuotes,
} from '../../db/quotes.js';
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
  resetVisitor,
  resolveApprovalFromDashboard,
} from './adapter.js';
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

function ownerToken(): string {
  return process.env.WINGMAN_DEMO_TOKEN || '';
}

function isOwner(req: Req): boolean {
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
        if (existing && getWebVisitor(existing)) {
          const session = currentSessionOf(existing);
          json(res, 200, { visitorId: existing, sessionId: session?.id ?? null, existing: true });
          return;
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
          if (!isOwner(req)) {
            json(res, 403, { error: 'Owner only.' });
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
        resolveApprovalFromDashboard(id, decision);
        json(res, 202, { ok: true });
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
        // Latest ~500 events grouped per session — demo scale by design.
        const events = getRecentConvEvents(0, 500).reverse();
        const seen = new Map<string, { sessionId: string; lastTs: string; lastType: string; preview: string }>();
        for (const e of events) {
          if (seen.has(e.session_id)) continue;
          const p = safeParse(e.payload) as { text?: string; summary?: string };
          seen.set(e.session_id, {
            sessionId: e.session_id,
            lastTs: e.ts,
            lastType: e.type,
            preview: (p.text || p.summary || e.type).slice(0, 120),
          });
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
