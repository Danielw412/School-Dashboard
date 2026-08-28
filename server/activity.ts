import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { ACTIVITY_PATH } from "./env.js";

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

export class ActivityStore {
  private writeChain: Promise<void> = Promise.resolve();

  async list(limit = 150): Promise<ActivityEvent[]> {
    try {
      const parsed = JSON.parse(await readFile(ACTIVITY_PATH, "utf8")) as ActivityEvent[];
      return parsed.slice(-Math.max(1, Math.min(limit, 500))).reverse();
    } catch {
      return [];
    }
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
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      const current = (await this.list(500)).reverse();
      const next = [...current, complete].slice(-500);
      await mkdir(dirname(ACTIVITY_PATH), { recursive: true });
      const temporaryPath = `${ACTIVITY_PATH}.${process.pid}.${randomUUID()}.tmp`;
      const contents = `${JSON.stringify(next, null, 2)}\n`;
      try {
        await writeFile(temporaryPath, contents, "utf8");
        await replaceActivityFile(temporaryPath, contents);
      } catch {
        // Activity is diagnostic telemetry. A transient antivirus/indexer lock must
        // never fail a Canvas tool or an agent run.
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    });
    await this.writeChain.catch(() => undefined);
    return complete;
  }
}

async function replaceActivityFile(temporaryPath: string, contents: string) {
  try {
    await rename(temporaryPath, ACTIVITY_PATH);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code !== "EPERM" && code !== "EACCES") throw error;
    await new Promise((resolve) => setTimeout(resolve, 30));
    try {
      await rename(temporaryPath, ACTIVITY_PATH);
    } catch {
      await writeFile(ACTIVITY_PATH, contents, "utf8");
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
