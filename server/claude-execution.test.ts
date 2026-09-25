import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  claudeEffort,
  ClaudeEventTranslator,
  claudeSignedIn,
  claudeTurnOptions,
  claudeUsage,
  normalizeClaudeModels,
} from "./claude-execution.js";

const turn = {
  provider: "claude" as const,
  model: "claude-opus-5",
  reasoningEffort: "xhigh",
  instructions: "Return JSON.",
  outputSchema: { type: "object", properties: { answers: { type: "array" } } },
  networkAccessEnabled: true,
  workingDirectory: "/tmp/school-dashboard-workspaces/task-1",
  mcp: { url: "http://127.0.0.1:8892/api/internal/canvas-mcp", token: "tool-token-0123456789abcdef" },
};

// Only the fields the translator reads; the SDK's message types carry many more.
const message = (value: Record<string, unknown>) => value as unknown as SDKMessage;

const init = (mcpStatus = "connected") => message({
  type: "system",
  subtype: "init",
  session_id: "session-1",
  mcp_servers: [{ name: "school_dashboard", status: mcpStatus }],
});

const modelUsage = {
  "claude-opus-5": {
    inputTokens: 100,
    outputTokens: 40,
    thinkingTokens: 12,
    cacheReadInputTokens: 1_000,
    cacheCreationInputTokens: 200,
    webSearchRequests: 0,
    costUSD: 0.01,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
  },
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Claude turn options", () => {
  it("gives Claude only read-only workspace tools and the assignment MCP server", () => {
    const options = claudeTurnOptions(turn);
    expect(options).toMatchObject({
      cwd: turn.workingDirectory,
      model: "claude-opus-5",
      effort: "xhigh",
      outputFormat: { type: "json_schema", schema: turn.outputSchema },
      tools: ["Read", "Glob", "Grep"],
      allowedTools: ["mcp__school_dashboard"],
      permissionMode: "dontAsk",
      strictMcpConfig: true,
      settingSources: [],
      skills: [],
      persistSession: false,
      mcpServers: {
        school_dashboard: {
          type: "http",
          url: turn.mcp.url,
          headers: { Authorization: `Bearer ${turn.mcp.token}` },
          alwaysLoad: true,
        },
      },
    });
    expect(options.systemPrompt).toEqual(expect.stringContaining(turn.workingDirectory));
  });

  it("offers no MCP server to features without Canvas tools", () => {
    const options = claudeTurnOptions({ ...turn, mcp: null });
    expect(options.mcpServers).toEqual({});
    expect(options.allowedTools).toEqual([]);
    expect(options.systemPrompt).not.toContain("school_dashboard");
  });

  it("keeps the dashboard's secrets out of Claude's environment but keeps Claude's own sign-in", () => {
    vi.stubEnv("CANVAS_API_TOKEN", "canvas-secret");
    vi.stubEnv("SCHOOL_DASHBOARD_WORKER_TOKEN", "worker-secret");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "claude-oauth");
    const env = claudeTurnOptions(turn).env ?? {};
    expect(env).not.toHaveProperty("CANVAS_API_TOKEN");
    expect(env).not.toHaveProperty("SCHOOL_DASHBOARD_WORKER_TOKEN");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("claude-oauth");
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe("school-dashboard");
  });

  it("maps the dashboard's reasoning levels to Claude effort levels", () => {
    expect(claudeEffort("none")).toBe("low");
    expect(claudeEffort("minimal")).toBe("low");
    expect(claudeEffort("medium")).toBe("medium");
    expect(claudeEffort("max")).toBe("max");
    expect(claudeEffort("ultra")).toBe("high");
  });
});

