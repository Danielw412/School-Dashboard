import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ThreadEvent } from "@openai/codex-sdk";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActivityStore } from "./activity.js";
import type { AgentExecutionRequest } from "./agent-execution.js";
import type { CodexTurnCallbacks, CodexTurnRequest, CodexTurnResult } from "./codex-execution.js";
import { AgentWorkerClient, compactThreadEventForTransport } from "./worker-client.js";
import { WorkerHub, type WorkerModelsReport } from "./worker-hub.js";
import { WORKER_CONNECT_PATH } from "./worker-protocol.js";

const TOKEN = "worker-token-for-tests-0123456789abcdef";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type RunTurn = (request: CodexTurnRequest, callbacks: CodexTurnCallbacks) => Promise<CodexTurnResult>;

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function startHub(options: { port?: number; reconnectGraceMs?: number } = {}) {
  const server = createServer((_request, response) => response.writeHead(404).end());
  const reports: WorkerModelsReport[] = [];
  const activity = { record: vi.fn(async () => undefined) } as unknown as ActivityStore;
  const hub = new WorkerHub({
    token: TOKEN,
    allowedNetworks: ["loopback"],
    activity,
    mcpPath: "/api/internal/canvas-mcp",
    reconnectGraceMs: options.reconnectGraceMs ?? 2_000,
    heartbeatMs: 60_000,
    onModels: (report) => {
      reports.push(report);
    },
  });
  hub.attach(server);
  const port = await listen(server, options.port);
  const stop = async () => {
    hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanups.push(stop);
  return { hub, server, port, url: `http://127.0.0.1:${port}`, reports, activity, stop };
}

async function startWorker(url: string, runTurn: RunTurn, maxConcurrentJobs = 2) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "school-worker-"));
  const worker = new AgentWorkerClient({
    serverUrl: url,
    token: TOKEN,
    name: "laptop",
    workerId: "worker-1",
    maxConcurrentJobs,
    workspaceRoot,
    codexVersion: "0.156.0",
    listModels: async () => [{
      id: "gpt-6-luna",
      displayName: "GPT-6-Luna",
      hidden: false,
      isDefault: false,
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "medium",
    }],
    runTurn,
    log: () => undefined,
    reconnectInitialMs: 20,
    reconnectMaxMs: 60,
  });
  cleanups.push(async () => {
    await worker.stop();
    await rm(workspaceRoot, { recursive: true, force: true });
  });
  await worker.start();
  return { worker, workspaceRoot };
}

