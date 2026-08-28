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
      description: '<p>Solve <strong>problems 3-9</strong>.</p><a href="/courses/9/files/77?verifier=secret-capability&amp;wrap=1">Worksheet</a>',
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
    expect(context.links[0]?.url).not.toContain("verifier");
    expect(context.links[0]?.url).toContain("wrap=1");
    expect(context.assignment?.description).not.toContain("secret-capability");
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

  it("provides focused module, page, announcement, discussion, and quiz readers", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("/module_item_sequence")) {
        expect(url.searchParams.get("asset_type")).toBe("Assignment");
        expect(url.searchParams.get("asset_id")).toBe("42");
        return json({ items: [{ current: { id: 7, title: "Worksheet 7" } }] });
      }
      if (url.pathname.endsWith("/pages/week-1")) {
        return json({ page_id: 3, url: "week-1", title: "Week 1", body: "<p>Read <strong>chapter 2</strong>.</p>", html_url: "https://canvas.test/courses/9/pages/week-1" });
      }
      if (url.pathname.endsWith("/announcements")) {
        expect(url.searchParams.get("context_codes[]")).toBe("course_9");
        return json([{ id: 10, title: "Reminder", message: "<p>Bring your packet.</p>" }]);
      }
      if (url.pathname.endsWith("/discussion_topics/10")) {
        return json({ id: 10, title: "Review", message: "<p>Review vectors.</p>" });
      }
      if (url.pathname.endsWith("/quizzes/12")) {
        return json({ id: 12, title: "Unit quiz", description: "<p>Covers <em>vectors</em>.</p>" });
      }
      throw new Error(`Unexpected Canvas request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new CanvasClient("https://canvas.test", activity);

    const sequence = await client.getModuleItemSequence("9", "Assignment", "42");
    const page = await client.getPage("9", "week-1");
    const announcements = await client.listAnnouncements("9");
    const discussion = await client.getDiscussion("9", "10");
    const quiz = await client.getQuiz("9", "12");

    expect(sequence.items).toBeDefined();
    expect(page.bodyMarkdown).toContain("**chapter 2**");
    expect(announcements[0]?.messageMarkdown).toBe("Bring your packet.");
    expect(discussion.messageMarkdown).toBe("Review vectors.");
    expect(quiz.descriptionMarkdown).toContain("_vectors_");
  });

  it("keeps course search useful when Canvas denies optional pages or files", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("/assignments")) {
        return json([{ id: 42, name: "Vector worksheet", html_url: "https://canvas.test/courses/9/assignments/42", submission_types: [], locked_for_user: false }]);
      }
      if (url.pathname.endsWith("/modules")) {
        return json([{ id: 7, name: "Vectors", items: [] }]);
      }
      if (url.pathname.endsWith("/pages")) return jsonError(404, "Pages disabled");
      if (url.pathname.endsWith("/files")) return jsonError(403, "Not authorized");
      throw new Error(`Unexpected Canvas request: ${url}`);
    }));
    const client = new CanvasClient("https://canvas.test", activity);

    const result = await client.searchCourse("9", "vector") as {
      assignments: unknown[];
      modules: unknown[];
      pages: unknown[];
      files: unknown[];
      unavailable: Array<{ section: string }>;
    };

    expect(result.assignments).toHaveLength(1);
    expect(result.modules).toHaveLength(1);
    expect(result.pages).toEqual([]);
    expect(result.files).toEqual([]);
    expect(result.unavailable.map((item) => item.section)).toEqual(["pages", "files"]);
  });
});

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jsonError(status: number, message: string) {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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
