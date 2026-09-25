import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import type { AgentExecutionTarget } from "./agent-execution.js";
import { CODEX_MODELS_PATH } from "./env.js";
import {
  claudeModelInfoSchema,
  type ClaudeReport,
  codexModelInfoSchema,
  type CodexModelInfo,
} from "./worker-protocol.js";
import {
  DEFAULT_CLAUDE_MODEL,
  effortLevels,
  findLunaReserveModel,
  LUNA_RESERVE_LABEL,
  modelLabel,
  modelNames,
} from "../src/models.js";

// The Codex and Claude model lists each machine that can run agents (the dashboard itself and
// the laptop worker) reported most recently. The selected agent target's lists decide which models
// are selectable. Lists are persisted so model choices stay stable while the laptop is offline or
// the server restarts.
const snapshotSchema = z.object({
  detectedAt: z.string(),
  source: z.string(),
  codexVersion: z.string().nullable(),
  models: z.array(codexModelInfoSchema).nullable(),
  error: z.string().nullable(),
});
export type ModelCatalogSnapshot = z.infer<typeof snapshotSchema>;

const claudeSnapshotSchema = z.object({
  detectedAt: z.string(),
  source: z.string(),
  version: z.string().nullable(),
  ready: z.boolean().nullable(),
  detail: z.string(),
  models: z.array(claudeModelInfoSchema).nullable(),
  error: z.string().nullable(),
});
export type ClaudeCatalogSnapshot = z.infer<typeof claudeSnapshotSchema>;

const targetSnapshotsSchema = <T extends z.ZodType>(schema: T) =>
  z.object({ local: schema.optional(), worker: schema.optional() });

const storedCatalogSchema = z.object({
  version: z.union([z.literal(2), z.literal(3)]),
  targets: targetSnapshotsSchema(snapshotSchema),
  // Added in version 3.
  claude: targetSnapshotsSchema(claudeSnapshotSchema).default({}),
});

export type SelectableModel = { id: string; label: string; efforts: string[] };

export type AgentModelsResponse = {
  selectable: SelectableModel[];
  detection: ModelCatalogSnapshot | null;
  lunaReserve: { supported: boolean; modelId: string | null; detail: string };
  claude: { selectable: SelectableModel[]; detection: ClaudeCatalogSnapshot | null; detail: string };
};

export type ModelCatalogOptions = {
  // The agent target new runs use; its model list is the one that counts.
  activeTarget?: () => AgentExecutionTarget;
  // Which target a pre-v2 single-snapshot file described.
  legacyTarget?: AgentExecutionTarget;
};

