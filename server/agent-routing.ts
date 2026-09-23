import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

import { z } from "zod";

import {
  type AgentExecutionCallbacks,
  type AgentExecutionRequest,
  type AgentExecutionStatus,
  type AgentExecutionTarget,
  type AgentExecutionTargetStatus,
  type AgentExecutor,
  AgentsUnavailableError,
} from "./agent-execution.js";
import type { CodexTurnResult } from "./codex-execution.js";

// Chooses where new agent runs execute. On the server + laptop deployment both the dashboard
// server ("local") and the laptop agent worker ("worker") can run Codex; the student's choice is
// persisted so it survives restarts. A single-machine dashboard only has "local".

export const agentTargetSchema = z.enum(["local", "worker"]);

const savedTargetSchema = z.object({ target: agentTargetSchema });

export class UnknownAgentTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownAgentTargetError";
  }
}

export class AgentTargetStore {
  private selected: AgentExecutionTarget;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    path: string;
    targets: readonly AgentExecutionTarget[];
    // Used until the student picks a target (and when a saved one is no longer configured).
    fallback: AgentExecutionTarget;
  }) {
    this.selected = options.fallback;
  }

  get targets(): readonly AgentExecutionTarget[] {
    return this.options.targets;
  }

  async load(): Promise<void> {
    try {
      const saved = savedTargetSchema.parse(JSON.parse(await readFile(this.options.path, "utf8")));
      this.selected = this.options.targets.includes(saved.target) ? saved.target : this.options.fallback;
    } catch {
      this.selected = this.options.fallback;
    }
  }

  current(): AgentExecutionTarget {
    return this.selected;
  }

  async set(target: AgentExecutionTarget): Promise<void> {
    if (!this.options.targets.includes(target)) {
      throw new UnknownAgentTargetError(`Agents cannot be set to run on "${target}" in this deployment.`);
    }
    const operation = this.writeChain.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.options.path), { recursive: true });
      const temporaryPath = `${this.options.path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify({ target, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.options.path);
      this.selected = target;
    });
    this.writeChain = operation;
    await operation;
  }
}

export class AgentExecutionRouter implements AgentExecutor {
  constructor(
    private readonly store: AgentTargetStore,
    private readonly executors: { local: AgentExecutor; worker: AgentExecutor | null },
  ) {}

  get mode(): AgentExecutionTarget {
    return this.store.current();
  }

  get targets(): readonly AgentExecutionTarget[] {
    return this.store.targets.filter((target) => this.executorFor(target));
  }

  // The label the dashboard shows for a target ("Server" / "Laptop", or "This computer").
  label(target: AgentExecutionTarget): string {
    if (target === "worker") return "Laptop";
    return this.executors.worker ? "Server" : "This computer";
  }

  status(): AgentExecutionStatus {
    const targets = this.targets.map((id) => this.targetStatus(id));
    const selectedId = targets.some((target) => target.id === this.mode) ? this.mode : targets[0]!.id;
    const selected = this.executorFor(selectedId)!.status();
    return {
      ...selected,
      mode: selectedId,
      // The laptop's details stay visible (diagnostics, offline banner) whichever target is selected.
      worker: this.executors.worker?.status().worker ?? null,
      activeJobs: targets.reduce((total, target) => total + target.activeJobs, 0),
      queuedJobs: targets.reduce((total, target) => total + target.queuedJobs, 0),
      targets,
    };
  }

  async select(target: AgentExecutionTarget): Promise<AgentExecutionStatus> {
    if (!this.targets.includes(target)) {
      throw new UnknownAgentTargetError(target === "worker"
        ? "This dashboard has no laptop agent worker. Set SCHOOL_DASHBOARD_AGENT_EXECUTION=worker on the server to add one."
        : "This dashboard cannot run agents on its own machine.");
    }
    await this.store.set(target);
    return this.status();
  }

  run(request: AgentExecutionRequest, callbacks: AgentExecutionCallbacks): Promise<CodexTurnResult> {
    const target = request.target ?? this.mode;
    const executor = this.executorFor(target);
    if (!executor) {
      return Promise.reject(new AgentsUnavailableError(`Agents cannot run on the ${this.label(target).toLowerCase()} in this deployment.`));
    }
    return executor.run(request, callbacks);
  }

  private executorFor(target: AgentExecutionTarget): AgentExecutor | null {
    return target === "worker" ? this.executors.worker : this.executors.local;
  }

  private targetStatus(id: AgentExecutionTarget): AgentExecutionTargetStatus {
    const status = this.executorFor(id)!.status();
    return {
      id,
      label: this.label(id),
      host: id === "worker" ? status.worker?.name ?? null : hostname(),
      available: status.available,
      message: status.message,
      activeJobs: status.activeJobs,
      queuedJobs: status.queuedJobs,
    };
  }
}
