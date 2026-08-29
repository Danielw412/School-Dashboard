import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActivityStore } from "./activity.js";
import { CanvasClient, extractRelevantCanvasContext } from "./canvas-client.js";
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

  it("preserves the complete agenda row instead of reducing it to the homework sentence", () => {
    const context = extractRelevantCanvasContext(`
      <table>
        <thead><tr><th>Task</th><th>Due</th><th>Submit</th><th>Materials and instructions</th></tr></thead>
        <tbody>
          <tr id="monday-revision">
            <td>Choose one of your two paragraphs to revise for Monday.</td>
            <td>Monday at 8:10 AM</td>
            <td>Bring the printed draft to class</td>
            <td>Use a highlighter and follow <a href="/courses/9/pages/revision-instructions">revision instructions</a>.</td>
          </tr>
        </tbody>
      </table>
    `, [
      { value: "monday-revision", kind: "source_anchor" },
      { value: "Choose one of your two paragraphs to revise for Monday.", kind: "source_text" },
    ], "https://canvas.test");

    expect(context.contextMarkdown).toContain("Monday at 8:10 AM");
    expect(context.contextMarkdown).toContain("printed draft");
    expect(context.contextMarkdown).toContain("highlighter");
    expect(context.cells).toHaveLength(4);
    expect(context.links[0]?.url).toBe("https://canvas.test/courses/9/pages/revision-instructions");
  });

  it("recovers source-page context when assignment resolution fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("/assignments")) return json([]);
      if (url.pathname.endsWith("/pages/august-31-september-4")) {
        return json({
          page_id: 31,
          url: "august-31-september-4",
          title: "August 31 - September 4",
          html_url: "https://canvas.test/courses/9/pages/august-31-september-4",
          body: '<table><tr id="revise"><td>Revise one paragraph.</td><td>Due Monday 8:10 AM</td><td><a href="/courses/9/pages/revision-instructions">Instructions</a></td></tr></table>',
        });
      }
      throw new Error(`Unexpected Canvas request: ${url}`);
    }));
    const client = new CanvasClient("https://canvas.test", activity);
    const task = makeTask();
    task.canvas.assignment_id = null;
    task.canvas.assignment_url = null;
    task.title = "Revise paragraph";
    task.display_title = "Revise paragraph";
    task.source = {
      key: "agenda:revise",
      type: "agenda_page",
      url: "https://canvas.test/courses/9/pages/august-31-september-4#revise",
      anchor: "revise",
      text: "Revise one paragraph.",
      assignment_url: null,
    };

    const context = await client.assignmentContext(task);

    expect(context.assignment).toBeNull();
    expect(context.resolution.method).toBe("not_found");
    expect(context.sourceContext).toMatchObject({
      kind: "page",
      title: "August 31 - September 4",
      matchedBy: "source_anchor",
    });
    expect(context.sourceContext?.contextMarkdown).toContain("Monday 8:10 AM");
    expect(context.sourceContext?.links[0]?.url).toContain("revision-instructions");
  });

  it("resolves an agenda page directly from a Canvas source anchor without listing pages", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("/assignments")) return json([]);
      if (url.pathname.endsWith("/pages/august-24-28-2")) {
        return json({
          page_id: 24,
          url: "august-24-28-2",
          title: "August 24-28",
          html_url: "https://canvas.test/courses/9/pages/august-24-28-2",
          body: '<table><tr><td>Choose one of your two paragraphs to revise for Monday.</td><td>Bring both drafts.</td></tr></table>',
        });
      }
      if (url.pathname.endsWith("/pages")) throw new Error("Page listing must not be used");
      throw new Error(`Unexpected Canvas request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new CanvasClient("https://canvas.test", activity);
    const task = makeTask();
    task.canvas.assignment_id = null;
    task.title = "Revise";
    task.display_title = "Revise";
    task.due_date = "2026-08-31T12:10:00Z";
    task.source = {
      key: "canvas:august-24-28-2:21",
      type: "agenda_page",
      url: null,
      anchor: "canvas:august-24-28-2:21",
      text: "Choose one of your two paragraphs to revise for Monday.",
      assignment_url: null,
    };

    const context = await client.assignmentContext(task);

    expect(context.sourceContext).toMatchObject({
      kind: "page",
      title: "August 24-28",
      matchedBy: "source_text",
    });
    expect(context.sourceContext?.contextMarkdown).toContain("Bring both drafts");
    expect(fetchMock.mock.calls.some(([input]) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      return url.pathname.endsWith("/pages") && url.searchParams.has("search_term");
    })).toBe(false);
  });

  it("follows directly linked revision instructions with normalized content", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      page_id: 4,
      url: "revision-instructions",
      title: "Revision instructions",
      html_url: "https://canvas.test/courses/9/pages/revision-instructions",
      body: '<p>Highlight the claim and upload by <strong>7:30 PM</strong>.</p><a href="/courses/9/files/77">Rubric</a>',
    })));
    const client = new CanvasClient("https://canvas.test", activity);

    const followed = await client.followLinkedResource(
      "https://canvas.test/courses/9/pages/revision-instructions",
    ) as { value: { bodyMarkdown: string; links: Array<{ url: string }> } };

    expect(followed.value.bodyMarkdown).toContain("**7:30 PM**");
    expect(followed.value.links[0]?.url).toBe("https://canvas.test/courses/9/files/77");
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
