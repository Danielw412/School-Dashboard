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
    tasks: vi.fn(async () => [task]),
    context: vi.fn(async () => context),
  },
}));

describe("MyWork", () => {
  beforeEach(() => vi.clearAllMocks());

  it("groups unfinished tasks and opens Canvas-backed directions", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><MyWork /></MemoryRouter>);
    expect(await screen.findByText("Problem Set 4")).toBeInTheDocument();
    await user.click(screen.getByText("Problem Set 4"));
    await waitFor(() => expect(screen.getByText(/Complete questions/)).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /Open Canvas/i })).toHaveAttribute("href", task.canvas.assignment_url);
    expect(screen.getByText(/Allowed: pdf/)).toBeInTheDocument();
  });

  it("switches to grouping by class", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><MyWork /></MemoryRouter>);
    await screen.findByText("Problem Set 4");
    await user.click(screen.getByRole("button", { name: /Class/i }));
    expect(screen.getAllByText("AP Physics C").length).toBeGreaterThan(0);
  });
});
