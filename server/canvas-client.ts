import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import * as cheerio from "cheerio";
import mime from "mime-types";
import sanitizeHtml from "sanitize-html";
import TurndownService from "turndown";
import { z } from "zod";

import type { ActivityStore } from "./activity.js";
import { sanitizeUrlCapabilities } from "./activity.js";
import { requireCanvasToken } from "./env.js";
import type { TrackedTask } from "./task-sync.js";

const canvasAssignmentSchema = z
  .object({
    id: z.number(),
    course_id: z.number().optional(),
    name: z.string(),
    description: z.string().nullable().optional(),
    due_at: z.string().nullable().optional(),
    html_url: z.string().url(),
    points_possible: z.number().nullable().optional(),
    submission_types: z.array(z.string()).default([]),
    allowed_extensions: z.array(z.string()).default([]),
    allowed_attempts: z.number().nullable().optional(),
    locked_for_user: z.boolean().default(false),
    lock_explanation: z.string().nullable().optional(),
    workflow_state: z.string().optional(),
    external_tool_tag_attributes: z
      .object({ url: z.string().optional(), new_tab: z.boolean().optional() })
      .nullable()
      .optional(),
  })
  .passthrough();

const canvasPageSchema = z
  .object({
    page_id: z.number().optional(),
    url: z.string(),
    title: z.string(),
    body: z.string().nullable().optional(),
    html_url: z.string().url().optional(),
    updated_at: z.string().optional(),
  })
  .passthrough();

const canvasModuleItemSchema = z
  .object({
    id: z.number(),
    module_id: z.number(),
    position: z.number().optional(),
    title: z.string(),
    type: z.string(),
    content_id: z.number().optional(),
    page_url: z.string().optional(),
    external_url: z.string().optional(),
    html_url: z.string().optional(),
    url: z.string().optional(),
    completion_requirement: z.unknown().optional(),
    content_details: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const canvasModuleSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    position: z.number().optional(),
    unlock_at: z.string().nullable().optional(),
    items: z.array(canvasModuleItemSchema).optional(),
  })
  .passthrough();

const canvasFileSchema = z
  .object({
    id: z.number(),
    display_name: z.string(),
    filename: z.string(),
    content_type: z.string().optional(),
    size: z.number().optional(),
    url: z.string().url(),
    preview_url: z.string().url().optional(),
    updated_at: z.string().optional(),
  })
  .passthrough();

const canvasCourseSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    course_code: z.string().optional(),
    syllabus_body: z.string().nullable().optional(),
    default_view: z.string().optional(),
    term: z.record(z.string(), z.unknown()).optional(),
    teachers: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();

export type CanvasAssignment = z.infer<typeof canvasAssignmentSchema>;
export type CanvasPage = z.infer<typeof canvasPageSchema>;
export type CanvasModule = z.infer<typeof canvasModuleSchema>;
export type CanvasModuleItem = z.infer<typeof canvasModuleItemSchema>;
export type CanvasFile = z.infer<typeof canvasFileSchema>;
export type CanvasCourse = z.infer<typeof canvasCourseSchema>;
export type CanvasReadablePage = CanvasPage & {
  bodyMarkdown: string;
  links: CanvasLink[];
};

export type CanvasSourceContext = {
  kind: "assignment" | "page" | "file" | "discussion" | "quiz" | "module_item" | "canvas_link";
  title: string;
  url: string | null;
  matchedBy: "direct_url" | "source_anchor" | "source_text" | "task_title" | "page_search";
  contextMarkdown: string;
  cells: string[];
  links: CanvasLink[];
  resource: Record<string, unknown>;
};

export type CanvasLink = {
  text: string;
  url: string;
  sameCanvasOrigin: boolean;
};

export type AssignmentContext = {
  assignment: CanvasAssignment | null;
  directionsHtml: string;
  directionsMarkdown: string;
  links: CanvasLink[];
  submissionRequirements: {
    supported: boolean;
    submissionTypes: string[];
    allowedExtensions: string[];
    pointsPossible: number | null;
    allowedAttempts: number | null;
    locked: boolean;
    lockExplanation: string | null;
  };
  externalAssignment: {
    isExternal: boolean;
    url: string | null;
  };
  sourceContext: CanvasSourceContext | null;
  resolution: {
    method: "canvas_id" | "direct_url" | "title_search" | "not_found";
    confidence: number;
  };
};

