import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRun, AssignmentContext, TrackedTask } from "../types";
import { AssignmentWorkspace } from "./AssignmentWorkspace";

const apiMocks = vi.hoisted(() => ({
  task: vi.fn(),
  context: vi.fn(),
  runs: vi.fn(),
  startRun: vi.fn(),
}));

vi.mock("../api", () => ({ schoolApi: apiMocks }));

const task = {
  logical_id: "physics:assignment:42",
  course: { id: "physics", name: "AP Physics C", prefix: "PHY", canvas_course_id: "9" },
  title: "Worksheet 7",
  display_title: "Worksheet 7",
  details: "Task Sync fallback details that should not render as directions.",
  due_date: "2099-09-01T20:00:00Z",
  completed: false,
  completion_status: "incomplete",
  due_uncertain: false,
  historical: false,
  google_task: { status: "needsAction", deleted: false, hidden: false },
  source: { key: "a", type: "assignment", anchor: "a", text: "Worksheet 7" },
  canvas: { course_id: "9", assignment_id: "42" },
} satisfies TrackedTask;

const context = {
  assignment: {
    id: 42,
    course_id: 9,
    name: "Worksheet 7",
    html_url: "https://canvas.test/courses/9/assignments/42",
    submission_types: ["online_upload"],
    allowed_extensions: ["pdf"],
    allowed_attempts: -1,
    locked_for_user: false,
  },
  directionsHtml: "<p>RAW CANVAS DIRECTIONS</p>",
  directionsMarkdown: "RAW CANVAS DIRECTIONS",
  links: [],
  submissionRequirements: {
    supported: true,
    submissionTypes: ["online_upload"],
    allowedExtensions: ["pdf"],
    pointsPossible: 10,
    allowedAttempts: -1,
    locked: false,
    lockExplanation: null,
  },
  externalAssignment: { isExternal: false, url: null },
  resolution: { method: "canvas_id", confidence: 1 },
} satisfies AssignmentContext;

describe("AssignmentWorkspace directions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.task.mockResolvedValue(task);
    apiMocks.context.mockResolvedValue(context);
    apiMocks.runs.mockResolvedValue([]);
    apiMocks.startRun.mockResolvedValue({ id: "new-run" });
  });

  it("does not expose raw Canvas directions and starts a Luna directions run", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    const button = await screen.findByRole("button", { name: "Get Directions" });
    expect(screen.queryByText("RAW CANVAS DIRECTIONS")).not.toBeInTheDocument();
    expect(screen.queryByText(/Task Sync fallback/)).not.toBeInTheDocument();

    await user.click(button);

    await waitFor(() => expect(apiMocks.startRun).toHaveBeenCalledWith({
      feature: "directions",
      logicalId: task.logical_id,
      model: undefined,
      reasoningEffort: undefined,
      useTestQuestionPredictor: undefined,
      extractionRunId: undefined,
    }));
  });

  it("renders only the structured Luna directions result", async () => {
    apiMocks.runs.mockResolvedValue([directionsRun()]);
    renderWorkspace();

    expect(await screen.findByText("Start with the packet on page 3.")).toBeInTheDocument();
    expect(screen.getByText("Unlimited")).toBeInTheDocument();
    expect(screen.queryByText("RAW CANVAS DIRECTIONS")).not.toBeInTheDocument();
  });
});

function renderWorkspace() {
  return render(
    <MemoryRouter initialEntries={[`/assignment/${encodeURIComponent(task.logical_id)}`]}>
      <Routes><Route path="/assignment/:logicalId" element={<AssignmentWorkspace />} /></Routes>
    </MemoryRouter>,
  );
}

function directionsRun(): AgentRun {
  return {
    id: "directions-run",
    feature: "directions",
    status: "completed",
    logicalId: task.logical_id,
    taskTitle: task.display_title,
    courseName: task.course.name,
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
    effectiveReasoningEffort: "high",
    prompt: "Investigate assignment directions with sufficient context.",
    startedAt: "2026-08-28T12:00:00Z",
    completedAt: "2026-08-28T12:01:00Z",
    threadId: "thread-1",
    workspaceId: "workspace-1",
    usage: null,
    events: [],
    rawStructuredOutput: null,
    error: null,
    predictor: null,
    output: {
      assignmentTitle: "Worksheet 7",
      overviewMarkdown: "Start with the packet on page 3.",
      instructions: [],
      assignedWork: [],
      submission: {
        methodMarkdown: "Upload one PDF.",
        deliverables: ["Completed work"],
        dueMarkdown: "September 1",
        attemptsMarkdown: "Unlimited",
      },
      resources: [],
      notices: [],
      sourcesInspected: [],
    },
  };
}
