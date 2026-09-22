import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { ActivityStore } from "./activity.js";
import { semanticVisualRectFromImage, WorkspaceManager } from "./workspace.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "semantic-crops");
type Layout = { width: number; height: number; lines: Array<{ text: string; left: number; top: number; width: number; height: number }> };
const layout = async (name: string): Promise<Layout> => JSON.parse(await readFile(join(fixtures, `${name}.json`), "utf8"));

// Bounds are visually checked content extents and surrounding exclusion limits,
// not snapshots of the algorithm's returned rectangle. See fixtures/README.md.
const cases = [
  { name: "physics-5", query: "F1 F2 65.0° 5.00 kg", content: [842, 267, 1099, 471], limit: [800, 245, 1140, 508] },
  { name: "physics-6", query: "Figure P4.19", content: [151, 675, 498, 1076], limit: [110, 640, 540, 1110] },
  { name: "physics-6", query: "Figure P4.27", content: [799, 733, 1253, 900], limit: [760, 700, 1310, 913] },
  { name: "physics-7", query: "M=43.8 kg", content: [172, 559, 475, 777], limit: [130, 530, 515, 815] },
  { name: "physics-7", query: "M=100 kg", content: [167, 1208, 470, 1428], limit: [125, 1180, 515, 1460] },
  { name: "physics-8", query: "FIGURE 4-48", content: [845, 413, 1303, 785], limit: [841, 375, 1340, 818] },
  { name: "physics-9", query: "1. m1 = 10.0 kg", content: [140, 604, 450, 949], limit: [100, 460, 490, 990] },
  { name: "physics-9", query: "2. m1 = 10.0 kg", content: [765, 609, 1203, 867], limit: [720, 450, 1240, 910] },
  { name: "physics-9", query: "3. m1 = 10.0 kg", content: [59, 1095, 554, 1351], limit: [20, 980, 595, 1400] },
  { name: "physics-9", query: "4. m1 = 10.0 kg", content: [700, 1095, 1360, 1350], limit: [660, 980, 1400, 1400] },
  { name: "physics-9", query: "5. m1 = 10.0 kg", content: [322, 1479, 1143, 1721], limit: [130, 1400, 1180, 1760] },
  { name: "chem-26", query: "photoelectron spectra below", content: [260, 732, 1186, 858], limit: [230, 695, 1220, 890] },
  { name: "chem-27", query: "mass spectrometer, resulting in the data below", content: [483, 705, 964, 1039], limit: [450, 670, 1000, 1075] },
];

describe("recorded problem-extraction visual regressions", () => {
  it.each(cases)("crops $name: $query", async ({ name, query, content, limit }) => {
    const page = await layout(name);
    const rect = await semanticVisualRectFromImage(join(fixtures, `${name}.png`), page.lines, query);
    expect(rect).not.toBeNull();
    const edges = [rect!.left, rect!.top, rect!.left + rect!.width, rect!.top + rect!.height];
    expect(edges[0]).toBeLessThanOrEqual(content[0]!);
    expect(edges[1]).toBeLessThanOrEqual(content[1]!);
    expect(edges[2]).toBeGreaterThanOrEqual(content[2]!);
    expect(edges[3]).toBeGreaterThanOrEqual(content[3]!);
    expect(edges[0]).toBeGreaterThanOrEqual(limit[0]!);
    expect(edges[1]).toBeGreaterThanOrEqual(limit[1]!);
    expect(edges[2]).toBeLessThanOrEqual(limit[2]!);
    expect(edges[3]).toBeLessThanOrEqual(limit[3]!);
  });

  it("does not substitute a similar figure number or inline mention for an absent caption", async () => {
    const page = await layout("physics-6");
    for (const query of ["Figure P4.1", "Figure P4.2", "Figure P4.99"]) {
      await expect(semanticVisualRectFromImage(join(fixtures, "physics-6.png"), page.lines, query)).resolves.toBeNull();
    }
    await expect(semanticVisualRectFromImage(join(fixtures, "physics-6.png"),
      page.lines.filter(line => !/^Figure P4[.,]19$/u.test(line.text)), "Figure P4.19")).resolves.toBeNull();
  });

  it("returns not_found for unreadable anchors rather than attaching an unrelated visual", async () => {
    const page = await layout("physics-5");
    await expect(semanticVisualRectFromImage(join(fixtures, "physics-5.png"), page.lines, "45.0° 60.0 N")).resolves.toBeNull();
  });

  it("rejects duplicate short anchors instead of silently selecting the first diagram", async () => {
    const page = await layout("physics-7");
    const lines = page.lines.map(line => /^M=/u.test(line.text) ? { ...line, text: "M=100 kg" } : line);
    await expect(semanticVisualRectFromImage(join(fixtures, "physics-7.png"), lines, "M=100 kg")).resolves.toBeNull();
  });

  it("uses image geometry for every visual kind and scales OCR boxes before producing actual crops", async () => {
    const root = await mkdtemp(join(tmpdir(), "school-crop-regression-"));
    const workspace = { id: "regression", path: root, rendersPath: join(root, "renders"), resourcesPath: join(root, "resources") };
    try {
      await mkdir(workspace.rendersPath);
      const image = join(workspace.rendersPath, "page.png");
      await copyFile(join(fixtures, "physics-9.png"), image);
      const page = await layout("physics-9");
      const manager = new WorkspaceManager({ record: vi.fn() } as unknown as ActivityStore);
      const renders = vi.spyOn(manager, "renderPdfPages").mockResolvedValue([{ page: 9, path: image }]);
      vi.spyOn(manager as unknown as { extractPdfLayout: () => Promise<unknown> }, "extractPdfLayout")
        .mockResolvedValue({ width: 612, height: 792, lines: [] });
      vi.spyOn(manager, "ocrPdfPages").mockResolvedValue([{
        page: 9, text: "", confidence: 90, imageWidth: page.width * 2, imageHeight: page.height * 2,
        regions: page.lines.map(line => ({ text: line.text, left: line.left * 2, top: line.top * 2, width: line.width * 2, height: line.height * 2 })),
      }]);
      const results = await manager.semanticCropPdfRegions("unused.pdf", [
        { page: 9, query: "3. m1 = 10.0 kg", kind: "diagram" },
        { page: 9, query: "5. m1 = 10.0 kg", kind: "graph", padding: 0 },
        { page: 9, query: "Figure P4.99", kind: "figure" },
        { page: 9, query: "Find the acceleration." },
      ], workspace);
      expect(renders).toHaveBeenCalledTimes(1);
      expect(results.map(result => result.status)).toEqual(["completed", "completed", "not_found", "skipped_text_only"]);
      expect(results[0]!.rect!.left + results[0]!.rect!.width).toBeGreaterThanOrEqual(554);
      expect(results[1]!.rect!.left + results[1]!.rect!.width).toBeGreaterThanOrEqual(1143);
      for (const result of results.slice(0, 2)) {
        expect(result.basis).toBe("figure-layout");
        const metadata = await sharp(result.path!).metadata();
        expect(metadata.width).toBe(result.rect!.width);
        expect(metadata.height).toBe(result.rect!.height);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