export class CanvasClient {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly activity: ActivityStore) {
    if (!baseUrl) {
      throw new Error("Canvas base URL is not configured.");
    }
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = requireCanvasToken();
  }

  async health(): Promise<{ connected: boolean; name?: string; error?: string }> {
    try {
      const profile = z
        .object({ name: z.string().optional(), short_name: z.string().optional() })
        .passthrough()
        .parse(await this.requestJson("/users/self/profile"));
      return { connected: true, name: profile.short_name ?? profile.name };
    } catch (error) {
      return { connected: false, error: error instanceof Error ? error.message : "Unavailable" };
    }
  }

  async getAssignment(courseId: string, assignmentId: string): Promise<CanvasAssignment> {
    return canvasAssignmentSchema.parse(
      await this.requestJson(
        `/courses/${encodeURIComponent(courseId)}/assignments/${encodeURIComponent(assignmentId)}`,
        { include: ["submission"] },
      ),
    );
  }

  async getCourse(courseId: string): Promise<CanvasCourse & { syllabusMarkdown: string }> {
    const course = canvasCourseSchema.parse(
      await this.requestJson(`/courses/${encodeURIComponent(courseId)}`, {
        include: ["syllabus_body", "term", "teachers"],
      }),
    );
    const syllabus = normalizeCanvasHtml(course.syllabus_body ?? "", this.baseUrl);
    return { ...course, syllabusMarkdown: syllabus.markdown };
  }

  async listAssignments(courseId: string, search?: string): Promise<CanvasAssignment[]> {
    const values = await this.paginate(
      `/courses/${encodeURIComponent(courseId)}/assignments`,
      search ? { search_term: search, per_page: "100" } : { per_page: "100" },
    );
    return z.array(canvasAssignmentSchema).parse(values);
  }


  async listPages(courseId: string, search?: string): Promise<CanvasPage[]> {
    const values = await this.paginate(`/courses/${encodeURIComponent(courseId)}/pages`, {
      ...(search ? { search_term: search } : {}),
      per_page: "100",
    });
    return z.array(canvasPageSchema).parse(values);
  }

  async listFiles(courseId: string, search?: string): Promise<CanvasFile[]> {
    const values = await this.paginate(`/courses/${encodeURIComponent(courseId)}/files`, {
      ...(search ? { search_term: search } : {}),
      per_page: "100",
    });
    return z.array(canvasFileSchema).parse(values);
  }

  async searchCourse(courseId: string, query: string): Promise<Record<string, unknown>> {
    const [assignmentsResult, pagesResult, modulesResult, filesResult] = await Promise.allSettled([
      this.listAssignments(courseId, query),
      this.listPages(courseId, query),
      this.listModules(courseId),
      this.listFiles(courseId, query),
    ]);
    const assignments = settledValue(assignmentsResult);
    const pages = settledValue(pagesResult);
    const modules = settledValue(modulesResult);
    const files = settledValue(filesResult);
    const tokens = normalizedTokens(query);
    return {
      query,
      assignments: rankByTitle(assignments, (item) => item.name, tokens).slice(0, 20),
      pages: rankByTitle(pages, (item) => item.title, tokens).slice(0, 20),
      modules: rankByTitle(modules, (item) => item.name, tokens).slice(0, 20),
      files: rankByTitle(files, (item) => item.display_name, tokens).slice(0, 20),
      unavailable: [
        settledFailure("assignments", assignmentsResult),
        settledFailure("pages", pagesResult),
        settledFailure("modules", modulesResult),
        settledFailure("files", filesResult),
      ].filter(Boolean),
    };
  }

  async listModules(courseId: string): Promise<CanvasModule[]> {
    const values = await this.paginate(`/courses/${encodeURIComponent(courseId)}/modules`, {
      include: ["items", "content_details"],
      per_page: "100",
    });
    return z.array(canvasModuleSchema).parse(values);
  }

  async listModuleItems(courseId: string, moduleId: string): Promise<CanvasModuleItem[]> {
    const values = await this.paginate(
      `/courses/${encodeURIComponent(courseId)}/modules/${encodeURIComponent(moduleId)}/items`,
      { include: ["content_details"], per_page: "100" },
    );
    return z.array(canvasModuleItemSchema).parse(values);
  }

  async getModuleItemResource(courseId: string, itemId: string): Promise<Record<string, unknown>> {
    const modules = await this.listModules(courseId);
    let item = modules.flatMap((module) => module.items ?? []).find((candidate) => String(candidate.id) === itemId);
    if (!item) {
      const results = await Promise.allSettled(modules.slice(0, 40).map((module) => this.listModuleItems(courseId, String(module.id))));
      item = results.flatMap((result) => result.status === "fulfilled" ? result.value : [])
        .find((candidate) => String(candidate.id) === itemId);
    }
    if (!item) throw new Error(`Canvas module item ${itemId} was not found in this course.`);
    let resource: unknown = null;
    if (item.type === "Page" && item.page_url) resource = await this.getPage(courseId, item.page_url);
    else if (item.type === "Assignment" && item.content_id) {
      const assignment = await this.getAssignment(courseId, String(item.content_id));
      const directions = normalizeCanvasHtml(assignment.description ?? "", this.baseUrl);
      resource = { ...assignment, description: directions.html, directionsMarkdown: directions.markdown, links: directions.links };
    }
    else if (item.type === "File" && item.content_id) resource = await this.getFile(String(item.content_id));
    else if (item.type === "Discussion" && item.content_id) resource = await this.getDiscussion(courseId, String(item.content_id));
    else if (item.type === "Quiz" && item.content_id) resource = await this.getQuiz(courseId, String(item.content_id));
    return { item, resource };
  }

  async getPage(courseId: string, slug: string): Promise<CanvasReadablePage> {
    const page = canvasPageSchema.parse(
      await this.requestJson(
        `/courses/${encodeURIComponent(courseId)}/pages/${encodeURIComponent(slug)}`,
      ),
    );
    const body = normalizeCanvasHtml(page.body ?? "", this.baseUrl);
    return { ...page, body: body.html, bodyMarkdown: body.markdown, links: body.links };
  }

  async getModuleItemSequence(
    courseId: string,
    assetType: "ModuleItem" | "File" | "Page" | "Discussion" | "Assignment" | "Quiz" | "ExternalTool",
    assetId: string,
  ): Promise<Record<string, unknown>> {
    return z.record(z.string(), z.unknown()).parse(
      await this.requestJson(`/courses/${encodeURIComponent(courseId)}/module_item_sequence`, {
        asset_type: assetType,
        asset_id: assetId,
      }),
    );
  }

  async listAnnouncements(
    courseId: string,
    range?: { startDate?: string; endDate?: string },
  ): Promise<Record<string, unknown>[]> {
    const values = await this.paginate("/announcements", {
      "context_codes[]": [`course_${courseId}`],
      ...(range?.startDate ? { start_date: range.startDate } : {}),
      ...(range?.endDate ? { end_date: range.endDate } : {}),
      per_page: "50",
    });
    return z.array(z.record(z.string(), z.unknown())).parse(values).map((announcement) => {
      const message = normalizeCanvasHtml(
        typeof announcement.message === "string" ? announcement.message : "",
        this.baseUrl,
      );
      return { ...announcement, messageMarkdown: message.markdown, links: message.links };
    });
  }

  async getDiscussion(courseId: string, topicId: string): Promise<Record<string, unknown>> {
    const discussion = z.record(z.string(), z.unknown()).parse(
      await this.requestJson(
        `/courses/${encodeURIComponent(courseId)}/discussion_topics/${encodeURIComponent(topicId)}`,
      ),
    );
    const message = normalizeCanvasHtml(
      typeof discussion.message === "string" ? discussion.message : "",
      this.baseUrl,
    );
    return { ...discussion, messageMarkdown: message.markdown, links: message.links };
  }

  async getQuiz(courseId: string, quizId: string): Promise<Record<string, unknown>> {
    const quiz = z.record(z.string(), z.unknown()).parse(
      await this.requestJson(
        `/courses/${encodeURIComponent(courseId)}/quizzes/${encodeURIComponent(quizId)}`,
      ),
    );
    const description = normalizeCanvasHtml(
      typeof quiz.description === "string" ? quiz.description : "",
      this.baseUrl,
    );
    return { ...quiz, descriptionMarkdown: description.markdown, links: description.links };
  }

  async listQuizQuestions(courseId: string, quizId: string): Promise<Record<string, unknown>[]> {
    const values = await this.paginate(
      `/courses/${encodeURIComponent(courseId)}/quizzes/${encodeURIComponent(quizId)}/questions`,
      { per_page: "100" },
    );
    return z.array(z.record(z.string(), z.unknown())).parse(values);
  }

  async getFile(fileId: string): Promise<CanvasFile> {
    return canvasFileSchema.parse(
      await this.requestJson(`/files/${encodeURIComponent(fileId)}`),
    );
  }

  async downloadFile(file: CanvasFile, destination: string): Promise<void> {
    await mkdir(dirname(destination), { recursive: true });
    const response = await fetch(file.url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok || !response.body) {
      throw new Error(`Canvas file download failed with status ${response.status}.`);
    }
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination));
    await this.activity.record({
      category: "resource",
      action: "download",
      status: "completed",
      summary: file.display_name,
      metadata: { fileId: file.id, size: file.size, destination: basename(destination) },
    });
  }

  async followLinkedResource(urlValue: string): Promise<Record<string, unknown>> {
    const url = new URL(urlValue, this.baseUrl);
    if (url.origin !== new URL(this.baseUrl).origin) {
      return {
        kind: "external",
        url: url.toString(),
        readable: false,
        message: "This resource is outside Canvas and was not read.",
      };
    }
    const assignment = url.pathname.match(/\/courses\/(\d+)\/assignments\/(\d+)/);
    if (assignment) {
      const value = await this.getAssignment(assignment[1]!, assignment[2]!);
      const directions = normalizeCanvasHtml(value.description ?? "", this.baseUrl);
      return {
        kind: "assignment",
        value: { ...value, description: directions.html, directionsMarkdown: directions.markdown, links: directions.links },
      };
    }
    const page = url.pathname.match(/\/courses\/(\d+)\/pages\/([^/]+)/);
    if (page) {
      return {
        kind: "page",
        value: await this.getPage(page[1]!, decodeURIComponent(page[2]!)),
      };
    }
    const file = url.pathname.match(/\/courses\/\d+\/files\/(\d+)|\/(?:api\/v1\/)?files\/(\d+)/);
    if (file) {
      return { kind: "file", value: await this.getFile(file[1] ?? file[2]!) };
    }
    const discussion = url.pathname.match(/\/courses\/(\d+)\/discussion_topics\/(\d+)/);
    if (discussion) {
      return {
        kind: "discussion",
        value: await this.getDiscussion(discussion[1]!, discussion[2]!),
      };
    }
    const quiz = url.pathname.match(/\/courses\/(\d+)\/quizzes\/(\d+)/);
    if (quiz) {
      return { kind: "quiz", value: await this.getQuiz(quiz[1]!, quiz[2]!) };
    }
    const moduleItem = url.pathname.match(
      /\/courses\/(\d+)\/modules\/(\d+)\/items\/(\d+)|\/courses\/(\d+)\/modules\/items\/(\d+)/,
    );
    if (moduleItem) {
      const courseId = moduleItem[1] ?? moduleItem[4]!;
      const itemId = moduleItem[3] ?? moduleItem[5]!;
      return {
        kind: "module_item",
        value: await this.getModuleItemResource(courseId, itemId),
      };
    }
    return {
      kind: "canvas_link",
      url: url.toString(),
      readable: false,
      message: "No deterministic Canvas API mapping is available for this same-origin URL.",
    };
  }

  async assignmentContext(task: TrackedTask): Promise<AssignmentContext> {
    const courseId = task.canvas.course_id ?? task.course.canvas_course_id;
    if (!courseId) {
      return emptyAssignmentContext();
    }
    const recoverSourceImmediately = taskSourceMayContainDirections(task);
    const [assignmentResolution, initialSourceContext] = await Promise.all([
      this.resolveAssignment(task, courseId),
      recoverSourceImmediately ? this.recoverTaskSourceContext(task, courseId) : Promise.resolve(null),
    ]);
    const { assignment, method, confidence } = assignmentResolution;
    const sourceContext = initialSourceContext ?? (
      assignment ? null : await this.recoverTaskSourceContext(task, courseId)
    );
    if (!assignment) {
      return emptyAssignmentContext(sourceContext);
    }
    const directions = normalizeCanvasHtml(assignment.description ?? "", this.baseUrl);
    const sanitizedAssignment = { ...assignment, description: directions.html };
    const externalUrl = assignment.external_tool_tag_attributes?.url ?? null;
    const isExternal = assignment.submission_types.includes("external_tool") || Boolean(externalUrl);
    const supportedTypes = new Set(["online_text_entry", "online_url", "online_upload"]);
    return {
      assignment: sanitizedAssignment,
      directionsHtml: directions.html,
      directionsMarkdown: directions.markdown,
      links: directions.links,
      submissionRequirements: {
        supported: assignment.submission_types.some((item) => supportedTypes.has(item)),
        submissionTypes: assignment.submission_types,
        allowedExtensions: assignment.allowed_extensions,
        pointsPossible: assignment.points_possible ?? null,
        allowedAttempts: assignment.allowed_attempts ?? null,
        locked: assignment.locked_for_user,
        lockExplanation: assignment.lock_explanation ?? null,
      },
      externalAssignment: { isExternal, url: externalUrl },
      sourceContext,
      resolution: { method, confidence },
    };
  }

  async recoverTaskSourceContext(
    task: TrackedTask,
    courseId = task.canvas.course_id ?? task.course.canvas_course_id ?? undefined,
  ): Promise<CanvasSourceContext | null> {
    if (!courseId) return null;
    const directUrls = uniqueStrings([
      task.source.assignment_url,
      task.canvas.assignment_url,
      task.source.url,
    ]);
    for (const url of directUrls) {
      try {
        const resolved = new URL(url, this.baseUrl);
        if (resolved.origin !== new URL(this.baseUrl).origin) continue;
        const courseMatch = resolved.pathname.match(/\/courses\/(\d+)/);
        if (courseMatch && courseMatch[1] !== courseId) continue;
        const followed = await this.followLinkedResource(resolved.toString());
        const context = sourceContextFromFollowedResource(followed, task, resolved.toString(), this.baseUrl);
        if (context) return context;
      } catch {
        // Try the next deterministic identifier before falling back to page search.
      }
    }

    for (const slug of sourcePageSlugs(task)) {
      try {
        const page = await this.getPage(courseId, slug);
        const relevant = extractRelevantCanvasContext(page.body ?? "", taskContextClues(task), this.baseUrl);
        return {
          kind: "page",
          title: page.title,
          url: page.html_url ?? `${this.baseUrl}/courses/${courseId}/pages/${page.url}`,
          matchedBy: relevant.matchedBy ?? "source_anchor",
          contextMarkdown: relevant.contextMarkdown || page.bodyMarkdown,
          cells: relevant.cells,
          links: relevant.links.length > 0 ? relevant.links : page.links,
          resource: compactCanvasResource(page),
        };
      } catch {
        // A stale anchor slug may still be recoverable from the focused page search below.
      }
    }

    const queries = sourceRecoveryQueries(task).slice(0, 3);
    const pageResults = await Promise.allSettled(queries.map((query) => this.listPages(courseId, query)));
    const pages = dedupeBy(
      pageResults.flatMap((result) => result.status === "fulfilled" ? result.value : []),
      (page) => page.url,
    );
    const ranked = rankPagesForTask(pages, task);
    for (const candidate of ranked.slice(0, 3)) {
      try {
        const page = await this.getPage(courseId, candidate.item.url);
        const relevant = extractRelevantCanvasContext(page.body ?? "", taskContextClues(task), this.baseUrl);
        if (!relevant.contextMarkdown && candidate.score < 0.35) continue;
        return {
          kind: "page",
          title: page.title,
          url: page.html_url ?? `${this.baseUrl}/courses/${courseId}/pages/${page.url}`,
          matchedBy: relevant.matchedBy ?? "page_search",
          contextMarkdown: relevant.contextMarkdown || page.bodyMarkdown,
          cells: relevant.cells,
          links: relevant.links.length > 0 ? relevant.links : page.links,
          resource: compactCanvasResource(page),
        };
      } catch {
        // A stale or inaccessible page should not prevent trying another ranked page.
      }
    }
    return null;
  }

  private async resolveAssignment(
    task: TrackedTask,
    courseId: string,
  ): Promise<Pick<AssignmentContext["resolution"], "method" | "confidence"> & { assignment: CanvasAssignment | null }> {
    if (task.canvas.assignment_id) {
      return {
        assignment: await this.getAssignment(courseId, task.canvas.assignment_id),
        method: "canvas_id",
        confidence: 1,
      };
    }
    for (const urlValue of uniqueStrings([task.source.assignment_url, task.canvas.assignment_url, task.source.url])) {
      try {
        const url = new URL(urlValue, this.baseUrl);
        if (url.origin !== new URL(this.baseUrl).origin) continue;
        const match = url.pathname.match(/\/courses\/(\d+)\/assignments\/(\d+)/);
        if (match?.[1] === courseId) {
          return {
            assignment: await this.getAssignment(courseId, match[2]!),
            method: "direct_url",
            confidence: 1,
          };
        }
      } catch {
        // Ignore malformed optional URLs and continue with title evidence.
      }
    }

    const queries = assignmentRecoveryQueries(task).slice(0, 3);
    const results = await Promise.allSettled(queries.map((query) => this.listAssignments(courseId, query)));
    const candidates = dedupeBy(
      results.flatMap((result) => result.status === "fulfilled" ? result.value : []),
      (assignment) => String(assignment.id),
    );
    const ranked = rankByMultipleQueries(candidates, (item) => item.name, queries);
    const best = ranked[0];
    const runnerUp = ranked[1];
    if (best && best.score >= 0.55 && (!runnerUp || best.score - runnerUp.score >= 0.08)) {
      return { assignment: best.item, method: "title_search", confidence: best.score };
    }
    return { assignment: null, method: "not_found", confidence: 0 };
  }

  async uploadSubmissionFile(
    courseId: string,
    assignmentId: string,
    filePath: string,
    fileBytes: Uint8Array,
  ): Promise<string> {
    const name = basename(filePath);
    const contentType = mime.lookup(extname(name)) || "application/octet-stream";
    const initialize = z
      .object({
        upload_url: z.string().url(),
        upload_params: z.record(z.string(), z.union([z.string(), z.number()])),
      })
      .parse(
        await this.requestJson(
          `/courses/${encodeURIComponent(courseId)}/assignments/${encodeURIComponent(assignmentId)}/submissions/self/files`,
          undefined,
          {
            method: "POST",
            body: { name, size: fileBytes.byteLength, content_type: contentType },
          },
        ),
      );
    const upload = new FormData();
    for (const [key, value] of Object.entries(initialize.upload_params)) {
      upload.append(key, String(value));
    }
    const fileBuffer = fileBytes.buffer.slice(
      fileBytes.byteOffset,
      fileBytes.byteOffset + fileBytes.byteLength,
    ) as ArrayBuffer;
    upload.append("file", new Blob([fileBuffer], { type: String(contentType) }), name);
    const response = await fetch(initialize.upload_url, {
      method: "POST",
      body: upload,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      throw new Error(`Canvas upload failed with status ${response.status}.`);
    }
    const result = z.object({ id: z.union([z.number(), z.string()]) }).parse(await response.json());
    return String(result.id);
  }

  async submitAssignment(
    courseId: string,
    assignmentId: string,
    submission:
      | { type: "online_text_entry"; text: string }
      | { type: "online_url"; url: string }
      | { type: "online_upload"; fileIds: string[] },
  ): Promise<unknown> {
    const body: Record<string, unknown> = { submission_type: submission.type };
    if (submission.type === "online_text_entry") body.body = submission.text;
    if (submission.type === "online_url") body.url = submission.url;
    if (submission.type === "online_upload") body.file_ids = submission.fileIds;
    return this.requestJson(
      `/courses/${encodeURIComponent(courseId)}/assignments/${encodeURIComponent(assignmentId)}/submissions`,
      undefined,
      { method: "POST", body: { submission: body } },
    );
  }

  private async paginate(
    path: string,
    query?: Record<string, string | string[]>,
  ): Promise<unknown[]> {
    const values: unknown[] = [];
    let next: URL | null = this.apiUrl(path, query);
    while (next) {
      const response = await this.request(next, { method: "GET" });
      const page = z.array(z.unknown()).parse(await response.json());
      values.push(...page);
      next = nextLink(response.headers.get("link"), this.baseUrl);
    }
    return values;
  }

  private async requestJson(
    path: string,
    query?: Record<string, string | string[]>,
    init?: { method: "POST" | "PUT" | "DELETE"; body?: unknown },
  ): Promise<unknown> {
    const response = await this.request(this.apiUrl(path, query), {
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      headers: init?.body === undefined ? undefined : { "Content-Type": "application/json" },
    });
    return response.json();
  }

  private async request(url: URL, init: RequestInit): Promise<Response> {
    if (url.origin !== new URL(this.baseUrl).origin) {
      throw new Error("Canvas API request was blocked because the origin did not match.");
    }
    const started = performance.now();
    const endpoint = `${url.pathname}${url.search}`;
    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
          ...init.headers,
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(
          `Canvas returned ${response.status}: ${(await response.text()).slice(0, 400)}`,
        );
      }
      await this.activity.record({
        category: "canvas",
        action: init.method ?? "GET",
        status: "completed",
        summary: endpoint,
        metadata: { durationMs: Math.round(performance.now() - started) },
      });
      return response;
    } catch (error) {
      await this.activity.record({
        category: "canvas",
        action: init.method ?? "GET",
        status: "failed",
        summary: endpoint,
        metadata: { error: error instanceof Error ? error.message : "Canvas request failed" },
      });
      throw error;
    }
  }

  private apiUrl(path: string, query?: Record<string, string | string[]>): URL {
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      for (const item of Array.isArray(value) ? value : [value]) {
        url.searchParams.append(key.endsWith("[]") ? key : Array.isArray(value) ? `${key}[]` : key, item);
      }
    }
    return url;
  }
}

