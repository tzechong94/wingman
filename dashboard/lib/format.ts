/** Format integer cents as a currency amount, e.g. 128050 → "S$1,280.50". */
export function money(cents: number, currency: string): string {
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat("en-SG", {
      style: "currency",
      currency: currency || "SGD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency || "$"} ${amount.toFixed(2)}`;
  }
}

/** Humanize a duration in seconds: 42 → "42s", 190 → "3m 10s", 4000 → "1h 7m". */
export function humanizeSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** "14:02" style clock time for a timestamp (epoch ms). */
export function clockTime(ms: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    return "";
  }
}

/** Short relative time: "just now", "4m ago", "2h ago", "3d ago", else a date. */
export function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 30_000) return "just now";
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  try {
    return new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
    }).format(new Date(ms));
  } catch {
    return "";
  }
}

/** Date + time for tables: "3 Jul, 14:02". */
export function dateTime(ms: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    return "";
  }
}

/** Compact display for opaque ids: keep the tail, which is the varying part. */
export function shortId(id: string, len = 6): string {
  if (!id) return "—";
  return id.length <= len ? id : `…${id.slice(-len)}`;
}
