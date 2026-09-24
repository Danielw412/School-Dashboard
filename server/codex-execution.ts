import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  Codex,
  type ModelReasoningEffort,
  type ThreadEvent,
  type Usage,
} from "@openai/codex-sdk";

import { listCodexMcpServers } from "./codex-models.js";

// One Codex turn, runnable in-process (local mode) or by the laptop agent worker. Everything here
// reads the Codex installation of the machine it runs on: its binary, ~/.codex auth, sessions,
// and config.toml. It never needs Canvas credentials.

export type CodexTurnRequest = {
  model: string;
  reasoningEffort: string;
  instructions: string;
  outputSchema: unknown;
  networkAccessEnabled: boolean;
  workingDirectory: string;
  // The assignment-scoped school_dashboard MCP endpoint and its short-lived bearer capability.
  mcp: { url: string; token: string } | null;
};

export type CodexTurnResult = {
  threadId: string | null;
  usage: Usage | null;
  finalResponse: string | null;
};

export type CodexTurnCallbacks = {
  signal: AbortSignal;
  onEvent: (event: ThreadEvent) => Promise<void> | void;
};

export async function runCodexTurn(
  request: CodexTurnRequest,
  { signal, onEvent }: CodexTurnCallbacks,
): Promise<CodexTurnResult> {
  const env = {
    ...sanitizedEnvironment(),
    ...(request.mcp ? { SCHOOL_DASHBOARD_TOOL_TOKEN: request.mcp.token } : {}),
  };
  // Discover servers with the same feature flags as the turn. A plugin-only server discovered
  // with plugins enabled would become an invalid transport when the turn disables plugins.
  const [reportedMcpServers, configuredMcpServers] = await Promise.all([
    listCodexMcpServers({
      env,
      cwd: request.workingDirectory,
      configOverrides: ["features.apps=false", "features.plugins=false"],
    }),
    configuredMcpServerNames(),
  ]);
  signal.throwIfAborted();
  const codex = new Codex({
    env,
    config: {
      show_raw_agent_reasoning: false,
      features: {
        apps: false,
        plugins: false,
        browser_use: false,
        browser_use_external: false,
        computer_use: false,
        image_generation: false,
        skill_search: false,
        shell_tool: !request.mcp,
      },
    },
    configOverrides: buildMcpConfigOverrides(
      request.mcp?.url ?? null,
      reportedMcpServers ?? configuredMcpServers,
      reportedMcpServers === null,
    ),
  });
  const thread = codex.startThread({
    model: request.model,
    modelReasoningEffort: request.reasoningEffort as ModelReasoningEffort,
    sandboxMode: "read-only",
    workingDirectory: request.workingDirectory,
    skipGitRepoCheck: true,
    networkAccessEnabled: request.networkAccessEnabled,
    webSearchMode: "disabled",
    approvalPolicy: "never",
    threadSource: "school-dashboard",
  });
  const { events } = await thread.runStreamed(request.instructions, {
    outputSchema: request.outputSchema,
    signal,
  });
  let threadId: string | null = null;
  let usage: Usage | null = null;
  let finalResponse: string | null = null;
  // The turn's own error (usage limits, rejected models). The CLI then exits non-zero, and that
  // exit's stderr would otherwise replace this message with transport noise.
  let turnFailure: string | null = null;
  try {
    for await (const event of events) {
      signal.throwIfAborted();
      if (event.type === "thread.started") threadId = event.thread_id;
      if (event.type === "turn.completed") usage = event.usage;
      if (event.type === "turn.failed") turnFailure = event.error.message;
      if (event.type === "error") turnFailure = event.message;
      if (event.type === "item.completed" && event.item.type === "agent_message") {
        finalResponse = event.item.text;
      }
      await onEvent(event);
    }
  } catch (error) {
    if (turnFailure && !signal.aborted) throw new Error(turnFailure, { cause: error });
    throw error;
  }
  signal.throwIfAborted();
  if (turnFailure && !finalResponse) throw new Error(turnFailure);
  return { threadId: thread.id ?? threadId, usage, finalResponse };
}

// MCP servers the Codex desktop app adds on the laptop. Disabling a server that no config layer
// defines makes Codex reject the whole configuration ("invalid transport"), so these are assumed
// only when Codex could not report its actual server list.
const BUILTIN_MCP_SERVERS = ["node_repl", "openaiDeveloperDocs", "cua_repl"];

export function buildMcpConfigOverrides(
  schoolDashboardUrl: string | null,
  configuredServers: string[] = [],
  includeBuiltinServers = true,
): string[] {
  const overrides = [...new Set([...(includeBuiltinServers ? BUILTIN_MCP_SERVERS : []), ...configuredServers])]
    .filter((name) => name !== "school_dashboard" && /^[A-Za-z0-9_-]+$/u.test(name))
    .map((name) => `mcp_servers.${name}.enabled=false`);
  if (!schoolDashboardUrl) return overrides;
  return [
    ...overrides,
    `mcp_servers.school_dashboard.url=${JSON.stringify(schoolDashboardUrl)}`,
    'mcp_servers.school_dashboard.bearer_token_env_var="SCHOOL_DASHBOARD_TOOL_TOKEN"',
    "mcp_servers.school_dashboard.required=true",
    "mcp_servers.school_dashboard.startup_timeout_sec=10",
    "mcp_servers.school_dashboard.tool_timeout_sec=240",
    'mcp_servers.school_dashboard.default_tools_approval_mode="auto"',
  ];
}

export async function configuredMcpServerNames(
  configPath = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml"),
): Promise<string[]> {
  try {
    const config = await readFile(configPath, "utf8");
    const names = new Set<string>();
    const pattern = /^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))(?:\.[^\]]+)?\]\s*$/gmu;
    for (const match of config.matchAll(pattern)) names.add(match[1] ?? match[2]!);
    return [...names];
  } catch {
    return [];
  }
}

function sanitizedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .filter(([key]) => !/(CANVAS|GOOGLE|GEMINI|TOKEN|SECRET|PASSWORD|COOKIE|API_KEY)/i.test(key)),
  );
}
