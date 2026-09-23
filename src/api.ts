import type {
  AgentRun,
  AgentExecutionStatus,
  AgentExecutionTarget,
  AgentModels,
  AgentProgress,
  AgentWorkflow,
  ActiveWork,
  AppSettings,
  AssignmentContext,
  Diagnostics,
  ConnectionTestResult,
  ReasoningEffort,
  TrackedTask,
  TaskCourse,
  CourseDirections,
  ManualTaskInput,
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

// Saved run images (problem crops, source pages) are served from their workspace.
export function workspaceFileUrl(workspaceId: string, path: string): string {
  return `/workspace-files/${encodeURIComponent(workspaceId)}/${path.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/")}`;
}

export const schoolApi = {
  tasks: () => api<TrackedTask[]>("/api/tasks?completed=all"),
  task: (logicalId: string) => api<TrackedTask>(`/api/tasks/${encodeURIComponent(logicalId)}`),
  taskCourses: () => api<TaskCourse[]>("/api/task-courses"),
  courseDirections: () => api<CourseDirections[]>("/api/course-directions"),
  saveCourseDirections: (courseId: string, directions: CourseDirections["directions"]) =>
    api<CourseDirections>(`/api/course-directions/${encodeURIComponent(courseId)}`, {
      method: "PUT",
      body: JSON.stringify({ directions }),
    }),
  createTask: (input: ManualTaskInput) => api<TrackedTask>("/api/tasks", { method: "POST", body: JSON.stringify(input) }),
  updateTask: (logicalId: string, input: ManualTaskInput) => api<TrackedTask>(`/api/tasks/${encodeURIComponent(logicalId)}`, { method: "PUT", body: JSON.stringify(input) }),
  context: (logicalId: string) => api<AssignmentContext>(`/api/tasks/${encodeURIComponent(logicalId)}/context`),
  runs: () => api<AgentRun[]>("/api/agent-runs"),
  activeWork: () => api<ActiveWork>("/api/active-work"),
  run: (id: string) => api<AgentRun>(`/api/agent-runs/${id}`),
  runProgress: (id: string) => api<AgentProgress>(`/api/agent-runs/${id}/progress`),
  startRun: (input: {
    feature: AgentRun["feature"];
    logicalId: string;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    useTestQuestionPredictor?: boolean;
    extractionRunId?: string;
  }) => api<AgentRun>("/api/agent-runs", { method: "POST", body: JSON.stringify(input) }),
  cancelRun: (id: string) => api<AgentRun>(`/api/agent-runs/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: "{}",
  }),
  startWorkflow: (input: {
    logicalId: string;
    steps: Array<Exclude<AgentRun["feature"], "studyGuide">>;
  }) => api<AgentWorkflow>("/api/agent-workflows", { method: "POST", body: JSON.stringify(input) }),
  cancelWorkflow: (id: string) => api<AgentWorkflow>(`/api/agent-workflows/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: "{}",
  }),
  agentExecution: () => api<AgentExecutionStatus>("/api/agent-execution"),
  setAgentTarget: (target: AgentExecutionTarget) => api<AgentExecutionStatus>("/api/agent-execution", {
    method: "PUT",
    body: JSON.stringify({ target }),
  }),
  agentModels: () => api<AgentModels>("/api/agent-models"),
  refreshAgentModels: () => api<{ requested: boolean }>("/api/agent-models/refresh", { method: "POST", body: "{}" }),
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
