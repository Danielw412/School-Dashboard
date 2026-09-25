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
    expect(catalog.describe().selectable.at(-1)).toEqual({ id: "gpt-6-luna-reserve", label: "Luna Reserve", efforts: ["high"] });
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

describe("Claude model catalog", () => {
  const claudeModels = [
    { id: "claude-opus-5-5", displayName: "Opus 5.5", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "claude-sonnet-5", displayName: "Sonnet 5", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
  ];

  it("offers the default Claude model until a machine reports its list", async () => {
    const catalog = new ModelCatalog(await catalogPath());
    const described = catalog.describe().claude;
    expect(described.selectable).toEqual([
      { id: "claude-opus-5", label: "Claude Opus 5", efforts: ["low", "medium", "high", "xhigh", "max"] },
    ]);
    expect(described.detail).toMatch(/Waiting for the agent machine/u);
    expect(catalog.isClaudeSelectable("claude-opus-5")).toBe(true);
    expect(catalog.isClaudeSelectable("claude-sonnet-5")).toBe(false);
  });

  it("uses the selected machine's list, remembers it across restarts, and keeps it through a failed check", async () => {
    const path = await catalogPath();
    let target: "local" | "worker" = "local";
    const catalog = new ModelCatalog(path, { activeTarget: () => target });
    await catalog.record({ source: "latitude7370", codexVersion: "0.156.0", models: installedModels, error: null });
    await catalog.recordClaude({
      source: "latitude7370",
      version: "2.1.282",
      ready: true,
      detail: "Signed in (Claude Max)",
      models: claudeModels,
      error: null,
    });
    expect(catalog.describe().claude.selectable.map((model) => model.label)).toEqual([
      "Claude Opus 5",
      "Claude Opus 5.5",
      "Claude Sonnet 5",
    ]);
    expect(catalog.describe().claude.detail).toBe("Signed in (Claude Max); 2 models available (latitude7370, Claude Code 2.1.282).");
    expect(catalog.isClaudeSelectable("claude-sonnet-5")).toBe(true);

    // The laptop has not reported yet: the server's list stands in, and its models stay valid.
    target = "worker";
    expect(catalog.describe().claude.detection).toBeNull();
    expect(catalog.describe().claude.selectable.map((model) => model.id)).toContain("claude-sonnet-5");
    await catalog.recordClaude({ source: "DESKTOP-TQMTS8O", version: "2.1.282", ready: false, detail: "Not signed in", models: null, error: null });
    expect(catalog.describe().claude.detail).toBe("Not signed in (DESKTOP-TQMTS8O, Claude Code 2.1.282).");

    target = "local";
    await catalog.recordClaude({ source: "latitude7370", version: "2.1.282", ready: null, detail: "timed out", models: null, error: "timed out" });
    const reloaded = new ModelCatalog(path, { activeTarget: () => "local" });
    await reloaded.load();
    expect(reloaded.describe().claude.selectable.map((model) => model.id)).toContain("claude-opus-5-5");
    expect(reloaded.describe().selectable.map((model) => model.id)).toEqual(["gpt-6-luna", "gpt-6-sol", "gpt-5.6-sol"]);
  });

  it("reads catalogs saved before Claude support", async () => {
    const path = await catalogPath();
    await writeFile(path, JSON.stringify({
      version: 2,
      targets: { local: { detectedAt: "2026-09-20T00:00:00.000Z", source: "latitude7370", codexVersion: "0.156.0", models: installedModels, error: null } },
    }), "utf8");
    const catalog = new ModelCatalog(path);
    await catalog.load();
    expect(catalog.describe().detection?.source).toBe("latitude7370");
    expect(catalog.describe().claude.detection).toBeNull();
  });
});
