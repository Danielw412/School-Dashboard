import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ShellContext } from "../shell-context";
import type { TrackedTask } from "../types";
import { AssignmentsPage } from "./Assignments";

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
} satisfies TrackedTask;

const english = { ...task, logical_id: "english:essay", course: { id: "english", name: "English Literature", prefix: "ENG" }, display_title: "Prose essay", due_date: "2099-08-29" };

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
    startWorkflow: vi.fn(async () => ({ id: "workflow-1" })),
    startRun: vi.fn(async () => ({ id: "run-1" })),
    cancelWorkflow: vi.fn(async () => ({ id: "workflow-1", status: "cancelled" })),
    cancelRun: vi.fn(async () => ({ id: "run-1", status: "cancelled" })),
  },
}));

const shell = (taskSyncUrl: string | null) => ({ settings: null, health: null, taskSyncUrl, reloadSettings: () => undefined });

function renderPage(path = "/", wrapper?: (children: ReactNode) => ReactNode) {
  const tree = <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/" element={<AssignmentsPage />} />
      <Route path="/assignment/:logicalId" element={<p>Assignment page</p>} />
    </Routes>
  </MemoryRouter>;
  return render(wrapper ? wrapper(tree) : tree);
}

describe("Assignments", () => {
  beforeEach(() => {
    // Restores each mock's original implementation, so one test's data never leaks into the next.
    vi.resetAllMocks();
    window.localStorage.clear();
  });

  it("lists only explicitly unfinished Google Tasks and links each to its assignment page", async () => {
    renderPage();
    const row = (await screen.findByText("Problem Set 4")).closest("a");
    expect(row).toHaveAttribute("href", `/assignment/${encodeURIComponent(task.logical_id)}`);
    expect(screen.queryByText("Checked off task")).not.toBeInTheDocument();
    expect(screen.queryByText("Unknown task")).not.toBeInTheDocument();
  });

  it("groups by due date by default, by class on request, and remembers the choice", async () => {
    const user = userEvent.setup();
    const { schoolApi } = await import("../api");
    vi.mocked(schoolApi.tasks).mockResolvedValue([task, english]);
    const { unmount } = renderPage();
    expect(await screen.findByRole("region", { name: "Later" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "By date" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "By class" }));
    expect(screen.getByRole("region", { name: "AP Physics C" })).toHaveTextContent("Problem Set 4");
    expect(screen.getByRole("region", { name: "English Literature" })).toHaveTextContent("Prose essay");
    unmount();

    renderPage();
    expect(await screen.findByRole("region", { name: "AP Physics C" })).toBeInTheDocument();
  });

  it("sorts each date group from the soonest due date", async () => {
    const { schoolApi } = await import("../api");
    vi.mocked(schoolApi.tasks).mockResolvedValueOnce([
      { ...task, logical_id: "later", display_title: "Later assignment", due_date: "2099-09-12T20:00:00Z" },
      { ...task, logical_id: "none", display_title: "No due date assignment", due_date: null },
      { ...task, logical_id: "soon", display_title: "Soon assignment", due_date: "2099-09-01T20:00:00Z" },
    ]);
    renderPage();
    const later = await screen.findByRole("region", { name: "Later" });
    expect(within(later).getAllByRole("link").map((link) => link.textContent)).toEqual([
      expect.stringContaining("Soon assignment"),
      expect.stringContaining("Later assignment"),
    ]);
    expect(screen.getByRole("region", { name: "No due date" })).toHaveTextContent("No due date assignment");
  });

  it("leads with what is overdue", async () => {
    const { schoolApi } = await import("../api");
    vi.mocked(schoolApi.tasks).mockResolvedValueOnce([{ ...task, due_date: "2020-01-06" }, english]);
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: "1 assignment is overdue" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Overdue" })).toHaveTextContent("Problem Set 4");
  });

  it("shows completed work separately", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Problem Set 4");
    await user.click(screen.getByRole("radio", { name: /Done/u }));
    expect(screen.getByText("Checked off task")).toBeInTheDocument();
    expect(screen.queryByText("Problem Set 4")).not.toBeInTheDocument();
  });

  it("explains unavailable Google completion data, links to Task Sync, and recovers after checking again", async () => {
    const user = userEvent.setup();
    const { schoolApi } = await import("../api");
    vi.mocked(schoolApi.tasks).mockResolvedValueOnce([{ ...task, completed: null, completion_status: "unavailable" }]);
    renderPage("/", (children) => <ShellContext.Provider value={shell("http://127.0.0.1:8890")}>{children}</ShellContext.Provider>);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Google Tasks completion status is unavailable");
    expect(within(alert).getByRole("link", { name: /Open Task Sync/u })).toHaveAttribute("href", "http://127.0.0.1:8890/settings?section=google");
    expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument();
    expect(screen.queryByText("Problem Set 4")).not.toBeInTheDocument();

    vi.mocked(schoolApi.tasks).mockResolvedValueOnce([task]);
    await user.click(within(alert).getByRole("button", { name: "Check again" }));

    expect(await screen.findByText("Problem Set 4")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows no Task Sync links when its address is unknown", async () => {
    const { schoolApi } = await import("../api");
    vi.mocked(schoolApi.tasks).mockResolvedValueOnce([]);
    renderPage();
    expect(await screen.findByText("No assignments yet")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Task Sync/u })).not.toBeInTheDocument();
  });

  it("creates a manual task", async () => {
    const user = userEvent.setup();
    const { schoolApi } = await import("../api");
    renderPage();
    await screen.findByText("Problem Set 4");

    await user.click(screen.getByRole("button", { name: /New task/i }));
    const sheet = screen.getByRole("dialog", { name: "New task" });
    await user.type(within(sheet).getByLabelText("Task name"), "Read chapter 6");
    await user.type(within(sheet).getByLabelText("Description / notes"), "Take notes on sections 6.1-6.3.");
    await user.click(within(sheet).getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(schoolApi.createTask).toHaveBeenCalledWith(expect.objectContaining({
      course_id: "physics",
      title: "Read chapter 6",
      details: "Take notes on sections 6.1-6.3.",
    })));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("opens the assignment page for links from the old task inspector", async () => {
    renderPage(`/?task=${encodeURIComponent(task.logical_id)}`);
    expect(await screen.findByText("Assignment page")).toBeInTheDocument();
  });

  it("shows live agent progress on the dashboard and stops it from there", async () => {
    const user = userEvent.setup();
    const { schoolApi } = await import("../api");
    vi.mocked(schoolApi.activeWork).mockResolvedValue({
      workflows: [{
        id: "workflow-1",
        logicalId: task.logical_id,
        taskTitle: task.display_title,
        courseName: task.course.name,
        status: "running",
        steps: [
          { feature: "directions", status: "completed", runId: "run-0" },
          { feature: "problemExtraction", status: "running", runId: null },
          { feature: "answerKey", status: "pending", runId: null },
        ],
        currentStep: 1,
        currentRunId: null,
        startedAt: "2026-08-31T20:00:00Z",
        completedAt: null,
        error: null,
      }],
      runs: [],
    });
    renderPage();

    const working = await screen.findByRole("region", { name: "Working now" });
    const steps = within(working).getByRole("list", { name: "Steps for Problem Set 4" });
    expect(steps).toHaveTextContent("Directions (done)");
    expect(steps).toHaveTextContent("Assigned problems (running)");
    expect(within(working).getByText("Starting assigned problems")).toBeInTheDocument();
    expect(screen.getByText(/Luna is working on one assignment/u)).toBeInTheDocument();

    const row = screen.getByRole("region", { name: "Later" }).querySelector(".assignment-row")!;
    expect(within(row as HTMLElement).getByText("Assigned problems")).toBeInTheDocument();
    expect(within(row as HTMLElement).getByRole("link", { name: "Problem Set 4" })).toHaveAttribute("href", `/assignment/${encodeURIComponent(task.logical_id)}?tab=problems`);

    await user.click(within(working).getByRole("button", { name: "Cancel Luna on Problem Set 4" }));
    await waitFor(() => expect(schoolApi.cancelWorkflow).toHaveBeenCalledWith("workflow-1"));
  });

  it("runs a workflow or a study guide straight from the list", async () => {
    const user = userEvent.setup();
    const { schoolApi } = await import("../api");
    renderPage();
    await screen.findByText("Problem Set 4");

    await user.click(screen.getByRole("button", { name: "Run Luna on Problem Set 4" }));
    await user.click(screen.getByRole("menuitem", { name: "Run all three" }));
    await waitFor(() => expect(schoolApi.startWorkflow).toHaveBeenCalledWith({
      logicalId: task.logical_id,
      steps: ["directions", "problemExtraction", "answerKey"],
    }));

    await user.click(screen.getByRole("button", { name: "Run Luna on Problem Set 4" }));
    await user.click(screen.getByRole("menuitem", { name: "Study guide" }));
    await waitFor(() => expect(schoolApi.startRun).toHaveBeenCalledWith({ feature: "studyGuide", logicalId: task.logical_id }));
  });

  it("switches to tiles and remembers the layout", async () => {
    const user = userEvent.setup();
    const { container, unmount } = renderPage();
    await screen.findByText("Problem Set 4");
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Tiles" }));
    expect(container.querySelector(".assignment-tile")).toHaveTextContent("Problem Set 4");
    expect(container.querySelector(".assignment-row")).toBeNull();
    unmount();

    const second = renderPage();
    await screen.findByText("Problem Set 4");
    expect(second.container.querySelector(".assignment-tile")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Run Luna on Problem Set 4" })).toBeInTheDocument();
  });
});
