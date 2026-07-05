"use client";

import { api, ApiError, isAuthError } from "@/lib/api";
import { sseReconnectNow, useConvEvents } from "@/lib/sse";
import {
  isApprovalPending,
  normalizeQuote,
  type Analytics,
  type ConvEvent,
  type ConversationSummary,
  type MsgOutPayload,
} from "@/lib/types";
import { useFetch } from "@/lib/use-fetch";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ActivityIcon,
  AlertCircleIcon,
  BrainIcon,
  FileTextIcon,
  LoaderIcon,
  LockIcon,
} from "../icons";
import { Button, Card, CenteredState, Modal, Spinner } from "../ui";
import { ActivityFeed } from "./activity";
import { ChatList } from "./chat-list";
import { ChatPane, ChatPaneEmpty } from "./chat-pane";
import { ContextPanel, ContextPanelEmpty } from "./context-panel";
import { MemoryTab } from "./memory-tab";
import { QuotesTab } from "./quotes-tab";

type AuthPhase = "checking" | "need_token" | "authed" | "error";
type Overlay = "activity" | "quotes" | "memory" | null;

const MAX_ACTIVITY_ITEMS = 200;

export function BusinessView() {
  const [authPhase, setAuthPhase] = useState<AuthPhase>("checking");
  const [analytics, setAnalytics] = useState<Analytics | null>(null);

  const checkAuth = useCallback(async () => {
    setAuthPhase("checking");
    try {
      const data = await api.analytics();
      setAnalytics(data);
      setAuthPhase("authed");
    } catch (err) {
      if (isAuthError(err)) setAuthPhase("need_token");
      else setAuthPhase("error");
    }
  }, []);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  const onAuthLost = useCallback(() => setAuthPhase("need_token"), []);

  if (authPhase === "checking") {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner className="size-4" /> Opening the cockpit…
        </div>
      </div>
    );
  }

  if (authPhase === "error") {
    return (
      <div className="flex h-full items-center justify-center">
        <CenteredState
          icon={<AlertCircleIcon className="size-6" />}
          title="Couldn't reach the Wingman host"
          hint="The backend isn't responding — check that it's running, then retry."
          action={<Button onClick={() => void checkAuth()}>Retry</Button>}
        />
      </div>
    );
  }

  if (authPhase === "need_token") {
    return (
      <TokenGate
        onAuthed={() => {
          sseReconnectNow(); // upgrade the shared stream to owner firehose
          void checkAuth();
        }}
      />
    );
  }

  return (
    <Cockpit
      analytics={analytics}
      onAnalytics={setAnalytics}
      onAuthLost={onAuthLost}
    />
  );
}

// ---------------------------------------------------------------------------
// Token gate
// ---------------------------------------------------------------------------

