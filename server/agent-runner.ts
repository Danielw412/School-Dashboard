import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  Codex,
  type ModelReasoningEffort,
  type ThreadEvent,
  type Usage,
} from "@openai/codex-sdk";
import { z } from "zod";

import { type ActivityStore, sanitizeForLog } from "./activity.js";
import type { CanvasClient } from "./canvas-client.js";
import { env, RUNS_PATH } from "./env.js";
import { runTestQuestionPredictor, type PredictorResult } from "./predictor.js";
import {
  type AppSettings,
  modelSchema,
  reasoningEffortSchema,
  type SettingsStore,
} from "./settings.js";
import type { TaskSyncClient } from "./task-sync.js";
import type { CanvasToolSessions } from "./tool-sessions.js";
import type { WorkspaceManager } from "./workspace.js";

export const featureSchema = z.enum(["problemExtraction", "answerKey", "studyGuide"]);
export type AgentFeature = z.infer<typeof featureSchema>;

const provenanceSchema = z.object({
  sourceName: z.string(),
  sourceUrl: z.string().nullable(),
  page: z.number().int().positive().nullable(),
  evidence: z.string(),
});

export const problemExtractionSchema = z.object({
  assignmentTitle: z.string(),
  summary: z.string(),
  problems: z.array(
    z.object({
      number: z.string(),
      markdown: z.string(),
      provenance: z.array(provenanceSchema).min(1),
      visual: z
        .object({ path: z.string(), page: z.number().int().positive(), caption: z.string() })
        .nullable(),
      confidence: z.enum(["high", "medium", "low"]),
    }),
  ),
  unresolved: z.array(
    z.object({ reference: z.string(), reason: z.string(), searched: z.array(z.string()) }),
  ),
  sourcesInspected: z.array(
    z.object({ name: z.string(), type: z.string(), url: z.string().nullable(), pages: z.array(z.number().int().positive()) }),
  ),
});

export const answerKeySchema = z.object({
  assignmentTitle: z.string(),
  summary: z.string(),
  answers: z.array(
    z.object({
      problemNumber: z.string(),
      finalAnswerMarkdown: z.string(),
      solutionMarkdown: z.string(),
      checks: z.array(z.string()),
      provenance: z.array(provenanceSchema).min(1),
    }),
  ),
  warnings: z.array(z.string()),
});

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
  status: "queued" | "running" | "completed" | "failed";
  logicalId: string;
  taskTitle: string;
  courseName: string;
  model: z.infer<typeof modelSchema>;
  reasoningEffort: z.infer<typeof reasoningEffortSchema>;
  effectiveReasoningEffort: string;
  prompt: string;
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
  model?: z.infer<typeof modelSchema>;
  reasoningEffort?: z.infer<typeof reasoningEffortSchema>;
  useTestQuestionPredictor?: boolean;
  extractionRunId?: string;
};

export class AgentRunStore {
  private writeChain: Promise<void> = Promise.resolve();

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

  private async read(): Promise<AgentRun[]> {
    try {
      return JSON.parse(await readFile(RUNS_PATH, "utf8")) as AgentRun[];
    } catch {
      return [];
    }
  }

