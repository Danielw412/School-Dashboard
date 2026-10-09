import { createContext, useContext } from "react";

import type { AppSettings, HealthStatus } from "./types";

// What the app shell already loads, shared with pages: saved settings (for the Task Sync link and
// effort defaults) and the last health check. Pages rendered on their own get nulls.
export type ShellInfo = {
  settings: AppSettings | null;
  health: HealthStatus | null;
  taskSyncUrl: string | null;
  reloadSettings: () => void;
};

export const ShellContext = createContext<ShellInfo | null>(null);

export function useShell(): ShellInfo {
  return useContext(ShellContext) ?? { settings: null, health: null, taskSyncUrl: null, reloadSettings: () => undefined };
}

export function useTaskSyncUrl(): string | null {
  return useContext(ShellContext)?.taskSyncUrl ?? null;
}
