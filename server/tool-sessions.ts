import { randomBytes } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { basename, relative } from "node:path";

import { z } from "zod";

import type { ActivityStore } from "./activity.js";
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
      case "modules":
        requireCourse(courseId);
        return this.canvas.listModules(courseId);
      case "module-items":
        requireCourse(courseId);
        return this.canvas.listModuleItems(
          courseId,
          z.union([z.string(), z.number()]).parse(input.moduleId).toString(),
        );
      case "page":
        requireCourse(courseId);
        return this.canvas.getPage(courseId, z.string().min(1).parse(input.slug));
      case "follow":
        return this.canvas.followLinkedResource(z.string().url().parse(input.url));
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
  "- search {\"query\":\"...\"}: focused course search across assignments, pages, modules, and files",
  "- modules: course modules and embedded items",
  "- module-items {\"moduleId\":123}: one module's items",
  "- page {\"slug\":\"page-slug\"}: a Canvas page",
  "- follow {\"url\":\"https://...\"}: classify/read a linked Canvas resource",
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
