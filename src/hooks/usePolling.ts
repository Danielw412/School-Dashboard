import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { isLiveConnected, subscribeToChanges, subscribeToConnection } from "../live-updates";
import type { LiveChange } from "../types";

export type PollingOptions = {
  // Reload when the server announces a matching change. While those notices arrive, poll only
  // every `liveInterval` ms (0: not at all); if the connection drops, poll every `interval` again.
  live?: (change: LiveChange) => boolean;
  liveInterval?: number;
  // When false, load nothing (another component already supplies this data).
  enabled?: boolean;
};

export type PollingState<T> = {
  data: T | null;
  error: unknown;
  loading: boolean;
  refresh: () => Promise<T>;
  setData: Dispatch<SetStateAction<T | null>>;
};

export function usePolling<T>(loader: () => Promise<T>, interval = 0, options: PollingOptions = {}): PollingState<T> {
  const { live, liveInterval = 0, enabled = true } = options;
  const loaderRef = useRef(loader);
  const liveRef = useRef(live);
  useEffect(() => {
    loaderRef.current = loader;
    liveRef.current = live;
  }, [loader, live]);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(enabled);
  const hasLive = Boolean(live);
  const liveConnected = useSyncExternalStore(subscribeToConnection, isLiveConnected, () => false);
  const refresh = useCallback(async () => {
    try {
      const result = await loaderRef.current();
      setData(result);
      setError(null);
      return result;
    } catch (nextError) {
      setError(nextError);
      throw nextError;
    } finally {
      setLoading(false);
    }
  }, []);
  // Load on mount, and again when the polling interval changes (a run finishing, for example).
  useEffect(() => {
    if (!enabled) return;
    void refresh().catch(() => undefined);
  }, [refresh, interval, enabled]);
  useEffect(() => {
    if (!enabled || !hasLive) return;
    return subscribeToChanges((change) => {
      if (change === null || liveRef.current?.(change)) void refresh().catch(() => undefined);
    });
  }, [refresh, enabled, hasLive]);
  const pollEvery = hasLive && liveConnected ? liveInterval : interval;
  useEffect(() => {
    if (!enabled || !pollEvery) return;
    const timer = window.setInterval(() => void refresh().catch(() => undefined), pollEvery);
    return () => window.clearInterval(timer);
  }, [refresh, pollEvery, enabled]);
  return { data, error, loading, refresh, setData };
}
