import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActivityStore } from "./activity.js";
import { TaskSyncClient, TaskSyncRequestError } from "./task-sync.js";

const activity = { record: vi.fn(async () => undefined) } as unknown as ActivityStore;

describe("TaskSyncClient browser resources", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the CSRF bootstrap once and sends complex URLs as a JSON request body", async () => {
    const linkedUrl = 'https://docs.google.com/document/d/revision-guide/edit?tab="quoted value"&from=Canvas#Monday notes';
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("/bootstrap")) {
        return json({ csrf_token: "csrf-token-with-more-than-twenty-characters", api_version: 1 });
      }
      expect(url.pathname).toBe("/api/v1/agent/browser-resources/read");
      expect(init?.headers).toMatchObject({ "X-CSRF-Token": "csrf-token-with-more-than-twenty-characters" });
      expect(JSON.parse(String(init?.body))).toEqual({ url: linkedUrl, timeout_seconds: 75 });
      return json({
        ok: true,
        source_type: "google_docs",
        source_url: linkedUrl,
        resource_id: "revision-guide",
        title: "Revision guide",
        captured_at: "2026-08-29T12:00:00Z",
        content: "Revise the claim and evidence.",
        content_truncated: false,
        items: [],
        items_truncated: false,
        metadata: {},
        warnings: [],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new TaskSyncClient("http://127.0.0.1:8790/api/v1", activity);

    await client.readBrowserResource(linkedUrl);
    await client.readBrowserResource(linkedUrl);

    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/bootstrap"))).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refreshes a stale CSRF token once after Canvas Task Sync restarts", async () => {
    const linkedUrl = "https://docs.google.com/document/d/revision-guide/edit";
    let bootstrapCalls = 0;
    let resourceCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("/bootstrap")) {
        bootstrapCalls += 1;
        return json({
          csrf_token: bootstrapCalls === 1
            ? "csrf-token-before-task-sync-restart"
            : "csrf-token-after-task-sync-restart",
          api_version: 1,
        });
      }

      resourceCalls += 1;
      if (resourceCalls === 1) {
        expect(init?.headers).toMatchObject({ "X-CSRF-Token": "csrf-token-before-task-sync-restart" });
        return json({
          error: {
            code: "csrf_failed",
            message: "Refresh the control center and try the action again.",
          },
        }, 403);
      }

      expect(init?.headers).toMatchObject({ "X-CSRF-Token": "csrf-token-after-task-sync-restart" });
      return json({
        ok: true,
        source_type: "google_docs",
        source_url: linkedUrl,
        resource_id: "revision-guide",
        title: "Revision guide",
        captured_at: "2026-08-30T04:00:00Z",
        content: "Use a specific claim and analyze the evidence.",
        content_truncated: false,
        items: [],
        items_truncated: false,
        metadata: {},
        warnings: [],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new TaskSyncClient("http://127.0.0.1:8790/api/v1", activity);

    const resource = await client.readBrowserResource(linkedUrl);

    expect(resource.content).toBe("Use a specific claim and analyze the evidence.");
    expect(bootstrapCalls).toBe(2);
    expect(resourceCalls).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("preserves structured authentication and access errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/bootstrap")) {
        return json({ csrf_token: "csrf-token-with-more-than-twenty-characters", api_version: 1 });
      }
      return json({ error: { code: "sign_in_required", message: "Sign in with the course account." } }, 409);
    }));
    const client = new TaskSyncClient("http://127.0.0.1:8790/api/v1", activity);

    await expect(client.readBrowserResource("https://example.com/course-resource")).rejects.toMatchObject({
      name: "TaskSyncRequestError",
      code: "sign_in_required",
      status: 409,
      message: "Sign in with the course account.",
    } satisfies Partial<TaskSyncRequestError>);
  });
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
