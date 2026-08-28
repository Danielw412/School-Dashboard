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

export type CanvasAssignment = z.infer<typeof canvasAssignmentSchema>;
export type CanvasPage = z.infer<typeof canvasPageSchema>;
export type CanvasModule = z.infer<typeof canvasModuleSchema>;
export type CanvasModuleItem = z.infer<typeof canvasModuleItemSchema>;
export type CanvasFile = z.infer<typeof canvasFileSchema>;

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
  resolution: {
    method: "canvas_id" | "title_search" | "not_found";
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

  async listAssignments(courseId: string, search?: string): Promise<CanvasAssignment[]> {
    const values = await this.paginate(
      `/courses/${encodeURIComponent(courseId)}/assignments`,
      search ? { search_term: search, per_page: "100" } : { per_page: "100" },
    );
    return z.array(canvasAssignmentSchema).parse(values);
  }

  async searchCourse(courseId: string, query: string): Promise<Record<string, unknown>> {
    const encodedCourse = encodeURIComponent(courseId);
    const [assignments, pages, modules, files] = await Promise.all([
      this.listAssignments(courseId, query),
      this.paginate(`/courses/${encodedCourse}/pages`, {
        search_term: query,
        per_page: "100",
      }).then((value) => z.array(canvasPageSchema).parse(value)),
      this.listModules(courseId),
      this.paginate(`/courses/${encodedCourse}/files`, {
        search_term: query,
        per_page: "100",
      }).then((value) => z.array(canvasFileSchema).parse(value)),
    ]);
    const tokens = normalizedTokens(query);
    return {
      query,
      assignments: rankByTitle(assignments, (item) => item.name, tokens).slice(0, 20),
      pages: rankByTitle(pages, (item) => item.title, tokens).slice(0, 20),
      modules: rankByTitle(modules, (item) => item.name, tokens).slice(0, 20),
      files: rankByTitle(files, (item) => item.display_name, tokens).slice(0, 20),
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

  async getPage(courseId: string, slug: string): Promise<CanvasPage> {
    return canvasPageSchema.parse(
      await this.requestJson(
        `/courses/${encodeURIComponent(courseId)}/pages/${encodeURIComponent(slug)}`,
      ),
    );
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
      return {
        kind: "assignment",
        value: await this.getAssignment(assignment[1]!, assignment[2]!),
      };
    }
    const page = url.pathname.match(/\/courses\/(\d+)\/pages\/([^/]+)/);
    if (page) {
      return {
        kind: "page",
        value: await this.getPage(page[1]!, decodeURIComponent(page[2]!)),
      };
    }
    const file = url.pathname.match(/\/courses\/\d+\/files\/(\d+)|\/files\/(\d+)/);
    if (file) {
      return { kind: "file", value: await this.getFile(file[1] ?? file[2]!) };
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
    let assignment: CanvasAssignment | null = null;
    let method: AssignmentContext["resolution"]["method"] = "not_found";
    let confidence = 0;
    if (task.canvas.assignment_id) {
      assignment = await this.getAssignment(courseId, task.canvas.assignment_id);
      method = "canvas_id";
      confidence = 1;
    } else {
      const candidates = await this.listAssignments(courseId, task.display_title);
      const ranked = rankByTitle(
        candidates,
        (item) => item.name,
        normalizedTokens(task.display_title),
      );
      const best = ranked[0];
      const runnerUp = ranked[1];
      if (best && best.score >= 0.55 && (!runnerUp || best.score - runnerUp.score >= 0.08)) {
        assignment = best.item;
        method = "title_search";
        confidence = best.score;
      }
    }
    if (!assignment) {
      return emptyAssignmentContext();
    }
    const directions = normalizeCanvasHtml(assignment.description ?? "", this.baseUrl);
    const externalUrl = assignment.external_tool_tag_attributes?.url ?? null;
    const isExternal = assignment.submission_types.includes("external_tool") || Boolean(externalUrl);
    const supportedTypes = new Set(["online_text_entry", "online_url", "online_upload"]);
    return {
      assignment,
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
      resolution: { method, confidence },
    };
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
    $(element).attr("href", resolved.toString());
    links.push({
      text: $(element).text().trim() || resolved.pathname,
      url: resolved.toString(),
      sameCanvasOrigin: resolved.origin === canvasOrigin,
    });
  });
  $("img[src]").each((_index, element) => {
    const src = $(element).attr("src");
    if (src) $(element).attr("src", new URL(src, baseUrl).toString());
  });
  const html = $("body").html() ?? "";
  const turndown = new TurndownService({ bulletListMarker: "-", headingStyle: "atx" });
  return { html, markdown: turndown.turndown(html), links };
}

function emptyAssignmentContext(): AssignmentContext {
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

function rankByTitle<T>(items: T[], title: (item: T) => string, query: Set<string>) {
  return items
    .map((item) => ({ item, score: tokenSimilarity(query, normalizedTokens(title(item))) }))
    .sort((left, right) => right.score - left.score || title(left.item).localeCompare(title(right.item)));
}

function tokenSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  const intersection = [...left].filter((item) => right.has(item)).length;
  return (2 * intersection) / (left.size + right.size);
}
