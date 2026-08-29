import { readFile } from "node:fs/promises";
import { join } from "node:path";

import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z, ZodError } from "zod";

import { ActivityStore } from "./activity.js";
import { buildAgentProgress } from "./agent-progress.js";
import { AgentRunner, AgentRunStore } from "./agent-runner.js";
import { CanvasClient } from "./canvas-client.js";
import { APP_ROOT, env, TEMP_WORKSPACE_ROOT } from "./env.js";
import { SettingsStore } from "./settings.js";
import { TaskSyncClient } from "./task-sync.js";
import { CanvasToolSessions, ToolAuthorizationError } from "./tool-sessions.js";
import { safeChild, WorkspaceManager } from "./workspace.js";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
});
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

const activity = new ActivityStore();
const settingsStore = new SettingsStore();
const settings = await settingsStore.get();
const taskSync = new TaskSyncClient(settings.connections.taskSyncApiBase, activity);
const canvas = new CanvasClient(settings.connections.canvasBaseUrl || env.canvasBaseUrl, activity);
const workspaces = new WorkspaceManager(activity);
const runs = new AgentRunStore();
await runs.failInterrupted();
const toolSessions = new CanvasToolSessions(canvas, workspaces, activity);
const agentRunner = new AgentRunner(
  settingsStore,
  taskSync,
  canvas,
  workspaces,
  toolSessions,
  activity,
  runs,
);

app.get("/api/health", async (_request, response) => {
  const [taskSyncHealth, canvasHealth] = await Promise.all([
    taskSync.health(),
    canvas.health(),
  ]);
  response.json({
    status: taskSyncHealth.connected && canvasHealth.connected ? "ready" : "degraded",
    taskSync: taskSyncHealth,
    canvas: canvasHealth,
    agent: { sdk: "@openai/codex-sdk", defaultModel: (await settingsStore.get()).defaultModel },
  });
});

app.get("/api/tasks", async (request, response) => {
  const completed = request.query.completed === "true";
  const tasks = await taskSync.listTasks(completed);
  response.json(tasks.filter((task) => task.completed === completed));
});

app.get("/api/tasks/:logicalId", async (request, response) => {
  response.json(await taskSync.getTask(request.params.logicalId));
});

app.get("/api/tasks/:logicalId/context", async (request, response) => {
  const task = await taskSync.getTask(request.params.logicalId);
  response.json(await canvas.assignmentContext(task));
});

app.get("/api/overview", async (_request, response) => {
  const tasks = (await taskSync.listTasks(false)).filter((task) => task.completed === false);
  const now = new Date();
  const endOfWeek = new Date(now);
  endOfWeek.setDate(now.getDate() + 7);
  const dueThisWeek = tasks.filter((task) => {
    if (!task.due_date) return false;
    const due = new Date(task.due_date);
    return due >= now && due <= endOfWeek;
  }).length;
  response.json({
    unfinished: tasks.length,
    dueThisWeek,
    classes: new Set(tasks.map((task) => task.course.id)).size,
    completionDataUnavailable: tasks.some((task) => task.completion_status === "unavailable"),
  });
});

app.get("/api/settings", async (_request, response) => {
  response.json(await settingsStore.get());
});

app.put("/api/settings", async (request, response) => {
  const previous = await settingsStore.get();
  const next = await settingsStore.save(request.body);
  const restartRequired =
    previous.connections.canvasBaseUrl !== next.connections.canvasBaseUrl ||
    previous.connections.taskSyncApiBase !== next.connections.taskSyncApiBase;
  await activity.record({
    category: "system",
    action: "settings.save",
    status: "completed",
    summary: "Local settings updated",
    metadata: { restartRequired },
  });
  response.json({ settings: next, restartRequired });
});

app.post("/api/settings/defaults", async (_request, response) => {
  response.json(await settingsStore.save(settingsStore.defaults()));
});

app.get("/api/agent-runs", async (request, response) => {
  const limit = Number.parseInt(String(request.query.limit ?? "100"), 10);
  response.json(await runs.list(Number.isFinite(limit) ? limit : 100));
});

app.get("/api/agent-runs/:id", async (request, response) => {
  const run = await runs.get(request.params.id);
  if (!run) return response.status(404).json({ error: "Agent run not found." });
  response.json(run);
});

app.get("/api/agent-runs/:id/progress", async (request, response) => {
  const run = await runs.get(request.params.id);
  if (!run) return response.status(404).json({ error: "Agent run not found." });
  response.json(buildAgentProgress(run, await activity.list(500)));
});

app.post("/api/agent-runs", async (request, response) => {
  const run = await agentRunner.start(request.body);
  response.status(202).json(run);
});

