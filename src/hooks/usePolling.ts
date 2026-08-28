import { useCallback, useEffect, useRef, useState } from "react";

export function usePolling<T>(loader: () => Promise<T>, interval = 0) {
  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  }, [loader]);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
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
  useEffect(() => {
    void refresh().catch(() => undefined);
    if (!interval) return;
    const timer = window.setInterval(() => void refresh().catch(() => undefined), interval);
    return () => window.clearInterval(timer);
  }, [refresh, interval]);
  return { data, error, loading, refresh, setData };
}
