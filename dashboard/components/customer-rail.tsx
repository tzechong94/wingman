"use client";

import { dateTime, shortId, timeAgo } from "@/lib/format";
import type {
  DemoChatSummary,
  MyChatsSnapshot,
  MyChatSummary,
} from "@/lib/types";
import type { ReactNode } from "react";
import { PlusIcon, SnowflakeIcon } from "./icons";
import { Button, cn } from "./ui";

/** What the customer view's chat surface is currently showing. */
export type CustomerSelection =
  | { kind: "live" }
  | {
      kind: "replay";
      sessionId: string;
      name: string;
      variant: "demo" | "closed";
    };

/** Display name for a seeded demo chat: customer name when known. */
export function demoChatName(c: DemoChatSummary): string {
  return c.customerName || `Walk-in ${shortId(c.sessionId, 4)}`;
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? "";
  const last =
    parts.length > 1
      ? (parts[parts.length - 1]?.charAt(0) ?? "")
      : (parts[0]?.charAt(1) ?? "");
  return (first + last).toUpperCase() || "?";
}

/**
 * Left rail of the phone-messenger customer view: mini brand + "New chat",
 * this browser's own chats, then the seeded demo conversations.
 */
export function CustomerRail({
  myChats,
  myChatsLoading,
  demoChats,
  demoChatsLoading,
  demoChatsError,
  onReloadDemoChats,
  selection,
  onSelect,
  onNewChat,
  creatingChat,
}: {
  myChats: MyChatsSnapshot | null;
  myChatsLoading: boolean;
  demoChats: DemoChatSummary[] | null;
  demoChatsLoading: boolean;
  demoChatsError: unknown;
  onReloadDemoChats: () => void;
  selection: CustomerSelection;
  onSelect: (next: CustomerSelection) => void;
  onNewChat: () => void;
  creatingChat: boolean;
}) {
  const activeSessionId = myChats?.activeSessionId ?? null;
  const ownChats = myChats?.chats ?? [];

  const selectOwn = (c: MyChatSummary) => {
    if (c.status === "active" && c.sessionId === activeSessionId) {
      onSelect({ kind: "live" });
    } else {
      onSelect({
        kind: "replay",
        sessionId: c.sessionId,
        name: dateTime(c.createdAt),
        variant: "closed",
      });
    }
  };

  return (
    <aside className="flex h-full w-full flex-col border-r border-line bg-panel">
      {/* mini brand + new chat */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent text-on-accent">
            <SnowflakeIcon className="size-3.5" />
          </span>
          <span className="truncate text-sm font-semibold text-ink">
            CoolBreeze <span aria-hidden="true">❄️</span>
          </span>
        </span>
        <Button
          variant="primary"
          size="sm"
          onClick={onNewChat}
          loading={creatingChat}
          className="shrink-0"
        >
          {!creatingChat && <PlusIcon className="size-3.5" />}
          New chat
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {/* your chats */}
        <SectionLabel>Your chats</SectionLabel>
        {myChatsLoading && ownChats.length === 0 && <RowSkeleton count={2} />}
        {!myChatsLoading && ownChats.length === 0 && (
          <p className="px-3 py-2 text-xs text-faint">
            No chats yet — say hi with New chat.
          </p>
        )}
        <ul>
          {ownChats.map((c) => {
            const isActive =
              c.status === "active" && c.sessionId === activeSessionId;
            const selected = isActive
              ? selection.kind === "live"
              : selection.kind === "replay" &&
                selection.sessionId === c.sessionId;
            return (
              <li key={c.sessionId}>
                <ChatRow
                  selected={selected}
                  onClick={() => selectOwn(c)}
                  avatar={isActive ? "You" : c.sessionId.slice(-2).toUpperCase()}
                  avatarTone={isActive ? "accent" : "muted"}
                  title={isActive ? "Your chat" : dateTime(c.createdAt)}
                  tag={
                    isActive ? (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-accent/30 bg-accent-soft px-1.5 py-px text-[9px] font-medium text-accent-strong">
                        <span className="size-1 rounded-full bg-accent" />
                        active
                      </span>
                    ) : undefined
                  }
                  time={timeAgo(c.lastTs)}
                  preview={c.preview || "(no messages yet)"}
                />
              </li>
            );
          })}
        </ul>

        {/* demo customers */}
        <SectionLabel className="mt-3">Demo customers</SectionLabel>
        <p className="px-3 pb-1.5 text-[11px] leading-snug text-faint">
          Real seeded conversations — browse how customers experience
          CoolBreeze.
        </p>
        {demoChatsLoading && (demoChats?.length ?? 0) === 0 && (
          <RowSkeleton count={4} />
        )}
        {Boolean(demoChatsError) &&
          !demoChatsLoading &&
          (demoChats?.length ?? 0) === 0 && (
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              <p className="text-xs text-faint">Couldn&rsquo;t load demos.</p>
              <Button size="sm" onClick={onReloadDemoChats}>
                Retry
              </Button>
            </div>
          )}
        {!demoChatsLoading &&
          !demoChatsError &&
          (demoChats?.length ?? 0) === 0 && (
            <p className="px-3 py-2 text-xs text-faint">
              No demo conversations seeded yet.
            </p>
          )}
        <ul>
          {(demoChats ?? []).map((c) => {
            const name = demoChatName(c);
            const selected =
              selection.kind === "replay" &&
              selection.sessionId === c.sessionId;
            return (
              <li key={c.sessionId}>
                <ChatRow
                  selected={selected}
                  onClick={() =>
                    onSelect({
                      kind: "replay",
                      sessionId: c.sessionId,
                      name,
                      variant: "demo",
                    })
                  }
                  avatar={initialsFor(name)}
                  avatarTone={c.customerName ? "accent" : "muted"}
                  title={name}
                  tag={
                    <span className="shrink-0 rounded border border-line px-1 text-[9px] tracking-wide text-faint uppercase">
                      demo
                    </span>
                  }
                  time={timeAgo(c.lastTs)}
                  preview={c.preview || "(no preview)"}
                />
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------

function SectionLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "px-3 pt-3 pb-1 text-[10px] font-semibold tracking-wide text-faint uppercase",
        className,
      )}
    >
      {children}
    </p>
  );
}

function ChatRow({
  selected,
  onClick,
  avatar,
  avatarTone,
  title,
  tag,
  time,
  preview,
}: {
  selected: boolean;
  onClick: () => void;
  avatar: string;
  avatarTone: "accent" | "muted";
  title: string;
  tag?: ReactNode;
  time: string;
  preview: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
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
          avatarTone === "accent"
            ? "bg-accent text-on-accent"
            : "bg-panel-2 text-muted",
        )}
      >
        {avatar}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium text-ink">
              {title}
            </span>
            {tag}
          </span>
          <span className="shrink-0 text-[10px] text-faint tabular-nums">
            {time}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted">
          {preview}
        </span>
      </span>
    </button>
  );
}

function RowSkeleton({ count }: { count: number }) {
  return (
    <div className="space-y-1 px-3 py-1" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
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