function normalizeCanvasHtml(
  value: string,
  baseUrl: string,
): { html: string; markdown: string; links: CanvasLink[] } {
  const safe = sanitizeHtml(value, {
    allowedTags: [
      "p",
      "br",
      "strong",
      "em",
      "b",
      "i",
      "u",
      "ul",
      "ol",
      "li",
      "h1",
      "h2",
      "h3",
      "h4",
      "blockquote",
      "code",
      "pre",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "a",
      "img",
      "span",
    ],
    allowedAttributes: {
      "*": ["id"],
      a: ["href", "title", "target"],
      img: ["src", "alt", "title"],
      span: ["class"],
    },
    allowedSchemes: ["http", "https"],
  });
  const $ = cheerio.load(safe);
  const canvasOrigin = new URL(baseUrl).origin;
  const links: CanvasLink[] = [];
  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const resolved = new URL(href, baseUrl);
    const safeUrl = sanitizeUrlCapabilities(resolved.toString());
    $(element).attr("href", safeUrl);
    links.push({
      text: $(element).text().trim() || resolved.pathname,
      url: safeUrl,
      sameCanvasOrigin: resolved.origin === canvasOrigin,
    });
  });
  $("img[src]").each((_index, element) => {
    const src = $(element).attr("src");
    if (src) {
      $(element).attr(
        "src",
        sanitizeUrlCapabilities(new URL(src, baseUrl).toString()),
      );
    }
  });
  const html = $("body").html() ?? "";
  const turndown = new TurndownService({ bulletListMarker: "-", headingStyle: "atx" });
  return { html, markdown: turndown.turndown(html), links };
}

