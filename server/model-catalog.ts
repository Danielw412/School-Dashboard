import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import type { AgentExecutionTarget } from "./agent-execution.js";
import { CODEX_MODELS_PATH } from "./env.js";
import { codexModelInfoSchema, type CodexModelInfo } from "./worker-protocol.js";
import { findLunaReserveModel, LUNA_RESERVE_LABEL, modelLabel, modelNames } from "../src/models.js";

// The model list each machine that can run Codex (the dashboard itself and the laptop worker)
// reported most recently. The selected agent target's list decides which models are selectable.
// Lists are persisted so model choices stay stable while the laptop is offline or the server
// restarts.
const snapshotSchema = z.object({
  detectedAt: z.string(),
  source: z.string(),
  codexVersion: z.string().nullable(),
  models: z.array(codexModelInfoSchema).nullable(),
  error: z.string().nullable(),
});
export type ModelCatalogSnapshot = z.infer<typeof snapshotSchema>;

const storedCatalogSchema = z.object({
  version: z.literal(2),
  targets: z.object({ local: snapshotSchema.optional(), worker: snapshotSchema.optional() }),
});

export type AgentModelsResponse = {
  selectable: Array<{ id: string; label: string }>;
  detection: ModelCatalogSnapshot | null;
  lunaReserve: { supported: boolean; modelId: string | null; detail: string };
};

export type ModelCatalogOptions = {
  // The agent target new runs use; its model list is the one that counts.
  activeTarget?: () => AgentExecutionTarget;
  // Which target a pre-v2 single-snapshot file described.
  legacyTarget?: AgentExecutionTarget;
};

export class ModelCatalog {
  private snapshots: Partial<Record<AgentExecutionTarget, ModelCatalogSnapshot>> = {};
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
    } catch {
      this.snapshots = {};
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
    const operation = this.writeChain.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify({ version: 2, targets: this.snapshots }, null, 2)}\n`, "utf8");
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
    return {
      selectable: [
        ...modelNames.map((id) => ({ id, label: modelLabel(id) })),
        ...(lunaReserve ? [{ id: lunaReserve, label: LUNA_RESERVE_LABEL }] : []),
      ],
      detection: snapshot,
      lunaReserve: { supported: Boolean(lunaReserve), modelId: lunaReserve, detail },
    };
  }

  private activeTarget(): AgentExecutionTarget {
    return this.options.activeTarget?.() ?? "local";
  }

  private snapshot(): ModelCatalogSnapshot | null {
    return this.snapshots[this.activeTarget()] ?? null;
  }
}
