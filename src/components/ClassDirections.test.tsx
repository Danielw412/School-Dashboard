import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ClassDirections } from "./ClassDirections";

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

describe("ClassDirections", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps four separate feature fields and saves them together for the class", async () => {
    const user = userEvent.setup();
    const { schoolApi } = await import("../api");
    render(<ClassDirections />);

    expect(await screen.findByLabelText("Answer key")).toHaveValue("Use free-body diagrams.");
    expect(screen.getByLabelText("Directions")).toHaveValue("");
    expect(screen.getByLabelText("Problem extraction")).toHaveValue("");
    expect(screen.getByLabelText("Study guide")).toHaveValue("");
    await user.type(screen.getByLabelText("Problem extraction"), "Preserve section headings.");
    await user.click(screen.getByRole("button", { name: "Save directions" }));

    await waitFor(() => expect(schoolApi.saveCourseDirections).toHaveBeenCalledWith("physics", {
      ...blankDirections,
      problemExtraction: "Preserve section headings.",
      answerKey: "Use free-body diagrams.",
    }));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });
});
