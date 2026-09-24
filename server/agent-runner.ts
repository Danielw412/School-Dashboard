import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";

import type { ThreadEvent, Usage } from "@openai/codex-sdk";
import { z } from "zod";

import { type ActivityStore, sanitizeForLog } from "./activity.js";
import {
  agentPlacement,
  type AgentExecutor,
  type AgentPlacement,
  AgentsUnavailableError,
} from "./agent-execution.js";
import type { AssignmentContext, CanvasClient } from "./canvas-client.js";
import {
  CourseDirectionsStore,
  type CourseDirectionFeature,
} from "./course-directions.js";
import { RUNS_PATH } from "./env.js";
import { runTestQuestionPredictor, type PredictorResult } from "./predictor.js";
import {
  type AppSettings,
  modelIdSchema,
  type ModelSelectable,
  modelSchema,
  reasoningEffortSchema,
  type SettingsStore,
} from "./settings.js";
import {
  collectSourcePages,
  sourceDocumentSchema,
  type SourcePageRef,
  sourcePageRefSchema,
} from "./source-pages.js";
import type { TaskSyncClient } from "./task-sync.js";
import { directionsEvidenceSufficient, type CanvasToolSessions } from "./tool-sessions.js";
import type { WorkspaceManager } from "./workspace.js";

export const featureSchema = z.enum(["directions", "problemExtraction", "answerKey", "studyGuide"]);
export type AgentFeature = z.infer<typeof featureSchema>;

const provenanceSchema = z.object({
  sourceName: z.string(),
  sourceUrl: z.string().nullable(),
  page: z.number().int().positive().nullable(),
  evidence: z.string(),
});

const visualKindSchema = z.enum(["figure", "diagram", "graph", "chart", "table", "spectrum", "map", "image"]);

const problemTableSchema = z.object({
  caption: z.string().nullable(),
  columns: z.array(z.string()).min(1),
  rows: z.array(z.array(z.string()).min(1)).min(1),
});

export const directionsSchema = z.object({
  assignmentTitle: z.string(),
  overviewMarkdown: z.string(),
  instructions: z.array(
    z.object({
      heading: z.string(),
      markdown: z.string(),
      provenance: z.array(provenanceSchema).min(1),
    }),
  ),
  assignedWork: z.array(
    z.object({
      label: z.string(),
      items: z.array(z.string()),
      provenance: z.array(provenanceSchema).min(1),
    }),
  ),
  submission: z.object({
    methodMarkdown: z.string(),
    deliverables: z.array(z.string()),
    dueMarkdown: z.string().nullable(),
  }),
  resources: z.array(
    z.object({
      title: z.string(),
      url: z.string().nullable(),
      kind: z.enum(["canvas", "file", "page", "external"]),
      description: z.string(),
    }),
  ),
  notices: z.array(
    z.object({ level: z.enum(["info", "warning"]), markdown: z.string() }),
  ),
  sourcesInspected: z.array(
    z.object({ name: z.string(), type: z.string(), url: z.string().nullable(), relevance: z.string() }),
  ),
});

export const missingVisualSchema = z.object({
  reference: z.string().describe("The figure label or wording that names the visual, such as \"Figure 5.21\" or \"the drawing\"."),
  status: z.enum(["not_in_source", "not_located"]).describe("not_in_source: the assignment's files do not reproduce this visual (for example a textbook figure). not_located: the visual is in the files but no correct crop could be attached."),
  detail: z.string().describe("One short sentence for the student, naming the page where the visual appears when known."),
});

const extractedProblemSchema = z.object({
  number: z.string(),
  markdown: z.string(),
  answerBankId: z.string().nullable(),
  table: problemTableSchema.nullable(),
  provenance: z.array(provenanceSchema).min(1),
  visual: z
    .object({
      path: z.string(),
      page: z.number().int().positive(),
      caption: z.string(),
      kind: visualKindSchema,
    })
    .nullable()
    .describe("Null unless the question requires a supplied figure, diagram, graph, table, map, image, or other non-text visual to be understood or solved."),
  missingVisual: missingVisualSchema
    .nullable()
    .describe("Null unless the question needs a visual that is not attached. The problem is still returned."),
  confidence: z.enum(["high", "medium", "low"]),
});

const answerBankSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  markdown: z.string(),
  problemNumbers: z.array(z.string()).min(2),
  provenance: z.array(provenanceSchema).min(1),
});

export const problemExtractionSchema = z.object({
  assignmentTitle: z.string(),
  summary: z.string(),
  answerBanks: z.array(answerBankSchema),
  problems: z.array(extractedProblemSchema),
  unresolved: z.array(
    z.object({ reference: z.string(), reason: z.string(), searched: z.array(z.string()) }),
  ),
  sourcesInspected: z.array(
    z.object({ name: z.string(), type: z.string(), url: z.string().nullable(), pages: z.array(z.number().int().positive()) }),
  ),
});

// What the dashboard stores: Luna's extraction plus full source-page images it adds afterwards.
export const savedProblemExtractionSchema = problemExtractionSchema.extend({
  problems: z.array(extractedProblemSchema.extend({
    sourcePages: z.array(sourcePageRefSchema).default([]),
  })),
  sourceDocuments: z.array(sourceDocumentSchema).default([]),
});
export type ProblemExtraction = z.infer<typeof problemExtractionSchema>;
export type SavedProblemExtraction = z.infer<typeof savedProblemExtractionSchema>;

export const answerKeySchema = z.object({
  assignmentTitle: z.string(),
  summary: z.string(),
  answers: z.array(
    z.object({
      problemNumber: z.string(),
      finalAnswerMarkdown: z.string(),
      solutionMarkdown: z.string(),
    }),
  ),
  warnings: z.array(z.string()),
});

export function stripLegacyAnswerMetadata(output: unknown): unknown {
  const parsed = answerKeySchema.safeParse(output);
  return parsed.success ? parsed.data : output;
}