export type RelevantCanvasContext = {
  contextMarkdown: string;
  cells: string[];
  links: CanvasLink[];
  matchedBy: CanvasSourceContext["matchedBy"] | null;
};

export function extractRelevantCanvasContext(
  htmlValue: string,
  clues: Array<{ value: string; kind: CanvasSourceContext["matchedBy"] }>,
  baseUrl: string,
): RelevantCanvasContext {
  const normalized = normalizeCanvasHtml(htmlValue, baseUrl);
  if (!normalized.html.trim()) {
    return { contextMarkdown: "", cells: [], links: [], matchedBy: null };
  }
  const $ = cheerio.load(normalized.html);
  // Cheerio's public element type differs between its browser and Node exports; keep the
  // scored nodes local and infer them from each traversal callback.
  const scored = new Map<unknown, { score: number; matchedBy: CanvasSourceContext["matchedBy"] }>();
  $("tr, li, p, [id]").each((_index, element) => {
    const node = $(element).closest("tr, li, p").get(0) ?? element;
    const text = $(node).text().replace(/\s+/g, " ").trim();
    const id = ($(element).attr("id") ?? "").trim();
    if (!text && !id) return;
    let bestScore = 0;
    let matchedBy: CanvasSourceContext["matchedBy"] = "task_title";
    for (const clue of clues) {
      const clueValue = clue.value.trim();
      if (!clueValue) continue;
      let score = 0;
      if (clue.kind === "source_anchor" && id && normalizeComparable(id) === normalizeComparable(clueValue)) {
        score = 10;
      } else {
        const comparableText = normalizeComparable(text);
        const comparableClue = normalizeComparable(clueValue);
        if (comparableClue.length >= 8 && comparableText.includes(comparableClue)) score = 7;
        else if (comparableText.length >= 8 && comparableClue.includes(comparableText)) score = 5;
        else score = tokenSimilarity(normalizedTokens(text), normalizedTokens(clueValue)) * 4;
      }
      if (score > bestScore) {
        bestScore = score;
        matchedBy = clue.kind;
      }
    }
    const previous = scored.get(node);
    if (bestScore > (previous?.score ?? 0)) scored.set(node, { score: bestScore, matchedBy });
  });

  const winner = [...scored.entries()].sort((left, right) => right[1].score - left[1].score)[0];
  if (!winner || winner[1].score < 0.75) {
    return {
      contextMarkdown: normalized.markdown,
      cells: [],
      links: normalized.links,
      matchedBy: null,
    };
  }
  const selected = $(winner[0] as never).closest("tr, li, p");
  const selectedNode = selected.length > 0 ? selected : $(winner[0] as never);
  const fragments: string[] = [];
  const row = selectedNode.is("tr") ? selectedNode : selectedNode.closest("tr");
  if (row.length > 0) {
    const table = row.closest("table");
    const header = table.find("thead tr").first().length > 0
      ? table.find("thead tr").first()
      : table.find("tr").filter((_index, element) => $(element).find("th").length > 0).first();
    if (header.length > 0 && header.get(0) !== row.get(0)) fragments.push($.html(header));
    fragments.push($.html(row));
    for (const neighbor of [row.prev("tr"), row.next("tr")]) {
      if (neighbor.length > 0 && nearbyInstructionText(neighbor.text())) fragments.push($.html(neighbor));
    }
  } else {
    fragments.push($.html(selectedNode));
    for (const neighbor of [selectedNode.prev(), selectedNode.next()]) {
      if (neighbor.length > 0 && nearbyInstructionText(neighbor.text())) fragments.push($.html(neighbor));
    }
  }
  const fragment = fragments.filter(Boolean).join("\n");
  const context = normalizeCanvasHtml(fragment, baseUrl);
  const cells = row.length > 0
    ? row.find("th, td").map((_index, element) => $(element).text().replace(/\s+/g, " ").trim()).get().filter(Boolean)
    : [];
  return {
    contextMarkdown: context.markdown,
    cells,
    links: context.links,
    matchedBy: winner[1].matchedBy,
  };
}

