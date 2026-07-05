"use client";

import { humanizeSeconds, money, shortId, timeAgo } from "@/lib/format";
import type { Analytics, ConversationSummary } from "@/lib/types";
import { useMemo, useState, type ReactNode } from "react";
import { MessageSquareIcon, SearchIcon } from "../icons";
import { Button, CenteredState, cn } from "../ui";

/** Display name for a chat: customer name when known, else the visitor id. */
export function conversationName(c: ConversationSummary): string {
  return c.customerName || `Visitor ${shortId(c.sessionId, 4)}`;
}

function initials(c: ConversationSummary): string {
  if (c.customerName) {
    const parts = c.customerName.trim().split(/\s+/).filter(Boolean);
    const first = parts[0]?.charAt(0) ?? "";
    const last =
      parts.length > 1
        ? (parts[parts.length - 1]?.charAt(0) ?? "")
        : (parts[0]?.charAt(1) ?? "");
    return (first + last).toUpperCase() || "?";
  }
  return c.sessionId.slice(-2).toUpperCase() || "?";
}

/**
 * Left pane of the WhatsApp-style inbox: search, a slim analytics strip and
 * the conversation list with unread-style approval badges.
 */
export function ChatList({
  conversations,
  loading,
  error,
  onReload,
  analytics,
  selectedId,
  onSelect,
  pendingBySession,
}: {
  conversations: ConversationSummary[];
  loading: boolean;
  error: unknown;
  onReload: () => void;
  analytics: Analytics | null;
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  /** Live pending-approval counts (from the approvals fetch) — overrides the snapshot counts. */
  pendingBySession: Map<string, number> | null;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = [...conversations].sort((a, b) => b.lastTs - a.lastTs);
    if (!q) return list;
    return list.filter(
      (c) =>
        (c.customerName ?? "").toLowerCase().includes(q) ||
        c.preview.toLowerCase().includes(q) ||
        c.sessionId.toLowerCase().includes(q),
    );
  }, [conversations, query]);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel sm:w-72">
      <div className="shrink-0 space-y-2.5 border-b border-line px-3 py-2.5">
        <label className="flex h-8 items-center gap-2 rounded-lg border border-line bg-surface px-2.5">
          <SearchIcon className="size-3.5 shrink-0 text-faint" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
            aria-label="Search conversations"
            className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-faint"
          />
        </label>
        <AnalyticsStrip analytics={analytics} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && conversations.length === 0 && <ListSkeleton />}

        {Boolean(error) && !loading && conversations.length === 0 && (
          <CenteredState
            title="Couldn't load chats"
            action={
              <Button size="sm" onClick={onReload}>
                Retry
              </Button>
            }
          />
        )}

        {!loading && !error && conversations.length === 0 && (
          <CenteredState
            icon={<MessageSquareIcon className="size-6" />}
            title="No conversations yet"
            hint="Every customer chat shows up here the moment it starts."
          />
        )}

        {conversations.length > 0 && filtered.length === 0 && (
          <p className="px-4 py-8 text-center text-xs text-faint">
            No chats match “{query.trim()}”.
          </p>
        )}

        <ul>
          {filtered.map((c) => {
            const selected = c.sessionId === selectedId;
            const pending =
              pendingBySession?.get(c.sessionId) ?? c.pendingApprovals;
            return (
              <li key={c.sessionId}>
                <button
                  type="button"
                  onClick={() => onSelect(c.sessionId)}
                  aria-current={selected ? "true" : undefined}
                  className={cn(
                    "flex w-full items-center gap-2.5 border-b border-line/50 px-3 py-2.5 text-left",
                    selected ? "bg-accent-soft/70" : "hover:bg-panel-2/60",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                      c.customerName
                        ? "bg-accent text-on-accent"
                        : "bg-panel-2 text-muted",
                    )}
                  >
                    {initials(c)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="flex min-w-0 items-baseline gap-1.5">
                        <span className="truncate text-sm font-medium text-ink">
                          {conversationName(c)}
                        </span>
                        {c.sessionId.startsWith("seed-sess-") ? (
                          <span className="shrink-0 rounded border border-line px-1 text-[9px] uppercase tracking-wide text-faint">
                            History
                          </span>
                        ) : (
                          <span className="shrink-0 text-[9px] text-faint tabular-nums">
                            #{shortId(c.sessionId, 4)}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-[10px] text-faint tabular-nums">
                        {timeAgo(c.lastTs)}
                      </span>
                    </span>
                    <span className="mt-0.5 flex items-center justify-between gap-2">
                      <span className="truncate text-xs text-muted">
                        {c.preview || "(no preview)"}
                      </span>
                      {pending > 0 && (
                        <span
                          className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-critical px-1 text-[10px] font-semibold text-white tabular-nums"
                          aria-label={`${pending} pending approval${pending === 1 ? "" : "s"}`}
                        >
                          {pending}
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-1 px-3 py-2" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-2.5 py-2">
          <div className="size-9 shrink-0 animate-pulse rounded-full bg-panel-2/70" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3 w-2/3 animate-pulse rounded bg-panel-2/70" />
            <div className="h-2.5 w-full animate-pulse rounded bg-panel-2/50" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slim analytics strip: the 4 tiles as a 2×2 micro-grid
// ---------------------------------------------------------------------------

function AnalyticsStrip({ analytics }: { analytics: Analytics | null }) {
  if (!analytics) {
    return (
      <div className="grid grid-cols-2 gap-1.5" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-9 animate-pulse rounded-md bg-panel-2/50" />
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-1.5">
      <MicroStat label="Quotes 7d" value={String(analytics.quotesSent7d)} />
      <MicroStat
        label="Auto · escalated"
        value={
          <>
            {analytics.autoSent7d}
            <span className="font-normal text-faint"> · </span>
            {analytics.escalated7d}
          </>
        }
      />
      <MicroStat
        label="Median reply"
        value={humanizeSeconds(analytics.medianResponseSeconds)}
      />
      <MicroStat
        label="Quoted 7d"
        value={money(analytics.centsQuoted7d, analytics.currency)}
      />
    </div>
  );
}

function MicroStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-md bg-panel-2/60 px-2 py-1">
      <p className="truncate text-[9px] font-semibold tracking-wide text-faint uppercase">
        {label}
      </p>
      <p className="truncate text-xs font-semibold text-ink tabular-nums">
        {value}
      </p>
    </div>
  );
}
