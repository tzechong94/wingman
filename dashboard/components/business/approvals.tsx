"use client";

import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useToast } from "@/lib/toast";
import {
  isApprovalPending,
  normalizeQuote,
  type ApprovalItem,
} from "@/lib/types";
import { useMemo, useState } from "react";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, XIcon } from "../icons";
import { QuoteCard } from "../quote-card";
import { Button, Card, StatusChip } from "../ui";

/**
 * "Needs you" section for one chat: pending approvals as full cards with
 * Approve/Reject (optimistic), resolved ones collapsed into a history list.
 */
export function SessionApprovals({
  approvals,
  onDecided,
  onReload,
  onAuthLost,
}: {
  /** Already filtered to the selected session. */
  approvals: ApprovalItem[];
  onDecided: (approvalId: string, decision: "approve" | "reject") => void;
  onReload: () => void;
  onAuthLost: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const pending = useMemo(
    () =>
      approvals
        .filter(isApprovalPending)
        .sort((a, b) => a.createdAt - b.createdAt),
    [approvals],
  );
  const resolved = useMemo(
    () =>
      approvals
        .filter((a) => !isApprovalPending(a))
        .sort((a, b) => b.createdAt - a.createdAt),
    [approvals],
  );

  const decide = async (a: ApprovalItem, decision: "approve" | "reject") => {
    setBusy(a.approvalId);
    onDecided(a.approvalId, decision); // optimistic
    try {
      await api.decide(a.approvalId, decision);
      toast(
        decision === "approve" ? "Approved — sending now." : "Rejected.",
        decision === "approve" ? "success" : "info",
      );
    } catch (err) {
      if (err instanceof Error && "status" in err) {
        const status = (err as { status: number }).status;
        if (status === 401 || status === 403) {
          onAuthLost();
          return;
        }
      }
      toast("That decision didn't go through — reloading the queue.", "error");
      onReload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2.5">
      {pending.length === 0 && (
        <p className="text-xs text-faint">Nothing needs you in this chat.</p>
      )}

      {pending.map((a) => (
        <ApprovalCard
          key={a.approvalId}
          approval={a}
          busy={busy === a.approvalId}
          onDecide={(d) => void decide(a, d)}
        />
      ))}

      {resolved.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            className="inline-flex items-center gap-1 rounded px-1 py-1 text-xs font-medium text-muted hover:text-ink"
          >
            {showHistory ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronRightIcon className="size-3.5" />
            )}
            Resolved ({resolved.length})
          </button>
          {showHistory && (
            <ul className="mt-2 space-y-1.5">
              {resolved.map((a) => (
                <li
                  key={a.approvalId}
                  className="flex items-center justify-between gap-2 rounded-lg border border-line/60 bg-panel px-3 py-2"
                >
                  <span className="min-w-0 truncate text-xs text-muted">
                    {a.title}
                  </span>
                  <StatusChip
                    tone={a.status === "approved" ? "success" : "critical"}
                    label={a.status === "approved" ? "Approved" : "Rejected"}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function ApprovalCard({
  approval,
  busy,
  onDecide,
}: {
  approval: ApprovalItem;
  busy: boolean;
  onDecide: (decision: "approve" | "reject") => void;
}) {
  const quote =
    approval.action === "send_quote"
      ? normalizeQuote(approval.payload.quote)
      : null;
  const why =
    (typeof approval.payload.why === "string" && approval.payload.why) ||
    quote?.escalationDetails ||
    null;
  const draftText =
    approval.action === "send_nudge" &&
    typeof approval.payload.draftText === "string"
      ? approval.payload.draftText
      : null;

  return (
    <Card className="overflow-hidden">
      <div className="space-y-3 p-3.5">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold text-ink">{approval.title}</p>
          <span className="shrink-0 text-[11px] text-faint tabular-nums">
            {timeAgo(approval.createdAt)}
          </span>
        </div>

        {quote && <QuoteCard quote={quote} showStatus={false} />}

        {draftText && (
          <blockquote className="border-l-2 border-line pl-3 text-sm text-muted italic">
            “{draftText}”
          </blockquote>
        )}

        {why && (
          <div className="rounded-md border-l-2 border-warning bg-warning-soft px-3 py-2">
            <p className="text-xs font-semibold text-warning">
              Why this needs you
            </p>
            <p className="mt-0.5 text-sm text-ink">{why}</p>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            onClick={() => onDecide("approve")}
            className="flex-1"
          >
            <CheckIcon className="size-3.5" />
            Approve
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={busy}
            onClick={() => onDecide("reject")}
            className="flex-1"
          >
            <XIcon className="size-3.5" />
            Reject
          </Button>
        </div>
      </div>
    </Card>
  );
}
