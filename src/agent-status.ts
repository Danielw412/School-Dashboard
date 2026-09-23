import { createContext, useContext } from "react";

import type { AgentExecutionStatus } from "./types";

// Provided by AppShell from its /api/active-work poll. Null (unknown) means agents are assumed
// available; the server still refuses a run with a clear message if they are not.
export const AgentStatusContext = createContext<AgentExecutionStatus | null>(null);

export function useAgentAvailability(): { available: boolean; reason: string | null } {
  const status = useContext(AgentStatusContext);
  return status && !status.available
    ? { available: false, reason: status.message }
    : { available: true, reason: null };
}
