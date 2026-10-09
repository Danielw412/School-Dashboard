import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ShellContext } from "../shell-context";
import { ClassesPage } from "./Classes";

const blankDirections = vi.hoisted(() => ({ directions: "", problemExtraction: "", answerKey: "", studyGuide: "" }));

vi.mock("../api", () => ({
  schoolApi: {
    taskCourses: vi.fn(async () => [
      { id: "physics", settings: { name: "AP Physics C", prefix: "PHY" } },
      { id: "english", settings: { name: "English Literature", prefix: "ENG" } },
    ]),
    courseDirections: vi.fn(async () => [
      { courseId: "physics", directions: { ...blankDirections, answerKey: "Use free-body diagrams." }, updatedAt: "2026-09-03T12:00:00.000Z" },
    ]),
    saveCourseDirections: vi.fn(async (courseId: string, directions: typeof blankDirections) => ({
      courseId,
      directions,
      updatedAt: "2026-09-03T13:00:00.000Z",
    })),
  },
}));

function renderPage(path = "/classes?class=physics") {
  return render(
    <ShellContext.Provider value={{ settings: null, health: null, taskSyncUrl: "http://127.0.0.1:8890", reloadSettings: () => undefined }}>
      <MemoryRouter initialEntries={[path]}><ClassesPage /></MemoryRouter>
    </ShellContext.Provider>,
  );
}

describe("Classes", () => {
  beforeEach(() => vi.resetAllMocks());

  it("keeps four separate feature fields and saves them together for the class", async () => {
    const user = userEvent.setup();
    const { schoolApi } = await import("../api");
    renderPage();

    expect(await screen.findByLabelText("Answer key")).toHaveValue("Use free-body diagrams.");
    expect(screen.getByLabelText("Directions")).toHaveValue("");
    expect(screen.getByLabelText("Assigned problems")).toHaveValue("");
    expect(screen.getByLabelText("Study guide")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save instructions" })).toBeDisabled();

    await user.type(screen.getByLabelText("Assigned problems"), "Preserve section headings.");
    expect(screen.getByText("Unsaved changes", { selector: ".save-bar__status" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save instructions" }));

    await waitFor(() => expect(schoolApi.saveCourseDirections).toHaveBeenCalledWith("physics", {
      ...blankDirections,
      problemExtraction: "Preserve section headings.",
      answerKey: "Use free-body diagrams.",
    }));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("keeps an unsaved draft per class and can discard it", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByLabelText("Directions"), "Odd problems only.");

    await user.click(screen.getByRole("button", { name: /English Literature/u }));
    expect(screen.getByRole("heading", { level: 2, name: "English Literature" })).toBeInTheDocument();
    expect(screen.getByLabelText("Directions")).toHaveValue("");
    expect(screen.getByRole("button", { name: /AP Physics C/u })).toHaveTextContent("Unsaved changes");

    await user.click(screen.getByRole("button", { name: /AP Physics C/u }));
    expect(screen.getByLabelText("Directions")).toHaveValue("Odd problems only.");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByLabelText("Directions")).toHaveValue("");
  });

  it("links each class to its sync settings in Task Sync", async () => {
    renderPage("/classes?class=english");
    expect(await screen.findByRole("link", { name: /Sync settings/u })).toHaveAttribute("href", "http://127.0.0.1:8890/courses?course=english");
  });
});
