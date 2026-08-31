import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import type { ActivityStore } from "./activity.js";
import {
  buildPdfDocumentIndex,
  buildOcrReadingOrderText,
  classifyPdfTextLayer,
  detectProblemMatches,
  parsePdfBboxLayout,
  parsePdfPageCount,
  safeChild,
  selectContactSheetPages,
  semanticFigureRectFromImage,
  semanticRectFromLines,
  isVisualCropQuery,
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

  it("does not let a number-only answer line consume the following problem start", () => {
    const matches = detectProblemMatches([{
      page: 5,
      representation: "ocr",
      confidence: 70,
      text: "15. Prior problem\n75)\n16. For A and B, find the dot product.\n17. Next problem",
    }], ["16"]);

    expect(matches).toEqual([expect.objectContaining({ problemNumber: "16" })]);
  });

  it("recovers requested problem numbers from common OCR lookalikes", () => {
    const matches = detectProblemMatches([{
      page: 5,
      representation: "ocr",
      confidence: 68,
      text: "12. Earlier problem\n16. Previous problem\n[IZ] A force acts on a particle. Find the work.\n18. Next problem",
    }], ["12", "17"]);

    expect(matches).toEqual(expect.arrayContaining([expect.objectContaining({
      problemNumber: "17",
      page: 5,
      representation: "ocr",
    })]));
    const recovered = matches.find((match) => match.problemNumber === "17");
    expect(recovered?.text).toContain("A force acts");
    expect(recovered?.text).not.toContain("Next problem");
  });

  it("infers a corrupted OCR problem marker between readable neighbors", () => {
    const matches = detectProblemMatches([{
      page: 5,
      representation: "ocr",
      confidence: 68,
      text: [
        "16. Prior vector problem.",
        "[E]5 force F acts on a particle.",
        "Find the work done by the force.",
        "IR. Vector A points north.",
      ].join("\n"),
    }], ["17"]);

    expect(matches).toEqual([expect.objectContaining({ problemNumber: "17" })]);
    expect(matches[0]?.text).toContain("force F acts");
    expect(matches[0]?.text).not.toContain("Vector A points north");
  });

  it("recovers an omitted marker from an exact figure label between neighboring problems", () => {
    const matches = detectProblemMatches([{
      page: 1,
      representation: "ocr",
      confidence: 72,
      text: [
        "14. Find graphically the resultant force.",
        "Each of the displacement vectors A and B shown in",
        "Figure P3.15 has a magnitude of 3.00 m. Find graphically",
        "(a) A + B and (b) A - B.",
        "16. A dog walks south and then east.",
      ].join("\n"),
    }], ["15"]);

    expect(matches).toEqual([expect.objectContaining({
      problemNumber: "15",
      text: expect.stringContaining("Each of the displacement vectors"),
    })]);
    expect(matches[0]?.text).toContain("A - B");
    expect(matches[0]?.text).not.toContain("A dog walks");
  });

  it("keeps an overlapping continuation before a corrupted next-problem marker", () => {
    const text = buildOcrReadingOrderText([
      { text: "16. For A and B, find the dot product.", left: 101, top: 725, width: 962, height: 59 },
      { text: "[E]5 force F acts on a particle.", left: 88, top: 766, width: 976, height: 78 },
      { text: "2 - 8k, find C · (A - B).", left: 134, top: 766, width: 224, height: 30 },
      { text: "Find the work done by the force.", left: 129, top: 820, width: 917, height: 58 },
      { text: "IR. Vector A points north.", left: 99, top: 889, width: 497, height: 30 },
      { text: "19. A second force acts.", left: 99, top: 1016, width: 494, height: 28 },
    ], 1445);

    expect(text).toContain("[E]5 force F acts on a particle.");
    expect(text).toContain("IR. Vector A points north.");
    expect(text.indexOf("2 - 8k")).toBeLessThan(text.indexOf("[E]5 force"));
    const matches = detectProblemMatches(
      [{ page: 5, text, representation: "ocr", confidence: 70 }],
      ["16", "17"],
    );
    expect(matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ problemNumber: "16", text: expect.stringContaining("2 - 8k") }),
      expect.objectContaining({ problemNumber: "17", text: expect.stringContaining("work done") }),
    ]));
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

  it("avoids broad OCR on a large scan but honors contact-sheet-selected pages", async () => {
    const activity = { record: vi.fn(async () => undefined) } as unknown as ActivityStore;
    const manager = new WorkspaceManager(activity);
    vi.spyOn(manager, "indexPdf").mockResolvedValue(buildPdfDocumentIndex(
      12,
      Array.from({ length: 12 }, () => "").join("\f"),
    ));
    vi.spyOn(manager, "extractPdfTextPages").mockImplementation(async (_path, pages) =>
      pages.map((page) => ({ page, text: "" })));
    const ocr = vi.spyOn(manager, "ocrPdfPages").mockResolvedValue([{
      page: 5,
      text: "12. Find x when x + 2 = 8.\n13. Next problem",
      confidence: 90,
      regions: [],
    }]);
    const workspace = {
      id: "bounded-ocr-test",
      path: "C:\\tmp",
      resourcesPath: "C:\\tmp\\resources",
      rendersPath: "C:\\tmp\\renders",
    };

    const broad = await manager.detectPdfProblems("scan.pdf", ["12"], workspace);
    expect(broad.usedOcr).toBe(false);
    expect(broad.unresolvedProblemNumbers).toEqual(["12"]);
    expect(ocr).not.toHaveBeenCalled();

    const targeted = await manager.detectPdfProblems("scan.pdf", ["12"], workspace, [5]);
    expect(ocr).toHaveBeenCalledWith("scan.pdf", [5], workspace);
    expect(targeted.matches[0]).toMatchObject({ problemNumber: "12", page: 5 });
  });

  it("does not automatically OCR every page of a medium scanned packet", async () => {
    const activity = { record: vi.fn(async () => undefined) } as unknown as ActivityStore;
    const manager = new WorkspaceManager(activity);
    vi.spyOn(manager, "indexPdf").mockResolvedValue(buildPdfDocumentIndex(7, Array(7).fill("").join("\f")));
    vi.spyOn(manager, "extractPdfTextPages").mockResolvedValue(
      Array.from({ length: 7 }, (_value, index) => ({ page: index + 1, text: "" })),
    );
    const ocr = vi.spyOn(manager, "ocrPdfPages");

    const result = await manager.detectPdfProblems("scan.pdf", ["15", "19"], makeTestWorkspace());

    expect(result.usedOcr).toBe(false);
    expect(result.ocrSkippedPages).toHaveLength(7);
    expect(ocr).not.toHaveBeenCalled();
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

  it("matches a long semantic request by its explicit problem number", () => {
    const layout = parsePdfBboxLayout(`
      <doc><page width="612" height="792"><flow><block>
        <line><word xMin="40" yMin="100" xMax="58" yMax="114">12.</word><word xMin="64" yMin="100" xMax="250" yMax="114">Find the missing angle.</word></line>
        <line><word xMin="64" yMin="124" xMax="300" yMax="140">Use the diagram below.</word></line>
        <line><word xMin="40" yMin="330" xMax="58" yMax="344">13.</word><word xMin="64" yMin="330" xMax="180" yMax="344">Next problem.</word></line>
      </block></flow></page></doc>
    `);

    const rect = semanticRectFromLines(
      layout.lines,
      "problem 12, including the complete text, both parts, and the required diagram",
      layout.width,
      layout.height,
      1224,
      1584,
    );

    expect(rect).not.toBeNull();
    expect(rect?.top).toBeLessThan(220);
    expect(rect?.height).toBeLessThan(600);
    expect(semanticRectFromLines(
      layout.lines,
      "a deliberately absent figure label",
      layout.width,
      layout.height,
      1224,
      1584,
    )).toBeNull();
  });

  it("skips semantic crops for ordinary problem text", async () => {
    const manager = new WorkspaceManager({ record: vi.fn(async () => undefined) } as unknown as ActivityStore);
    const [result] = await manager.semanticCropPdfRegions(
      "missing.pdf",
      [{ page: 4, query: "12. Calculate the dot product." }],
      makeTestWorkspace(),
    );

    expect(isVisualCropQuery("12. Calculate the dot product.")).toBe(false);
    expect(isVisualCropQuery("Figure P3.19")).toBe(true);
    expect(result).toMatchObject({ status: "skipped_text_only", path: null, rect: null });
  });

  it("bounds a captioned figure above its label without nearby text blocks", async () => {
    const root = await mkdtemp(join(tmpdir(), "school-dashboard-figure-test-"));
    const path = join(root, "page.png");
    const svg = Buffer.from(`<svg width="600" height="800" xmlns="http://www.w3.org/2000/svg">
      <rect width="600" height="800" fill="white"/>
      <rect x="335" y="55" width="220" height="12" fill="black"/>
      <rect x="335" y="80" width="190" height="12" fill="black"/>
      <rect x="395" y="220" width="4" height="240" fill="black"/>
      <rect x="345" y="338" width="205" height="4" fill="black"/>
      <path d="M360 430 L520 250" stroke="black" stroke-width="5"/>
      <rect x="420" y="505" width="100" height="18" fill="black"/>
      <rect x="335" y="650" width="220" height="12" fill="black"/>
      <rect x="335" y="675" width="180" height="12" fill="black"/>
    </svg>`);
    await sharp(svg).png().toFile(path);
    try {
      const rect = await semanticFigureRectFromImage(
        path,
        { left: 420, top: 505, width: 100, height: 18 },
        12,
      );

      expect(rect).not.toBeNull();
      expect(rect!.top).toBeGreaterThan(190);
      expect(rect!.top).toBeLessThan(230);
      expect(rect!.left).toBeGreaterThan(320);
      expect(rect!.width).toBeLessThan(260);
      expect(rect!.top + rect!.height).toBeLessThan(560);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

function makeTestWorkspace() {
  return {
    id: "pdf-test",
    path: "C:\\tmp\\pdf-test",
    resourcesPath: "C:\\tmp\\pdf-test\\resources",
    rendersPath: "C:\\tmp\\pdf-test\\renders",
  };
}
