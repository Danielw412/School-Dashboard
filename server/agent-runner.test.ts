import { describe, expect, it } from "vitest";

import {
  buildInstructions,
  buildMcpConfigOverrides,
  compactEventForLog,
  enforceProblemVisualPolicy,
  problemRequiresVisual,
  resolveAgentPreferences,
  sanitizeStoredAgentEvents,
  stripLegacyAnswerMetadata,
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

  it("constrains directions to authoritative preloaded evidence and minimal tools", () => {
    const instructions = buildInstructions("directions", defaultSettings.prompts.assignmentNavigation, null);

    expect(instructions).toContain("preloaded data");
    expect(instructions).toContain("Call get_preloaded_context exactly once first");
    expect(instructions).toContain("preflight.directionsEvidenceSufficient");
    expect(instructions).toContain("sourceContext.contextMarkdown");
    expect(instructions).toContain("recover_canvas_context once");
    expect(instructions).toContain("read_linked_resource_with_chrome once");
    expect(instructions).toContain("prefer those direct links over any course search");
    expect(instructions).toContain("do not open unrelated links");
    expect(instructions).toContain("Do not repeat a failed URL");
    expect(instructions).toContain("never invoke Canvas through PowerShell");
    expect(instructions).not.toContain("revision instructions");
    expect(instructions).not.toContain("pdf-inspect");
  });

  it("connects Luna to only the short-lived structured MCP server", () => {
    const overrides = buildMcpConfigOverrides(true, 8780, ["personal_server"]);
    const override = overrides.join("\n");

    expect(override).toContain("school_dashboard");
    expect(override).toContain("http://127.0.0.1:8780/api/internal/canvas-mcp");
    expect(override).toContain('bearer_token_env_var="SCHOOL_DASHBOARD_TOOL_TOKEN"');
    expect(override).not.toContain("canvas-tool.mjs");
    expect(overrides).toContain("mcp_servers.personal_server.enabled=false");
    expect(overrides).toContain("mcp_servers.node_repl.enabled=false");
    expect(buildMcpConfigOverrides(false, 8780)).not.toContain("mcp_servers={}");
    expect(buildMcpConfigOverrides(false, 8780).every((value) => value.endsWith(".enabled=false"))).toBe(true);
  });

  it("directs problem extraction through bounded text-first lookup and visual-only crops", () => {
    const instructions = buildInstructions("problemExtraction", defaultSettings.prompts.problemExtraction, null);

    expect(instructions).toContain("call index_pdf once");
    expect(instructions).toContain("cached text and detected problem sections first");
    expect(instructions).toContain("Never OCR broad page ranges");
    expect(instructions).toContain("Set visual to null by default");
    expect(instructions).toContain("if and only if the problem requires");
    expect(instructions).toContain("call semantic_crop_pdf once");
    expect(instructions).toContain("Render one targeted page only when needed");
    expect(instructions).toContain("Do not crop or attach text-only problems");
    expect(instructions).toContain("Stop as soon as every requested problem is verified");
  });

  it("removes page crops from text-only problems while retaining required figures", () => {
    expect(problemRequiresVisual("Calculate $A \\cdot B$ from the listed components.")).toBe(false);
    expect(problemRequiresVisual("Sketch a diagram, then calculate the resultant.")).toBe(false);
    expect(problemRequiresVisual("Find the image distance for the lens.")).toBe(false);
    expect(problemRequiresVisual("Use Figure P3.15 to determine the resultant.")).toBe(true);
    expect(problemRequiresVisual("Determine the components of the force shown below.")).toBe(true);

    const output = enforceProblemVisualPolicy({
      assignmentTitle: "Vectors",
      summary: "Two problems",
      problems: [
        {
          number: "12",
          markdown: "Calculate $A \\cdot B$ from the listed components.",
          provenance: [{ sourceName: "Packet", sourceUrl: null, page: 2, evidence: "Problem 12" }],
          visual: { path: "renders/page-2.png", page: 2, caption: "Source page" },
          confidence: "high",
        },
        {
          number: "15",
          markdown: "Use Figure P3.15 to determine the resultant.",
          provenance: [{ sourceName: "Packet", sourceUrl: null, page: 3, evidence: "Problem 15" }],
          visual: { path: "renders/figure-15.png", page: 3, caption: "Figure P3.15" },
          confidence: "high",
        },
      ],
      unresolved: [],
      sourcesInspected: [{ name: "Packet", type: "PDF", url: null, pages: [2, 3] }],
    });

    expect(output.problems[0]?.visual).toBeNull();
    expect(output.problems[1]?.visual?.path).toBe("renders/figure-15.png");
  });

  it("keeps answer generation local to parsed questions and visuals", () => {
    const instructions = buildInstructions("answerKey", defaultSettings.prompts.answerKey, null);

    expect(instructions).toContain("attached visual");
    expect(instructions).toContain("no Canvas helper or network access");
    expect(instructions).toContain("do not generate a checks list");
    expect(instructions).toContain("Do not navigate Canvas, cite extracted provenance, or mention sources");
  });

  it("strips checks and provenance from legacy answer-key output", () => {
    const normalized = stripLegacyAnswerMetadata({
      assignmentTitle: "Vectors",
      summary: "Solved.",
      answers: [{
        problemNumber: "1",
        finalAnswerMarkdown: "5",
        solutionMarkdown: "Use the formula.",
        checks: ["Units match"],
        provenance: [{ sourceName: "Packet", sourceUrl: null, page: 2, evidence: "Problem 1" }],
      }],
      warnings: [],
    });

    expect(normalized).toEqual({
      assignmentTitle: "Vectors",
      summary: "Solved.",
      answers: [{ problemNumber: "1", finalAnswerMarkdown: "5", solutionMarkdown: "Use the formula." }],
      warnings: [],
    });
  });
});
