"use client";

import { api, isAuthError } from "@/lib/api";
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
import { useState } from "react";
import { MessageSquareIcon, ZapIcon } from "../icons";
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
  const { data, loading, error, reload } = useFetch(() =>
    api.transcript({ sessionId: conversation.sessionId }),
  );

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
        {!loading && data && data.length === 0 && (
          <CenteredState title="Empty conversation" />
        )}
        {data?.map((e) => <TranscriptRow key={e.id} event={e} />)}
      </div>
    </Modal>
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
