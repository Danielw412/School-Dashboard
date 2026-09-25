import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSettings, modelSchema, SettingsStore } from "./settings.js";
import { modelLabel } from "../src/models.js";

describe("model settings compatibility", () => {
  it("migrates retired saved preferences without losing custom settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "school-settings-"));
    const path = join(root, "settings.json");
    try {
      const legacy = {
        ...structuredClone(defaultSettings),
        defaultModel: "gpt-5.6-terra",
        featureModels: {
          problemExtraction: "gpt-5.6-luna", answerKey: "gpt-5.6-sol",
          studyGuide: "gpt-5.6-terra", assignmentNavigation: "gpt-6-sol",
        },
        prompts: { ...defaultSettings.prompts, studyGuide: "Preserve this customized study guide prompt." },
        cache: { ...defaultSettings.cache, ttlMinutes: 77 },
      };
      await writeFile(path, JSON.stringify(legacy));
      const store = new SettingsStore(path);
      const settings = await store.get();
      expect(settings.defaultModel).toBe("gpt-6-luna");
      expect(settings.featureModels).toEqual({
        problemExtraction: "gpt-6-luna", answerKey: "gpt-5.6-sol",
        studyGuide: "gpt-6-luna", assignmentNavigation: "gpt-6-sol",
      });
      expect(settings.prompts).toEqual(legacy.prompts);
      expect(settings.cache.ttlMinutes).toBe(77);
      expect(settings.connections).toEqual(legacy.connections);
      await store.save(settings);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(settings);
      await expect(store.get()).resolves.toEqual(settings);
      await expect(store.save(legacy)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a Codex-reported Luna Reserve ID and falls back per field when it disappears", async () => {
    const root = await mkdtemp(join(tmpdir(), "school-settings-"));
    const path = join(root, "settings.json");
    let reserveListed = true;
    const store = new SettingsStore(path, (model) =>
      modelSchema.safeParse(model).success || (reserveListed && model === "gpt-6-luna-reserve"));
    try {
      const saved = await store.save({
        ...structuredClone(defaultSettings),
        featureModels: { ...defaultSettings.featureModels, studyGuide: "gpt-6-luna-reserve", answerKey: "gpt-6-sol" },
        prompts: { ...defaultSettings.prompts, answerKey: "Keep this customized answer-key prompt." },
      });
      expect(saved.featureModels.studyGuide).toBe("gpt-6-luna-reserve");
      await expect(store.save({ ...saved, defaultModel: "gpt-99-imaginary" })).rejects.toThrow(/not a model Codex currently supports/u);

      reserveListed = false;
      const settings = await store.get();
      expect(settings.featureModels).toEqual({ ...defaultSettings.featureModels, answerKey: "gpt-6-sol" });
      expect(settings.prompts.answerKey).toBe("Keep this customized answer-key prompt.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts verified current IDs and rejects retired models for new runs", () => {
    for (const model of ["gpt-6-luna", "gpt-6-sol", "gpt-5.6-sol"]) expect(modelSchema.parse(model)).toBe(model);
    for (const model of ["gpt-5.6-luna", "gpt-5.6-terra", "GPT-6 Luna"]) expect(modelSchema.safeParse(model).success).toBe(false);
    expect(modelLabel("gpt-6-luna")).toBe("GPT-6 Luna");
    expect(modelLabel("gpt-6-sol")).toBe("GPT-6 Sol");
    expect(modelLabel("gpt-5.6-terra")).toBe("GPT-5.6 Terra");
    expect(modelLabel("unknown-historical-model")).toBe("unknown-historical-model");
  });

  it("labels Claude model IDs, including dated ones", () => {
    expect(modelLabel("claude-opus-5")).toBe("Claude Opus 5");
    expect(modelLabel("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(modelLabel("claude-fable-5-1")).toBe("Claude Fable 5.1");
    expect(modelLabel("claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
    expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Claude Haiku 4.5");
  });
});

describe("Claude settings", () => {
  it("adds Claude defaults to settings saved before Claude support", async () => {
    const root = await mkdtemp(join(tmpdir(), "school-settings-"));
    const path = join(root, "settings.json");
    try {
      const { claude, ...legacy } = structuredClone(defaultSettings);
      void claude;
      await writeFile(path, JSON.stringify({ ...legacy, reasoningEffort: "medium" }));
      const settings = await new SettingsStore(path).get();
      expect(settings.claude).toEqual({ model: "claude-opus-5", reasoningEffort: "high" });
      expect(settings.reasoningEffort).toBe("medium");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a model Claude Code lists and falls back when it is no longer listed", async () => {
    const root = await mkdtemp(join(tmpdir(), "school-settings-"));
    const path = join(root, "settings.json");
    let listed = ["claude-opus-5", "claude-sonnet-5"];
    const store = new SettingsStore(path, undefined, (model) => listed.includes(model));
    try {
      const saved = await store.save({ ...structuredClone(defaultSettings), claude: { model: "claude-sonnet-5", reasoningEffort: "max" } });
      expect(saved.claude).toEqual({ model: "claude-sonnet-5", reasoningEffort: "max" });
      await expect(store.save({ ...saved, claude: { model: "claude-imaginary-9", reasoningEffort: "high" } }))
        .rejects.toThrow(/not a model Claude Code currently lists/u);

      listed = ["claude-opus-5"];
      await expect(store.get()).resolves.toMatchObject({ claude: { model: "claude-opus-5", reasoningEffort: "max" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
