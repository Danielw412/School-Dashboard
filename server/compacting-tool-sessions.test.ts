import { describe, expect, it } from "vitest";

import { compactAgentToolResult } from "./compacting-tool-sessions.js";

describe("agent tool payload compaction", () => {
  it("deduplicates and trims preloaded context without dropping assignment evidence", () => {
    const sourceContext = {
      kind: "page",
      title: "August 24-28",
      url: "https://example.test/page",
      matchedBy: "source_text",
      contextMarkdown: "Friday assignment context",
      cells: ["Friday", "Revise paragraph"],
      links: [{ text: "revision instructions", url: "https://example.test/doc", sameCanvasOrigin: false }],
      resource: {
        page_id: 42,
        title: "August 24-28",
        html_url: "https://example.test/page",
        body: "large duplicate raw HTML",
        last_edited_by: { id: 123, display_name: "Teacher" },
      },
    };
    const result = compactAgentToolResult("preloaded-context", {
      task: {
        logical_id: "task-1",
        course: {
          id: "english",
          name: "AP English",
          prefix: "ENGLISH",
          canvas_course_id: "12604",
          canvas_base_url: "https://example.test",
        },
        title: "Revise paragraph",
        display_title: "Revise paragraph",
        details: "",
        due_date: "2026-08-31",
        completed: false,
        completion_status: "incomplete",
        google_task: { task_id: "secretly-irrelevant", status: "needsAction" },
        source: {
          key: "canvas:12604:week",
          type: "canvas",
          url: null,
          anchor: "anchor",
          text: "Choose one of your two paragraphs to revise for Monday.",
          assignment_url: null,
        },
        canvas: { course_id: "12604", assignment_id: null },
      },
      assignmentContext: {
        assignment: null,
        moduleItem: { id: 704, module_id: 7, title: "Unit 1 Assignment 4", type: "Page" },
        directionsHtml: "<p>duplicate HTML</p>",
        directionsMarkdown: "Use a strong claim.",
        links: [],
        submissionRequirements: { supported: false },
        externalAssignment: { isExternal: false, url: null },
        sourceContext,
        resolution: { method: "not_found", confidence: 0 },
      },
      preflight: {
        structuredToolsReady: true,
        selectedAssignment: null,
        recoveredSourceContext: sourceContext,
        directionsEvidenceSufficient: false,
      },
    });

    expect(result).toMatchObject({
      task: { logical_id: "task-1", display_title: "Revise paragraph" },
      assignmentContext: {
        directionsMarkdown: "Use a strong claim.",
        moduleItem: { id: 704, title: "Unit 1 Assignment 4" },
        sourceContext: {
          contextMarkdown: "Friday assignment context",
          resource: { page_id: 42 },
        },
      },
      preflight: { structuredToolsReady: true, directionsEvidenceSufficient: false },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("google_task");
    expect(serialized).not.toContain("completion_status");
    expect(serialized).not.toContain("directionsHtml");
    expect(serialized).not.toContain("last_edited_by");
    expect(serialized).not.toContain("recoveredSourceContext");
  });

  it("returns browser text and links without repeating every captured item", () => {
    const result = compactAgentToolResult("browser-resource", {
      ok: true,
      sourceType: "google_docs",
      url: "https://docs.google.com/document/d/example/edit",
      resourceId: "example",
      title: "Paragraph Revision Instructions",
      capturedAt: "2026-08-30T04:21:13.539Z",
      captureStatus: "captured",
      content: "Use a strong claim. Integrate evidence.",
      contentTruncated: false,
      items: Array.from({ length: 100 }, (_, index) => ({
        id: `line-${index}`,
        kind: "paragraph",
        order: index,
        text: `line ${index}`,
        metadata: { extraction_method: "background_plain_text_export" },
      })),
      itemsTruncated: false,
      links: [{ text: "rubric", url: "https://example.test/rubric" }],
      metadata: { extraction_method: "background_plain_text_export" },
      warnings: ["Automatic linked-resource capture uses plain text only."],
      source: "authenticated_chrome_extension",
    });

    expect(result).toMatchObject({
      content: "Use a strong claim. Integrate evidence.",
      links: [{ text: "rubric", url: "https://example.test/rubric" }],
      contentTruncated: false,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('"items"');
    expect(serialized).not.toContain('"metadata"');
    expect(serialized).not.toContain("itemsTruncated");
  });

  it("keeps limited structured data when a browser capture has no readable text", () => {
    const result = compactAgentToolResult("browser-resource", {
      ok: true,
      sourceType: "google_sheets",
      url: "https://docs.google.com/spreadsheets/d/example/edit",
      resourceId: "example",
      title: "Sheet",
      content: "",
      items: [{
        id: "cell-block",
        kind: "table",
        order: 0,
        structuredData: { rows: [["A", "B"]] },
        metadata: { noisy: true },
      }],
      links: [],
      warnings: [],
      source: "authenticated_chrome_extension",
    });

    expect(result).toMatchObject({
      structuredItems: [{
        id: "cell-block",
        kind: "table",
        order: 0,
        structuredData: { rows: [["A", "B"]] },
      }],
    });
  });
});
