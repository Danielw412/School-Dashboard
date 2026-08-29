import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import type { ActivityStore } from "./activity.js";
import {
  buildPdfDocumentIndex,
  classifyPdfTextLayer,
  detectProblemMatches,
  parsePdfBboxLayout,
  parsePdfPageCount,
  safeChild,
  selectContactSheetPages,
  semanticRectFromLines,
  WorkspaceManager,
} from "./workspace.js";

describe("safeChild", () => {
  it("keeps assignment resources inside the workspace", () => {
    expect(safeChild("C:\\tmp\\assignment", "resources\\worksheet.pdf")).toBe("C:\\tmp\\assignment\\resources\\worksheet.pdf");
  });

  it("blocks path traversal", () => {
    expect(() => safeChild("C:\\tmp\\assignment", "..\\secret.env")).toThrow(/escaped/);
  });
});

describe("PDF inspection helpers", () => {
  it("reads the page count reported by pdfinfo", () => {
    expect(parsePdfPageCount("Title: Worksheet\nPages:          12\nEncrypted: no\n")).toBe(12);
    expect(() => parsePdfPageCount("Title: Not a PDF report")).toThrow(/page count/);
  });

  it("classifies text-layer samples conservatively", () => {
    expect(classifyPdfTextLayer(150)).toBe("usable");
    expect(classifyPdfTextLayer(24)).toBe("sparse");
    expect(classifyPdfTextLayer(0)).toBe("none");
  });

  it("indexes text PDFs and detects worksheet problems without rendering", () => {
    const index = buildPdfDocumentIndex(2, [
      "VECTOR WORKSHEET\n1. Find the magnitude of the vector.\n2. Draw the components.",
      "Chapter 3 Exercises\n12) Calculate the dot product.\n13) Explain the sign.",
    ].join("\f"));

    expect(index.textLayer).toBe("usable");
    expect(index.primarilyScanned).toBe(false);
    expect(index.pages[0]).toMatchObject({ strategy: "text", structure: "worksheet", problemNumbers: ["1", "2"] });
    expect(index.detectedProblemNumbers).toEqual(["1", "2", "12", "13"]);
    expect(index.likelyRelevantPages).toEqual([1, 2]);
  });

  it("routes scanned pages to local OCR and recommends a contact-sheet overview", () => {
    const index = buildPdfDocumentIndex(12, Array.from({ length: 12 }, () => "").join("\f"));

    expect(index.textLayer).toBe("none");
    expect(index.primarilyScanned).toBe(true);
    expect(index.pages.every((page) => page.strategy === "ocr")).toBe(true);
    expect(index.contactSheetRecommended).toBe(true);
    expect(selectContactSheetPages(index, 6)).toEqual([1, 3, 5, 8, 10, 12]);
  });

  it("automatically extracts requested problem sections from batched page text", () => {
    const matches = detectProblemMatches([{
      page: 4,
      representation: "text",
      confidence: 100,
      text: "11. Prior problem\nwork\n12. Find x when x + 2 = 8.\nShow all work.\n13. Next problem",
    }], ["12"]);

    expect(matches).toEqual([expect.objectContaining({
      problemNumber: "12",
      page: 4,
      representation: "text",
      confidence: "high",
    })]);
    expect(matches[0]?.text).toContain("Show all work");
    expect(matches[0]?.text).not.toContain("Next problem");
  });

  it("falls back to batched OCR when requested problems are on scanned pages", async () => {
    const activity = { record: vi.fn(async () => undefined) } as unknown as ActivityStore;
    const manager = new WorkspaceManager(activity);
    vi.spyOn(manager, "indexPdf").mockResolvedValue(buildPdfDocumentIndex(2, "\f"));
    vi.spyOn(manager, "extractPdfTextPages").mockResolvedValue([
      { page: 1, text: "" },
      { page: 2, text: "" },
    ]);
    const ocr = vi.spyOn(manager, "ocrPdfPages").mockResolvedValue([
      {
        page: 1,
        text: "12. Find x when x + 2 = 8.\n13. Next problem",
        confidence: 88,
        regions: [],
      },
      { page: 2, text: "", confidence: 80, regions: [] },
    ]);

    const result = await manager.detectPdfProblems(
      "scanned.pdf",
      ["12"],
      { id: "ocr-test", path: "C:\\tmp", resourcesPath: "C:\\tmp\\resources", rendersPath: "C:\\tmp\\renders" },
    );

    expect(ocr).toHaveBeenCalledWith("scanned.pdf", [1, 2], expect.any(Object));
    expect(result.usedOcr).toBe(true);
    expect(result.matches[0]).toMatchObject({ problemNumber: "12", representation: "ocr" });
  });

  it("renders page batches concurrently while preserving requested order", async () => {
    const activity = { record: vi.fn(async () => undefined) } as unknown as ActivityStore;
    const manager = new WorkspaceManager(activity);
    let active = 0;
    let maximumActive = 0;
    vi.spyOn(manager, "renderPdfPage").mockImplementation(async (_path, page) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return `render-${page}.png`;
    });

    const result = await manager.renderPdfPages(
      "worksheet.pdf",
      [4, 2, 7],
      { id: "render-test", path: "C:\\tmp", resourcesPath: "C:\\tmp\\resources", rendersPath: "C:\\tmp\\renders" },
      2,
    );

    expect(maximumActive).toBe(2);
    expect(result).toEqual([
      { page: 4, path: "render-4.png" },
      { page: 2, path: "render-2.png" },
      { page: 7, path: "render-7.png" },
    ]);
  });

  it("uses text layout to make a bounded semantic problem crop", () => {
    const layout = parsePdfBboxLayout(`
      <doc><page width="612" height="792"><flow><block>
        <line><word xMin="40" yMin="100" xMax="58" yMax="114">12.</word><word xMin="64" yMin="100" xMax="220" yMax="114">Find the missing angle.</word></line>
        <line><word xMin="64" yMin="124" xMax="300" yMax="140">Use the diagram below.</word></line>
        <line><word xMin="40" yMin="330" xMax="58" yMax="344">13.</word><word xMin="64" yMin="330" xMax="180" yMax="344">Next problem.</word></line>
      </block></flow></page></doc>
    `);
    const rect = semanticRectFromLines(layout.lines, "12", layout.width, layout.height, 1224, 1584);

    expect(rect).not.toBeNull();
    expect(rect?.top).toBeLessThan(220);
    expect(rect?.height).toBeLessThan(600);
    expect(rect?.width).toBeLessThan(1224);
  });

  it("batches crops and reuses identical cached results", async () => {
    const root = await mkdtemp(join(tmpdir(), "school-dashboard-workspace-test-"));
    const workspace = {
      id: "crop-cache-test",
      path: root,
      resourcesPath: join(root, "resources"),
      rendersPath: join(root, "renders"),
    };
    await Promise.all([mkdir(workspace.resourcesPath), mkdir(workspace.rendersPath)]);
    await sharp({ create: { width: 400, height: 300, channels: 3, background: "white" } })
      .png()
      .toFile(join(workspace.rendersPath, "page.png"));
    const activity = { record: vi.fn(async () => undefined) } as unknown as ActivityStore;
    const manager = new WorkspaceManager(activity);
    try {
      const first = await manager.cropImages([
        { path: "renders/page.png", rect: { left: 10, top: 10, width: 100, height: 80 } },
        { path: "renders/page.png", rect: { left: 150, top: 20, width: 120, height: 90 } },
      ], workspace);
      const repeated = await manager.cropImage(
        "renders/page.png",
        { left: 10, top: 10, width: 100, height: 80 },
        workspace,
      );

      expect(first).toHaveLength(2);
      expect(first[0]?.path).toBe(repeated);
      expect(first[0]?.path).not.toBe(first[1]?.path);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
