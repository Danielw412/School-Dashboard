import { describe, expect, it, vi } from "vitest";

import type { ActivityStore } from "./activity.js";
import type { AgentRun, AgentRunner, AgentRunStore, StartAgentRun } from "./agent-runner.js";
import type { TaskSyncClient } from "./task-sync.js";
import { AgentWorkflowRunner } from "./workflow-runner.js";

describe("AgentWorkflowRunner", () => {
  it("runs directions, extraction, and answer generation sequentially", async () => {
    const starts: StartAgentRun[] = [];
    const agentRunner = {
      start: vi.fn(async (input: StartAgentRun) => {
        starts.push(input);
        return { id: `run-${input.feature}` } as AgentRun;
      }),
    } as unknown as AgentRunner;
    const runs = {
      get: vi.fn(async (id: string) => ({
        id,
        status: "completed",
        error: null,
      }) as AgentRun),
    } as unknown as AgentRunStore;
    const taskSync = {
      getTask: vi.fn(async () => ({
        display_title: "Problem Set 4",
        course: { name: "AP Physics C" },
      })),
    } as unknown as TaskSyncClient;
    const activity = { record: vi.fn(async () => undefined) } as unknown as ActivityStore;
    const runner = new AgentWorkflowRunner(agentRunner, runs, taskSync, activity);

    await runner.start({
      logicalId: "physics:assignment:42",
      steps: ["directions", "problemExtraction", "answerKey"],
    });

    await vi.waitFor(() => expect(starts).toHaveLength(3));
    expect(starts.map((item) => item.feature)).toEqual([
      "directions",
      "problemExtraction",
      "answerKey",
    ]);
    expect(starts[2].extractionRunId).toBe("run-problemExtraction");
    expect(runner.list()[0]).toMatchObject({
      status: "completed",
      currentRunId: null,
      steps: [
        { feature: "directions", status: "completed" },
        { feature: "problemExtraction", status: "completed" },
        { feature: "answerKey", status: "completed" },
      ],
    });
  });
});
