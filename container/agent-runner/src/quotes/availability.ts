/**
 * Real availability via cal.com — the external-calendar tool call.
 *
 * When a customer turn shows booking intent, trusted driver code calls the
 * cal.com API (v2 slots) for the business's service-visit event type and
 * injects the REAL open slots into the prompt. The model offers only those —
 * "never invent availability" upgraded from a prohibition to actual data.
 *
 * Env (unset → feature silently off, old behavior stands):
 *   CALCOM_API_KEY        cal_live_…
 *   CALCOM_EVENT_TYPE_ID  numeric event type id ("Aircon service visit")
 *   CALCOM_API_BASE       default https://api.cal.com/v2
 *   CALCOM_TIMEZONE       default Asia/Singapore
 */
import type { MessageInRow } from '../db/messages-in.js';

const TIMEOUT_MS = 8_000;
const DAYS_AHEAD = 5;
const MAX_SLOTS_SHOWN = 10;

function log(msg: string): void {
  console.error(`[availability] ${msg}`);
}

export function bookingIntent(batch: MessageInRow[]): boolean {
  for (const row of batch) {
    try {
      const c = JSON.parse(row.content) as { text?: string; sender?: string };
      if (c.sender === 'system') continue;
      const t = (c.text ?? '').toLowerCase();
      if (
        /\b(confirm|book|schedule|appointment|come (over|down|by)|when can|what time|available|availability|slot|arrange)\b/.test(
          t,
        )
      ) {
        return true;
      }
    } catch {
      /* skip */
    }
  }
  return false;
}

interface SlotsByDay {
  day: string;
  times: string[];
}

export interface OfferedSlot {
  iso: string;
  label: string; // "Wed 8 Jul 18:00"
}

let lastOffered: OfferedSlot[] = [];
export function getOfferedSlots(): OfferedSlot[] {
  return lastOffered;
}
/** Consumed after a successful booking — one booking per offer cycle. */
export function clearOfferedSlots(): void {
  lastOffered = [];
}

/** Structured slots with original ISO starts (needed to CREATE bookings). */
export function parseSlotsIso(body: unknown, tz: string): OfferedSlot[] {
  const data = (body as { data?: { slots?: Record<string, unknown[]> } | Record<string, unknown[]> })?.data ?? body;
  const map = ((data as { slots?: Record<string, unknown[]> })?.slots ?? data) as Record<string, unknown[]>;
  if (typeof map !== 'object' || map === null) return [];
  const out: OfferedSlot[] = [];
  for (const [, slots] of Object.entries(map)) {
    if (!Array.isArray(slots)) continue;
    for (const sRaw of slots) {
      const iso = typeof sRaw === 'string' ? sRaw : ((sRaw as { start?: string; time?: string })?.start ?? (sRaw as { time?: string })?.time);
      if (!iso) continue;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) continue;
      try {
        out.push({
          iso,
          label: new Intl.DateTimeFormat('en-SG', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(d),
        });
      } catch {
        out.push({ iso, label: iso });
      }
    }
  }
  return out.sort((a, b) => (a.iso < b.iso ? -1 : 1)).slice(0, 20);
}

/** Tolerant parse of cal.com /v2/slots — {data: {"2026-07-07": [{start}|string, …]}}. */
export function parseSlotsResponse(body: unknown, tz: string): SlotsByDay[] {
  const data =
    (body as { data?: { slots?: Record<string, unknown[]> } | Record<string, unknown[]> })?.data ?? body;
  const map = ((data as { slots?: Record<string, unknown[]> })?.slots ?? data) as Record<string, unknown[]>;
  if (typeof map !== 'object' || map === null) return [];
  const out: SlotsByDay[] = [];
  for (const [day, slots] of Object.entries(map)) {
    if (!Array.isArray(slots)) continue;
    const times: string[] = [];
    for (const s of slots) {
      const iso = typeof s === 'string' ? s : ((s as { start?: string; time?: string })?.start ?? (s as { time?: string })?.time);
      if (!iso) continue;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) continue;
      try {
        times.push(new Intl.DateTimeFormat('en-SG', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d));
      } catch {
        times.push(iso.slice(11, 16));
      }
    }
    if (times.length) out.push({ day, times: [...new Set(times)] });
  }
  return out.sort((a, b) => (a.day < b.day ? -1 : 1));
}

export async function fetchAvailability(): Promise<string | null> {
  const key = process.env.CALCOM_API_KEY;
  const eventTypeId = process.env.CALCOM_EVENT_TYPE_ID;
  if (!key || !eventTypeId) return null;
  const base = (process.env.CALCOM_API_BASE || 'https://api.cal.com/v2').replace(/\/$/, '');
  const tz = process.env.CALCOM_TIMEZONE || 'Asia/Singapore';

  const start = new Date();
  const end = new Date(start.getTime() + DAYS_AHEAD * 86_400_000);
  const url =
    `${base}/slots?eventTypeId=${encodeURIComponent(eventTypeId)}` +
    `&start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}` +
    `&timeZone=${encodeURIComponent(tz)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, 'cal-api-version': '2024-09-04' },
      signal: controller.signal,
    });
    if (!res.ok) {
      log(`cal.com HTTP ${res.status}`);
      return null;
    }
    const body = await res.json();
    lastOffered = parseSlotsIso(body, tz);
    const days = parseSlotsResponse(body, tz);
    if (days.length === 0) return null;
    let shown = 0;
    const parts: string[] = [];
    for (const d of days) {
      const take = d.times.slice(0, Math.max(1, Math.min(4, MAX_SLOTS_SHOWN - shown)));
      if (take.length === 0) break;
      const label = new Intl.DateTimeFormat('en-SG', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(
        new Date(`${d.day}T00:00:00`),
      );
      parts.push(`${label}: ${take.join(', ')}`);
      shown += take.length;
      if (shown >= MAX_SLOTS_SHOWN) break;
    }
    return parts.join(' | ');
  } catch (err) {
    log(`cal.com fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Prompt enrichment (same pattern as vision): booking intent + configured
 * calendar → real slots injected. Fails soft to the old "team will confirm"
 * behavior.
 */
export async function enrichPromptWithAvailability(prompt: string, batch: MessageInRow[]): Promise<string> {
  if (!process.env.CALCOM_API_KEY || !bookingIntent(batch)) return prompt;
  const slots = await fetchAvailability();
  if (!slots) return prompt;
  log('real slots injected');
  // Prepended, not appended — trailing system notes get ignored under
  // variance; leading ones are obeyed (same lesson as the quote notes).
  return (
    `<system>MANDATORY for this reply — REAL calendar availability (from the business's booking system): ${slots}. ` +
    `If the customer's latest message ALREADY PICKS a time matching one of these openings, do NOT re-offer — ` +
    `confirm their pick is locked in and close warmly. If they propose a time NOT in this list, that time is ` +
    `TAKEN — say so and offer the nearest listed slots instead; never accept an unlisted time. Otherwise your ` +
    `reply MUST offer 2-3 of these exact slots by name. Never offer times outside this list, and do not ask ` +
    `open-ended "when works for you" questions when slots are listed here.</system>\n` +
    prompt
  );
}
