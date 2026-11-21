import { describe, expect, it } from "vitest";

import type { ActivityEvent } from "./activity.js";
import {
  type AgentProgressEntry,
  appendProgressEntry,
  buildAgentProgress,
  MAX_PROGRESS_ENTRIES,
  runProgress,
} from "./agent-progress.js";
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

  it("keeps the complete available activity history for a scrollable timeline", () => {
    const run = {
      id: "run-1",
      status: "running",
      startedAt: "2026-08-28T12:00:00.000Z",
      completedAt: null,
      workspaceId: "workspace-1",
    } as AgentRun;
    const events = Array.from({ length: 14 }, (_, index) => ({
      ...event(`step-${index}`, "completed", { runId: "run-1" }),
      id: `event-${index}`,
    }));

    const progress = buildAgentProgress(run, events);

    expect(progress.entries).toHaveLength(14);
  });

  it("builds progress from a run's own entries, newest first, with finished steps folded", () => {
    const run = {
      id: "run-1",
      status: "running",
      startedAt: "2026-08-28T12:00:00.000Z",
      completedAt: null,
      workspaceId: "workspace-1",
    } as AgentRun;
    const entries: AgentProgressEntry[] = [];
    appendProgressEntry(entries, event("workspace.prepare", "started", { runId: "run-1" }));
    appendProgressEntry(entries, event("workspace.prepare", "completed", { runId: "run-1" }));
    appendProgressEntry(entries, { ...event("canvas_tool.pdf-text", "started", { runId: "run-1" }), id: "pdf-1" });
    appendProgressEntry(entries, { ...event("canvas_tool.search", "warning", { runId: "run-1" }), id: "search-1" });

    const progress = runProgress(run, entries, new Date("2026-08-28T12:00:30.000Z"));

    expect(progress.entries.map((entry) => entry.message)).toEqual([
      "Searching the Canvas course",
      "Reading PDF text",
      "Preparing an isolated assignment workspace complete",
    ]);
    expect(progress.current).toBe("Reading PDF text");
    expect(progress.elapsedMs).toBe(30_000);
  });

  it("keeps a bounded number of entries per run, dropping the oldest", () => {
    const entries: AgentProgressEntry[] = [];
    for (let index = 0; index < MAX_PROGRESS_ENTRIES + 5; index += 1) {
      appendProgressEntry(entries, { ...event(`step-${index}`, "completed", { runId: "run-1" }), id: `event-${index}` });
    }
    expect(entries).toHaveLength(MAX_PROGRESS_ENTRIES);
    expect(entries[0].id).toBe("event-5");
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