app.get("/api/diagnostics", async (_request, response) => {
  const [currentSettings, recentRuns, recentActivity, cache, taskSyncHealth, canvasHealth] =
    await Promise.all([
      settingsStore.get(),
      runs.list(25),
      activity.list(150),
      workspaces.stats(),
      taskSync.health(),
      canvas.health(),
    ]);
  response.json({
    generatedAt: new Date().toISOString(),
    currentModel: currentSettings.defaultModel,
    currentPrompts: currentSettings.prompts,
    featureModels: currentSettings.featureModels,
    reasoningEffort: currentSettings.reasoningEffort,
    connections: {
      taskSync: taskSyncHealth,
      canvas: canvasHealth,
      canvasCredentialConfigured: Boolean(env.canvasToken),
      taskSyncApiBase: currentSettings.connections.taskSyncApiBase,
      canvasBaseUrl: currentSettings.connections.canvasBaseUrl,
    },
    predictor: {
      configured: Boolean(env.predictorCommand),
      message: env.predictorCommand
        ? "External predictor command is configured."
        : "Test Question Predictor is unavailable until TEST_QUESTION_PREDICTOR_COMMAND is configured.",
    },
    cache,
    recentRuns,
    activity: recentActivity,
  });
});

app.post("/api/cache/clear", async (_request, response) => {
  await workspaces.clearCache();
  response.status(204).end();
});

app.post(
  "/api/tasks/:logicalId/submit",
  upload.single("file"),
  async (request, response) => {
    const submissionType = z
      .enum(["online_text_entry", "online_url", "online_upload"])
      .parse(request.body.type);
    if (request.body.confirmation !== "SUBMIT") {
      return response.status(400).json({ error: "Type SUBMIT to confirm this irreversible Canvas action." });
    }
    const task = await taskSync.getTask(String(request.params.logicalId));
    const context = await canvas.assignmentContext(task);
    const courseId = task.canvas.course_id ?? task.course.canvas_course_id;
    const assignmentId = context.assignment?.id?.toString() ?? task.canvas.assignment_id;
    if (!courseId || !assignmentId || !context.assignment) {
      return response.status(409).json({ error: "This task is not resolved to a Canvas assignment." });
    }
    if (!context.assignment.submission_types.includes(submissionType)) {
      return response.status(400).json({ error: `Canvas does not allow ${submissionType} for this assignment.` });
    }
    let submission:
      | { type: "online_text_entry"; text: string }
      | { type: "online_url"; url: string }
      | { type: "online_upload"; fileIds: string[] };
    if (submissionType === "online_text_entry") {
      submission = { type: submissionType, text: z.string().min(1).parse(request.body.text) };
    } else if (submissionType === "online_url") {
      submission = { type: submissionType, url: z.string().url().parse(request.body.url) };
    } else {
      if (!request.file) return response.status(400).json({ error: "Choose a file to upload." });
      const extension = request.file.originalname.split(".").pop()?.toLowerCase();
      if (
        context.assignment.allowed_extensions.length > 0 &&
        extension &&
        !context.assignment.allowed_extensions.map((item) => item.toLowerCase()).includes(extension)
      ) {
        return response.status(400).json({ error: `Canvas does not list .${extension} as an allowed extension.` });
      }
      const fileId = await canvas.uploadSubmissionFile(
        courseId,
        assignmentId,
        request.file.originalname,
        request.file.buffer,
      );
      submission = { type: submissionType, fileIds: [fileId] };
    }
    const result = await canvas.submitAssignment(courseId, assignmentId, submission);
    await activity.record({
      category: "canvas",
      action: "submit",
      status: "completed",
      summary: task.display_title,
      metadata: { logicalId: task.logical_id, submissionType },
    });
    response.json({ submitted: true, result });
  },
);

app.post("/api/internal/canvas-tools", async (request, response) => {
  const result = await toolSessions.execute(
    request.header("x-school-tool-token"),
    request.body.action,
    request.body.input,
  );
  response.json(result);
});

app.get("/workspace-files/:workspaceId/*path", async (request, response) => {
  const workspaceId = z.string().regex(/^[a-zA-Z0-9._-]+$/).parse(request.params.workspaceId);
  const rawPath = request.params.path;
  const requestedPath = Array.isArray(rawPath) ? rawPath.join("/") : String(rawPath ?? "");
  const workspaceRoot = safeChild(TEMP_WORKSPACE_ROOT, workspaceId);
  const filePath = safeChild(workspaceRoot, requestedPath);
  try {
    await readFile(filePath);
    response.sendFile(filePath);
  } catch {
    response.status(404).json({ error: "Workspace file not found." });
  }
});

const distPath = join(APP_ROOT, "dist");
app.use(express.static(distPath));
app.get("/{*path}", (_request, response, next) => {
  response.sendFile(join(distPath, "index.html"), (error) => (error ? next() : undefined));
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  void _next;
  const status = error instanceof ToolAuthorizationError ? 403 : error instanceof ZodError ? 400 : 500;
  const message = error instanceof ZodError
    ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
    : error instanceof Error
      ? error.message
      : "Unexpected server error";
  response.status(status).json({ error: message });
});

await workspaces.pruneWorkspaces(settings.cache.workspaceRetentionHours);
app.listen(env.port, "127.0.0.1", () => {
  void activity.record({
    category: "system",
    action: "server.start",
    status: "completed",
    summary: `School Dashboard listening on http://127.0.0.1:${env.port}`,
  });
  process.stdout.write(`School Dashboard API listening on http://127.0.0.1:${env.port}\n`);
});
