import { createContext, useContext } from "react";

import { schoolApi } from "../api";
import type { ActiveWork } from "../types";
import { type PollingState, usePolling } from "./usePolling";

// What agents are doing now. AppShell loads it once for every page; a page rendered on its own
// (in tests) loads its own copy.
export const ActiveWorkContext = createContext<PollingState<ActiveWork> | null>(null);

// Every change notice can affect active work (runs, their progress, workflows, agent status). The
// slow poll while notices arrive picks up agent sign-in changes, which are not announced.
const anyChange = () => true;

export function useActiveWorkSource(enabled = true): PollingState<ActiveWork> {
  return usePolling(schoolApi.activeWork, 2_500, { live: anyChange, liveInterval: 30_000, enabled });
}

export function useActiveWork(): PollingState<ActiveWork> {
  const shared = useContext(ActiveWorkContext);
  const own = useActiveWorkSource(!shared);
  return shared ?? own;
}
