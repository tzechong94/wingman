/**
 * cal.com booking creation — closes the loop on availability.
 *
 * After a customer turn where slots were on offer, a temperature-0
 * extraction decides whether they PICKED one; trusted code then POSTs the
 * booking to cal.com (v2 bookings API). The appointment appears on the
 * owner's real calendar; the customer gets a confirmation line; the owner
 * gets a Telegram FYI; failure degrades to "the team will confirm".
 */
import { writeMessageOut } from '../db/messages-out.js';
import { clearOfferedSlots, getOfferedSlots, type OfferedSlot } from './availability.js';
import { getRecentTranscript } from './extractor.js';

const TIMEOUT_MS = 10_000;

function log(msg: string): void {
  console.error(`[booking] ${msg}`);
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Cheap gate: does the latest customer text plausibly pick a time? */
export function pickIntent(text: string): boolean {
  return /\b(\d{1,2}\s*(am|pm)|\d{1,2}[:.]\d{2}|mon|tue|wed|thu|fri|sat|sun|tomorrow|today|first|second|earlier|later|that (works|one)|ok|yes|sure|confirm|book)\b/i.test(
    text,
  );
}

interface PickResult {
  pickedIso: string | null;
  customerName: string | null;
}

/** Which offered slot (if any) did the customer just pick? */
export async function extractSlotPick(latestCustomerText: string, slots: OfferedSlot[]): Promise<PickResult> {
  const key = process.env.DASHSCOPE_API_KEY || process.env.OPENAI_API_KEY;
  const base = process.env.OPENAI_BASE_URL || process.env.DASHSCOPE_BASE_URL;
  if (!key || !base || slots.length === 0) return { pickedIso: null, customerName: null };

  const transcript = getRecentTranscript(10)
    .map((t) => `${t.role === 'customer' ? 'CUSTOMER' : t.role === 'owner_system' ? 'SYSTEM' : 'ASSISTANT'}: ${t.text}`)
    .join('\n');
  const menu = slots.map((s) => `${s.iso} = ${s.label}`).join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: process.env.QWEN_EXTRACT_MODEL || 'qwen-turbo',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'A service business offered a customer these appointment slots:\n' +
              menu +
              '\n\nGiven the conversation and the customer\'s LATEST message, did they clearly pick ONE of these slots? ' +
              'Reply STRICT flat JSON: {"pickedIso": "<exact iso from the list>"|null, "customerName": string|null}. ' +
              'pickedIso must be copied EXACTLY from the list, and the DAY AND TIME the customer stated must both match ' +
              'that slot. If the customer names a day or time that is NOT in the list (e.g. they say Monday but no Monday ' +
              'slot is listed), that is NOT a pick — return null. Ambiguous / no pick / asking questions = null. ' +
              'NEVER substitute a different slot for what the customer asked. ' +
              'customerName = their name if stated anywhere, else null.',
          },
          { role: 'user', content: `${transcript}\nCUSTOMER (latest): ${latestCustomerText}` },
        ],
      }),
    });
    if (!res.ok) return { pickedIso: null, customerName: null };
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? '{}') as Partial<PickResult>;
    const pickedIso = slots.find((s) => s.iso === parsed.pickedIso)?.iso ?? null;
    return { pickedIso, customerName: parsed.customerName ?? null };
  } catch {
    return { pickedIso: null, customerName: null };
  } finally {
    clearTimeout(timer);
  }
}

