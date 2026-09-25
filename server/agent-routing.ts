import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

import { z } from "zod";

import {
  type AgentProvider,
  agentProviders,
  type EffortChoice,
  effortLevels,
  providerLabel,
} from "../src/models.js";
import {
  type AgentExecutionCallbacks,
  type AgentExecutionRequest,
  type AgentExecutionStatus,
  type AgentExecutionTarget,
  type AgentExecutionTargetStatus,
  type AgentExecutor,
  AgentsUnavailableError,
} from "./agent-execution.js";
import type { AgentTurnResult } from "./agent-turn.js";

// Chooses where new agent runs execute and which agent runs them. On the server + laptop
// deployment both the dashboard server ("local") and the laptop agent worker ("worker") can run
// Codex or Claude; the student's choices, including a quick effort level per agent, are persisted
// so they survive restarts. A single-machine dashboard only has "local".

export const agentTargetSchema = z.enum(["local", "worker"]);
export const agentProviderSchema = z.enum(agentProviders);
export const effortChoiceSchema = z.enum(["default", ...effortLevels]);

const defaultEffort: Record<AgentProvider, EffortChoice> = { codex: "default", claude: "default" };

const savedSelectionSchema = z.object({
  target: agentTargetSchema,
  provider: agentProviderSchema.catch("codex").default("codex"),
  effort: z.object({
    codex: effortChoiceSchema.catch("default").default("default"),
    claude: effortChoiceSchema.catch("default").default("default"),
  }).catch(defaultEffort).default(defaultEffort),
});

export type AgentSelectionChange = {
  target?: AgentExecutionTarget;
  provider?: AgentProvider;
  // Applies to `provider`, or to the selected agent when no provider is given.
  effort?: EffortChoice;
};

export const agentSelectionChangeSchema = z.object({
  target: agentTargetSchema.optional(),
  provider: agentProviderSchema.optional(),
  effort: effortChoiceSchema.optional(),
}).refine((change) => change.target || change.provider || change.effort, "Choose a target, an agent, or an effort level.");

export class UnknownAgentTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownAgentTargetError";
  }
}

export class AgentSelectionStore {
  private selected: AgentExecutionTarget;
  private selectedProvider: AgentProvider = "codex";
  private effort: Record<AgentProvider, EffortChoice> = { ...defaultEffort };
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
      const saved = savedSelectionSchema.parse(JSON.parse(await readFile(this.options.path, "utf8")));
      this.selected = this.options.targets.includes(saved.target) ? saved.target : this.options.fallback;
      this.selectedProvider = saved.provider;
      this.effort = { ...saved.effort };
    } catch {
      this.selected = this.options.fallback;
    }
  }

  current(): AgentExecutionTarget {
    return this.selected;
  }

  provider(): AgentProvider {
    return this.selectedProvider;
  }

  efforts(): Record<AgentProvider, EffortChoice> {
    return { ...this.effort };
  }

  async update(change: AgentSelectionChange): Promise<void> {
    if (change.target && !this.options.targets.includes(change.target)) {
      throw new UnknownAgentTargetError(`Agents cannot be set to run on "${change.target}" in this deployment.`);
    }
    const operation = this.writeChain.catch(() => undefined).then(async () => {
      const target = change.target ?? this.selected;
      const provider = change.provider ?? this.selectedProvider;
      const effort = change.effort ? { ...this.effort, [provider]: change.effort } : this.effort;
      await mkdir(dirname(this.options.path), { recursive: true });
      const temporaryPath = `${this.options.path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(
        temporaryPath,
        `${JSON.stringify({ target, provider, effort, updatedAt: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
      );
      await rename(temporaryPath, this.options.path);
      this.selected = target;
      this.selectedProvider = provider;
      this.effort = effort;
    });
    this.writeChain = operation;
    await operation;
  }
}

export class AgentExecutionRouter implements AgentExecutor {
  constructor(
    private readonly store: AgentSelectionStore,
    private readonly executors: { local: AgentExecutor; worker: AgentExecutor | null },
  ) {}

  get mode(): AgentExecutionTarget {
    return this.store.current();
  }

  get provider(): AgentProvider {
    return this.store.provider();
  }

  effort(provider: AgentProvider = this.provider): EffortChoice {
    return this.store.efforts()[provider];
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
    const provider = this.provider;
    const targets = this.targets.map((id) => this.targetStatus(id, provider));
    const selectedId = targets.some((target) => target.id === this.mode) ? this.mode : targets[0]!.id;
    const executor = this.executorFor(selectedId)!;
    const selected = executor.status(provider);
    return {
      ...selected,
      mode: selectedId,
      provider,
      // The laptop's details stay visible (diagnostics, offline banner) whichever target is selected.
      worker: this.executors.worker?.status().worker ?? null,
      activeJobs: targets.reduce((total, target) => total + target.activeJobs, 0),
      queuedJobs: targets.reduce((total, target) => total + target.queuedJobs, 0),
      targets,
      providers: agentProviders.map((id) => {
        const status = id === provider ? selected : executor.status(id);
        return { id, label: providerLabel(id), available: status.available, message: status.message };
      }),
      effort: this.store.efforts(),
    };
  }

  async select(change: AgentSelectionChange): Promise<AgentExecutionStatus> {
    if (change.target && !this.targets.includes(change.target)) {
      throw new UnknownAgentTargetError(change.target === "worker"
        ? "This dashboard has no laptop agent worker. Set SCHOOL_DASHBOARD_AGENT_EXECUTION=worker on the server to add one."
        : "This dashboard cannot run agents on its own machine.");
    }
    await this.store.update(change);
    return this.status();
  }

  run(request: AgentExecutionRequest, callbacks: AgentExecutionCallbacks): Promise<AgentTurnResult> {
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

  private targetStatus(id: AgentExecutionTarget, provider: AgentProvider): AgentExecutionTargetStatus {
    const status = this.executorFor(id)!.status(provider);
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
