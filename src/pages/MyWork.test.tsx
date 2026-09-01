import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MyWork } from "./MyWork";

const task = {
  logical_id: "physics:assignment:42",
  course: { id: "physics", name: "AP Physics C", prefix: "PHY", canvas_course_id: "1" },
  title: "Problem Set 4",
  display_title: "Problem Set 4",
  details: "Solve the assigned questions.",
  due_date: "2099-08-30T20:00:00Z",
  completed: false,
  completion_status: "incomplete",
  due_uncertain: false,
  historical: false,
  google_task: { status: "needsAction", deleted: false, hidden: false },
  source: { key: "a", type: "assignment", anchor: "a", text: "Problem Set 4" },
  canvas: { course_id: "1", assignment_id: "42", assignment_url: "https://canvas.test/courses/1/assignments/42" },
};

const context = {
  assignment: { id: 42, name: "Problem Set 4", html_url: task.canvas.assignment_url, submission_types: ["online_upload"], allowed_extensions: ["pdf"], locked_for_user: false },
  directionsHtml: "<p>Complete questions 1-5.</p>",
  directionsMarkdown: "Complete questions **1-5**.",
  links: [],
  submissionRequirements: { supported: true, submissionTypes: ["online_upload"], allowedExtensions: ["pdf"], pointsPossible: 20, allowedAttempts: 2, locked: false, lockExplanation: null },
  externalAssignment: { isExternal: false, url: null },
  resolution: { method: "canvas_id", confidence: 1 },
};

vi.mock("../api", () => ({
  schoolApi: {
    tasks: vi.fn(async () => [
      task,
      { ...task, logical_id: "physics:assignment:99", display_title: "Checked off task", completed: true, completion_status: "completed" },
      { ...task, logical_id: "physics:assignment:100", display_title: "Unknown task", completed: null, completion_status: "unavailable" },
    ]),
    activeWork: vi.fn(async () => ({ workflows: [], runs: [] })),
    taskCourses: vi.fn(async () => [{ id: "physics", settings: { name: "AP Physics C", prefix: "PHY" } }]),
    createTask: vi.fn(async () => task),
    updateTask: vi.fn(async () => task),
    context: vi.fn(async () => context),
    startWorkflow: vi.fn(async () => ({ id: "workflow-1" })),
    cancelWorkflow: vi.fn(async () => ({ id: "workflow-1", status: "cancelled" })),
    cancelRun: vi.fn(),
  },
}));

describe("MyWork", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows only explicitly unfinished Google Tasks and opens the workspace preview", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><MyWork /></MemoryRouter>);
    expect(await screen.findByText("Problem Set 4")).toBeInTheDocument();
    expect(screen.queryByText("Checked off task")).not.toBeInTheDocument();
    expect(screen.queryByText("Unknown task")).not.toBeInTheDocument();
    await user.click(screen.getByText("Problem Set 4"));
    await waitFor(() => expect(screen.getByText(/Get directions/)).toBeInTheDocument());
    expect(screen.queryByText(/Complete questions/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open Canvas/i })).toHaveAttribute("href", task.canvas.assignment_url);
    expect(screen.getByText(/Allowed: pdf/)).toBeInTheDocument();
  });

  it("groups assignments by class by default", async () => {
    render(<MemoryRouter><MyWork /></MemoryRouter>);
    await screen.findByText("Problem Set 4");
    expect(screen.getByRole("button", { name: /Class/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByText("AP Physics C").length).toBeGreaterThan(0);
  });

  it("creates a manual task from the work list", async () => {
    const user = userEvent.setup();
    const { schoolApi } = await import("../api");
    render(<MemoryRouter><MyWork /></MemoryRouter>);
    await screen.findByText("Problem Set 4");

    await user.click(screen.getByRole("button", { name: /New task/i }));
    await user.type(screen.getByLabelText("Task name"), "Read chapter 6");
    await user.type(screen.getByLabelText("Description / notes"), "Take notes on sections 6.1–6.3.");
    await user.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(schoolApi.createTask).toHaveBeenCalledWith(expect.objectContaining({
      course_id: "physics",
      title: "Read chapter 6",
      details: "Take notes on sections 6.1–6.3.",
    })));
  });

  it("opens an existing task in the editor", async () => {
    const user = userEvent.setup();
    const { schoolApi } = await import("../api");
    render(<MemoryRouter><MyWork /></MemoryRouter>);
    await user.click(await screen.findByText("Problem Set 4"));
    await user.click(screen.getByRole("button", { name: /Edit task/i }));
    const name = screen.getByLabelText("Task name");
    await user.clear(name);
    await user.type(name, "Problem Set 4 revised");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(schoolApi.updateTask).toHaveBeenCalledWith(
      task.logical_id,
      expect.objectContaining({ title: "Problem Set 4 revised" }),
    ));
  });

  it("offers one ungrouped view sorted from the soonest due date to no due date", async () => {
    const user = userEvent.setup();
    const { schoolApi } = await import("../api");
    vi.mocked(schoolApi.tasks).mockResolvedValueOnce([
      { ...task, logical_id: "physics:assignment:later", display_title: "Later assignment", due_date: "2099-09-12T20:00:00Z" },
      { ...task, logical_id: "physics:assignment:none", display_title: "No due date assignment", due_date: null },
      { ...task, logical_id: "physics:assignment:soon", display_title: "Soon assignment", due_date: "2099-09-01T20:00:00Z" },
    ]);
    const { container } = render(<MemoryRouter><MyWork /></MemoryRouter>);
    await screen.findByText("Later assignment");

    await user.click(screen.getByRole("button", { name: /Due soonest/i }));

    const titles = [...container.querySelectorAll(".assignment-item .assignment-main > strong")]
      .map((element) => element.textContent);
    expect(titles).toEqual(["Soon assignment", "Later assignment", "No due date assignment"]);
    expect(container.querySelectorAll(".assignment-group > header")).toHaveLength(0);
  });

  it("starts the full assignment workflow in sequence", async () => {
    const user = userEvent.setup();
    const { schoolApi } = await import("../api");
    render(<MemoryRouter><MyWork /></MemoryRouter>);
    await user.click(await screen.findByText("Problem Set 4"));
    await user.click(await screen.findByRole("button", { name: /Full workflow/i }));
    await waitFor(() => expect(schoolApi.startWorkflow).toHaveBeenCalledWith({
      logicalId: task.logical_id,
      steps: ["directions", "problemExtraction", "answerKey"],
    }));
  });

  it("offers cancellation for an active assignment workflow", async () => {
    const user = userEvent.setup();
    const { schoolApi } = await import("../api");
    vi.mocked(schoolApi.activeWork).mockResolvedValue({
      workflows: [{
        id: "workflow-1",
        logicalId: task.logical_id,
        taskTitle: task.display_title,
        courseName: task.course.name,
        status: "running",
        steps: [{ feature: "directions", status: "running", runId: "run-1" }],
        currentStep: 0,
        currentRunId: "run-1",
        startedAt: "2026-08-31T20:00:00Z",
        completedAt: null,
        error: null,
      }],
      runs: [],
    });
    render(<MemoryRouter><MyWork /></MemoryRouter>);
    await user.click(await screen.findByText("Problem Set 4"));

    await user.click(await screen.findByRole("button", { name: "Cancel Luna" }));

    await waitFor(() => expect(schoolApi.cancelWorkflow).toHaveBeenCalledWith("workflow-1"));
  });
});
