import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import type { ThreadEvent } from "@openai/codex-sdk";
import WebSocket, { type RawData } from "ws";

import { runCodexTurn } from "./codex-execution.js";
import { safeChild } from "./safe-path.js";
import {
  type CodexModelInfo,
  type ServerMessage,
  serverMessageSchema,
  WORKER_CONNECT_PATH,
  WORKER_PROTOCOL_VERSION,
  type WorkerJob,
  type WorkerJobFinished,
  type WorkerMessage,
  workspaceIdSchema,
} from "./worker-protocol.js";

// Laptop side of the agent worker. It keeps one outbound WebSocket to the dashboard server,
// runs each job with this machine's Codex (its ~/.codex auth, sessions, and config), and streams
// compact events back. Jobs keep running across short disconnects: their messages are buffered
// and the final result is re-sent until the server acknowledges it.

const MAX_BUFFERED_EVENTS = 1_000;

type LocalJob = {
  job: WorkerJob;
  controller: AbortController;
  outbox: WorkerMessage[];
  finished: WorkerJobFinished | null;
};

export type AgentWorkerOptions = {
  serverUrl: string;
  token: string;
  name: string;
  workerId: string;
  maxConcurrentJobs: number;
  workspaceRoot: string;
  codexVersion: string | null;
  listModels: () => Promise<CodexModelInfo[]>;
  runTurn?: typeof runCodexTurn;
  log?: (message: string) => void;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  // Reconnect when the server's 15 s heartbeat pings stop arriving (sleep, network change).
  staleAfterMs?: number;
  modelRefreshMs?: number;
  workspaceRetentionHours?: number;
};

export class AgentWorkerClient {
  private socket: WebSocket | null = null;
  private ready = false;
  private stopped = false;
  private attempt = 0;
  private readonly jobs = new Map<string, LocalJob>();
  private models: CodexModelInfo[] | null = null;
  private modelsError: string | null = "Model list not read yet.";
  private reconnectTimer: NodeJS.Timeout | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private readonly runTurn: typeof runCodexTurn;
  private readonly log: (message: string) => void;

  constructor(private readonly options: AgentWorkerOptions) {
    this.runTurn = options.runTurn ?? runCodexTurn;
    this.log = options.log ?? ((message) => process.stdout.write(`[${new Date().toISOString()}] ${message}\n`));
  }

  async start(): Promise<void> {
    await this.pruneWorkspaces();
    await this.refreshModels();
    this.connect();
    this.maintenanceTimer = setInterval(() => {
      void this.refreshModels().then(() => this.sendModels());
      void this.pruneWorkspaces();
    }, this.options.modelRefreshMs ?? 30 * 60_000);
    this.maintenanceTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.staleTimer) clearTimeout(this.staleTimer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    for (const job of this.jobs.values()) job.controller.abort(new Error("The laptop agent worker stopped."));
    this.socket?.close(1001, "Worker stopping");
    this.socket = null;
  }

  connected(): boolean {
    return this.ready;
  }

  activeRunIds(): string[] {
    return [...this.jobs.values()].filter((job) => !job.finished).map((job) => job.job.runId);
  }

