import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActivityStore } from "./activity.js";
import {
  detectProblemMatches,
  figureNearProblemFromImage,
  semanticVisualRectFromImage,
  WorkspaceManager,
} from "./workspace.js";

// Synthetic 170-DPI pages reproducing the September 23 circular-motion packet layout
// (docs/issues/2026-09-23-problem-extraction-visual-crops.md). Printed text lines are thin
// bars at their OCR boxes; drawings are connected outlines. See the issue for the evidence.
type Line = { text: string; left: number; top: number; width: number; height: number };

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function page(lines: Line[], drawings: string, marks = ""): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "school-visual-anchor-"));
  directories.push(directory);
  const bars = lines.map((line) =>
    `<rect x="${line.left}" y="${line.top + 5}" width="${line.width}" height="${Math.max(4, line.height - 10)}" fill="black"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1445" height="1870"><rect width="1445" height="1870" fill="white"/>${bars}${drawings}${marks}</svg>`;
  const path = join(directory, "page.png");
  await sharp(Buffer.from(svg)).png().toFile(path);
  return path;
}

// A connected outline drawing: a frame with a diagonal cable and a circle hanging off it.
const drawing = (left: number, top: number, width: number, height: number) =>
  `<g fill="none" stroke="black" stroke-width="4"><rect x="${left}" y="${top}" width="${width}" height="${height}"/>` +
  `<line x1="${left}" y1="${top}" x2="${left + width}" y2="${top + height}"/>` +
  `<circle cx="${left + width / 2}" cy="${top + height / 2}" r="${Math.min(width, height) / 4}"/></g>`;

const prose = (text: string, left: number, top: number, width = 556): Line => ({ text, left, top, width, height: 22 });

const rollerCoasterPage: Line[] = [
  prose("A roller coaster vehicle has a mass of 500 kg when", 200, 741, 486),
  prose("fully loaded with passengers (Fig. P6.20). (a) If the", 200, 767, 486),
  prose("vehicle has a speed of 20.0 m/s at point A, what is the", 200, 793, 486),
  { text: "FIGURE P8.20", left: 371, top: 1214, width: 102, height: 18 },
  prose("A model airplane of mass 0.75 kg flies in a horizontal", 183, 1460, 489),
  prose("which acts at 20 degrees inward from the vertical as shown in", 184, 1614, 490),
  { text: "Figure P6.43.", left: 184, top: 1640, width: 125, height: 30 },
  { text: "FIGURE P6.43", left: 953, top: 1730, width: 104, height: 20 },
];
const rollerCoasterDrawings = drawing(160, 950, 540, 240) + drawing(800, 1390, 440, 320);