export const studyGuideSchema = z.object({
  assessmentTitle: z.string(),
  overview: z.string(),
  teacherStatedScope: z.array(
    z.object({ topic: z.string(), evidence: z.string(), provenance: provenanceSchema }),
  ),
  agentInferredTopics: z.array(
    z.object({ topic: z.string(), rationale: z.string(), provenance: z.array(provenanceSchema) }),
  ),
  sections: z.array(
    z.object({ heading: z.string(), explanationMarkdown: z.string(), keyIdeas: z.array(z.string()) }),
  ),
  practiceQuestions: z.array(
    z.object({ questionMarkdown: z.string(), answerMarkdown: z.string(), basis: z.string(), provenance: z.array(provenanceSchema) }),
  ),
  sourcesInspected: z.array(
    z.object({ name: z.string(), type: z.string(), url: z.string().nullable(), relevance: z.string() }),
  ),
  predictor: z.object({
    requested: z.boolean(),
    status: z.enum(["disabled", "unavailable", "available"]),
    message: z.string(),
  }),
});

export type AgentRun = {
  id: string;
  feature: AgentFeature;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  logicalId: string;
  taskTitle: string;
  courseName: string;
  model: string;
  reasoningEffort: z.infer<typeof reasoningEffortSchema>;
  effectiveReasoningEffort: string;
  prompt: string;
  courseDirections?: {
    courseId: string;
    feature: CourseDirectionFeature;
    directions: string;
    updatedAt: string | null;
  };
  // Where Codex ran: the dashboard server or the laptop worker (absent on older runs).
  execution?: AgentPlacement;
  startedAt: string;
  completedAt: string | null;
  threadId: string | null;
  workspaceId: string | null;
  usage: Usage | null;
  events: unknown[];
  rawStructuredOutput: string | null;
  output: unknown;
  error: string | null;
  predictor: PredictorResult | null;
};

export type StartAgentRun = {
  feature: AgentFeature;
  logicalId: string;
  model?: string;
  reasoningEffort?: z.infer<typeof reasoningEffortSchema>;
  useTestQuestionPredictor?: boolean;
  extractionRunId?: string;
};

export class AgentRunStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly path = RUNS_PATH,
    private readonly replaceFile: (source: string, destination: string) => Promise<void> = replaceFileWithRetry,
  ) {}

  async list(limit = 100): Promise<AgentRun[]> {
    const runs = await this.read();
    return runs.slice(-Math.max(1, Math.min(limit, 250))).reverse();
  }

  async get(id: string): Promise<AgentRun | null> {
    return (await this.read()).find((run) => run.id === id) ?? null;
  }

  async create(run: AgentRun): Promise<AgentRun> {
    await this.mutate((runs) => [...runs, run].slice(-250));
    return run;
  }

  async update(id: string, patch: Partial<AgentRun>): Promise<AgentRun> {
    let updated: AgentRun | null = null;
    await this.mutate((runs) =>
      runs.map((run) => {
        if (run.id !== id) return run;
        updated = { ...run, ...patch };
        return updated;
      }),
    );
    if (!updated) throw new Error(`Agent run ${id} was not found.`);
    return updated;
  }

  async updateIfActive(id: string, patch: Partial<AgentRun>): Promise<AgentRun> {
    let updated: AgentRun | null = null;
    await this.mutate((runs) =>
      runs.map((run) => {
        if (run.id !== id) return run;
        updated = run.status === "queued" || run.status === "running" ? { ...run, ...patch } : run;
        return updated;
      }),
    );
    if (!updated) throw new Error(`Agent run ${id} was not found.`);
    return updated;
  }

  async failInterrupted(): Promise<number> {
    let count = 0;
    await this.mutate((runs) =>
      runs.map((run) => {
        if (run.status !== "queued" && run.status !== "running") return run;
        count += 1;
        return {
          ...run,
          status: "failed",
          completedAt: new Date().toISOString(),
          error: "The dashboard server restarted before this run completed.",
        };
      }),
    );
    return count;
  }

  async failOrphaned(isActive: (id: string) => boolean): Promise<number> {
    let count = 0;
    await this.mutate((runs) => {
      const next = runs.map((run) => {
        if ((run.status !== "queued" && run.status !== "running") || isActive(run.id)) return run;
        count += 1;
        return {
          ...run,
          status: "failed" as const,
          completedAt: new Date().toISOString(),
          error: "The run stopped without reporting a final status.",
        };
      });
      return count === 0 ? runs : next;
    });
    return count;
  }

  private async read(): Promise<AgentRun[]> {
    try {
      const runs = sanitizeForLog(JSON.parse(await readFile(this.path, "utf8"))) as AgentRun[];
      return runs.map((run) => {
        const normalizedOutput = run.feature === "answerKey"
          ? stripLegacyAnswerMetadata(run.output)
          : run.output;
        return {
          ...run,
          events: sanitizeStoredAgentEvents(run.events),
          output: normalizedOutput,
          rawStructuredOutput:
            run.feature === "answerKey" && normalizedOutput && run.rawStructuredOutput
              ? JSON.stringify(normalizedOutput)
              : run.rawStructuredOutput,
        };
      });
    } catch {
      return [];
    }
  }

  private async mutate(transform: (runs: AgentRun[]) => AgentRun[]) {
    const operation = this.writeChain.catch(() => undefined).then(async () => {
      const current = await this.read();
      const next = transform(current);
      if (next === current) return;
      await mkdir(dirname(this.path), { recursive: true });
      const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
        await this.replaceFile(temporaryPath, this.path);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.writeChain = operation;
    await operation;
  }
}

async function replaceFileWithRetry(source: string, destination: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientFileReplacementError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
  try {
    await copyFile(source, destination);
    await rm(source, { force: true });
  } catch {
    throw lastError;
  }
}

function isTransientFileReplacementError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return ["EACCES", "EBUSY", "EEXIST", "EPERM"].includes(String(error.code));
}

