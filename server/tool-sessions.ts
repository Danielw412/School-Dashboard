import { randomBytes } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { basename, relative } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { sanitizeForLog, type ActivityStore } from "./activity.js";
import type { AssignmentContext, CanvasClient } from "./canvas-client.js";
import { APP_ROOT } from "./env.js";
import type { AppSettings } from "./settings.js";
import type { TrackedTask } from "./task-sync.js";
import {
  type AssignmentWorkspace,
  safeChild,
  type WorkspaceManager,
} from "./workspace.js";

type ToolSession = {
  token: string;
  task: TrackedTask;
  context: AssignmentContext;
  workspace: AssignmentWorkspace;
  settings: AppSettings;
  expiresAt: number;
  allowMutation: boolean;
  runId: string | null;
  profile: "standard" | "directions";
  preflight: Record<string, unknown>;
  cache: Map<string, Promise<unknown>>;
};

type McpConnection = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  ready: Promise<void>;
};

const objectInput = z.record(z.string(), z.unknown()).default({});

export class CanvasToolSessions {
  private readonly sessions = new Map<string, ToolSession>();
  private readonly mcpConnections = new Map<string, McpConnection>();

  constructor(
    private readonly canvas: CanvasClient,
    private readonly workspaces: WorkspaceManager,
    private readonly activity: ActivityStore,
  ) {}

  create(
    task: TrackedTask,
    context: AssignmentContext,
    workspace: AssignmentWorkspace,
    settings: AppSettings,
    options?: {
      allowMutation?: boolean;
      ttlMinutes?: number;
      runId?: string;
      profile?: "standard" | "directions";
      preflight?: Record<string, unknown>;
    },
  ): ToolSession {
    this.pruneExpired();
    const token = randomBytes(32).toString("base64url");
    const session: ToolSession = {
      token,
      task,
      context,
      workspace,
      settings,
      expiresAt: Date.now() + (options?.ttlMinutes ?? 45) * 60_000,
      allowMutation: options?.allowMutation ?? false,
      runId: options?.runId ?? null,
      profile: options?.profile ?? "standard",
      preflight: options?.preflight ?? {},
      cache: new Map(),
    };
    this.sessions.set(token, session);
    return session;
  }

  revoke(token: string) {
    this.sessions.delete(token);
    const connection = this.mcpConnections.get(token);
    this.mcpConnections.delete(token);
    if (connection) void Promise.allSettled([connection.transport.close(), connection.server.close()]);
  }