describe("ClaudeEventTranslator", () => {
  it("reports a Claude turn as the Codex thread events the dashboard records", () => {
    const translator = new ClaudeEventTranslator(true);
    const events = [
      init(),
      message({
        type: "assistant",
        uuid: "assistant-1",
        message: {
          content: [
            { type: "thinking", thinking: "private reasoning" },
            { type: "tool_use", id: "tool-1", name: "mcp__school_dashboard__index_pdf", input: { file: "a.pdf" } },
            { type: "tool_use", id: "tool-2", name: "Read", input: { file_path: "/secret" } },
          ],
        },
      }),
      message({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tool-1", content: [{ type: "image", source: { data: "AAAA" } }] },
            { type: "tool_result", tool_use_id: "tool-2", content: "denied", is_error: true },
          ],
        },
      }),
      message({
        type: "assistant",
        uuid: "assistant-2",
        message: { content: [{ type: "tool_use", id: "tool-3", name: "StructuredOutput", input: { answers: [] } }] },
      }),
      message({
        type: "result",
        subtype: "success",
        is_error: false,
        uuid: "result-1",
        result: "",
        structured_output: { answers: [] },
        modelUsage,
      }),
    ].flatMap((item) => translator.translate(item));

    expect(events).toEqual([
      { type: "thread.started", thread_id: "session-1" },
      { type: "item.completed", item: { id: "assistant-1-0", type: "reasoning", text: "" } },
      {
        type: "item.started",
        item: { id: "tool-1", type: "mcp_tool_call", server: "school_dashboard", tool: "index_pdf", arguments: {}, status: "in_progress" },
      },
      { type: "item.started", item: { id: "tool-2", type: "command_execution", command: "Read", aggregated_output: "", status: "in_progress" } },
      {
        type: "item.completed",
        item: { id: "tool-1", type: "mcp_tool_call", server: "school_dashboard", tool: "index_pdf", arguments: {}, status: "completed" },
      },
      { type: "item.completed", item: { id: "tool-2", type: "command_execution", command: "Read", aggregated_output: "", status: "failed" } },
      { type: "item.completed", item: { id: "result-1", type: "agent_message", text: "{\"answers\":[]}" } },
      {
        type: "turn.completed",
        usage: { input_tokens: 1_300, cached_input_tokens: 1_000, cache_write_input_tokens: 200, output_tokens: 40, reasoning_output_tokens: 12 },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("private reasoning");
    expect(JSON.stringify(events)).not.toContain("AAAA");
    expect(translator).toMatchObject({ threadId: "session-1", finalResponse: "{\"answers\":[]}", failure: null });
  });

  it("fails the turn when the assignment tools did not connect", () => {
    const translator = new ClaudeEventTranslator(true);
    expect(() => translator.translate(init("failed"))).toThrow(/could not connect to the assignment tools \(school_dashboard: failed\)/u);
    expect(new ClaudeEventTranslator(false).translate(message({
      type: "system",
      subtype: "init",
      session_id: "session-2",
      mcp_servers: [],
    }))).toEqual([{ type: "thread.started", thread_id: "session-2" }]);
  });

  it("keeps Claude's own error messages for failed turns", () => {
    const signedOut = new ClaudeEventTranslator(false);
    signedOut.translate(message({
      type: "assistant",
      uuid: "assistant-1",
      error: "authentication_failed",
      message: { content: [{ type: "text", text: "Invalid API key · Please run /login" }] },
    }));
    expect(signedOut.failure).toBe("Claude is not signed in on this machine: Invalid API key · Please run /login");

    const invalid = new ClaudeEventTranslator(false);
    expect(invalid.translate(message({
      type: "result",
      subtype: "error_max_structured_output_retries",
      is_error: true,
      errors: [],
      modelUsage: {},
    }))).toEqual([{ type: "turn.failed", error: { message: "Claude could not produce output that matches the required structure." } }]);
    expect(invalid.finalResponse).toBeNull();
  });
});

describe("Claude usage and readiness", () => {
  it("sums every model Claude used, counting cache reads and writes as input", () => {
    expect(claudeUsage({ ...modelUsage, "claude-haiku-4-5": { ...modelUsage["claude-opus-5"], thinkingTokens: undefined } })).toEqual({
      input_tokens: 2_600,
      cached_input_tokens: 2_000,
      cache_write_input_tokens: 400,
      output_tokens: 80,
      reasoning_output_tokens: 12,
    });
  });

  it("recognizes a signed-in account from what Claude Code reports", () => {
    expect(claudeSignedIn({ email: "student@example.com", subscriptionType: "Claude Max", apiProvider: "firstParty" })).toBe(true);
    expect(claudeSignedIn({ apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" })).toBe(true);
    expect(claudeSignedIn({ apiProvider: "bedrock" })).toBe(true);
    expect(claudeSignedIn({ tokenSource: "none", apiProvider: "firstParty" })).toBe(false);
  });

  it("lists one row per concrete model, resolving aliases and dropping the default row", () => {
    expect(normalizeClaudeModels([
      { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
      { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "", supportsEffort: true, supportedEffortLevels: ["low", "high", "max"] },
      { value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]", displayName: "Opus 5.5 (1M)", description: "" },
      { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "" },
      { value: "claude-opus-5-5", displayName: "Opus 5.5", description: "", supportsEffort: true, supportedEffortLevels: ["low"] },
    ])).toEqual([
      { id: "claude-opus-5-5", displayName: "Opus 5.5", reasoningEfforts: ["low", "high", "max"] },
      { id: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", reasoningEfforts: [] },
    ]);
  });
});
