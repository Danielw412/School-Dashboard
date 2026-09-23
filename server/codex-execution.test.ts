import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ThreadEvent } from "@openai/codex-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCodexTurn } from "./codex-execution.js";

const sdk = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  threadOptions: [] as Array<Record<string, unknown>>,
  script: { events: [] as ThreadEvent[], exitError: null as Error | null },
}));

vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    constructor(options: Record<string, unknown>) {
      sdk.options.push(options);
    }

    startThread(options: Record<string, unknown>) {
      sdk.threadOptions.push(options);
      return {
        id: "thread-from-sdk",
        runStreamed: async () => ({
          events: (async function* () {
            for (const event of sdk.script.events) yield event;
            if (sdk.script.exitError) throw sdk.script.exitError;
          })(),
        }),
      };
    }
  },
}));

let codexHome: string;
const savedEnvironment = { ...process.env };

beforeEach(async () => {
  sdk.options.length = 0;
  sdk.threadOptions.length = 0;
  sdk.script = { events: [], exitError: null };
  codexHome = await mkdtemp(join(tmpdir(), "school-codex-home-"));
  await writeFile(join(codexHome, "config.toml"), "[mcp_servers.personal_notes]\ncommand = \"notes\"\n");
  process.env.CODEX_HOME = codexHome;
  process.env.CANVAS_API_TOKEN = "canvas-secret";
  process.env.SCHOOL_DASHBOARD_WORKER_TOKEN = "worker-secret";
});

afterEach(async () => {
  process.env = { ...savedEnvironment };
  await rm(codexHome, { recursive: true, force: true });
});

const turn = {
  model: "gpt-6-luna",
  reasoningEffort: "high",
  instructions: "Find the directions.",
  outputSchema: { type: "object" },
  networkAccessEnabled: true,
  workingDirectory: "C:/worker-workspaces/task-1",
  mcp: { url: "http://latitude7370:8892/api/internal/canvas-mcp", token: "tool-capability" },
};

describe("runCodexTurn", () => {
  it("runs read-only Codex with only the scoped dashboard MCP server and no dashboard secrets", async () => {
    sdk.script.events = [
      { type: "thread.started", thread_id: "thread-1" },
      { type: "item.completed", item: { id: "m", type: "agent_message", text: "{\"ok\":true}" } },
      { type: "turn.completed", usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 2 } },
    ] as ThreadEvent[];
    const seen: string[] = [];

    const result = await runCodexTurn(turn, {
      signal: new AbortController().signal,
      onEvent: (event) => {
        seen.push(event.type);
      },
    });

    expect(result).toEqual({
      threadId: "thread-from-sdk",
      usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 2 },
      finalResponse: "{\"ok\":true}",
    });
    expect(seen).toEqual(["thread.started", "item.completed", "turn.completed"]);
    const options = sdk.options[0] as { env: Record<string, string>; config: { features: Record<string, boolean> }; configOverrides: string[] };
    expect(options.env.SCHOOL_DASHBOARD_TOOL_TOKEN).toBe("tool-capability");
    expect(options.env).not.toHaveProperty("CANVAS_API_TOKEN");
    expect(options.env).not.toHaveProperty("SCHOOL_DASHBOARD_WORKER_TOKEN");
    expect(options.config.features.shell_tool).toBe(false);
    expect(options.configOverrides).toContain("mcp_servers.personal_notes.enabled=false");
    expect(options.configOverrides).toContain('mcp_servers.school_dashboard.url="http://latitude7370:8892/api/internal/canvas-mcp"');
    expect(sdk.threadOptions[0]).toMatchObject({
      model: "gpt-6-luna",
      modelReasoningEffort: "high",
      sandboxMode: "read-only",
      workingDirectory: "C:/worker-workspaces/task-1",
      approvalPolicy: "never",
    });
  });

  it("reports the turn's own failure instead of the CLI's exit noise", async () => {
    sdk.script.events = [
      { type: "thread.started", thread_id: "thread-2" },
      { type: "turn.failed", error: { message: "You've hit your usage limit. Try again at 9:05 PM." } },
    ] as ThreadEvent[];
    sdk.script.exitError = new Error("Codex Exec exited with code 1: Reading prompt from stdin... rmcp: fail to get common stream");

    await expect(runCodexTurn({ ...turn, mcp: null }, { signal: new AbortController().signal, onEvent: () => undefined }))
      .rejects.toThrow("You've hit your usage limit. Try again at 9:05 PM.");
    expect((sdk.options[0] as { config: { features: Record<string, boolean> } }).config.features.shell_tool).toBe(true);
  });
});