  async handleMcp(
    token: string | undefined,
    request: IncomingMessage,
    response: ServerResponse,
    body: unknown,
  ) {
    if (!token) throw new ToolAuthorizationError("Missing Canvas tool capability.");
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      this.revoke(token);
      throw new ToolAuthorizationError("Canvas tool capability is invalid or expired.");
    }
    let connection = this.mcpConnections.get(token);
    if (!connection) {
      connection = this.createMcpConnection(session);
      this.mcpConnections.set(token, connection);
    }
    await connection.ready;
    await connection.transport.handleRequest(request, response, body);
  }

  async installAgentScript(session: ToolSession): Promise<string> {
    const path = safeChild(session.workspace.path, "canvas-tool.mjs");
    await copyFile(safeChild(APP_ROOT, "scripts/canvas-tool.mjs"), path);
    await writeFile(
      safeChild(session.workspace.path, "CANVAS_TOOLS.md"),
      toolDocumentation(session.profile),
      "utf8",
    );
    return path;
  }

  async execute(token: string | undefined, rawAction: unknown, rawInput: unknown): Promise<unknown> {
    if (!token) throw new ToolAuthorizationError("Missing Canvas tool capability.");
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      throw new ToolAuthorizationError("Canvas tool capability is invalid or expired.");
    }
    const action = z.string().min(1).parse(rawAction);
    const input = objectInput.parse(rawInput);
    requireProfileAction(session, action);
    const courseId = session.task.canvas.course_id ?? session.task.course.canvas_course_id;
    const assignmentId =
      session.context.assignment?.id?.toString() ?? session.task.canvas.assignment_id ?? null;

    await this.activity.record({
      category: "agent",
      action: `canvas_tool.${action}`,
      status: "started",
      summary: session.task.display_title,
      metadata: { workspace: session.workspace.id, runId: session.runId },
    });

    try {
      const result: unknown = await (async (): Promise<unknown> => {
        switch (action) {
      case "preloaded-context":
        return {
          task: session.task,
          assignmentContext: session.context,
          preflight: session.preflight,
        };
      case "context":
      case "assignment":
      case "submission-requirements":
        return {
          task: session.task,
          assignment: session.context.assignment,
          directionsMarkdown: session.context.directionsMarkdown,
          links: session.context.links,
          submissionRequirements: session.context.submissionRequirements,
          externalAssignment: session.context.externalAssignment,
          resolution: session.context.resolution,
        };
      case "recover-context": {
        const sourceContext = await sessionCached(session, "recover-context", () =>
          this.canvas.recoverTaskSourceContext(session.task, courseId ?? undefined));
        return {
          taskIdentifiers: taskRecoveryIdentifiers(session.task),
          assignment: session.context.assignment,
          resolution: session.context.resolution,
          sourceContext: sourceContext ?? session.context.sourceContext,
          directLinks: directTaskLinks(session.task, session.context),
        };
      }
      case "search": {
        requireCourse(courseId);
        const query = z.string().min(1).parse(input.query);
        return sessionCached(session, `search:${query}`, () => this.canvas.searchCourse(courseId, query));
      }
      case "course":
        requireCourse(courseId);
        return sessionCached(session, "course", () => this.canvas.getCourse(courseId));
      case "pages":
        requireCourse(courseId);
        return sessionCached(session, `pages:${String(input.query ?? "")}`, () => this.canvas.listPages(
            courseId,
            input.query === undefined ? undefined : z.string().min(1).parse(input.query),
          ));
      case "files":
        requireCourse(courseId);
        return sessionCached(session, `files:${String(input.query ?? "")}`, () => this.canvas.listFiles(
            courseId,
            input.query === undefined ? undefined : z.string().min(1).parse(input.query),
          ));
      case "modules":
        requireCourse(courseId);
        return sessionCached(session, "modules", () => this.canvas.listModules(courseId));
      case "module-items":
        requireCourse(courseId);
        return sessionCached(session, `module-items:${String(input.moduleId)}`, () => this.canvas.listModuleItems(
            courseId,
            z.union([z.string(), z.number()]).parse(input.moduleId).toString(),
          ));
      case "module-neighborhood":
        requireCourse(courseId);
        requireAssignment(assignmentId);
        return this.canvas.getModuleItemSequence(courseId, "Assignment", assignmentId);
      case "page":
        requireCourse(courseId);
        return sessionCached(session, `page:${String(input.slug)}`, () =>
          this.canvas.getPage(courseId, z.string().min(1).parse(input.slug)));
      case "follow": {
        requireCourse(courseId);
        const url = z.string().url().parse(input.url);
        requireCourseScopedUrl(url, courseId);
        return sessionCached(session, `follow:${url}`, () => this.canvas.followLinkedResource(url));
      }
      case "announcements":
        requireCourse(courseId);
        return this.canvas.listAnnouncements(courseId, {
          startDate: input.startDate === undefined ? undefined : z.string().date().parse(input.startDate),
          endDate: input.endDate === undefined ? undefined : z.string().date().parse(input.endDate),
        });
      case "discussion":
        requireCourse(courseId);
        return this.canvas.getDiscussion(
          courseId,
          z.union([z.string(), z.number()]).parse(input.topicId).toString(),
        );
      case "quiz":
        requireCourse(courseId);
        return this.canvas.getQuiz(
          courseId,
          z.union([z.string(), z.number()]).parse(input.quizId).toString(),
        );
      case "quiz-questions":
        requireCourse(courseId);
        return this.canvas.listQuizQuestions(
          courseId,
          z.union([z.string(), z.number()]).parse(input.quizId).toString(),
        );
      case "file":
        return sessionCached(session, `file:${String(input.fileId)}`, () =>
          this.canvas.getFile(z.union([z.string(), z.number()]).parse(input.fileId).toString()));
      case "download": {
        const file = await this.canvas.getFile(
          z.union([z.string(), z.number()]).parse(input.fileId).toString(),
        );
        const result = await this.workspaces.cacheCanvasFile(
          this.canvas,
          file,
          session.workspace,
          session.settings,
        );
        return { ...result, path: relative(session.workspace.path, result.path).replaceAll("\\", "/") };
      }
      case "pdf-text": {
        const path = safeChild(session.workspace.path, z.string().min(1).parse(input.path));
        const pages = parsePdfPageSelection(input, false);
        if (!pages) {
          return { path: relative(session.workspace.path, path), pages: null, text: await this.workspaces.extractPdfText(path) };
        }
        return {
          path: relative(session.workspace.path, path),
          pages,
          extracts: await this.workspaces.extractPdfTextPages(path, pages),
        };
      }
      case "pdf-inspect": {
        const path = safeChild(session.workspace.path, z.string().min(1).parse(input.path));
        return {
          path: relative(session.workspace.path, path).replaceAll("\\", "/"),
          ...(await this.workspaces.inspectPdf(path)),
        };
      }
      case "pdf-index": {
        const path = safeChild(session.workspace.path, z.string().min(1).parse(input.path));
        const requestedProblems = z.array(z.string()).max(100).default([]).parse(input.problemNumbers);
        return {
          path: relative(session.workspace.path, path).replaceAll("\\", "/"),
          ...(await this.workspaces.indexPdf(path, requestedProblems)),
        };
      }
      case "pdf-render": {
        const path = safeChild(session.workspace.path, z.string().min(1).parse(input.path));
        const pages = parsePdfRenderPages(input);
        const dpi = input.dpi === undefined ? 170 : z.number().int().min(36).max(300).parse(input.dpi);
        const renders = (await this.workspaces.renderPdfPages(path, pages, session.workspace, 4, dpi)).map(
          (render) => ({
            page: render.page,
            path: relative(session.workspace.path, render.path).replaceAll("\\", "/"),
          }),
        );
        return renders.length === 1
          ? { page: renders[0].page, path: renders[0].path, renders }
          : { renders };
      }
      case "pdf-contact-sheet": {
        const path = safeChild(session.workspace.path, z.string().min(1).parse(input.path));
        const pages = input.pages === undefined
          ? undefined
          : z.array(z.number().int().positive()).min(1).max(20).parse(input.pages);
        const contact = await this.workspaces.createPdfContactSheet(path, session.workspace, pages);
        return {
          pages: contact.pages,
          path: relative(session.workspace.path, contact.path).replaceAll("\\", "/"),
        };
      }
      case "pdf-ocr": {
        const path = safeChild(session.workspace.path, z.string().min(1).parse(input.path));
        const pages = parsePdfPageSelection(input, true)!;
        return {
          pages: await this.workspaces.ocrPdfPages(path, pages, session.workspace),
        };
      }
      case "pdf-detect-problems": {
        const path = safeChild(session.workspace.path, z.string().min(1).parse(input.path));
        const problemNumbers = z.array(z.string()).max(100).default([]).parse(input.problemNumbers);
        const pages = input.pages === undefined
          ? undefined
          : z.array(z.number().int().positive()).min(1).max(80).parse(input.pages);
        return this.workspaces.detectPdfProblems(path, problemNumbers, session.workspace, pages);
      }
      case "image-crop": {
        if (input.crops !== undefined) {
          const crops = z.array(z.object({
            path: z.string().min(1),
            rect: cropRectSchema,
          })).min(1).max(40).parse(input.crops);
          const outputs = await this.workspaces.cropImages(crops, session.workspace);
          return { crops: outputs.map((output) => ({
            sourcePath: output.sourcePath,
            path: relative(session.workspace.path, output.path).replaceAll("\\", "/"),
          })) };
        }
        const path = z.string().min(1).parse(input.path);
        const output = await this.workspaces.cropImage(path, cropRectSchema.parse(input.rect), session.workspace);
        return { path: relative(session.workspace.path, output).replaceAll("\\", "/") };
      }
      case "pdf-semantic-crop": {
        const path = safeChild(session.workspace.path, z.string().min(1).parse(input.path));
        const regions = z.array(z.object({
          page: z.number().int().positive(),
          query: z.string().min(1),
          padding: z.number().int().min(0).max(100).optional(),
        })).min(1).max(20).parse(input.regions);
        const crops = await this.workspaces.semanticCropPdfRegions(path, regions, session.workspace);
        return { crops: crops.map((crop) => ({
          ...crop,
          path: relative(session.workspace.path, crop.path).replaceAll("\\", "/"),
        })) };
      }
      case "batch": {
        const operations = batchOperationsSchema.parse(input.operations);
        const results: Array<{ action: string; status: "completed"; result: unknown } | { action: string; status: "failed"; error: string }> = await Promise.all(operations.map(async (operation) => {
          try {
            return { action: operation.action, status: "completed" as const, result: await this.execute(token, operation.action, operation.input) };
          } catch (error) {
            return { action: operation.action, status: "failed" as const, error: errorMessage(error) };
          }
        }));
        return { results };
      }
      case "upload": {
        requireMutation(session, input);
        requireCourse(courseId);
        requireAssignment(assignmentId);
        const localPath = safeChild(session.workspace.path, z.string().min(1).parse(input.path));
        const bytes = await readFile(localPath);
        const fileId = await this.canvas.uploadSubmissionFile(courseId, assignmentId, basename(localPath), bytes);
        return { fileId };
      }
      case "submit": {
        requireMutation(session, input);
        requireCourse(courseId);
        requireAssignment(assignmentId);
        const submission = z
          .discriminatedUnion("type", [
            z.object({ type: z.literal("online_text_entry"), text: z.string().min(1) }),
            z.object({ type: z.literal("online_url"), url: z.string().url() }),
            z.object({ type: z.literal("online_upload"), fileIds: z.array(z.string()).min(1) }),
          ])
          .parse(input.submission);
        return this.canvas.submitAssignment(courseId, assignmentId, submission);
      }
      default:
        throw new Error(`Unknown Canvas tool action: ${action}`);
        }
      })();
      await this.activity.record({
        category: "agent",
        action: `canvas_tool.${action}`,
        status: "completed",
        summary: session.task.display_title,
        metadata: { workspace: session.workspace.id, runId: session.runId },
      });
      return sanitizeForLog(result);
    } catch (error) {
      await this.activity.record({
        category: "agent",
        action: `canvas_tool.${action}`,
        status: "failed",
        summary: session.task.display_title,
        metadata: {
          workspace: session.workspace.id,
          runId: session.runId,
          error: error instanceof Error ? error.message : "Canvas tool failed",
        },
      });
      throw error;
    }
  }

  private createMcpConnection(session: ToolSession): McpConnection {
    const server = new McpServer(
      { name: "school-dashboard", version: "1.0.0" },
      { instructions: mcpServerInstructions(session.profile) },
    );
    const annotations = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    } as const;
    const register = (
      name: string,
      description: string,
      action: string,
      inputSchema: z.ZodType,
    ) => {
      if (!toolActionAllowed(session.profile, action)) return;
      server.registerTool(name, { description, inputSchema, annotations }, async (args) =>
        toMcpToolResult(
          await this.execute(session.token, action, args),
          imageResultActions.has(action) ? session.workspace.path : null,
        ));
    };

    register(
      "get_preloaded_context",
      "Return the task, resolved assignment context, agenda/source row context, submission requirements, direct links, and module preflight already fetched for this run. Call exactly once before any recovery or search.",
      "preloaded-context",
      z.object({}),
    );
    register(
      "recover_canvas_context",
      "Recover the originating Canvas assignment/page context from the task title, source sentence, anchor, page metadata, and direct URLs. Use before broad search when preloaded resolution is missing or incomplete.",
      "recover-context",
      z.object({}),
    );
    register(
      "follow_canvas_link",
      "Read one directly relevant same-course Canvas URL, including assignment pages, agenda pages, files, module items, discussions, quizzes, or linked revision instructions.",
      "follow",
      z.object({ url: z.string().url() }),
    );
    register(
      "get_canvas_page",
      "Read one known Canvas page by slug. Prefer a slug or direct URL recovered from the task over search.",
      "page",
      z.object({ slug: z.string().min(1) }),
    );
    register(
      "search_canvas_course",
      "Run one focused course search. Use only after direct URLs, source anchors, source text, and known identifiers do not locate the needed resource.",
      "search",
      z.object({ query: z.string().min(2) }),
    );
    register(
      "list_canvas_modules",
      "List module structure when a known assignment reference cannot be resolved from direct identifiers.",
      "modules",
      z.object({}),
    );
    register(
      "get_canvas_module_items",
      "Read the items in one known Canvas module.",
      "module-items",
      z.object({ moduleId: z.union([z.string(), z.number()]) }),
    );
    register(
      "find_canvas_files",
      "Find course files by a specific filename or phrase. Prefer a known file ID or direct file URL.",
      "files",
      z.object({ query: z.string().min(1).optional() }),
    );
    register(
      "get_canvas_file",
      "Get metadata for one known Canvas file ID.",
      "file",
      z.object({ fileId: z.union([z.string(), z.number()]) }),
    );
    register(
      "download_canvas_file",
      "Download one known Canvas file ID into the run workspace. Repeated downloads reuse the cache.",
      "download",
      z.object({ fileId: z.union([z.string(), z.number()]) }),
    );
    register(
      "batch_canvas_operations",
      "Run independent read-only Canvas retrieval operations together. Each result succeeds or fails independently.",
      "batch",
      z.object({ operations: batchOperationsSchema }),
    );
    register(
      "index_pdf",
      "Inspect an unfamiliar PDF once: page count, per-page text quality, structure, likely relevant pages, detected problem numbers, and cheapest recommended representation.",
      "pdf-index",
      z.object({ path: z.string().min(1), problemNumbers: z.array(z.string()).max(100).optional() }),
    );
    register(
      "extract_pdf_text",
      "Extract layout-preserving text for the whole PDF or multiple selected pages in one cached call.",
      "pdf-text",
      pdfPathSelectionSchema(false),
    );
    register(
      "ocr_pdf_pages",
      "OCR multiple scanned or image-heavy PDF pages locally in one batch. Use only when the PDF index says text is missing or unusable.",
      "pdf-ocr",
      pdfPathSelectionSchema(true),
    );
    register(
      "render_pdf_pages",
      "Render multiple selected pages together. Use after indexing and only when visual evidence is required.",
      "pdf-render",
      pdfPathSelectionSchema(true).extend({ dpi: z.number().int().min(36).max(300).optional() }),
    );
    register(
      "create_pdf_contact_sheet",
      "Create a cached low-resolution document overview for fast navigation before expensive full-resolution rendering.",
      "pdf-contact-sheet",
      z.object({ path: z.string().min(1), pages: z.array(z.number().int().positive()).min(1).max(20).optional() }),
    );
    register(
      "detect_pdf_problems",
      "Automatically locate requested or visible problem numbers and extract their sections from worksheet/textbook text, with OCR fallback for scanned pages.",
      "pdf-detect-problems",
      z.object({
        path: z.string().min(1),
        problemNumbers: z.array(z.string()).max(100).optional(),
        pages: z.array(z.number().int().positive()).min(1).max(80).optional(),
      }),
    );
    register(
      "crop_image_regions",
      "Crop one or many already-rendered image regions together. Identical crops reuse cached output.",
      "image-crop",
      z.object({
        path: z.string().min(1).optional(),
        rect: cropRectSchema.optional(),
        crops: z.array(z.object({ path: z.string().min(1), rect: cropRectSchema })).min(1).max(40).optional(),
      }),
    );
    register(
      "semantic_crop_pdf",
      "Locate and crop complete problem, diagram, table, or answer regions by page and semantic query. Uses PDF layout first and OCR layout only when needed; supports batches.",
      "pdf-semantic-crop",
      z.object({
        path: z.string().min(1),
        regions: z.array(z.object({
          page: z.number().int().positive(),
          query: z.string().min(1),
          padding: z.number().int().min(0).max(100).optional(),
        })).min(1).max(20),
      }),
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomBytes(16).toString("hex"),
      enableJsonResponse: true,
    });
    return { server, transport, ready: server.connect(transport) };
  }

  private pruneExpired() {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }
}