function sourceContextFromFollowedResource(
  followed: Record<string, unknown>,
  task: TrackedTask,
  directUrl: string,
  baseUrl: string,
): CanvasSourceContext | null {
  const kind = typeof followed.kind === "string" ? followed.kind : "canvas_link";
  const value = followed.value && typeof followed.value === "object"
    ? followed.value as Record<string, unknown>
    : followed;
  if (kind === "page") {
    const relevant = extractRelevantCanvasContext(
      typeof value.body === "string" ? value.body : "",
      taskContextClues(task),
      baseUrl,
    );
    return {
      kind: "page",
      title: typeof value.title === "string" ? value.title : task.display_title,
      url: typeof value.html_url === "string" ? value.html_url : directUrl,
      matchedBy: relevant.matchedBy ?? "direct_url",
      contextMarkdown: relevant.contextMarkdown || (typeof value.bodyMarkdown === "string" ? value.bodyMarkdown : ""),
      cells: relevant.cells,
      links: relevant.links.length > 0 ? relevant.links : canvasLinksFromUnknown(value.links),
      resource: compactCanvasResource(value),
    };
  }
  if (kind === "assignment") {
    return {
      kind: "assignment",
      title: typeof value.name === "string" ? value.name : task.display_title,
      url: typeof value.html_url === "string" ? value.html_url : directUrl,
      matchedBy: "direct_url",
      contextMarkdown: typeof value.directionsMarkdown === "string" ? value.directionsMarkdown : "",
      cells: [],
      links: canvasLinksFromUnknown(value.links),
      resource: compactCanvasResource(value),
    };
  }
  if (["file", "discussion", "quiz", "module_item"].includes(kind)) {
    const title = [value.display_name, value.title, value.name].find((item): item is string => typeof item === "string");
    const markdown = [value.messageMarkdown, value.descriptionMarkdown, value.bodyMarkdown]
      .find((item): item is string => typeof item === "string") ?? "";
    return {
      kind: kind as CanvasSourceContext["kind"],
      title: title ?? task.display_title,
      url: directUrl,
      matchedBy: "direct_url",
      contextMarkdown: markdown,
      cells: [],
      links: canvasLinksFromUnknown(value.links),
      resource: compactCanvasResource(value),
    };
  }
  return null;
}