export class ModelCatalog {
  private snapshots: Partial<Record<AgentExecutionTarget, ModelCatalogSnapshot>> = {};
  private claudeSnapshots: Partial<Record<AgentExecutionTarget, ClaudeCatalogSnapshot>> = {};
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly path = CODEX_MODELS_PATH,
    private readonly options: ModelCatalogOptions = {},
  ) {}

  async load(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.path, "utf8"));
      const stored = storedCatalogSchema.safeParse(raw);
      this.snapshots = stored.success
        ? { ...stored.data.targets }
        : { [this.options.legacyTarget ?? "local"]: snapshotSchema.parse(raw) };
      this.claudeSnapshots = stored.success ? { ...stored.data.claude } : {};
    } catch {
      this.snapshots = {};
      this.claudeSnapshots = {};
    }
  }

  async record(input: {
    source: string;
    codexVersion: string | null;
    models: CodexModelInfo[] | null;
    error: string | null;
    target?: AgentExecutionTarget;
  }): Promise<void> {
    const { target = this.activeTarget(), ...report } = input;
    // A failed probe keeps the last successful model list rather than hiding detected models.
    const models = report.models ?? this.snapshots[target]?.models ?? null;
    this.snapshots[target] = { detectedAt: new Date().toISOString(), ...report, models };
    await this.persist();
  }

  async recordClaude(input: ClaudeReport & { source: string; target?: AgentExecutionTarget }): Promise<void> {
    const { target = this.activeTarget(), ...report } = input;
    // As for Codex, a failed check keeps the last model list.
    const models = report.models ?? this.claudeSnapshots[target]?.models ?? null;
    this.claudeSnapshots[target] = { detectedAt: new Date().toISOString(), ...report, models };
    await this.persist();
  }

  private async persist(): Promise<void> {
    const operation = this.writeChain.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      const stored = { version: 3, targets: this.snapshots, claude: this.claudeSnapshots };
      await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.path);
    });
    this.writeChain = operation;
    await operation;
  }

  hasReport(target: AgentExecutionTarget): boolean {
    return Boolean(this.snapshots[target]);
  }

  lunaReserveModelId(): string | null {
    return findLunaReserveModel(this.snapshot()?.models ?? []);
  }

  isSelectable = (model: string): boolean =>
    (modelNames as readonly string[]).includes(model) || model === this.lunaReserveModelId();

  // Any model a machine's Claude Code listed stays valid, so a Claude choice made while one
  // machine is selected survives switching to the other before it has reported.
  isClaudeSelectable = (model: string): boolean =>
    model === DEFAULT_CLAUDE_MODEL ||
    Object.values(this.claudeSnapshots).some((snapshot) => snapshot?.models?.some((item) => item.id === model));

  describe(): AgentModelsResponse {
    const lunaReserve = this.lunaReserveModelId();
    const snapshot = this.snapshot();
    const checked = snapshot
      ? `${snapshot.source}${snapshot.codexVersion ? `, Codex ${snapshot.codexVersion}` : ""}`
      : null;
    let detail: string;
    if (lunaReserve) {
      detail = `Codex lists Luna Reserve as ${lunaReserve} (${checked}).`;
    } else if (!snapshot?.models) {
      detail = snapshot?.error
        ? `Could not read the Codex model list (${checked}): ${snapshot.error}`
        : "Waiting for the agent machine to report its Codex model list.";
    } else {
      detail = `Not available: the installed Codex (${checked}) does not list a Luna Reserve model among ${snapshot.models.length} models, including hidden ones.`;
    }
    const codexEfforts = (id: string) => snapshot?.models?.find((model) => model.id === id)?.reasoningEfforts ?? [...effortLevels];
    return {
      selectable: [
        ...modelNames.map((id) => ({ id, label: modelLabel(id), efforts: codexEfforts(id) })),
        ...(lunaReserve ? [{ id: lunaReserve, label: LUNA_RESERVE_LABEL, efforts: codexEfforts(lunaReserve) }] : []),
      ],
      detection: snapshot,
      lunaReserve: { supported: Boolean(lunaReserve), modelId: lunaReserve, detail },
      claude: this.describeClaude(),
    };
  }

  private describeClaude(): AgentModelsResponse["claude"] {
    const snapshot = this.claudeSnapshots[this.activeTarget()] ?? null;
    // Before the selected machine reports, show what the other one listed.
    const listed = snapshot?.models
      ?? Object.values(this.claudeSnapshots).find((item) => item?.models)?.models
      ?? [];
    const selectable = listed.map((model) => ({ id: model.id, label: modelLabel(model.id), efforts: model.reasoningEfforts }));
    if (!selectable.some((model) => model.id === DEFAULT_CLAUDE_MODEL)) {
      selectable.unshift({ id: DEFAULT_CLAUDE_MODEL, label: modelLabel(DEFAULT_CLAUDE_MODEL), efforts: [...effortLevels] });
    }
    const checked = snapshot ? `${snapshot.source}${snapshot.version ? `, Claude Code ${snapshot.version}` : ""}` : null;
    let detail: string;
    if (!snapshot) {
      detail = "Waiting for the agent machine to report its Claude Code sign-in and models.";
    } else if (snapshot.ready === false) {
      detail = `${snapshot.detail} (${checked}).`;
    } else if (!snapshot.models) {
      detail = `Could not read the Claude model list (${checked}): ${snapshot.error ?? snapshot.detail}`;
    } else {
      detail = `${snapshot.detail}; ${snapshot.models.length} models available (${checked}).`;
    }
    return { selectable, detection: snapshot, detail };
  }

  private activeTarget(): AgentExecutionTarget {
    return this.options.activeTarget?.() ?? "local";
  }

  private snapshot(): ModelCatalogSnapshot | null {
    return this.snapshots[this.activeTarget()] ?? null;
  }
}
