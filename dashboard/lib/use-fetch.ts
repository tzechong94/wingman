"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: unknown;
  reload: () => void;
  /** Optimistically replace the data without a round trip. */
  mutate: (updater: (prev: T | null) => T | null) => void;
}

/**
 * Tiny data-fetching hook: loads once (when `enabled`), exposes reload +
 * optimistic mutate. Stale responses from superseded loads are discarded.
 */
export function useFetch<T>(fn: () => Promise<T>, enabled = true): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<unknown>(null);
  const generation = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const load = useCallback(() => {
    const gen = ++generation.current;
    setLoading(true);
    setError(null);
    fnRef
      .current()
      .then((result) => {
        if (generation.current !== gen) return;
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (generation.current !== gen) return;
        setError(err);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (enabled) load();
  }, [enabled, load]);

  const mutate = useCallback((updater: (prev: T | null) => T | null) => {
    setData((prev) => updater(prev));
  }, []);

  return { data, loading, error, reload: load, mutate };
}
