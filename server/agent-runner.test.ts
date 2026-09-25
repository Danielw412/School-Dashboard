import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type AgentRun,
  AgentRunStore,
  buildInstructions,
  compactEventForLog,
  enforceProblemVisualPolicy,
  moduleSequenceTarget,
  parseProblemExtractionOutput,
  parseProblemExtractionRunOutput,
  problemRequiresVisual,
  resolveAgentPreferences,
  sanitizeStoredAgentEvents,
  savedExtractionAssetPaths,
  stripLegacyAnswerMetadata,
} from "./agent-runner.js";
import type { AssignmentContext } from "./canvas-client.js";
import { buildMcpConfigOverrides } from "./codex-execution.js";
import { defaultSettings } from "./settings.js";

const temporaryDirectories: string[] = [];

function problem(
  number: string,
  markdown: string,
  missingVisual: Parameters<typeof enforceProblemVisualPolicy>[0]["problems"][number]["missingVisual"] = null,
) {
  return {
    number,
    markdown,
    answerBankId: null,
    table: null,
    provenance: [{ sourceName: "Packet", sourceUrl: null, page: 2, evidence: `Problem ${number}` }],
    visual: null,
    missingVisual,
    confidence: "high" as const,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("agent run preferences", () => {
  it("defaults problem extraction to Luna with xhigh reasoning", () => {
    const resolved = resolveAgentPreferences(defaultSettings, "problemExtraction");

    expect(resolved.model).toBe("gpt-6-luna");
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
    settings.featureModels.assignmentNavigation = "gpt-6-sol";

    const resolved = resolveAgentPreferences(settings, "directions", { reasoningEffort: "medium" });

    expect(resolved.model).toBe("gpt-6-sol");
    expect(resolved.reasoningEffort).toBe("medium");
    expect(resolved.prompt).toBe(settings.prompts.assignmentNavigation);
  });

  it("uses Claude's own model and effort settings for Claude runs", () => {
    const settings = structuredClone(defaultSettings);
    settings.claude = { model: "claude-sonnet-5", reasoningEffort: "medium" };

    expect(resolveAgentPreferences(settings, "directions", { provider: "claude" })).toMatchObject({
      model: "claude-sonnet-5",
      reasoningEffort: "medium",
      prompt: settings.prompts.assignmentNavigation,
    });
    expect(resolveAgentPreferences(settings, "problemExtraction", { provider: "claude" }).reasoningEffort).toBe("xhigh");
  });

  it("applies the quick effort choice to every feature unless a run names its own", () => {
    expect(resolveAgentPreferences(defaultSettings, "problemExtraction", { effort: "low" }).reasoningEffort).toBe("low");
    expect(resolveAgentPreferences(defaultSettings, "answerKey", { provider: "claude", effort: "max" }).reasoningEffort).toBe("max");
    expect(resolveAgentPreferences(defaultSettings, "problemExtraction", { effort: "default" }).reasoningEffort).toBe("xhigh");
    expect(resolveAgentPreferences(defaultSettings, "studyGuide", { effort: "low", reasoningEffort: "high" }).reasoningEffort).toBe("high");
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

  it("adds the matching saved class directions as bounded student context", () => {
    const instructions = buildInstructions(
      "answerKey",
      defaultSettings.prompts.answerKey,
      null,
      "Use the teacher's sign convention.",
    );

    expect(instructions).toContain("Use the teacher's sign convention.");
    expect(instructions).toContain("class directions for this feature");
    expect(instructions).toContain("student context, not verified teacher instructions");
    expect(instructions).toContain("questions and problem data must still come exclusively from extracted-problems.json");
  });

  it("connects Luna to only the short-lived structured MCP server", () => {
    const overrides = buildMcpConfigOverrides("http://127.0.0.1:8892/api/internal/canvas-mcp", ["personal_server"]);
    const override = overrides.join("\n");

    expect(override).toContain("school_dashboard");
    expect(override).toContain("http://127.0.0.1:8892/api/internal/canvas-mcp");
    expect(override).toContain('bearer_token_env_var="SCHOOL_DASHBOARD_TOOL_TOKEN"');
    expect(override).not.toContain("canvas-tool.mjs");
    expect(overrides).toContain("mcp_servers.personal_server.enabled=false");
    expect(overrides).toContain("mcp_servers.node_repl.enabled=false");
    expect(buildMcpConfigOverrides(null)).not.toContain("mcp_servers={}");
    expect(buildMcpConfigOverrides(null).every((value) => value.endsWith(".enabled=false"))).toBe(true);
    // The laptop worker points the same capability at the dashboard server over the tailnet.
    expect(buildMcpConfigOverrides("http://latitude7370:8892/api/internal/canvas-mcp").join("\n"))
      .toContain('mcp_servers.school_dashboard.url="http://latitude7370:8892/api/internal/canvas-mcp"');
  });

  it("uses a resolved module item to preload its module neighborhood", () => {
    const base = {
      assignment: { id: 104 },
      moduleItem: null,
    } as unknown as AssignmentContext;

    expect(moduleSequenceTarget(base)).toEqual({ type: "Assignment", id: 104 });
    expect(moduleSequenceTarget({
      ...base,
      moduleItem: { id: 704, module_id: 7, title: "Unit 1 Assignment 4", type: "Assignment" },
    })).toEqual({ type: "ModuleItem", id: 704 });
  });

  it("directs problem extraction through bounded text-first lookup and visual-only crops", () => {
    const instructions = buildInstructions("problemExtraction", defaultSettings.prompts.problemExtraction, null);

    expect(instructions).toContain("call index_pdf once");
    expect(instructions).toContain("cached text and detected problem sections first");
    expect(instructions).toContain("Never OCR broad page ranges");
    expect(instructions).toContain("one distinct refinement contact sheet");
    expect(instructions).toContain("every necessary page together in one render_pdf_pages call");
    expect(instructions).toContain("pass that heading");
    expect(instructions).toContain("Set visual and missingVisual to null by default");
    expect(instructions).toContain("if and only if the problem requires");
    expect(instructions).toContain("in one semantic_crop_pdf call");
    expect(instructions).toContain("set problemNumber whenever the problem is numbered");
    expect(instructions).toContain("Look at every returned crop before using it");
    expect(instructions).toContain("missingVisual with status not_located");
    expect(instructions).toContain("missingVisual with status not_in_source");
    expect(instructions).toContain("figureCaptions");
    expect(instructions).toContain("Render pages only when genuinely needed");
    expect(instructions).toContain("Do not crop or attach text-only problems");
    expect(instructions).toContain("Stop as soon as every requested problem is verified");
    expect(instructions).toContain("separate answerBanks entry");
    expect(instructions).toContain("structured table field");
    expect(instructions).toContain("always set each region's kind");
  });

  it("flags missing required visuals per problem and removes page crops from text-only problems", () => {
    expect(problemRequiresVisual("Calculate $A \\cdot B$ from the listed components.")).toBe(false);
    expect(problemRequiresVisual("Sketch a diagram, then calculate the resultant.")).toBe(false);
    expect(problemRequiresVisual("Find the image distance for the lens.")).toBe(false);
    expect(problemRequiresVisual("A 125-kg crate rests on the flatbed of a truck that moves at 15.0 m/s.")).toBe(false);
    expect(problemRequiresVisual("Use Figure P3.15 to determine the resultant.")).toBe(true);
    expect(problemRequiresVisual("Determine the components of the force shown below.")).toBe(true);
    expect(problemRequiresVisual("The photoelectron spectra below show two peaks.")).toBe(true);
    expect(problemRequiresVisual("The mass spectrometer produced the data below.")).toBe(true);
    // The September 23 misses: plain wording that still depends on the packet's drawing.
    expect(problemRequiresVisual("Chairs are swung in a circle by 12.0-m cables attached to a vertical rotating pole, as the drawing shows.")).toBe(true);
    expect(problemRequiresVisual("She reaches the point where a jump is necessary (point A in the drawing).")).toBe(true);
    expect(problemRequiresVisual("The stone is wedged into the tread, as shown.")).toBe(true);

    const output = enforceProblemVisualPolicy({
      assignmentTitle: "Vectors",
      summary: "Two problems",
      answerBanks: [],
      problems: [
        {
          number: "12",
          markdown: "Calculate $A \\cdot B$ from the listed components.",
          answerBankId: null,
          table: null,
          provenance: [{ sourceName: "Packet", sourceUrl: null, page: 2, evidence: "Problem 12" }],
          visual: { path: "renders/page-2.png", page: 2, caption: "Source page", kind: "image" },
          missingVisual: null,
          confidence: "high",
        },
        {
          number: "15",
          markdown: "Use Figure P3.15 to determine the resultant.",
          answerBankId: null,
          table: null,
          provenance: [{ sourceName: "Packet", sourceUrl: null, page: 3, evidence: "Problem 15" }],
          visual: { path: "renders/figure-15.png", page: 3, caption: "Figure P3.15", kind: "figure" },
          missingVisual: null,
          confidence: "high",
        },
      ],
      unresolved: [],
      sourcesInspected: [{ name: "Packet", type: "PDF", url: null, pages: [2, 3] }],
    });

    expect(output.problems[0]?.visual).toBeNull();
    expect(output.problems[1]?.visual?.path).toBe("renders/figure-15.png");

    const missingBank = parseProblemExtractionRunOutput({
      ...output,
      problems: [{ ...output.problems[0]!, answerBankId: "bank-1" }],
    });
    expect(missingBank.unresolved).toContainEqual({
      reference: "Answer bank bank-1",
      reason: expect.stringContaining("not included"),
      searched: [],
    });
    const invalidBank = parseProblemExtractionRunOutput({
      ...output,
      answerBanks: [{ id: "bank-1", title: "Options", markdown: "A. 1", problemNumbers: ["12"], provenance: [] }],
      problems: [{ ...output.problems[0]!, answerBankId: "bank-1" }],
    });
    expect(invalidBank.answerBanks).toEqual([]);
    expect(invalidBank.unresolved).toContainEqual({
      reference: "Answer bank bank-1",
      reason: expect.stringContaining("invalid for problem 12"),
      searched: [],
    });
    const blankBank = parseProblemExtractionRunOutput({
      ...output,
      answerBanks: [{ id: "bank-1", title: "Options", markdown: " ", problemNumbers: ["12", "15"], provenance: output.problems[0]!.provenance }],
      problems: [{ ...output.problems[0]!, answerBankId: "bank-1" }],
    });
    expect(blankBank.answerBanks).toEqual([]);
    expect(blankBank.unresolved[0]?.reference).toBe("Answer bank bank-1");

    const partial = enforceProblemVisualPolicy({
      assignmentTitle: "Circular motion",
      summary: "Three problems",
      answerBanks: [],
      problems: [
        problem("2", "The photoelectron spectra below show two peaks."),
        problem("39", "The maximum tension ... (Hint: see Figure 5.21.)", {
          reference: "Figure 5.21",
          status: "not_in_source",
          detail: "Figure 5.21 is a textbook figure that the packet does not reproduce.",
        }),
        problem("11", "A 125-kg crate rests on the flatbed of a truck."),
      ],
      unresolved: [],
      sourcesInspected: [{ name: "Packet", type: "PDF", url: null, pages: [26] }],
    });

    // Unexplained gaps become warnings; Luna's own explanation is kept; text-only stays clean.
    expect(partial.problems[0]!.missingVisual).toEqual({
      reference: "The photoelectron spectra",
      status: "not_located",
      detail: expect.stringContaining("Open the source page"),
    });
    expect(partial.problems[1]!.missingVisual?.status).toBe("not_in_source");
    expect(partial.problems[2]!.missingVisual).toBeNull();

    expect(enforceProblemVisualPolicy({
      ...partial,
      problems: [{ ...partial.problems[2]!, answerBankId: "bank-1" }],
    }).problems[0]?.answerBankId).toBe("bank-1");
  });

  it("reads runs saved before per-problem missing visuals and source pages", () => {
    const legacy = parseProblemExtractionOutput({
      assignmentTitle: "Vectors",
      summary: "One problem",
      problems: [{
        number: "1",
        markdown: "Add the vectors.",
        provenance: [{ sourceName: "Packet", sourceUrl: null, page: 1, evidence: "Problem 1" }],
        visual: { path: "renders/figure.png", page: 1, caption: "Figure 1" },
        confidence: "high",
      }],
      unresolved: [],
      sourcesInspected: [],
    });

    expect(legacy.problems[0]).toMatchObject({ missingVisual: null, sourcePages: [], visual: { kind: "image" } });
    expect(legacy.sourceDocuments).toEqual([]);
    expect(savedExtractionAssetPaths(legacy)).toEqual(["renders/figure.png"]);
  });

  it("keeps answer generation local to parsed questions and visuals", () => {
    const instructions = buildInstructions("answerKey", defaultSettings.prompts.answerKey, null);

    expect(instructions).toContain("attached visual");
    expect(instructions).toContain("sourceDocuments holds full-page images");
    expect(instructions).toContain("whenever it has a missingVisual");
    expect(instructions).toContain("never invent values from it");
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

describe("AgentRunStore", () => {
  it("preserves retired model IDs when reading and updating historical runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "school-dashboard-runs-"));
    temporaryDirectories.push(directory);
    const store = new AgentRunStore(join(directory, "runs.json"));
    for (const model of ["gpt-5.6-luna", "gpt-5.6-terra"]) {
      const run = { ...agentRun(), id: model, model, status: "completed" as const };
      await store.create(run);
      await store.update(run.id, { taskTitle: "Historical assignment" });
      await expect(store.get(run.id)).resolves.toMatchObject({ model, status: "completed", taskTitle: "Historical assignment" });
    }
  });

  it("recovers after a failed file replacement instead of poisoning later status updates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "school-dashboard-runs-"));
    temporaryDirectories.push(directory);
    let replacements = 0;
    const replace = vi.fn(async (source: string, destination: string) => {
      replacements += 1;
      if (replacements === 2) throw Object.assign(new Error("file temporarily locked"), { code: "EPERM" });
      await rename(source, destination);
    });
    const store = new AgentRunStore(join(directory, "runs.json"), replace);
    const run = agentRun();

    await store.create(run);
    await expect(store.update(run.id, { status: "running" })).rejects.toThrow("file temporarily locked");
    await store.update(run.id, {
      status: "failed",
      completedAt: "2026-08-31T20:05:00.000Z",
      error: "Recovered after the write failure.",
    });

    await expect(store.get(run.id)).resolves.toMatchObject({
      status: "failed",
      error: "Recovered after the write failure.",
    });
    expect(replace).toHaveBeenCalledTimes(3);
  });

  it("marks persisted active records as failed when no live execution owns them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "school-dashboard-runs-"));
    temporaryDirectories.push(directory);
    const store = new AgentRunStore(join(directory, "runs.json"));
    await store.create({ ...agentRun(), status: "running" });

    await expect(store.failOrphaned(() => false)).resolves.toBe(1);
    await expect(store.get("run-1")).resolves.toMatchObject({
      status: "failed",
      error: "The run stopped without reporting a final status.",
    });
  });
});

function agentRun(): AgentRun {
  return {
    id: "run-1",
    feature: "directions",
    status: "queued",
    logicalId: "physics:assignment:42",
    taskTitle: "Problem Set 4",
    courseName: "AP Physics C",
    model: "gpt-6-luna",
    reasoningEffort: "medium",
    effectiveReasoningEffort: "medium",
    prompt: "Inspect the assignment.",
    startedAt: "2026-08-31T20:00:00.000Z",
    completedAt: null,
    threadId: null,
    workspaceId: null,
    usage: null,
    events: [],
    rawStructuredOutput: null,
    output: null,
    error: null,
    predictor: null,
  };
}
