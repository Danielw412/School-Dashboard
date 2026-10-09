import { type Feature, featureLabel } from "./features";
import type { ActiveWork, AgentProgress, AgentRun, AgentWorkflow } from "./types";

// What an agent is doing on one assignment right now: a multi-step workflow, or a single run.
export type ActiveAssignment = {
  logicalId: string;
  taskTitle: string;
  courseName: string;
  workflow: AgentWorkflow | null;
  run: AgentRun | null;
  progress: AgentProgress | null;
  feature: Feature | null;
  current: string;
  // Since the workflow (or lone run) started, as of the server's last report.
  elapsedMs: number | null;
};

export function activeAssignments(activeWork: ActiveWork | null | undefined): Map<string, ActiveAssignment> {
  const result = new Map<string, ActiveAssignment>();
  if (!activeWork) return result;
  for (const workflow of activeWork.workflows) {
    const entry = activeWork.runs.find((item) => item.run.id === workflow.currentRunId)
      ?? activeWork.runs.find((item) => item.run.logicalId === workflow.logicalId);
    const step = workflow.currentStep !== null ? workflow.steps[workflow.currentStep] : null;
    const feature = step?.feature ?? entry?.run.feature ?? null;
    result.set(workflow.logicalId, {
      logicalId: workflow.logicalId,
      taskTitle: workflow.taskTitle,
      courseName: workflow.courseName,
      workflow,
      run: entry?.run ?? null,
      progress: entry?.progress ?? null,
      feature,
      current: entry?.progress.current ?? (feature ? `Starting ${featureLabel(feature).toLowerCase()}` : "Starting"),
      elapsedMs: entry ? elapsedSince(workflow.startedAt, entry.progress) : null,
    });
  }
  for (const { run, progress } of activeWork.runs) {
    if (result.has(run.logicalId)) continue;
    result.set(run.logicalId, {
      logicalId: run.logicalId,
      taskTitle: run.taskTitle,
      courseName: run.courseName,
      workflow: null,
      run,
      progress,
      feature: run.feature,
      current: progress.current || `Starting ${featureLabel(run.feature).toLowerCase()}`,
      elapsedMs: progress.elapsedMs,
    });
  }
  return result;
}

function elapsedSince(startedAt: string, progress: AgentProgress): number {
  const elapsed = new Date(progress.serverNow).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(elapsed) ? Math.max(elapsed, progress.elapsedMs) : progress.elapsedMs;
}
