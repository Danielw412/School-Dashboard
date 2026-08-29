import { describe, expect, it } from "vitest";

import type { ActivityEvent } from "./activity.js";
import { buildAgentProgress } from "./agent-progress.js";
import type { AgentRun } from "./agent-runner.js";

describe("agent progress", () => {
  it("matches run and workspace activity without exposing raw reasoning", () => {
    const run = {
      id: "run-1",
      status: "running",
      startedAt: "2026-08-28T12:00:00.000Z",
      completedAt: null,
      workspaceId: "workspace-1",
    } as AgentRun;
    const events = [
      event("reasoning", "completed", { runId: "run-1" }),
      event("canvas_tool.pdf-inspect", "started", { workspace: "workspace-1" }),
      event("canvas_tool.search", "completed", { runId: "other-run" }),
    ];

    const progress = buildAgentProgress(run, events, new Date("2026-08-28T12:02:03.000Z"));

    expect(progress.elapsedMs).toBe(123_000);
    expect(progress.entries.map((item) => item.message)).toEqual([
      "Reasoning about inspected evidence complete",
      "Inspecting PDF structure and text layer",
    ]);
    expect(JSON.stringify(progress)).not.toContain("chain of thought");
  });
});

function event(action: string, status: ActivityEvent["status"], metadata: Record<string, unknown>): ActivityEvent {
  return {
    id: `${action}-${status}`,
    timestamp: "2026-08-28T12:01:00.000Z",
    category: "agent",
    action,
    status,
    summary: "Assignment",
    metadata,
  };
}
