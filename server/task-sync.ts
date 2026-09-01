import { z } from "zod";

import type { ActivityStore } from "./activity.js";

const courseSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  canvas_course_id: z.string().nullable().optional(),
  canvas_base_url: z.string().nullable().optional(),
  canvas_url: z.string().nullable().optional(),
});

const taskSchema = z.object({
  logical_id: z.string(),
  course: courseSchema,
  title: z.string(),
  display_title: z.string(),
  details: z.string().default(""),
  due_date: z.string().nullable(),
  completed: z.boolean().nullable(),
  completion_status: z.string(),
  classification: z.string().nullable().optional(),
  task_type: z.string().nullable().optional(),
  action_kind: z.string().nullable().optional(),
  due_basis: z.string().nullable().optional(),
  due_uncertain: z.boolean().default(false),
  due_uncertain_reason: z.string().nullable().optional(),
  source_date: z.string().nullable().optional(),
  historical: z.boolean().default(false),
  manually_managed: z.boolean().default(false),
  google_task: z.object({
    task_id: z.string().nullable().optional(),
    tasklist_id: z.string().nullable().optional(),
    tasklist_title: z.string().nullable().optional(),
    status: z.string(),
    completed_at: z.string().nullable().optional(),
    deleted: z.boolean(),
    hidden: z.boolean(),
  }),
  source: z.object({
    key: z.string(),
    type: z.string(),
    url: z.string().nullable().optional(),
    anchor: z.string(),
    text: z.string(),
    assignment_url: z.string().nullable().optional(),
  }),
  canvas: z.object({
    course_id: z.string().nullable().optional(),
    assignment_id: z.string().nullable().optional(),
    course_url: z.string().nullable().optional(),
    assignment_url: z.string().nullable().optional(),
  }),
});

type ParsedTrackedTask = z.infer<typeof taskSchema>;
export type TrackedTask = Omit<ParsedTrackedTask, "manually_managed"> & {
  manually_managed?: boolean;
};

const taskCourseSchema = z.object({
  id: z.string(),
  settings: z.object({
    name: z.string(),
    prefix: z.string(),
  }),
});

export type TaskCourse = z.infer<typeof taskCourseSchema>;

export const manualTaskInputSchema = z.object({
  course_id: z.string().min(1),
  title: z.string().trim().min(1).max(1024),
  details: z.string().max(8192).default(""),
  due_date: z.string().date().nullable(),
  completed: z.boolean(),
  classification: z.enum(["homework", "classwork"]),
  task_type: z.enum(["assignment", "quiz", "test"]),
  action_kind: z.enum(["practice", "complete", "bring", "present", "submit", "read", "study", "write", "other"]),
  source_url: z.string().url().nullable(),
  assignment_url: z.string().url().nullable(),
});

export type ManualTaskInput = z.infer<typeof manualTaskInputSchema>;

const browserResourceSchema = z.object({
  ok: z.literal(true),
  source_type: z.string(),
  source_url: z.string().url(),
  resource_id: z.string(),
  title: z.string(),
  captured_at: z.string(),
  content: z.string(),
  content_truncated: z.boolean(),
  items: z.array(z.record(z.string(), z.unknown())),
  items_truncated: z.boolean(),
  metadata: z.record(z.string(), z.unknown()),
  warnings: z.array(z.string()),
  capture_status: z.enum(["cached", "captured"]).optional(),
});

export type BrowserResource = z.infer<typeof browserResourceSchema>;

export class TaskSyncRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TaskSyncRequestError";
  }
}

