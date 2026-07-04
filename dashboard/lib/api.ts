import {
  normalizeApproval,
  normalizeConversation,
  normalizeMemory,
  normalizeQuote,
  parseConvEvent,
  type Analytics,
  type ApprovalItem,
  type ConvEvent,
  type ConversationSummary,
  type MemorySnapshot,
  type QuoteRecord,
} from "./types";

const BASE = "/webhook/web";

/** Single constant for the SSE endpoint (see lib/sse.ts). */
export const SSE_URL = `${BASE}/events`;

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function isAuthError(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 401 || e.status === 403);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      credentials: "same-origin",
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(0, "Network error — is the Wingman host running?");
  }

  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const message =
      body !== null &&
      typeof body === "object" &&
      "error" in body &&
      typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }

  return body as T;
}

function get<T>(path: string): Promise<T> {
  return request<T>(path);
}

function post<T>(path: string, payload?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: payload === undefined ? "{}" : JSON.stringify(payload),
  });
}

export interface SessionInfo {
  visitorId: string;
  sessionId: string;
}

export interface Attachment {
  mimeType: string;
  data: string;
}

export const api = {
  createSession(): Promise<SessionInfo> {
    return post<SessionInfo>("/session");
  },

  sendMessage(text: string, attachments?: Attachment[]): Promise<{ ok: boolean }> {
    return post<{ ok: boolean }>("/message", {
      text,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    });
  },

  async transcript(opts?: { sessionId?: string; after?: number }): Promise<ConvEvent[]> {
    const params = new URLSearchParams();
    if (opts?.sessionId) params.set("sessionId", opts.sessionId);
    if (opts?.after !== undefined) params.set("after", String(opts.after));
    const qs = params.toString();
    const res = await get<{ events: unknown[] }>(`/transcript${qs ? `?${qs}` : ""}`);
    return (res.events ?? [])
      .map(parseConvEvent)
      .filter((e): e is ConvEvent => e !== null);
  },

  auth(token: string): Promise<{ ok: boolean }> {
    return post<{ ok: boolean }>("/auth", { token });
  },

  async approvals(): Promise<ApprovalItem[]> {
    const res = await get<{ approvals: unknown[] }>("/approvals");
    return (res.approvals ?? [])
      .map(normalizeApproval)
      .filter((a): a is ApprovalItem => a !== null);
  },

  decide(approvalId: string, decision: "approve" | "reject"): Promise<{ ok: boolean }> {
    return post<{ ok: boolean }>(`/approvals/${encodeURIComponent(approvalId)}`, {
      decision,
    });
  },

  analytics(): Promise<Analytics> {
    return get<Analytics>("/analytics");
  },

  async quotes(): Promise<QuoteRecord[]> {
    const res = await get<{ quotes: unknown[] }>("/quotes");
    return (res.quotes ?? [])
      .map(normalizeQuote)
      .filter((q): q is QuoteRecord => q !== null);
  },

  async conversations(): Promise<ConversationSummary[]> {
    const res = await get<{ conversations: unknown[] }>("/conversations");
    return (res.conversations ?? [])
      .map(normalizeConversation)
      .filter((c): c is ConversationSummary => c !== null);
  },

  async memory(): Promise<MemorySnapshot> {
    const res = await get<unknown>("/memory");
    return normalizeMemory(res);
  },

  reset(): Promise<SessionInfo> {
    return post<SessionInfo>("/reset");
  },

  timewarp(sessionId: string): Promise<{ ok: boolean; warped: number }> {
    return post<{ ok: boolean; warped: number }>("/timewarp", { sessionId });
  },
};
