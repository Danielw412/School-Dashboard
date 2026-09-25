import type { ThreadEvent, Usage } from "@openai/codex-sdk";

import type { AgentProvider } from "../src/models.js";
import { runClaudeTurn } from "./claude-execution.js";
import { runCodexTurn } from "./codex-execution.js";

// One agent turn, runnable in-process (local mode) or by the laptop agent worker, with either
// Codex (@openai/codex-sdk) or Claude (@anthropic-ai/claude-agent-sdk). Both get the same prompt,
// output schema, workspace, and assignment-scoped MCP capability, and both report progress as
// Codex-style thread events, so run history, progress, and the laptop relay treat them alike.
// Everything here uses the agent installation and sign-in of the machine it runs on; it never
// needs Canvas credentials.

export type AgentTurnRequest = {
  // Absent on jobs from before Claude support; those are Codex turns.
  provider?: AgentProvider;
  model: string;
  reasoningEffort: string;
  instructions: string;
  outputSchema: unknown;
  networkAccessEnabled: boolean;
  workingDirectory: string;
  // The assignment-scoped school_dashboard MCP endpoint and its short-lived bearer capability.
  mcp: { url: string; token: string } | null;
};

export type AgentTurnResult = {
  // The Codex thread ID or the Claude session ID.
  threadId: string | null;
  usage: Usage | null;
  finalResponse: string | null;
};

export type AgentTurnCallbacks = {
  signal: AbortSignal;
  onEvent: (event: ThreadEvent) => Promise<void> | void;
};

export function runAgentTurn(request: AgentTurnRequest, callbacks: AgentTurnCallbacks): Promise<AgentTurnResult> {
  return request.provider === "claude" ? runClaudeTurn(request, callbacks) : runCodexTurn(request, callbacks);
}

// The agent never sees the dashboard's own secrets (Canvas, Google, worker token).
export function sanitizedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .filter(([key]) => !/(CANVAS|GOOGLE|GEMINI|TOKEN|SECRET|PASSWORD|COOKIE|API_KEY)/i.test(key)),
  );
}
