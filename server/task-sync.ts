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

export type TrackedTask = z.infer<typeof taskSchema>;

export class TaskSyncClient {
  constructor(
    private readonly baseUrl: string,
    private readonly activity: ActivityStore,
  ) {}

  async listTasks(completed = false): Promise<TrackedTask[]> {
    return z.array(taskSchema).parse(await this.get(`/tasks?completed=${completed}`));
  }

  async getTask(logicalId: string): Promise<TrackedTask> {
    return taskSchema.parse(await this.get(`/tasks/${encodeURIComponent(logicalId)}`));
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

  private async get(path: string, log = true): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const started = performance.now();
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const body = (await response.text()).slice(0, 500);
        if (response.status === 404 && path.startsWith("/tasks")) {
          throw new Error(
            "Canvas Task Sync does not expose the task API yet. Restart it after updating the repo.",
          );
        }
        throw new Error(`Task Sync returned ${response.status}: ${body}`);
      }
      if (log) {
        await this.activity.record({
          category: "task_sync",
          action: "GET",
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
          action: "GET",
          status: "failed",
          summary: path.split("?")[0] ?? path,
          metadata: { error: error instanceof Error ? error.message : "Request failed" },
        });
      }
      throw error;
    }
  }
}