  private connect(): void {
    if (this.stopped) return;
    const url = new URL(WORKER_CONNECT_PATH, this.options.serverUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.options.token}` },
      handshakeTimeout: 15_000,
      maxPayload: 128 * 1024 * 1024,
    });
    this.socket = socket;
    this.ready = false;
    socket.on("open", () => {
      this.touch(socket);
      this.sendRaw(socket, {
        type: "hello",
        protocol: WORKER_PROTOCOL_VERSION,
        worker: {
          id: this.options.workerId,
          name: this.options.name,
          hostname: hostname(),
          platform: process.platform,
          codexVersion: this.options.codexVersion,
          maxConcurrentJobs: this.options.maxConcurrentJobs,
        },
        models: this.models,
        modelsError: this.modelsError,
        activeRunIds: this.activeRunIds(),
        finishedRunIds: [...this.jobs.values()].filter((job) => job.finished).map((job) => job.job.runId),
      });
    });
    socket.on("ping", () => this.touch(socket));
    socket.on("message", (data, isBinary) => {
      this.touch(socket);
      if (!isBinary) this.onMessage(socket, data);
    });
    socket.on("error", (error) => this.log(`Connection to ${this.options.serverUrl} failed: ${error.message}`));
    socket.on("close", (code, reason) => {
      if (this.socket !== socket) return;
      const wasReady = this.ready;
      this.socket = null;
      this.ready = false;
      if (this.staleTimer) clearTimeout(this.staleTimer);
      if (wasReady) this.log(`Disconnected from the dashboard server (${code}${reason.length ? ` ${reason}` : ""}).`);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const initial = this.options.reconnectInitialMs ?? 1_000;
    const maximum = this.options.reconnectMaxMs ?? 30_000;
    const base = Math.min(maximum, initial * 2 ** this.attempt);
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private touch(socket: WebSocket): void {
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      if (this.socket === socket) {
        this.log("The dashboard server stopped responding; reconnecting.");
        socket.terminate();
      }
    }, this.options.staleAfterMs ?? 45_000);
  }

  private onMessage(socket: WebSocket, data: RawData): void {
    let message: ServerMessage;
    try {
      message = serverMessageSchema.parse(JSON.parse(data.toString()));
    } catch {
      this.log("Ignored an unreadable message from the dashboard server.");
      return;
    }
    if (message.type === "welcome") {
      this.onWelcome(socket, message.activeRunIds);
    } else if (message.type === "job.start") {
      this.onJobStart(message.job);
    } else if (message.type === "job.cancel") {
      const job = this.jobs.get(message.runId);
      if (job && !job.finished) {
        this.log(`Cancelling ${job.job.feature} for "${job.job.taskTitle}": ${message.reason}`);
        job.controller.abort(new Error(message.reason));
      }
    } else if (message.type === "job.ack") {
      if (this.jobs.get(message.runId)?.finished) this.jobs.delete(message.runId);
    } else if (message.type === "refresh-models") {
      void this.refreshModels().then(() => this.sendModels());
    } else if (message.type === "error") {
      this.log(`Dashboard server: ${message.message}`);
    }
  }

  private onWelcome(socket: WebSocket, wanted: string[]): void {
    const keep = new Set(wanted);
    for (const [runId, job] of this.jobs) {
      if (keep.has(runId)) continue;
      // The server gave up on this run (or restarted); stop spending tokens on it.
      if (!job.finished) {
        this.log(`Dropping "${job.job.taskTitle}": the dashboard server no longer tracks this run.`);
        job.controller.abort(new Error("The dashboard server no longer tracks this run."));
      }
      this.jobs.delete(runId);
    }
    this.ready = true;
    this.attempt = 0;
    this.log(`Connected to ${this.options.serverUrl} as ${this.options.name}.`);
    for (const job of this.jobs.values()) {
      for (const message of job.outbox.splice(0)) this.sendRaw(socket, message);
      if (job.finished) this.sendRaw(socket, job.finished);
    }
  }

  private onJobStart(job: WorkerJob): void {
    const existing = this.jobs.get(job.runId);
    if (existing) {
      this.emit(existing, { type: "job.accepted", runId: job.runId });
      return;
    }
    const local: LocalJob = { job, controller: new AbortController(), outbox: [], finished: null };
    this.jobs.set(job.runId, local);
    if (this.activeRunIds().length > this.options.maxConcurrentJobs) {
      this.complete(local, "failed", null, "The laptop agent worker is already running its maximum number of jobs.");
      return;
    }
    this.emit(local, { type: "job.accepted", runId: job.runId });
    void this.execute(local);
  }

  private async execute(local: LocalJob): Promise<void> {
    const { job, controller } = local;
    const started = Date.now();
    this.log(`Starting ${job.feature} for "${job.taskTitle}" with ${job.model} (${job.reasoningEffort}).`);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(job.timeoutMs)]);
    try {
      const workingDirectory = await materializeWorkspace(this.options.workspaceRoot, job.workspace);
      signal.throwIfAborted();
      const result = await this.runTurn({
        model: job.model,
        reasoningEffort: job.reasoningEffort,
        instructions: job.instructions,
        outputSchema: job.outputSchema,
        networkAccessEnabled: job.networkAccessEnabled,
        workingDirectory,
        mcp: job.toolToken
          ? { url: new URL(job.mcpPath, this.options.serverUrl).toString(), token: job.toolToken }
          : null,
      }, {
        signal,
        onEvent: (event) => this.emit(local, {
          type: "job.event",
          runId: job.runId,
          event: compactThreadEventForTransport(event) as Extract<WorkerMessage, { type: "job.event" }>["event"],
        }),
      });
      this.complete(local, "completed", result, null);
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const message = cancelled
        ? controller.signal.reason instanceof Error ? controller.signal.reason.message : "Cancelled."
        : error instanceof Error ? error.message : "Codex run failed.";
      this.complete(local, cancelled ? "cancelled" : "failed", null, message);
    }
    this.log(`Finished ${job.feature} for "${job.taskTitle}" (${local.finished?.status}) in ${Math.round((Date.now() - started) / 1000)}s.`);
  }

  private complete(
    local: LocalJob,
    status: WorkerJobFinished["status"],
    result: WorkerJobFinished["result"],
    error: string | null,
  ): void {
    local.finished = { type: "job.finished", runId: local.job.runId, status, result, error: error?.slice(0, 4000) ?? null };
    // A run the server already dropped (see onWelcome) has nobody waiting for its result.
    if (this.jobs.get(local.job.runId) !== local) return;
    if (this.ready && this.socket) this.sendRaw(this.socket, local.finished);
  }

  private emit(local: LocalJob, message: WorkerMessage): void {
    if (this.jobs.get(local.job.runId) !== local) return;
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) {
      this.sendRaw(this.socket, message);
      return;
    }
    local.outbox.push(message);
    if (local.outbox.length > MAX_BUFFERED_EVENTS) {
      // Progress events are expendable; the final result is kept separately.
      const index = local.outbox.findIndex((item) => item.type === "job.event");
      if (index >= 0) local.outbox.splice(index, 1);
    }
  }

  private sendModels(): void {
    if (!this.ready || !this.socket) return;
    this.sendRaw(this.socket, {
      type: "models",
      codexVersion: this.options.codexVersion,
      models: this.models,
      modelsError: this.modelsError,
    });
  }

  private sendRaw(socket: WebSocket, message: WorkerMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  private async refreshModels(): Promise<void> {
    try {
      this.models = await this.options.listModels();
      this.modelsError = null;
    } catch (error) {
      this.modelsError = error instanceof Error ? error.message : "Could not list Codex models.";
      this.log(`Could not read the Codex model list: ${this.modelsError}`);
    }
  }

  private async pruneWorkspaces(): Promise<void> {
    const retentionMs = (this.options.workspaceRetentionHours ?? 24) * 3_600_000;
    const active = new Set([...this.jobs.values()].map((job) => job.job.workspace.id));
    try {
      for (const entry of await readdir(this.options.workspaceRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || active.has(entry.name)) continue;
        const path = join(this.options.workspaceRoot, entry.name);
        if (Date.now() - (await stat(path)).mtimeMs > retentionMs) await rm(path, { recursive: true, force: true });
      }
    } catch {
      // The workspace root does not exist until the first job.
    }
  }
}

// A local copy of the run's seed files, so Codex sees the same working directory it would on
// the server. Tool outputs are not mirrored; MCP returns them inline to Codex.
export async function materializeWorkspace(root: string, workspace: WorkerJob["workspace"]): Promise<string> {
  const directory = safeChild(root, workspaceIdSchema.parse(workspace.id));
  await Promise.all([
    mkdir(join(directory, "resources"), { recursive: true }),
    mkdir(join(directory, "renders"), { recursive: true }),
  ]);
  for (const file of workspace.files) {
    const destination = safeChild(directory, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(file.data, "base64"));
  }
  return directory;
}

// The server only needs item types, final agent text, and errors. MCP results (which carry
// base64 page images) and command output stay on the laptop.
export function compactThreadEventForTransport(event: ThreadEvent): unknown {
  if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") {
    return event;
  }
  const item = event.item;
  if (item.type === "error") return event;
  if (item.type === "agent_message" && event.type === "item.completed") return event;
  return { type: event.type, item: { id: item.id, type: item.type } };
}
