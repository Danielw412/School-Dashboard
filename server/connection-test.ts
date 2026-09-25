import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

import { providerLabel } from "../src/models.js";
import type { AgentExecutionStatus } from "./agent-execution.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export type ConnectionCheck = {
  id: string;
  label: string;
  status: "passed" | "warning" | "failed";
  detail: string;
  latencyMs: number;
  optional?: boolean;
};

export type ConnectionTestResult = {
  testedAt: string;
  status: "ready" | "degraded";
  checks: ConnectionCheck[];
};

type Health = { connected: boolean; name?: string; apiVersion?: number; error?: string };

export async function runConnectionTest(dependencies: {
  taskSyncHealth: () => Promise<Health>;
  canvasHealth: () => Promise<Health>;
  canvasCredentialConfigured: boolean;
  canvasBaseUrl: string;
  taskSyncRoute: string;
  // The selected agent's default model, for example "Claude Opus 5".
  agentModel: string;
  agents: AgentExecutionStatus;
  mcpHealth: () => { connected: boolean; name: string; transport: string; toolCount: number };
  workspaceStats: () => Promise<{ files: number; bytes: number; hits: number; misses: number }>;
  predictorConfigured: boolean;
}): Promise<ConnectionTestResult> {
  const checks = await Promise.all([
    timed("dashboard-api", "Dashboard API", async () => ({
      status: "passed",
      detail: "The local API completed this end-to-end test request.",
    })),
    timed("task-sync", "Canvas Task Sync", async () => {
      const health = await dependencies.taskSyncHealth();
      return health.connected
        ? { status: "passed" as const, detail: `Connected to ${dependencies.taskSyncRoute} (API v${health.apiVersion ?? "unknown"}).` }
        : { status: "failed" as const, detail: health.error || "Canvas Task Sync is unavailable." };
    }),
    timed("canvas", "Canvas API", async () => {
      const health = await dependencies.canvasHealth();
      return health.connected
        ? { status: "passed" as const, detail: health.name ? `Connected as ${health.name}.` : "Canvas accepted the configured credentials." }
        : { status: "failed" as const, detail: health.error || `Canvas is unavailable at ${dependencies.canvasBaseUrl}.` };
    }),
    timed("canvas-credentials", "Canvas credentials", async () => dependencies.canvasCredentialConfigured
      ? { status: "passed" as const, detail: "The Canvas base URL and server-side API token are configured." }
      : { status: "failed" as const, detail: "CANVAS_API_TOKEN is missing from the local environment." }),
    ...agentChecks(dependencies.agents, dependencies.agentModel),
    timed("assignment-mcp", "Assignment MCP", async () => {
      const health = dependencies.mcpHealth();
      return health.connected
        ? { status: "passed" as const, detail: `${health.name} exposes ${health.toolCount} scoped tools over ${health.transport}.` }
        : { status: "failed" as const, detail: "The assignment-scoped MCP bridge is unavailable." };
    }),
    timed("pdf-tools", "PDF tools", async () => {
      await Promise.all(["pdfinfo", "pdftotext", "pdftoppm"].map((command) =>
        execFileAsync(command, ["-v"], { timeout: 10_000, windowsHide: true }),
      ));
      return { status: "passed", detail: "Poppler inspection, text extraction, and page rendering are available." };
    }),
    timed("ocr", "OCR runtime", async () => {
      require.resolve("tesseract.js");
      require.resolve("@tesseract.js-data/eng");
      return { status: "passed", detail: "Tesseract.js and the local English language data are available." };
    }),
    timed("workspace", "Workspace and cache", async () => {
      const stats = await dependencies.workspaceStats();
      return { status: "passed", detail: `Local workspace storage is readable (${stats.files} cached files).` };
    }),
    timed("predictor", "Test Question Predictor", async () => dependencies.predictorConfigured
      ? { status: "passed" as const, detail: "The optional predictor command is configured and will be exercised by a study-guide run.", optional: true }
      : { status: "warning" as const, detail: "Optional integration is not configured.", optional: true }),
  ]);
  return {
    testedAt: new Date().toISOString(),
    status: checks.some((check) => check.status === "failed") ? "degraded" : "ready",
    checks,
  };
}

// One check per place agents can run, for the selected agent. Only the selected target is
// required; the other is reported as optional so an offline laptop does not fail a server-agent
// setup, or vice versa.
function agentChecks(agents: AgentExecutionStatus, agentModel: string): Array<Promise<ConnectionCheck>> {
  const targets = agents.targets ?? [{
    id: agents.mode,
    label: agents.mode === "worker" ? "Laptop" : "This computer",
    host: agents.worker?.name ?? null,
    available: agents.available,
    message: agents.message,
    activeJobs: agents.activeJobs,
    queuedJobs: agents.queuedJobs,
  }];
  return targets.map((target) => {
    const selected = target.id === agents.mode;
    const agent = providerLabel(agents.provider);
    const label = targets.length > 1
      ? `${target.label} ${agent} agents${selected ? " (selected)" : ""}`
      : target.id === "worker" ? "Laptop agent worker" : `${agent} agent runtime`;
    return timed(selected ? "agent-sdk" : `agent-${target.id}`, label, async () => {
      const worker = agents.worker;
      const defaultModel = selected ? ` Default model: ${agentModel}.` : "";
      if (!target.available) {
        return selected
          ? { status: "failed" as const, detail: target.message }
          : { status: "warning" as const, detail: target.message, optional: true };
      }
      const versions = [
        `Codex ${worker?.codexVersion ?? "unknown"}`,
        ...(worker?.claude?.version ? [`Claude Code ${worker.claude.version}`] : []),
      ].join(", ");
      const detail = target.id === "worker" && worker
        ? `${worker.name} is connected over the tailnet (${versions}, up to ${worker.maxConcurrentJobs} parallel runs).`
        : target.message;
      return { status: "passed" as const, detail: `${detail}${defaultModel}`, ...(selected ? {} : { optional: true }) };
    });
  });
}

async function timed(
  id: string,
  label: string,
  test: () => Promise<{ status: ConnectionCheck["status"]; detail: string; optional?: boolean }>,
): Promise<ConnectionCheck> {
  const started = performance.now();
  try {
    const result = await test();
    return { id, label, ...result, latencyMs: Math.max(0, Math.round(performance.now() - started)) };
  } catch (error) {
    return {
      id,
      label,
      status: "failed",
      detail: connectionErrorDetail(error),
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
    };
  }
}

function connectionErrorDetail(error: unknown): string {
  if (!(error instanceof Error)) return "Connection test failed.";
  const code = "code" in error && typeof error.code === "string" ? error.code : null;
  if (code === "EPERM") {
    return "The server was blocked from launching this local tool. Check its execute permission and restart the dashboard.";
  }
  if (code === "ENOENT") return "The required local command could not be found on PATH.";
  return error.message;
}
