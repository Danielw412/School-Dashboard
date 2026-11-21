import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ActivityStore, type ActivityEvent, sanitizeForLog } from "./activity.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("activity redaction", () => {
  it("removes URL capabilities without hiding token-usage diagnostics", () => {
    const value = sanitizeForLog({
      sourceUrl: "https://canvas.test/courses/9/files/7?verifier=secret&wrap=1",
      input_tokens: 1234,
      access_token: "secret-token",
    });

    expect(value).toEqual({
      sourceUrl: "https://canvas.test/courses/9/files/7?wrap=1",
      input_tokens: 1234,
      access_token: "[redacted]",
    });
  });
});

describe("ActivityStore", () => {
  it("records in memory, tells subscribers, and saves shortly after", async () => {
    const directory = await mkdtemp(join(tmpdir(), "school-dashboard-activity-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "activity.json");
    await writeFile(path, JSON.stringify([event("earlier")]), "utf8");
    const store = new ActivityStore(path, 10);
    const heard: string[] = [];
    store.subscribe((recorded) => heard.push(recorded.action));
    store.subscribe(() => {
      throw new Error("a broken listener must not fail the recorder");
    });

    await store.record({ category: "agent", action: "later", status: "completed", summary: "Run", metadata: { token: "secret" } });

    expect((await store.list()).map((item) => item.action)).toEqual(["later", "earlier"]);
    expect(heard).toEqual(["later"]);
    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(path, "utf8")) as ActivityEvent[];
      expect(saved.map((item) => item.action)).toEqual(["earlier", "later"]);
      expect(saved[1].metadata).toEqual({ token: "[redacted]" });
    });
  });

  it("keeps the newest 500 events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "school-dashboard-activity-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "activity.json");
    const store = new ActivityStore(path, 10);
    for (let index = 0; index < 505; index += 1) {
      await store.record({ category: "system", action: `event-${index}`, status: "completed", summary: "" });
    }
    await store.flush();

    const saved = JSON.parse(await readFile(path, "utf8")) as ActivityEvent[];
    expect(saved).toHaveLength(500);
    expect(saved[0].action).toBe("event-5");
    expect((await store.list(1000))[0].action).toBe("event-504");
  });
});

function event(action: string): ActivityEvent {
  return { id: action, timestamp: "2026-11-21T12:00:00.000Z", category: "system", action, status: "completed", summary: "" };
}
