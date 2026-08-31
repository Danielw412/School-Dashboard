import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

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
        .nullable()
        .describe("Null unless the question requires a supplied figure, diagram, graph, table, map, image, or other non-text visual to be understood or solved."),
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
      const runs = sanitizeForLog(JSON.parse(await readFile(RUNS_PATH, "utf8"))) as AgentRun[];
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
      await this.activity.record({
        category: "agent",
        action: "workspace.prepare",
        status: "started",
        summary: run.taskTitle,
        metadata: { runId: run.id },
      });
      const workspace = await this.workspaces.create(task.logical_id);
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
          recoveredSourceContext: context.sourceContext,
          moduleNeighborhood: null,
          directionsEvidenceSufficient:
            run.feature === "directions" && directionsEvidenceSufficient(task, context),
        };
        const courseId = task.canvas.course_id ?? task.course.canvas_course_id;
        if (courseId && context.assignment?.id) {
          try {
            preflight.moduleNeighborhood = await this.canvas.getModuleItemSequence(
              courseId,
              "Assignment",
              String(context.assignment.id),
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
      const instructions = buildInstructions(run.feature, run.prompt, predictor);
      const configuredMcpServers = await configuredMcpServerNames();
      const codex = new Codex({
        env: {
          ...sanitizedEnvironment(),
          ...(toolSession ? {
            SCHOOL_DASHBOARD_TOOL_TOKEN: toolSession.token,
          } : {}),
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
            shell_tool: !toolSession,
          },
        },
        configOverrides: buildMcpConfigOverrides(Boolean(toolSession), env.port, configuredMcpServers),
      });
      const thread = codex.startThread({
        model: run.model,
        modelReasoningEffort: run.effectiveReasoningEffort as ModelReasoningEffort,
        sandboxMode: "read-only",
        workingDirectory: workspace.path,
        skipGitRepoCheck: true,
        networkAccessEnabled: run.feature !== "answerKey",
        webSearchMode: "disabled",
        approvalPolicy: "never",
        threadSource: "school-dashboard",
      });
      await this.activity.record({
        category: "agent",
        action: "codex.start",
        status: "completed",
        summary: run.taskTitle,
        metadata: { runId: run.id, workspace: workspace.id, model: run.model },
      });
      await this.runs.update(run.id, { workspaceId: workspace.id });
      const { events } = await thread.runStreamed(instructions, {
        outputSchema: schemaForFeature(run.feature),
        signal: AbortSignal.timeout(run.feature === "problemExtraction" ? 15 * 60_000 : 8 * 60_000),
      });
      const rawEvents: unknown[] = [];
      let usage: Usage | null = null;
      let rawStructuredOutput: string | null = null;
      for await (const event of events) {
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
      }
      if (!rawStructuredOutput) throw new Error("Codex completed without structured output.");
      const parsedOutput = outputParser(run.feature).parse(JSON.parse(rawStructuredOutput));
      const policyCheckedOutput = run.feature === "problemExtraction"
        ? enforceProblemVisualPolicy(problemExtractionSchema.parse(parsedOutput))
        : parsedOutput;
      const safeOutput = sanitizeForLog(policyCheckedOutput);
      const safeRawStructuredOutput = JSON.stringify(safeOutput);
      await this.runs.update(run.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        threadId: thread.id,
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
    const parsed = problemExtractionSchema.parse(extraction.output);
    const problems = await Promise.all(parsed.problems.map(async (problem, index) => {
      if (!problem.visual) {
        return { number: problem.number, markdown: problem.markdown, visual: null };
      }
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
      return {
        number: problem.number,
        markdown: problem.markdown,
        visual: { ...problem.visual, path },
      };
    }));
    return { assignmentTitle: parsed.assignmentTitle, problems };
  }
}

export function buildInstructions(
  feature: AgentFeature,
  customPrompt: string,
  predictor: PredictorResult | null,
): string {
  const workspaceRules = `You are operating inside one temporary assignment workspace. Do not inspect skills, plugins, MCP servers, browser tools, repositories, environment variables, or files outside this workspace. Return only the requested structured JSON.`;
  const canvasRules = `Call get_preloaded_context exactly once first. Treat its task, assignment context, sourceContext, and preflight data as authoritative. If they answer the request, stop immediately without another retrieval. Use only structured school_dashboard tools for missing information; shell access is disabled, and you must never invoke Canvas through PowerShell, shell commands, JavaScript helpers, direct HTTP, or handwritten JSON. Prefer direct URLs and known assignment/file/page/module identifiers, then source-anchor/source-text recovery, and only then one focused course search. Use the authenticated Chrome-extension tool only for an already-known linked resource that Canvas cannot read, never for discovery. Do not repeat a failed URL or retry a failed operation with near-identical wording. External links may be reported but must not be claimed as read unless a structured tool returned readable content.`;
  const pdfRules = `For every unfamiliar PDF, call index_pdf once with any requested problem numbers. Use cached text and detected problem sections first. Create a low-resolution contact sheet only when the index cannot narrow candidate pages; a contact sheet created inside batch_canvas_operations is already displayed, so never call it again. For every scanned document over four pages, pass only contact-sheet-selected candidate pages into detect_pdf_problems. Do not call ocr_pdf_pages for pages already processed by detection. Never OCR broad page ranges: OCR only unresolved likely pages whose text layer is missing or unusable. Render one targeted page only when needed to verify unclear text/OCR. If detection returned every requested section and a required semantic crop completed, do not render that page merely to verify the same evidence again. Crop and return an image only when a required non-text visual must appear in the final problem. Reuse cached outputs, batch independent operations, and stop when exact requested content is sufficiently verified.`;
  if (feature === "directions") {
    return `${workspaceRules}\n${canvasRules}\n\nFeature prompt:\n${customPrompt}\n\nMandatory Directions scope: determine only the assigned work, relevant instructions, submission requirements, and due date. If preflight.directionsEvidenceSufficient is true, answer immediately from the preloaded data; every other retrieval tool is intentionally unavailable. For agenda/table tasks, treat sourceContext.contextMarkdown and sourceContext.cells as the relevant surrounding row, not merely the classified homework sentence: preserve exact due times, submission method, required materials, related links, and nearby instructions. If resolution is missing or incomplete, call recover_canvas_context once; it uses the task title, source sentence, source anchor, source/page metadata, and direct URLs. If the relevant context directly references instructions, directions, guidelines, a rubric, requirements, a checklist, or criteria, read only the minimum directly relevant linked resource(s) needed before finalizing and prefer those direct links over any course search. If a known required link is external or API-inaccessible, use read_linked_resource_with_chrome once for that URL. Do not search the course while a directly relevant instruction link is already known, do not open unrelated links, do not open or inspect PDF/file question content in Directions, and do not search broadly. Stop immediately once assigned work, submission method, due information, and explicitly referenced instructions are sufficiently verified. Everything in the response must be a brief Luna-authored paraphrase, never raw Canvas HTML: overviewMarkdown is at most two short sentences; use no more than five instructions; keep assigned-work items exact and terse; make submission.methodMarkdown one short sentence; use short deliverable phrases; and make dueMarkdown the concise verified date/time. Never include attempt counts, solve problems, repeat facts, or invent missing details.`;
  }
  if (feature === "problemExtraction") {
    return `${workspaceRules}\n${canvasRules}\n${pdfRules}\n\nFeature prompt:\n${customPrompt}\n\nLocate the exact question text. Start with direct assignment/source links and recovered source context, then inspect only relevant module neighbors and linked resources. Prefer a known PDF/file URL or file ID over file listing or course search. Treat a linked answer key only as a cross-check; never use it as the source of a problem statement. Request independent Canvas resources together when possible. Set visual to null by default. A visual is allowed if and only if the problem requires a supplied figure, diagram, graph, table, map, or other non-text image to understand or solve it; a source-page screenshot is not provenance and must never be attached merely because the question came from a PDF. A targeted page render may be inspected to correct unclear OCR, but it must not be attached to a text-only problem. When a visual is required, call semantic_crop_pdf once with the exact figure or diagram label whenever one exists; its completed output is the final crop and must not be cropped again. The tool skips ordinary text queries, so never send problem text merely to obtain a screenshot. Only if a genuinely required unlabeled visual returns not_found may you use known render coordinates once. Do not retry near-identical semantic queries. Do not crop or attach text-only problems. Write inline math with $...$ and display math with $$...$$. Stop as soon as every requested problem is verified; if exact text cannot be found, add an unresolved entry rather than continuing broad searches or inventing it.`;
  }
  if (feature === "answerKey") {
    return `${workspaceRules}\nRead only extracted-problems.json and the local visual paths named inside it. You have no Canvas helper or network access for this feature.\n\nFeature prompt:\n${customPrompt}\n\nMandatory Answer Key rules: use only each parsed question in extracted-problems.json and inspect its attached visual whenever it affects the question. Do not navigate Canvas, cite extracted provenance, or mention sources. Preserve problem numbering. Return a concise final answer and a complete solution using Markdown and LaTeX only. Never emit HTML tags such as <details>, <summary>, or heading tags. Silently verify the work, but do not generate a checks list or green-check commentary. These rules override any conflicting wording in the customizable feature prompt.`;
  }
  return `${workspaceRules}\n${canvasRules}\n${pdfRules}\n\nFeature prompt:\n${customPrompt}\n\nThis is a focused assessment investigation. Inspect the assessment description, its containing or nearby modules, and only relevant pages, assignments, notes, PDFs, worksheets, or teacher review material. Separate teacher-stated scope from your own inferences. Predictor adapter status:\n${JSON.stringify(predictor)}\nIf predictor status is unavailable, state that exactly and do not fabricate predicted history. If available, treat its output as one labeled evidence source, not teacher-provided scope.`;
}

const BUILTIN_MCP_SERVERS = ["node_repl", "openaiDeveloperDocs", "cua_repl"];

export function buildMcpConfigOverrides(
  enabled: boolean,
  port: number,
  configuredServers: string[] = [],
): string[] {
  const overrides = [...new Set([...BUILTIN_MCP_SERVERS, ...configuredServers])]
    .filter((name) => name !== "school_dashboard" && /^[A-Za-z0-9_-]+$/u.test(name))
    .map((name) => `mcp_servers.${name}.enabled=false`);
  if (!enabled) return overrides;
  const url = JSON.stringify(`http://127.0.0.1:${port}/api/internal/canvas-mcp`);
  return [
    ...overrides,
    `mcp_servers.school_dashboard.url=${url}`,
    'mcp_servers.school_dashboard.bearer_token_env_var="SCHOOL_DASHBOARD_TOOL_TOKEN"',
    "mcp_servers.school_dashboard.required=true",
    "mcp_servers.school_dashboard.startup_timeout_sec=10",
    "mcp_servers.school_dashboard.tool_timeout_sec=240",
    'mcp_servers.school_dashboard.default_tools_approval_mode="auto"',
  ];
}

export async function configuredMcpServerNames(
  configPath = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml"),
): Promise<string[]> {
  try {
    const config = await readFile(configPath, "utf8");
    const names = new Set<string>();
    const pattern = /^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))(?:\.[^\]]+)?\]\s*$/gmu;
    for (const match of config.matchAll(pattern)) names.add(match[1] ?? match[2]!);
    return [...names];
  } catch {
    return [];
  }
}

