import type { LiveChange } from "./types";

// One shared connection to the server's change notices (GET /api/events), open while anything
// listens. A listener gets each notice, and `null` whenever the connection (re)opens, since changes
// made while it was closed were not announced.
type ChangeListener = (change: LiveChange | null) => void;

const changeListeners = new Set<ChangeListener>();
const connectionListeners = new Set<() => void>();
let source: EventSource | null = null;
let connected = false;
let retryTimer: number | null = null;

const RETRY_MS = 10_000;

// A run was created or its record changed (not just its progress): run lists reload.
export function runsChanged(change: LiveChange): boolean {
  return change.topics.includes("runs");
}

export function liveUpdatesSupported(): boolean {
  return typeof window !== "undefined" && typeof window.EventSource === "function";
}

export function subscribeToChanges(listener: ChangeListener): () => void {
  changeListeners.add(listener);
  connect();
  return () => {
    changeListeners.delete(listener);
    if (changeListeners.size === 0) disconnect();
  };
}

// Whether notices are arriving now; pages poll as before while they are not.
export function isLiveConnected(): boolean {
  return connected;
}

export function subscribeToConnection(listener: () => void): () => void {
  connectionListeners.add(listener);
  return () => connectionListeners.delete(listener);
}

function connect(): void {
  if (source || retryTimer !== null || !liveUpdatesSupported()) return;
  const next = new EventSource("/api/events");
  source = next;
  next.addEventListener("open", () => {
    setConnected(true);
    notify(null);
  });
  next.addEventListener("change", (event) => {
    try {
      notify(JSON.parse((event as MessageEvent<string>).data) as LiveChange);
    } catch {
      // Ignore a notice this version does not understand.
    }
  });
  next.addEventListener("error", () => {
    setConnected(false);
    // The browser reconnects by itself after a dropped stream. It gives up (CLOSED) on an error
    // reply, such as a server without this endpoint; try again later.
    if (next.readyState !== EventSource.CLOSED) return;
    next.close();
    if (source === next) source = null;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      if (changeListeners.size > 0) connect();
    }, RETRY_MS);
  });
}

function disconnect(): void {
  source?.close();
  source = null;
  if (retryTimer !== null) window.clearTimeout(retryTimer);
  retryTimer = null;
  setConnected(false);
}

function notify(change: LiveChange | null): void {
  for (const listener of [...changeListeners]) {
    try {
      listener(change);
    } catch {
      // One page's reload must not stop the others hearing about the change.
    }
  }
}

function setConnected(value: boolean): void {
  if (connected === value) return;
  connected = value;
  for (const listener of [...connectionListeners]) listener();
}
