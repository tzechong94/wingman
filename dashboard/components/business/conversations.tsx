"use client";

import { api, ApiError, isAuthError } from "@/lib/api";
import { clockTime, shortId, timeAgo } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { useFetch } from "@/lib/use-fetch";
import type {
  ConversationSummary,
  ConvEvent,
  MsgInPayload,
  MsgOutPayload,
  ReasoningPayload,
} from "@/lib/types";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { MessageSquareIcon, SendIcon, UserIcon, ZapIcon } from "../icons";
import { Button, CenteredState, Modal, Spinner, StatusChip } from "../ui";

export function ConversationsTab({
  conversations,
  loading,
  error,
  onReload,
  onAuthLost,
}: {
  conversations: ConversationSummary[];
  loading: boolean;
  error: unknown;
  onReload: () => void;
  onAuthLost: () => void;
}) {
  const [open, setOpen] = useState<ConversationSummary | null>(null);

  if (loading && conversations.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted">
        <Spinner className="size-4" /> Loading conversations…
      </div>
    );
  }

  if (error && conversations.length === 0) {
    return (
      <CenteredState
        title="Couldn't load conversations"
        action={
          <Button size="sm" onClick={onReload}>
            Retry
          </Button>
        }
      />
    );
  }

  if (conversations.length === 0) {
    return (
      <CenteredState
        icon={<MessageSquareIcon className="size-6" />}
        title="No conversations yet"
        hint="Every customer chat shows up here the moment it starts."
      />
    );
  }

  return (
    <>
      <ul className="divide-y divide-line/60">
        {conversations.map((c) => (
          <li key={c.sessionId}>
            <button
              type="button"
              onClick={() => setOpen(c)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-panel-2/60"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink">
                  {c.preview || "(no preview)"}
                </p>
                <p className="mt-0.5 text-[11px] text-faint tabular-nums">
                  session {shortId(c.sessionId)} · {timeAgo(c.lastTs)}
                </p>
              </div>
              <StatusChip
                tone={c.lastType === "error" ? "critical" : "neutral"}
                label={c.lastType.replace(/_/g, " ") || "—"}
              />
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <TranscriptModal
          conversation={open}
          onClose={() => setOpen(null)}
          onAuthLost={onAuthLost}
        />
      )}
    </>
  );
}

interface OwnerEcho {
  key: number;
  text: string;
  ts: number;
}

function TranscriptModal({
  conversation,
  onClose,
  onAuthLost,
}: {
  conversation: ConversationSummary;
  onClose: () => void;
  onAuthLost: () => void;
}) {
  const { toast } = useToast();
  const [warping, setWarping] = useState(false);
  const { data, loading, error, reload, mutate } = useFetch(() =>
    api.transcript({ sessionId: conversation.sessionId }),
  );

  // --- owner barge-in composer ----------------------------------------------
  const [reply, setReply] = useState("");
  const [replySending, setReplySending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [echoes, setEchoes] = useState<OwnerEcho[]>([]);
  const echoKeyRef = useRef(1);
  const replyInputRef = useRef<HTMLInputElement>(null);

  // Hide an optimistic echo once the real msg_out event lands in the transcript.
  const visibleEchoes = useMemo(() => {
    if (!data) return echoes;
    return echoes.filter(
      (echo) =>
        !data.some((e) => {
          if (e.type !== "msg_out") return false;
          const p = e.payload as MsgOutPayload;
          return p.fromOwner === true && p.text === echo.text;
        }),
    );
  }, [data, echoes]);

  const sendReply = async () => {
    const text = reply.trim();
    if (!text || replySending) return;

    const echo: OwnerEcho = { key: echoKeyRef.current++, text, ts: Date.now() };
    setReplySending(true);
    setReplyError(null);
    setEchoes((prev) => [...prev, echo]);
    setReply("");

    try {
      await api.ownerReply(conversation.sessionId, text);
      // Silent refetch — the backend records the owner message asynchronously,
      // so the echo stays visible until the real event shows up.
      try {
        const events = await api.transcript({ sessionId: conversation.sessionId });
        mutate(() => events);
      } catch {
        // Refetch is best-effort; the optimistic echo keeps the reply visible.
      }
    } catch (err) {
      setEchoes((prev) => prev.filter((e) => e.key !== echo.key));
      setReply(text);
      if (isAuthError(err)) {
        onAuthLost();
        return;
      }
      setReplyError(
        err instanceof ApiError && err.message
          ? err.message
          : "Couldn't send that reply — try again.",
      );
    } finally {
      setReplySending(false);
      replyInputRef.current?.focus();
    }
  };

  const onReplyKey = (ev: KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      void sendReply();
    }
  };

  const timewarp = async () => {
    setWarping(true);
    try {
      const res = await api.timewarp(conversation.sessionId);
      toast(
        res.warped > 0
          ? `Time-warped ${res.warped} pending follow-up${res.warped === 1 ? "" : "s"} — watch the chat.`
          : "No pending follow-ups to fire for this conversation.",
        res.warped > 0 ? "success" : "info",
      );
    } catch (err) {
      if (isAuthError(err)) {
        onAuthLost();
        return;
      }
      toast("Time-warp failed — try again.", "error");
    } finally {
      setWarping(false);
    }
  };

  return (
    <Modal
      wide
      title={`Conversation · ${shortId(conversation.sessionId, 8)}`}
      onClose={onClose}
      headerExtra={
        <Button size="sm" loading={warping} onClick={() => void timewarp()}>
          <ZapIcon className="size-3.5" />
          Time-warp
        </Button>
      }
    >
      <div className="space-y-2 px-4 py-4">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted">
            <Spinner className="size-4" /> Loading transcript…
          </div>
        )}
        {Boolean(error) && !loading && (
          <CenteredState
            title="Couldn't load this transcript"
            action={
              <Button size="sm" onClick={reload}>
                Retry
              </Button>
            }
          />
        )}
        {!loading && data && data.length === 0 && visibleEchoes.length === 0 && (
          <CenteredState title="Empty conversation" />
        )}
        {data?.map((e) => <TranscriptRow key={e.id} event={e} />)}
        {visibleEchoes.map((echo) => (
          <OwnerBubble
            key={`echo-${echo.key}`}
            text={echo.text}
            ts={echo.ts}
            pending
          />
        ))}
      </div>

      {/* owner barge-in composer, pinned to the bottom of the modal */}
      <div className="sticky bottom-0 border-t border-line bg-panel px-4 py-3">
        {replyError && (
          <p className="mb-2 text-xs text-critical" role="alert">
            {replyError}
          </p>
        )}
        <div className="flex items-center gap-2">
          <input
            ref={replyInputRef}
            type="text"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={onReplyKey}
            disabled={replySending}
            placeholder="Reply as owner…"
            aria-label="Reply as owner"
            className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-faint disabled:opacity-60"
          />
          <Button
            variant="primary"
            size="md"
            loading={replySending}
            disabled={!reply.trim()}
            onClick={() => void sendReply()}
          >
            {!replySending && <SendIcon className="size-3.5" />}
            Send
          </Button>
        </div>
        <p className="mt-1.5 text-[10px] text-faint">
          Sends to the customer as you — the agent sees it too.
        </p>
      </div>
    </Modal>
  );
}

