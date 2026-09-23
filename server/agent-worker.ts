import { createHash } from "node:crypto";
import { hostname } from "node:os";

import { codexCliVersion, listCodexModels } from "./codex-models.js";
import { APP_ROOT, env, WORKER_WORKSPACE_ROOT } from "./env.js";
import { AgentWorkerClient } from "./worker-client.js";

// Laptop agent worker: `npm run worker`. Reads SCHOOL_DASHBOARD_SERVER_URL and
// SCHOOL_DASHBOARD_WORKER_TOKEN from .env and dials out to the dashboard over the tailnet.

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (!env.serverUrl) {
  fail("Set SCHOOL_DASHBOARD_SERVER_URL in .env to the dashboard server, for example http://latitude7370:8892.");
}
if (!/^https?:\/\//u.test(env.serverUrl)) {
  fail("SCHOOL_DASHBOARD_SERVER_URL must start with http:// or https://.");
}
if (!env.workerToken) {
  fail("Set SCHOOL_DASHBOARD_WORKER_TOKEN in .env to the same value the dashboard server uses.");
}

const name = env.workerName || hostname();
const worker = new AgentWorkerClient({
  serverUrl: env.serverUrl,
  token: env.workerToken,
  name,
  // Stable per machine and checkout, so the server recognizes a reconnecting worker.
  workerId: createHash("sha256").update(`${hostname()}\0${APP_ROOT}`).digest("hex").slice(0, 32),
  maxConcurrentJobs: Number.isFinite(env.workerConcurrency)
    ? Math.min(16, Math.max(1, env.workerConcurrency))
    : 3,
  workspaceRoot: WORKER_WORKSPACE_ROOT,
  codexVersion: codexCliVersion(),
  listModels: () => listCodexModels(),
});

const shutdown = (signal: string) => {
  process.stdout.write(`[${new Date().toISOString()}] Received ${signal}; stopping the agent worker.\n`);
  void worker.stop().finally(() => setTimeout(() => process.exit(0), 250));
};
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

process.stdout.write(
  `[${new Date().toISOString()}] School Dashboard agent worker ${name} (Codex ${codexCliVersion() ?? "unknown"}) connecting to ${env.serverUrl}\n`,
);
await worker.start();