async function serverWorkspace() {
  const path = await mkdtemp(join(tmpdir(), "school-server-workspace-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  await mkdir(join(path, "resources"), { recursive: true });
  await writeFile(join(path, "extracted-problems.json"), JSON.stringify({ problems: [{ number: "1" }] }));
  await writeFile(join(path, "resources", "problem-1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]));
  return { id: `task-${randomUUID().slice(0, 8)}`, path };
}

function request(workspace: { id: string; path: string }, overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest {
  return {
    runId: randomUUID(),
    feature: "answerKey",
    taskTitle: "Worksheet 3",
    model: "gpt-6-luna",
    reasoningEffort: "high",
    instructions: "Solve the extracted problems.",
    outputSchema: { type: "object" },
    networkAccessEnabled: false,
    workspace,
    toolToken: "tool-capability-token-abcdef",
    timeoutMs: 60_000,
    ...overrides,
  };
}

async function until(condition: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function socketOf(worker: AgentWorkerClient): WebSocket {
  return (worker as unknown as { socket: WebSocket }).socket;
}

describe("laptop agent worker round trip", () => {
  it("runs a job on the worker with its mirrored workspace and streams compact events back", async () => {
    const { hub, url, reports } = await startHub();
    const seen: CodexTurnRequest[] = [];
    let mirrored: { json: string; image: number[] } | null = null;
    await startWorker(url, async (turn, { onEvent }) => {
      seen.push(turn);
      mirrored = {
        json: await readFile(join(turn.workingDirectory, "extracted-problems.json"), "utf8"),
        image: [...await readFile(join(turn.workingDirectory, "resources", "problem-1.png"))],
      };
      await onEvent({ type: "thread.started", thread_id: "thread-123" });
      await onEvent({
        type: "item.completed",
        item: {
          id: "tool-1",
          type: "mcp_tool_call",
          server: "school_dashboard",
          tool: "render_pdf_pages",
          arguments: {},
          result: { content: [{ type: "image", data: "A".repeat(50_000), mimeType: "image/png" }], structured_content: null },
          status: "completed",
        },
      } as ThreadEvent);
      await onEvent({ type: "item.completed", item: { id: "msg-1", type: "agent_message", text: "{\"answers\":[]}" } });
      await onEvent({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } } as ThreadEvent);
      return { threadId: "thread-123", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } as CodexTurnResult["usage"], finalResponse: "{\"answers\":[]}" };
    });
    await until(() => hub.status().available);
    expect(hub.status().worker).toMatchObject({ name: "laptop", codexVersion: "0.156.0", maxConcurrentJobs: 2 });
    expect(reports[0]).toMatchObject({ codexVersion: "0.156.0", models: [expect.objectContaining({ id: "gpt-6-luna" })] });

    const workspace = await serverWorkspace();
    const events: ThreadEvent[] = [];
    const onStarted = vi.fn();
    const result = await hub.run(request(workspace), {
      signal: new AbortController().signal,
      onStarted,
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result).toEqual({
      threadId: "thread-123",
      usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
      finalResponse: "{\"answers\":[]}",
    });
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual(["thread.started", "item.completed", "item.completed", "turn.completed"]);
    // The MCP result (base64 page images) stays on the laptop.
    expect(events[1]).toEqual({ type: "item.completed", item: { id: "tool-1", type: "mcp_tool_call" } });
    expect(mirrored).toEqual({ json: JSON.stringify({ problems: [{ number: "1" }] }), image: [0x89, 0x50, 0x4e, 0x47, 0, 255] });
    expect(seen[0].workingDirectory).toContain(workspace.id);
    expect(seen[0].mcp).toEqual({ url: `${url}/api/internal/canvas-mcp`, token: "tool-capability-token-abcdef" });
    expect(seen[0].networkAccessEnabled).toBe(false);
    expect(hub.status()).toMatchObject({ activeJobs: 0, queuedJobs: 0 });
  });

  it("keeps a run alive across a dropped connection and delivers its buffered result after reconnecting", async () => {
    const { hub, url, activity } = await startHub();
    const gate = deferred();
    const { worker } = await startWorker(url, async (_turn, { onEvent }) => {
      await onEvent({ type: "thread.started", thread_id: "thread-keep" });
      await gate.promise;
      await onEvent({ type: "item.completed", item: { id: "msg", type: "agent_message", text: "{\"ok\":true}" } });
      return { threadId: "thread-keep", usage: null, finalResponse: "{\"ok\":true}" };
    });
    await until(() => hub.status().available);

    const events: string[] = [];
    let started = false;
    const pending = hub.run(request(await serverWorkspace()), {
      signal: new AbortController().signal,
      onStarted: () => {
        started = true;
      },
      onEvent: (event) => {
        events.push(event.type === "item.completed" ? `item:${event.item.type}` : event.type);
      },
    });
    await until(() => started && events.includes("thread.started"));

    socketOf(worker).terminate();
    gate.release();

    await expect(pending).resolves.toEqual({ threadId: "thread-keep", usage: null, finalResponse: "{\"ok\":true}" });
    expect(events).toEqual(["thread.started", "item:agent_message"]);
    const actions = vi.mocked(activity.record).mock.calls.map(([event]) => event.action);
    expect(actions.filter((action) => action === "agent-worker.connect")).toHaveLength(2);
    expect(actions).toContain("agent-worker.disconnect");
    await until(() => hub.status().available);
  });

  it("fails a run whose worker stays offline past the reconnect grace period", async () => {
    const { hub } = await startHub({ reconnectGraceMs: 100 });
    expect(hub.status()).toMatchObject({ available: false, mode: "worker" });
    expect(hub.status().message).toMatch(/has not connected yet/u);

    await expect(hub.run(request(await serverWorkspace()), {
      signal: new AbortController().signal,
      onStarted: () => undefined,
      onEvent: () => undefined,
    })).rejects.toThrow("The laptop agent worker went offline before this run could start.");
  });

  it("cancels the laptop job when the dashboard run is cancelled", async () => {
    const { hub, url } = await startHub();
    let running = false;
    let aborted = false;
    await startWorker(url, (_turn, { signal }) => new Promise((_resolve, reject) => {
      running = true;
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      });
    }));
    await until(() => hub.status().available);
    const controller = new AbortController();
    const pending = hub.run(request(await serverWorkspace()), {
      signal: controller.signal,
      onStarted: () => undefined,
      onEvent: () => undefined,
    });
    await until(() => running);
    controller.abort(new Error("Cancelled by the user."));

    await expect(pending).rejects.toThrow("Cancelled by the user.");
    await until(() => aborted);
  });

  it("stops laptop jobs the dashboard server no longer tracks after it restarts", async () => {
    const first = await startHub();
    let aborted = false;
    let started = false;
    const { worker } = await startWorker(first.url, (_turn, { signal }) => new Promise((_resolve, reject) => {
      started = true;
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      });
    }));
    await until(() => first.hub.status().available);
    const pending = first.hub.run(request(await serverWorkspace()), {
      signal: new AbortController().signal,
      onStarted: () => undefined,
      onEvent: () => undefined,
    });
    pending.catch(() => undefined);
    await until(() => started && worker.activeRunIds().length === 1);

    await first.stop();
    const second = await startHub({ port: first.port });
    await until(() => second.hub.status().available);
    await until(() => aborted);
    await until(() => worker.activeRunIds().length === 0);
  });

  it("queues runs beyond the worker's concurrency until a slot frees up", async () => {
    const { hub, url } = await startHub();
    const gates = [deferred(), deferred()];
    let calls = 0;
    await startWorker(url, async () => {
      const gate = gates[calls];
      calls += 1;
      await gate.promise;
      return { threadId: `thread-${calls}`, usage: null, finalResponse: "{}" };
    }, 1);
    await until(() => hub.status().available);
    const callbacks = { signal: new AbortController().signal, onStarted: () => undefined, onEvent: () => undefined };
    const first = hub.run(request(await serverWorkspace()), callbacks);
    const second = hub.run(request(await serverWorkspace()), callbacks);
    await until(() => calls === 1);
    expect(hub.status()).toMatchObject({ activeJobs: 1, queuedJobs: 1 });

    gates[0].release();
    await first;
    await until(() => calls === 2);
    gates[1].release();
    await expect(second).resolves.toMatchObject({ finalResponse: "{}" });
  });

  it("refuses worker connections without the shared token", async () => {
    const { hub, port } = await startHub();
    const socket = new WebSocket(`ws://127.0.0.1:${port}${WORKER_CONNECT_PATH}`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    const error = await new Promise<Error>((resolve) => socket.on("error", resolve));
    expect(error.message).toContain("401");
    expect(hub.status().available).toBe(false);
  });
});

describe("worker event transport", () => {
  it("keeps agent text and errors but strips tool payloads", () => {
    const agent = { type: "item.completed", item: { id: "a", type: "agent_message", text: "{}" } } as ThreadEvent;
    const error = { type: "item.completed", item: { id: "e", type: "error", message: "boom" } } as ThreadEvent;
    const command = {
      type: "item.started",
      item: { id: "c", type: "command_execution", command: "cat secret", aggregated_output: "x", status: "in_progress" },
    } as ThreadEvent;
    expect(compactThreadEventForTransport(agent)).toBe(agent);
    expect(compactThreadEventForTransport(error)).toBe(error);
    expect(compactThreadEventForTransport(command)).toEqual({ type: "item.started", item: { id: "c", type: "command_execution" } });
    expect(compactThreadEventForTransport({ type: "turn.started" })).toEqual({ type: "turn.started" });
  });
});
