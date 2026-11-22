// The last copy of slow server data (assignments come from Google Tasks through Task Sync), kept
// in this browser so a page can show it at once while a fresh copy loads. It is only a
// convenience: without storage, or after a format change (bump the version), pages load as before.
const PREFIX = "school-dashboard:cache:v1:";

export function readCached<T>(key: string): T | null {
  try {
    const stored = window.localStorage.getItem(PREFIX + key);
    return stored === null ? null : JSON.parse(stored) as T;
  } catch {
    return null;
  }
}

export function writeCached(key: string, value: unknown) {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage is full or blocked; the next visit loads normally.
  }
}
