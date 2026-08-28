import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

const SECRET_KEY = /(authorization|api.?key|token|secret|password|cookie)/i;
const BEARER = /Bearer\s+[A-Za-z0-9._~+\/-]+/gi;

export function sanitizeForLog(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(BEARER, "Bearer [redacted]");
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
    this.writeChain = this.writeChain.then(async () => {
      const current = (await this.list(500)).reverse();
      const next = [...current, complete].slice(-500);
      await mkdir(dirname(ACTIVITY_PATH), { recursive: true });
      const temporaryPath = `${ACTIVITY_PATH}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      await rename(temporaryPath, ACTIVITY_PATH);
    });
    await this.writeChain;
    return complete;
  }
}