describe("semantic crop anchors on scanned packets", () => {
  it("matches the one caption OCR misread by a confusable digit (P6.20 read as P8.20)", async () => {
    const image = await page(rollerCoasterPage, rollerCoasterDrawings);
    const rect = await semanticVisualRectFromImage(image, rollerCoasterPage, "Figure P6.20");

    expect(rect).not.toBeNull();
    expect(rect!.left).toBeLessThanOrEqual(160);
    expect(rect!.top).toBeLessThanOrEqual(950);
    expect(rect!.left + rect!.width).toBeGreaterThanOrEqual(700);
    expect(rect!.top + rect!.height).toBeGreaterThanOrEqual(1190);
    // Bounded above the caption and never reaching the next problem's drawing.
    expect(rect!.top + rect!.height).toBeLessThan(1390);
  });

  it("refuses an OCR correction that is ambiguous or not a lookalike", async () => {
    const ambiguous = [...rollerCoasterPage, { text: "FIGURE P5.20", left: 900, top: 300, width: 102, height: 18 }];
    const image = await page(ambiguous, rollerCoasterDrawings + drawing(860, 120, 300, 160));

    await expect(semanticVisualRectFromImage(image, ambiguous, "Figure P6.20")).resolves.toBeNull();
    await expect(semanticVisualRectFromImage(image, rollerCoasterPage, "Figure P6.21")).resolves.toBeNull();
  });

  it("prefers the printed caption over a wrapped sentence-ending mention of the same figure", async () => {
    const image = await page(rollerCoasterPage, rollerCoasterDrawings);
    const rect = await semanticVisualRectFromImage(image, rollerCoasterPage, "Figure P6.43");

    expect(rect).not.toBeNull();
    expect(rect!.left).toBeGreaterThan(700);
    expect(rect!.left).toBeLessThanOrEqual(800);
    expect(rect!.top + rect!.height).toBeGreaterThanOrEqual(1710);
  });

  it("does not treat a wrapped textbook-figure mention as a caption to crop around", async () => {
    const lines = [
      prose("(Hint: The tension serves the same purpose as the normal force in", 103, 502),
      { text: "Figure 5.21.)", left: 112, top: 526, width: 111, height: 23 },
      prose("40. A downhill skier, whose mass is 50.0 kg, attains a speed of", 111, 557),
    ];
    const image = await page(lines, drawing(247, 780, 267, 195));

    await expect(semanticVisualRectFromImage(image, lines, "Figure 5.21")).resolves.toBeNull();
  });

  it("reads a decimal label such as 12.0 m as a label, not as problem 12", async () => {
    const lines = [
      prose("12. A car is safely negotiating an unbanked circular turn at a", 88, 298),
      { text: "12.0m", left: 1058, top: 730, width: 50, height: 12 },
      { text: "12) 120 m/s", left: 834, top: 1204, width: 119, height: 46 },
    ];
    const image = await page(lines, drawing(984, 712, 182, 96));
    const rect = await semanticVisualRectFromImage(image, lines, "12.0 m");

    expect(rect).not.toBeNull();
    expect(rect!.left).toBeLessThanOrEqual(984);
    expect(rect!.left + rect!.width).toBeGreaterThanOrEqual(1166);
    expect(rect!.top).toBeGreaterThan(600);
  });
});

const swingPage: Line[] = [
  prose("*18. What is the minimum coefficient of static friction neces-", 708, 465, 571),
  prose("sary to allow a penny to rotate along with a 33 rpm record", 720, 491, 548),
  prose("*19. A swing ride at a carnival consists of chairs that are swung", 709, 573, 559),
  prose("in a circle by 12.0-m cables attached to a vertical rotating pole, as", 722, 599, 547),
  prose("the drawing shows. Suppose the total mass of a chair and its occu-", 723, 624, 546),
  prose("**20. A rigid massless rod is rotated about one end in a horizontal", 704, 921, 570),
  prose("circle. There is a mass attached to the center of the rod and a", 727, 951, 549),
  prose("11. A 125-kg crate rests on the flatbed of a truck that moves at", 72, 162, 571),
  prose("a speed of 15.0 m/s around an unbanked curve whose radius is", 85, 188, 559),
];
const swingDrawing = drawing(900, 700, 300, 190);
// Handwritten answers: many small separate strokes, none the size of a drawing.
const handwriting = Array.from({ length: 12 }, (_value, index) =>
  `<path d="M ${840 + (index % 4) * 60} ${1150 + Math.floor(index / 4) * 70} q 15 -30 30 0 t 20 10" stroke="black" stroke-width="3" fill="none"/>`).join("");