export class AgentRunner {
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(
    private readonly settingsStore: SettingsStore,
    private readonly taskSync: TaskSyncClient,
    private readonly canvas: CanvasClient,
    private readonly workspaces: WorkspaceManager,
    private readonly toolSessions: CanvasToolSessions,
    private readonly activity: ActivityStore,
    private readonly runs: AgentRunStore,
    private readonly executor: AgentExecutor,
    private readonly courseDirections = new CourseDirectionsStore(),
    private readonly isSelectableModel: ModelSelectable = (model) => modelSchema.safeParse(model).success,
  ) {}

  async start(input: StartAgentRun): Promise<AgentRun> {
    const parsed = z
      .object({
        feature: featureSchema,
        logicalId: z.string().min(1),
        model: modelIdSchema.refine(this.isSelectableModel, "This model is not currently supported by Codex.").optional(),
        reasoningEffort: reasoningEffortSchema.optional(),
        useTestQuestionPredictor: z.boolean().optional(),
        extractionRunId: z.string().uuid().optional(),
      })
      .parse(input);
    // Fail fast (HTTP 503) instead of recording a run that cannot reach Codex. The run stays on
    // the target selected now, even if the student switches targets while it is underway.
    const execution = this.executor.status();
    if (!execution.available) throw new AgentsUnavailableError(execution.message);
    const placement = agentPlacement(execution);
    const settings = await this.settingsStore.get();
    const task = await this.taskSync.getTask(parsed.logicalId);
    const savedCourseDirections = await this.courseDirections.get(task.course.id);
    const courseDirections = {
      courseId: savedCourseDirections.courseId,
      feature: parsed.feature,
      directions: savedCourseDirections.directions[parsed.feature],
      updatedAt: savedCourseDirections.updatedAt,
    };
    const preference = resolveAgentPreferences(
      settings,
      parsed.feature,
      parsed.model,
      parsed.reasoningEffort,
    );
    const model = preference.model;
    const reasoningEffort = preference.reasoningEffort;
    const effectiveReasoningEffort = reasoningEffort === "none" ? "minimal" : reasoningEffort;
    const prompt = preference.prompt;
    const run: AgentRun = {
      id: randomUUID(),
      feature: parsed.feature,
      status: "queued",
      logicalId: parsed.logicalId,
      taskTitle: task.display_title,
      courseName: task.course.name,
      model,
      reasoningEffort,
      effectiveReasoningEffort,
      prompt,
      courseDirections,
      execution: placement,
      startedAt: new Date().toISOString(),
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
    const controller = new AbortController();
    this.activeRuns.set(run.id, controller);
    try {
      await this.runs.create(run);
    } catch (error) {
      this.activeRuns.delete(run.id);
      throw error;
    }
    void this.execute(run, parsed, settings, task, controller).finally(() => {
      this.activeRuns.delete(run.id);
    });
    return run;
  }

  async cancel(id: string): Promise<AgentRun> {
    const run = await this.runs.get(id);
    if (!run) throw new Error("Agent run not found.");
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") return run;
    this.activeRuns.get(id)?.abort(new Error("Cancelled by the user."));
    const cancelled = await this.runs.update(id, {
      status: "cancelled",
      completedAt: new Date().toISOString(),
      error: "Cancelled by the user.",
    });
    await this.activity.record({
      category: "agent",
      action: run.feature,
      status: "warning",
      summary: `${run.taskTitle} cancelled`,
      metadata: { runId: run.id },
    });
    return cancelled;
  }

  async reconcileOrphanedRuns(): Promise<number> {
    return this.runs.failOrphaned((id) => this.activeRuns.has(id));
  }

  private async execute(
    run: AgentRun,
    input: StartAgentRun,
    settings: AppSettings,
    task: Awaited<ReturnType<TaskSyncClient["getTask"]>>,
    controller: AbortController,
  ) {
    let toolToken: string | null = null;
    // Kept outside the try so a run rejected after Luna answered still records what she returned.
    const rawEvents: unknown[] = [];
    let rawStructuredOutput: string | null = null;
    try {
      controller.signal.throwIfAborted();
      await this.runs.update(run.id, { status: "running" });
      await this.activity.record({
        category: "agent",
        action: run.feature,
        status: "started",
        summary: run.taskTitle,
        metadata: { runId: run.id, model: run.model, reasoningEffort: run.reasoningEffort },
      });
      await this.activity.record({
        category: "agent",
        action: "workspace.prepare",
        status: "started",
        summary: run.taskTitle,
        metadata: { runId: run.id },
      });
      const workspace = await this.workspaces.create(task.logical_id);
      controller.signal.throwIfAborted();
      await this.activity.record({
        category: "agent",
        action: "workspace.prepare",
        status: "completed",
        summary: run.taskTitle,
        metadata: { runId: run.id, workspace: workspace.id },
      });
      let predictor: PredictorResult | null = null;
      let toolSession: ReturnType<CanvasToolSessions["create"]> | null = null;
      if (run.feature === "answerKey") {
        const answerSource = await this.prepareAnswerSource(input, task.logical_id, workspace);
        await this.workspaces.writeJson(workspace, "extracted-problems.json", answerSource);
      } else {
        await this.activity.record({
          category: "agent",
          action: "source-context",
          status: "started",
          summary: run.taskTitle,
          metadata: { runId: run.id, workspace: workspace.id },
        });
        const context = await this.canvas.assignmentContext(task);
        controller.signal.throwIfAborted();
        await this.workspaces.writeJson(workspace, "task.json", task);
        await this.workspaces.writeJson(workspace, "assignment-context.json", context);
        if (run.feature === "studyGuide") {
          predictor = await runTestQuestionPredictor(Boolean(input.useTestQuestionPredictor), {
            task,
            assignment: context.assignment,
            directions: context.directionsMarkdown,
          });
          await this.workspaces.writeJson(workspace, "test-question-predictor.json", predictor);
        }
        const preflight: Record<string, unknown> = {
          structuredToolsReady: true,
          selectedAssignment: context.assignment?.id ?? null,
          selectedModuleItem: context.moduleItem?.id ?? null,
          recoveredSourceContext: context.sourceContext,
          moduleNeighborhood: null,
          directionsEvidenceSufficient:
            run.feature === "directions" && directionsEvidenceSufficient(task, context),
        };
        const courseId = task.canvas.course_id ?? task.course.canvas_course_id;
        const sequenceAsset = moduleSequenceTarget(context);
        if (courseId && sequenceAsset) {
          try {
            preflight.moduleNeighborhood = await this.canvas.getModuleItemSequence(
              courseId,
              sequenceAsset.type,
              String(sequenceAsset.id),
            );
          } catch (error) {
            preflight.moduleNeighborhoodError =
              error instanceof Error ? error.message : "Module neighborhood unavailable";
          }
        }
        toolSession = this.toolSessions.create(task, context, workspace, settings, {
          runId: run.id,
          profile: run.feature === "directions" ? "directions" : "standard",
          preflight,
        });
        toolToken = toolSession.token;
        await this.workspaces.writeJson(workspace, "canvas-tool-preflight.json", preflight);
        await this.activity.record({
          category: "agent",
          action: "source-context",
          status: "completed",
          summary: run.taskTitle,
          metadata: { runId: run.id, workspace: workspace.id },
        });
        await this.activity.record({
          category: "agent",
          action: "mcp.connect",
          status: "completed",
          summary: run.taskTitle,
          metadata: { runId: run.id, workspace: workspace.id, tool: "school_dashboard" },
        });
      }
      const instructions = buildInstructions(run.feature, run.prompt, predictor, run.courseDirections?.directions);
      controller.signal.throwIfAborted();
      await this.runs.update(run.id, { workspaceId: workspace.id });
      const timeoutMs = run.feature === "problemExtraction" ? 15 * 60_000 : 8 * 60_000;
      let usage: Usage | null = null;
      const result = await this.executor.run({
        runId: run.id,
        feature: run.feature,
        taskTitle: run.taskTitle,
        model: run.model,
        reasoningEffort: run.effectiveReasoningEffort,
        instructions,
        outputSchema: schemaForFeature(run.feature),
        networkAccessEnabled: run.feature !== "answerKey",
        workspace,
        toolToken: toolSession?.token ?? null,
        timeoutMs,
        target: run.execution?.target,
      }, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
        onStarted: async () => {
          const placement = run.execution;
          const host = placement?.target === "worker"
            ? this.executor.status().worker?.name ?? placement.host
            : placement?.host;
          await this.activity.record({
            category: "agent",
            action: "codex.start",
            status: "completed",
            summary: run.taskTitle,
            metadata: {
              runId: run.id,
              workspace: workspace.id,
              model: run.model,
              ...(placement ? { target: placement.target } : {}),
              ...(placement?.target === "worker" && host ? { worker: host } : {}),
              ...(placement && placement.label !== "This computer" && host
                ? { progressLabel: `Starting the configured Codex model on the ${placement.label.toLowerCase()} (${host})` }
                : {}),
            },
          });
        },
        onEvent: async (event: ThreadEvent) => {
          controller.signal.throwIfAborted();
          rawEvents.push(sanitizeForLog(compactEventForLog(event)));
          if (event.type === "thread.started") {
            await this.runs.update(run.id, { threadId: event.thread_id });
          }
          if (event.type === "turn.completed") usage = event.usage;
          if (event.type === "item.completed" && event.item.type === "agent_message") {
            rawStructuredOutput = event.item.text;
          }
          if (event.type === "item.started") {
            await this.activity.record({
              category: "agent",
              action: event.item.type,
              status: "started",
              summary: event.item.type === "reasoning"
                ? "Reasoning about inspected evidence"
                : `${event.item.type.replaceAll("_", " ")} in progress`,
              metadata: { runId: run.id },
            });
          }
          if (event.type === "item.completed") {
            await this.activity.record({
              category: "agent",
              action: event.item.type,
              status: event.item.type === "error" ? "failed" : "completed",
              summary: summarizeItem(event),
              metadata: { runId: run.id },
            });
          }
        },
      });
      controller.signal.throwIfAborted();
      usage = result.usage ?? usage;
      rawStructuredOutput = result.finalResponse ?? rawStructuredOutput;
      if (!rawStructuredOutput) throw new Error("Codex completed without structured output.");
      const parsedOutput = run.feature === "problemExtraction"
        ? parseProblemExtractionRunOutput(JSON.parse(rawStructuredOutput))
        : outputParser(run.feature).parse(JSON.parse(rawStructuredOutput));
      let finalOutput: unknown = parsedOutput;
      if (run.feature === "problemExtraction") {
        const extraction = await this.attachSourcePages(
          run,
          workspace,
          enforceProblemVisualPolicy(problemExtractionSchema.parse(parsedOutput)),
        );
        await this.workspaces.preserveWorkspaceAssets(workspace.id, savedExtractionAssetPaths(extraction));
        controller.signal.throwIfAborted();
        finalOutput = extraction;
      }
      const safeOutput = sanitizeForLog(finalOutput);
      const safeRawStructuredOutput = JSON.stringify(safeOutput);
      await this.runs.updateIfActive(run.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        threadId: result.threadId,
        usage,
        events: rawEvents.slice(-250),
        rawStructuredOutput: safeRawStructuredOutput,
        output: safeOutput,
        predictor,
      });
      await this.activity.record({
        category: "agent",
        action: run.feature,
        status: "completed",
        summary: run.taskTitle,
        metadata: { runId: run.id, model: run.model, usage },
      });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const message = cancelled ? "Cancelled by the user." : error instanceof Error ? error.message : "Agent run failed";
      await this.runs.updateIfActive(run.id, {
        status: cancelled ? "cancelled" : "failed",
        completedAt: new Date().toISOString(),
        error: message,
        // Diagnostics only: output stays null, so a rejected draft can never feed an answer key,
        // and its assets are not preserved.
        events: rawEvents.slice(-250),
        rawStructuredOutput: rawStructuredOutput ? redactFailedOutput(rawStructuredOutput, toolToken) : null,
      });
      await this.activity.record({
        category: "agent",
        action: run.feature,
        status: cancelled ? "warning" : "failed",
        summary: run.taskTitle,
        metadata: { runId: run.id, error: message },
      });
    } finally {
      if (toolToken) this.toolSessions.revoke(toolToken);
    }
  }

  // Best effort: a run whose source pages cannot be rendered still completes without them.
  private async attachSourcePages(
    run: AgentRun,
    workspace: Awaited<ReturnType<WorkspaceManager["create"]>>,
    extraction: ProblemExtraction,
  ): Promise<SavedProblemExtraction> {
    try {
      const { documents, problemPages } = await collectSourcePages(this.workspaces, workspace, extraction.problems);
      return {
        ...extraction,
        problems: extraction.problems.map((problem, index) => ({ ...problem, sourcePages: problemPages[index] ?? [] })),
        sourceDocuments: documents,
      };
    } catch (error) {
      await this.activity.record({
        category: "agent",
        action: "source-pages",
        status: "warning",
        summary: run.taskTitle,
        metadata: { runId: run.id, error: error instanceof Error ? error.message : "Source pages unavailable" },
      });
      return {
        ...extraction,
        problems: extraction.problems.map((problem) => ({ ...problem, sourcePages: [] })),
        sourceDocuments: [],
      };
    }
  }

  private async prepareAnswerSource(
    input: StartAgentRun,
    logicalId: string,
    workspace: Awaited<ReturnType<WorkspaceManager["create"]>>,
  ) {
    if (!input.extractionRunId) throw new Error("Generate or select an extracted-problems run first.");
    const extraction = await this.runs.get(input.extractionRunId);
    if (!extraction || extraction.feature !== "problemExtraction" || extraction.status !== "completed") {
      throw new Error("The selected extracted-problems run is unavailable or incomplete.");
    }
    if (extraction.logicalId !== logicalId) {
      throw new Error("The extracted problems belong to a different assignment.");
    }
    const parsed = parseProblemExtractionOutput(extraction.output);
    // Whole source pages are optional context; an expired page is skipped rather than fatal.
    const sourceDocuments = extraction.workspaceId
      ? await Promise.all(parsed.sourceDocuments.map(async (document) => ({
        id: document.id,
        name: document.name,
        pages: (await Promise.all(document.pages.map(async (page) => {
          try {
            return [{
              page: page.page,
              path: await this.workspaces.copyWorkspaceAsset(
                extraction.workspaceId!,
                page.path,
                workspace,
                `source-${document.id}-page-${page.page}${extname(page.path)}`,
              ),
            }];
          } catch {
            return [];
          }
        }))).flat(),
      })))
      : [];
    const sourcePagesFor = (refs: SourcePageRef[]) => refs.flatMap((ref) => {
      const document = sourceDocuments.find((item) => item.id === ref.documentId);
      const page = document?.pages.find((item) => item.page === ref.page);
      return document && page ? [{ document: document.name, page: page.page, path: page.path }] : [];
    });
    const problems = await Promise.all(parsed.problems.map(async (problem, index) => {
      const common = {
        number: problem.number,
        markdown: problem.markdown,
        answerBankId: problem.answerBankId,
        table: problem.table,
        missingVisual: problem.missingVisual,
        sourcePages: sourcePagesFor(problem.sourcePages),
      };
      if (!problem.visual) return { ...common, visual: null };
      if (!extraction.workspaceId) {
        throw new Error("An extracted problem visual is unavailable. Extract the problems again.");
      }
      let path: string;
      try {
        path = await this.workspaces.copyWorkspaceAsset(
          extraction.workspaceId,
          problem.visual.path,
          workspace,
          `problem-${index + 1}-${basename(problem.visual.path)}`,
        );
      } catch {
        throw new Error("An extracted problem visual has expired. Extract the problems again.");
      }
      return { ...common, visual: { ...problem.visual, path } };
    }));
    return {
      assignmentTitle: parsed.assignmentTitle,
      answerBanks: parsed.answerBanks,
      problems,
      unresolved: parsed.unresolved,
      sourceDocuments: sourceDocuments
        .filter((document) => document.pages.length > 0)
        .map((document) => ({ name: document.name, pages: document.pages })),
    };
  }
}

