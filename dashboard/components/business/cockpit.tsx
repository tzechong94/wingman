"use client";

import { api, ApiError, isAuthError } from "@/lib/api";
import { humanizeSeconds, money } from "@/lib/format";
import { sseReconnectNow, useConvEvents } from "@/lib/sse";
import type { Analytics, ConvEvent } from "@/lib/types";
import { useFetch } from "@/lib/use-fetch";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ActivityIcon,
  FileTextIcon,
  LoaderIcon,
  LockIcon,
  MessageSquareIcon,
} from "../icons";
import { AlertCircleIcon } from "../icons";
import { Button, Card, CenteredState, Spinner, Tabs } from "../ui";
import { ActivityFeed } from "./activity";
import { ApprovalsQueue } from "./approvals";
import { ConversationsTab } from "./conversations";
import { QuotesTab } from "./quotes-tab";

type AuthPhase = "checking" | "need_token" | "authed" | "error";
type TabValue = "activity" | "conversations" | "quotes";

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
// Cockpit body
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
  const [tab, setTab] = useState<TabValue>("activity");
  const [activity, setActivity] = useState<ConvEvent[]>([]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const approvalsFetch = useFetch(guard(() => api.approvals()));
  const conversationsFetch = useFetch(guard(() => api.conversations()));
  const quotesFetch = useFetch(guard(() => api.quotes()));

  const { reload: reloadApprovals } = approvalsFetch;
  const { reload: reloadConversations } = conversationsFetch;
  const { reload: reloadQuotes } = quotesFetch;

  // Live updates: approval/quote events refresh the queue, quotes and tiles.
  const onEvent = useCallback(
    (e: ConvEvent) => {
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
      if (e.type === "approval" || e.type === "quote") {
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => {
          refreshTimer.current = null;
          reloadApprovals();
          reloadQuotes();
          api.analytics().then(onAnalytics).catch(() => undefined);
        }, 400);
      }
      if (e.type === "msg_in" || e.type === "msg_out") {
        // Keep the conversations list roughly fresh without hammering the API.
        if (tab === "conversations") reloadConversations();
      }
    },
    [reloadApprovals, reloadQuotes, reloadConversations, onAnalytics, tab],
  );

  const sseState = useConvEvents(onEvent, true);

  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">Owner cockpit</h1>
          <p className="text-sm text-muted">
            Everything your agent did — and the few calls it saved for you.
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 py-1 text-[11px] font-medium text-muted">
          {sseState === "open" ? (
            <span className="size-1.5 rounded-full bg-accent" />
          ) : (
            <LoaderIcon className="size-3 animate-spin" />
          )}
          {sseState === "open" ? "Live" : "Reconnecting…"}
        </span>
      </div>

      <StatTiles analytics={analytics} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(320px,5fr)_7fr]">
        <ApprovalsQueue
          approvals={approvalsFetch.data ?? []}
          loading={approvalsFetch.loading}
          error={approvalsFetch.error}
          onReload={reloadApprovals}
          onAuthLost={onAuthLost}
          onDecided={(approvalId, decision) => {
            approvalsFetch.mutate((prev) =>
              (prev ?? []).map((a) =>
                a.approvalId === approvalId
                  ? { ...a, status: decision === "approve" ? "approved" : "rejected" }
                  : a,
              ),
            );
          }}
        />

        <Card className="self-start overflow-hidden">
          <div className="px-2 pt-1">
            <Tabs<TabValue>
              value={tab}
              onChange={setTab}
              options={[
                {
                  value: "activity",
                  label: "Activity",
                  icon: <ActivityIcon className="size-3.5" />,
                },
                {
                  value: "conversations",
                  label: "Conversations",
                  icon: <MessageSquareIcon className="size-3.5" />,
                },
                {
                  value: "quotes",
                  label: "Quotes",
                  icon: <FileTextIcon className="size-3.5" />,
                },
              ]}
            />
          </div>
          <div className="max-h-[32rem] min-h-64 overflow-y-auto">
            {tab === "activity" && <ActivityFeed items={activity} />}
            {tab === "conversations" && (
              <ConversationsTab
                conversations={conversationsFetch.data ?? []}
                loading={conversationsFetch.loading}
                error={conversationsFetch.error}
                onReload={reloadConversations}
                onAuthLost={onAuthLost}
              />
            )}
            {tab === "quotes" && (
              <QuotesTab
                quotes={quotesFetch.data ?? []}
                loading={quotesFetch.loading}
                error={quotesFetch.error}
                onReload={reloadQuotes}
              />
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat tiles
// ---------------------------------------------------------------------------

function StatTiles({ analytics }: { analytics: Analytics | null }) {
  if (!analytics) {
    return (
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} className="h-24 animate-pulse bg-panel-2/40">
            <span className="sr-only">Loading…</span>
          </Card>
        ))}
      </div>
    );
  }

  const { quotesSent7d, autoSent7d, escalated7d, medianResponseSeconds } =
    analytics;
  const counterfactual =
    escalated7d === 0
      ? autoSent7d > 0
        ? "None needed you — fully hands-off."
        : "Waiting for the first quote."
      : `You only saw the ${escalated7d}.`;

  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <StatTile
        label="Quotes (7d)"
        value={String(quotesSent7d)}
        sub="sent by your agent"
      />
      <StatTile
        label="Auto vs escalated"
        value={
          <span>
            {autoSent7d} auto{" "}
            <span className="font-normal text-muted">·</span> {escalated7d}{" "}
            needed you
          </span>
        }
        sub={counterfactual}
      />
      <StatTile
        label="Median response"
        value={humanizeSeconds(medianResponseSeconds)}
        sub="customer message → reply"
      />
      <StatTile
        label="Quoted (7d)"
        value={money(analytics.centsQuoted7d, analytics.currency)}
        sub="total value quoted"
      />
    </div>
  );
}

function StatTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: ReactNode;
  sub: string;
}) {
  return (
    <Card className="px-4 py-3.5">
      <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">
        {label}
      </p>
      <p className="mt-1.5 text-xl leading-tight font-semibold text-ink tabular-nums">
        {value}
      </p>
      <p className="mt-1 text-xs text-muted">{sub}</p>
    </Card>
  );
}