export class ToolAuthorizationError extends Error {}

function requireCourse(courseId: string | null | undefined): asserts courseId is string {
  if (!courseId) throw new Error("This task has no Canvas course identifier.");
}

function requireAssignment(assignmentId: string | null): asserts assignmentId is string {
  if (!assignmentId) throw new Error("This task could not be resolved to a Canvas assignment.");
}

function requireCourseScopedUrl(urlValue: string, courseId: string) {
  const url = new URL(urlValue);
  const courseMatch = url.pathname.match(/\/courses\/(\d+)/);
  if (courseMatch && courseMatch[1] !== courseId) {
    throw new ToolAuthorizationError("The linked Canvas resource belongs to a different course.");
  }
}

function requireMutation(session: ToolSession, input: Record<string, unknown>) {
  if (!session.allowMutation || input.confirmed !== true) {
    throw new ToolAuthorizationError("Upload and submission require an explicit user confirmation capability.");
  }
}

const cropRectSchema = z.object({
  left: z.number().int().nonnegative(),
  top: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const batchActionSchema = z.enum([
  "recover-context",
  "search",
  "course",
  "pages",
  "files",
  "modules",
  "module-items",
  "module-neighborhood",
  "page",
  "follow",
  "announcements",
  "discussion",
  "quiz",
  "quiz-questions",
  "file",
  "download",
  "pdf-index",
  "pdf-text",
  "pdf-render",
  "pdf-contact-sheet",
  "pdf-ocr",
  "pdf-detect-problems",
  "image-crop",
  "pdf-semantic-crop",
]);

const batchOperationsSchema = z.array(z.object({
  action: batchActionSchema,
  input: z.record(z.string(), z.unknown()).default({}),
})).min(1).max(12);

function pdfPathSelectionSchema(required: boolean) {
  return z.object({
    path: z.string().min(1),
    page: z.number().int().positive().optional(),
    pages: z.array(z.number().int().positive()).min(1).max(40).optional(),
    range: z.object({ start: z.number().int().positive(), end: z.number().int().positive() }).optional(),
  }).superRefine((value, context) => {
    const selectionCount = [value.page, value.pages, value.range].filter((item) => item !== undefined).length;
    if ((required && selectionCount !== 1) || (!required && selectionCount > 1)) {
      context.addIssue({ code: "custom", message: required
        ? "Choose exactly one of page, pages, or range."
        : "Choose at most one of page, pages, or range." });
    }
    if (value.range && value.range.end < value.range.start) {
      context.addIssue({ code: "custom", path: ["range", "end"], message: "Range end must be at least range start." });
    } else if (value.range && value.range.end - value.range.start + 1 > 40) {
      context.addIssue({ code: "custom", path: ["range"], message: "A page range may contain at most 40 pages." });
    }
  });
}

async function sessionCached<T>(session: ToolSession, key: string, factory: () => Promise<T>): Promise<T> {
  const existing = session.cache.get(key);
  if (existing) return existing as Promise<T>;
  const pending = factory().catch((error) => {
    session.cache.delete(key);
    throw error;
  });
  session.cache.set(key, pending);
  return pending;
}

function taskRecoveryIdentifiers(task: TrackedTask) {
  return {
    taskTitle: task.title,
    displayTitle: task.display_title,
    details: task.details,
    sourceText: task.source.text,
    sourceAnchor: task.source.anchor,
    sourceKey: task.source.key,
    sourceType: task.source.type,
    sourceDate: task.source_date ?? null,
    courseId: task.canvas.course_id ?? task.course.canvas_course_id ?? null,
    assignmentId: task.canvas.assignment_id ?? null,
  };
}

function directTaskLinks(task: TrackedTask, context: AssignmentContext): string[] {
  return [...new Set([
    task.canvas.assignment_url,
    task.source.assignment_url,
    task.source.url,
    context.assignment?.html_url,
    ...context.links.map((link) => link.url),
    ...(context.sourceContext?.links.map((link) => link.url) ?? []),
  ].filter((value): value is string => Boolean(value)))];
}

function mcpServerInstructions(profile: ToolSession["profile"]): string {
  const common = "Use direct Canvas URLs and known IDs first, then recovered source context, then one focused search. Index each PDF once. Prefer cached text, then contact-sheet/rendered vision, then OCR only for unusable text. Batch independent operations. Stop once the requested facts or problem text are sufficiently verified. All tools are assignment/course scoped and read-only.";
  return profile === "directions"
    ? `${common} Directions may recover and follow only directly relevant Canvas context; file/PDF content inspection is intentionally unavailable.`
    : `${common} For problem extraction, use automatic problem detection before manual page inspection and semantic crops before full-page visuals.`;
}

const imageResultActions = new Set([
  "pdf-render",
  "pdf-contact-sheet",
  "image-crop",
  "pdf-semantic-crop",
]);

async function toMcpToolResult(value: unknown, workspacePath: string | null) {
  const structuredContent = value && typeof value === "object"
    ? value as Record<string, unknown>
    : { value };
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  > = [{ type: "text", text: JSON.stringify(value) }];
  if (workspacePath) {
    const paths = collectImageResultPaths(value).slice(0, 12);
    const images = await Promise.allSettled(paths.map(async (path) => {
      const absolutePath = safeChild(workspacePath, path);
      return {
        type: "image" as const,
        data: (await readFile(absolutePath)).toString("base64"),
        mimeType: imageMimeType(path),
      };
    }));
    for (const image of images) {
      if (image.status === "fulfilled") content.push(image.value);
    }
  }
  return {
    content,
    structuredContent,
  };
}

function collectImageResultPaths(value: unknown, paths = new Set<string>()): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectImageResultPaths(item, paths);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "path" && typeof item === "string" && /\.(?:png|jpe?g|webp)$/iu.test(item)) {
        paths.add(item);
      } else {
        collectImageResultPaths(item, paths);
      }
    }
  }
  return [...paths];
}

