import { once } from "node:events";
import { createServer } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it, vi } from "vitest";

import type { ActivityStore } from "./activity.js";
import type { CanvasClient } from "./canvas-client.js";
import { defaultSettings } from "./settings.js";
import {
  CanvasToolSessions,
  parsePdfPageSelection,
  parsePdfRenderPages,
  toolActionAllowed,
  toolDocumentation,
} from "./tool-sessions.js";
import type { WorkspaceManager } from "./workspace.js";

describe("PDF render page selection", () => {
  it("preserves single-page rendering", () => {
    expect(parsePdfRenderPages({ page: 7 })).toEqual([7]);
  });

  it("accepts a deduplicated page list and an inclusive range", () => {
    expect(parsePdfRenderPages({ pages: [4, 2, 4, 9] })).toEqual([4, 2, 9]);
    expect(parsePdfRenderPages({ range: { start: 3, end: 6 } })).toEqual([3, 4, 5, 6]);
  });

  it("requires exactly one bounded selection", () => {
    expect(() => parsePdfRenderPages({})).toThrow(/exactly one/);
    expect(() => parsePdfRenderPages({ page: 1, pages: [2] })).toThrow(/exactly one/);
    expect(() => parsePdfRenderPages({ range: { start: 1, end: 41 } })).toThrow(/at most 40/);
  });

  it("supports optional batched text selection while keeping OCR/render selection explicit", () => {
    expect(parsePdfPageSelection({}, false)).toBeNull();
    expect(parsePdfPageSelection({ pages: [2, 5, 2] }, false)).toEqual([2, 5]);
    expect(() => parsePdfPageSelection({}, true)).toThrow(/exactly one/);
  });
});

describe("Directions tool profile", () => {
  it("blocks duplicate preloaded fetches and all file/PDF inspection", () => {
    for (const action of ["context", "assignment", "submission-requirements", "download", "pdf-inspect", "pdf-index", "pdf-text", "pdf-render", "pdf-contact-sheet", "pdf-ocr", "pdf-detect-problems", "pdf-semantic-crop", "image-crop"]) {
      expect(toolActionAllowed("directions", action)).toBe(false);
    }
  });

  it("retains narrowly targeted Canvas navigation", () => {
    for (const action of ["preloaded-context", "recover-context", "page", "follow", "search", "modules", "module-items", "batch"]) {
      expect(toolActionAllowed("directions", action)).toBe(true);
    }
    expect(toolDocumentation("directions")).not.toContain("pdf-inspect {");
    expect(toolDocumentation("directions")).toContain("Question-content inspection belongs to problem extraction");
  });

  it("recovers unresolved Canvas context through a cached structured operation", async () => {
    const recoverTaskSourceContext = vi.fn(async () => ({
      kind: "page",
      title: "Weekly agenda",
      url: "https://canvas.test/courses/9/pages/week",
      matchedBy: "source_anchor",
      contextMarkdown: "Due at 8:10 AM; bring a printed draft.",
      cells: ["Revise paragraph", "8:10 AM", "Printed draft"],
      links: [],
      resource: {},
    }));
    const activity = { record: vi.fn(async () => undefined) } as unknown as ActivityStore;
    const sessions = new CanvasToolSessions(
      { recoverTaskSourceContext } as unknown as CanvasClient,
      {} as WorkspaceManager,
      activity,
    );
    const session = sessions.create({
      logical_id: "english:agenda:revise",
      course: { id: "english", name: "English", prefix: "ENG", canvas_course_id: "9" },
      title: "Revise paragraph",
      display_title: "Revise paragraph",
      details: "",
      due_date: null,
      completed: false,
      completion_status: "incomplete",
      due_uncertain: false,
      historical: false,
      google_task: { status: "needsAction", deleted: false, hidden: false },
      source: { key: "agenda", type: "page", anchor: "revise", text: "Revise one paragraph." },
      canvas: { course_id: "9" },
    }, {
      assignment: null,
      directionsHtml: "",
      directionsMarkdown: "",
      links: [],
      submissionRequirements: {
        supported: false,
        submissionTypes: [],
        allowedExtensions: [],
        pointsPossible: null,
        allowedAttempts: null,
        locked: false,
        lockExplanation: null,
      },
      externalAssignment: { isExternal: false, url: null },
      sourceContext: null,
      resolution: { method: "not_found", confidence: 0 },
    }, {
      id: "workspace",
      path: "C:\\tmp\\workspace",
      resourcesPath: "C:\\tmp\\workspace\\resources",
      rendersPath: "C:\\tmp\\workspace\\renders",
    }, defaultSettings, {
      profile: "directions",
      preflight: { selectedAssignment: null, moduleNeighborhood: { previous: "Agenda" } },
    });

    const httpServer = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        await sessions.handleMcp(session.token, request, response, body);
      } catch (error) {
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : "MCP test failure" }));
      }
    });
    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("MCP test server did not bind a TCP port.");
    const client = new Client({ name: "school-dashboard-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
    );
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const preloaded = await client.callTool({ name: "get_preloaded_context", arguments: {} });
      const first = await client.callTool({ name: "recover_canvas_context", arguments: {} });
      const repeated = await client.callTool({ name: "recover_canvas_context", arguments: {} });

      expect(tools.tools.map((tool) => tool.name)).toContain("get_preloaded_context");
      expect(first.structuredContent).toEqual(repeated.structuredContent);
      expect(JSON.stringify(preloaded.structuredContent)).toContain("moduleNeighborhood");
      expect(JSON.stringify(preloaded.structuredContent)).toContain("Revise one paragraph");
      expect(recoverTaskSourceContext).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(first.structuredContent)).toContain("printed draft");
    } finally {
      await client.close();
      sessions.revoke(session.token);
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    }
  });
});
