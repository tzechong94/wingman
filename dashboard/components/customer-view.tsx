"use client";

import { api, ApiError, type Attachment } from "@/lib/api";
import { clockTime } from "@/lib/format";
import { useConvEvents, type SseState } from "@/lib/sse";
import { useToast } from "@/lib/toast";
import {
  normalizeQuote,
  referencedQuoteIds,
  type ConvEvent,
  type MsgInPayload,
  type MsgOutPayload,
} from "@/lib/types";
import { useFetch } from "@/lib/use-fetch";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { CustomerRail, type CustomerSelection } from "./customer-rail";
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  ClockIcon,
  LoaderIcon,
  PaperclipIcon,
  SendIcon,
  SnowflakeIcon,
  UserIcon,
  XIcon,
} from "./icons";
import { QuoteCard } from "./quote-card";
import { Button, CenteredState, cn, Spinner, StatusChip } from "./ui";

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const TYPING_TIMEOUT_MS = 90_000;

interface LocalEcho {
  key: number;
  text: string;
  attachmentCount: number;
  ts: number;
}

interface PendingAttachment {
  name: string;
  mimeType: string;
  data: string; // base64, no data: prefix
  previewUrl: string;
}

type Phase = "loading" | "ready" | "error";

function mergeEvents(prev: ConvEvent[], incoming: ConvEvent[]): ConvEvent[] {
  if (incoming.length === 0) return prev;
  const byId = new Map<number, ConvEvent>();
  for (const e of prev) byId.set(e.id, e);
  for (const e of incoming) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** Quote ids that have been resolved by a later approval/quote event. */
function computeResolvedQuoteIds(events: ConvEvent[]): Set<string> {
  const resolved = new Set<string>();
  for (const e of events) {
    if (e.type === "quote" || e.type === "approval" || e.type === "msg_out") {
      const p = e.payload as MsgOutPayload;
      // The pending bubble itself must not resolve its own chip.
      if (e.type === "msg_out" && p.quotePending && !p.quote) continue;
      for (const id of referencedQuoteIds(e)) resolved.add(id);
    }
  }
  return resolved;
}

function filterVisible(events: ConvEvent[]): ConvEvent[] {
  return events.filter(
    (e) => e.type === "msg_in" || e.type === "msg_out" || e.type === "error",
  );
}

// ---------------------------------------------------------------------------
// Orchestrator: left rail (chat list) + chat surface. Below 800px it becomes
// list OR chat, WhatsApp-mobile style, with a back arrow in the chat header.
// ---------------------------------------------------------------------------

export function CustomerView() {
  const { toast } = useToast();

  const [selection, setSelection] = useState<CustomerSelection>({
    kind: "live",
  });
  const [mobilePane, setMobilePane] = useState<"list" | "chat">("chat");
  // Remount key for the live chat: bumping it after POST /session?new=1 makes
  // the live pane re-bootstrap into the freshly minted session.
  const [liveEpoch, setLiveEpoch] = useState(0);
  const [creatingChat, setCreatingChat] = useState(false);

  const myChats = useFetch(useCallback(() => api.myChats(), []));
  const demoChats = useFetch(useCallback(() => api.demoChats(), []));
  const reloadMyChats = myChats.reload;

  const select = useCallback((next: CustomerSelection) => {
    setSelection(next);
    setMobilePane("chat");
  }, []);

  const startNewChat = useCallback(async () => {
    if (creatingChat) return;
    setCreatingChat(true);
    try {
      await api.createSession({ forceNew: true });
      setLiveEpoch((n) => n + 1);
      setSelection({ kind: "live" });
      setMobilePane("chat");
      reloadMyChats();
      toast("Fresh conversation started.", "success");
    } catch {
      toast("Couldn't start a new chat — try again.", "error");
    } finally {
      setCreatingChat(false);
    }
  }, [creatingChat, reloadMyChats, toast]);

  // Continue an ended own-chat: same session reactivates (transcript +
  // memory intact); the live pane remounts and boots into it.
  const continueChat = useCallback(
    async (sessionId: string) => {
      if (creatingChat) return;
      setCreatingChat(true);
      try {
        await api.activateChat(sessionId);
        setLiveEpoch((n) => n + 1);
        setSelection({ kind: "live" });
        setMobilePane("chat");
        reloadMyChats();
        toast("Chat resumed — pick up where you left off.", "success");
      } catch {
        toast("Couldn't resume this chat — try again.", "error");
      } finally {
        setCreatingChat(false);
      }
    },
    [creatingChat, reloadMyChats, toast],
  );

  // The live chat's bootstrap may mint the visitor cookie + first session, so
  // refresh the own-chats list once it settles.
  const onLiveSessionReady = useCallback(() => {
    reloadMyChats();
  }, [reloadMyChats]);

  const openList = useCallback(() => setMobilePane("list"), []);
  const isLive = selection.kind === "live";

  return (
    <div className="flex h-full">
      <div
        className={cn(
          "h-full w-full min-w-0 min-[800px]:w-64 min-[800px]:shrink-0",
          mobilePane === "chat" && "hidden min-[800px]:block",
        )}
      >
        <CustomerRail
          myChats={myChats.data}
          myChatsLoading={myChats.loading}
          demoChats={demoChats.data}
          demoChatsLoading={demoChats.loading}
          demoChatsError={demoChats.error}
          onReloadDemoChats={demoChats.reload}
          selection={selection}
          onSelect={select}
          onNewChat={() => void startNewChat()}
          creatingChat={creatingChat}
        />
      </div>

      <div
        className={cn(
          "h-full min-w-0 flex-1",
          mobilePane === "list" && "hidden min-[800px]:block",
        )}
      >
        {/* The live chat stays mounted while a replay is open so SSE keeps
            flowing and composer state survives browsing demo chats. */}
        <div className={cn("h-full", !isLive && "hidden")}>
          <LiveChat
            key={liveEpoch}
            visible={isLive && mobilePane === "chat"}
            onOpenList={openList}
            onSessionReady={onLiveSessionReady}
          />
        </div>
        {selection.kind === "replay" && (
          <ReplayChat
            // Keyed by session: useFetch loads once per mount, so switching
            // chats must remount the pane (else the first transcript sticks).
            key={selection.sessionId}
            sessionId={selection.sessionId}
            name={selection.name}
            variant={selection.variant}
            onOpenList={openList}
            onStartNew={() => void startNewChat()}
            onContinue={(id) => void continueChat(id)}
            startingNew={creatingChat}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live chat: this visitor's active conversation (composer, SSE, photos).
// ---------------------------------------------------------------------------

function LiveChat({
  visible,
  onOpenList,
  onSessionReady,
}: {
  visible: boolean;
  onOpenList: () => void;
  onSessionReady: (sessionId: string) => void;
}) {
  const { toast } = useToast();

  const [phase, setPhase] = useState<Phase>("loading");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<ConvEvent[]>([]);
  const [echoes, setEchoes] = useState<LocalEcho[]>([]);
  const [awaitingSince, setAwaitingSince] = useState<number | null>(null);
  const [slowNote, setSlowNote] = useState(false);
  const [input, setInput] = useState("");
  const [attachment, setAttachment] = useState<PendingAttachment | null>(null);
  const [sending, setSending] = useState(false);

  const sessionRef = useRef<string | null>(null);
  sessionRef.current = sessionId;
  const lastEventIdRef = useRef(0);
  const echoKeyRef = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const prevSseState = useRef<SseState>("connecting");
  const onSessionReadyRef = useRef(onSessionReady);
  onSessionReadyRef.current = onSessionReady;

  const addEvents = useCallback((incoming: ConvEvent[]) => {
    const own = incoming.filter(
      (e) => !sessionRef.current || e.sessionId === sessionRef.current,
    );
    if (own.length === 0) return;
    for (const e of own) {
      lastEventIdRef.current = Math.max(lastEventIdRef.current, e.id);
    }
    setEvents((prev) => mergeEvents(prev, own));
    // Reconcile optimistic echoes against real msg_in rows.
    const inbound = own.filter((e) => e.type === "msg_in");
    if (inbound.length > 0) {
      setEchoes((prev) => {
        let next = prev;
        for (const e of inbound) {
          const text = String((e.payload as MsgInPayload).text ?? "");
          const idx = next.findIndex((echo) => echo.text === text);
          if (idx >= 0) next = [...next.slice(0, idx), ...next.slice(idx + 1)];
        }
        return next;
      });
    }
    if (own.some((e) => e.type === "msg_out")) {
      setAwaitingSince(null);
      setSlowNote(false);
    }
  }, []);

  // --- bootstrap: session → transcript, SSE opens once session cookie exists
  const bootstrap = useCallback(async () => {
    setPhase("loading");
    try {
      const session = await api.createSession();
      sessionRef.current = session.sessionId;
      setSessionId(session.sessionId);
      const transcript = await api.transcript();
      addEvents(transcript);
      setPhase("ready");
      onSessionReadyRef.current(session.sessionId);
    } catch {
      setPhase("error");
    }
  }, [addEvents]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const sseState = useConvEvents(
    useCallback((e: ConvEvent) => addEvents([e]), [addEvents]),
    phase === "ready",
  );

  // Backfill anything missed while the stream was down.
  useEffect(() => {
    if (
      phase === "ready" &&
      sseState === "open" &&
      prevSseState.current === "reconnecting"
    ) {
      api
        .transcript({ after: lastEventIdRef.current })
        .then(addEvents)
        .catch(() => undefined);
    }
    prevSseState.current = sseState;
  }, [sseState, phase, addEvents]);

  // Typing timeout: gentle note after 90s with no reply.
  useEffect(() => {
    if (awaitingSince === null) return;
    const t = setTimeout(() => {
      setAwaitingSince(null);
      setSlowNote(true);
    }, TYPING_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [awaitingSince]);

  // Auto-scroll to the newest message. `visible` is a dep so that returning
  // from a replay (display:none while hidden) re-pins the bottom.
  useEffect(() => {
    if (!visible) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events, echoes, awaitingSince, slowNote, visible]);

  const resolvedQuoteIds = useMemo(
    () => computeResolvedQuoteIds(events),
    [events],
  );

  const visibleEvents = useMemo(() => filterVisible(events), [events]);

  const hasMessages = visibleEvents.length > 0 || echoes.length > 0;

  // --- composer -------------------------------------------------------------

  const onPickFile = (ev: ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/") || file.type === "image/svg+xml") {
      toast("Photos only, please (JPEG, PNG, WebP…).", "error");
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast("That photo is over 5 MB — try a smaller one.", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const base64 = dataUrl.split(",")[1] ?? "";
      setAttachment({
        name: file.name,
        mimeType: file.type,
        data: base64,
        previewUrl: dataUrl,
      });
    };
    reader.onerror = () => toast("Couldn't read that photo — try again.", "error");
    reader.readAsDataURL(file);
  };

  const send = async () => {
    const text = input.trim();
    if ((!text && !attachment) || sending || phase !== "ready") return;

    const attachments: Attachment[] | undefined = attachment
      ? [{ mimeType: attachment.mimeType, data: attachment.data }]
      : undefined;
    const echo: LocalEcho = {
      key: echoKeyRef.current++,
      text,
      attachmentCount: attachment ? 1 : 0,
      ts: Date.now(),
    };

    setSending(true);
    setEchoes((prev) => [...prev, echo]);
    setInput("");
    setAttachment(null);
    setSlowNote(false);

    try {
      await api.sendMessage(text, attachments);
      setAwaitingSince(Date.now());
    } catch (err) {
      setEchoes((prev) => prev.filter((e) => e.key !== echo.key));
      setInput(text);
      if (err instanceof ApiError && err.status === 429) {
        toast(
          "You've hit the demo message limit for now — give it a minute and try again. Thanks for your patience!",
          "info",
        );
      } else if (err instanceof ApiError && err.status === 413) {
        toast("That photo is too large to send — 5 MB max.", "error");
      } else {
        toast(
          err instanceof ApiError && err.message
            ? err.message
            : "Couldn't send that — please try again.",
          "error",
        );
      }
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const onComposerKey = (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      void send();
    }
  };

  const suggest = (text: string) => {
    setInput(text);
    inputRef.current?.focus();
  };

  // --- render ----------------------------------------------------------------

  if (phase === "loading") {
    return (
      <ChatFrame sseState={null} onOpenList={onOpenList}>
        <div className="flex flex-1 items-center justify-center">
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner className="size-4" /> Connecting you to CoolBreeze…
          </div>
        </div>
      </ChatFrame>
    );
  }

  if (phase === "error") {
    return (
      <ChatFrame sseState={null} onOpenList={onOpenList}>
        <div className="flex flex-1 items-center justify-center">
          <CenteredState
            icon={<AlertCircleIcon className="size-6" />}
            title="Couldn't reach CoolBreeze"
            hint="The demo backend isn't responding. Check that the Wingman host is running, then retry."
            action={
              <Button variant="secondary" onClick={() => void bootstrap()}>
                Retry
              </Button>
            }
          />
        </div>
      </ChatFrame>
    );
  }

  return (
    <ChatFrame sseState={sseState} onOpenList={onOpenList}>
      {/* messages */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {!hasMessages && (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent">
              <SnowflakeIcon className="size-6" />
            </div>
            <div>
              <p className="text-sm font-semibold text-ink">
                Welcome to CoolBreeze Aircon Services
              </p>
              <p className="mt-1 max-w-xs text-sm text-muted">
                Describe your aircon problem and get a quote in minutes — photos
                welcome.
              </p>
            </div>
            <div className="flex flex-col items-center gap-2">
              <button
                type="button"
                onClick={() => suggest("My aircon is leaking, how much to fix?")}
                className="rounded-full border border-line bg-panel px-3.5 py-1.5 text-xs text-ink hover:bg-panel-2"
              >
                Try: “My aircon is leaking, how much to fix?”
              </button>
              <button
                type="button"
                onClick={() =>
                  suggest("Hi, it's Mr. Tan here — the usual servicing please.")
                }
                className="rounded-full border border-line bg-panel px-3.5 py-1.5 text-xs text-ink hover:bg-panel-2"
              >
                Say you're Mr. Tan to see memory recall
              </button>
            </div>
          </div>
        )}

        {visibleEvents.map((e) => (
          <EventBubble key={e.id} event={e} resolvedQuoteIds={resolvedQuoteIds} />
        ))}

        {echoes.map((echo) => (
          <div key={`echo-${echo.key}`} className="flex justify-end">
            <div className="max-w-[80%]">
              <div className="rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-sm whitespace-pre-wrap text-on-accent opacity-80">
                {echo.text || "(photo)"}
                {echo.attachmentCount > 0 && (
                  <span className="mt-1 flex items-center gap-1 text-xs opacity-90">
                    <PaperclipIcon className="size-3" /> 1 photo
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-right text-[10px] text-faint">Sending…</p>
            </div>
          </div>
        ))}

        {awaitingSince !== null && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl rounded-bl-md border border-line bg-panel px-3.5 py-2.5">
              <span className="flex items-center gap-1">
                <span className="typing-dot size-1.5 rounded-full bg-faint" />
                <span className="typing-dot size-1.5 rounded-full bg-faint" />
                <span className="typing-dot size-1.5 rounded-full bg-faint" />
              </span>
              <span className="text-xs text-muted">CoolBreeze is typing…</span>
            </div>
          </div>
        )}

        {slowNote && (
          <p className="px-4 text-center text-xs text-muted">
            CoolBreeze is taking a little longer than usual — your message is in
            the queue and a reply will land here.
          </p>
        )}
      </div>

      {/* composer */}
      <div className="border-t border-line bg-panel px-3 pt-3 pb-2">
        {attachment && (
          <div className="mb-2 inline-flex items-center gap-2 rounded-lg border border-line bg-panel-2 py-1 pr-1 pl-2">
            <img
              src={attachment.previewUrl}
              alt=""
              className="size-8 rounded object-cover"
            />
            <span className="max-w-40 truncate text-xs text-muted">
              {attachment.name}
            </span>
            <button
              type="button"
              onClick={() => setAttachment(null)}
              aria-label="Remove photo"
              className="rounded p-1 text-muted hover:bg-panel hover:text-ink"
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onPickFile}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach a photo"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-panel-2 hover:text-ink"
          >
            <PaperclipIcon className="size-4.5" />
          </button>
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onComposerKey}
            placeholder="Message CoolBreeze…"
            className="max-h-32 min-h-9 flex-1 resize-none rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint"
          />
          <Button
            variant="primary"
            onClick={() => void send()}
            disabled={(!input.trim() && !attachment) || sending}
            aria-label="Send message"
            className="size-9 shrink-0 px-0"
          >
            {sending ? (
              <LoaderIcon className="size-4 animate-spin" />
            ) : (
              <SendIcon className="size-4" />
            )}
          </Button>
        </div>
        <p className="mt-1.5 text-[10px] text-faint">
          Enter to send · Shift+Enter for a new line
        </p>
      </div>
    </ChatFrame>
  );
}

// ---------------------------------------------------------------------------
// Read-only replay: a demo customer's chat, or one of your ended chats.
// msg_in renders as the customer side — as if the viewer were that customer.
// ---------------------------------------------------------------------------

function ReplayChat({
  sessionId,
  name,
  variant,
  onOpenList,
  onStartNew,
  onContinue,
  startingNew,
}: {
  sessionId: string;
  name: string;
  variant: "demo" | "closed";
  onOpenList: () => void;
  onStartNew: () => void;
  onContinue: (sessionId: string) => void;
  startingNew: boolean;
}) {
  const { data, loading, error, reload } = useFetch(
    useCallback(() => api.transcript({ sessionId }), [sessionId]),
  );
  const events = useMemo(() => data ?? [], [data]);

  const resolvedQuoteIds = useMemo(
    () => computeResolvedQuoteIds(events),
    [events],
  );
  const visibleEvents = useMemo(() => filterVisible(events), [events]);

  const badge = (
    <StatusChip
      tone="neutral"
      label={variant === "demo" ? "Demo replay" : "Ended"}
    />
  );

  return (
    <ChatFrame sseState={null} onOpenList={onOpenList} badge={badge}>
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {loading && (
          <div className="flex h-full items-center justify-center">
            <div className="flex items-center gap-2 text-sm text-muted">
              <Spinner className="size-4" /> Loading conversation…
            </div>
          </div>
        )}

        {Boolean(error) && !loading && (
          <div className="flex h-full items-center justify-center">
            <CenteredState
              icon={<AlertCircleIcon className="size-6" />}
              title="Couldn't load this conversation"
              action={
                <Button variant="secondary" onClick={reload}>
                  Retry
                </Button>
              }
            />
          </div>
        )}

        {!loading && !error && visibleEvents.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted">Nothing was said in this chat.</p>
          </div>
        )}

        {!loading &&
          visibleEvents.map((e) => (
            <EventBubble
              key={e.id}
              event={e}
              resolvedQuoteIds={resolvedQuoteIds}
            />
          ))}
      </div>

      {/* read-only footer instead of a composer */}
      <div className="flex items-center justify-between gap-3 border-t border-line bg-panel px-4 py-3">
        <p className="min-w-0 text-xs text-muted">
          {variant === "demo" ? (
            <>
              Replaying <span className="font-medium text-ink">{name}</span>
              &rsquo;s conversation — demo history
            </>
          ) : (
            "This chat is paused — continue it or start fresh"
          )}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {variant !== "demo" && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => onContinue(sessionId)}
              loading={startingNew}
            >
              Continue this chat
            </Button>
          )}
          <Button
            variant={variant === "demo" ? "primary" : "secondary"}
            size="sm"
            onClick={onStartNew}
            loading={startingNew}
          >
            Start your own chat
          </Button>
        </div>
      </div>
    </ChatFrame>
  );
}

// ---------------------------------------------------------------------------

function ChatFrame({
  sseState,
  onOpenList,
  badge,
  children,
}: {
  sseState: SseState | null;
  /** Shown below 800px: back to the chat list (WhatsApp-mobile pattern). */
  onOpenList?: () => void;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col px-4 py-4 sm:py-6">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-[0_2px_12px_rgb(22_48_43/0.06)]">
        {/* brand header */}
        <div className="flex items-center gap-3 border-b border-line bg-panel px-4 py-3">
          {onOpenList && (
            <button
              type="button"
              onClick={onOpenList}
              aria-label="Back to chat list"
              className="-ml-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-panel-2 hover:text-ink min-[800px]:hidden"
            >
              <ArrowLeftIcon className="size-4.5" />
            </button>
          )}
          <div className="flex size-9 items-center justify-center rounded-full bg-accent text-on-accent">
            <SnowflakeIcon className="size-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-ink">
              CoolBreeze Aircon Services
            </p>
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <span className="size-1.5 rounded-full bg-accent" />
              Typically replies in minutes
            </p>
          </div>
          {badge}
          {sseState === "reconnecting" && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[11px] text-muted">
              <LoaderIcon className="size-3 animate-spin" />
              Reconnecting…
            </span>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

function EventBubble({
  event,
  resolvedQuoteIds,
}: {
  event: ConvEvent;
  resolvedQuoteIds: Set<string>;
}) {
  if (event.type === "error") {
    return (
      <p className="px-4 text-center text-xs text-muted">
        Something hiccuped on our side — please send that again.
      </p>
    );
  }

  if (event.type === "msg_in") {
    const p = event.payload as MsgInPayload;
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%]">
          <div className="rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-sm whitespace-pre-wrap text-on-accent">
            {p.text || "(photo)"}
            {(p.attachmentCount ?? 0) > 0 && (
              <span className="mt-1 flex items-center gap-1 text-xs opacity-90">
                <PaperclipIcon className="size-3" />
                {p.attachmentCount === 1 ? "1 photo" : `${p.attachmentCount} photos`}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-right text-[10px] text-faint">
            {clockTime(event.ts)}
          </p>
        </div>
      </div>
    );
  }

  // msg_out
  const p = event.payload as MsgOutPayload;
  const fromOwner = p.fromOwner === true;
  const quote = normalizeQuote(p.quote);
  const pendingQuoteId = p.quotePending?.quoteId;
  const stillPending =
    pendingQuoteId !== undefined && !resolvedQuoteIds.has(pendingQuoteId);
  const text =
    p.text || (typeof p.askQuestion === "string" ? p.askQuestion : "");

  return (
    <div className="flex items-end gap-2">
      <div className="mb-4 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
        {fromOwner ? (
          <UserIcon className="size-3.5" />
        ) : (
          <SnowflakeIcon className="size-3.5" />
        )}
      </div>
      <div className="max-w-[80%] min-w-0">
        {fromOwner && (
          <p className="mb-0.5 flex items-center gap-1 text-[10px] font-medium text-accent-strong">
            Owner · CoolBreeze
          </p>
        )}
        <div
          className={
            fromOwner
              ? "space-y-2 rounded-2xl rounded-bl-md border border-accent/30 bg-panel px-3.5 py-2.5"
              : "space-y-2 rounded-2xl rounded-bl-md border border-line bg-panel px-3.5 py-2.5"
          }
        >
          {text && (
            <p className="text-sm whitespace-pre-wrap text-ink">{text}</p>
          )}
          {quote && <QuoteCard quote={quote} files={p.files} />}
          {!quote && p.files && p.files.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {p.files.map((f) => (
                <a
                  key={f.url}
                  href={f.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-accent-strong hover:bg-panel-2"
                >
                  {f.name || "Download"}
                </a>
              ))}
            </div>
          )}
          {p.quotePending && stillPending && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning-soft px-2.5 py-1 text-xs font-medium text-warning">
              <ClockIcon className="size-3.5" />
              Waiting for the boss to approve
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[10px] text-faint">{clockTime(event.ts)}</p>
      </div>
    </div>
  );
}
