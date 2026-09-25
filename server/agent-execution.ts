import { hostname } from "node:os";

import type { ThreadEvent } from "@openai/codex-sdk";

import type { AgentProvider, EffortChoice } from "../src/models.js";
import type { ActivityStore } from "./activity.js";
import { runAgentTurn, type AgentTurnResult } from "./agent-turn.js";
import type { ClaudeProbe } from "./claude-execution.js";
import type { CodexSignIn } from "./codex-models.js";
import type { AssignmentWorkspace } from "./workspace.js";

// The dashboard prepares everything a run needs (Canvas context, preflight, tool capability,
// workspace seed files) and hands one agent turn (Codex or Claude) to an executor: in-process on
// the dashboard's own machine ("local"), or on the laptop agent worker over its outbound WebSocket
// ("worker"). When both exist, AgentExecutionRouter sends each run to the target the student
// selected.

export type AgentExecutionTarget = "local" | "worker";

export type AgentExecutionRequest = {
  runId: string;
  provider: AgentProvider;
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
  // The agent is about to start (for the worker: the laptop accepted the job).
  onStarted: () => Promise<void> | void;
  onEvent: (event: ThreadEvent) => Promise<void> | void;
};

export type AgentWorkerSummary = {
  id: string;
  name: string;
  hostname: string;
  platform: string;
  codexVersion: string | null;
  // What the laptop's Claude Code reported; absent from workers older than Claude support.
  claude?: ClaudeReadiness | null;
  maxConcurrentJobs: number;
  connectedAt: string | null;
  lastSeenAt: string | null;
  disconnectedAt: string | null;
};

// `ready: null` means not checked yet, or the check could not run (see `error`).
export type ClaudeReadiness = { version: string | null; ready: boolean | null; detail: string; error: string | null };

// Claude can take runs once it is signed in, and also before the first check has finished (the
// run then reports its own sign-in error).
export function claudeAvailable(claude: ClaudeReadiness | null | undefined): boolean {
  return claude?.ready === true || (claude?.ready === null && !claude.error);
}

export type AgentExecutionTargetStatus = {
  id: AgentExecutionTarget;
  label: string;
  host: string | null;
  available: boolean;
  message: string;
  activeJobs: number;
  queuedJobs: number;
};

export type AgentProviderStatus = {
  id: AgentProvider;
  label: string;
  // On the selected target.
  available: boolean;
  message: string;
};

export type AgentExecutionStatus = {
  // The target new runs go to, and the agent that runs them.
  mode: AgentExecutionTarget;
  provider: AgentProvider;
  // Whether that agent can take runs on that target.
  available: boolean;
  message: string;
  worker: AgentWorkerSummary | null;
  activeJobs: number;
  queuedJobs: number;
  // Every target this dashboard can run agents on, for the selected agent, and every agent on
  // the selected target (reported by AgentExecutionRouter).
  targets?: AgentExecutionTargetStatus[];
  providers?: AgentProviderStatus[];
  // The quick effort choice for each agent.
  effort?: Record<AgentProvider, EffortChoice>;
};

export interface AgentExecutor {
  readonly mode: AgentExecutionTarget;
  // Availability of the given agent (Codex when omitted) on this executor's machine.
  status(provider?: AgentProvider): AgentExecutionStatus;
  run(request: AgentExecutionRequest, callbacks: AgentExecutionCallbacks): Promise<AgentTurnResult>;
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

export type LocalAgentExecutorOptions = {
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
  // Checks Claude Code's sign-in here (and reports its models). Without it Claude is assumed ready.
  claudeStatus?: () => Promise<ClaudeProbe>;
  claudeRecheckMs?: number;
  runTurn?: typeof runAgentTurn;
};

type Waiter = { admit: () => void };

// Runs Codex or Claude in this process with this machine's own sign-in (~/.codex, ~/.claude),
// against the same MCP tools and workspace the laptop worker would use. Both agents share one
// concurrency limit.
export class LocalAgentExecutor implements AgentExecutor {
  readonly mode = "local" as const;
  private active = 0;
  private readonly waiting: Waiter[] = [];
  private signIn: CodexSignIn = { ready: null, detail: "" };
  private signInCheckedAt = 0;
  private signInCheck: Promise<void> | null = null;
  private claude: ClaudeReadiness = { version: null, ready: null, detail: "", error: null };
  private claudeCheckedAt = 0;
  private claudeCheck: Promise<void> | null = null;

  constructor(private readonly options: LocalAgentExecutorOptions) {}

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

  // Re-checks Claude Code here; `status("claude")` also refreshes it in the background when stale.
  // Starting Claude Code takes a moment of CPU, so this runs far less often than the Codex check.
  async refreshClaude(): Promise<ClaudeReadiness> {
    if (!this.options.claudeStatus) return this.claude;
    this.claudeCheck ??= this.options.claudeStatus()
      .then(({ version, ready, detail, error }) => {
        this.claude = { version, ready, detail, error };
      })
      .catch(() => undefined)
      .finally(() => {
        this.claudeCheckedAt = Date.now();
        this.claudeCheck = null;
      });
    await this.claudeCheck;
    return this.claude;
  }

  claudeReadiness(): ClaudeReadiness {
    return { ...this.claude };
  }

  status(provider: AgentProvider = "codex"): AgentExecutionStatus {
    const where = this.options.role === "server"
      ? `the dashboard server (${hostname()})`
      : `this machine (${hostname()})`;
    let available: boolean;
    let message: string;
    if (provider === "claude") {
      if (Date.now() - this.claudeCheckedAt > (this.options.claudeRecheckMs ?? 10 * 60_000)) void this.refreshClaude();
      available = claudeAvailable(this.claude);
      message = available
        ? `Claude runs on ${where}.`
        : this.claude.ready === false && /not signed in/iu.test(this.claude.detail)
          ? `Claude is not signed in on ${where}. Run "claude auth login" there as the dashboard's user.`
          : `Claude is unavailable on ${where}: ${this.claude.error ?? this.claude.detail}`;
    } else {
      if (Date.now() - this.signInCheckedAt > (this.options.signInRecheckMs ?? 60_000)) void this.refreshSignIn();
      available = this.signIn.ready !== false;
      message = `Codex runs on ${where}.`;
      if (!available) {
        message = /not logged in/iu.test(this.signIn.detail) || !this.signIn.detail
          ? `Codex is not signed in on ${where}. Run "codex login --device-auth" there as the dashboard's user.`
          : `Codex is unavailable on ${where}: ${this.signIn.detail}`;
      }
    }
    return {
      mode: "local",
      provider,
      available,
      message,
      worker: null,
      activeJobs: this.active,
      queuedJobs: this.waiting.length,
    };
  }

  async run(request: AgentExecutionRequest, callbacks: AgentExecutionCallbacks): Promise<AgentTurnResult> {
    await this.acquire(request, callbacks.signal);
    try {
      callbacks.signal.throwIfAborted();
      await callbacks.onStarted();
      return await (this.options.runTurn ?? runAgentTurn)({
        provider: request.provider,
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
