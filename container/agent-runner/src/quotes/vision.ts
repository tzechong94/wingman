/**
 * Photo→quote vision path — deterministic, driver-called (the model never
 * has to invoke a vision tool). When an inbound batch carries image
 * attachments, we call DashScope Qwen-VL directly and append the unit
 * description to the prompt as a system note, so the model quotes the right
 * rate-card line (wall-mounted vs ceiling cassette).
 *
 * Best-effort with a hard timeout: a vision failure degrades to the agent
 * asking the customer — never a blocked turn.
 */
import fs from 'fs';
import path from 'path';

import type { MessageInRow } from '../db/messages-in.js';

const VISION_MODEL = process.env.QWEN_VL_MODEL || 'qwen-vl-max';
const VISION_TIMEOUT_MS = 15_000;
const MAX_IMAGES = 2;

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function log(msg: string): void {
  console.error(`[vision] ${msg}`);
}

/** Collect inbox-relative image paths from a batch's message contents. */
export function collectImagePaths(batch: MessageInRow[]): string[] {
  const out: string[] = [];
  for (const row of batch) {
    try {
      const content = JSON.parse(row.content) as { attachments?: Array<{ localPath?: string }> };
      for (const att of content.attachments ?? []) {
        if (!att.localPath) continue;
        const ext = att.localPath.split('.').pop()?.toLowerCase() ?? '';
        if (MIME_BY_EXT[ext]) out.push(att.localPath);
      }
    } catch {
      /* non-JSON content */
    }
  }
  return out.slice(0, MAX_IMAGES);
}

async function describeImage(localPath: string): Promise<string | null> {
  const key = process.env.DASHSCOPE_API_KEY || process.env.OPENAI_API_KEY;
  const base = process.env.OPENAI_BASE_URL || process.env.DASHSCOPE_BASE_URL;
  if (!key || !base) return null;

  const abs = path.join('/workspace', localPath);
  let data: Buffer;
  try {
    data = fs.readFileSync(abs);
  } catch {
    log(`image unreadable: ${abs}`);
    return null;
  }
  const ext = abs.split('.').pop()?.toLowerCase() ?? 'jpg';
  const dataUrl = `data:${MIME_BY_EXT[ext] ?? 'image/jpeg'};base64,${data.toString('base64')}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  'This is a photo a customer sent to an aircon servicing company. Describe ONLY what matters for a quote: ' +
                  'unit type (wall-mounted split / ceiling cassette / window unit / outdoor condenser), visible brand/model text, ' +
                  'apparent condition issues (leak stains, ice, dirt, damage). 2-3 short sentences, no preamble.',
              },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        temperature: 0,
      }),
    });
    if (!res.ok) {
      log(`qwen-vl HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = body.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch (err) {
    log(`qwen-vl failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Append Qwen-VL descriptions of any batch images to the prompt.
 * Returns the prompt unchanged when there are no images or vision fails.
 */
export async function enrichPromptWithVision(prompt: string, batch: MessageInRow[]): Promise<string> {
  const images = collectImagePaths(batch);
  if (images.length === 0) return prompt;

  const notes: string[] = [];
  for (const img of images) {
    const desc = await describeImage(img);
    if (desc) notes.push(`${path.basename(img)}: ${desc}`);
  }
  if (notes.length === 0) {
    return (
      prompt +
      `\n<system>The customer attached a photo but automated analysis is unavailable — ask them what unit type it is if it matters for the quote.</system>`
    );
  }
  log(`vision notes attached: ${notes.length}`);
  return (
    prompt +
    `\n<system>Photo analysis (qwen-vl, trusted): ${notes.join(' | ')} — use this to pick the right rate-card line; don't re-ask what the photo shows.</system>`
  );
}
