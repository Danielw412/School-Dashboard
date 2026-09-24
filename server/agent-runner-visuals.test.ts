import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActivityStore } from "./activity.js";
import type { AgentExecutionRequest, AgentExecutor } from "./agent-execution.js";
import { type AgentRun, AgentRunner, AgentRunStore } from "./agent-runner.js";
import type { CanvasClient } from "./canvas-client.js";
import type { CourseDirectionsStore } from "./course-directions.js";
import { defaultSettings, type SettingsStore } from "./settings.js";
import type { TaskSyncClient } from "./task-sync.js";
import type { CanvasToolSessions } from "./tool-sessions.js";
import { type AssignmentWorkspace, WorkspaceManager } from "./workspace.js";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const provenance = (page: number) => [{
  sourceName: "25-26 Unit 2 Circular motion packet.pdf",
  sourceUrl: "https://canvas.example/courses/1/files/2110126",
  page,
  evidence: "Printed problem",
}];

// The shape of the September 23 response: one attached crop, a drawing Luna could not crop,
// a textbook figure the packet does not contain, and a problem citing that figure unexplained.
const extraction = {
  assignmentTitle: "Unit 2 Assignment 2",
  summary: "Circular motion problems.",
  answerBanks: [],
  problems: [
    {
      number: "23",
      markdown: "Use the drawing of the banked track.",
      answerBankId: null,
      table: null,
      provenance: provenance(4),
      visual: { path: "renders/2110126-25-26-Unit-2-Circular-motion-packet-page-4-170dpi-crop-1.png", page: 4, caption: "Banked track", kind: "diagram" },
      missingVisual: null,
      confidence: "high",
    },
    {
      number: "19",
      markdown: "A swing ride's chairs hang from 12.0-m cables, as the drawing shows.",
      answerBankId: null,
      table: null,
      provenance: provenance(2),
      visual: null,
      missingVisual: { reference: "The drawing", status: "not_located", detail: "The swing diagram is on page 2." },
      confidence: "high",
    },
    {
      number: "39",
      markdown: "Find the maximum speed. (Hint: see Figure 5.21.)",
      answerBankId: null,
      table: null,
      provenance: provenance(3),
      visual: null,
      missingVisual: null,
      confidence: "medium",
    },
  ],
  unresolved: [],
  sourcesInspected: [{ name: "Packet", type: "PDF", url: null, pages: [2, 3, 4] }],
};

async function harness(respond: (request: AgentExecutionRequest) => Promise<string | null>) {
  const root = await mkdtemp(join(tmpdir(), "school-runner-visuals-"));
  directories.push(root);
  const activity = { record: vi.fn(async () => undefined) } as unknown as ActivityStore;
  const workspaces = new WorkspaceManager(activity, join(root, "workspaces"), join(root, "assets"));
  // No Poppler in unit tests: the packet has seven pages, rendered as small placeholder JPEGs.
  vi.spyOn(workspaces, "indexPdf").mockResolvedValue({ pageCount: 7 } as Awaited<ReturnType<WorkspaceManager["indexPdf"]>>);
  const renderSourcePages = vi.spyOn(workspaces, "renderSourcePages").mockImplementation(async (_pdf, pages, workspace) => {
    await mkdir(join(workspace.path, "source-pages"), { recursive: true });
    return Promise.all(pages.map(async (page) => {
      const path = join(workspace.path, "source-pages", `packet-page-${page}.jpg`);
      await writeFile(path, `page ${page}`);
      return { page, path };
    }));
  });
  const createWorkspace = workspaces.create.bind(workspaces);
  vi.spyOn(workspaces, "create").mockImplementation(async (logicalId) => {
    const workspace = await createWorkspace(logicalId);
    await writeFile(join(workspace.resourcesPath, "2110126-25-26-Unit-2-Circular-motion-packet.pdf"), "%PDF");
    await mkdir(workspace.rendersPath, { recursive: true });
    await writeFile(join(workspace.rendersPath, "2110126-25-26-Unit-2-Circular-motion-packet-page-4-170dpi-crop-1.png"), "crop");
    return workspace;
  });
  const executor: AgentExecutor = {
    mode: "local",
    status: () => ({ mode: "local", available: true, message: "Ready", worker: null, activeJobs: 0, queuedJobs: 0 }),
    run: async (request, callbacks) => {
      await callbacks.onStarted();
      return { threadId: "thread-1", usage: null, finalResponse: await respond(request) };
    },
  };
  const task = {
    logical_id: "task-1",
    display_title: "Unit 2 Assignment 2",
    course: { id: "course-1", name: "Physics", canvas_course_id: null },
    canvas: { course_id: null },
  };
  const runs = new AgentRunStore(join(root, "runs.json"));
  const runner = new AgentRunner(
    { get: async () => defaultSettings } as unknown as SettingsStore,
    { getTask: async () => task } as unknown as TaskSyncClient,
    { assignmentContext: async () => ({ assignment: null, moduleItem: null, sourceContext: null }) } as unknown as CanvasClient,
    workspaces,
    { create: () => ({ token: "tool-token-abcdefghijklmnopqrstuvwxyz" }), revoke: vi.fn() } as unknown as CanvasToolSessions,
    activity,
    runs,
    executor,
    { get: async (courseId: string) => ({ courseId, directions: { directions: "", problemExtraction: "", answerKey: "", studyGuide: "" }, updatedAt: null }) } as unknown as CourseDirectionsStore,
  );
  const finished = async (run: AgentRun) => {
    await vi.waitFor(async () => {
      expect(["completed", "failed", "cancelled"]).toContain((await runs.get(run.id))?.status);
    }, { timeout: 5_000 });
    return (await runs.get(run.id))!;
  };
  return { runner, runs, finished, renderSourcePages, workspaces };
}

