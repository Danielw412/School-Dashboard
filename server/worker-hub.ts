import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import type { IncomingMessage, Server } from "node:http";
import { dirname, join, relative } from "node:path";
import type { Duplex } from "node:stream";

import type { ThreadEvent, Usage } from "@openai/codex-sdk";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { z } from "zod";

import type { ActivityStore } from "./activity.js";
import {
  AgentsUnavailableError,
  type AgentExecutionCallbacks,
  type AgentExecutionRequest,
  type AgentExecutionStatus,
  type AgentExecutor,
  type AgentWorkerSummary,
} from "./agent-execution.js";
import type { CodexTurnResult } from "./codex-execution.js";
import { buildAllowList, isAllowedAddress } from "./network-access.js";
import {
  type CodexModelInfo,
  type ServerMessage,
  WORKER_CONNECT_PATH,
  WORKER_PROTOCOL_VERSION,
  type WorkerHello,
  type WorkerJob,
  type WorkerJobFinished,
  workerMessageSchema,
} from "./worker-protocol.js";

// Server side of the laptop agent worker. The worker dials in over the tailnet and keeps one
// WebSocket open; the server queues each prepared Codex turn, sends it down that socket, and
// relays the streamed events and final result back to the waiting run. A dropped socket gives
// the worker a grace period to reconnect and reclaim its in-flight runs before they fail.

const MAX_WORKSPACE_BYTES = 40 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 10_000;

type PendingJob = {
  job: WorkerJob;
  callbacks: AgentExecutionCallbacks;
  state: "queued" | "dispatched" | "detached";
  // The worker confirmed it owns the job. An unconfirmed job lost in a disconnect is re-sent.
  accepted: boolean;
  timer: NodeJS.Timeout | null;
  events: Promise<void>;
  resolve: (result: CodexTurnResult) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
};

type Connection = {
  socket: WebSocket;
  worker: AgentWorkerSummary | null;
  alive: boolean;
};

export type WorkerModelsReport = {
  source: string;
  codexVersion: string | null;
  models: CodexModelInfo[] | null;
  error: string | null;
};

export type WorkerHubOptions = {
  token: string;
  allowedNetworks: string[];
  activity: ActivityStore;
  mcpPath: string;
  statePath?: string;
  onModels?: (report: WorkerModelsReport) => Promise<void> | void;
  reconnectGraceMs?: number;
  heartbeatMs?: number;
};

