"use client";

import { useEffect, useRef, useState } from "react";
import { SSE_URL } from "./api";
import { parseConvEvent, type ConvEvent } from "./types";

export type SseState = "connecting" | "open" | "reconnecting";

type EventListenerFn = (e: ConvEvent) => void;
type StateListenerFn = (s: SseState) => void;

// ---------------------------------------------------------------------------
// Module-level singleton: one shared EventSource for the whole page.
// The backend decides scope (visitor vs owner firehose) from cookies, so the
// URL never changes — subscribers just attach/detach. Ref-counted: closed when
// the last subscriber unmounts.
// ---------------------------------------------------------------------------

let source: EventSource | null = null;
let refCount = 0;
let state: SseState = "connecting";
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelayMs = 2000;
const eventListeners = new Set<EventListenerFn>();
const stateListeners = new Set<StateListenerFn>();

function setState(next: SseState): void {
  if (state === next) return;
  state = next;
  stateListeners.forEach((fn) => fn(next));
}

function teardown(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (source) {
    source.close();
    source = null;
  }
}

function scheduleReconnect(): void {
  if (retryTimer || refCount === 0) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (refCount > 0) connect();
  }, retryDelayMs);
  retryDelayMs = Math.min(retryDelayMs * 2, 15_000);
}

function connect(): void {
  if (typeof window === "undefined") return;
  teardown();
  const es = new EventSource(SSE_URL);
  source = es;

  es.onopen = () => {
    retryDelayMs = 2000;
    setState("open");
  };

  es.addEventListener("conv", (ev: MessageEvent<string>) => {
    const parsed = parseConvEvent(ev.data);
    if (parsed) eventListeners.forEach((fn) => fn(parsed));
  });

  es.onerror = () => {
    setState("reconnecting");
    // EventSource retries CONNECTING states natively (preserving
    // Last-Event-ID); only a CLOSED source needs a manual respawn.
    if (es.readyState === EventSource.CLOSED) scheduleReconnect();
  };
}

/**
 * Force a fresh connection — needed after owner auth so the stream is
 * re-established with the owner cookie and upgrades to the firehose scope.
 */
export function sseReconnectNow(): void {
  if (refCount === 0) return;
  retryDelayMs = 2000;
  setState("connecting");
  connect();
}

/**
 * Subscribe to the shared conversation event stream.
 * Returns the connection state for "reconnecting…" indicators.
 */
export function useConvEvents(
  onEvent: EventListenerFn | undefined,
  enabled = true,
): SseState {
  const [localState, setLocalState] = useState<SseState>(state);
  const callbackRef = useRef(onEvent);
  callbackRef.current = onEvent;

  useEffect(() => {
    if (!enabled) return;

    const handler: EventListenerFn = (e) => callbackRef.current?.(e);
    eventListeners.add(handler);
    stateListeners.add(setLocalState);
    refCount += 1;
    if (!source) {
      setState("connecting");
      connect();
    }
    setLocalState(state);

    return () => {
      eventListeners.delete(handler);
      stateListeners.delete(setLocalState);
      refCount -= 1;
      if (refCount === 0) teardown();
    };
  }, [enabled]);

  return localState;
}
