import { z } from "zod";

// JSON text frames exchanged over the laptop worker's outbound WebSocket.
// Bump the version for incompatible changes; both sides refuse a mismatched peer.
export const WORKER_PROTOCOL_VERSION = 1;
export const WORKER_CONNECT_PATH = "/api/agent-worker/connect";

const runIdSchema = z.string().uuid();
export const workspaceIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,120}$/u);

export const codexModelInfoSchema = z.object({
  id: z.string().min(1).max(120),
  displayName: z.string().max(200),
  hidden: z.boolean(),
  isDefault: z.boolean(),
  reasoningEfforts: z.array(z.string().max(40)).max(20),
  defaultReasoningEffort: z.string().max(40).nullable(),
});
export type CodexModelInfo = z.infer<typeof codexModelInfoSchema>;

export const workerJobSchema = z.object({
  runId: runIdSchema,
  feature: z.string().min(1),
  taskTitle: z.string(),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1),
  instructions: z.string().min(1),
  outputSchema: z.unknown(),
  networkAccessEnabled: z.boolean(),
  // The run's seed files; tool-produced files stay in the server workspace behind MCP.
  workspace: z.object({
    id: workspaceIdSchema,
    files: z.array(z.object({ path: z.string().min(1).max(400), data: z.string() })).max(500),
  }),
  toolToken: z.string().min(16).nullable(),
  // Path on the dashboard server; the worker resolves it against the URL it dialed.
  mcpPath: z.string().startsWith("/"),
  timeoutMs: z.number().int().positive(),
});
export type WorkerJob = z.infer<typeof workerJobSchema>;

const usageSchema = z.looseObject({
  input_tokens: z.number(),
  cached_input_tokens: z.number(),
  output_tokens: z.number(),
});

export const workerJobResultSchema = z.object({
  threadId: z.string().nullable(),
  usage: usageSchema.nullable(),
  finalResponse: z.string().nullable(),
});

const threadEventSchema = z.looseObject({ type: z.string().min(1) });

export const workerHelloSchema = z.object({
  type: z.literal("hello"),
  protocol: z.number().int(),
  worker: z.object({
    id: z.string().min(1).max(120),
    name: z.string().min(1).max(120),
    hostname: z.string().max(255),
    platform: z.string().max(40),
    codexVersion: z.string().max(40).nullable(),
    maxConcurrentJobs: z.number().int().min(1).max(16),
  }),
  models: z.array(codexModelInfoSchema).max(200).nullable(),
  modelsError: z.string().max(2000).nullable(),
  // Jobs still running on the laptop, and finished ones whose result the server has not acked.
  activeRunIds: z.array(runIdSchema).max(64),
  finishedRunIds: z.array(runIdSchema).max(64),
});
export type WorkerHello = z.infer<typeof workerHelloSchema>;

export const workerMessageSchema = z.discriminatedUnion("type", [
  workerHelloSchema,
  z.object({ type: z.literal("job.accepted"), runId: runIdSchema }),
  z.object({ type: z.literal("job.event"), runId: runIdSchema, event: threadEventSchema }),
  z.object({
    type: z.literal("job.finished"),
    runId: runIdSchema,
    status: z.enum(["completed", "failed", "cancelled"]),
    result: workerJobResultSchema.nullable(),
    error: z.string().max(4000).nullable(),
  }),
  z.object({
    type: z.literal("models"),
    codexVersion: z.string().max(40).nullable(),
    models: z.array(codexModelInfoSchema).max(200).nullable(),
    modelsError: z.string().max(2000).nullable(),
  }),
]);
export type WorkerMessage = z.infer<typeof workerMessageSchema>;
export type WorkerJobFinished = Extract<WorkerMessage, { type: "job.finished" }>;

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("welcome"),
    protocol: z.number().int(),
    // Runs the server still wants from this worker; the worker cancels and forgets the rest.
    activeRunIds: z.array(runIdSchema),
  }),
  z.object({ type: z.literal("job.start"), job: workerJobSchema }),
  z.object({ type: z.literal("job.cancel"), runId: runIdSchema, reason: z.string() }),
  z.object({ type: z.literal("job.ack"), runId: runIdSchema }),
  z.object({ type: z.literal("refresh-models") }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
