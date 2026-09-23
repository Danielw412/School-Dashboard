import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { normalizeRpcModels } from "./codex-models.js";
import { ModelCatalog } from "./model-catalog.js";
import { findLunaReserveModel, modelLabel } from "../src/models.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function catalogPath() {
  const root = await mkdtemp(join(tmpdir(), "school-models-"));
  roots.push(root);
  return join(root, "codex-models.json");
}

// The shape Codex 0.156.0's app-server returns from model/list (trimmed).
const installedModels = normalizeRpcModels([
  { id: "gpt-6-astra", model: "gpt-6-astra", displayName: "GPT-6-Astra", hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low" },
  { id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT-6-Luna", hidden: false, isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "xhigh" }], defaultReasoningEffort: "medium" },
  { id: "gpt-reserve", model: "gpt-reserve", displayName: "GPT-Reserve", hidden: true, isDefault: false, supportedReasoningEfforts: [], defaultReasoningEffort: "medium" },
]);

describe("Codex model catalog", () => {
  it("normalizes app-server model/list records", () => {
    expect(installedModels[1]).toEqual({
      id: "gpt-6-luna",
      displayName: "GPT-6-Luna",
      hidden: false,
      isDefault: false,
      reasoningEfforts: ["medium", "xhigh"],
      defaultReasoningEffort: "medium",
    });
    expect(() => normalizeRpcModels({})).toThrow();
  });

  it("does not treat an unrelated reserve model as Luna Reserve", async () => {
    const catalog = new ModelCatalog(await catalogPath());
    await catalog.record({ source: "DESKTOP-TQMTS8O", codexVersion: "0.156.0", models: installedModels, error: null });

    expect(findLunaReserveModel(installedModels)).toBeNull();
    expect(catalog.isSelectable("gpt-reserve")).toBe(false);
    const described = catalog.describe();
    expect(described.lunaReserve.supported).toBe(false);
    expect(described.lunaReserve.detail).toMatch(/does not list a Luna Reserve model among 3 models/u);
    expect(described.selectable.map((model) => model.id)).toEqual(["gpt-6-luna", "gpt-6-sol", "gpt-5.6-sol"]);
  });

  it("makes a detected Luna Reserve selectable under the exact ID Codex reports, and remembers it", async () => {
    const path = await catalogPath();
    const catalog = new ModelCatalog(path);
    const withReserve = [
      ...installedModels,
      { id: "gpt-6-luna-reserve", displayName: "GPT-6-Luna-Reserve", hidden: false, isDefault: false, reasoningEfforts: ["high"], defaultReasoningEffort: "high" },
    ];
    await catalog.record({ source: "DESKTOP-TQMTS8O", codexVersion: "0.157.0", models: withReserve, error: null });

    expect(catalog.isSelectable("gpt-6-luna-reserve")).toBe(true);
    expect(catalog.describe().selectable.at(-1)).toEqual({ id: "gpt-6-luna-reserve", label: "Luna Reserve" });
    expect(modelLabel("gpt-6-luna-reserve")).toBe("GPT-6 Luna Reserve");

    // A failed later probe keeps the last known list instead of withdrawing the model.
    await catalog.record({ source: "DESKTOP-TQMTS8O", codexVersion: "0.157.0", models: null, error: "app-server timed out" });
    const reloaded = new ModelCatalog(path);
    await reloaded.load();
    expect(reloaded.isSelectable("gpt-6-luna-reserve")).toBe(true);
    expect(findLunaReserveModel([{ id: "luna_reserve", displayName: "x" }])).toBe("luna_reserve");
    expect(findLunaReserveModel([{ id: "gpt-7-x", displayName: "Luna Reserve" }])).toBe("gpt-7-x");
  });

  it("follows the model list of the machine new runs are sent to", async () => {
    const path = await catalogPath();
    let target: "local" | "worker" = "worker";
    const catalog = new ModelCatalog(path, { activeTarget: () => target });
    const withReserve = [
      ...installedModels,
      { id: "gpt-6-luna-reserve", displayName: "GPT-6-Luna-Reserve", hidden: false, isDefault: false, reasoningEfforts: ["high"], defaultReasoningEffort: "high" },
    ];
    await catalog.record({ source: "DESKTOP-TQMTS8O", codexVersion: "0.156.0", models: withReserve, error: null, target: "worker" });
    await catalog.record({ source: "latitude7370", codexVersion: "0.156.0", models: installedModels, error: null, target: "local" });

    expect(catalog.isSelectable("gpt-6-luna-reserve")).toBe(true);
    expect(catalog.describe().detection?.source).toBe("DESKTOP-TQMTS8O");
    target = "local";
    expect(catalog.isSelectable("gpt-6-luna-reserve")).toBe(false);
    expect(catalog.describe().detection?.source).toBe("latitude7370");

    const reloaded = new ModelCatalog(path, { activeTarget: () => "worker" });
    await reloaded.load();
    expect(reloaded.hasReport("local")).toBe(true);
    expect(reloaded.isSelectable("gpt-6-luna-reserve")).toBe(true);
  });

  it("reads a pre-switch single-machine model list as the target that reported it", async () => {
    const path = await catalogPath();
    await writeFile(path, JSON.stringify({
      detectedAt: "2026-09-23T20:09:37.606Z",
      source: "DESKTOP-TQMTS8O",
      codexVersion: "0.156.0",
      models: installedModels,
      error: null,
    }), "utf8");
    const catalog = new ModelCatalog(path, { activeTarget: () => "local", legacyTarget: "worker" });
    await catalog.load();
    expect(catalog.hasReport("worker")).toBe(true);
    expect(catalog.hasReport("local")).toBe(false);
    expect(catalog.describe().lunaReserve.detail).toBe("Waiting for the agent machine to report its Codex model list.");
  });

  it("explains when no model list has been reported yet", async () => {
    const catalog = new ModelCatalog(await catalogPath());
    await catalog.load();
    expect(catalog.describe().lunaReserve).toEqual({
      supported: false,
      modelId: null,
      detail: "Waiting for the agent machine to report its Codex model list.",
    });
  });
});
