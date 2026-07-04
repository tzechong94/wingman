"use client";

import { money } from "@/lib/format";
import type { FileRef, QuoteRecord, QuoteStatus } from "@/lib/types";
import { DownloadIcon } from "./icons";
import { StatusChip, type ChipTone } from "./ui";

export const QUOTE_STATUS_META: Record<
  QuoteStatus,
  { label: string; tone: ChipTone }
> = {
  auto_sent: { label: "Auto-sent", tone: "success" },
  approved: { label: "Approved", tone: "success" },
  pending_approval: { label: "Pending approval", tone: "warning" },
  rejected: { label: "Not approved", tone: "critical" },
};

/**
 * A quote rendered as line items + total. Used inside customer chat bubbles,
 * approval cards and the owner's quote detail modal.
 */
export function QuoteCard({
  quote,
  files,
  showStatus = true,
}: {
  quote: QuoteRecord;
  files?: FileRef[];
  showStatus?: boolean;
}) {
  const meta = QUOTE_STATUS_META[quote.status] ?? {
    label: quote.status,
    tone: "neutral" as ChipTone,
  };
  const pdf = files?.find((f) => f.url);

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-panel-2 px-3 py-2">
        <span className="text-xs font-semibold tracking-wide text-muted uppercase">
          Quote{quote.customerName ? ` · ${quote.customerName}` : ""}
        </span>
        {showStatus && <StatusChip tone={meta.tone} label={meta.label} />}
      </div>

      <table className="w-full text-sm">
        <tbody>
          {quote.lineItems.map((item, i) => (
            <tr key={i} className="border-b border-line/60 last:border-b-0">
              <td className="px-3 py-2 align-top text-ink">
                {item.description}
                <span className="mt-0.5 block text-xs text-muted tabular-nums">
                  {item.qty} × {money(item.unitPriceCents, quote.currency)}
                </span>
              </td>
              <td className="px-3 py-2 text-right align-top text-ink tabular-nums">
                {money(item.qty * item.unitPriceCents, quote.currency)}
              </td>
            </tr>
          ))}
          {quote.lineItems.length === 0 && (
            <tr>
              <td colSpan={2} className="px-3 py-2 text-sm text-muted">
                No line items
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="border-t border-line px-3 py-2">
        {quote.discountPct > 0 && (
          <div className="flex items-center justify-between text-sm text-muted">
            <span>Discount</span>
            <span className="tabular-nums">−{quote.discountPct}%</span>
          </div>
        )}
        <div className="flex items-center justify-between pt-0.5">
          <span className="text-sm font-medium text-ink">Total</span>
          <span className="text-base font-semibold text-ink tabular-nums">
            {money(quote.totalCents, quote.currency)}
          </span>
        </div>
      </div>

      {pdf && (
        <div className="border-t border-line px-3 py-2">
          <a
            href={pdf.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-xs font-medium text-accent-strong hover:bg-panel-2"
          >
            <DownloadIcon className="size-3.5" />
            Download PDF
          </a>
        </div>
      )}
    </div>
  );
}
