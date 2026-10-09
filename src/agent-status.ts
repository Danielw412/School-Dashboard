import { createContext, useContext } from "react";

import type { AgentProvider } from "./models";
import type { AgentExecutionStatus, AgentExecutionTargetStatus } from "./types";

// Provided by AppShell from its /api/active-work poll. Null (unknown) means agents are assumed
// available; the server still refuses a run with a clear message if they are not.
export const AgentStatusContext = createContext<AgentExecutionStatus | null>(null);

export function useAgentAvailability(): { available: boolean; reason: string | null } {
  const status = useContext(AgentStatusContext);
  return status && !status.available
    ? { available: false, reason: status.message }
    : { available: true, reason: null };
}

// The target new runs go to, when the server reports more than one (server + laptop deployment).
export function selectedAgentTarget(agents: AgentExecutionStatus | null): AgentExecutionTargetStatus | null {
  return agents?.targets?.find((target) => target.id === agents.mode) ?? null;
}

// The agent new runs use (Codex until the student picks Claude, and on servers without Claude).
export function useSelectedAgentProvider(): AgentProvider {
  return useContext(AgentStatusContext)?.provider ?? "codex";
}

// Whether there is anything to switch: a second agent or a second machine.
export function hasAgentChoices(agents: AgentExecutionStatus | null): boolean {
  return Boolean(agents && ((agents.providers?.length ?? 0) > 1 || (agents.targets?.length ?? 0) > 1));
}
