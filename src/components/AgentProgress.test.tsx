import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AgentProgress } from "../types";
import { ProgressTimeline } from "./AgentProgress";

const progress: AgentProgress = {
  runId: "run-1",
  status: "running",
  startedAt: "2026-09-03T20:00:00.000Z",
  completedAt: null,
  serverNow: "2026-09-03T20:00:01.000Z",
  elapsedMs: 1_000,
  current: "Reading assignment context",
  entries: [
    {
      id: "event-1",
      timestamp: "2026-09-03T20:00:00.000Z",
      status: "started",
      message: "Reading assignment context",
      category: "agent",
      action: "source-context",
      tool: null,
    },
  ],
};

describe("ProgressTimeline", () => {
  it("contains rotating entry icons so animation cannot change the scroll area", () => {
    const { container } = render(<ProgressTimeline progress={progress} active />);

    const iconCell = container.querySelector(".progress-entry-icon");
    expect(iconCell).toBeInTheDocument();
    expect(iconCell?.querySelector("svg.spin")).toBeInTheDocument();
  });
});
