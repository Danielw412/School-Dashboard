import { describe, expect, it } from "vitest";

import {
  compactEventForLog,
  resolveAgentPreferences,
  sanitizeStoredAgentEvents,
} from "./agent-runner.js";
import { defaultSettings } from "./settings.js";

describe("agent run preferences", () => {
  it("defaults problem extraction to Luna with xhigh reasoning", () => {
    const resolved = resolveAgentPreferences(defaultSettings, "problemExtraction");

    expect(resolved.model).toBe("gpt-5.6-luna");
    expect(resolved.reasoningEffort).toBe("xhigh");
    expect(resolved.prompt).toBe(defaultSettings.prompts.problemExtraction);
  });

  it("never records private reasoning text in compact run events", () => {
    const event = {
      type: "item.completed",
      item: { id: "reasoning-1", type: "reasoning", text: "private chain-of-thought text" },
    } as never;

    const compact = compactEventForLog(event);

    expect(JSON.stringify(compact)).toContain("Reasoning about inspected evidence completed");
    expect(JSON.stringify(compact)).not.toContain("private chain-of-thought text");
    expect(JSON.stringify(sanitizeStoredAgentEvents([event]))).not.toContain("private chain-of-thought text");
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