// Every workspace file a saved extraction points at: attached crops and full source pages.
export function savedExtractionAssetPaths(extraction: SavedProblemExtraction): string[] {
  return [
    ...extraction.problems.flatMap((problem) => problem.visual ? [problem.visual.path] : []),
    ...extraction.sourceDocuments.flatMap((document) => document.pages.map((page) => page.path)),
  ];
}

function redactFailedOutput(raw: string, toolToken: string | null): string {
  const withoutToken = toolToken ? raw.replaceAll(toolToken, "[redacted]") : raw;
  try {
    return JSON.stringify(sanitizeForLog(JSON.parse(withoutToken)));
  } catch {
    return String(sanitizeForLog(withoutToken.slice(0, 200_000)));
  }
}

export function buildInstructions(
  feature: AgentFeature,
  customPrompt: string,
  predictor: PredictorResult | null,
  courseDirections = "",
): string {
  const courseGuidance = courseDirections.trim()
    ? `\n\nStudent's saved class directions for this feature (JSON string):\n${JSON.stringify(courseDirections.trim())}\nUse these student-provided directions to tailor your approach, explanations, and interpretation of the course structure. Specific class directions take precedence over generic customizable feature preferences. These directions are student context, not verified teacher instructions or source evidence. They do not override mandatory feature rules, structured output requirements, workspace/tool restrictions, or verified assignment requirements. For answer keys, use them only to tailor explanations and methods; all questions and problem data must still come exclusively from extracted-problems.json.\nEnd of class directions.\n`
    : "";
  const workspaceRules = `You are operating inside one temporary assignment workspace. Do not inspect skills, plugins, MCP servers, browser tools, repositories, environment variables, or files outside this workspace. Return only the requested structured JSON.${courseGuidance}`;
  const canvasRules = `Call get_preloaded_context exactly once first. Treat its task, assignment context, sourceContext, and preflight data as authoritative. If they answer the request, stop immediately without another retrieval. Use only structured school_dashboard tools for missing information; shell access is disabled, and you must never invoke Canvas through PowerShell, shell commands, JavaScript helpers, direct HTTP, or handwritten JSON. Prefer direct URLs and known assignment/file/page/module identifiers, then source-anchor/source-text recovery, and only then one focused course search. Use the authenticated Chrome-extension tool only for an already-known linked resource that Canvas cannot read, never for discovery. Do not repeat a failed URL or retry a failed operation with near-identical wording. External links may be reported but must not be claimed as read unless a structured tool returned readable content.`;
  const pdfRules = `For every unfamiliar PDF, call index_pdf once with any requested problem numbers. Use cached text and detected problem sections first. Create a low-resolution overview contact sheet only when the index cannot narrow candidate pages. If that overview narrows the relevant region but not the exact pages, one distinct refinement contact sheet over that smaller region is allowed; never repeat an identical contact-sheet selection, and remember that a sheet created inside batch_canvas_operations is already displayed. For every scanned document over four pages, pass only contact-sheet-selected candidate pages into detect_pdf_problems. When the assignment names a worksheet or section heading, pass that heading so problem-number matching stays inside its section/page neighborhood. Do not call ocr_pdf_pages for pages already processed by detection. Never OCR broad page ranges: OCR only unresolved likely pages whose text layer is missing or unusable. Render pages only when genuinely needed to verify unclear text/OCR. When multiple pages need that visual verification, send every necessary page together in one render_pdf_pages call instead of rendering them one-by-one. If detection returned every requested section and a required semantic crop completed, do not render those pages merely to verify the same evidence again. Crop and return an image only when a required non-text visual must appear in the final problem. Reuse cached outputs, batch independent operations, and stop when exact requested content is sufficiently verified.`;
  if (feature === "directions") {
    return `${workspaceRules}\n${canvasRules}\n\nFeature prompt:\n${customPrompt}\n\nMandatory Directions scope: determine only the assigned work, relevant instructions, submission requirements, and due date. If preflight.directionsEvidenceSufficient is true, answer immediately from the preloaded data; every other retrieval tool is intentionally unavailable. For agenda/table tasks, treat sourceContext.contextMarkdown and sourceContext.cells as the relevant surrounding row, not merely the classified homework sentence: preserve exact due times, submission method, required materials, related links, and nearby instructions. If resolution is missing or incomplete, call recover_canvas_context once; it uses the task title, source sentence, source anchor, source/page metadata, and direct URLs. If the relevant context directly references instructions, directions, guidelines, a rubric, requirements, a checklist, or criteria, read only the minimum directly relevant linked resource(s) needed before finalizing and prefer those direct links over any course search. If a known required link is external or API-inaccessible, use read_linked_resource_with_chrome once for that URL. Do not search the course while a directly relevant instruction link is already known, do not open unrelated links, do not open or inspect PDF/file question content in Directions, and do not search broadly. Stop immediately once assigned work, submission method, due information, and explicitly referenced instructions are sufficiently verified. Everything in the response must be a brief Luna-authored paraphrase, never raw Canvas HTML: overviewMarkdown is at most two short sentences; use no more than five instructions; keep assigned-work items exact and terse; make submission.methodMarkdown one short sentence; use short deliverable phrases; and make dueMarkdown the concise verified date/time. Never include attempt counts, solve problems, repeat facts, or invent missing details.`;
  }
  if (feature === "problemExtraction") {
    return `${workspaceRules}\n${canvasRules}\n${pdfRules}\n\nFeature prompt:\n${customPrompt}\n\nLocate the exact question text. Start with direct assignment/source links and recovered source context, then inspect only relevant module neighbors and linked resources. Prefer a known PDF/file URL or file ID over file listing or course search. Treat a linked answer key only as a cross-check; never use it as the source of a problem statement. Request independent Canvas resources together when possible. Put every subpart and every multiple-choice answer choice on its own Markdown line, with a blank line before the first choice; never run choices together in one paragraph. When one answer bank is shared by two or more problems, create exactly one separate answerBanks entry, link each covered problem with answerBankId, and do not repeat the bank inside any problem markdown. For a simple source table, populate the structured table field and omit pipe-table Markdown. If a table's spatial layout or visual encoding matters, leave table null and attach a tight table screenshot instead. Set visual and missingVisual to null by default. A visual is allowed if and only if the problem requires a figure, diagram, drawing, graph, chart, spectrum, table, map, or other non-text image that the assignment's own files supply; a source-page screenshot is not provenance and must never be attached merely because the question came from a PDF. A targeted page render may be inspected to correct unclear OCR, but it must not be attached to a text-only problem. Wording such as “as the drawing shows” or “point A in the drawing” needs a visual just like a figure number. detect_pdf_problems reports figures (a drawing inside a detected problem's region) and figureCaptions (every figure caption read on the searched pages); use them to find the supplied visuals, and remember OCR can misread a caption digit (P6.20 read as P8.20). Request every required visual on the same PDF together in one semantic_crop_pdf call; always set each region's kind, and set problemNumber whenever the problem is numbered on the page. Use the exact figure label when one exists; otherwise use the short source phrase immediately above or inside the visual, such as an axis label or “spectra below.” The tool falls back to the drawing inside that problem's region when the label is unreadable and reports how each crop was located (anchor and note). Look at every returned crop before using it: a completed crop that shows the whole intended visual is the final image and must be assigned to that problem's visual field, but a crop that shows the wrong or partial content must not be attached. For a required visual that returned not_found or a wrong crop, you may crop known render coordinates once with crop_image_regions and inspect that result the same way. Do not retry near-identical semantic queries. If a required supplied visual still cannot be attached, keep the problem and set missingVisual with status not_located, naming the page where the visual appears. When a problem cites a figure the assignment's files do not reproduce (for example a textbook figure number with no matching caption on any inspected page), do not crop anything; keep the problem and set missingVisual with status not_in_source. Do not crop or attach text-only problems. Write inline math with $...$ and display math with $$...$$. Stop as soon as every requested problem is verified; if exact text cannot be found, add an unresolved entry rather than continuing broad searches or inventing it.`;
  }
  if (feature === "answerKey") {
    return `${workspaceRules}\nRead only extracted-problems.json and the local image paths named inside it. You have no Canvas helper or network access for this feature.\n\nFeature prompt:\n${customPrompt}\n\nMandatory Answer Key rules: use only each parsed question, linked answer bank, structured table, attached visual, and source page image in extracted-problems.json. Inspect every attached visual whenever it affects the question. sourceDocuments holds full-page images of the assignment's source file, and each problem's sourcePages names the pages it came from. Open a problem's source pages whenever it has a missingVisual, its attached visual looks cropped, unreadable, or unrelated, or data it needs is absent from the markdown; read any other page of the sheet when the problem depends on it. A missingVisual with status not_in_source is not shown on any page: solve from the text when that is possible, otherwise state exactly what the missing figure would have to show in warnings, and never invent values from it. The unresolved list may flag a missing or invalid answer bank; warn about unavailable choices instead of inventing them. Do not navigate Canvas, cite extracted provenance, or mention sources. Preserve problem numbering. Return a concise final answer and a complete solution using Markdown and LaTeX only. Never emit HTML tags such as <details>, <summary>, or heading tags. Silently verify the work, but do not generate a checks list or green-check commentary. These rules override any conflicting wording in the customizable feature prompt.`;
  }
  return `${workspaceRules}\n${canvasRules}\n${pdfRules}\n\nFeature prompt:\n${customPrompt}\n\nThis is a focused assessment investigation. Inspect the assessment description, its containing or nearby modules, and only relevant pages, assignments, notes, PDFs, worksheets, or teacher review material. Separate teacher-stated scope from your own inferences. Predictor adapter status:\n${JSON.stringify(predictor)}\nIf predictor status is unavailable, state that exactly and do not fabricate predicted history. If available, treat its output as one labeled evidence source, not teacher-provided scope.`;
}

