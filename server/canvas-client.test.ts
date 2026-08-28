import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActivityStore } from "./activity.js";
import { CanvasClient } from "./canvas-client.js";
import type { TrackedTask } from "./task-sync.js";

const activity = { record: vi.fn(async () => undefined) } as unknown as ActivityStore;

describe("CanvasClient assignment context", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses Canvas identifiers deterministically and normalizes directions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: 42,
      course_id: 9,
      name: "Worksheet 7",
      description: '<p>Solve <strong>problems 3-9</strong>.</p><a href="/courses/9/files/77">Worksheet</a>',
      due_at: "2026-09-01T20:00:00Z",
      html_url: "https://canvas.test/courses/9/assignments/42",
      points_possible: 25,
      submission_types: ["online_upload"],
      allowed_extensions: ["pdf"],
      locked_for_user: false,
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const client = new CanvasClient("https://canvas.test", activity);
    const context = await client.assignmentContext(makeTask());
    expect(context.resolution).toEqual({ method: "canvas_id", confidence: 1 });
    expect(context.directionsMarkdown).toContain("**problems 3-9**");
    expect(context.links[0]).toMatchObject({ sameCanvasOrigin: true });
    expect(context.submissionRequirements).toMatchObject({ supported: true, allowedExtensions: ["pdf"] });
  });

  it("marks external tools without claiming their content is readable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: 42,
      name: "External Lab",
      description: "<p>Complete the lab online.</p>",
      html_url: "https://canvas.test/courses/9/assignments/42",
      submission_types: ["external_tool"],
      external_tool_tag_attributes: { url: "https://example-lab.test/launch" },
      locked_for_user: false,
    }), { status: 200 })));
    const client = new CanvasClient("https://canvas.test", activity);
    const context = await client.assignmentContext(makeTask());
    expect(context.externalAssignment).toEqual({ isExternal: true, url: "https://example-lab.test/launch" });
    expect(context.submissionRequirements.supported).toBe(false);
  });
});

function makeTask(): TrackedTask {
  return {
    logical_id: "physics:assignment:42",
    course: { id: "physics", name: "Physics", prefix: "PHY", canvas_course_id: "9" },
    title: "Worksheet 7",
    display_title: "Worksheet 7",
    details: "",
    due_date: null,
    completed: false,
    completion_status: "incomplete",
    due_uncertain: false,
    historical: false,
    google_task: { status: "needsAction", deleted: false, hidden: false },
    source: { key: "a", type: "assignment", anchor: "a", text: "Worksheet 7" },
    canvas: { course_id: "9", assignment_id: "42" },
  };
}
