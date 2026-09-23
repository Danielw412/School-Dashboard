import { describe, expect, it, vi } from "vitest";

import type { ActivityStore } from "./activity.js";
import {
  agentPlacement,
  type AgentExecutionCallbacks,
  type AgentExecutionRequest,
  LocalCodexExecutor,
} from "./agent-execution.js";
import type { CodexTurnCallbacks, CodexTurnRequest, CodexTurnResult } from "./codex-execution.js";

function request(runId: string, toolToken: string | null = null): AgentExecutionRequest {
  return {
    runId,
    feature: "problemExtraction",
    taskTitle: `Assignment ${runId}`,
    model: "gpt-6-luna",
    reasoningEffort: "xhigh",
    instructions: "Return JSON.",
    outputSchema: { type: "object" },
    networkAccessEnabled: true,
    workspace: { id: `workspace-${runId}`, path: `/tmp/workspace-${runId}` },
    toolToken,
    timeoutMs: 60_000,
    target: "local",
  };
}

function callbacks(signal = new AbortController().signal): AgentExecutionCallbacks & { started: ReturnType<typeof vi.fn> } {
  const started = vi.fn();
  return { signal, onStarted: started, onEvent: () => undefined, started };
}

function deferredTurns() {
  const pending: Array<{ request: CodexTurnRequest; resolve: (result: CodexTurnResult) => void }> = [];
  const runTurn = vi.fn((turn: CodexTurnRequest, turnCallbacks: CodexTurnCallbacks) => {
    void turnCallbacks;
    return new Promise<CodexTurnResult>((resolve) => pending.push({ request: turn, resolve }));
  });
  return { pending, runTurn };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("LocalCodexExecutor", () => {
  it("runs Codex here against the dashboard's own MCP endpoint", async () => {
    const { pending, runTurn } = deferredTurns();
    const executor = new LocalCodexExecutor({ mcpUrl: "http://127.0.0.1:8892/api/internal/canvas-mcp", role: "server", runTurn });
    const run = executor.run(request("a", "tool-token-0123456789abcdef"), callbacks());
    await flush();
    expect(pending[0]!.request).toMatchObject({
      workingDirectory: "/tmp/workspace-a",
      mcp: { url: "http://127.0.0.1:8892/api/internal/canvas-mcp", token: "tool-token-0123456789abcdef" },
    });
    expect(executor.status()).toMatchObject({ mode: "local", available: true, activeJobs: 1, queuedJobs: 0 });
    pending[0]!.resolve({ threadId: "thread-a", usage: null, finalResponse: "{}" });
    await expect(run).resolves.toMatchObject({ threadId: "thread-a" });
    expect(executor.status().activeJobs).toBe(0);
  });

  it("queues runs beyond its concurrency limit and reports the wait as progress", async () => {
    const { pending, runTurn } = deferredTurns();
    const activity = { record: vi.fn(async () => undefined) } as unknown as ActivityStore;
    const executor = new LocalCodexExecutor({ mcpUrl: "http://127.0.0.1/mcp", role: "server", maxConcurrentJobs: 1, activity, runTurn });
    const first = callbacks();
    const second = callbacks();
    const firstRun = executor.run(request("a"), first);
    const secondRun = executor.run(request("b"), second);
    await flush();

    expect(pending).toHaveLength(1);
    expect(second.started).not.toHaveBeenCalled();
    expect(executor.status()).toMatchObject({ activeJobs: 1, queuedJobs: 1 });
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({
      action: "agent-slot.wait",
      status: "started",
      metadata: { runId: "b", progressLabel: "Waiting for a free agent slot on the server" },
    }));

    pending[0]!.resolve({ threadId: "thread-a", usage: null, finalResponse: "{}" });
    await firstRun;
    await flush();
    expect(pending).toHaveLength(2);
    expect(second.started).toHaveBeenCalledTimes(1);
    pending[1]!.resolve({ threadId: "thread-b", usage: null, finalResponse: "{}" });
    await expect(secondRun).resolves.toMatchObject({ threadId: "thread-b" });
    expect(executor.status()).toMatchObject({ activeJobs: 0, queuedJobs: 0 });
  });

  it("drops a cancelled run from the queue without starting Codex", async () => {
    const { pending, runTurn } = deferredTurns();
    const executor = new LocalCodexExecutor({ mcpUrl: "http://127.0.0.1/mcp", maxConcurrentJobs: 1, runTurn });
    const firstRun = executor.run(request("a"), callbacks());
    const controller = new AbortController();
    const cancelled = executor.run(request("b"), callbacks(controller.signal));
    await flush();
    controller.abort(new Error("Cancelled by the user."));
    await expect(cancelled).rejects.toThrow("Cancelled by the user.");
    expect(executor.status().queuedJobs).toBe(0);

    pending[0]!.resolve({ threadId: "thread-a", usage: null, finalResponse: "{}" });
    await firstRun;
    await flush();
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(executor.status().activeJobs).toBe(0);
  });

  it("is unavailable while Codex is signed out on this machine", async () => {
    const signInStatus = vi.fn(async () => ({ ready: false, detail: "Not logged in" }));
    const executor = new LocalCodexExecutor({ mcpUrl: "http://127.0.0.1/mcp", role: "server", signInStatus });
    expect(executor.status().available).toBe(true);
    await executor.refreshSignIn();
    const status = executor.status();
    expect(status.available).toBe(false);
    expect(status.message).toMatch(/Codex is not signed in on the dashboard server .*codex login --device-auth/u);

    signInStatus.mockResolvedValue({ ready: true, detail: "Logged in using ChatGPT" });
    await executor.refreshSignIn();
    expect(executor.status().available).toBe(true);
  });

  it("stays available when the sign-in check itself cannot run", async () => {
    const executor = new LocalCodexExecutor({
      mcpUrl: "http://127.0.0.1/mcp",
      signInStatus: async () => ({ ready: null, detail: "spawn EACCES" }),
    });
    await executor.refreshSignIn();
    expect(executor.status()).toMatchObject({ available: true });
  });
});

describe("agentPlacement", () => {
  it("records the selected target's label and host", () => {
    expect(agentPlacement({
      mode: "local",
      available: true,
      message: "",
      worker: null,
      activeJobs: 0,
      queuedJobs: 0,
      targets: [
        { id: "local", label: "Server", host: "latitude7370", available: true, message: "", activeJobs: 0, queuedJobs: 0 },
        { id: "worker", label: "Laptop", host: "DESKTOP-TQMTS8O", available: true, message: "", activeJobs: 0, queuedJobs: 0 },
      ],
    })).toEqual({ target: "local", label: "Server", host: "latitude7370" });
  });
});
