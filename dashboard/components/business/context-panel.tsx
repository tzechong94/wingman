"use client";

import { api } from "@/lib/api";
import { money, timeAgo } from "@/lib/format";
import type {
  ApprovalItem,
  ConvEvent,
  MemoryEpisode,
  QuoteRecord,
} from "@/lib/types";
import { useFetch } from "@/lib/use-fetch";
import { useEffect, useMemo, type ReactNode } from "react";
import {
  ActivityIcon,
  BrainIcon,
  ClockIcon,
  DownloadIcon,
  FileTextIcon,
  XIcon,
} from "../icons";
import { QUOTE_STATUS_META } from "../quote-card";
import { cn, StatusChip } from "../ui";
import { ReasoningTimeline } from "./activity";
import { SessionApprovals } from "./approvals";

const MEMORY_POLL_MS = 15_000;
const MAX_TIMELINE_ITEMS = 100;

/**
 * Right pane of the inbox: per-chat context — pending approvals, quotes,
 * linked customer memory and the live reasoning timeline. Collapses into a
 * toggleable drawer below 1100px viewport width.
 */
export function ContextPanel({
  sessionId,
  customerName,
  approvals,
  approvalsLoading,
  onDecided,
  onReloadApprovals,
  onAuthLost,
  quotes,
  quotesLoading,
  quotePdfUrls,
  events,
  open,
  onClose,
}: {
  sessionId: string;
  customerName: string | null;
  /** Already filtered to this session. */
  approvals: ApprovalItem[];
  approvalsLoading: boolean;
  onDecided: (approvalId: string, decision: "approve" | "reject") => void;
  onReloadApprovals: () => void;
  onAuthLost: () => void;
  /** Already filtered to this session. */
  quotes: QuoteRecord[];
  quotesLoading: boolean;
  /** quoteId → PDF url, mined from this session's transcript events. */
  quotePdfUrls: Map<string, string>;
  /** This session's transcript events (for the reasoning timeline). */
  events: ConvEvent[];
  /** Drawer state at <1100px; ignored at wide viewports (always visible). */
  open: boolean;
  onClose: () => void;
}) {
  const memoryFetch = useFetch(() => api.memory());
  const { reload: reloadMemory } = memoryFetch;
  useEffect(() => {
    const timer = setInterval(reloadMemory, MEMORY_POLL_MS);
    return () => clearInterval(timer);
  }, [reloadMemory]);

  const linkedEpisodes = useMemo(() => {
    if (!customerName || !memoryFetch.data?.available) return [];
    const needle = customerName.toLowerCase();
    return memoryFetch.data.episodes.filter((ep) =>
      ep.content.toLowerCase().includes(needle),
    );
  }, [customerName, memoryFetch.data]);

  const timeline = useMemo(
    () =>
      events
        .filter(
          (e) =>
            e.type === "reasoning" ||
            e.type === "quote" ||
            e.type === "approval" ||
            e.type === "followup",
        )
        .slice(-MAX_TIMELINE_ITEMS),
    [events],
  );

  const sortedQuotes = useMemo(
    () => [...quotes].sort((a, b) => b.createdAt - a.createdAt),
    [quotes],
  );

  return (
    <aside
      aria-label="Chat context"
      className={cn(
        "w-80 shrink-0 flex-col border-l border-line bg-panel",
        "min-[1100px]:static min-[1100px]:z-auto min-[1100px]:flex min-[1100px]:shadow-none",
        open ? "absolute inset-y-0 right-0 z-30 flex shadow-xl" : "hidden",
      )}
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-3.5">
        <h2 className="text-[11px] font-semibold tracking-wide text-muted uppercase">
          Context
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close context panel"
          className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-ink min-[1100px]:hidden"
        >
          <XIcon className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3.5 py-4">
        {/* 1 — Needs you */}
        <Section
          icon={<ClockIcon className="size-3.5" />}
          title="Needs you"
          count={approvals.filter((a) => a.status === "pending").length}
        >
          {approvalsLoading && approvals.length === 0 ? (
            <SkeletonBlock lines={2} />
          ) : (
            <SessionApprovals
              key={sessionId}
              approvals={approvals}
              onDecided={onDecided}
              onReload={onReloadApprovals}
              onAuthLost={onAuthLost}
            />
          )}
        </Section>

        {/* 2 — Quotes */}
        <Section
          icon={<FileTextIcon className="size-3.5" />}
          title="Quotes"
          count={sortedQuotes.length}
        >
          {quotesLoading && sortedQuotes.length === 0 ? (
            <SkeletonBlock lines={2} />
          ) : sortedQuotes.length === 0 ? (
            <p className="text-xs text-faint">No quotes in this chat yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {sortedQuotes.map((q) => {
                const meta = QUOTE_STATUS_META[q.status] ?? {
                  label: q.status,
                  tone: "neutral" as const,
                };
                const pdfUrl = quotePdfUrls.get(q.id);
                return (
                  <li
                    key={q.id}
                    className="flex items-center gap-2 rounded-lg border border-line/60 bg-panel px-2.5 py-2"
                  >
                    <span className="text-sm font-semibold text-ink tabular-nums">
                      {money(q.totalCents, q.currency)}
                    </span>
                    <StatusChip tone={meta.tone} label={meta.label} />
                    <span className="ml-auto shrink-0 text-[10px] text-faint tabular-nums">
                      {timeAgo(q.createdAt)}
                    </span>
                    {pdfUrl && (
                      <a
                        href={pdfUrl}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="Download quote PDF"
                        title="Download quote PDF"
                        className="shrink-0 rounded p-1 text-accent-strong hover:bg-panel-2"
                      >
                        <DownloadIcon className="size-3.5" />
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        {/* 3 — Customer memory */}
        <Section
          icon={<BrainIcon className="size-3.5" />}
          title="Customer memory"
          count={linkedEpisodes.length}
        >
          {memoryFetch.loading && memoryFetch.data === null ? (
            <SkeletonBlock lines={3} />
          ) : linkedEpisodes.length === 0 ? (
            <p className="text-xs text-faint">No linked memory records.</p>
          ) : (
            <ul className="space-y-1.5">
              {linkedEpisodes.map((ep, i) => (
                <MemoryEpisodeRow key={i} episode={ep} />
              ))}
            </ul>
          )}
        </Section>

        {/* 4 — Live reasoning */}
        <Section
          icon={<ActivityIcon className="size-3.5" />}
          title="Live reasoning"
          count={timeline.length}
        >
          {timeline.length === 0 ? (
            <p className="text-xs text-faint">
              Reasoning steps appear here as the agent works this chat.
            </p>
          ) : (
            <ReasoningTimeline items={timeline} />
          )}
        </Section>
      </div>
    </aside>
  );
}

/** Empty-state panel shown when no chat is selected. */
export function ContextPanelEmpty({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label="Chat context"
      className={cn(
        "w-80 shrink-0 flex-col border-l border-line bg-panel",
        "min-[1100px]:static min-[1100px]:z-auto min-[1100px]:flex min-[1100px]:shadow-none",
        open ? "absolute inset-y-0 right-0 z-30 flex shadow-xl" : "hidden",
      )}
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-3.5">
        <h2 className="text-[11px] font-semibold tracking-wide text-muted uppercase">
          Context
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close context panel"
          className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-ink min-[1100px]:hidden"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      <p className="px-4 py-8 text-center text-xs text-faint">
        Approvals, quotes, memory and reasoning for the selected chat show up
        here.
      </p>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Bits
// ---------------------------------------------------------------------------

function Section({
  icon,
  title,
  count,
  children,
}: {
  icon: ReactNode;
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">
        <span className="text-faint">{icon}</span>
        {title}
        {count !== undefined && count > 0 && (
          <span className="font-normal text-faint tabular-nums">{count}</span>
        )}
      </h3>
      {children}
    </section>
  );
}

function SkeletonBlock({ lines }: { lines: number }) {
  return (
    <div className="space-y-1.5" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="h-8 animate-pulse rounded-lg bg-panel-2/50" />
      ))}
    </div>
  );
}

/** Compact episode card: content + recall count. */
function MemoryEpisodeRow({ episode }: { episode: MemoryEpisode }) {
  const recalled = episode.accessCount > 0;
  return (
    <li className="rounded-lg border border-line/60 bg-panel px-2.5 py-2">
      <p className="line-clamp-3 text-xs text-ink">{episode.content}</p>
      <p className="mt-1 flex items-center justify-between gap-2">
        <span
          className={
            recalled
              ? "inline-flex items-center gap-1 text-[10px] font-semibold text-accent tabular-nums"
              : "text-[10px] text-faint tabular-nums"
          }
        >
          {recalled && <BrainIcon className="size-3" />}
          recalled {episode.accessCount}×
        </span>
        <span className="text-[10px] text-faint tabular-nums">
          {recalled
            ? timeAgo(episode.lastAccessedAt)
            : timeAgo(episode.createdAt)}
        </span>
      </p>
    </li>
  );
}
