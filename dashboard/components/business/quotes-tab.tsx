"use client";

import { dateTime, money, shortId } from "@/lib/format";
import type { EscalationReason, QuoteRecord } from "@/lib/types";
import { useState } from "react";
import { FileTextIcon } from "../icons";
import { QuoteCard, QUOTE_STATUS_META } from "../quote-card";
import { Button, CenteredState, Modal, Spinner, StatusChip } from "../ui";

const ESCALATION_LABELS: Record<Exclude<EscalationReason, null>, string> = {
  discount_exceeds_limit: "Discount over limit",
  off_card: "Off rate card",
  low_confidence: "Low confidence",
  total_exceeds_limit: "Total over limit",
};

export function QuotesTab({
  quotes,
  loading,
  error,
  onReload,
}: {
  quotes: QuoteRecord[];
  loading: boolean;
  error: unknown;
  onReload: () => void;
}) {
  const [open, setOpen] = useState<QuoteRecord | null>(null);

  if (loading && quotes.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted">
        <Spinner className="size-4" /> Loading quotes…
      </div>
    );
  }

  if (error && quotes.length === 0) {
    return (
      <CenteredState
        title="Couldn't load quotes"
        action={
          <Button size="sm" onClick={onReload}>
            Retry
          </Button>
        }
      />
    );
  }

  if (quotes.length === 0) {
    return (
      <CenteredState
        icon={<FileTextIcon className="size-6" />}
        title="No quotes yet"
        hint="Quotes the agent produces — auto-sent or escalated — are listed here."
      />
    );
  }

  const sorted = [...quotes].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] font-semibold tracking-wide text-muted uppercase">
              <th className="px-4 py-2">Customer</th>
              <th className="px-4 py-2 text-right">Total</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((q) => {
              const meta = QUOTE_STATUS_META[q.status] ?? {
                label: q.status,
                tone: "neutral" as const,
              };
              return (
                <tr
                  key={q.id}
                  onClick={() => setOpen(q)}
                  className="cursor-pointer border-b border-line/60 last:border-b-0 hover:bg-panel-2/60"
                >
                  <td className="px-4 py-2.5 text-ink">
                    {q.customerName || shortId(q.sessionId)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-medium text-ink tabular-nums">
                    {money(q.totalCents, q.currency)}
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusChip tone={meta.tone} label={meta.label} />
                  </td>
                  <td className="px-4 py-2.5 text-muted tabular-nums">
                    {dateTime(q.createdAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {open && (
        <Modal title={`Quote · ${open.customerName || shortId(open.id)}`} onClose={() => setOpen(null)}>
          <div className="space-y-3 px-4 py-4">
            <QuoteCard quote={open} />
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              {open.escalationReason && (
                <MetaRow
                  label="Escalation"
                  value={
                    ESCALATION_LABELS[open.escalationReason] ??
                    open.escalationReason
                  }
                  tone="warning"
                />
              )}
              {open.confidence !== null && (
                <MetaRow
                  label="Confidence"
                  value={`${Math.round(open.confidence * 100)}%`}
                />
              )}
              <MetaRow label="Created" value={dateTime(open.createdAt)} />
              <MetaRow label="Session" value={shortId(open.sessionId, 8)} />
            </dl>
            {open.escalationDetails && (
              <div className="rounded-md border-l-2 border-warning bg-warning-soft px-3 py-2">
                <p className="text-xs font-semibold text-warning">
                  Escalation details
                </p>
                <p className="mt-0.5 text-sm text-ink">
                  {open.escalationDetails}
                </p>
              </div>
            )}
            {open.notes && (
              <p className="rounded-md bg-panel-2 px-3 py-2 text-sm text-muted">
                {open.notes}
              </p>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

function MetaRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warning";
}) {
  return (
    <div>
      <dt className="text-[11px] font-semibold tracking-wide text-faint uppercase">
        {label}
      </dt>
      <dd
        className={`mt-0.5 tabular-nums ${tone === "warning" ? "text-warning" : "text-ink"}`}
      >
        {value}
      </dd>
    </div>
  );
}
