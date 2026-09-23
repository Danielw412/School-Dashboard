import { hostname } from "node:os";

import type { ThreadEvent } from "@openai/codex-sdk";

import { runCodexTurn, type CodexTurnResult } from "./codex-execution.js";
import type { AssignmentWorkspace } from "./workspace.js";

// The dashboard prepares everything a run needs (Canvas context, preflight, tool capability,
// workspace seed files) and hands one Codex turn to an executor: in-process on this machine, or
// on the laptop agent worker over its outbound WebSocket.

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

export type AgentExecutionStatus = {
  mode: "local" | "worker";
  available: boolean;
  message: string;
  worker: AgentWorkerSummary | null;
  activeJobs: number;
  queuedJobs: number;
};

export interface AgentExecutor {
  readonly mode: "local" | "worker";
  status(): AgentExecutionStatus;
  run(request: AgentExecutionRequest, callbacks: AgentExecutionCallbacks): Promise<CodexTurnResult>;
}

export class AgentsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentsUnavailableError";
  }
}

export class LocalCodexExecutor implements AgentExecutor {
  readonly mode = "local" as const;
  private active = 0;

  constructor(private readonly mcpUrl: string) {}

  status(): AgentExecutionStatus {
    return {
      mode: "local",
      available: true,
      message: `Codex runs on this machine (${hostname()}).`,
      worker: null,
      activeJobs: this.active,
      queuedJobs: 0,
    };
  }

  async run(request: AgentExecutionRequest, callbacks: AgentExecutionCallbacks): Promise<CodexTurnResult> {
    this.active += 1;
    try {
      await callbacks.onStarted();
      return await runCodexTurn({
        model: request.model,
        reasoningEffort: request.reasoningEffort,
        instructions: request.instructions,
        outputSchema: request.outputSchema,
        networkAccessEnabled: request.networkAccessEnabled,
        workingDirectory: request.workspace.path,
        mcp: request.toolToken ? { url: this.mcpUrl, token: request.toolToken } : null,
      }, callbacks);
    } finally {
      this.active -= 1;
    }
  }
}
