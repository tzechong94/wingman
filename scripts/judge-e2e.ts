/**
 * Judge-script e2e — the full loop, scripted, against a running host.
 *
 *   mint → ambiguous inquiry → scoping question → answer → auto-quote (+PDF)
 *   → discount ask → escalation → approve (dashboard path) → revised quote
 *   → audit visible
 *
 * Run before every deploy and against prod right after:
 *   pnpm exec tsx scripts/judge-e2e.ts [--base http://localhost:3000] [--fast]
 *
 * Exit 0 = every beat landed. Exit 1 = a beat failed (message says which).
 * --fast skips the returning-customer (memory) beat to save one turn.
 */
import fs from 'fs';

const BASE = argValue('--base') || 'http://localhost:3000';
const FAST = process.argv.includes('--fast');
const TURN_TIMEOUT_MS = 120_000;

// Load .env for the demo token (existing env wins).
for (const line of fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8').split('\n') : []) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const TOKEN = process.env.WINGMAN_DEMO_TOKEN || '';

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/* ── tiny client with cookie jar ── */

const jar = new Map<string, string>();

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(jar.size ? { Cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const m = raw.match(/^([^=]+)=([^;]*)/);
    if (m) jar.set(m[1], decodeURIComponent(m[2]));
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

interface ConvEvent {
  id: number;
  type: string;
  actor: string | null;
  payload: string;
  ts: string;
}

let lastEventId = 0;

async function waitFor(
  description: string,
  predicate: (e: ConvEvent, payload: Record<string, unknown>) => boolean,
  timeoutMs = TURN_TIMEOUT_MS,
): Promise<{ event: ConvEvent; payload: Record<string, unknown> }> {
  const start = Date.now();
  process.stdout.write(`  … waiting: ${description} `);
  while (Date.now() - start < timeoutMs) {
    const { json } = await call('GET', `/webhook/web/transcript?after=${lastEventId}`);
    for (const e of (json.events as ConvEvent[]) ?? []) {
      lastEventId = Math.max(lastEventId, e.id);
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(e.payload) as Record<string, unknown>;
      } catch {
        /* keep {} */
      }
      if (predicate(e, payload)) {
        const secs = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`✓ (${secs}s)`);
        return { event: e, payload };
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log('✗ TIMEOUT');
  throw new Error(`Timed out waiting for: ${description}`);
}

async function send(text: string): Promise<void> {
  const { status, json } = await call('POST', '/webhook/web/message', { text });
  if (status !== 202) throw new Error(`send failed (${status}): ${JSON.stringify(json)}`);
  console.log(`→ customer: "${text}"`);
}

/* ── the script ── */

async function main(): Promise<void> {
  console.log(`Judge e2e against ${BASE}\n`);

  // 0. Health
  const health = await call('GET', '/webhook/web/health');
  if (health.status !== 200) throw new Error(`health check failed: ${health.status}`);
  console.log('✓ health');

  // 1. Mint
  const mint = await call('POST', '/webhook/web/session');
  if (mint.status !== 201 && mint.status !== 200) throw new Error(`mint failed: ${mint.status}`);
  console.log(`✓ visitor minted (${mint.json.visitorId})`);

  // 2. Owner auth (needed later; fail fast if token wrong)
  if (!TOKEN) throw new Error('WINGMAN_DEMO_TOKEN missing from env/.env');
  const auth = await call('POST', '/webhook/web/auth', { token: TOKEN });
  if (auth.status !== 200) throw new Error(`owner auth failed: ${auth.status}`);
  console.log('✓ owner authenticated');

  // 3. Ambiguous inquiry → scoping question (no price!)
  await send('Hi, my aircon is leaking water. How much to fix it?');
  const scoping = await waitFor(
    'agent reply (should ask a scoping question, not quote)',
    (e) => e.type === 'msg_out' && e.actor === 'agent',
  );
  const scopingText = String(scoping.payload.text ?? '');
  if (/\bSGD\s*\d|\$\s*\d/.test(scopingText)) {
    throw new Error(`agent quoted a price without scoping: "${scopingText.slice(0, 120)}"`);
  }
  if (scoping.payload.quote) throw new Error('agent sent a quote card without scoping first');
  console.log(`  agent asked: "${scopingText.slice(0, 100)}…"`);

  // 4. (memory beat) introduce as Mr. Tan
  if (!FAST) {
    await send("I'm Mr. Tan by the way — you've serviced my place in Bishan before.");
    await waitFor('recognition reply', (e, p) => {
      return e.type === 'msg_out' && e.actor === 'agent' && /tan/i.test(String(p.text ?? ''));
    });
  }

  // 5. Answer scoping → expect an AUTO-SENT quote card
  await send(
    'It is 1 wall-mounted unit in the master bedroom, last serviced about a year ago. Just fix the leak please.',
  );
  const quote = await waitFor(
    'auto-sent quote card',
    (e, p) => e.type === 'msg_out' && Boolean(p.quote),
  );
  const q = quote.payload.quote as { id: string; status: string; totalCents: number };
  if (q.status !== 'auto_sent') throw new Error(`expected auto_sent, got ${q.status}`);
  console.log(`  quote ${q.id}: SGD ${(q.totalCents / 100).toFixed(2)} (auto-sent)`);
  const files = quote.payload.files as Array<{ url: string }> | undefined;
  if (files?.length) {
    const pdf = await fetch(`${BASE}${files[0].url}`, {
      headers: { Cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    console.log(pdf.ok ? '  ✓ PDF downloads' : `  ⚠ PDF fetch ${pdf.status} (non-blocking)`);
  } else {
    console.log('  ⚠ no PDF attached (non-blocking — renderer is best-effort)');
  }

  // 6. Discount ask → escalation
  await send('Can you do 20% off if I confirm today?');
  await waitFor(
    'checking-with-boss reply',
    (e, p) => e.type === 'msg_out' && Boolean(p.quotePending),
  );
  const escalated = await waitFor(
    'approval requested (reasoning/approval event)',
    (e, p) => e.type === 'approval' && (p as { state?: string }).state === 'requested',
  );
  const pendingQuoteId = (escalated.payload as { quoteId?: string }).quoteId ?? '';

  // 7. Approve from the dashboard path
  const approvals = await call('GET', '/webhook/web/approvals');
  const pending = ((approvals.json.approvals as Array<Record<string, unknown>>) ?? []).find(
    (a) => a.status === 'pending' && a.action === 'send_quote',
  );
  if (!pending) throw new Error('no pending send_quote approval visible to the owner');
  console.log(`→ owner approves ${pending.approvalId}`);
  const resolve = await call('POST', `/webhook/web/approvals/${pending.approvalId}`, { decision: 'approve' });
  if (resolve.status !== 202) throw new Error(`approve failed: ${resolve.status}`);

  // 8. Customer receives the approved quote (host-delivered — no model in the loop)
  await waitFor(
    'approved quote delivered to customer',
    (e, p) =>
      e.type === 'msg_out' && Boolean((p.quote as { status?: string } | undefined)?.status === 'approved'),
    30_000, // host-side path — must be fast
  );

  // 9. Audit visible
  const quotes = await call('GET', '/webhook/web/quotes');
  const audited = ((quotes.json.quotes as Array<Record<string, unknown>>) ?? []).some(
    (row) => row.id === pendingQuoteId || row.id === q.id,
  );
  if (!audited) throw new Error('quotes not visible in the audit endpoint');
  console.log('✓ audit trail shows the quotes');

  const tiles = await call('GET', '/webhook/web/analytics');
  console.log(
    `✓ analytics: ${tiles.json.quotesSent7d} quotes 7d, median response ${tiles.json.medianResponseSeconds}s`,
  );

  console.log('\nALL BEATS PASSED ✅');
}

main().catch((err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
