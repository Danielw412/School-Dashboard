import { hostname } from "node:os";

import type { ThreadEvent } from "@openai/codex-sdk";

import type { ActivityStore } from "./activity.js";
import { runCodexTurn, type CodexTurnResult } from "./codex-execution.js";
import type { CodexSignIn } from "./codex-models.js";
import type { AssignmentWorkspace } from "./workspace.js";

// The dashboard prepares everything a run needs (Canvas context, preflight, tool capability,
// workspace seed files) and hands one Codex turn to an executor: in-process on the dashboard's own
// machine ("local"), or on the laptop agent worker over its outbound WebSocket ("worker"). When
// both exist, AgentExecutionRouter sends each run to the target the student selected.

export type AgentExecutionTarget = "local" | "worker";

export type AgentExecutionRequest = {
  runId: string;
  feature: string;
  taskTitle: string;
  model: string;
  reasoningEffort: string;
  instructions: string;
  outputSchema: unknown;
  networkAccessEnabled: boolean;
  workspace: Pick<AssignmentWorkspace, "id" | "path">;
  toolToken: string | null;
  timeoutMs: number;
  // Fixed when the run starts, so switching targets never moves a run that is already underway.
  target?: AgentExecutionTarget;
};

export type AgentExecutionCallbacks = {
  signal: AbortSignal;
  // Codex is about to start the thread (for the worker: the laptop accepted the job).
  onStarted: () => Promise<void> | void;
  onEvent: (event: ThreadEvent) => Promise<void> | void;
};

export type AgentWorkerSummary = {
  id: string;
  name: string;
  hostname: string;
  platform: string;
  codexVersion: string | null;
  maxConcurrentJobs: number;
  connectedAt: string | null;
  lastSeenAt: string | null;
  disconnectedAt: string | null;
};

export type AgentExecutionTargetStatus = {
  id: AgentExecutionTarget;
  label: string;
  host: string | null;
  available: boolean;
  message: string;
  activeJobs: number;
  queuedJobs: number;
};

export type AgentExecutionStatus = {
  // The target new runs go to.
  mode: AgentExecutionTarget;
  available: boolean;
  message: string;
  worker: AgentWorkerSummary | null;
  activeJobs: number;
  queuedJobs: number;
  // Every target this dashboard can run agents on (reported by AgentExecutionRouter).
  targets?: AgentExecutionTargetStatus[];
};

export interface AgentExecutor {
  readonly mode: AgentExecutionTarget;
  status(): AgentExecutionStatus;
  run(request: AgentExecutionRequest, callbacks: AgentExecutionCallbacks): Promise<CodexTurnResult>;
}

// Where a run executes, recorded on the run for history and progress messages.
export type AgentPlacement = { target: AgentExecutionTarget; label: string; host: string | null };

export function agentPlacement(status: AgentExecutionStatus): AgentPlacement {
  const selected = status.targets?.find((target) => target.id === status.mode);
  if (selected) return { target: selected.id, label: selected.label, host: selected.host };
  return status.mode === "worker"
    ? { target: "worker", label: "Laptop", host: status.worker?.name ?? null }
    : { target: "local", label: "This computer", host: hostname() };
}

export class AgentsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentsUnavailableError";
  }
}

export type LocalCodexExecutorOptions = {
  // The dashboard's own assignment-scoped MCP endpoint (loopback).
  mcpUrl: string;
  // "server" when this dashboard also serves a laptop agent worker; "computer" when everything
  // runs on one machine.
  role?: "server" | "computer";
  maxConcurrentJobs?: number;
  activity?: ActivityStore;
  // Checks that Codex is signed in here. Without it the executor assumes it is.
  signInStatus?: () => Promise<CodexSignIn>;
  signInRecheckMs?: number;
  runTurn?: typeof runCodexTurn;
};

type Waiter = { admit: () => void };

// Runs Codex in this process with this machine's own ~/.codex, against the same MCP tools and
// workspace the laptop worker would use.
export class LocalCodexExecutor implements AgentExecutor {
  readonly mode = "local" as const;
  private active = 0;
  private readonly waiting: Waiter[] = [];
  private signIn: CodexSignIn = { ready: null, detail: "" };
  private signInCheckedAt = 0;
  private signInCheck: Promise<void> | null = null;

  constructor(private readonly options: LocalCodexExecutorOptions) {}

  get maxConcurrentJobs(): number {
    const limit = this.options.maxConcurrentJobs ?? 3;
    return Number.isFinite(limit) ? Math.min(16, Math.max(1, Math.trunc(limit))) : 3;
  }

  // Re-reads the Codex sign-in state; `status()` also refreshes it in the background when stale.
  async refreshSignIn(): Promise<CodexSignIn> {
    if (!this.options.signInStatus) return this.signIn;
    this.signInCheck ??= this.options.signInStatus()
      .then((result) => {
        this.signIn = result;
      })
      .catch(() => undefined)
      .finally(() => {
        this.signInCheckedAt = Date.now();
        this.signInCheck = null;
      });
    await this.signInCheck;
    return this.signIn;
  }

  status(): AgentExecutionStatus {
    if (Date.now() - this.signInCheckedAt > (this.options.signInRecheckMs ?? 60_000)) void this.refreshSignIn();
    const where = this.options.role === "server"
      ? `the dashboard server (${hostname()})`
      : `this machine (${hostname()})`;
    const available = this.signIn.ready !== false;
    let message = `Codex runs on ${where}.`;
    if (!available) {
      message = /not logged in/iu.test(this.signIn.detail) || !this.signIn.detail
        ? `Agents are unavailable: Codex is not signed in on ${where}. Run "codex login --device-auth" there as the dashboard's user.`
        : `Agents are unavailable on ${where}: ${this.signIn.detail}`;
    }
    return {
      mode: "local",
      available,
      message,
      worker: null,
      activeJobs: this.active,
      queuedJobs: this.waiting.length,
    };
  }

  async run(request: AgentExecutionRequest, callbacks: AgentExecutionCallbacks): Promise<CodexTurnResult> {
    await this.acquire(request, callbacks.signal);
    try {
      callbacks.signal.throwIfAborted();
      await callbacks.onStarted();
      return await (this.options.runTurn ?? runCodexTurn)({
        model: request.model,
        reasoningEffort: request.reasoningEffort,
        instructions: request.instructions,
        outputSchema: request.outputSchema,
        networkAccessEnabled: request.networkAccessEnabled,
        workingDirectory: request.workspace.path,
        mcp: request.toolToken ? { url: this.options.mcpUrl, token: request.toolToken } : null,
      }, callbacks);
    } finally {
      this.release();
    }
  }

  private acquire(request: AgentExecutionRequest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.active < this.maxConcurrentJobs) {
      this.active += 1;
      return Promise.resolve();
    }
    const where = this.options.role === "server" ? "the server" : "this computer";
    this.recordWait(request, "started", `Waiting for a free agent slot on ${where}`);
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal.reason);
      };
      const waiter: Waiter = {
        admit: () => {
          signal.removeEventListener("abort", onAbort);
          this.active += 1;
          this.recordWait(request, "completed", `Agent slot on ${where} ready`);
          resolve();
        },
      };
      this.waiting.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.admit();
  }

  private recordWait(request: AgentExecutionRequest, status: "started" | "completed", progressLabel: string): void {
    void this.options.activity?.record({
      category: "agent",
      action: "agent-slot.wait",
      status,
      summary: request.taskTitle,
      metadata: { runId: request.runId, progressLabel },
    });
  }
}
