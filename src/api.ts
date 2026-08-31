import type {
  AgentRun,
  AgentProgress,
  AgentWorkflow,
  ActiveWork,
  AppSettings,
  AssignmentContext,
  Diagnostics,
  ConnectionTestResult,
  ModelName,
  ReasoningEffort,
  TrackedTask,
} from "./types";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const message = await response
      .json()
      .then((body: { error?: string }) => body.error)
      .catch(() => response.statusText);
    throw new Error(message || `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const schoolApi = {
  tasks: () => api<TrackedTask[]>("/api/tasks?completed=false"),
  task: (logicalId: string) => api<TrackedTask>(`/api/tasks/${encodeURIComponent(logicalId)}`),
  context: (logicalId: string) => api<AssignmentContext>(`/api/tasks/${encodeURIComponent(logicalId)}/context`),
  runs: () => api<AgentRun[]>("/api/agent-runs"),
  activeWork: () => api<ActiveWork>("/api/active-work"),
  run: (id: string) => api<AgentRun>(`/api/agent-runs/${id}`),
  runProgress: (id: string) => api<AgentProgress>(`/api/agent-runs/${id}/progress`),
  startRun: (input: {
    feature: AgentRun["feature"];
    logicalId: string;
    model?: ModelName;
    reasoningEffort?: ReasoningEffort;
    useTestQuestionPredictor?: boolean;
    extractionRunId?: string;
  }) => api<AgentRun>("/api/agent-runs", { method: "POST", body: JSON.stringify(input) }),
  startWorkflow: (input: {
    logicalId: string;
    steps: Array<Exclude<AgentRun["feature"], "studyGuide">>;
  }) => api<AgentWorkflow>("/api/agent-workflows", { method: "POST", body: JSON.stringify(input) }),
  settings: () => api<AppSettings>("/api/settings"),
  saveSettings: (settings: AppSettings) =>
    api<{ settings: AppSettings; restartRequired: boolean }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
  restoreDefaults: () => api<AppSettings>("/api/settings/defaults", { method: "POST", body: "{}" }),
  diagnostics: () => api<Diagnostics>("/api/diagnostics"),
  testConnections: () => api<ConnectionTestResult>("/api/connection-test", { method: "POST", body: "{}" }),
  clearCache: () => api<void>("/api/cache/clear", { method: "POST", body: "{}" }),
};