function imageMimeType(path: string): string {
  if (/\.jpe?g$/iu.test(path)) return "image/jpeg";
  if (/\.webp$/iu.test(path)) return "image/webp";
  return "image/png";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Tool operation failed";
}

const directionsBlockedActions = new Set([
  "context",
  "assignment",
  "submission-requirements",
  "module-neighborhood",
  "files",
  "file",
  "download",
  "pdf-inspect",
  "pdf-index",
  "pdf-text",
  "pdf-render",
  "pdf-contact-sheet",
  "pdf-ocr",
  "pdf-detect-problems",
  "pdf-semantic-crop",
  "image-crop",
]);

function requireProfileAction(session: ToolSession, action: string) {
  if (!toolActionAllowed(session.profile, action)) {
    throw new ToolAuthorizationError(
      `The ${action} action is unavailable in Directions. Use the authoritative preloaded context and leave file/PDF inspection to problem extraction.`,
    );
  }
}

export function toolActionAllowed(profile: "standard" | "directions", action: string) {
  return profile !== "directions" || !directionsBlockedActions.has(action);
}

export function parsePdfRenderPages(input: Record<string, unknown>): number[] {
  return parsePdfPageSelection(input, true)!;
}

export function parsePdfPageSelection(input: Record<string, unknown>, required: boolean): number[] | null {
  const selection = pdfPathSelectionSchema(required).parse({ path: "selection.pdf", ...input });
  if (selection.page === undefined && selection.pages === undefined && selection.range === undefined) return null;
  const pages = selection.page !== undefined
    ? [selection.page]
    : selection.pages
      ? selection.pages
      : Array.from(
          { length: selection.range!.end - selection.range!.start + 1 },
          (_, index) => selection.range!.start + index,
        );
  return [...new Set(pages)];
}