export function moduleSequenceTarget(
  context: AssignmentContext,
): { type: "ModuleItem" | "Assignment"; id: number } | null {
  if (context.moduleItem) return { type: "ModuleItem", id: context.moduleItem.id };
  if (context.assignment) return { type: "Assignment", id: context.assignment.id };
  return null;
}

const VISUAL_NOUN = String.raw`(?:figure|fig\.?|diagram|drawing|graph|chart|plot|spectrum|spectra|table|map|illustration|picture|photo(?:graph)?|circuit|free[- ]body diagram)`;

export function problemRequiresVisual(markdown: string): boolean {
  const visual = VISUAL_NOUN;
  return new RegExp(String.raw`\b(?:use|using|from|according to|refer(?:ring)? to)\s+(?:the\s+)?${visual}\b`, "iu").test(markdown) ||
    new RegExp(String.raw`\b(?:following|provided|attached|accompanying)\s+${visual}\b`, "iu").test(markdown) ||
    new RegExp(String.raw`\b${visual}\s+(?:above|below|shown|provided|attached|depicts?|illustrates?|shows?|lists?)\b`, "iu").test(markdown) ||
    /\b(?:figure|fig\.?)\s*[A-Z]?\d+(?:\.\d+)?\b/iu.test(markdown) ||
    new RegExp(String.raw`\b(?:shown|depicted|pictured|illustrated|labeled|marked)\s+(?:above|below|in|on)\s+(?:the\s+)?${visual}\b`, "iu").test(markdown) ||
    // "(point A in the drawing)", "the angle in the figure"
    new RegExp(String.raw`\b(?:in|on)\s+the\s+${visual}\b`, "iu").test(markdown) ||
    /\bas\s+(?:shown|depicted|pictured|illustrated)\b/iu.test(markdown) ||
    /\b(?:shown|depicted|pictured|illustrated)\s+(?:above|below)\b/iu.test(markdown) ||
    /\b(?:data|results?)\s+(?:shown\s+)?(?:above|below)\b/iu.test(markdown);
}