export class TaskSyncClient {
  private csrfTokenPromise: Promise<string> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly activity: ActivityStore,
  ) {}

  async listTasks(completed: boolean | undefined = false): Promise<TrackedTask[]> {
    const query = completed === undefined ? "" : `?completed=${completed}`;
    return z.array(taskSchema).parse(await this.get(`/tasks${query}`));
  }

  async getTask(logicalId: string): Promise<TrackedTask> {
    return taskSchema.parse(await this.get(`/tasks/${encodeURIComponent(logicalId)}`));
  }

  async listCourses(): Promise<TaskCourse[]> {
    return z.array(taskCourseSchema).parse(await this.get("/courses"));
  }

  async createTask(input: ManualTaskInput): Promise<TrackedTask> {
    return taskSchema.parse(await this.mutate("/tasks", "POST", input));
  }

  async updateTask(logicalId: string, input: ManualTaskInput): Promise<TrackedTask> {
    return taskSchema.parse(await this.mutate(
      `/tasks/${encodeURIComponent(logicalId)}`,
      "PUT",
      input,
    ));
  }

  async health(): Promise<{ connected: boolean; apiVersion?: number; error?: string }> {
    try {
      const value = z
        .object({ api_version: z.number() })
        .parse(await this.get("/bootstrap", false));
      return { connected: true, apiVersion: value.api_version };
    } catch (error) {
      return { connected: false, error: error instanceof Error ? error.message : "Unavailable" };
    }
  }

  async readBrowserResource(url: string, timeoutSeconds = 75): Promise<BrowserResource> {
    let csrfToken = await this.csrfToken();
    try {
      return await this.readBrowserResourceWithToken(url, timeoutSeconds, csrfToken);
    } catch (error) {
      if (!(error instanceof TaskSyncRequestError)
        || error.status !== 403
        || error.code !== "csrf_failed") {
        throw error;
      }

      this.csrfTokenPromise = null;
      csrfToken = await this.csrfToken();
      return this.readBrowserResourceWithToken(url, timeoutSeconds, csrfToken);
    }
  }

  private async readBrowserResourceWithToken(
    url: string,
    timeoutSeconds: number,
    csrfToken: string,
  ): Promise<BrowserResource> {
    return browserResourceSchema.parse(await this.request(
      "/agent/browser-resources/read",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({ url, timeout_seconds: timeoutSeconds }),
        signal: AbortSignal.timeout((timeoutSeconds + 10) * 1_000),
      },
      true,
    ));
  }

  private async get(path: string, log = true): Promise<unknown> {
    return this.request(path, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    }, log);
  }

  private async csrfToken(): Promise<string> {
    this.csrfTokenPromise ??= this.get("/bootstrap", false).then((value) =>
      z.object({ csrf_token: z.string().min(20) }).parse(value).csrf_token).catch((error) => {
        this.csrfTokenPromise = null;
        throw error;
      });
    return this.csrfTokenPromise;
  }

  private async mutate(path: string, method: "POST" | "PUT", body: unknown): Promise<unknown> {
    const execute = async () => this.request(path, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-CSRF-Token": await this.csrfToken(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }, true);
    try {
      return await execute();
    } catch (error) {
      if (!(error instanceof TaskSyncRequestError) || error.code !== "csrf_failed") throw error;
      this.csrfTokenPromise = null;
      return execute();
    }
  }

  private async request(path: string, init: RequestInit, log: boolean): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const started = performance.now();
    try {
      const response = await fetch(url, init);
      if (!response.ok) {
        const body = (await response.text()).slice(0, 2_000);
        if (response.status === 404 && path.startsWith("/tasks")) {
          throw new Error(
            "Canvas Task Sync does not expose the task API yet. Restart it after updating the repo.",
          );
        }
        const parsed = parseTaskSyncError(body);
        throw new TaskSyncRequestError(
          parsed?.error?.message ?? `Task Sync returned ${response.status}: ${body.slice(0, 500)}`,
          parsed?.error?.code ?? "task_sync_request_failed",
          response.status,
        );
      }
      if (log) {
        await this.activity.record({
          category: "task_sync",
          action: init.method ?? "GET",
          status: "completed",
          summary: path.split("?")[0] ?? path,
          metadata: { durationMs: Math.round(performance.now() - started) },
        });
      }
      return response.json();
    } catch (error) {
      if (log) {
        await this.activity.record({
          category: "task_sync",
          action: init.method ?? "GET",
          status: "failed",
          summary: path.split("?")[0] ?? path,
          metadata: { error: error instanceof Error ? error.message : "Request failed" },
        });
      }
      throw error;
    }
  }
}

function parseTaskSyncError(body: string): { error?: { code?: string; message?: string } } | null {
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== "object") return null;
    return value as { error?: { code?: string; message?: string } };
  } catch {
    return null;
  }
}
