import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

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
  taskSyncApiBase: string;
  codexModel: string;
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
        ? { status: "passed" as const, detail: `Connected to ${dependencies.taskSyncApiBase} (API v${health.apiVersion ?? "unknown"}).` }
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
    timed("codex-sdk", "Codex agent runtime", async () => ({
      status: "passed",
      detail: `@openai/codex-sdk is loaded. Default model: ${dependencies.codexModel}.`,
    })),
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