// The figure a problem names, for the student-facing missing-visual note.
function referencedVisual(markdown: string): string {
  const reference = markdown.match(/\b(?:figure|fig\.?)\s*[A-Z]?\d+(?:\.\d+)*\b/iu)?.[0]
    ?? markdown.match(new RegExp(String.raw`\bthe\s+(?:[a-z-]+\s+)?${VISUAL_NOUN}`, "iu"))?.[0]
    ?? "The referenced visual";
  return reference.charAt(0).toUpperCase() + reference.slice(1);
}

export function enforceProblemVisualPolicy(output: ProblemExtraction): ProblemExtraction {
  // A missing visual is a per-problem warning, not a reason to discard the whole extraction:
  // the problem text is still useful, the student can open the source page, and the answer
  // key gets the same page images.
  const problems = output.problems.map((problem) => {
    const visual = problem.visual && (
      problemRequiresVisual(problem.markdown) ||
      problemRequiresVisual(problem.visual.caption) ||
      problem.visual.kind !== "image"
    ) ? problem.visual : null;
    const unexplained = !visual && !problem.table && !problem.missingVisual && problemRequiresVisual(problem.markdown);
    return {
      ...problem,
      visual,
      missingVisual: unexplained
        ? {
          reference: referencedVisual(problem.markdown),
          status: "not_located" as const,
          detail: "This problem refers to a visual that was not attached. Open the source page to see it.",
        }
        : problem.missingVisual,
    };
  });

  return {
    ...output,
    problems,
  };
}

