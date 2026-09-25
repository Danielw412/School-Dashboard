import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type {
  AccountInfo,
  ModelInfo,
  ModelUsage,
  Options,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ThreadEvent, Usage } from "@openai/codex-sdk";

import { effortLevels, type EffortLevel } from "../src/models.js";
import {
  type AgentTurnCallbacks,
  type AgentTurnRequest,
  type AgentTurnResult,
  sanitizedEnvironment,
} from "./agent-turn.js";
import type { ClaudeModelInfo } from "./worker-protocol.js";

// One Claude turn through the Claude Agent SDK, with the Claude Code sign-in of the machine it
// runs on (~/.claude). It gets the same limits as a Codex turn: read-only built-in tools that
// cannot leave the assignment workspace, the assignment-scoped school_dashboard MCP server and
// nothing else, and none of this machine's Claude Code settings, CLAUDE.md, hooks, skills, or
// plugins. The SDK is loaded on first use, so a machine without it installed still runs Codex.

const require = createRequire(import.meta.url);
const MCP_SERVER = "school_dashboard";
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER}__`;
// Claude Code returns structured output through this internal tool; it is not a workspace tool.
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";
const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];

// The Claude Code version bundled with the Agent SDK, which every turn uses.
export function claudeCodeVersion(): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk")), "manifest.json"), "utf8"));
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

export async function runClaudeTurn(
  request: AgentTurnRequest,
  { signal, onEvent }: AgentTurnCallbacks,
): Promise<AgentTurnResult> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  signal.throwIfAborted();
  const translator = new ClaudeEventTranslator(request.mcp !== null);
  let stderr = "";
  const session = query({
    prompt: request.instructions,
    options: {
      ...claudeTurnOptions(request),
      abortController: controller,
      stderr: (data) => {
        stderr = `${stderr}${data}`.slice(-2000);
      },
    },
  });
  try {
    for await (const message of session) {
      signal.throwIfAborted();
      for (const event of translator.translate(message)) await onEvent(event);
    }
  } catch (error) {
    signal.throwIfAborted();
    const detail = translator.failure ?? (stderr.trim().split(/\r?\n/u).at(-1) || null);
    if (detail) throw new Error(detail, { cause: error });
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    session.close();
  }
  signal.throwIfAborted();
  if (!translator.finalResponse) throw new Error(translator.failure ?? "Claude finished without structured output.");
  return { threadId: translator.threadId, usage: translator.usage, finalResponse: translator.finalResponse };
}

export function claudeTurnOptions(request: AgentTurnRequest): Options {
  return {
    cwd: request.workingDirectory,
    model: request.model,
    effort: claudeEffort(request.reasoningEffort),
    outputFormat: { type: "json_schema", schema: request.outputSchema as Record<string, unknown> },
    systemPrompt: claudeSystemPrompt(request.workingDirectory, request.mcp !== null),
    // Read-only built-ins only. They need no approval inside the working directory, and in
    // dontAsk mode every other call (reads outside the workspace included) is denied.
    tools: READ_ONLY_TOOLS,
    allowedTools: request.mcp ? [`mcp__${MCP_SERVER}`] : [],
    permissionMode: "dontAsk",
    mcpServers: request.mcp
      ? {
          [MCP_SERVER]: {
            type: "http",
            url: request.mcp.url,
            headers: { Authorization: `Bearer ${request.mcp.token}` },
            // Present from the first request, like Codex's required server.
            alwaysLoad: true,
            timeout: 240_000,
          },
        }
      : {},
    strictMcpConfig: true,
    settingSources: [],
    skills: [],
    persistSession: false,
    env: claudeEnvironment(),
  };
}

function claudeSystemPrompt(workingDirectory: string, hasTools: boolean): string {
  return [
    "You are the School Dashboard assignment agent. The user message holds your task, its rules, and the required output.",
    `Your working directory is the temporary assignment workspace ${workingDirectory}. Read files only inside it and pass absolute paths to Read; paths inside its JSON files are relative to it.`,
    hasTools
      ? `Your tools are read-only: Read, Glob, and Grep for workspace files, plus the ${MCP_SERVER} MCP tools for Canvas and document work. Nothing else is available.`
      : "Your tools are read-only: Read, Glob, and Grep for workspace files. Nothing else is available.",
    "Finish by returning the requested structured output.",
  ].join("\n");
}

export function claudeEffort(reasoningEffort: string): EffortLevel {
  if (reasoningEffort === "none" || reasoningEffort === "minimal") return "low";
  return (effortLevels as readonly string[]).includes(reasoningEffort) ? reasoningEffort as EffortLevel : "high";
}

// Claude Code's own credentials stay available (an API key or OAuth token in the environment, or
// the ~/.claude sign-in through HOME); the dashboard's secrets do not.
function claudeEnvironment(): Record<string, string> {
  const own = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]
    .flatMap((key) => process.env[key] ? [[key, process.env[key]!] as const] : []);
  return { ...sanitizedEnvironment(), ...Object.fromEntries(own), CLAUDE_AGENT_SDK_CLIENT_APP: "school-dashboard" };
}

// Reports Claude's messages as the Codex thread events the rest of the dashboard records. Tool
// payloads and thinking text are left out, as they are for Codex.
export class ClaudeEventTranslator {
  threadId: string | null = null;
  usage: Usage | null = null;
  finalResponse: string | null = null;
  // The turn's own error (sign-in, usage limits, rejected models), which is more useful than the
  // process exit that follows it.
  failure: string | null = null;
  private readonly openTools = new Map<string, Extract<ThreadEvent, { type: "item.started" }>["item"]>();

  constructor(private readonly requiresMcp: boolean) {}

  translate(message: SDKMessage): ThreadEvent[] {
    if (message.type === "system" && message.subtype === "init") {
      this.threadId = message.session_id;
      const server = message.mcp_servers.find((item) => item.name === MCP_SERVER);
      if (this.requiresMcp && (!server || ["failed", "needs-auth"].includes(server.status))) {
        this.failure = `Claude could not connect to the assignment tools (${MCP_SERVER}: ${server?.status ?? "missing"}).`;
        throw new Error(this.failure);
      }
      return [{ type: "thread.started", thread_id: message.session_id }];
    }
    if (message.type === "assistant") {
      if (message.error) this.failure = assistantErrorMessage(message.error, message.message.content);
      return message.message.content.flatMap((block, index): ThreadEvent[] => {
        if (block.type === "thinking" || block.type === "redacted_thinking") {
          return [{ type: "item.completed", item: { id: `${message.uuid}-${index}`, type: "reasoning", text: "" } }];
        }
        if (block.type !== "tool_use" || block.name === STRUCTURED_OUTPUT_TOOL) return [];
        const item = block.name.startsWith(MCP_TOOL_PREFIX)
          ? {
              id: block.id,
              type: "mcp_tool_call" as const,
              server: MCP_SERVER,
              tool: block.name.slice(MCP_TOOL_PREFIX.length),
              arguments: {},
              status: "in_progress" as const,
            }
          : { id: block.id, type: "command_execution" as const, command: block.name, aggregated_output: "", status: "in_progress" as const };
        this.openTools.set(block.id, item);
        return [{ type: "item.started", item }];
      });
    }
    if (message.type === "user" && Array.isArray(message.message.content)) {
      return message.message.content.flatMap((block): ThreadEvent[] => {
        if (block.type !== "tool_result") return [];
        const item = this.openTools.get(block.tool_use_id);
        if (!item) return [];
        this.openTools.delete(block.tool_use_id);
        const status = block.is_error ? "failed" as const : "completed" as const;
        return [{ type: "item.completed", item: { ...item, status } as typeof item }];
      });
    }
    if (message.type === "result") {
      this.usage = claudeUsage(message.modelUsage);
      if (message.subtype !== "success" || message.is_error) {
        this.failure = message.subtype === "success"
          ? message.result || this.failure || "Claude reported an error."
          : resultErrorMessage(message.subtype, message.errors) ?? this.failure;
        return [{ type: "turn.failed", error: { message: this.failure ?? "Claude reported an error." } }];
      }
      this.finalResponse = message.structured_output === undefined
        ? jsonText(message.result)
        : JSON.stringify(message.structured_output);
      return [
        ...(this.finalResponse
          ? [{ type: "item.completed", item: { id: message.uuid, type: "agent_message", text: this.finalResponse } } satisfies ThreadEvent]
          : []),
        { type: "turn.completed", usage: this.usage },
      ];
    }
    return [];
  }
}

// Codex-style totals: input includes cache reads and writes, as Codex's input_tokens does.
export function claudeUsage(modelUsage: Record<string, ModelUsage>): Usage {
  const usage: Usage = {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };
  for (const model of Object.values(modelUsage)) {
    usage.input_tokens += model.inputTokens + model.cacheReadInputTokens + model.cacheCreationInputTokens;
    usage.cached_input_tokens += model.cacheReadInputTokens;
    usage.cache_write_input_tokens += model.cacheCreationInputTokens;
    usage.output_tokens += model.outputTokens;
    usage.reasoning_output_tokens += model.thinkingTokens ?? 0;
  }
  return usage;
}

function jsonText(text: string): string | null {
  try {
    JSON.parse(text);
    return text;
  } catch {
    return null;
  }
}

function resultErrorMessage(subtype: string, errors: string[]): string | null {
  if (errors.length) return errors.join("; ").slice(0, 2000);
  if (subtype === "error_max_structured_output_retries") return "Claude could not produce output that matches the required structure.";
  if (subtype === "error_max_turns") return "Claude reached its turn limit before finishing.";
  if (subtype === "error_max_budget_usd") return "Claude reached its spending limit before finishing.";
  return null;
}

function assistantErrorMessage(error: string, content: ReadonlyArray<{ type: string; text?: string }>): string {
  const text = content.flatMap((block) => block.type === "text" && block.text ? [block.text] : []).join(" ").trim();
  const labels: Record<string, string> = {
    authentication_failed: "Claude is not signed in on this machine",
    oauth_org_not_allowed: "This Claude account's organization cannot use Claude Code",
    account_on_hold: "This Claude account is on hold",
    verification_required: "This Claude account needs verification",
    billing_error: "Claude reported a billing problem",
    rate_limit: "Claude's usage limit was reached",
    overloaded: "Claude is overloaded right now",
    model_not_found: "This Claude model is not available to the signed-in account",
  };
  const label = labels[error] ?? "Claude reported an error";
  return text ? `${label}: ${text.slice(0, 1500)}` : `${label}.`;
}

export type ClaudeProbe = {
  version: string | null;
  // null when the check itself could not run, which is not treated as signed out.
  ready: boolean | null;
  detail: string;
  models: ClaudeModelInfo[] | null;
  error: string | null;
};

// Asks this machine's Claude Code for its sign-in and model list without starting a turn.
export async function probeClaude(options: { timeoutMs?: number } = {}): Promise<ClaudeProbe> {
  const version = claudeCodeVersion();
  let query: typeof import("@anthropic-ai/claude-agent-sdk").query;
  try {
    ({ query } = await import("@anthropic-ai/claude-agent-sdk"));
  } catch {
    const message = "The Claude Agent SDK is not installed here. Run npm install in the School Dashboard folder.";
    return { version, ready: false, detail: message, models: null, error: message };
  }
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(new Error(`Claude Code did not answer within ${timeoutMs} ms.`)), timeoutMs);
  // An input stream that stays open until the probe ends, so no prompt is ever sent.
  const idle = async function* () {
    await new Promise((resolve) => controller.signal.addEventListener("abort", resolve, { once: true }));
  };
  const session = query({
    prompt: idle(),
    options: {
      abortController: controller,
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      env: claudeEnvironment(),
    },
  });
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    const [models, account] = await Promise.race([
      Promise.all([session.supportedModels(), session.accountInfo()]),
      aborted,
    ]);
    const ready = claudeSignedIn(account);
    return {
      version,
      ready,
      detail: ready ? `Signed in${account.subscriptionType ? ` (${account.subscriptionType})` : ""}` : "Not signed in",
      models: normalizeClaudeModels(models),
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Claude Code could not be started.";
    return { version, ready: null, detail: message, models: null, error: message };
  } finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort(new Error("Probe finished."));
    session.close();
  }
}

export function claudeSignedIn(account: AccountInfo): boolean {
  if (account.apiProvider && account.apiProvider !== "firstParty") return true;
  return Boolean(
    account.email ||
    account.subscriptionType ||
    account.apiKeySource ||
    (account.tokenSource && account.tokenSource !== "none"),
  );
}

// One row per concrete model: aliases ("opus", "sonnet") become the model they resolve to, and
// Claude Code's "default" row is dropped in favor of the model it names.
export function normalizeClaudeModels(models: ModelInfo[]): ClaudeModelInfo[] {
  const rows = new Map<string, ClaudeModelInfo>();
  for (const model of models) {
    if (model.value === "default") continue;
    const id = model.resolvedModel ?? model.value;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(id) || rows.has(id)) continue;
    rows.set(id, {
      id,
      displayName: model.displayName.slice(0, 200),
      reasoningEfforts: model.supportsEffort ? [...(model.supportedEffortLevels ?? [])] : [],
    });
  }
  return [...rows.values()];
}