export function problemRequiresVisual(markdown: string): boolean {
  const visual = String.raw`(?:figure|fig\.?|diagram|graph|chart|table|map|illustration|photo|circuit|free[- ]body diagram)`;
  return new RegExp(String.raw`\b(?:use|using|from|according to|refer(?:ring)? to)\s+(?:the\s+)?${visual}\b`, "iu").test(markdown) ||
    new RegExp(String.raw`\b(?:following|provided|attached)\s+${visual}\b`, "iu").test(markdown) ||
    new RegExp(String.raw`\b${visual}\s+(?:above|below|shown|provided|attached|depicts?|illustrates?|shows?|lists?)\b`, "iu").test(markdown) ||
    /\b(?:figure|fig\.?)\s*[A-Z]?\d+(?:\.\d+)?\b/iu.test(markdown) ||
    new RegExp(String.raw`\b(?:shown|depicted|pictured|illustrated)\s+(?:above|below|in|on)\s+(?:the\s+)?${visual}\b`, "iu").test(markdown) ||
    /\b(?:as\s+)?(?:shown|depicted|pictured|illustrated)\s+(?:above|below)\b/iu.test(markdown);
}

export function enforceProblemVisualPolicy(
  output: z.infer<typeof problemExtractionSchema>,
): z.infer<typeof problemExtractionSchema> {
  return {
    ...output,
    problems: output.problems.map((problem) => ({
      ...problem,
      visual: problem.visual && problemRequiresVisual(problem.markdown) ? problem.visual : null,
    })),
  };
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
  modelOverride?: z.infer<typeof modelSchema>,
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

function sanitizedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .filter(([key]) => !/(CANVAS|GOOGLE|GEMINI|TOKEN|SECRET|PASSWORD|COOKIE|API_KEY)/i.test(key)),
  );
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
