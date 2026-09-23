import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { CODEX_MODELS_PATH } from "./env.js";
import { codexModelInfoSchema, type CodexModelInfo } from "./worker-protocol.js";
import { findLunaReserveModel, LUNA_RESERVE_LABEL, modelLabel, modelNames } from "../src/models.js";

// The model list the machine that runs Codex reported most recently. It is persisted so model
// choices stay stable while the laptop is offline or the server restarts.
const snapshotSchema = z.object({
  detectedAt: z.string(),
  source: z.string(),
  codexVersion: z.string().nullable(),
  models: z.array(codexModelInfoSchema).nullable(),
  error: z.string().nullable(),
});
export type ModelCatalogSnapshot = z.infer<typeof snapshotSchema>;

export type AgentModelsResponse = {
  selectable: Array<{ id: string; label: string }>;
  detection: ModelCatalogSnapshot | null;
  lunaReserve: { supported: boolean; modelId: string | null; detail: string };
};

export class ModelCatalog {
  private snapshot: ModelCatalogSnapshot | null = null;

  constructor(private readonly path = CODEX_MODELS_PATH) {}

  async load(): Promise<void> {
    try {
      this.snapshot = snapshotSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch {
      this.snapshot = null;
    }
  }

  async record(input: {
    source: string;
    codexVersion: string | null;
    models: CodexModelInfo[] | null;
    error: string | null;
  }): Promise<void> {
    // A failed probe keeps the last successful model list rather than hiding detected models.
    const models = input.models ?? this.snapshot?.models ?? null;
    this.snapshot = { detectedAt: new Date().toISOString(), ...input, models };
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.snapshot, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.path);
  }

  lunaReserveModelId(): string | null {
    return findLunaReserveModel(this.snapshot?.models ?? []);
  }

  isSelectable = (model: string): boolean =>
    (modelNames as readonly string[]).includes(model) || model === this.lunaReserveModelId();

  describe(): AgentModelsResponse {
    const lunaReserve = this.lunaReserveModelId();
    const snapshot = this.snapshot;
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
}