const STANDARD_TOOL_DOCUMENTATION = [
  "# Canvas assignment tools",
  "",
  "This workspace has a scoped Canvas helper script. It uses a short-lived capability and never exposes the Canvas API token.",
  "",
  "Run tools with node canvas-tool.mjs ACTION 'JSON':",
  "",
  "- context or assignment: selected assignment, directions, links, and submission requirements",
  "- course: course metadata and syllabus text",
  "- search {\"query\":\"...\"}: focused course search across assignments, pages, modules, and files",
  "- pages {\"query\":\"optional phrase\"}: list available course pages; use a query when possible",
  "- files {\"query\":\"optional phrase\"}: list available course files; use a query when possible",
  "- modules: course modules and embedded items",
  "- module-items {\"moduleId\":123}: one module's items",
  "- module-neighborhood: the selected assignment's module sequence with previous/current/next items",
  "- page {\"slug\":\"page-slug\"}: a Canvas page",
  "- follow {\"url\":\"https://...\"}: classify/read a linked Canvas resource",
  "- announcements {\"startDate\":\"YYYY-MM-DD\",\"endDate\":\"YYYY-MM-DD\"}: course announcements in an optional date range",
  "- discussion {\"topicId\":123}: one Canvas discussion or announcement topic",
  "- quiz {\"quizId\":123}: quiz/test metadata and teacher description",
  "- quiz-questions {\"quizId\":123}: authorized question data for an accessible classic quiz; Canvas may deny or omit it",
  "- file {\"fileId\":123}: file metadata",
  "- download {\"fileId\":123}: download into resources/ with cache support",
  "- pdf-inspect {\"path\":\"resources/file.pdf\"}: page count, text-layer quality, scanned/image status, and a text-or-vision recommendation",
  "- pdf-text {\"path\":\"resources/file.pdf\",\"page\":2}: layout-aware PDF text (page is optional)",
  "- pdf-render {\"path\":\"resources/file.pdf\",\"page\":2}: render one page to renders/",
  "- pdf-render {\"path\":\"resources/file.pdf\",\"pages\":[2,4,7]}: render several pages in one call",
  "- pdf-render {\"path\":\"resources/file.pdf\",\"range\":{\"start\":2,\"end\":6}}: render an inclusive page range in one call",
  "- image-crop {\"path\":\"renders/page.png\",\"rect\":{\"left\":10,\"top\":20,\"width\":600,\"height\":400}}: crop a rendered visual",
  "- submission-requirements: allowed submission types, extensions, locks, and attempts",
  "",
  "Inspect every unfamiliar PDF before extraction. Follow pdf-inspect's recommendation: prefer pdf-text for a usable text layer and vision from rendered pages for sparse/image-only documents. When multiple pages need rendering, prefer one batched pdf-render call with pages or range instead of many single-page calls. The agent session is read-only. Upload and submit operations exist behind a separate, explicit user-confirmation capability and are not available during analysis runs. Never infer text that is missing from a source. Use downloaded files and rendered pages as provenance.",
  "",
].join("\n");

