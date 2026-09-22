import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(APP_ROOT, ".env"), quiet: true });

export const APP_DATA_DIR = join(APP_ROOT, ".school-dashboard");
export const CACHE_DIR = join(APP_DATA_DIR, "cache");
export const WORKSPACE_ASSET_DIR = join(APP_DATA_DIR, "workspace-assets");
export const TEMP_WORKSPACE_ROOT = join(tmpdir(), "school-dashboard-workspaces");
export const SETTINGS_PATH = join(APP_DATA_DIR, "settings.json");
export const ACTIVITY_PATH = join(APP_DATA_DIR, "activity.json");
export const RUNS_PATH = join(APP_DATA_DIR, "runs.json");

export const env = {
  port: Number.parseInt(process.env.SCHOOL_DASHBOARD_PORT ?? "8892", 10),
  taskSyncApiBase:
    process.env.TASK_SYNC_API_BASE?.replace(/\/$/, "") ??
    "http://127.0.0.1:8890/api/v1",
  // When set (for example daniel@100.87.157.44), Task Sync runs on that server and is reached
  // through a supervised SSH tunnel; TASK_SYNC_API_BASE and the saved connection URL are ignored.
  taskSyncSshTarget: process.env.TASK_SYNC_SSH_TARGET?.trim() ?? "",
  taskSyncRemotePort: Number.parseInt(process.env.TASK_SYNC_REMOTE_PORT ?? "8790", 10),
  canvasBaseUrl: process.env.CANVAS_BASE_URL?.replace(/\/$/, "") ?? "",
  canvasToken: process.env.CANVAS_API_TOKEN ?? "",
  cacheTtlMinutes: Number.parseInt(
    process.env.SCHOOL_DASHBOARD_CACHE_TTL_MINUTES ?? "30",
    10,
  ),
  cacheMaxMb: Number.parseInt(process.env.SCHOOL_DASHBOARD_CACHE_MAX_MB ?? "512", 10),
  predictorCommand: process.env.TEST_QUESTION_PREDICTOR_COMMAND ?? "",
};

export function requireCanvasToken(): string {
  if (!env.canvasToken) {
    throw new Error("CANVAS_API_TOKEN is not configured in the local .env file.");
  }
  return env.canvasToken;
}