function TokenGate({ onAuthed }: { onAuthed: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.auth(token.trim());
      onAuthed();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "That token didn't match — check with the demo operator."
          : "Couldn't verify the token — try again.",
      );
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <form onSubmit={submit} className="flex flex-col gap-4 p-6">
          <div className="flex size-10 items-center justify-center rounded-full bg-accent-soft text-accent">
            <LockIcon className="size-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-ink">Owner access</h2>
            <p className="mt-1 text-sm text-muted">
              The Business view shows every conversation and approval. Enter the
              demo token to continue.
            </p>
          </div>
          <div>
            <input
              type="password"
              autoFocus
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Demo token"
              aria-label="Demo token"
              className="h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-faint"
            />
            {error && <p className="mt-1.5 text-xs text-critical">{error}</p>}
          </div>
          <Button type="submit" variant="primary" loading={busy} disabled={!token.trim()}>
            Unlock cockpit
          </Button>
        </form>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session transcript: fetched history merged with live SSE events
// ---------------------------------------------------------------------------

function useSessionTranscript(
  sessionId: string | null,
  onAuthLost: () => void,
) {
  const [base, setBase] = useState<ConvEvent[]>([]);
  const [live, setLive] = useState<ConvEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const genRef = useRef(0);
  const onAuthLostRef = useRef(onAuthLost);
  onAuthLostRef.current = onAuthLost;

  const load = useCallback(
    (id: string, silent = false) => {
      const gen = ++genRef.current;
      if (!silent) setLoading(true);
      setError(null);
      api
        .transcript({ sessionId: id })
        .then((events) => {
          if (genRef.current !== gen) return;
          setBase(events);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (genRef.current !== gen) return;
          if (isAuthError(err)) onAuthLostRef.current();
          setError(err);
          setLoading(false);
        });
    },
    [],
  );

  useEffect(() => {
    genRef.current++; // invalidate any in-flight load
    setBase([]);
    setLive([]);
    setError(null);
    setLoading(false);
    if (sessionId) load(sessionId);
  }, [sessionId, load]);

  /** Feed a live SSE event for this session into the transcript. */
  const append = useCallback((e: ConvEvent) => {
    setLive((prev) =>
      prev.some((p) => p.id === e.id) ? prev : [...prev, e],
    );
  }, []);

  const reload = useCallback(
    (silent = false) => {
      if (sessionId) load(sessionId, silent);
    },
    [sessionId, load],
  );

  const events = useMemo(() => {
    const map = new Map<number, ConvEvent>();
    for (const e of base) map.set(e.id, e);
    for (const e of live) if (!map.has(e.id)) map.set(e.id, e);
    return [...map.values()].sort((a, b) => a.id - b.id);
  }, [base, live]);

  return { events, loading, error, reload, append };
}

// ---------------------------------------------------------------------------
// Cockpit body — WhatsApp-Web-style 3-pane inbox
// ---------------------------------------------------------------------------

function Cockpit({
  analytics,
  onAnalytics,
  onAuthLost,
}: {
  analytics: Analytics | null;
  onAnalytics: (a: Analytics) => void;
  onAuthLost: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [activity, setActivity] = useState<ConvEvent[]>([]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const guard = useCallback(
    <T,>(fn: () => Promise<T>): (() => Promise<T>) =>
      async () => {
        try {
          return await fn();
        } catch (err) {
          if (isAuthError(err)) onAuthLost();
          throw err;
        }
      },
    [onAuthLost],
  );

  const conversationsFetch = useFetch(guard(() => api.conversations()));
  const approvalsFetch = useFetch(guard(() => api.approvals()));
  const quotesFetch = useFetch(guard(() => api.quotes()));

  const { reload: reloadConversations, mutate: mutateConversations } =
    conversationsFetch;
  const { reload: reloadApprovals } = approvalsFetch;
  const { reload: reloadQuotes } = quotesFetch;

  const transcript = useSessionTranscript(selectedId, onAuthLost);
  const { append: appendTranscript } = transcript;

  const scheduleListReload = useCallback(() => {
    if (listTimer.current) return;
    listTimer.current = setTimeout(() => {
      listTimer.current = null;
      reloadConversations();
    }, 600);
  }, [reloadConversations]);

  // Live updates from the owner firehose.
  const onEvent = useCallback(
    (e: ConvEvent) => {
      // Global activity accumulator (for the Activity overlay).
      if (
        e.type === "reasoning" ||
        e.type === "quote" ||
        e.type === "approval" ||
        e.type === "followup"
      ) {
        setActivity((prev) => {
          if (prev.some((p) => p.id === e.id)) return prev;
          return [e, ...prev].slice(0, MAX_ACTIVITY_ITEMS);
        });
      }

      // Selected chat: feed the transcript directly (no refetch).
      if (e.sessionId && e.sessionId === selectedId) appendTranscript(e);

      // Left list: bump preview/time in place; refetch only for new sessions.
      if (e.type === "msg_in" || e.type === "msg_out") {
        mutateConversations((prev) => {
          if (!prev) return prev;
          const idx = prev.findIndex((c) => c.sessionId === e.sessionId);
          if (idx === -1) {
            scheduleListReload(); // brand-new conversation
            return prev;
          }
          const cur = prev[idx];
          if (!cur) return prev;
          const text =
            typeof e.payload.text === "string" ? e.payload.text : "";
          const next = [...prev];
          next[idx] = {
            ...cur,
            lastTs: Math.max(cur.lastTs, e.ts),
            lastType: e.type,
            preview: text ? text.slice(0, 120) : cur.preview,
          };
          return next;
        });
      }

      // Approval / quote events refresh the queues, tiles and badges.
      if (e.type === "approval" || e.type === "quote") {
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => {
          refreshTimer.current = null;
          reloadApprovals();
          reloadQuotes();
          reloadConversations();
          api.analytics().then(onAnalytics).catch(() => undefined);
        }, 400);
      }
    },
    [
      selectedId,
      appendTranscript,
      mutateConversations,
      scheduleListReload,
      reloadApprovals,
      reloadQuotes,
      reloadConversations,
      onAnalytics,
    ],
  );

  const sseState = useConvEvents(onEvent, true);

  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      if (listTimer.current) clearTimeout(listTimer.current);
    },
    [],
  );

  const conversations = conversationsFetch.data ?? [];

  // Live per-chat pending counts from the approvals fetch (fresher than the
  // conversations snapshot, and tracks optimistic approve/reject instantly).
  const pendingBySession = useMemo(() => {
    if (!approvalsFetch.data) return null;
    const m = new Map<string, number>();
    for (const a of approvalsFetch.data) {
      if (!isApprovalPending(a) || !a.sessionId) continue;
      m.set(a.sessionId, (m.get(a.sessionId) ?? 0) + 1);
    }
    return m;
  }, [approvalsFetch.data]);

  const selectedConv = useMemo<ConversationSummary | null>(() => {
    if (!selectedId) return null;
    return (
      conversations.find((c) => c.sessionId === selectedId) ?? {
        sessionId: selectedId,
        lastTs: 0,
        lastType: "",
        preview: "",
        pendingApprovals: 0,
        customerName: null,
      }
    );
  }, [conversations, selectedId]);

  const sessionApprovals = useMemo(
    () =>
      (approvalsFetch.data ?? []).filter((a) => a.sessionId === selectedId),
    [approvalsFetch.data, selectedId],
  );

  const sessionQuotes = useMemo(
    () => (quotesFetch.data ?? []).filter((q) => q.sessionId === selectedId),
    [quotesFetch.data, selectedId],
  );

  // quoteId → PDF url, mined from this chat's msg_out events.
  const quotePdfUrls = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of transcript.events) {
      if (e.type !== "msg_out") continue;
      const p = e.payload as MsgOutPayload;
      const q = normalizeQuote(p.quote);
      const url = p.files?.find((f) => f.url)?.url;
      if (q?.id && url) m.set(q.id, url);
    }
    return m;
  }, [transcript.events]);

  const onDecided = useCallback(
    (approvalId: string, decision: "approve" | "reject") => {
      approvalsFetch.mutate((prev) =>
        (prev ?? []).map((a) =>
          a.approvalId === approvalId
            ? { ...a, status: decision === "approve" ? "approved" : "rejected" }
            : a,
        ),
      );
    },
    [approvalsFetch],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Slim top bar */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-line bg-panel px-3.5">
        <p className="truncate text-xs font-semibold text-ink">
          CoolBreeze — Owner cockpit
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <span className="mr-1.5 inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-2 py-0.5 text-[10px] font-medium text-muted">
            {sseState === "open" ? (
              <span className="size-1.5 rounded-full bg-accent" />
            ) : (
              <LoaderIcon className="size-3 animate-spin" />
            )}
            {sseState === "open" ? "Live" : "Reconnecting…"}
          </span>
          <TopBarButton
            label="Activity — everything the agent did"
            onClick={() => setOverlay("activity")}
          >
            <ActivityIcon className="size-4" />
          </TopBarButton>
          <TopBarButton
            label="All quotes"
            onClick={() => setOverlay("quotes")}
          >
            <FileTextIcon className="size-4" />
          </TopBarButton>
          <TopBarButton
            label="Agent memory"
            onClick={() => setOverlay("memory")}
          >
            <BrainIcon className="size-4" />
          </TopBarButton>
        </div>
      </div>

      {/* Three panes */}
      <div className="relative flex min-h-0 flex-1">
        <ChatList
          conversations={conversations}
          loading={conversationsFetch.loading}
          error={conversationsFetch.error}
          onReload={reloadConversations}
          analytics={analytics}
          selectedId={selectedId}
          onSelect={setSelectedId}
          pendingBySession={pendingBySession}
        />

        {selectedConv ? (
          <>
            <ChatPane
              conversation={selectedConv}
              events={transcript.events}
              loading={transcript.loading}
              error={transcript.error}
              onReload={() => transcript.reload(true)}
              onAuthLost={onAuthLost}
              contextOpen={contextOpen}
              onToggleContext={() => setContextOpen((v) => !v)}
            />
            <ContextPanel
              sessionId={selectedConv.sessionId}
              customerName={selectedConv.customerName}
              approvals={sessionApprovals}
              approvalsLoading={approvalsFetch.loading}
              onDecided={onDecided}
              onReloadApprovals={reloadApprovals}
              onAuthLost={onAuthLost}
              quotes={sessionQuotes}
              quotesLoading={quotesFetch.loading}
              quotePdfUrls={quotePdfUrls}
              events={transcript.events}
              open={contextOpen}
              onClose={() => setContextOpen(false)}
            />
          </>
        ) : (
          <>
            <ChatPaneEmpty
              contextOpen={contextOpen}
              onToggleContext={() => setContextOpen((v) => !v)}
            />
            <ContextPanelEmpty
              open={contextOpen}
              onClose={() => setContextOpen(false)}
            />
          </>
        )}
      </div>

      {/* Global overlays — the old tabs, unchanged, in full-screen drawers */}
      {overlay === "activity" && (
        <Modal full title="Activity — live firehose" onClose={() => setOverlay(null)}>
          <ActivityFeed items={activity} />
        </Modal>
      )}
      {overlay === "quotes" && (
        <Modal full title="All quotes" onClose={() => setOverlay(null)}>
          <QuotesTab
            quotes={quotesFetch.data ?? []}
            loading={quotesFetch.loading}
            error={quotesFetch.error}
            onReload={reloadQuotes}
          />
        </Modal>
      )}
      {overlay === "memory" && (
        <Modal full title="Agent memory" onClose={() => setOverlay(null)}>
          <MemoryTab />
        </Modal>
      )}
    </div>
  );
}

function TopBarButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="rounded-md p-1.5 text-muted transition-colors hover:bg-panel-2 hover:text-ink"
    >
      {children}
    </button>
  );
}
