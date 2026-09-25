import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentProvider } from "../src/models.js";
import type {
  AgentExecutionCallbacks,
  AgentExecutionRequest,
  AgentExecutionStatus,
  AgentExecutionTarget,
  AgentExecutor,
} from "./agent-execution.js";
import { AgentExecutionRouter, AgentSelectionStore, UnknownAgentTargetError } from "./agent-routing.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function targetPath() {
  const root = await mkdtemp(join(tmpdir(), "school-agent-target-"));
  roots.push(root);
  return join(root, "agent-execution.json");
}

function fakeExecutor(
  mode: AgentExecutionTarget,
  status: Partial<AgentExecutionStatus> = {},
  byProvider: Partial<Record<AgentProvider, Partial<AgentExecutionStatus>>> = {},
) {
  const executor = {
    mode,
    status: (provider: AgentProvider = "codex"): AgentExecutionStatus => ({
      mode,
      provider,
      available: true,
      message: mode === "worker"
        ? `${provider === "claude" ? "Claude" : "Codex"} runs on DESKTOP-TQMTS8O through the laptop agent worker.`
        : `${provider === "claude" ? "Claude" : "Codex"} runs on the dashboard server.`,
      worker: null,
      activeJobs: 0,
      queuedJobs: 0,
      ...status,
      ...byProvider[provider],
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
    provider: "codex",
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

describe("AgentSelectionStore", () => {
  it("uses the fallback until a target is chosen, then remembers the choice across restarts", async () => {
    const path = await targetPath();
    const store = new AgentSelectionStore({ path, targets: ["local", "worker"], fallback: "worker" });
    await store.load();
    expect(store.current()).toBe("worker");

    await store.update({ target: "local" });
    expect(store.current()).toBe("local");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ target: "local", provider: "codex" });

    const restarted = new AgentSelectionStore({ path, targets: ["local", "worker"], fallback: "worker" });
    await restarted.load();
    expect(restarted.current()).toBe("local");
  });

  it("remembers the agent and a quick effort level per agent, keeping the other choices", async () => {
    const path = await targetPath();
    // A file from before Claude support names only the target.
    await writeFile(path, JSON.stringify({ target: "worker" }), "utf8");
    const store = new AgentSelectionStore({ path, targets: ["local", "worker"], fallback: "local" });
    await store.load();
    expect(store.current()).toBe("worker");
    expect(store.provider()).toBe("codex");
    expect(store.efforts()).toEqual({ codex: "default", claude: "default" });

    await store.update({ provider: "claude" });
    await store.update({ effort: "max" });
    await store.update({ provider: "codex", effort: "low" });
    expect(store.efforts()).toEqual({ codex: "low", claude: "max" });

    const restarted = new AgentSelectionStore({ path, targets: ["local", "worker"], fallback: "local" });
    await restarted.load();
    expect(restarted.current()).toBe("worker");
    expect(restarted.provider()).toBe("codex");
    expect(restarted.efforts()).toEqual({ codex: "low", claude: "max" });
  });

  it("falls back to Codex and the default effort for unreadable saved choices", async () => {
    const path = await targetPath();
    await writeFile(path, JSON.stringify({ target: "local", provider: "gemini", effort: { codex: "ultra" } }), "utf8");
    const store = new AgentSelectionStore({ path, targets: ["local"], fallback: "local" });
    await store.load();
    expect(store.provider()).toBe("codex");
    expect(store.efforts()).toEqual({ codex: "default", claude: "default" });
  });

  it("ignores a saved target this deployment no longer has, and refuses to select one", async () => {
    const path = await targetPath();
    await writeFile(path, JSON.stringify({ target: "worker" }), "utf8");
    const store = new AgentSelectionStore({ path, targets: ["local"], fallback: "local" });
    await store.load();
    expect(store.current()).toBe("local");
    await expect(store.update({ target: "worker" })).rejects.toBeInstanceOf(UnknownAgentTargetError);
    expect(store.current()).toBe("local");
  });
});

describe("AgentExecutionRouter", () => {
  it("reports both targets and sends new runs to the selected one", async () => {
    const store = new AgentSelectionStore({ path: await targetPath(), targets: ["local", "worker"], fallback: "worker" });
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

    const switched = await router.select({ target: "local" });
    expect(switched.mode).toBe("local");
    expect(switched.message).toBe("Codex runs on the dashboard server.");
    // The laptop's details remain visible after switching to the server.
    expect(switched.worker?.name).toBe("DESKTOP-TQMTS8O");
    await router.run(request(), callbacks());
    expect(local.run).toHaveBeenCalledTimes(1);
  });

  it("keeps a run on the target it started with after the student switches", async () => {
    const store = new AgentSelectionStore({ path: await targetPath(), targets: ["local", "worker"], fallback: "local" });
    const local = fakeExecutor("local");
    const worker = fakeExecutor("worker", { worker: laptop });
    const router = new AgentExecutionRouter(store, { local, worker });

    const pinned = request("worker");
    await router.select({ target: "local" });
    const result = await router.run(pinned, callbacks());
    expect(result.threadId).toBe(`worker-${pinned.runId}`);
    expect(worker.run).toHaveBeenCalledWith(pinned, expect.anything());
    expect(local.run).not.toHaveBeenCalled();
  });

  it("reports the selected target's availability, not the other's", async () => {
    const store = new AgentSelectionStore({ path: await targetPath(), targets: ["local", "worker"], fallback: "worker" });
    const offline = "Agents are unavailable: the laptop agent worker (DESKTOP-TQMTS8O) is offline.";
    const router = new AgentExecutionRouter(store, {
      local: fakeExecutor("local"),
      worker: fakeExecutor("worker", { available: false, message: offline, worker: laptop }),
    });
    expect(router.status()).toMatchObject({ mode: "worker", available: false, message: offline });
    expect(router.status().targets?.find((target) => target.id === "local")?.available).toBe(true);

    await router.select({ target: "local" });
    expect(router.status()).toMatchObject({ mode: "local", available: true });
  });

  it("offers only this computer on a single-machine dashboard", async () => {
    const store = new AgentSelectionStore({ path: await targetPath(), targets: ["local"], fallback: "local" });
    const router = new AgentExecutionRouter(store, { local: fakeExecutor("local"), worker: null });
    expect(router.status().targets).toEqual([
      expect.objectContaining({ id: "local", label: "This computer" }),
    ]);
    await expect(router.select({ target: "worker" })).rejects.toThrow(/no laptop agent worker/u);
    await expect(router.run(request("worker"), callbacks())).rejects.toThrow(/cannot run on the laptop/u);
  });

  it("reports each agent on the selected target and each target for the selected agent", async () => {
    const store = new AgentSelectionStore({ path: await targetPath(), targets: ["local", "worker"], fallback: "worker" });
    const claudeMissing = "The laptop agent worker on DESKTOP-TQMTS8O is from before Claude support.";
    const router = new AgentExecutionRouter(store, {
      local: fakeExecutor("local"),
      worker: fakeExecutor("worker", { worker: laptop }, { claude: { available: false, message: claudeMissing } }),
    });
    expect(router.status()).toMatchObject({ mode: "worker", provider: "codex", available: true, effort: { codex: "default", claude: "default" } });
    expect(router.status().providers).toEqual([
      expect.objectContaining({ id: "codex", label: "Codex", available: true }),
      expect.objectContaining({ id: "claude", label: "Claude", available: false, message: claudeMissing }),
    ]);

    const claude = await router.select({ provider: "claude", effort: "xhigh" });
    expect(claude).toMatchObject({ provider: "claude", available: false, message: claudeMissing, effort: { claude: "xhigh" } });
    expect(claude.targets?.map((target) => [target.id, target.available])).toEqual([["local", true], ["worker", false]]);
    expect(router.effort()).toBe("xhigh");
    expect(router.effort("codex")).toBe("default");

    const server = await router.select({ target: "local" });
    expect(server).toMatchObject({ mode: "local", provider: "claude", available: true, message: "Claude runs on the dashboard server." });
  });
});
