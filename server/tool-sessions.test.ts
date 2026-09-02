import { once } from "node:events";
import { createServer } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it, vi } from "vitest";

import type { ActivityStore } from "./activity.js";
import type { AssignmentContext, CanvasClient } from "./canvas-client.js";
import { defaultSettings } from "./settings.js";
import { TaskSyncRequestError, type TaskSyncClient, type TrackedTask } from "./task-sync.js";
import {
  CanvasToolSessions,
  directionsEvidenceSufficient,
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

describe("PDF tool payloads", () => {
  it("allows one distinct refinement contact sheet but rejects duplicate or third selections", async () => {
    const createPdfContactSheet = vi.fn(async (_path, _workspace, pages?: number[]) => ({
      path: "C:\\tmp\\workspace\\renders\\sheet.png",
      pages: pages ?? [1, 5, 10],
    }));
    const activity = { record: vi.fn(async () => undefined) } as unknown as ActivityStore;
    const sessions = new CanvasToolSessions(
      {} as CanvasClient,
      { createPdfContactSheet } as unknown as WorkspaceManager,
      activity,
    );
    const session = sessions.create(makeTask(), makeContext(), makeWorkspace(), defaultSettings);

    await expect(sessions.execute(session.token, "pdf-contact-sheet", {
      path: "resources/packet.pdf",
    })).resolves.toMatchObject({ pages: [1, 5, 10] });
    await expect(sessions.execute(session.token, "pdf-contact-sheet", {
      path: "resources/packet.pdf",
      pages: [8, 9, 10, 9],
    })).resolves.toMatchObject({ pages: [8, 9, 10, 9] });
    await expect(sessions.execute(session.token, "pdf-contact-sheet", {
      path: "resources/packet.pdf",
      pages: [10, 9, 8],
    })).rejects.toThrow(/identical PDF contact sheet/i);
    await expect(sessions.execute(session.token, "pdf-contact-sheet", {
      path: "resources/packet.pdf",
      pages: [12, 13],
    })).rejects.toThrow(/one distinct refinement/i);
    expect(createPdfContactSheet).toHaveBeenCalledTimes(2);
  });

  it("keeps OCR layout coordinates internal instead of sending them to Luna", async () => {
    const ocrPdfPages = vi.fn(async () => [{
      page: 2,
      text: "12. Calculate the dot product.",
      confidence: 91,
      imageWidth: 1200,
      imageHeight: 1600,
      regions: [{ text: "12.", left: 40, top: 60, width: 30, height: 20 }],
    }]);
    const activity = { record: vi.fn(async () => undefined) } as unknown as ActivityStore;
    const sessions = new CanvasToolSessions(
      {} as CanvasClient,
      { ocrPdfPages } as unknown as WorkspaceManager,
      activity,
    );
    const session = sessions.create(makeTask(), makeContext(), makeWorkspace(), defaultSettings);

    const result = await sessions.execute(session.token, "pdf-ocr", {
      path: "resources/packet.pdf",
      page: 2,
    });

    expect(result).toEqual({ pages: [{ page: 2, text: "12. Calculate the dot product.", confidence: 91 }] });
    expect(JSON.stringify(result)).not.toContain("regions");
    expect(JSON.stringify(result)).not.toContain("imageWidth");
  });

  it("skips a duplicate page render after problem detection and semantic crops complete", async () => {
    const detectPdfProblems = vi.fn(async () => ({
      matches: [{
        problemNumber: "15",
        page: 1,
        text: "15. Use Figure P3.15.",
        representation: "text" as const,
        confidence: "high" as const,
      }],
      searchedPages: [1],
      usedOcr: false,
      unresolvedProblemNumbers: [],
      ocrSkippedPages: [],
    }));
    const semanticCropPdfRegions = vi.fn(async () => [{
      page: 1,
      query: "Figure P3.15",
      status: "completed" as const,
      path: "C:\\tmp\\workspace\\renders\\figure.png",
      rect: { left: 10, top: 20, width: 200, height: 180 },
      basis: "figure-layout" as const,
      error: null,
    }]);
    const renderPdfPages = vi.fn();
    const activity = { record: vi.fn(async () => undefined) } as unknown as ActivityStore;
    const sessions = new CanvasToolSessions(
      {} as CanvasClient,
      { detectPdfProblems, semanticCropPdfRegions, renderPdfPages } as unknown as WorkspaceManager,
      activity,
    );
    const session = sessions.create(makeTask(), makeContext(), makeWorkspace(), defaultSettings);

    await sessions.execute(session.token, "pdf-detect-problems", {
      path: "resources/serway.pdf",
      pages: [1],
      problemNumbers: ["15"],
    });
    await sessions.execute(session.token, "pdf-semantic-crop", {
      path: "resources/serway.pdf",
      regions: [{ page: 1, query: "Figure P3.15", kind: "figure" }],
    });
    const result = await sessions.execute(session.token, "pdf-render", {
      path: "resources/serway.pdf",
      page: 1,
    });

    expect(renderPdfPages).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      renders: [],
      skippedPages: [1],
      reason: expect.stringContaining("already complete"),
    }));
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
    expect(toolDocumentation("directions")).toContain("do not search the course or visit unrelated links");
  });

  it("keeps recovery available when a contextual source has not been recovered", async () => {
    const task = makeTask();
    task.title = "Revise";
    task.display_title = "Revise";
    task.due_date = "2026-08-31T12:10:00Z";
    task.source.anchor = "canvas:weekly-agenda:21";
    task.source.text = "Choose one of your two paragraphs to revise for Monday.";
    const context = makeContext();
    expect(directionsEvidenceSufficient(task, context)).toBe(false);

    const sessions = makeSessions();
    const session = sessions.create(task, context, makeWorkspace(), defaultSettings, {
      profile: "directions",
      preflight: { directionsEvidenceSufficient: false },
    });
    const tools = await mcpToolNames(sessions, session.token);
    expect(tools).toContain("get_preloaded_context");
    expect(tools).toContain("recover_canvas_context");
    expect(tools).toContain("search_canvas_course");
    sessions.revoke(session.token);
  });

  it("does not stop before a directly referenced instruction link is read", () => {
    const task = makeTask();
    task.due_date = "2026-08-31T12:10:00Z";
    task.source.text = "Complete one paragraph for Monday.";
    const context = makeContext();
    const url = "https://docs.google.com/document/d/assignment-instructions/edit";
    context.sourceContext = {
      kind: "page",
      title: "Weekly agenda",
      url: "https://canvas.test/courses/9/pages/week",
      matchedBy: "source_anchor",
      contextMarkdown: "Complete one paragraph for Monday. Here are the assignment details.",
      cells: ["Complete one paragraph", "Monday"],
      links: [{ text: "Instructions", url, sameCanvasOrigin: false }],
      resource: {},
    };
    expect(directionsEvidenceSufficient(task, context)).toBe(false);
  });

  it("exposes only the direct instruction readers when an instruction link is already known", async () => {
    const instructionUrl = "https://docs.google.com/document/d/assignment-instructions/edit";
    const unrelatedUrl = "https://docs.google.com/presentation/d/lecture-slides/edit";
    const context = makeContext();
    context.sourceContext = {
      kind: "page",
      title: "Weekly agenda",
      url: "https://canvas.test/courses/9/pages/week",
      matchedBy: "source_anchor",
      contextMarkdown: "Complete the assignment by Monday.",
      cells: ["Complete the assignment", "Monday"],
      links: [
        { text: "Instructions", url: instructionUrl, sameCanvasOrigin: false },
        { text: "Lecture slides", url: unrelatedUrl, sameCanvasOrigin: false },
      ],
      resource: {},
    };
    const readBrowserResource = vi.fn();
    const sessions = makeSessions({ searchCourse: vi.fn() } as unknown as CanvasClient, {
      readBrowserResource,
    } as unknown as TaskSyncClient);
    const session = sessions.create(makeTask(), context, makeWorkspace(), defaultSettings, {
      profile: "directions",
      preflight: { directionsEvidenceSufficient: false },
    });

    expect(await mcpToolNames(sessions, session.token)).toEqual([
      "get_preloaded_context",
      "read_linked_resource_with_chrome",
      "follow_canvas_link",
    ]);
    await expect(sessions.execute(session.token, "search", { query: "assignment instructions" }))
      .rejects.toThrow(/directly referenced instruction resource/i);
    await expect(sessions.execute(session.token, "browser-resource", { url: unrelatedUrl }))
      .rejects.toThrow(/read only that relevant instruction link/i);
    expect(readBrowserResource).not.toHaveBeenCalled();
    sessions.revoke(session.token);
  });

  it("uses the authenticated extension once for a known link and caches failures", async () => {
    const url = "https://docs.google.com/document/d/assignment-instructions/edit?tab=t.0";
    const readBrowserResource = vi.fn(async () => {
      throw new TaskSyncRequestError("Request access to this document.", "access_denied", 409);
    });
    const taskSync = { readBrowserResource } as unknown as TaskSyncClient;
    const sessions = makeSessions({} as CanvasClient, taskSync);
    const context = makeContext();
    context.links = [{ text: "Instructions", url, sameCanvasOrigin: false }];
    const session = sessions.create(makeTask(), context, makeWorkspace(), defaultSettings);

    const first = await sessions.execute(session.token, "browser-resource", { url });
    const repeated = await sessions.execute(session.token, "browser-resource", { url: `${url}#section` });

    expect(first).toEqual(repeated);
    expect(first).toMatchObject({
      ok: false,
      error: { code: "access_denied", status: 409 },
      retryable: false,
    });
    expect(readBrowserResource).toHaveBeenCalledTimes(1);
  });

  it("reuses one successful authenticated extension read within the run", async () => {
    const url = "https://course.example.edu/resources/assignment-guide?week=3";
    const readBrowserResource = vi.fn(async () => ({
      ok: true as const,
      source_type: "web_page",
      source_url: url,
      resource_id: "web_assignment_guide",
      title: "Assignment guide",
      captured_at: "2026-08-29T12:00:00Z",
      content: "Use evidence and explain the reasoning.",
      content_truncated: false,
      items: [],
      items_truncated: false,
      metadata: {},
      warnings: [],
      capture_status: "captured" as const,
    }));
    const sessions = makeSessions({} as CanvasClient, { readBrowserResource } as unknown as TaskSyncClient);
    const context = makeContext();
    context.links = [{ text: "Assignment guide", url, sameCanvasOrigin: false }];
    const session = sessions.create(makeTask(), context, makeWorkspace(), defaultSettings);

    const first = await sessions.execute(session.token, "browser-resource", { url });
    const repeated = await sessions.execute(session.token, "browser-resource", { url });

    expect(first).toEqual(repeated);
    expect(first).toMatchObject({ ok: true, title: "Assignment guide", captureStatus: "captured" });
    expect(readBrowserResource).toHaveBeenCalledTimes(1);
  });

  it("rejects extension browsing for URLs not discovered in scoped context", async () => {
    const readBrowserResource = vi.fn();
    const sessions = makeSessions({} as CanvasClient, { readBrowserResource } as unknown as TaskSyncClient);
    const session = sessions.create(makeTask(), makeContext(), makeWorkspace(), defaultSettings);

    await expect(sessions.execute(session.token, "browser-resource", {
      url: "https://example.com/unrelated",
    })).rejects.toThrow(/already present/i);
    expect(readBrowserResource).not.toHaveBeenCalled();
  });

  it("does not repeat normalized failed searches or try alternate Directions searches", async () => {
    const searchCourse = vi.fn(async () => {
      throw new Error("Canvas search unavailable");
    });
    const sessions = makeSessions({ searchCourse } as unknown as CanvasClient);
    const session = sessions.create(makeTask(), makeContext(), makeWorkspace(), defaultSettings, {
      profile: "directions",
    });

    await expect(sessions.execute(session.token, "search", { query: "  Assignment   Instructions " }))
      .rejects.toThrow(/unavailable/);
    await expect(sessions.execute(session.token, "search", { query: "assignment instructions" }))
      .rejects.toThrow(/already failed/);
    await expect(sessions.execute(session.token, "search", { query: "assignment requirements" }))
      .rejects.toThrow(/at most one focused/i);
    expect(searchCourse).toHaveBeenCalledTimes(1);
  });

  it("rejects multiple search variants hidden inside a Directions batch", async () => {
    const searchCourse = vi.fn();
    const sessions = makeSessions({ searchCourse } as unknown as CanvasClient);
    const session = sessions.create(makeTask(), makeContext(), makeWorkspace(), defaultSettings, {
      profile: "directions",
    });

    await expect(sessions.execute(session.token, "batch", {
      operations: [
        { action: "search", input: { query: "assignment instructions" } },
        { action: "search", input: { query: "assignment requirements" } },
      ],
    })).rejects.toThrow(/at most one focused/i);
    expect(searchCourse).not.toHaveBeenCalled();
  });

  it("recovers unresolved Canvas context once and stops when the recovered row is sufficient", async () => {
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
      const recovered = await client.callTool({ name: "recover_canvas_context", arguments: {} });

      expect(tools.tools.map((tool) => tool.name)).toContain("get_preloaded_context");
      expect(JSON.stringify(preloaded.structuredContent)).toContain("moduleNeighborhood");
      expect(JSON.stringify(preloaded.structuredContent)).toContain("Revise one paragraph");
      expect(recoverTaskSourceContext).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(recovered.structuredContent)).toContain("printed draft");
      await expect(sessions.execute(session.token, "search", { query: "revise paragraph" }))
        .rejects.toThrow(/evidence is sufficient/i);
      expect(recoverTaskSourceContext).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      sessions.revoke(session.token);
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("switches from recovery directly to a discovered instruction link instead of searching", async () => {
    const instructionUrl = "https://docs.google.com/document/d/assignment-instructions/edit";
    const recoverTaskSourceContext = vi.fn(async () => ({
      kind: "page",
      title: "Weekly agenda",
      url: "https://canvas.test/courses/9/pages/week",
      matchedBy: "source_anchor",
      contextMarkdown: "Complete the assignment by Monday. Instructions are linked.",
      cells: ["Complete the assignment", "Monday"],
      links: [{ text: "Instructions", url: instructionUrl, sameCanvasOrigin: false }],
      resource: {},
    }));
    const searchCourse = vi.fn();
    const readBrowserResource = vi.fn(async () => ({
      ok: true as const,
      source_type: "google_docs",
      source_url: instructionUrl,
      resource_id: "assignment-instructions",
      title: "Instructions",
      captured_at: "2026-08-29T12:00:00Z",
      content: "Use one quotation and explain its significance.",
      content_truncated: false,
      items: [],
      items_truncated: false,
      metadata: {},
      warnings: [],
      capture_status: "captured" as const,
    }));
    const sessions = makeSessions(
      { recoverTaskSourceContext, searchCourse } as unknown as CanvasClient,
      { readBrowserResource } as unknown as TaskSyncClient,
    );
    const session = sessions.create(makeTask(), makeContext(), makeWorkspace(), defaultSettings, {
      profile: "directions",
      preflight: { directionsEvidenceSufficient: false },
    });

    await sessions.execute(session.token, "recover-context", {});
    await expect(sessions.execute(session.token, "search", { query: "assignment instructions" }))
      .rejects.toThrow(/directly referenced instruction resource/i);
    const resource = await sessions.execute(session.token, "browser-resource", { url: instructionUrl });

    expect(resource).toMatchObject({ ok: true, title: "Instructions" });
    expect(searchCourse).not.toHaveBeenCalled();
    expect(readBrowserResource).toHaveBeenCalledTimes(1);
  });
});

function makeTask(): TrackedTask {
  return {
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
  };
}

function makeContext(): AssignmentContext {
  return {
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
  };
}

function makeWorkspace() {
  return {
    id: "workspace",
    path: "C:\\tmp\\workspace",
    resourcesPath: "C:\\tmp\\workspace\\resources",
    rendersPath: "C:\\tmp\\workspace\\renders",
  };
}

function makeSessions(
  canvas = {} as CanvasClient,
  taskSync?: TaskSyncClient,
) {
  const activity = { record: vi.fn(async () => undefined) } as unknown as ActivityStore;
  return new CanvasToolSessions(canvas, {} as WorkspaceManager, activity, taskSync);
}

async function mcpToolNames(sessions: CanvasToolSessions, token: string): Promise<string[]> {
  const httpServer = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      await sessions.handleMcp(
        token,
        request,
        response,
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "MCP failure" }));
    }
  });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("MCP test server did not bind.");
  const client = new Client({ name: "school-dashboard-test", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
    ));
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  }
}