export class WorkerHub implements AgentExecutor {
  readonly mode = "worker" as const;
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  private readonly allowList: ReturnType<typeof buildAllowList>;
  private readonly jobs = new Map<string, PendingJob>();
  private readonly queue: string[] = [];
  private connection: Connection | null = null;
  private lastWorker: AgentWorkerSummary | null = null;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private readonly options: WorkerHubOptions) {
    this.allowList = buildAllowList(options.allowedNetworks);
  }

  async loadState(): Promise<void> {
    if (!this.options.statePath) return;
    try {
      const saved = JSON.parse(await readFile(this.options.statePath, "utf8")) as AgentWorkerSummary;
      if (saved && typeof saved.name === "string") {
        this.lastWorker = { ...saved, disconnectedAt: saved.disconnectedAt ?? saved.lastSeenAt };
      }
    } catch {
      this.lastWorker = null;
    }
  }

  attach(httpServer: Server): void {
    httpServer.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head));
    this.heartbeat = setInterval(() => this.checkHeartbeat(), this.options.heartbeatMs ?? 15_000);
    this.heartbeat.unref();
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.connection?.socket.terminate();
    this.server.close();
  }

  status(): AgentExecutionStatus {
    const worker = this.connection?.worker ?? null;
    const known = worker ?? this.lastWorker;
    const activeJobs = [...this.jobs.values()].filter((job) => job.state !== "queued").length;
    const queuedJobs = [...this.jobs.values()].filter((job) => job.state === "queued").length;
    let message: string;
    if (!this.options.token) {
      message = "Agents are unavailable: SCHOOL_DASHBOARD_WORKER_TOKEN is not set on the dashboard server.";
    } else if (worker) {
      message = `Agents run on ${worker.name} through the laptop agent worker.`;
    } else if (known) {
      const since = known.disconnectedAt ? ` since ${new Date(known.disconnectedAt).toLocaleString()}` : "";
      message = `Agents are unavailable: the laptop agent worker (${known.name}) is offline${since}.`;
    } else {
      message = "Agents are unavailable: the laptop agent worker has not connected yet.";
    }
    return {
      mode: "worker",
      available: Boolean(worker && this.options.token),
      message,
      worker: known ? { ...known } : null,
      activeJobs,
      queuedJobs,
    };
  }

  requestModelRefresh(): boolean {
    if (!this.connection?.worker) return false;
    this.send(this.connection, { type: "refresh-models" });
    return true;
  }

  async run(request: AgentExecutionRequest, callbacks: AgentExecutionCallbacks): Promise<CodexTurnResult> {
    callbacks.signal.throwIfAborted();
    if (!this.options.token) throw new AgentsUnavailableError(this.status().message);
    const files = await packWorkspace(request.workspace.path);
    callbacks.signal.throwIfAborted();
    const job: WorkerJob = {
      runId: request.runId,
      feature: request.feature,
      taskTitle: request.taskTitle,
      model: request.model,
      reasoningEffort: request.reasoningEffort,
      instructions: request.instructions,
      outputSchema: request.outputSchema,
      networkAccessEnabled: request.networkAccessEnabled,
      workspace: { id: request.workspace.id, files },
      toolToken: request.toolToken,
      mcpPath: this.options.mcpPath,
      timeoutMs: request.timeoutMs,
    };
    return new Promise<CodexTurnResult>((resolve, reject) => {
      const onAbort = () => this.abort(job.runId, callbacks.signal.reason);
      const pending: PendingJob = {
        job,
        callbacks,
        state: "queued",
        accepted: false,
        timer: null,
        events: Promise.resolve(),
        resolve,
        reject,
        cleanup: () => callbacks.signal.removeEventListener("abort", onAbort),
      };
      callbacks.signal.addEventListener("abort", onAbort, { once: true });
      this.jobs.set(job.runId, pending);
      this.queue.push(job.runId);
      if (!this.connection?.worker) {
        this.startGraceTimer(job.runId, "The laptop agent worker went offline before this run could start.");
      }
      this.pump();
      if (pending.state === "queued") {
        this.recordProgress(job, "started", this.connection?.worker
          ? "Waiting for a free slot on the laptop agent worker"
          : "Waiting for the laptop agent worker to reconnect");
      }
    });
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== WORKER_CONNECT_PATH) return rejectUpgrade(socket, 404, "Not Found");
    if (!isAllowedAddress(request.socket.remoteAddress, this.allowList)) {
      return rejectUpgrade(socket, 403, "Forbidden");
    }
    if (!this.options.token) return rejectUpgrade(socket, 503, "Service Unavailable");
    const provided = request.headers.authorization?.match(/^Bearer\s+(.+)$/iu)?.[1];
    if (!provided || !tokensMatch(provided, this.options.token)) {
      return rejectUpgrade(socket, 401, "Unauthorized");
    }
    this.server.handleUpgrade(request, socket, head, (webSocket) => this.accept(webSocket));
  }

  private accept(socket: WebSocket): void {
    const connection: Connection = { socket, worker: null, alive: true };
    const helloTimer = setTimeout(() => {
      if (!connection.worker) socket.close(4001, "Expected hello");
    }, HELLO_TIMEOUT_MS);
    socket.on("pong", () => {
      connection.alive = true;
      if (connection.worker) connection.worker.lastSeenAt = new Date().toISOString();
    });
    socket.on("message", (data, isBinary) => {
      if (!isBinary) this.onMessage(connection, data);
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      this.onClose(connection);
    });
    socket.on("error", () => undefined);
  }

  private onMessage(connection: Connection, data: RawData): void {
    let parsed: z.infer<typeof workerMessageSchema>;
    try {
      parsed = workerMessageSchema.parse(JSON.parse(data.toString()));
    } catch {
      return;
    }
    if (connection.worker) connection.worker.lastSeenAt = new Date().toISOString();
    if (parsed.type === "hello") {
      void this.onHello(connection, parsed);
      return;
    }
    // Everything else belongs to the current, introduced connection only.
    if (connection !== this.connection || !connection.worker) return;
    if (parsed.type === "models") {
      void this.reportModels({
        source: workerSource(connection.worker),
        codexVersion: parsed.codexVersion,
        models: parsed.models,
        error: parsed.modelsError,
      });
      return;
    }
    const pending = this.jobs.get(parsed.runId);
    if (parsed.type === "job.finished") {
      this.send(connection, { type: "job.ack", runId: parsed.runId });
      if (pending) this.finish(parsed.runId, pending, parsed);
      return;
    }
    if (!pending) return;
    if (parsed.type === "job.accepted") {
      pending.accepted = true;
      this.chain(parsed.runId, pending, () => pending.callbacks.onStarted());
    } else {
      this.chain(parsed.runId, pending, () => pending.callbacks.onEvent(parsed.event as ThreadEvent));
    }
  }

  private async onHello(connection: Connection, hello: WorkerHello): Promise<void> {
    if (hello.protocol !== WORKER_PROTOCOL_VERSION) {
      this.send(connection, {
        type: "error",
        message: `Protocol ${hello.protocol} is not supported; the dashboard speaks protocol ${WORKER_PROTOCOL_VERSION}. Update both machines to the same School Dashboard version.`,
      });
      connection.socket.close(4003, "Protocol mismatch");
      return;
    }
    const now = new Date().toISOString();
    const previous = this.connection;
    connection.worker = {
      ...hello.worker,
      connectedAt: now,
      lastSeenAt: now,
      disconnectedAt: null,
    };
    this.connection = connection;
    this.lastWorker = connection.worker;
    if (previous && previous !== connection) {
      // The laptop reconnected before the old socket timed out; its jobs move to the new one.
      this.detachAll();
      previous.socket.close(4000, "Replaced by a newer worker connection");
    }

    const onWorker = new Set([...hello.activeRunIds, ...hello.finishedRunIds]);
    for (const [runId, pending] of this.jobs) {
      if (pending.state === "queued") {
        this.clearTimer(pending);
      } else if (pending.state === "detached") {
        this.clearTimer(pending);
        if (onWorker.has(runId)) {
          pending.state = "dispatched";
        } else if (!pending.accepted) {
          pending.state = "queued";
          this.queue.unshift(runId);
        } else {
          this.fail(runId, pending, new Error("The laptop agent worker restarted before this run finished."));
        }
      }
    }
    const wanted = [...this.jobs].filter(([, pending]) => pending.state === "dispatched").map(([runId]) => runId);
    this.send(connection, { type: "welcome", protocol: WORKER_PROTOCOL_VERSION, activeRunIds: wanted });
    void this.persistState();
    void this.options.activity.record({
      category: "system",
      action: "agent-worker.connect",
      status: "completed",
      summary: `Laptop agent worker ${connection.worker.name} connected`,
      metadata: { worker: connection.worker.name, hostname: connection.worker.hostname, codexVersion: connection.worker.codexVersion },
    });
    this.pump();
    await this.reportModels({
      source: workerSource(connection.worker),
      codexVersion: hello.worker.codexVersion,
      models: hello.models,
      error: hello.modelsError,
    });
  }

  private async reportModels(report: WorkerModelsReport): Promise<void> {
    try {
      await this.options.onModels?.(report);
    } catch {
      // The model list is advisory; failing to persist it must not affect the connection.
    }
  }

  private onClose(connection: Connection): void {
    if (connection !== this.connection) return;
    this.connection = null;
    if (connection.worker) {
      const now = new Date().toISOString();
      this.lastWorker = { ...connection.worker, disconnectedAt: now };
      void this.persistState();
      void this.options.activity.record({
        category: "system",
        action: "agent-worker.disconnect",
        status: "warning",
        summary: `Laptop agent worker ${connection.worker.name} disconnected`,
        metadata: { worker: connection.worker.name },
      });
    }
    this.detachAll();
  }

  private detachAll(): void {
    for (const [runId, pending] of this.jobs) {
      if (pending.state === "dispatched") {
        pending.state = "detached";
        this.startGraceTimer(runId, "Lost contact with the laptop agent worker during this run.");
      } else if (pending.state === "queued" && !pending.timer) {
        this.startGraceTimer(runId, "The laptop agent worker went offline before this run could start.");
      }
    }
  }

  private pump(): void {
    const connection = this.connection;
    if (!connection?.worker) return;
    while (this.queue.length) {
      const inFlight = [...this.jobs.values()].filter((job) => job.state !== "queued").length;
      if (inFlight >= connection.worker.maxConcurrentJobs) return;
      const runId = this.queue.shift()!;
      const pending = this.jobs.get(runId);
      if (!pending || pending.state !== "queued") continue;
      this.clearTimer(pending);
      pending.state = "dispatched";
      this.send(connection, { type: "job.start", job: pending.job });
      this.recordProgress(pending.job, "completed", `Sending the run to ${connection.worker.name}`);
    }
  }

  private chain(runId: string, pending: PendingJob, step: () => Promise<void> | void): void {
    pending.events = pending.events.then(step).catch((error: unknown) => {
      if (this.jobs.get(runId) !== pending) return;
      if (this.connection) {
        this.send(this.connection, { type: "job.cancel", runId, reason: "The dashboard could not record this run." });
      }
      this.fail(runId, pending, error);
    });
  }

  private finish(runId: string, pending: PendingJob, message: WorkerJobFinished): void {
    // Settle only after every earlier event for this run has been recorded.
    pending.events = pending.events.then(() => {
      if (this.jobs.get(runId) !== pending) return;
      if (message.status === "completed" && message.result) {
        this.settle(runId, pending);
        pending.resolve({
          threadId: message.result.threadId,
          usage: message.result.usage as Usage | null,
          finalResponse: message.result.finalResponse,
        });
      } else {
        this.fail(runId, pending, new Error(message.error || (message.status === "cancelled"
          ? "The laptop agent worker cancelled this run."
          : "The laptop agent worker reported a failed run.")));
      }
    });
  }

  private abort(runId: string, reason: unknown): void {
    const pending = this.jobs.get(runId);
    if (!pending) return;
    if (pending.state !== "queued" && this.connection) {
      this.send(this.connection, {
        type: "job.cancel",
        runId,
        reason: reason instanceof Error ? reason.message : "Cancelled",
      });
    }
    this.fail(runId, pending, reason);
  }

  private fail(runId: string, pending: PendingJob, error: unknown): void {
    this.settle(runId, pending);
    pending.reject(error);
  }

  private settle(runId: string, pending: PendingJob): void {
    this.clearTimer(pending);
    pending.cleanup();
    this.jobs.delete(runId);
    const queued = this.queue.indexOf(runId);
    if (queued >= 0) this.queue.splice(queued, 1);
    queueMicrotask(() => this.pump());
  }

  private startGraceTimer(runId: string, message: string): void {
    const pending = this.jobs.get(runId);
    if (!pending) return;
    this.clearTimer(pending);
    pending.timer = setTimeout(() => {
      if (this.jobs.get(runId) === pending) this.fail(runId, pending, new AgentsUnavailableError(message));
    }, this.options.reconnectGraceMs ?? 120_000);
  }

  private clearTimer(pending: PendingJob): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
  }

  private checkHeartbeat(): void {
    const connection = this.connection;
    if (!connection) return;
    if (!connection.alive) {
      connection.socket.terminate();
      return;
    }
    connection.alive = false;
    connection.socket.ping();
  }

  private send(connection: Connection, message: ServerMessage): void {
    if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(JSON.stringify(message));
  }

  private recordProgress(job: WorkerJob, status: "started" | "completed", progressLabel: string): void {
    void this.options.activity.record({
      category: "agent",
      action: "agent-worker.dispatch",
      status,
      summary: job.taskTitle,
      metadata: { runId: job.runId, progressLabel },
    });
  }

  private async persistState(): Promise<void> {
    const path = this.options.statePath;
    if (!path || !this.lastWorker) return;
    try {
      await mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(this.lastWorker, null, 2)}\n`, "utf8");
      await rename(temporaryPath, path);
    } catch {
      // Worker presence is advisory; losing it only affects the offline message after a restart.
    }
  }
}

export async function packWorkspace(
  root: string,
  limit = MAX_WORKSPACE_BYTES,
): Promise<WorkerJob["workspace"]["files"]> {
  const files: WorkerJob["workspace"]["files"] = [];
  let total = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        const data = await readFile(path);
        total += data.length;
        if (total > limit) {
          throw new Error("This run's workspace is too large to send to the laptop agent worker.");
        }
        files.push({ path: relative(root, path).replaceAll("\\", "/"), data: data.toString("base64") });
      }
    }
  };
  await walk(root);
  return files;
}

function workerSource(worker: AgentWorkerSummary): string {
  return worker.name === worker.hostname ? worker.name : `${worker.name} (${worker.hostname})`;
}

function tokensMatch(provided: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