function OwnerBubble({
  text,
  ts,
  pending = false,
}: {
  text: string;
  ts: number;
  pending?: boolean;
}) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[75%] rounded-xl rounded-bl-sm border border-accent/40 bg-accent-soft/60 px-3 py-1.5 text-sm whitespace-pre-wrap text-ink">
        <span className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold tracking-wide text-accent-strong uppercase">
          <UserIcon className="size-3" />
          Owner
        </span>
        {text}
        <span className="mt-0.5 block text-[10px] text-faint tabular-nums">
          {pending ? "Sending…" : clockTime(ts)}
        </span>
      </div>
    </div>
  );
}

function TranscriptRow({ event }: { event: ConvEvent }) {
  if (event.type === "msg_in") {
    const p = event.payload as MsgInPayload;
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] rounded-xl rounded-br-sm bg-accent px-3 py-1.5 text-sm whitespace-pre-wrap text-on-accent">
          {p.text || "(photo)"}
          <span className="mt-0.5 block text-right text-[10px] opacity-75 tabular-nums">
            {clockTime(event.ts)}
          </span>
        </div>
      </div>
    );
  }

  if (event.type === "msg_out") {
    const p = event.payload as MsgOutPayload;
    const text =
      p.text || (typeof p.askQuestion === "string" ? p.askQuestion : "") || "(quote)";
    if (p.fromOwner === true) {
      return <OwnerBubble text={text} ts={event.ts} />;
    }
    return (
      <div className="flex justify-start">
        <div className="max-w-[75%] rounded-xl rounded-bl-sm border border-line bg-panel-2/60 px-3 py-1.5 text-sm whitespace-pre-wrap text-ink">
          {text}
          <span className="mt-0.5 block text-[10px] text-faint tabular-nums">
            {clockTime(event.ts)}
          </span>
        </div>
      </div>
    );
  }

  // reasoning / quote / approval / followup / error — muted meta rows
  const p = event.payload as ReasoningPayload;
  const label =
    p.summary ||
    (event.type === "quote"
      ? "Quote created"
      : event.type === "approval"
        ? "Approval update"
        : event.type === "followup"
          ? "Follow-up"
          : event.type === "error"
            ? "Error"
            : "Event");
  return (
    <p className="px-2 text-center text-[11px] text-faint">
      <span className="rounded-full bg-panel-2 px-2 py-0.5">
        {event.type.replace(/_/g, " ")} · {label}
      </span>
    </p>
  );
}