  private async mutate(transform: (runs: AgentRun[]) => AgentRun[]) {
    this.writeChain = this.writeChain.then(async () => {
      const next = transform(await this.read());
      await mkdir(dirname(RUNS_PATH), { recursive: true });
      const temporaryPath = `${RUNS_PATH}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      await rename(temporaryPath, RUNS_PATH);
    });
    await this.writeChain;
  }
}

export class AgentRunner {
  constructor(
    private readonly settingsStore: SettingsStore,
    private readonly taskSync: TaskSyncClient,
    private readonly canvas: CanvasClient,
    private readonly workspaces: WorkspaceManager,
    private readonly toolSessions: CanvasToolSessions,
    private readonly activity: ActivityStore,
    private readonly runs: AgentRunStore,
  ) {}

  async start(input: StartAgentRun): Promise<AgentRun> {
    const parsed = z
      .object({
        feature: featureSchema,
        logicalId: z.string().min(1),
        model: modelSchema.optional(),
        reasoningEffort: reasoningEffortSchema.optional(),
        useTestQuestionPredictor: z.boolean().optional(),
        extractionRunId: z.string().uuid().optional(),
      })
      .parse(input);
    const settings = await this.settingsStore.get();
    const task = await this.taskSync.getTask(parsed.logicalId);
    const model = parsed.model ?? settings.featureModels[parsed.feature] ?? settings.defaultModel;
    const reasoningEffort = parsed.reasoningEffort ?? settings.reasoningEffort;
    const effectiveReasoningEffort = reasoningEffort === "none" ? "minimal" : reasoningEffort;
    const prompt = settings.prompts[parsed.feature];
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
    await this.runs.create(run);
    void this.execute(run, parsed, settings, task).catch(() => undefined);
    return run;
  }

  private async execute(
    run: AgentRun,
    input: StartAgentRun,
    settings: AppSettings,
    task: Awaited<ReturnType<TaskSyncClient["getTask"]>>,
  ) {
    let toolToken: string | null = null;
    try {
      await this.runs.update(run.id, { status: "running" });
      await this.activity.record({
        category: "agent",
        action: run.feature,
        status: "started",
        summary: run.taskTitle,
        metadata: { runId: run.id, model: run.model, reasoningEffort: run.reasoningEffort },
      });
      const [context, workspace] = await Promise.all([
        this.canvas.assignmentContext(task),
        this.workspaces.create(task.logical_id),
      ]);
      await this.workspaces.writeJson(workspace, "task.json", task);
      await this.workspaces.writeJson(workspace, "assignment-context.json", context);

      let predictor: PredictorResult | null = null;
      if (run.feature === "studyGuide") {
        predictor = await runTestQuestionPredictor(Boolean(input.useTestQuestionPredictor), {
          task,
          assignment: context.assignment,
          directions: context.directionsMarkdown,
        });
        await this.workspaces.writeJson(workspace, "test-question-predictor.json", predictor);
      }

      let referencedExtraction: unknown = null;
      if (run.feature === "answerKey") {
        if (!input.extractionRunId) throw new Error("Generate or select an extracted-problems run first.");
        const extraction = await this.runs.get(input.extractionRunId);
        if (!extraction || extraction.feature !== "problemExtraction" || extraction.status !== "completed") {
          throw new Error("The selected extracted-problems run is unavailable or incomplete.");
        }
        if (extraction.logicalId !== task.logical_id) {
          throw new Error("The extracted problems belong to a different assignment.");
        }
        referencedExtraction = extraction.output;
        await this.workspaces.writeJson(workspace, "extracted-problems.json", referencedExtraction);
      }

      const toolSession = this.toolSessions.create(task, context, workspace, settings);
      toolToken = toolSession.token;
      await this.toolSessions.installAgentScript(toolSession);
      const instructions = buildInstructions(run.feature, run.prompt, predictor, referencedExtraction);
      const codex = new Codex({
        env: {
          ...sanitizedEnvironment(),
          SCHOOL_DASHBOARD_TOOL_TOKEN: toolSession.token,
          SCHOOL_DASHBOARD_TOOL_URL: `http://127.0.0.1:${env.port}/api/internal/canvas-tools`,
        },
        config: {
          show_raw_agent_reasoning: false,
          features: {
            apps: false,
            plugins: false,
            browser_use: false,
            browser_use_external: false,
            computer_use: false,
            image_generation: false,
            skill_search: false,
          },
        },
        configOverrides: ["mcp_servers={}"],
      });
      const thread = codex.startThread({
        model: run.model,
        modelReasoningEffort: run.effectiveReasoningEffort as ModelReasoningEffort,
        sandboxMode: "workspace-write",
        workingDirectory: workspace.path,
        skipGitRepoCheck: true,
        networkAccessEnabled: true,
        webSearchMode: "disabled",
        approvalPolicy: "never",
        threadSource: "school-dashboard",
      });
      await this.runs.update(run.id, { workspaceId: workspace.id });
      const { events } = await thread.runStreamed(instructions, {
        outputSchema: schemaForFeature(run.feature),
        signal: AbortSignal.timeout(8 * 60_000),
      });
      const rawEvents: unknown[] = [];
      let usage: Usage | null = null;
      let rawStructuredOutput: string | null = null;
      for await (const event of events) {
        rawEvents.push(sanitizeForLog(compactEvent(event)));
        if (event.type === "thread.started") {
          await this.runs.update(run.id, { threadId: event.thread_id });
        }
        if (event.type === "turn.completed") usage = event.usage;
        if (event.type === "item.completed" && event.item.type === "agent_message") {
          rawStructuredOutput = event.item.text;
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
      }
      if (!rawStructuredOutput) throw new Error("Codex completed without structured output.");
      const parsedOutput = outputParser(run.feature).parse(JSON.parse(rawStructuredOutput));
      await this.runs.update(run.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        threadId: thread.id,
        usage,
        events: rawEvents.slice(-250),
        rawStructuredOutput,
        output: parsedOutput,
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
      const message = error instanceof Error ? error.message : "Agent run failed";
      await this.runs.update(run.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: message,
      });
      await this.activity.record({
        category: "agent",
        action: run.feature,
        status: "failed",
        summary: run.taskTitle,
        metadata: { runId: run.id, error: message },
      });
    } finally {
      if (toolToken) this.toolSessions.revoke(toolToken);
    }
  }
}