describe("problem-region fallbacks and detection hints", () => {
  it("crops the drawing inside a numbered problem when its label is unreadable", async () => {
    const image = await page(swingPage, swingDrawing, handwriting);
    // Crops are cut from the render inside the run workspace.
    const root = dirname(image);
    const workspace = { id: "fallback", path: root, rendersPath: join(root, "renders"), resourcesPath: join(root, "resources") };
    await mkdir(workspace.rendersPath);
    const manager = new WorkspaceManager({ record: vi.fn() } as unknown as ActivityStore);
    vi.spyOn(manager, "renderPdfPages").mockResolvedValue([{ page: 2, path: image }]);
    vi.spyOn(manager as unknown as { extractPdfLayout: () => Promise<unknown> }, "extractPdfLayout")
      .mockResolvedValue({ width: 612, height: 792, lines: [] });
    vi.spyOn(manager, "ocrPdfPages").mockResolvedValue([{
      page: 2, text: "", confidence: 70, imageWidth: 1445, imageHeight: 1870, regions: swingPage,
    }]);
    const [withNumber, withoutNumber] = await manager.semanticCropPdfRegions("packet.pdf", [
      { page: 2, query: "65.0°", kind: "diagram", problemNumber: "19" },
      { page: 2, query: "65.0°", kind: "diagram" },
    ], workspace);

    expect(withNumber).toMatchObject({ status: "completed", anchor: "problem-number" });
    expect(withNumber!.note).toContain("problem 19");
    expect(withNumber!.rect!.left).toBeLessThanOrEqual(900);
    expect(withNumber!.rect!.left + withNumber!.rect!.width).toBeGreaterThanOrEqual(1200);
    expect(withNumber!.rect!.top + withNumber!.rect!.height).toBeLessThan(921);
    expect(withoutNumber).toMatchObject({ status: "not_found", anchor: null });
    expect(withoutNumber!.error).toContain("problemNumber");
  });

  it("hints only at problems whose region holds a drawing, ignoring handwriting", async () => {
    const image = await page(swingPage, swingDrawing, handwriting);

    await expect(figureNearProblemFromImage(image, swingPage, "19")).resolves.toEqual({ caption: null });
    await expect(figureNearProblemFromImage(image, swingPage, "18")).resolves.toBeNull();
    await expect(figureNearProblemFromImage(image, swingPage, "20")).resolves.toBeNull();
    await expect(figureNearProblemFromImage(image, swingPage, "11")).resolves.toBeNull();
  });

  it("reports figure hints and printed captions from problem detection", async () => {
    const image = await page([...swingPage, ...rollerCoasterPage], swingDrawing);
    const root = await mkdtemp(join(tmpdir(), "school-detect-figures-"));
    directories.push(root);
    const workspace = { id: "detect", path: root, rendersPath: join(root, "renders"), resourcesPath: join(root, "resources") };
    const manager = new WorkspaceManager({ record: vi.fn() } as unknown as ActivityStore);
    vi.spyOn(manager, "indexPdf").mockResolvedValue({
      pageCount: 1,
      pages: [{ page: 1, extractedCharacters: 0, textLayer: "none", strategy: "ocr", headings: [], problemNumbers: [], structure: "unknown" }],
      likelyRelevantPages: [1],
    } as unknown as Awaited<ReturnType<WorkspaceManager["indexPdf"]>>);
    vi.spyOn(manager, "extractPdfTextPages").mockResolvedValue([{ page: 1, text: "" }]);
    vi.spyOn(manager, "ocrPdfPages").mockResolvedValue([{
      page: 1,
      text: swingPage.map((line) => line.text).join("\n"),
      confidence: 72,
      imageWidth: 1445,
      imageHeight: 1870,
      regions: [...swingPage, ...rollerCoasterPage],
    }]);
    vi.spyOn(manager, "renderPdfPage").mockResolvedValue(image);

    const result = await manager.detectPdfProblems("packet.pdf", ["18", "19", "20"], workspace, [1]);

    expect(result.matches.map((match) => match.problemNumber).sort()).toEqual(["18", "19", "20"]);
    expect(result.figures).toEqual([{ problemNumber: "19", page: 1, caption: null }]);
    // Printed captions only: the wrapped "Figure P6.43." mention is not listed.
    expect(result.figureCaptions).toEqual([
      { page: 1, caption: "FIGURE P8.20" },
      { page: 1, caption: "FIGURE P6.43" },
    ]);
  });

  it("finds starred problem numbers and ignores lines that start with a decimal", () => {
    const matches = detectProblemMatches([{
      page: 3,
      representation: "ocr",
      confidence: 70,
      text: "*19. A swing ride at a carnival\n40. A downhill skier attains a speed of\n21.0 m/s just as she reaches the jump.\n**20. A rigid massless rod",
    }], ["19", "20", "21", "40"]);

    expect(matches.map((match) => match.problemNumber).sort()).toEqual(["19", "20", "40"]);
  });
});
