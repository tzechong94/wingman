/**
 * Outbound prose sanitizer — qwen narrates MCP tool calls as XML-ish tags
 * instead of invoking them (<ask_user_question>{...}</ask_user_question>).
 * A customer must never see raw markup: convert the narration into the plain
 * question text it contains, deterministically.
 */

interface NarratedQuestion {
  questions?: Array<{ question?: string; options?: Array<string | { label?: string }> }>;
  question?: string;
}

const AUQ_RE = /<ask_user_question>\s*([\s\S]*?)(?:<\/ask_user_question>|$)/gi;

export function sanitizeNarratedToolTags(text: string): string {
  let out = text.replace(AUQ_RE, (_m, body: string) => {
    const parsed = tryParseLoose(body);
    if (parsed) {
      const qs: string[] = [];
      if (Array.isArray(parsed.questions)) {
        for (const q of parsed.questions) {
          if (q?.question) {
            const opts = Array.isArray(q.options)
              ? q.options
                  .map((o) => (typeof o === 'string' ? o : o?.label ?? ''))
                  .filter(Boolean)
              : [];
            qs.push(q.question + (opts.length ? ` (${opts.join(' / ')})` : ''));
          }
        }
      } else if (parsed.question) {
        qs.push(parsed.question);
      }
      if (qs.length) return qs.join(' ');
    }
    // Unparseable narration: drop the markup, keep any human-ish text.
    return body.replace(/[{}[\]"]/g, ' ').replace(/\s+/g, ' ').trim();
  });

  // Generic guard: strip any other lone narrated tool tags we know of.
  out = out.replace(/<\/?(?:send_message|schedule_task|save_preference|set_engagement_mode)>/gi, '');
  return out.replace(/\n{3,}/g, '\n\n');
}

/** Parse JSON that may be truncated mid-stream — try as-is, then with closers appended. */
function tryParseLoose(body: string): NarratedQuestion | null {
  const raw = body.trim();
  if (!raw) return null;
  for (const candidate of [raw, raw + '}', raw + ']}', raw + '"}]}', raw + '}]}']) {
    try {
      return JSON.parse(candidate) as NarratedQuestion;
    } catch {
      /* next */
    }
  }
  return null;
}
