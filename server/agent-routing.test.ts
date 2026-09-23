import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentExecutionCallbacks,
  AgentExecutionRequest,
  AgentExecutionStatus,
  AgentExecutionTarget,
  AgentExecutor,
} from "./agent-execution.js";
import { AgentExecutionRouter, AgentTargetStore, UnknownAgentTargetError } from "./agent-routing.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function targetPath() {
  const root = await mkdtemp(join(tmpdir(), "school-agent-target-"));
  roots.push(root);
  return join(root, "agent-execution.json");
}

function fakeExecutor(mode: AgentExecutionTarget, status: Partial<AgentExecutionStatus> = {}) {
  const executor = {
    mode,
    status: (): AgentExecutionStatus => ({
      mode,
      available: true,
      message: mode === "worker" ? "Agents run on DESKTOP-TQMTS8O through the laptop agent worker." : "Codex runs on the dashboard server.",
      worker: null,
      activeJobs: 0,
      queuedJobs: 0,
      ...status,
    }),
    run: vi.fn(async (request: AgentExecutionRequest, callbacks: AgentExecutionCallbacks) => {
      void callbacks;
      return { threadId: `${mode}-${request.runId}`, usage: null, finalResponse: "{}" };
    }),
  } satisfies AgentExecutor;
  return executor;
}

const laptop = {
  id: "worker-1",
  name: "DESKTOP-TQMTS8O",
  hostname: "DESKTOP-TQMTS8O",
  platform: "win32",
  codexVersion: "0.156.0",
  maxConcurrentJobs: 3,
  connectedAt: null,
  lastSeenAt: null,
  disconnectedAt: null,
};

function request(target?: AgentExecutionTarget): AgentExecutionRequest {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    feature: "directions",
    taskTitle: "Worksheet 3",
    model: "gpt-6-luna",
    reasoningEffort: "high",
    instructions: "Return JSON.",
    outputSchema: {},
    networkAccessEnabled: true,
    workspace: { id: "workspace-1", path: "/tmp/workspace-1" },
    toolToken: null,
    timeoutMs: 60_000,
    target,
  };
}

const callbacks = (): AgentExecutionCallbacks => ({
  signal: new AbortController().signal,
  onStarted: () => undefined,
  onEvent: () => undefined,
});

describe("AgentTargetStore", () => {
  it("uses the fallback until a target is chosen, then remembers the choice across restarts", async () => {
    const path = await targetPath();
    const store = new AgentTargetStore({ path, targets: ["local", "worker"], fallback: "worker" });
    await store.load();
    expect(store.current()).toBe("worker");

    await store.set("local");
    expect(store.current()).toBe("local");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ target: "local" });

    const restarted = new AgentTargetStore({ path, targets: ["local", "worker"], fallback: "worker" });
    await restarted.load();
    expect(restarted.current()).toBe("local");
  });

  it("ignores a saved target this deployment no longer has, and refuses to select one", async () => {
    const path = await targetPath();
    await writeFile(path, JSON.stringify({ target: "worker" }), "utf8");
    const store = new AgentTargetStore({ path, targets: ["local"], fallback: "local" });
    await store.load();
    expect(store.current()).toBe("local");
    await expect(store.set("worker")).rejects.toBeInstanceOf(UnknownAgentTargetError);
    expect(store.current()).toBe("local");
  });
});

describe("AgentExecutionRouter", () => {
  it("reports both targets and sends new runs to the selected one", async () => {
    const store = new AgentTargetStore({ path: await targetPath(), targets: ["local", "worker"], fallback: "worker" });
    const local = fakeExecutor("local", { activeJobs: 1 });
    const worker = fakeExecutor("worker", { worker: laptop, activeJobs: 2, queuedJobs: 1 });
    const router = new AgentExecutionRouter(store, { local, worker });

    const status = router.status();
    expect(status.mode).toBe("worker");
    expect(status.worker?.name).toBe("DESKTOP-TQMTS8O");
    expect(status.activeJobs).toBe(3);
    expect(status.queuedJobs).toBe(1);
    expect(status.targets).toEqual([
      expect.objectContaining({ id: "local", label: "Server", host: hostname(), available: true, activeJobs: 1 }),
      expect.objectContaining({ id: "worker", label: "Laptop", host: "DESKTOP-TQMTS8O", available: true, queuedJobs: 1 }),
    ]);

    await router.run(request(), callbacks());
    expect(worker.run).toHaveBeenCalledTimes(1);
    expect(local.run).not.toHaveBeenCalled();

    const switched = await router.select("local");
    expect(switched.mode).toBe("local");
    expect(switched.message).toBe("Codex runs on the dashboard server.");
    // The laptop's details remain visible after switching to the server.
    expect(switched.worker?.name).toBe("DESKTOP-TQMTS8O");
    await router.run(request(), callbacks());
    expect(local.run).toHaveBeenCalledTimes(1);
  });

  it("keeps a run on the target it started with after the student switches", async () => {
    const store = new AgentTargetStore({ path: await targetPath(), targets: ["local", "worker"], fallback: "local" });
    const local = fakeExecutor("local");
    const worker = fakeExecutor("worker", { worker: laptop });
    const router = new AgentExecutionRouter(store, { local, worker });

    const pinned = request("worker");
    await router.select("local");
    const result = await router.run(pinned, callbacks());
    expect(result.threadId).toBe(`worker-${pinned.runId}`);
    expect(worker.run).toHaveBeenCalledWith(pinned, expect.anything());
    expect(local.run).not.toHaveBeenCalled();
  });

  it("reports the selected target's availability, not the other's", async () => {
    const store = new AgentTargetStore({ path: await targetPath(), targets: ["local", "worker"], fallback: "worker" });
    const offline = "Agents are unavailable: the laptop agent worker (DESKTOP-TQMTS8O) is offline.";
    const router = new AgentExecutionRouter(store, {
      local: fakeExecutor("local"),
      worker: fakeExecutor("worker", { available: false, message: offline, worker: laptop }),
    });
    expect(router.status()).toMatchObject({ mode: "worker", available: false, message: offline });
    expect(router.status().targets?.find((target) => target.id === "local")?.available).toBe(true);

    await router.select("local");
    expect(router.status()).toMatchObject({ mode: "local", available: true });
  });

  it("offers only this computer on a single-machine dashboard", async () => {
    const store = new AgentTargetStore({ path: await targetPath(), targets: ["local"], fallback: "local" });
    const router = new AgentExecutionRouter(store, { local: fakeExecutor("local"), worker: null });
    expect(router.status().targets).toEqual([
      expect.objectContaining({ id: "local", label: "This computer" }),
    ]);
    await expect(router.select("worker")).rejects.toThrow(/no laptop agent worker/u);
    await expect(router.run(request("worker"), callbacks())).rejects.toThrow(/cannot run on the laptop/u);
  });
});
