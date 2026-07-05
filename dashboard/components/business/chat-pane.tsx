"use client";

import { api, ApiError, isAuthError } from "@/lib/api";
import { clockTime, shortId } from "@/lib/format";
import { useToast } from "@/lib/toast";
import {
  normalizeQuote,
  type ConversationSummary,
  type ConvEvent,
  type MsgInPayload,
  type MsgOutPayload,
  type ReasoningPayload,
} from "@/lib/types";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  MessageSquareIcon,
  PanelRightIcon,
  SendIcon,
  UserIcon,
  ZapIcon,
} from "../icons";
import { QuoteCard } from "../quote-card";
import { Button, CenteredState, cn, Spinner } from "../ui";
import { conversationName } from "./chat-list";

interface OwnerEcho {
  key: number;
  text: string;
  ts: number;
}

/**
 * Center pane of the inbox: chat header (with time-warp), the transcript and
 * the owner barge-in composer pinned to the bottom.
 */
export function ChatPane({
  conversation,
  events,
  loading,
  error,
  onReload,
  onAuthLost,
  contextOpen,
  onToggleContext,
}: {
  conversation: ConversationSummary;
  events: ConvEvent[];
  loading: boolean;
  error: unknown;
  onReload: () => void;
  onAuthLost: () => void;
  contextOpen: boolean;
  onToggleContext: () => void;
}) {
  const { toast } = useToast();
  const [warping, setWarping] = useState(false);

  // --- owner barge-in composer ---------------------------------------------
  const [reply, setReply] = useState("");
  const [replySending, setReplySending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [echoes, setEchoes] = useState<OwnerEcho[]>([]);
  const echoKeyRef = useRef(1);
  const replyInputRef = useRef<HTMLInputElement>(null);

  // Reset composer state when switching chats.
  const sessionId = conversation.sessionId;
  useEffect(() => {
    setReply("");
    setReplyError(null);
    setEchoes([]);
  }, [sessionId]);

  // Hide an optimistic echo once the real msg_out event lands in the transcript.
  const visibleEchoes = useMemo(
    () =>
      echoes.filter(
        (echo) =>
          !events.some((e) => {
            if (e.type !== "msg_out") return false;
            const p = e.payload as MsgOutPayload;
            return p.fromOwner === true && p.text === echo.text;
          }),
      ),
    [events, echoes],
  );

  // --- transcript scroll: stick to bottom unless the user scrolled up -------
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const lastCount = events.length + visibleEchoes.length;

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  // Always jump to the bottom when the chat changes…
  useLayoutEffect(() => {
    atBottomRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sessionId]);

  // …and follow new events only while pinned to the bottom.
  useEffect(() => {
    if (!atBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastCount]);

  const sendReply = async () => {
    const text = reply.trim();
    if (!text || replySending) return;

    const echo: OwnerEcho = { key: echoKeyRef.current++, text, ts: Date.now() };
    setReplySending(true);
    setReplyError(null);
    setEchoes((prev) => [...prev, echo]);
    setReply("");

    try {
      await api.ownerReply(sessionId, text);
      // The SSE firehose delivers the recorded msg_out; a silent refetch is a
      // best-effort fallback in case the stream is reconnecting.
      onReload();
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
      const res = await api.timewarp(sessionId);
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
    <section className="flex min-w-0 flex-1 flex-col bg-surface">
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-line bg-panel px-3.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="truncate text-sm font-semibold text-ink">
            {conversationName(conversation)}
          </h2>
          <span className="shrink-0 rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[10px] text-muted tabular-nums">
            {shortId(sessionId, 8)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" loading={warping} onClick={() => void timewarp()}>
            <ZapIcon className="size-3.5" />
            Time-warp
          </Button>
          <button
            type="button"
            onClick={onToggleContext}
            aria-label={contextOpen ? "Hide context panel" : "Show context panel"}
            aria-expanded={contextOpen}
            className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-ink min-[1100px]:hidden"
          >
            <PanelRightIcon className="size-4" />
          </button>
        </div>
      </div>

      {/* Transcript */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4"
      >
        {loading && events.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted">
            <Spinner className="size-4" /> Loading transcript…
          </div>
        )}
        {Boolean(error) && !loading && events.length === 0 && (
          <CenteredState
            title="Couldn't load this transcript"
            action={
              <Button size="sm" onClick={onReload}>
                Retry
              </Button>
            }
          />
        )}
        {!loading &&
          !error &&
          events.length === 0 &&
          visibleEchoes.length === 0 && <CenteredState title="Empty conversation" />}
        {events.map((e) => (
          <TranscriptRow key={e.id} event={e} />
        ))}
        {visibleEchoes.map((echo) => (
          <OwnerBubble
            key={`echo-${echo.key}`}
            text={echo.text}
            ts={echo.ts}
            pending
          />
        ))}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-line bg-panel px-4 py-3">
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
    </section>
  );
}

/** Friendly placeholder when no chat is selected. */
export function ChatPaneEmpty({
  contextOpen,
  onToggleContext,
}: {
  contextOpen: boolean;
  onToggleContext: () => void;
}) {
  return (
    <section className="relative flex min-w-0 flex-1 flex-col items-center justify-center bg-surface">
      <button
        type="button"
        onClick={onToggleContext}
        aria-label={contextOpen ? "Hide context panel" : "Show context panel"}
        aria-expanded={contextOpen}
        className="absolute top-2.5 right-2.5 rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-ink min-[1100px]:hidden"
      >
        <PanelRightIcon className="size-4" />
      </button>
      <CenteredState
        icon={<MessageSquareIcon className="size-6" />}
        title="Select a conversation"
        hint="Pick a chat on the left to see the transcript, approvals and the agent's reasoning."
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Bubbles
// ---------------------------------------------------------------------------

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
    const quote = normalizeQuote(p.quote);
    const text =
      p.text ||
      (typeof p.askQuestion === "string" ? p.askQuestion : "") ||
      (quote ? "" : "(quote)");
    if (p.fromOwner === true) {
      return <OwnerBubble text={text} ts={event.ts} />;
    }
    return (
      <div className="flex justify-start">
        <div
          className={cn(
            "max-w-[75%] min-w-0 rounded-xl rounded-bl-sm border border-line bg-panel-2/60 px-3 py-1.5 text-sm text-ink",
            quote && "w-full sm:max-w-md",
          )}
        >
          {text && <p className="whitespace-pre-wrap">{text}</p>}
          {quote && (
            <div className={cn(text && "mt-2")}>
              <QuoteCard quote={quote} files={p.files} />
            </div>
          )}
          <span className="mt-0.5 block text-[10px] text-faint tabular-nums">
            {clockTime(event.ts)}
          </span>
        </div>
      </div>
    );
  }

  // reasoning / quote / approval / followup / error — faint centered
  // one-liners, like WhatsApp date separators.
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