describe("problem extraction with incomplete visuals", () => {
  it("completes with per-problem warnings and saves the whole source packet", async () => {
    const { runner, finished, workspaces } = await harness(async () => JSON.stringify(extraction));
    const run = await finished(await runner.start({ feature: "problemExtraction", logicalId: "task-1" }));

    expect(run.status).toBe("completed");
    const output = run.output as {
      problems: Array<{ number: string; missingVisual: { status: string; reference: string } | null; sourcePages: unknown[] }>;
      sourceDocuments: Array<{ id: string; pageCount: number; pages: Array<{ page: number; path: string }> }>;
    };
    expect(output.problems.map((item) => item.missingVisual?.status ?? null)).toEqual([null, "not_located", "not_located"]);
    expect(output.problems[2]!.missingVisual!.reference).toBe("Figure 5.21");
    // A seven-page packet is kept whole so any page can be opened.
    expect(output.sourceDocuments).toHaveLength(1);
    expect(output.sourceDocuments[0]!).toMatchObject({ id: "document-2110126", pageCount: 7 });
    expect(output.sourceDocuments[0]!.pages.map((page) => page.page)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(output.problems.map((item) => item.sourcePages)).toEqual([
      [{ documentId: "document-2110126", page: 4 }],
      [{ documentId: "document-2110126", page: 2 }],
      [{ documentId: "document-2110126", page: 3 }],
    ]);
    // Source pages outlive the temporary workspace like attached crops do.
    await expect(workspaces.resolveWorkspaceAsset(run.workspaceId!, "source-pages/packet-page-6.jpg")).resolves.toContain("assets");
  });

  it("gives the answer key the source pages, missing-visual notes, and attached crops", async () => {
    let answerWorkspace: Pick<AssignmentWorkspace, "id" | "path"> | null = null;
    let answerSource: {
      problems: Array<{ number: string; missingVisual: unknown; visual: { path: string } | null; sourcePages: Array<{ document: string; page: number; path: string }> }>;
      sourceDocuments: Array<{ name: string; pages: Array<{ page: number; path: string }> }>;
    } | null = null;
    const { runner, finished } = await harness(async (request) => {
      if (request.feature === "problemExtraction") return JSON.stringify(extraction);
      answerWorkspace = request.workspace;
      answerSource = JSON.parse(await readFile(join(request.workspace.path, "extracted-problems.json"), "utf8"));
      return JSON.stringify({ assignmentTitle: "Unit 2", summary: "Solved.", answers: [], warnings: [] });
    });
    const extracted = await finished(await runner.start({ feature: "problemExtraction", logicalId: "task-1" }));
    const answer = await finished(await runner.start({ feature: "answerKey", logicalId: "task-1", extractionRunId: extracted.id }));

    expect(answer.status).toBe("completed");
    const source = answerSource!;
    expect(source.sourceDocuments[0]!.name).toBe("25-26 Unit 2 Circular motion packet.pdf");
    expect(source.sourceDocuments[0]!.pages).toHaveLength(7);
    expect(source.problems[1]).toMatchObject({
      number: "19",
      missingVisual: { status: "not_located" },
      sourcePages: [{ document: "25-26 Unit 2 Circular motion packet.pdf", page: 2 }],
    });
    // Every path handed to Luna exists inside the answer workspace.
    for (const path of [
      source.problems[0]!.visual!.path,
      ...source.sourceDocuments[0]!.pages.map((page) => page.path),
      ...source.problems.flatMap((item) => item.sourcePages.map((page) => page.path)),
    ]) {
      await expect(readFile(join(answerWorkspace!.path, path))).resolves.toBeTruthy();
    }
  });

  it("keeps questions and source pages when an answer bank is missing", async () => {
    const incomplete = {
      ...extraction,
      problems: [{ ...extraction.problems[0]!, answerBankId: "missing-bank" }],
    };
    const { runner, finished } = await harness(async () => JSON.stringify(incomplete));
    const run = await finished(await runner.start({ feature: "problemExtraction", logicalId: "task-1" }));

    expect(run.status).toBe("completed");
    expect(run.output).toMatchObject({
      problems: [{ number: "23", answerBankId: "missing-bank", sourcePages: [{ documentId: "document-2110126", page: 4 }] }],
      unresolved: [{ reference: "Answer bank missing-bank", reason: expect.stringContaining("not included") }],
    });
  });

  it("keeps a redacted draft and events for diagnosis when post-turn validation rejects the output", async () => {
    const invalid = {
      ...extraction,
      problems: [{ ...extraction.problems[0]!, provenance: [], markdown: "Token tool-token-abcdefghijklmnopqrstuvwxyz" }],
    };
    const { runner, finished } = await harness(async () => JSON.stringify(invalid));
    const run = await finished(await runner.start({ feature: "problemExtraction", logicalId: "task-1" }));

    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/provenance/);
    expect(run.output).toBeNull();
    expect(run.rawStructuredOutput).toContain("provenance");
    expect(run.rawStructuredOutput).not.toContain("tool-token-abcdefghijklmnopqrstuvwxyz");
  });
});