// Keep usable questions when a shared bank is omitted or malformed. Report the gap in the
// same unresolved list used for questions that could not be verified.
export function parseProblemExtractionRunOutput(value: unknown): z.infer<typeof problemExtractionSchema> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return problemExtractionSchema.parse(value);
  }
  const record = value as Record<string, unknown>;
  const rawBanks = Array.isArray(record.answerBanks) ? record.answerBanks : [];
  const problems = Array.isArray(record.problems) ? record.problems : [];
  const bankIds = new Set<string>();
  const validBanks: z.infer<typeof answerBankSchema>[] = [];
  const warnings: Array<{ reference: string; reason: string; searched: string[] }> = [];
  const linkedProblems = (id: string) => problems.flatMap((problem) => {
    if (!problem || typeof problem !== "object" || Array.isArray(problem)) return [];
    const item = problem as Record<string, unknown>;
    return item.answerBankId === id && typeof item.number === "string" ? [item.number] : [];
  });
  for (const [index, rawBank] of rawBanks.entries()) {
    const parsed = answerBankSchema.safeParse(rawBank);
    const id = rawBank && typeof rawBank === "object" && !Array.isArray(rawBank)
      ? (rawBank as Record<string, unknown>).id
      : null;
    const bankId = typeof id === "string" && id.trim() ? id : null;
    if (parsed.success && parsed.data.title.trim() && parsed.data.markdown.trim() && !bankIds.has(parsed.data.id)) {
      bankIds.add(parsed.data.id);
      validBanks.push(parsed.data);
      continue;
    }
    const numbers = bankId ? linkedProblems(bankId) : [];
    warnings.push({
      reference: bankId ? `Answer bank ${bankId}` : `Answer bank ${index + 1}`,
      reason: `This answer bank was invalid${numbers.length ? ` for problem${numbers.length === 1 ? "" : "s"} ${numbers.join(", ")}` : ""}. Check the source page for its choices.`,
      searched: [],
    });
  }
  if (record.answerBanks !== undefined && !Array.isArray(record.answerBanks)) {
    warnings.push({ reference: "Answer banks", reason: "The answer bank list was invalid. Check the source pages for its choices.", searched: [] });
  }
  for (const problem of problems) {
    if (!problem || typeof problem !== "object" || Array.isArray(problem)) continue;
    const item = problem as Record<string, unknown>;
    const id = item.answerBankId;
    if (typeof id !== "string" || !id || bankIds.has(id)) continue;
    const reference = `Answer bank ${id}`;
    if (warnings.some((warning) => warning.reference === reference)) continue;
    const numbers = linkedProblems(id);
    warnings.push({
      reference,
      reason: `Problem${numbers.length === 1 ? "" : "s"} ${numbers.join(", ")} reference an answer bank that was not included. Check the source page for its choices.`,
      searched: [],
    });
  }
  const unresolved = Array.isArray(record.unresolved) ? record.unresolved : [];
  const existingReferences = new Set(unresolved.flatMap((item) =>
    item && typeof item === "object" && !Array.isArray(item) && typeof item.reference === "string"
      ? [item.reference] : []));
  return problemExtractionSchema.parse({
    ...record,
    answerBanks: validBanks,
    unresolved: [...unresolved, ...warnings.filter((warning) => !existingReferences.has(warning.reference))],
  });
}

