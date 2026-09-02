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
  runProgress: vi.fn(),
  startRun: vi.fn(),
  cancelRun: vi.fn(),
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
    apiMocks.runProgress.mockResolvedValue({
      runId: "directions-run",
      status: "completed",
      startedAt: "2026-08-28T12:00:00Z",
      completedAt: "2026-08-28T12:01:00Z",
      serverNow: "2026-08-28T12:01:00Z",
      elapsedMs: 60_000,
      current: "Structured result prepared",
      entries: [],
    });
    apiMocks.startRun.mockResolvedValue({ id: "new-run" });
    apiMocks.cancelRun.mockResolvedValue({ id: "directions-run", status: "cancelled" });
  });

  it("does not expose raw Canvas directions and starts a Luna directions run", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    const button = await screen.findByRole("button", { name: "Get directions" });
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
    expect(screen.getByText("September 1")).toBeInTheDocument();
    expect(screen.queryByText("Attempts")).not.toBeInTheDocument();
    expect(screen.queryByText("RAW CANVAS DIRECTIONS")).not.toBeInTheDocument();
    expect(screen.getByText("View sources").closest("details")).not.toHaveAttribute("open");
  });

  it("shows safe live Luna activity and elapsed time", async () => {
    apiMocks.runs.mockResolvedValue([{
      ...directionsRun(),
      status: "running",
      completedAt: null,
      output: null,
    }]);
    apiMocks.runProgress.mockResolvedValue({
      runId: "directions-run",
      status: "running",
      startedAt: "2026-08-28T12:00:00Z",
      completedAt: null,
      serverNow: "2026-08-28T12:00:08Z",
      elapsedMs: 8_000,
      current: "Inspecting PDF structure and text layer",
      entries: [{
        id: "activity-1",
        timestamp: "2026-08-28T12:00:07Z",
        status: "started",
        message: "Inspecting PDF structure and text layer",
      }],
    });
    renderWorkspace();

    expect(await screen.findByText("Inspecting PDF structure and text layer", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText(/^\d+s$/)).toBeInTheDocument();
    expect(screen.queryByText(/chain of thought/i)).not.toBeInTheDocument();
  });

  it("cancels the active Luna run", async () => {
    apiMocks.runs.mockResolvedValue([{
      ...directionsRun(),
      status: "running",
      completedAt: null,
      output: null,
    }]);
    const user = userEvent.setup();
    renderWorkspace();

    await user.click(await screen.findByRole("button", { name: "Cancel Luna" }));

    await waitFor(() => expect(apiMocks.cancelRun).toHaveBeenCalledWith("directions-run"));
  });

  it("keeps problem sources collapsed and reveals an existing answer below the problem", async () => {
    apiMocks.runs.mockResolvedValue([problemRun(), answerRun()]);
    const user = userEvent.setup();
    renderWorkspace("?tab=problems");

    expect(await screen.findByText(/A particle has velocity/)).toBeInTheDocument();
    const sourceDetails = screen.getByText("View sources").closest("details");
    expect(sourceDetails).not.toHaveAttribute("open");
    const answerDetails = screen.getByText("Show answer").closest("details");
    expect(answerDetails).not.toHaveAttribute("open");

    await user.click(screen.getByText("Show answer"));

    expect(answerDetails).toHaveAttribute("open");
    expect(screen.getAllByText("5 m/s").length).toBeGreaterThan(0);
  });

  it("renders shared answer banks once and uses structured tables", async () => {
    const run = problemRun();
    run.output = {
      assignmentTitle: "Atomic theory",
      summary: "Two problems found.",
      answerBanks: [{
        id: "bank-3-4",
        title: "Questions 3-4",
        markdown: "(A) First choice\n(B) Second choice",
        problemNumbers: ["3", "4"],
        provenance: [{ sourceName: "Packet", sourceUrl: null, page: 26, evidence: "Shared choices" }],
      }],
      problems: [{
        number: "3",
        markdown: "3. Choose the impossible configuration.",
        answerBankId: "bank-3-4",
        table: {
          caption: "Visible-light reference",
          columns: ["Color", "Wavelength"],
          rows: [["Violet", "410 nm"], ["Blue", "470 nm"]],
        },
        provenance: [{ sourceName: "Packet", sourceUrl: null, page: 26, evidence: "Problem 3" }],
        visual: null,
        confidence: "high",
      }, {
        number: "4",
        markdown: "4. Choose the transition element.",
        answerBankId: "bank-3-4",
        table: null,
        provenance: [{ sourceName: "Packet", sourceUrl: null, page: 26, evidence: "Problem 4" }],
        visual: null,
        confidence: "high",
      }],
      unresolved: [],
      sourcesInspected: [],
    };
    apiMocks.runs.mockResolvedValue([run]);
    renderWorkspace("?tab=problems");

    expect(await screen.findByText("Questions 3-4")).toBeInTheDocument();
    expect(screen.getAllByText("Answer bank")).toHaveLength(1);
    expect(screen.getByRole("table", { name: "Visible-light reference" })).toBeInTheDocument();
    expect(screen.getByText("410 nm")).toBeInTheDocument();
  });
});

function renderWorkspace(search = "") {
  return render(
    <MemoryRouter initialEntries={[`/assignment/${encodeURIComponent(task.logical_id)}${search}`]}>
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
      },
      resources: [{
        title: "Worksheet packet",
        url: "https://canvas.test/files/7",
        kind: "file",
        description: "Assigned source",
      }],
      notices: [],
      sourcesInspected: [{
        name: "Worksheet packet",
        type: "pdf",
        url: "https://canvas.test/files/7",
        relevance: "Contains the assignment directions",
      }],
    },
  };
}

function problemRun(): AgentRun {
  return {
    ...directionsRun(),
    id: "problem-run",
    feature: "problemExtraction",
    output: {
      assignmentTitle: "Worksheet 7",
      summary: "One exact problem found.",
      problems: [{
        number: "1",
        markdown: "A particle has velocity \\(v=5\\) m/s.",
        provenance: [{ sourceName: "Worksheet packet", sourceUrl: null, page: 2, evidence: "Problem 1" }],
        visual: null,
        confidence: "high",
      }],
      unresolved: [],
      sourcesInspected: [],
    },
  };
}

function answerRun(): AgentRun {
  return {
    ...directionsRun(),
    id: "answer-run",
    feature: "answerKey",
    output: {
      assignmentTitle: "Worksheet 7",
      summary: "Solved from the extracted problem.",
      answers: [{
        problemNumber: "1",
        finalAnswerMarkdown: "5 m/s",
        solutionMarkdown: "The given constant velocity is **5 m/s**.",
        checks: [],
        provenance: [{ sourceName: "Extracted problem", sourceUrl: null, page: 2, evidence: "Problem 1" }],
      }],
      warnings: [],
    },
  };
}
