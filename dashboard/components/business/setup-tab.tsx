"use client";

import { api, type BusinessSetup } from "@/lib/api";
import { money } from "@/lib/format";
import { useFetch } from "@/lib/use-fetch";
import type { ReactNode } from "react";
import { ChevronRightIcon } from "../icons";
import { Button, CenteredState, StatusChip } from "../ui";

/**
 * Judge-facing "Business setup" view: the exact documents the business gave
 * the agent (rate card, house rules, persona, customer notes). Grounding
 * proof — every quoted price traces back to an RC-xx ref shown here.
 */
export function SetupTab() {
  const { data, loading, error, reload } = useFetch(() => api.business());

  if (loading && data === null) {
    return (
      <div className="space-y-3 px-4 py-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg bg-panel-2/40">
            <span className="sr-only">Loading…</span>
          </div>
        ))}
      </div>
    );
  }

  if (error && data === null) {
    return (
      <CenteredState
        title="Couldn't load the business documents"
        hint="The business endpoint didn't respond — check that the Wingman host is running."
        action={
          <Button size="sm" onClick={reload}>
            Retry
          </Button>
        }
      />
    );
  }

  if (data === null) return null;

  return (
    <div className="space-y-4 px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <p className="max-w-lg text-sm text-muted">
          Everything Wingman knows comes from these documents — uploaded by the
          business, never invented. Quote line items cite their rate-card refs
          (RC-xx) so every price is traceable.
        </p>
        <div className="flex items-center gap-2">
          {data.folder && <StatusChip tone="success" label={data.folder} />}
          {data.provider && <StatusChip tone="neutral" label={data.provider} />}
        </div>
      </div>

      <Section title="Rate card">
        {data.files.rateCard ? (
          <RateCard markdown={data.files.rateCard} />
        ) : (
          <NotUploaded />
        )}
      </Section>

      <Section title="House rules">
        {data.files.houseRules ? (
          <HouseRules json={data.files.houseRules} />
        ) : (
          <NotUploaded />
        )}
      </Section>

      <Section title="Agent persona (system prompt)">
        {data.files.persona ? (
          <>
            <p className="mb-2 text-xs text-faint">
              This is the literal instruction file the agent runs on.
            </p>
            <PreBlock text={data.files.persona} />
          </>
        ) : (
          <NotUploaded />
        )}
      </Section>

      <Section title="Customer notes">
        {data.files.customers ? (
          <PreBlock text={data.files.customers} />
        ) : (
          <NotUploaded />
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details open className="group rounded-lg border border-line/60 bg-panel">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 select-none [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-3.5 shrink-0 text-faint transition-transform group-open:rotate-90" />
        <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">
          {title}
        </span>
      </summary>
      <div className="border-t border-line/60 px-3 py-3">{children}</div>
    </details>
  );
}

function NotUploaded() {
  return (
    <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center">
      <p className="text-xs text-faint">Not uploaded.</p>
    </div>
  );
}

/** Raw document text: monospace, muted, scrollable. */
function PreBlock({ text }: { text: string }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-lg bg-panel-2/40 px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted">
      {text}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Rate card: parse `| RC-xx | service | price |` rows into a real table
// ---------------------------------------------------------------------------

interface RateRow {
  ref: string;
  service: string;
  price: string;
}

function parseRateCard(md: string): { rows: RateRow[]; prose: string[] } {
  const rows: RateRow[] = [];
  const prose: string[] = [];
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("|")) {
      // `| a | b | c |` → ["a", "b", "c"]; header/separator rows won't match RC-xx.
      const cells = line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim());
      const ref = cells[0] ?? "";
      if (/^RC-\d+$/i.test(ref) && cells.length >= 3) {
        rows.push({ ref, service: cells[1] ?? "", price: cells[2] ?? "" });
      }
      continue;
    }
    // Non-table content (bundle notes, NOT-on-rate-card warnings) → prose.
    const text = line.replace(/^#{1,6}\s*/, "").replace(/\*\*/g, "");
    if (text) prose.push(text);
  }
  return { rows, prose };
}

function RateCard({ markdown }: { markdown: string }) {
  const { rows, prose } = parseRateCard(markdown);

  if (rows.length === 0) return <PreBlock text={markdown} />;

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border border-line/60">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line/60 bg-panel-2/40 text-left text-[11px] tracking-wide text-muted uppercase">
              <th scope="col" className="px-3 py-2 font-semibold">
                Ref
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                Service
              </th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">
                Price
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/40">
            {rows.map((row, i) => (
              <tr key={`${row.ref}-${i}`}>
                <td className="px-3 py-2">
                  <span className="inline-flex rounded-full border border-line bg-accent-soft px-2 py-0.5 font-mono text-[11px] font-medium whitespace-nowrap text-accent-strong">
                    {row.ref}
                  </span>
                </td>
                <td className="px-3 py-2 text-ink">{row.service}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap text-ink tabular-nums">
                  {row.price}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {prose.length > 0 && (
        <div className="space-y-1">
          {prose.map((line, i) => (
            <p key={i} className="text-xs leading-relaxed text-muted">
              {line}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// House rules: JSON → labeled key-value rows with human formatting
// ---------------------------------------------------------------------------

interface RuleSpec {
  key: string;
  label: string;
  render: (value: unknown, currency: string) => string | null;
}

const RULE_SPECS: RuleSpec[] = [
  {
    key: "businessName",
    label: "Business name",
    render: (v) => (typeof v === "string" ? v : null),
  },
  {
    key: "currency",
    label: "Currency",
    render: (v) => (typeof v === "string" ? v : null),
  },
  {
    key: "maxAutoDiscountPct",
    label: "Max auto-approved discount",
    render: (v) => (typeof v === "number" ? `${v}%` : null),
  },
  {
    key: "maxAutoTotalCents",
    label: "Auto-send limit",
    render: (v, currency) => (typeof v === "number" ? money(v, currency) : null),
  },
  {
    key: "minRetrievalConfidence",
    label: "Min retrieval confidence",
    render: (v) =>
      typeof v === "number"
        ? v <= 1
          ? `${Math.round(v * 100)}%`
          : String(v)
        : null,
  },
  {
    key: "followUpAfterHours",
    label: "Follow-up after",
    render: (v) => (typeof v === "number" ? `${v}h` : null),
  },
];

function HouseRules({ json }: { json: string }) {
  let parsed: Record<string, unknown> | null = null;
  try {
    const value: unknown = JSON.parse(json);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    // fall through to the raw view
  }

  if (parsed === null) return <PreBlock text={json} />;

  const currency =
    typeof parsed.currency === "string" && parsed.currency
      ? parsed.currency
      : "SGD";

  const rows: { label: string; value: string }[] = [];
  const seen = new Set<string>();
  for (const spec of RULE_SPECS) {
    if (!(spec.key in parsed)) continue;
    seen.add(spec.key);
    const rendered = spec.render(parsed[spec.key], currency);
    rows.push({
      label: spec.label,
      value: rendered ?? fallbackValue(parsed[spec.key]),
    });
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (seen.has(key)) continue;
    rows.push({ label: key, value: fallbackValue(value) });
  }

  if (rows.length === 0) return <PreBlock text={json} />;

  return (
    <dl className="divide-y divide-line/40 overflow-hidden rounded-lg border border-line/60">
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex items-baseline justify-between gap-4 px-3 py-2"
        >
          <dt className="text-xs text-muted">{row.label}</dt>
          <dd className="text-right text-sm font-medium text-ink tabular-nums">
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function fallbackValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? "—";
  } catch {
    return "—";
  }
}