function taskSourceMayContainDirections(task: TrackedTask): boolean {
  return /agenda|page|table|syllabus/i.test(task.source.type) ||
    Boolean(task.source.url?.match(/\/pages\//i)) ||
    Boolean(task.source.anchor && task.source.anchor !== task.source.key);
}

function taskContextClues(task: TrackedTask): Array<{ value: string; kind: CanvasSourceContext["matchedBy"] }> {
  const fragment = (() => {
    try {
      return task.source.url ? decodeURIComponent(new URL(task.source.url).hash.replace(/^#/, "")) : "";
    } catch {
      return "";
    }
  })();
  return [
    ...uniqueStrings([fragment, task.source.anchor]).map((value) => ({ value, kind: "source_anchor" as const })),
    ...uniqueStrings([task.source.text, task.details]).map((value) => ({ value, kind: "source_text" as const })),
    ...uniqueStrings([task.display_title, task.title]).map((value) => ({ value, kind: "task_title" as const })),
  ];
}

function sourceRecoveryQueries(task: TrackedTask): string[] {
  const pageSlug = sourcePageSlugs(task).map((value) => value.replace(/[-_]+/g, " "));
  return uniqueStrings([
    ...pageSlug,
    task.source.anchor,
    task.source_date,
    task.source.text.length <= 100 ? task.source.text : undefined,
    task.display_title,
  ]);
}

function sourcePageSlugs(task: TrackedTask): string[] {
  const values: string[] = [];
  if (task.source.url) {
    try {
      const match = new URL(task.source.url).pathname.match(/\/pages\/([^/]+)/);
      if (match?.[1]) values.push(decodeURIComponent(match[1]));
    } catch {
      // The source URL is optional; the anchor may still encode the page slug.
    }
  }
  const anchorMatch = task.source.anchor.match(/^canvas:(.+):\d+$/u);
  if (anchorMatch?.[1]) values.push(anchorMatch[1]);
  return uniqueStrings(values);
}

function assignmentRecoveryQueries(task: TrackedTask): string[] {
  return uniqueStrings([
    task.display_title,
    task.title,
    task.source.text.length <= 120 ? task.source.text : undefined,
    task.source.anchor,
  ]);
}

function rankPagesForTask(pages: CanvasPage[], task: TrackedTask) {
  const tokens = new Set(sourceRecoveryQueries(task).flatMap((query) => [...normalizedTokens(query)]));
  return rankByTitle(pages, (page) => `${page.title} ${page.url}`, tokens);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function dedupeBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const current = key(value);
    if (seen.has(current)) return false;
    seen.add(current);
    return true;
  });
}

function canvasLinksFromUnknown(value: unknown): CanvasLink[] {
  const parsed = z.array(z.object({ text: z.string(), url: z.string(), sameCanvasOrigin: z.boolean() })).safeParse(value);
  return parsed.success ? parsed.data : [];
}

function compactCanvasResource(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => ![
    "body",
    "bodyMarkdown",
    "description",
    "directionsMarkdown",
    "message",
    "messageMarkdown",
    "links",
  ].includes(key)));
}