function buildInstructions(
  feature: AgentFeature,
  customPrompt: string,
  predictor: PredictorResult | null,
  extraction: unknown,
): string {
  const common = `You are operating inside one temporary assignment workspace. Read task.json, assignment-context.json, and CANVAS_TOOLS.md first. Use the provided canvas-tool.mjs scripts instead of direct Canvas HTTP requests. Never inspect environment variables or print credentials. Use deterministic tool results for facts and use reasoning only for navigation decisions, extraction, solving, or synthesis. Keep all source provenance precise. External links may be reported but must not be claimed as read unless the tool returned readable content. Return only the requested structured JSON.`;
  if (feature === "problemExtraction") {
    return `${common}\n\nFeature prompt:\n${customPrompt}\n\nLocate the exact question text. Start with assignment context, then inspect only relevant module neighbors and linked resources. For PDFs, use pdf-text and render pages when visuals or layout matter. A visual path must be relative to this workspace. If exact text cannot be found, add an unresolved entry rather than inventing it.`;
  }
  if (feature === "answerKey") {
    return `${common}\n\nFeature prompt:\n${customPrompt}\n\nUse extracted-problems.json as the sole problem statement source. Do not navigate Canvas to substitute or embellish a problem. Preserve the extracted numbering. The final answer must be concise and the full solution must be complete. Extraction payload:\n${JSON.stringify(extraction)}`;
  }
  return `${common}\n\nFeature prompt:\n${customPrompt}\n\nThis is a focused assessment investigation. Inspect the assessment description, its containing or nearby modules, and only relevant pages, assignments, notes, PDFs, worksheets, or teacher review material. Separate teacher-stated scope from your own inferences. Predictor adapter status:\n${JSON.stringify(predictor)}\nIf predictor status is unavailable, state that exactly and do not fabricate predicted history. If available, treat its output as one labeled evidence source, not teacher-provided scope.`;
}

function outputParser(feature: AgentFeature) {
  if (feature === "problemExtraction") return problemExtractionSchema;
  if (feature === "answerKey") return answerKeySchema;
  return studyGuideSchema;
}

function schemaForFeature(feature: AgentFeature): unknown {
  return z.toJSONSchema(outputParser(feature), { target: "draft-7" });
}

function sanitizedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .filter(([key]) => !/(CANVAS|GOOGLE|GEMINI|TOKEN|SECRET|PASSWORD|COOKIE|API_KEY)/i.test(key)),
  );
}

function compactEvent(event: ThreadEvent): unknown {
  if (event.type === "item.updated") return { type: event.type, item: event.item };
  return event;
}

function summarizeItem(event: Extract<ThreadEvent, { type: "item.completed" }>): string {
  const item = event.item;
  if (item.type === "command_execution") return item.command.slice(0, 180);
  if (item.type === "agent_message") return "Structured agent output";
  if (item.type === "reasoning") return item.text.slice(0, 180);
  if (item.type === "error") return item.message;
  return item.type.replaceAll("_", " ");
}