/** POST the booking to cal.com. Returns the booked slot label or null. */
export async function createCalBooking(iso: string, customerName: string | null): Promise<boolean> {
  const key = process.env.CALCOM_API_KEY;
  const eventTypeId = Number(process.env.CALCOM_EVENT_TYPE_ID);
  if (!key || !eventTypeId) return false;
  const base = (process.env.CALCOM_API_BASE || 'https://api.cal.com/v2').replace(/\/$/, '');
  const tz = process.env.CALCOM_TIMEZONE || 'Asia/Singapore';
  const name = customerName || 'Wingman customer';
  const emailSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '') || 'customer';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'cal-api-version': '2024-08-13',
      },
      signal: controller.signal,
      body: JSON.stringify({
        start: iso,
        eventTypeId,
        attendee: { name, email: `${emailSlug}@wingman-demo.invalid`, timeZone: tz, language: 'en' },
        metadata: { source: 'wingman' },
      }),
    });
    if (!res.ok) {
      log(`cal.com booking HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    log(`cal.com booking failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Post-turn orchestrator: offered slots + a picking customer → real booking.
 * Writes the confirmation/fallback as driver messages and briefs the model.
 */
// One attempt per customer utterance, one booking per offer cycle.
let lastAttemptText = '';

export async function maybeBookAppointment(
  routing: {
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    inReplyTo: string | null;
  },
  modelProse = '',
): Promise<{ handled: boolean }> {
  const NO = { handled: false };
  const say = (text: string): void => {
    writeMessageOut({
      id: generateId('msg'),
      in_reply_to: routing.inReplyTo,
      kind: 'chat',
      platform_id: routing.platformId,
      channel_type: routing.channelType,
      thread_id: routing.threadId,
      content: JSON.stringify({ text }),
    });
  };
  if (!process.env.CALCOM_API_KEY) return NO;
  const slots = getOfferedSlots();
  if (slots.length === 0) return NO;
  const latestCustomerText = getRecentTranscript(10)
    .filter((t) => t.role === 'customer')
    .at(-1)?.text;
  // The model sometimes CLAIMS a booking that never happened ("I've locked
  // in Wednesday at 18:00!") — with real slots on offer, replace the lie
  // with the truth: the actual availability, and let the customer pick.
  const falseLockClaim = () =>
    /locked in|i've locked|has been (booked|scheduled)|booked you|scheduled your|your appointment (for|on|is)/i.test(
      modelProse,
    );
  const offerTruth = (): { handled: boolean } => {
    const menu = slots
      .slice(0, 6)
      .map((sl) => sl.label)
      .join(', ');
    say(`Here's our live availability: ${menu}. Which of these works best for you?`);
    log('false booking claim replaced with real availability');
    return { handled: true };
  };

  if (!latestCustomerText || !pickIntent(latestCustomerText)) {
    return falseLockClaim() ? offerTruth() : NO;
  }
  if (latestCustomerText === lastAttemptText) return NO; // nudge/system turn — customer said nothing new
  lastAttemptText = latestCustomerText;

  const pick = await extractSlotPick(latestCustomerText, slots);
  if (!pick.pickedIso) {
    log(`no clear slot pick in: "${latestCustomerText.slice(0, 60)}"`);
    // Customer named a CONCRETE time that isn't an open slot → the truthful
    // reply is deterministic: that time isn't open, here's what is. Without
    // this the model tends to "note down" impossible times.
    if (/\b\d{1,2}\s*(am|pm)\b|\b\d{1,2}[:.]\d{2}\b/i.test(latestCustomerText)) {
      const menu = slots.slice(0, 4).map((sl) => sl.label).join(', ');
      say(`That exact time doesn't look open on our calendar, I'm afraid. Here's what we have: ${menu}. Any of these work?`);
      return { handled: true };
    }
    return falseLockClaim() ? offerTruth() : NO;
  }
  const slot = slots.find((s) => s.iso === pick.pickedIso)!;

  const booked = await createCalBooking(slot.iso, pick.customerName);
  if (booked) clearOfferedSlots();
  writeMessageOut({
    id: generateId('sys'),
    kind: 'system',
    content: JSON.stringify({
      action: 'reasoning_event',
      event: {
        ts: new Date().toISOString(),
        type: 'rule',
        summary: booked ? `Booked in cal.com — ${slot.label}` : `cal.com booking failed for ${slot.label}`,
        detail: booked
          ? `Appointment created on the business calendar${pick.customerName ? ` for ${pick.customerName}` : ''}`
          : 'API error — customer told the team will confirm manually',
      },
    }),
  });
  writeMessageOut({
    id: generateId('sys'),
    kind: 'system',
    content: JSON.stringify({
      action: 'owner_fyi',
      text: booked
        ? `\u{1F4C5} Appointment booked — ${slot.label}${pick.customerName ? ` for ${pick.customerName}` : ''} (chat continues in the cockpit). It's on your cal.com calendar.`
        : `⚠️ Booking API failed for ${slot.label} — the customer expects this slot; please confirm it manually in cal.com.`,
    }),
  });
  say(
    booked
      ? `Locked in — ${slot.label}. It's on our calendar; see you then! 📅`
      : `Almost! That slot was taken just now — what other day works for you?`,
  );
  log(booked ? `booked ${slot.label}` : `booking failed ${slot.label}`);
  return { handled: true };
}