function normalizeComparable(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function nearbyInstructionText(value: string): boolean {
  return /\b(?:due|submit|submission|upload|turn in|bring|required|materials?|instructions?|revision|revise|link)\b/i.test(value);
}

function emptyAssignmentContext(sourceContext: CanvasSourceContext | null = null): AssignmentContext {
  return {
    assignment: null,
    directionsHtml: "",
    directionsMarkdown: "",
    links: [],
    submissionRequirements: {
      supported: false,
      submissionTypes: [],
      allowedExtensions: [],
      pointsPossible: null,
      allowedAttempts: null,
      locked: false,
      lockExplanation: null,
    },
    externalAssignment: { isExternal: false, url: null },
    sourceContext,
    resolution: { method: "not_found", confidence: 0 },
  };
}

function nextLink(value: string | null, canvasBaseUrl: string): URL | null {
  if (!value) return null;
  for (const section of value.split(",")) {
    const match = section.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === "next") {
      const url = new URL(match[1]!);
      if (url.origin !== new URL(canvasBaseUrl).origin) {
        throw new Error("Canvas pagination attempted to leave the configured origin.");
      }
      return url;
    }
  }
  return null;
}

function normalizedTokens(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase()
      .replace(/\[[^\]]+\]/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter((item) => item.length > 1),
  );
}

