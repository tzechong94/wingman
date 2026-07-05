"use client";

import { clockTime, money, shortId } from "@/lib/format";
import {
  normalizeQuote,
  type ConvEvent,
  type ReasoningKind,
  type ReasoningPayload,
} from "@/lib/types";
import { useState, type ComponentType, type SVGProps } from "react";
import {
  ActivityIcon,
  AlertCircleIcon,
  AlertTriangleIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  DatabaseIcon,
  EyeIcon,
  FileTextIcon,
  InfoIcon,
  SearchIcon,
  ShieldCheckIcon,
} from "../icons";
import { CenteredState } from "../ui";

type IconType = ComponentType<SVGProps<SVGSVGElement>>;

const REASONING_ICONS: Record<ReasoningKind, { icon: IconType; tint: string }> = {
  retrieval: { icon: SearchIcon, tint: "text-muted" },
  memory: { icon: DatabaseIcon, tint: "text-accent-strong" },
  rule: { icon: ShieldCheckIcon, tint: "text-accent-strong" },
  escalation: { icon: AlertTriangleIcon, tint: "text-warning" },
  vision: { icon: EyeIcon, tint: "text-muted" },
  followup: { icon: ClockIcon, tint: "text-muted" },
  info: { icon: InfoIcon, tint: "text-muted" },
  error: { icon: AlertCircleIcon, tint: "text-critical" },
};

interface ActivityRow {
  icon: IconType;
  tint: string;
  title: string;
  detail?: string;
}

function describe(e: ConvEvent): ActivityRow {
  if (e.type === "reasoning") {
    const p = e.payload as ReasoningPayload;
    const meta = (p.type && REASONING_ICONS[p.type]) || REASONING_ICONS.info;
    return {
      icon: meta.icon,
      tint: meta.tint,
      title: p.summary || "Reasoning step",
      ...(p.detail ? { detail: p.detail } : {}),
    };
  }
  if (e.type === "quote") {
    const q = normalizeQuote(e.payload.quote) ?? normalizeQuote(e.payload);
    return {
      icon: FileTextIcon,
      tint: "text-accent-strong",
      title: q
        ? `Quote ${q.status.replace(/_/g, " ")} — ${q.customerName || "customer"} · ${money(q.totalCents, q.currency)}`
        : "Quote event",
    };
  }
  if (e.type === "approval") {
    const title =
      typeof e.payload.title === "string" && e.payload.title
        ? e.payload.title
        : "Approval update";
    const status =
      typeof e.payload.status === "string" ? ` (${e.payload.status})` : "";
    return {
      icon: CheckCircleIcon,
      tint: "text-warning",
      title: `${title}${status}`,
    };
  }
  // followup
  const p = e.payload as ReasoningPayload & { draftText?: string };
  return {
    icon: ClockIcon,
    tint: "text-muted",
    title: p.summary || "Follow-up scheduled",
    ...(p.detail || p.draftText ? { detail: p.detail || p.draftText } : {}),
  };
}

/**
 * Compact icon-timeline of reasoning steps for one session — the small
 * treatment used in the cockpit's right context panel. `items` oldest-first.
 */
export function ReasoningTimeline({ items }: { items: ConvEvent[] }) {
  return (
    <ol className="space-y-2">
      {items.map((e) => {
        const row = describe(e);
        const RowIcon = row.icon;
        return (
          <li key={e.id} className="flex items-start gap-2">
            <span className={`mt-0.5 shrink-0 ${row.tint}`}>
              <RowIcon className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs leading-snug text-ink">{row.title}</p>
              {row.detail && (
                <p className="mt-0.5 line-clamp-2 text-[11px] text-muted">
                  {row.detail}
                </p>
              )}
              <p className="mt-0.5 text-[10px] text-faint tabular-nums">
                {clockTime(e.ts)}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Live reasoning feed. `items` are newest-first, accumulated by the cockpit. */
export function ActivityFeed({ items }: { items: ConvEvent[] }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  if (items.length === 0) {
    return (
      <CenteredState
        icon={<ActivityIcon className="size-6" />}
        title="Nothing yet"
        hint="Reasoning events appear here as the agent works — send a message from the Customer view to see it think."
      />
    );
  }

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <ul className="divide-y divide-line/60">
      {items.map((e) => {
        const row = describe(e);
        const RowIcon = row.icon;
        const isOpen = expanded.has(e.id);
        const expandable = Boolean(row.detail);
        return (
          <li key={e.id}>
            <div
              role={expandable ? "button" : undefined}
              tabIndex={expandable ? 0 : undefined}
              onClick={expandable ? () => toggle(e.id) : undefined}
              onKeyDown={
                expandable
                  ? (ev) => {
                      if (ev.key === "Enter" || ev.key === " ") {
                        ev.preventDefault();
                        toggle(e.id);
                      }
                    }
                  : undefined
              }
              className={`flex items-start gap-2.5 px-4 py-2.5 ${expandable ? "cursor-pointer hover:bg-panel-2/60" : ""}`}
            >
              <span className={`mt-0.5 shrink-0 ${row.tint}`}>
                <RowIcon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink">{row.title}</p>
                <p className="mt-0.5 text-[11px] text-faint tabular-nums">
                  {clockTime(e.ts)} · session {shortId(e.sessionId)}
                </p>
                {isOpen && row.detail && (
                  <p className="mt-1.5 rounded-md bg-panel-2 px-2.5 py-1.5 text-xs whitespace-pre-wrap text-muted">
                    {row.detail}
                  </p>
                )}
              </div>
              {expandable && (
                <span className="mt-1 shrink-0 text-faint">
                  {isOpen ? (
                    <ChevronDownIcon className="size-3.5" />
                  ) : (
                    <ChevronRightIcon className="size-3.5" />
                  )}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