export function parseProblemExtractionOutput(value: unknown): SavedProblemExtraction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return savedProblemExtractionSchema.parse(value);
  const record = value as Record<string, unknown>;
  const problems = Array.isArray(record.problems)
    ? record.problems.map((problem) => {
        if (!problem || typeof problem !== "object" || Array.isArray(problem)) return problem;
        const item = problem as Record<string, unknown>;
        const visual = item.visual && typeof item.visual === "object" && !Array.isArray(item.visual)
          ? { kind: "image", ...(item.visual as Record<string, unknown>) }
          : item.visual ?? null;
        return {
          answerBankId: null,
          table: null,
          missingVisual: null,
          ...item,
          visual,
        };
      })
    : record.problems;
  return savedProblemExtractionSchema.parse({ answerBanks: [], ...record, problems });
}

function outputParser(feature: AgentFeature) {
  if (feature === "directions") return directionsSchema;
  if (feature === "problemExtraction") return problemExtractionSchema;
  if (feature === "answerKey") return answerKeySchema;
  return studyGuideSchema;
}

export function resolveAgentPreferences(
  settings: AppSettings,
  feature: AgentFeature,
  modelOverride?: string,
  reasoningOverride?: z.infer<typeof reasoningEffortSchema>,
) {
  const settingsFeature = feature === "directions" ? "assignmentNavigation" : feature;
  return {
    model: modelOverride ?? settings.featureModels[settingsFeature] ?? settings.defaultModel,
    reasoningEffort:
      reasoningOverride ?? (feature === "problemExtraction" ? "xhigh" : settings.reasoningEffort),
    prompt: settings.prompts[settingsFeature],
  } as const;
}

function schemaForFeature(feature: AgentFeature): unknown {
  return z.toJSONSchema(outputParser(feature), { target: "draft-7" });
}

export function compactEventForLog(event: ThreadEvent): unknown {
  if (
    event.type === "item.started" ||
    event.type === "item.updated" ||
    event.type === "item.completed"
  ) {
    const summary = event.type === "item.completed"
      ? summarizeItem(event)
      : event.item.type === "reasoning"
        ? "Reasoning about inspected evidence"
        : `${event.item.type.replaceAll("_", " ")} in progress`;
    return { type: event.type, item: { type: event.item.type, summary } };
  }
  return event;
}

export function sanitizeStoredAgentEvents(events: unknown[]): unknown[] {
  return events.map((event) => {
    if (!event || typeof event !== "object") return event;
    const record = event as Record<string, unknown>;
    const item = record.item;
    if (!item || typeof item !== "object") return event;
    const itemRecord = item as Record<string, unknown>;
    const type = typeof itemRecord.type === "string" ? itemRecord.type : "agent_item";
    const summary = type === "reasoning"
      ? "Reasoning about inspected evidence"
      : type === "command_execution"
        ? "Scoped assignment tool activity"
        : type === "agent_message"
          ? "Structured result activity"
          : typeof itemRecord.summary === "string"
            ? itemRecord.summary
            : `${type.replaceAll("_", " ")} activity`;
    return { type: record.type, item: { type, summary } };
  });
}

function summarizeItem(event: Extract<ThreadEvent, { type: "item.completed" }>): string {
  const item = event.item;
  if (item.type === "command_execution") return "Scoped assignment tool completed";
  if (item.type === "agent_message") return "Structured result prepared";
  if (item.type === "reasoning") return "Reasoning about inspected evidence completed";
  if (item.type === "error") return item.message;
  return item.type.replaceAll("_", " ");
}
