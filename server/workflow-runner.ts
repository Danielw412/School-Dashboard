import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { ActivityStore } from "./activity.js";
import type { AgentFeature, AgentRunner, AgentRunStore } from "./agent-runner.js";
import type { TaskSyncClient } from "./task-sync.js";

const workflowFeatureSchema = z.enum(["directions", "problemExtraction", "answerKey"]);
const workflowInputSchema = z.object({
  logicalId: z.string().min(1),
  steps: z.array(workflowFeatureSchema).min(1).max(3),
});

export type AgentWorkflowStep = {
  feature: AgentFeature;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  runId: string | null;
};

export type AgentWorkflow = {
  id: string;
  logicalId: string;
  taskTitle: string;
  courseName: string;
  status: "queued" | "running" | "completed" | "failed";
  steps: AgentWorkflowStep[];
  currentStep: number | null;
  currentRunId: string | null;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
};

const allowedSequences = new Set([
  "directions",
  "directions,problemExtraction",
  "directions,problemExtraction,answerKey",
  "problemExtraction,answerKey",
]);

export class AgentWorkflowRunner {
  private readonly workflows = new Map<string, AgentWorkflow>();

  constructor(
    private readonly agentRunner: AgentRunner,
    private readonly runs: AgentRunStore,
    private readonly taskSync: TaskSyncClient,
    private readonly activity: ActivityStore,
  ) {}

  async start(input: unknown): Promise<AgentWorkflow> {
    const parsed = workflowInputSchema.parse(input);
    if (!allowedSequences.has(parsed.steps.join(","))) {
      throw new Error("Choose one of the supported assignment workflows.");
    }
    const existing = this.list().find(
      (workflow) => workflow.logicalId === parsed.logicalId && isActive(workflow.status),
    );
    if (existing) return existing;

    const task = await this.taskSync.getTask(parsed.logicalId);
    const workflow: AgentWorkflow = {
      id: randomUUID(),
      logicalId: parsed.logicalId,
      taskTitle: task.display_title,
      courseName: task.course.name,
      status: "queued",
      steps: parsed.steps.map((feature) => ({ feature, status: "pending", runId: null })),
      currentStep: null,
      currentRunId: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
    };
    this.workflows.set(workflow.id, workflow);
    void this.execute(workflow.id).catch(() => undefined);
    return structuredClone(workflow);
  }

  list(): AgentWorkflow[] {
    return [...this.workflows.values()]
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map((workflow) => structuredClone(workflow));
  }

  private async execute(id: string): Promise<void> {
    this.patch(id, { status: "running" });
    let extractionRunId: string | undefined;
    const workflow = this.require(id);
    try {
      for (let index = 0; index < workflow.steps.length; index += 1) {
        const feature = workflow.steps[index].feature;
        this.updateStep(id, index, { status: "running" });
        this.patch(id, { currentStep: index, currentRunId: null });
        await this.activity.record({
          category: "agent",
          action: `workflow.${feature}`,
          status: "started",
          summary: workflow.taskTitle,
          metadata: { workflowId: id, logicalId: workflow.logicalId },
        });

        const run = await this.agentRunner.start({
          feature,
          logicalId: workflow.logicalId,
          extractionRunId: feature === "answerKey" ? extractionRunId : undefined,
        });
        this.updateStep(id, index, { runId: run.id });
        this.patch(id, { currentRunId: run.id });
        const completedRun = await this.waitForTerminalRun(run.id);
        if (completedRun.status !== "completed") {
          throw new Error(completedRun.error || `${featureLabel(feature)} failed.`);
        }
        if (feature === "problemExtraction") extractionRunId = completedRun.id;
        this.updateStep(id, index, { status: "completed" });
        await this.activity.record({
          category: "agent",
          action: `workflow.${feature}`,
          status: "completed",
          summary: workflow.taskTitle,
          metadata: { workflowId: id, logicalId: workflow.logicalId, runId: run.id },
        });
      }
      this.patch(id, {
        status: "completed",
        currentStep: null,
        currentRunId: null,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Assignment workflow failed.";
      const current = this.require(id);
      if (current.currentStep !== null) {
        this.updateStep(id, current.currentStep, { status: "failed" });
        for (let index = current.currentStep + 1; index < current.steps.length; index += 1) {
          this.updateStep(id, index, { status: "skipped" });
        }
      }
      this.patch(id, {
        status: "failed",
        currentRunId: null,
        completedAt: new Date().toISOString(),
        error: message,
      });
      await this.activity.record({
        category: "agent",
        action: "workflow",
        status: "failed",
        summary: workflow.taskTitle,
        metadata: { workflowId: id, logicalId: workflow.logicalId, error: message },
      });
    }
  }

  private async waitForTerminalRun(runId: string) {
    const deadline = Date.now() + 20 * 60_000;
    while (Date.now() < deadline) {
      const run = await this.runs.get(runId);
      if (!run) throw new Error("The active agent run could not be found.");
      if (run.status === "completed" || run.status === "failed") return run;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    throw new Error("The assignment workflow timed out.");
  }

  private require(id: string): AgentWorkflow {
    const workflow = this.workflows.get(id);
    if (!workflow) throw new Error("Agent workflow was not found.");
    return workflow;
  }

  private patch(id: string, patch: Partial<AgentWorkflow>) {
    const workflow = this.require(id);
    this.workflows.set(id, { ...workflow, ...patch });
  }

  private updateStep(id: string, index: number, patch: Partial<AgentWorkflowStep>) {
    const workflow = this.require(id);
    const steps = workflow.steps.map((step, stepIndex) =>
      stepIndex === index ? { ...step, ...patch } : step,
    );
    this.workflows.set(id, { ...workflow, steps });
  }
}

export function featureLabel(feature: AgentFeature): string {
  if (feature === "directions") return "Getting directions";
  if (feature === "problemExtraction") return "Finding assigned problems";
  if (feature === "answerKey") return "Building the answer key";
  return "Building the study guide";
}

function isActive(status: AgentWorkflow["status"]): boolean {
  return status === "queued" || status === "running";
}