function settledValue<T>(result: PromiseSettledResult<T[]>): T[] {
  return result.status === "fulfilled" ? result.value : [];
}

function settledFailure(label: string, result: PromiseSettledResult<unknown>) {
  if (result.status === "fulfilled") return null;
  return {
    section: label,
    reason: result.reason instanceof Error ? result.reason.message : "Canvas access unavailable",
  };
}

function rankByTitle<T>(items: T[], title: (item: T) => string, query: Set<string>) {
  return items
    .map((item) => ({ item, score: tokenSimilarity(query, normalizedTokens(title(item))) }))
    .sort((left, right) => right.score - left.score || title(left.item).localeCompare(title(right.item)));
}

function rankByMultipleQueries<T>(items: T[], title: (item: T) => string, queries: string[]) {
  const tokenQueries = queries.map(normalizedTokens).filter((query) => query.size > 0);
  return items
    .map((item) => ({
      item,
      score: Math.max(0, ...tokenQueries.map((query) => tokenSimilarity(query, normalizedTokens(title(item))))),
    }))
    .sort((left, right) => right.score - left.score || title(left.item).localeCompare(title(right.item)));
}

function tokenSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  const intersection = [...left].filter((item) => right.has(item)).length;
  return (2 * intersection) / (left.size + right.size);
}