const DIRECTIONS_TOOL_DOCUMENTATION = [
  "# Canvas assignment tools — Directions profile",
  "",
  "assignment-context.json and canvas-tool-preflight.json are authoritative and already contain the selected assignment, directions, submission requirements, links, and module neighborhood. Read them directly and do not re-fetch them.",
  "",
  "Only when a specific assignment instruction remains missing or ambiguous, run one targeted lookup with node canvas-tool.mjs ACTION 'JSON':",
  "",
  "- page {\"slug\":\"page-slug\"}: read one specifically relevant Canvas page",
  "- follow {\"url\":\"https://...\"}: classify/read one specifically relevant linked Canvas resource",
  "- search {\"query\":\"specific phrase\"}: focused course search when the missing resource cannot otherwise be identified",
  "- pages {\"query\":\"specific phrase\"}: locate a specifically named Canvas page",
  "- modules or module-items {\"moduleId\":123}: inspect module structure only when preflight does not resolve a necessary ambiguity",
  "- course, announcements, discussion, or quiz: use only when the assignment explicitly points there for a missing instruction",
  "",
  "File listing, file metadata, downloads, PDF inspection/text/rendering, image cropping, and duplicate assignment/context/submission/preflight requests are disabled for Directions. Question-content inspection belongs to problem extraction. Stop as soon as assigned work, submission method, and due information are sufficiently verified.",
  "",
].join("\n");

export function toolDocumentation(profile: "standard" | "directions" = "standard") {
  return profile === "directions" ? DIRECTIONS_TOOL_DOCUMENTATION : STANDARD_TOOL_DOCUMENTATION;
}

export const TOOL_DOCUMENTATION = STANDARD_TOOL_DOCUMENTATION;
