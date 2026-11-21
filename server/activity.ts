import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

import { ACTIVITY_PATH } from "./env.js";
import { JsonFileWriter, readJsonFile, removeStaleTemporaryFiles } from "./json-file.js";

export type ActivityCategory =
  | "agent"
  | "canvas"
  | "task_sync"
  | "resource"
  | "cache"
  | "system";

export type ActivityEvent = {
  id: string;
  timestamp: string;
  category: ActivityCategory;
  action: string;
  status: "started" | "completed" | "warning" | "failed";
  summary: string;
  metadata?: Record<string, unknown>;
};

const SECRET_KEY = /^(authorization|api.?key|token|.*_token|secret|.*_secret|password|cookie|access_code|verification_code)$/i;
const BEARER = /Bearer\s+[A-Za-z0-9._~+\/-]+/gi;
const SENSITIVE_QUERY_VALUE = /([?&](?:verifier|access_token|token|api_key|signature|sig)=)[^&#\s"'<>]+/gi;
const SENSITIVE_QUERY_KEYS = new Set([
  "verifier",
  "access_token",
  "token",
  "api_key",
  "signature",
  "sig",
]);

export function sanitizeUrlCapabilities(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function sanitizeForLog(value: unknown): unknown {
  if (typeof value === "string") {
    const withoutBearer = value.replace(BEARER, "Bearer [redacted]");
    if (/^https?:\/\//i.test(withoutBearer)) return sanitizeUrlCapabilities(withoutBearer);
    return withoutBearer.replace(SENSITIVE_QUERY_VALUE, "$1[redacted]");
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeForLog);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY.test(key) ? "[redacted]" : sanitizeForLog(item),
      ]),
    );
  }
  return value;
}

const MAX_EVENTS = 500;

export type ActivityListener = (event: ActivityEvent) => void;

// The recent activity log. It lives in memory (loaded once) and is saved to disk shortly after it
// changes, so recording an event never waits on the file and reading never re-parses it.
export class ActivityStore {
  private events: ActivityEvent[] | null = null;
  private loading: Promise<ActivityEvent[]> | null = null;
  private readonly listeners = new Set<ActivityListener>();
  private readonly file: JsonFileWriter;

  constructor(private readonly path = ACTIVITY_PATH, private readonly saveDelayMs = 1_000) {
    // Activity is diagnostic telemetry. A transient antivirus/indexer lock must never fail a
    // Canvas tool or an agent run, so a failed save is dropped and retried with the next event.
    this.file = new JsonFileWriter(path, () => this.events ?? [], replaceActivityFile);
  }

  async list(limit = 150): Promise<ActivityEvent[]> {
    const events = await this.load();
    return events.slice(-Math.max(1, Math.min(limit, MAX_EVENTS))).reverse();
  }

  async record(
    event: Omit<ActivityEvent, "id" | "timestamp">,
  ): Promise<ActivityEvent> {
    const complete: ActivityEvent = {
      ...event,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      metadata: sanitizeForLog(event.metadata) as Record<string, unknown> | undefined,
    };
    const events = await this.load();
    events.push(complete);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    this.file.saveSoon(this.saveDelayMs);
    for (const listener of this.listeners) {
      try {
        listener(complete);
      } catch {
        // A listener (run progress, live updates) must never fail the work being recorded.
      }
    }
    return complete;
  }

  // Called with each new event, after it is recorded.
  subscribe(listener: ActivityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Writes any events not yet on disk (on shutdown).
  async flush(): Promise<void> {
    await this.file.flush().catch(() => undefined);
  }

  private load(): Promise<ActivityEvent[]> {
    if (this.events) return Promise.resolve(this.events);
    this.loading ??= (async () => {
      await removeStaleTemporaryFiles(this.path);
      let saved: ActivityEvent[] = [];
      try {
        const parsed = await readJsonFile(this.path);
        if (Array.isArray(parsed)) saved = (parsed as ActivityEvent[]).slice(-MAX_EVENTS);
      } catch {
        // Missing or unreadable: start a fresh log.
      }
      this.events = saved;
      return saved;
    })();
    return this.loading;
  }
}

async function replaceActivityFile(temporaryPath: string, destination: string, contents: string) {
  try {
    await rename(temporaryPath, destination);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code !== "EPERM" && code !== "EACCES") throw error;
    await new Promise((resolve) => setTimeout(resolve, 30));
    try {
      await rename(temporaryPath, destination);
    } catch {
      await writeFile(destination, contents, "utf8");
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
