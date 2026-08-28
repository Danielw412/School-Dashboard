import { randomBytes } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { basename, relative } from "node:path";

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
};

const objectInput = z.record(z.string(), z.unknown()).default({});

export class CanvasToolSessions {
  private readonly sessions = new Map<string, ToolSession>();

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
    options?: { allowMutation?: boolean; ttlMinutes?: number },
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
    };
    this.sessions.set(token, session);
    return session;
  }

  revoke(token: string) {
    this.sessions.delete(token);
  }

  async installAgentScript(session: ToolSession): Promise<string> {
    const path = safeChild(session.workspace.path, "canvas-tool.mjs");
    await copyFile(safeChild(APP_ROOT, "scripts/canvas-tool.mjs"), path);
    await writeFile(
      safeChild(session.workspace.path, "CANVAS_TOOLS.md"),
      TOOL_DOCUMENTATION,
      "utf8",
    );
    return path;
  }

  async execute(token: string | undefined, rawAction: unknown, rawInput: unknown) {
    if (!token) throw new ToolAuthorizationError("Missing Canvas tool capability.");
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      throw new ToolAuthorizationError("Canvas tool capability is invalid or expired.");
    }
    const action = z.string().min(1).parse(rawAction);
    const input = objectInput.parse(rawInput);
    const courseId = session.task.canvas.course_id ?? session.task.course.canvas_course_id;
    const assignmentId =
      session.context.assignment?.id?.toString() ?? session.task.canvas.assignment_id ?? null;

    await this.activity.record({
      category: "agent",
      action: `canvas_tool.${action}`,
      status: "started",
      summary: session.task.display_title,
      metadata: { workspace: session.workspace.id },
    });

    try {
      const result = await (async () => {
        switch (action) {
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
      case "search": {
        requireCourse(courseId);
        const query = z.string().min(1).parse(input.query);
        return this.canvas.searchCourse(courseId, query);
      }
      case "course":
        requireCourse(courseId);
        return this.canvas.getCourse(courseId);
      case "pages":
        requireCourse(courseId);
        return this.canvas.listPages(
          courseId,
          input.query === undefined ? undefined : z.string().min(1).parse(input.query),
        );
      case "files":
        requireCourse(courseId);
        return this.canvas.listFiles(
          courseId,
          input.query === undefined ? undefined : z.string().min(1).parse(input.query),
        );
      case "modules":
        requireCourse(courseId);
        return this.canvas.listModules(courseId);
      case "module-items":
        requireCourse(courseId);
        return this.canvas.listModuleItems(
          courseId,
          z.union([z.string(), z.number()]).parse(input.moduleId).toString(),
        );
      case "module-neighborhood":
        requireCourse(courseId);
        requireAssignment(assignmentId);
        return this.canvas.getModuleItemSequence(courseId, "Assignment", assignmentId);
      case "page":
        requireCourse(courseId);
        return this.canvas.getPage(courseId, z.string().min(1).parse(input.slug));
      case "follow": {
        requireCourse(courseId);
        const url = z.string().url().parse(input.url);
        requireCourseScopedUrl(url, courseId);
        return this.canvas.followLinkedResource(url);
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
        return this.canvas.getFile(z.union([z.string(), z.number()]).parse(input.fileId).toString());
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
        const page = input.page === undefined ? undefined : z.number().int().positive().parse(input.page);
        return { path: relative(session.workspace.path, path), page: page ?? null, text: await this.workspaces.extractPdfText(path, page) };
      }
      case "pdf-render": {
        const path = safeChild(session.workspace.path, z.string().min(1).parse(input.path));
        const page = z.number().int().positive().parse(input.page);
        const output = await this.workspaces.renderPdfPage(path, page, session.workspace);
        return { page, path: relative(session.workspace.path, output).replaceAll("\\", "/") };
      }
      case "image-crop": {
        const path = z.string().min(1).parse(input.path);
        const output = await this.workspaces.cropImage(
          path,
          z
            .object({ left: z.number().int(), top: z.number().int(), width: z.number().int(), height: z.number().int() })
            .parse(input.rect),
          session.workspace,
        );
        return { path: relative(session.workspace.path, output).replaceAll("\\", "/") };
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
        metadata: { workspace: session.workspace.id },
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
          error: error instanceof Error ? error.message : "Canvas tool failed",
        },
      });
      throw error;
    }
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

export const TOOL_DOCUMENTATION = [
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
  "- pdf-text {\"path\":\"resources/file.pdf\",\"page\":2}: layout-aware PDF text (page is optional)",
  "- pdf-render {\"path\":\"resources/file.pdf\",\"page\":2}: render a page to renders/",
  "- image-crop {\"path\":\"renders/page.png\",\"rect\":{\"left\":10,\"top\":20,\"width\":600,\"height\":400}}: crop a rendered visual",
  "- submission-requirements: allowed submission types, extensions, locks, and attempts",
  "",
  "The agent session is read-only. Upload and submit operations exist behind a separate, explicit user-confirmation capability and are not available during analysis runs. Never infer text that is missing from a source. Use downloaded files and rendered pages as provenance.",
  "",
].join("\n");
