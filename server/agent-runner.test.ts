import { describe, expect, it } from "vitest";

import { resolveAgentPreferences } from "./agent-runner.js";
import { defaultSettings } from "./settings.js";

describe("agent run preferences", () => {
  it("defaults problem extraction to Luna with xhigh reasoning", () => {
    const resolved = resolveAgentPreferences(defaultSettings, "problemExtraction");

    expect(resolved.model).toBe("gpt-5.6-luna");
    expect(resolved.reasoningEffort).toBe("xhigh");
    expect(resolved.prompt).toBe(defaultSettings.prompts.problemExtraction);
  });

  it("maps directions to assignment-navigation settings and honors an override", () => {
    const settings = structuredClone(defaultSettings);
    settings.featureModels.assignmentNavigation = "gpt-5.6-terra";

    const resolved = resolveAgentPreferences(settings, "directions", undefined, "medium");

    expect(resolved.model).toBe("gpt-5.6-terra");
    expect(resolved.reasoningEffort).toBe("medium");
    expect(resolved.prompt).toBe(settings.prompts.assignmentNavigation);
  });
});
