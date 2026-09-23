import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { promisify } from "node:util";

import * as cheerio from "cheerio";
import sharp from "sharp";
import { createWorker } from "tesseract.js";
import englishOcrData from "@tesseract.js-data/eng";

import type { ActivityStore } from "./activity.js";
import type { CanvasClient, CanvasFile } from "./canvas-client.js";
import { CACHE_DIR, TEMP_WORKSPACE_ROOT, WORKSPACE_ASSET_DIR } from "./env.js";
import { safeChild } from "./safe-path.js";
import type { AppSettings } from "./settings.js";

export { safeChild };

const execFileAsync = promisify(execFile);
const PDF_OCR_DPI = 170;
// Sharp enough to zoom into small diagram labels in the page viewer.
const SOURCE_PAGE_DPI = 200;

export type CacheStats = {
  files: number;
  bytes: number;
  hits: number;
  misses: number;
};

export type AssignmentWorkspace = {
  id: string;
  path: string;
  resourcesPath: string;
  rendersPath: string;
};

export type PdfInspection = {
  pageCount: number;
  textLayer: "usable" | "sparse" | "none";
  hasUsableTextLayer: boolean;
  primarilyScanned: boolean;
  recommendation: "text" | "vision";
  sampledPages: { start: number; end: number };
  extractedCharacters: number;
};

export type PdfPageIndex = {
  page: number;
  extractedCharacters: number;
  textLayer: PdfInspection["textLayer"];
  strategy: "text" | "render" | "ocr";
  headings: string[];
  problemNumbers: string[];
  structure: "worksheet" | "textbook" | "instructions" | "unknown";
};

export type PdfDocumentIndex = PdfInspection & {
  pages: PdfPageIndex[];
  likelyRelevantPages: number[];
  detectedProblemNumbers: string[];
  contactSheetRecommended: boolean;
};

export type PdfOcrPage = {
  page: number;
  text: string;
  confidence: number;
  imageWidth?: number;
  imageHeight?: number;
  regions: Array<{ text: string; left: number; top: number; width: number; height: number }>;
};

type OcrBoxedText = {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
};

function ocrRegion(region: OcrBoxedText): PdfOcrPage["regions"][number] {
  return {
    text: region.text,
    left: region.bbox.x0,
    top: region.bbox.y0,
    width: Math.max(1, region.bbox.x1 - region.bbox.x0),
    height: Math.max(1, region.bbox.y1 - region.bbox.y0),
  };
}

function splitOcrLineRegions(
  words: OcrBoxedText[],
  fallback: OcrBoxedText,
): PdfOcrPage["regions"] {
  const sorted = [...words]
    .filter((word) => word.text.trim())
    .sort((left, right) => left.bbox.x0 - right.bbox.x0);
  if (sorted.length === 0) return [ocrRegion(fallback)];
  const segments: OcrBoxedText[][] = [[]];
  for (const word of sorted) {
    const segment = segments.at(-1)!;
    const previous = segment.at(-1);
    const lineHeight = Math.max(1, fallback.bbox.y1 - fallback.bbox.y0);
    // OCR line boxes can span a printed question column and a handwritten answer
    // column. Their noisy height made the old 3x threshold too large to split the
    // columns, which interleaved answers into problem text. Normal word spacing is
    // far smaller than this conservative 1.2x/45px boundary at our render DPI.
    if (previous && word.bbox.x0 - previous.bbox.x1 > Math.max(45, lineHeight * 1.2)) {
      segments.push([]);
    }
    segments.at(-1)!.push(word);
  }
  return segments.map((segment) => ocrRegion({
    text: segment.map((word) => word.text).join(" "),
    bbox: {
      x0: Math.min(...segment.map((word) => word.bbox.x0)),
      y0: Math.min(...segment.map((word) => word.bbox.y0)),
      x1: Math.max(...segment.map((word) => word.bbox.x1)),
      y1: Math.max(...segment.map((word) => word.bbox.y1)),
    },
  }));
}

export type PdfProblemMatch = {
  problemNumber: string;
  page: number;
  text: string;
  representation: "text" | "ocr";
  confidence: "high" | "medium" | "low";
};

// How a semantic crop found its visual. Anything but an exact caption or label is a
// fallback the agent must confirm by looking at the returned image.
export type PdfCropAnchor = "caption" | "ocr-corrected-caption" | "label" | "problem-number";

export type PdfSemanticCrop = {
  page: number;
  query: string;
  status: "completed" | "not_found" | "skipped_text_only";
  path: string | null;
  rect: { left: number; top: number; width: number; height: number } | null;
  basis: "text-layout" | "ocr-layout" | "figure-layout" | null;
  anchor: PdfCropAnchor | null;
  note: string | null;
  error: string | null;
};

// Detection hints about supplied visuals: a sizeable drawing inside a detected problem's
// region, and every figure caption read on the searched pages.
export type PdfFigureHints = {
  figures: Array<{ problemNumber: string; page: number; caption: string | null }>;
  figureCaptions: Array<{ page: number; caption: string }>;
};

export type PdfVisualKind = "figure" | "diagram" | "graph" | "chart" | "table" | "spectrum" | "map" | "image";

export class WorkspaceManager {
  private hits = 0;
  private misses = 0;
  private readonly operationCache = new Map<string, Promise<unknown>>();

  constructor(
    private readonly activity: ActivityStore,
    private readonly workspaceRoot = TEMP_WORKSPACE_ROOT,
    private readonly assetRoot = WORKSPACE_ASSET_DIR,
  ) {}

  async create(logicalId: string): Promise<AssignmentWorkspace> {
    await mkdir(this.workspaceRoot, { recursive: true });
    const id = `${safeName(logicalId).slice(0, 48)}-${randomUUID().slice(0, 8)}`;
    const path = join(this.workspaceRoot, id);
    const resourcesPath = join(path, "resources");
    const rendersPath = join(path, "renders");
    await Promise.all([
      mkdir(resourcesPath, { recursive: true }),
      mkdir(rendersPath, { recursive: true }),
    ]);
    return { id, path, resourcesPath, rendersPath };
  }

  async writeJson(workspace: AssignmentWorkspace, name: string, value: unknown) {
    const destination = safeChild(workspace.path, name);
    await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return destination;
  }

  async copyWorkspaceAsset(
    sourceWorkspaceId: string,
    sourceRelativePath: string,
    destinationWorkspace: AssignmentWorkspace,
    destinationName: string,
  ): Promise<string> {
    const source = await this.resolveWorkspaceAsset(sourceWorkspaceId, sourceRelativePath);
    const destination = safeChild(
      destinationWorkspace.resourcesPath,
      safeName(destinationName),
    );
    await copyFile(source, destination);
    return relative(destinationWorkspace.path, destination).replaceAll("\\", "/");
  }

  async resolveWorkspaceAsset(workspaceId: string, relativePath: string): Promise<string> {
    const saved = safeChild(safeChild(this.assetRoot, workspaceId), relativePath);
    try {
      if ((await stat(saved)).isFile()) return saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = safeChild(safeChild(this.workspaceRoot, workspaceId), relativePath);
    if (!(await stat(temporary)).isFile()) throw new Error("Workspace asset is not a file.");
    return temporary;
  }

  // Only final, referenced visuals belong here. PDFs, prompts, and intermediate
  // renders remain temporary and still expire under the workspace retention policy.
  async preserveWorkspaceAssets(
    workspaceId: string,
    paths: string[],
    allowMissing = false,
  ): Promise<string[]> {
    const missing: string[] = [];
    for (const path of new Set(paths)) {
      try {
        const source = await this.resolveWorkspaceAsset(workspaceId, path);
        const destination = safeChild(safeChild(this.assetRoot, workspaceId), path);
        if (source === destination) continue;
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(source, destination);
      } catch (error) {
        if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        missing.push(path);
      }
    }
    return missing;
  }

  async cacheCanvasFile(
    client: CanvasClient,
    file: CanvasFile,
    workspace: AssignmentWorkspace,
    settings: AppSettings,
  ): Promise<{ path: string; cache: "hit" | "miss"; name: string }> {
    await mkdir(CACHE_DIR, { recursive: true });
    const fingerprint = createHash("sha256")
      .update(`${file.id}:${file.size ?? ""}:${file.updated_at ?? ""}:${file.url}`)
      .digest("hex")
      .slice(0, 20);
    const extension = safeExtension(file.display_name);
    const cachePath = join(CACHE_DIR, `${fingerprint}${extension}`);
    const destination = safeChild(
      workspace.resourcesPath,
      `${String(file.id)}-${safeName(file.display_name)}`,
    );
    let cache: "hit" | "miss" = "miss";
    try {
      const info = await stat(cachePath);
      const ageMinutes = (Date.now() - info.mtimeMs) / 60_000;
      if (ageMinutes <= settings.cache.ttlMinutes) {
        cache = "hit";
        this.hits += 1;
      } else {
        await client.downloadFile(file, cachePath);
        this.misses += 1;
      }
    } catch {
      await client.downloadFile(file, cachePath);
      this.misses += 1;
    }
    await copyFile(cachePath, destination);
    await this.activity.record({
      category: "cache",
      action: cache,
      status: "completed",
      summary: file.display_name,
      metadata: { fileId: file.id, workspace: workspace.id },
    });
    await this.enforceCacheLimit(settings.cache.maxMegabytes);
    return { path: destination, cache, name: basename(destination) };
  }

  async extractPdfText(pdfPath: string, page?: number): Promise<string> {
    assertPdf(pdfPath);
    const allText = await this.cached(`pdf-text:${pdfPath}`, async () => {
      try {
        const { stdout } = await execFileAsync("pdftotext", ["-layout", pdfPath, "-"], {
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
          timeout: 90_000,
        });
        return stdout;
      } catch (error) {
        throw new Error(`PDF text extraction requires Poppler's pdftotext: ${errorMessage(error)}`);
      }
    });
    if (!page) return allText;
    return splitPdfTextPages(allText)[page - 1] ?? "";
  }

  async extractPdfTextPages(pdfPath: string, pages: number[]): Promise<Array<{ page: number; text: string }>> {
    if (pages.length === 0) throw new Error("Choose at least one PDF page for text extraction.");
    const text = await this.extractPdfText(pdfPath);
    const pageText = splitPdfTextPages(text);
    return pages.map((page) => ({ page, text: pageText[page - 1] ?? "" }));
  }

  async inspectPdf(pdfPath: string): Promise<PdfInspection> {
    const index = await this.indexPdf(pdfPath);
    return {
      pageCount: index.pageCount,
      textLayer: index.textLayer,
      hasUsableTextLayer: index.hasUsableTextLayer,
      primarilyScanned: index.primarilyScanned,
      recommendation: index.recommendation,
      sampledPages: index.sampledPages,
      extractedCharacters: index.extractedCharacters,
    };
  }

  async indexPdf(pdfPath: string, requestedProblems: string[] = []): Promise<PdfDocumentIndex> {
    assertPdf(pdfPath);
    const base = await this.cached(`pdf-index:${pdfPath}`, async () => {
      const [infoResult, textResult] = await Promise.all([
        execFileAsync("pdfinfo", [pdfPath], {
          encoding: "utf8",
          maxBuffer: 2 * 1024 * 1024,
          timeout: 30_000,
        }).catch((error) => {
          throw new Error(`PDF inspection requires Poppler's pdfinfo: ${errorMessage(error)}`);
        }),
        this.extractPdfText(pdfPath),
      ]);
      return buildPdfDocumentIndex(parsePdfPageCount(infoResult.stdout), textResult);
    });
    if (requestedProblems.length === 0) return base;
    return addRequestedProblemsToIndex(base, requestedProblems);
  }

  async renderPdfPage(
    pdfPath: string,
    page: number,
    workspace: AssignmentWorkspace,
    dpi = 170,
  ): Promise<string> {
    assertPdf(pdfPath);
    if (!Number.isInteger(page) || page < 1) throw new Error("PDF page must be at least 1.");
    if (!Number.isInteger(dpi) || dpi < 36 || dpi > 300) throw new Error("PDF render DPI must be between 36 and 300.");
    const stem = safeName(basename(pdfPath, extname(pdfPath)));
    const outputStem = join(workspace.rendersPath, `${stem}-page-${page}-${dpi}dpi`);
    return this.cached(`pdf-render:${pdfPath}:${page}:${dpi}:${workspace.id}`, async () => {
      try {
        await execFileAsync(
          "pdftoppm",
          ["-f", String(page), "-l", String(page), "-singlefile", "-png", "-r", String(dpi), pdfPath, outputStem],
          { timeout: 90_000, maxBuffer: 8 * 1024 * 1024 },
        );
      } catch (error) {
        throw new Error(`PDF rendering requires Poppler's pdftoppm: ${errorMessage(error)}`);
      }
      const destination = `${outputStem}.png`;
      await this.activity.record({
        category: "resource",
        action: "render_pdf_page",
        status: "completed",
        summary: `${basename(pdfPath)} page ${page}`,
        metadata: { workspace: workspace.id, output: basename(destination), dpi },
      });
      return destination;
    });
  }

  async renderPdfPages(
    pdfPath: string,
    pages: number[],
    workspace: AssignmentWorkspace,
    concurrency = 4,
    dpi = 170,
  ): Promise<Array<{ page: number; path: string }>> {
    if (pages.length === 0) throw new Error("Choose at least one PDF page to render.");
    const results = new Array<{ page: number; path: string }>(pages.length);
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(Math.max(1, concurrency), pages.length) },
      async () => {
        while (cursor < pages.length) {
          const index = cursor;
          cursor += 1;
          const page = pages[index];
          results[index] = {
            page,
            path: await this.renderPdfPage(pdfPath, page, workspace, dpi),
          };
        }
      },
    );
    await Promise.all(workers);
    return results;
  }

  async createPdfContactSheet(
    pdfPath: string,
    workspace: AssignmentWorkspace,
    requestedPages?: number[],
  ): Promise<{ path: string; pages: number[] }> {
    const index = await this.indexPdf(pdfPath);
    const pages = requestedPages?.length
      ? [...new Set(requestedPages)].slice(0, 20)
      : selectContactSheetPages(index, 16);
    const key = `pdf-contact:${pdfPath}:${pages.join(",")}:${workspace.id}`;
    const path = await this.cached(key, async () => {
      const renders = await this.renderPdfPages(pdfPath, pages, workspace, 4, 55);
      const columns = pages.length <= 4 ? 2 : 4;
      const cellWidth = 270;
      const cellHeight = 360;
      const composites = await Promise.all(renders.map(async (render, indexPosition) => {
        const thumbnail = await sharp(render.path)
          .resize({ width: 246, height: 318, fit: "inside", withoutEnlargement: true })
          .png()
          .toBuffer();
        const metadata = await sharp(thumbnail).metadata();
        const column = indexPosition % columns;
        const row = Math.floor(indexPosition / columns);
        const left = column * cellWidth + Math.floor((cellWidth - (metadata.width ?? 246)) / 2);
        const top = row * cellHeight + 28;
        const label = Buffer.from(
          `<svg width="${cellWidth}" height="28"><text x="12" y="20" font-family="Arial" font-size="16" fill="#263238">Page ${render.page}</text></svg>`,
        );
        return [
          { input: label, left: column * cellWidth, top: row * cellHeight },
          { input: thumbnail, left, top },
        ];
      }));
      const rows = Math.ceil(pages.length / columns);
      const output = join(
        workspace.rendersPath,
        `${safeName(basename(pdfPath, extname(pdfPath)))}-contact-${hashKey(pages.join(","))}.png`,
      );
      await sharp({
        create: {
          width: columns * cellWidth,
          height: Math.max(1, rows) * cellHeight,
          channels: 3,
          background: "#eef1f2",
        },
      }).composite(composites.flat()).png().toFile(output);
      return output;
    });
    return { path, pages };
  }

  async ocrPdfPages(
    pdfPath: string,
    pages: number[],
    workspace: AssignmentWorkspace,
  ): Promise<PdfOcrPage[]> {
    const uniquePages = [...new Set(pages)];
    if (uniquePages.length === 0) throw new Error("Choose at least one PDF page for OCR.");
    if (uniquePages.length > 40) throw new Error("One OCR batch may contain at most 40 pages.");
    const cachedResults = await Promise.all(uniquePages.map(async (page) => {
      const key = `pdf-ocr:${pdfPath}:${page}:${workspace.id}`;
      const existing = this.operationCache.get(key);
      return existing ? { page, result: await existing as PdfOcrPage } : { page, result: null };
    }));
    const missing = cachedResults.filter((item) => !item.result).map((item) => item.page);
    if (missing.length > 0) {
      const renders = await this.renderPdfPages(pdfPath, missing, workspace, 4, PDF_OCR_DPI);
      const workerCount = Math.min(2, renders.length);
      const workers = await Promise.all(Array.from({ length: workerCount }, () => createWorker("eng", 1, {
        langPath: englishOcrData.langPath,
        gzip: englishOcrData.gzip,
        cacheMethod: "none",
      })));
      let cursor = 0;
      try {
        await Promise.all(workers.map(async (worker) => {
          while (cursor < renders.length) {
            const current = renders[cursor++];
            const key = `pdf-ocr:${pdfPath}:${current.page}:${workspace.id}`;
            const imageMetadata = await sharp(current.path).metadata();
            const promise = worker.recognize(
              current.path,
              // Bounding boxes must use the same coordinates as the saved render.
              // Auto-rotation reports boxes in a deskewed image, not this source.
              { rotateAuto: false },
              { text: true, blocks: true },
            ).then(({ data }) => {
              const blocks = data.blocks ?? [];
              const lines = blocks.flatMap((block) =>
                (block.paragraphs ?? []).flatMap((paragraph) => paragraph.lines ?? []));
              const regions = lines.length > 0
                ? lines.flatMap((line) => splitOcrLineRegions(line.words ?? [], line))
                : blocks.map((block) => ocrRegion(block));
              return {
                page: current.page,
                text: buildOcrReadingOrderText(regions, imageMetadata.width ?? 1),
                confidence: data.confidence,
                imageWidth: imageMetadata.width,
                imageHeight: imageMetadata.height,
                regions,
              };
            }).catch((error) => {
              this.operationCache.delete(key);
              throw error;
            });
            this.operationCache.set(key, promise);
            await promise;
          }
        }));
      } finally {
        await Promise.all(workers.map((worker) => worker.terminate()));
      }
    }
    return Promise.all(uniquePages.map((page) => this.cached(
      `pdf-ocr:${pdfPath}:${page}:${workspace.id}`,
      async () => { throw new Error(`OCR result for page ${page} was not produced.`); },
    )));
  }

  async detectPdfProblems(
    pdfPath: string,
    requestedProblems: string[],
    workspace: AssignmentWorkspace,
    selectedPages?: number[],
    sectionHeading?: string,
  ): Promise<{
    matches: PdfProblemMatch[];
    searchedPages: number[];
    usedOcr: boolean;
    unresolvedProblemNumbers: string[];
    ocrSkippedPages: number[];
  } & PdfFigureHints> {
    const index = await this.indexPdf(pdfPath, requestedProblems);
    const pages = selectedPages?.length
      ? [...new Set(selectedPages)]
      : Array.from({ length: index.pageCount }, (_value, page) => page + 1);
    const textPages = await this.extractPdfTextPages(pdfPath, pages);
    const textMatches = detectProblemMatches(
      textPages.map((entry) => ({ ...entry, representation: "text" as const, confidence: 100 })),
      requestedProblems,
      sectionHeading,
    );
    const found = new Set(textMatches.map((match) => normalizeProblemNumber(match.problemNumber)));
    const requested = requestedProblems.map(normalizeProblemNumber).filter(Boolean);
    const unresolved = requested.filter((problem) => !found.has(problem));
    const nonTextPages = pages.filter((page) => index.pages[page - 1]?.strategy !== "text");
    const exactCandidatePages = new Set(index.pages
      .filter((page) => page.problemNumbers.some((number) => unresolved.includes(normalizeProblemNumber(number))))
      .map((page) => page.page));
    const likelyCandidatePages = new Set(index.likelyRelevantPages);
    const ocrCandidates = nonTextPages.filter((page) =>
      exactCandidatePages.has(page) || likelyCandidatePages.has(page));
    const ocrLimit = selectedPages?.length ? 40 : 8;
    const shouldOcrVisibleProblems = requested.length === 0 && Boolean(selectedPages?.length);
    const shouldOcrUnresolvedProblems = unresolved.length > 0;
    const fallbackCandidates = index.pageCount <= 4 ? nonTextPages : [];
    const eligibleOcrPages = selectedPages?.length
      ? nonTextPages
      : ocrCandidates.length > 0 ? ocrCandidates : fallbackCandidates;
    const ocrPages = shouldOcrVisibleProblems || shouldOcrUnresolvedProblems
      ? eligibleOcrPages.slice(0, ocrLimit)
      : [];
    const ocr = ocrPages.length > 0 ? await this.ocrPdfPages(pdfPath, ocrPages, workspace) : [];
    const ocrMatches = detectProblemMatches(
      ocr.map((entry) => ({
        page: entry.page,
        text: entry.text,
        representation: "ocr" as const,
        confidence: entry.confidence,
      })),
      requestedProblems,
      sectionHeading,
    );
    const matches = dedupeProblemMatches([...textMatches, ...ocrMatches]);
    const resolved = new Set(matches.map((match) => normalizeProblemNumber(match.problemNumber)));
    const textPageNumbers = new Set(pages.filter((page) => !nonTextPages.includes(page)));
    const hints = await this.figureHints(pdfPath, matches, pages.filter((page) => textPageNumbers.has(page)), ocr, workspace)
      .catch((): PdfFigureHints => ({ figures: [], figureCaptions: [] }));
    return {
      matches,
      searchedPages: pages,
      usedOcr: ocr.length > 0,
      unresolvedProblemNumbers: requestedProblems.filter((problem) => !resolved.has(normalizeProblemNumber(problem))),
      ocrSkippedPages: nonTextPages.filter((page) => !ocrPages.includes(page)),
      ...hints,
    };
  }

  // Best-effort hints only: a failure here must never fail problem detection.
  private async figureHints(
    pdfPath: string,
    matches: PdfProblemMatch[],
    textPages: number[],
    ocr: PdfOcrPage[],
    workspace: AssignmentWorkspace,
  ): Promise<PdfFigureHints> {
    const ocrByPage = new Map(ocr.map((page) => [page.page, page]));
    const linePages = [...new Set([...textPages, ...ocrByPage.keys()])].sort((left, right) => left - right);
    const matchPages = new Set(matches.map((match) => match.page));
    const figureCaptions: PdfFigureHints["figureCaptions"] = [];
    const figures: PdfFigureHints["figures"] = [];
    // Drawings are only measured on pages holding a detected problem, and on a bounded number of them.
    const analyzedPages = new Set(linePages.filter((page) => matchPages.has(page)).slice(0, 12));
    for (const page of linePages) {
      const render = analyzedPages.has(page)
        ? await this.renderPdfPage(pdfPath, page, workspace, PDF_OCR_DPI)
        : null;
      const size = render ? await sharp(render).metadata() : null;
      const lines = await this.visualLinesForPage(pdfPath, page, ocrByPage.get(page) ?? null,
        size?.width ?? 1, size?.height ?? 1);
      for (const line of lines) {
        if (isCaption(line) && !isFigureMention(line)) figureCaptions.push({ page, caption: line.text.trim() });
      }
      if (!render) continue;
      const visualPage = await this.cached(`visual-layout:${render}`, () => analyzeVisualPage(render));
      for (const match of matches.filter((item) => item.page === page)) {
        const figure = figureNearProblem(visualPage, lines, match.problemNumber);
        if (figure) figures.push({ problemNumber: match.problemNumber, page, caption: figure.caption });
      }
    }
    return { figures, figureCaptions };
  }

  // Printed-text lines in render pixel coordinates: OCR regions for scanned pages,
  // otherwise the PDF text layer scaled onto the render.
  private async visualLinesForPage(
    pdfPath: string,
    page: number,
    ocr: PdfOcrPage | null,
    width: number,
    height: number,
  ): Promise<VisualLine[]> {
    if (ocr) {
      return ocr.regions.map((line) => ({ text: line.text, ...scaleAndClampRect(line,
        ocr.imageWidth ?? width, ocr.imageHeight ?? height, width, height, 0) }));
    }
    const layout = await this.extractPdfLayout(pdfPath, page);
    return layout.lines.map((line) => ({
      text: line.text,
      ...scaleAndClampRect({ left: line.xMin, top: line.yMin, width: line.xMax - line.xMin, height: line.yMax - line.yMin },
        layout.width, layout.height, width, height, 0),
    }));
  }

  // Full-page JPEGs kept with an extraction so the student and the answer-key run can read
  // the whole source page when a crop is missing or wrong.
  async renderSourcePages(
    pdfPath: string,
    pages: number[],
    workspace: AssignmentWorkspace,
    dpi = SOURCE_PAGE_DPI,
  ): Promise<Array<{ page: number; path: string }>> {
    assertPdf(pdfPath);
    const directory = join(workspace.path, "source-pages");
    await mkdir(directory, { recursive: true });
    const stem = safeName(basename(pdfPath, extname(pdfPath)));
    const results: Array<{ page: number; path: string }> = [];
    for (const page of [...new Set(pages)].sort((left, right) => left - right)) {
      const outputStem = join(directory, `${stem}-page-${page}`);
      const path = await this.cached(`pdf-source-page:${pdfPath}:${page}:${dpi}:${workspace.id}`, async () => {
        try {
          await execFileAsync(
            "pdftoppm",
            ["-f", String(page), "-l", String(page), "-singlefile", "-jpeg", "-jpegopt", "quality=82", "-r", String(dpi), pdfPath, outputStem],
            { timeout: 90_000, maxBuffer: 8 * 1024 * 1024 },
          );
        } catch (error) {
          throw new Error(`PDF rendering requires Poppler's pdftoppm: ${errorMessage(error)}`);
        }
        return `${outputStem}.jpg`;
      });
      results.push({ page, path });
    }
    return results;
  }

  async cropImages(
    crops: Array<{ path: string; rect: { left: number; top: number; width: number; height: number } }>,
    workspace: AssignmentWorkspace,
  ): Promise<Array<{ sourcePath: string; path: string }>> {
    return Promise.all(crops.map(async (crop) => ({
      sourcePath: crop.path,
      path: await this.cropImage(crop.path, crop.rect, workspace),
    })));
  }

  async semanticCropPdfRegions(
    pdfPath: string,
    regions: Array<{ page: number; query: string; kind?: PdfVisualKind; padding?: number; problemNumber?: string }>,
    workspace: AssignmentWorkspace,
  ): Promise<PdfSemanticCrop[]> {
    if (regions.length === 0) throw new Error("Choose at least one semantic PDF region.");
    if (regions.length > 20) throw new Error("One semantic crop batch may contain at most 20 regions.");
    const pages = [...new Set(regions
      .filter((region) => isVisualCropQuery(region.query, region.kind))
      .map((region) => region.page))];
    if (pages.length === 0) {
      return regions.map((region) => skippedTextCrop(region));
    }
    const renders = await this.renderPdfPages(pdfPath, pages, workspace, 4, 170);
    const renderByPage = new Map(renders.map((render) => [render.page, render.path]));
    const layoutEntries = await Promise.all(pages.map(async (page) => [page, await this.extractPdfLayout(pdfPath, page)] as const));
    const layouts = new Map(layoutEntries);
    const results: PdfSemanticCrop[] = [];
    for (const region of regions) {
      if (!isVisualCropQuery(region.query, region.kind)) {
        results.push(skippedTextCrop(region));
        continue;
      }
      const renderPath = renderByPage.get(region.page)!;
      const metadata = await sharp(renderPath).metadata();
      const width = metadata.width ?? 1;
      const height = metadata.height ?? 1;
      const layout = layouts.get(region.page)!;
      const visualPage = await this.cached(`visual-layout:${renderPath}`, () => analyzeVisualPage(renderPath));
      const textLines = layout.lines.map((line) => ({
        text: line.text,
        ...scaleAndClampRect({ left: line.xMin, top: line.yMin, width: line.xMax - line.xMin, height: line.yMax - line.yMin },
          layout.width, layout.height, width, height, 0),
      }));
      let ocrLines: VisualLine[] | null = null;
      const readOcrLines = async () => {
        if (!ocrLines) {
          const [ocr] = await this.ocrPdfPages(pdfPath, [region.page], workspace);
          ocrLines = await this.visualLinesForPage(pdfPath, region.page, ocr!, width, height);
        }
        return ocrLines;
      };
      let match = semanticVisualRect(visualPage, textLines, region.query, region.padding)
        ?? semanticVisualRect(visualPage, await readOcrLines(), region.query, region.padding);
      // A scanned label or caption can be unreadable even when the problem start is not;
      // the drawing inside that problem's region is then the best remaining anchor.
      const problemNumber = region.problemNumber ? normalizeProblemNumber(region.problemNumber) : "";
      let fellBack = false;
      if (!match && /^\d{1,4}[a-z]?$/u.test(problemNumber)) {
        match = problemVisualRect(visualPage, textLines, problemNumber, region.padding)
          ?? problemVisualRect(visualPage, await readOcrLines(), problemNumber, region.padding);
        fellBack = match !== null;
      }
      if (!match) {
        results.push({
          page: region.page,
          query: region.query,
          status: "not_found",
          path: null,
          rect: null,
          basis: null,
          anchor: null,
          note: null,
          error: `Could not locate a complete region for ${region.query} on page ${region.page}. ${problemNumber
            ? `Problem ${region.problemNumber} did not anchor a drawing either.`
            : "Pass problemNumber for a numbered problem, or crop known render coordinates."}`,
        });
        continue;
      }
      results.push({
        page: region.page,
        query: region.query,
        status: "completed",
        rect: match.rect,
        basis: "figure-layout",
        anchor: match.anchor,
        note: cropAnchorNote(match, region, fellBack),
        path: await this.cropImage(relative(workspace.path, renderPath), match.rect, workspace),
        error: null,
      });
    }
    return results;
  }

  private async extractPdfLayout(
    pdfPath: string,
    page: number,
  ): Promise<{ width: number; height: number; lines: PdfLayoutLine[] }> {
    return this.cached(`pdf-layout:${pdfPath}:${page}`, async () => {
      try {
        const { stdout } = await execFileAsync(
          "pdftotext",
          ["-f", String(page), "-l", String(page), "-bbox-layout", pdfPath, "-"],
          { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60_000 },
        );
        return parsePdfBboxLayout(stdout);
      } catch (error) {
        throw new Error(`PDF layout extraction requires Poppler's pdftotext: ${errorMessage(error)}`);
      }
    });
  }

  async cropImage(
    sourcePath: string,
    rect: { left: number; top: number; width: number; height: number },
    workspace: AssignmentWorkspace,
  ): Promise<string> {
    for (const value of Object.values(rect)) {
      if (!Number.isInteger(value) || value < 0) throw new Error("Crop values must be non-negative integers.");
    }
    if (rect.width < 10 || rect.height < 10) throw new Error("Crop is too small.");
    const source = safeChild(workspace.path, sourcePath);
    const key = `${source}:${rect.left}:${rect.top}:${rect.width}:${rect.height}`;
    const output = join(
      workspace.rendersPath,
      `${basename(source, extname(source))}-crop-${hashKey(key)}.png`,
    );
    return this.cached(`image-crop:${key}`, async () => {
      const metadata = await sharp(source).metadata();
      if (
        rect.left + rect.width > (metadata.width ?? 0) ||
        rect.top + rect.height > (metadata.height ?? 0)
      ) {
        throw new Error("Crop rectangle exceeds the source image bounds.");
      }
      await sharp(source).extract(rect).png().toFile(output);
      return output;
    });
  }

  async stats(): Promise<CacheStats> {
    let files = 0;
    let bytes = 0;
    try {
      for (const entry of await readdir(CACHE_DIR, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const info = await stat(join(CACHE_DIR, entry.name));
        files += 1;
        bytes += info.size;
      }
    } catch {
      // Empty cache.
    }
    return { files, bytes, hits: this.hits, misses: this.misses };
  }

  async clearCache(): Promise<void> {
    await rm(CACHE_DIR, { recursive: true, force: true });
    this.hits = 0;
    this.misses = 0;
    await this.activity.record({
      category: "cache",
      action: "clear",
      status: "completed",
      summary: "Downloaded resource cache cleared",
    });
  }

  async pruneWorkspaces(retentionHours: number): Promise<number> {
    let removed = 0;
    try {
      for (const entry of await readdir(this.workspaceRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const path = join(this.workspaceRoot, entry.name);
        const info = await stat(path);
        if (Date.now() - info.mtimeMs > retentionHours * 3_600_000) {
          await rm(path, { recursive: true, force: true });
          removed += 1;
        }
      }
    } catch {
      // Workspace root does not exist yet.
    }
    return removed;
  }

  private async cached<T>(key: string, factory: () => Promise<T>): Promise<T> {
    const existing = this.operationCache.get(key);
    if (existing) return existing as Promise<T>;
    const pending = factory().catch((error) => {
      this.operationCache.delete(key);
      throw error;
    });
    this.operationCache.set(key, pending);
    return pending;
  }

  private async enforceCacheLimit(maxMegabytes: number) {
    const maximum = maxMegabytes * 1024 * 1024;
    let entries: Array<{ path: string; size: number; mtimeMs: number }> = [];
    try {
      entries = await Promise.all(
        (await readdir(CACHE_DIR, { withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map(async (entry) => {
            const path = join(CACHE_DIR, entry.name);
            const info = await stat(path);
            return { path, size: info.size, mtimeMs: info.mtimeMs };
          }),
      );
    } catch {
      return;
    }
    let total = entries.reduce((sum, item) => sum + item.size, 0);
    for (const entry of entries.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      if (total <= maximum) break;
      await rm(entry.path, { force: true });
      total -= entry.size;
    }
  }
}

export type PdfLayoutLine = {
  text: string;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
};

export function splitPdfTextPages(value: string): string[] {
  const pages = value.split("\f");
  if (pages.at(-1)?.trim() === "") pages.pop();
  return pages;
}

export function buildPdfDocumentIndex(pageCount: number, fullText: string): PdfDocumentIndex {
  const texts = splitPdfTextPages(fullText);
  const pages = Array.from({ length: pageCount }, (_value, index) => {
    const text = texts[index] ?? "";
    const extractedCharacters = text.replace(/\s+/g, "").length;
    const textLayer = classifyPdfPageTextLayer(extractedCharacters);
    const problemNumbers = detectProblemStarts(text).map((problem) => problem.number);
    return {
      page: index + 1,
      extractedCharacters,
      textLayer,
      strategy: textLayer === "usable" ? "text" as const : textLayer === "none" ? "ocr" as const : "render" as const,
      headings: detectHeadings(text),
      problemNumbers: [...new Set(problemNumbers)],
      structure: classifyPageStructure(text, problemNumbers.length),
    };
  });
  const sampledPages = { start: 1, end: Math.min(pageCount, 3) };
  const sampleCharacters = pages
    .slice(0, sampledPages.end)
    .reduce((sum, page) => sum + page.extractedCharacters, 0);
  const extractedCharacters = pages.reduce((sum, page) => sum + page.extractedCharacters, 0);
  const usablePages = pages.filter((page) => page.textLayer === "usable").length;
  const textLayer = usablePages >= Math.max(1, Math.ceil(pageCount * 0.4))
    ? "usable"
    : pages.some((page) => page.textLayer !== "none") ? "sparse" : "none";
  const detectedProblemNumbers = [...new Set(pages.flatMap((page) => page.problemNumbers))];
  const likelyRelevantPages = pages
    .filter((page) => page.problemNumbers.length > 0 || page.structure === "worksheet")
    .map((page) => page.page);
  return {
    pageCount,
    textLayer,
    hasUsableTextLayer: textLayer === "usable",
    primarilyScanned: usablePages < Math.max(1, Math.ceil(pageCount / 2)),
    recommendation: textLayer === "usable" ? "text" : "vision",
    sampledPages,
    extractedCharacters: extractedCharacters || sampleCharacters,
    pages,
    likelyRelevantPages: likelyRelevantPages.slice(0, 40),
    detectedProblemNumbers,
    contactSheetRecommended: pageCount > 4 && (likelyRelevantPages.length === 0 || likelyRelevantPages.length > 8),
  };
}

function addRequestedProblemsToIndex(index: PdfDocumentIndex, requestedProblems: string[]): PdfDocumentIndex {
  const wanted = new Set(requestedProblems.map(normalizeProblemNumber).filter(Boolean));
  const matching = index.pages
    .filter((page) => page.problemNumbers.some((problem) => wanted.has(normalizeProblemNumber(problem))))
    .map((page) => page.page);
  return {
    ...index,
    likelyRelevantPages: matching.length > 0 ? matching : index.likelyRelevantPages,
    contactSheetRecommended: matching.length === 0 && index.pageCount > 4,
  };
}

export function detectProblemMatches(
  pages: Array<{ page: number; text: string; representation: "text" | "ocr"; confidence: number }>,
  requestedProblems: string[],
  sectionHeading?: string,
): PdfProblemMatch[] {
  const wanted = new Set(requestedProblems.map(normalizeProblemNumber).filter(Boolean));
  const matches: PdfProblemMatch[] = [];
  for (const page of constrainPagesToSection(pages, sectionHeading)) {
    const starts = page.representation === "ocr"
      ? detectProblemStartsWithOcrHints(page.text, wanted)
      : detectProblemStarts(page.text);
    for (let index = 0; index < starts.length; index += 1) {
      const start = starts[index];
      const normalized = normalizeProblemNumber(start.number);
      if (wanted.size > 0 && !wanted.has(normalized)) continue;
      const end = page.representation === "ocr"
        ? findOcrProblemEnd(starts, index, page.text.length)
        : starts[index + 1]?.offset ?? page.text.length;
      const text = page.text.slice(start.offset, end).trim();
      if (!text) continue;
      matches.push({
        problemNumber: start.number,
        page: page.page,
        text,
        representation: page.representation,
        confidence: page.representation === "text"
          ? "high"
          : page.confidence >= 75 ? "medium" : "low",
      });
    }
  }
  return matches;
}

function constrainPagesToSection<T extends { page: number; text: string }>(
  pages: T[],
  sectionHeading?: string,
): T[] {
  if (!sectionHeading?.trim()) return pages;
  const headingTokens = normalizedHeadingTokens(sectionHeading);
  if (headingTokens.length < 2) return [];
  const candidates = pages.flatMap((page, pageIndex) =>
    page.text.split(/\r?\n/u).map((line, lineIndex) => ({
      page,
      pageIndex,
      lineIndex,
      line,
      score: headingSimilarity(line, headingTokens),
    })));
  const anchor = candidates.sort((left, right) => right.score - left.score)[0];
  if (!anchor || anchor.score < 0.62) return [];
  const sectionPages = pages.slice(anchor.pageIndex, anchor.pageIndex + 5);
  const constrained: T[] = [];
  for (let offset = 0; offset < sectionPages.length; offset += 1) {
    const page = sectionPages[offset]!;
    const lines = page.text.split(/\r?\n/u);
    if (offset > 0) {
      const openingHeading = lines.slice(0, 4).find((line) => looksLikeSectionHeading(line.trim()));
      if (openingHeading && headingSimilarity(openingHeading, headingTokens) < 0.45) {
        break;
      }
    }
    const start = offset === 0 ? anchor.lineIndex : 0;
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index]!.trim();
      if (!looksLikeSectionHeading(line)) continue;
      if (headingSimilarity(line, headingTokens) < 0.45) {
        end = index;
        break;
      }
    }
    const text = lines.slice(start, end).join("\n");
    if (text.trim()) constrained.push({ ...page, text });
    if (end < lines.length) break;
  }
  return constrained;
}

function normalizedHeadingTokens(value: string): string[] {
  return value.toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 2);
}

function headingSimilarity(line: string, expectedTokens: string[]): number {
  const actual = new Set(normalizedHeadingTokens(line));
  if (actual.size === 0) return 0;
  const overlap = expectedTokens.filter((token) => actual.has(token)).length;
  return overlap / expectedTokens.length;
}

function looksLikeSectionHeading(line: string): boolean {
  if (line.length < 5 || line.length > 160) return false;
  return /^(?:chapter|section|unit|lesson|worksheet|practice|review|advanced|problems?|exercises?)\b/iu.test(line) ||
    (line === line.toLocaleUpperCase() && /[A-Z]{3}/u.test(line));
}

function findOcrProblemEnd(
  starts: Array<{ number: string; offset: number }>,
  index: number,
  textLength: number,
): number {
  const current = Number.parseInt(normalizeProblemNumber(starts[index]!.number), 10);
  if (!Number.isFinite(current)) return starts[index + 1]?.offset ?? textLength;
  const later = starts.slice(index + 1);
  const consecutive = later.find((start) =>
    Number.parseInt(normalizeProblemNumber(start.number), 10) === current + 1);
  if (consecutive) return consecutive.offset;
  const plausible = later.find((start) => {
    const number = Number.parseInt(normalizeProblemNumber(start.number), 10);
    return Number.isFinite(number) && number > current && number <= current + 10;
  });
  return plausible?.offset ?? later[0]?.offset ?? textLength;
}

function detectProblemStarts(text: string): Array<{ number: string; offset: number }> {
  const starts: Array<{ number: string; offset: number }> = [];
  // Textbooks star harder problems ("*19.", "**20."); the stars are not part of the number.
  const pattern = /^(?:[^\S\r\n]*[*•]{1,3})?(?:[^\S\r\n]*(?:problem|question|exercise|review|example)[^\S\r\n]*)?(\d{1,4}[a-z]?)(?:[^\S\r\n]*[.)\]:-](?!\d)|[^\S\r\n]{2,})[^\S\r\n]*\S/imug;
  for (const match of text.matchAll(pattern)) {
    starts.push({ number: match[1]!, offset: match.index ?? 0 });
  }
  return starts;
}

function detectProblemStartsWithOcrHints(
  text: string,
  wanted: ReadonlySet<string>,
): Array<{ number: string; offset: number }> {
  const starts = detectProblemStarts(text);
  if (wanted.size === 0) return starts;
  const seenOffsets = new Set(starts.map((start) => start.offset));
  const alreadyFound = new Set(starts.map((start) => normalizeProblemNumber(start.number)));
  const pattern = /^[^\S\r\n]*[*•]{0,3}[^\S\r\n]*[[(]?[^\S\r\n]*([0-9A-Z|]{1,4})[^\S\r\n]*[\])}.:]?[^\S\r\n]+\S/gimu;
  for (const match of text.matchAll(pattern)) {
    const offset = match.index ?? 0;
    if (seenOffsets.has(offset)) continue;
    const token = match[1]!;
    const requestedCandidates = [...wanted].filter((problem) =>
      !alreadyFound.has(problem) && ocrNumberCouldMatch(token, problem));
    if (requestedCandidates.length === 1) {
      const problem = requestedCandidates[0]!;
      starts.push({ number: problem, offset });
      seenOffsets.add(offset);
      alreadyFound.add(problem);
      continue;
    }
    const interpreted = parseOcrLeadingNumber(match[0]);
    if (interpreted !== null && interpreted > 0 && hasExplicitOcrProblemDelimiter(match[0])) {
      starts.push({ number: String(interpreted), offset });
      seenOffsets.add(offset);
      alreadyFound.add(String(interpreted));
      continue;
    }
  }
  const ordered = starts.sort((left, right) => left.offset - right.offset);
  const lines = [...text.matchAll(/^([^\r\n]+)$/gmu)].map((match) => ({
    text: match[1]!,
    offset: match.index ?? 0,
  }));
  for (const problem of wanted) {
    if (!/^\d{1,4}$/u.test(problem) || alreadyFound.has(problem)) continue;
    const number = Number.parseInt(problem, 10);
    const previous = [...ordered].reverse().find((start) =>
      Number.parseInt(normalizeProblemNumber(start.number), 10) === number - 1);
    const next = ordered.find((start) =>
      start.offset > (previous?.offset ?? -1) &&
      Number.parseInt(normalizeProblemNumber(start.number), 10) === number + 1);
    if (!previous || !next) continue;
    const intervalLines = lines.filter((line) =>
      line.offset > previous.offset && line.offset < next.offset);
    const visualReferenceStart = inferFigureReferencedProblemStart(intervalLines, problem);
    if (visualReferenceStart) {
      starts.push({ number: problem, offset: visualReferenceStart.offset });
      alreadyFound.add(problem);
      continue;
    }
    const candidates = intervalLines.filter((line) => {
      const token = line.text.match(/^\s*(\S{1,6})\s+\S/u)?.[1];
      return Boolean(token) && isCorruptOcrProblemToken(token!) && parseOcrLeadingNumber(line.text) === null;
    });
    if (candidates.length === 0) continue;
    starts.push({ number: problem, offset: candidates[0]!.offset });
    alreadyFound.add(problem);
  }
  return starts.sort((left, right) => left.offset - right.offset);
}

function inferFigureReferencedProblemStart(
  lines: Array<{ text: string; offset: number }>,
  problem: string,
): { text: string; offset: number } | null {
  const anchorIndex = lines.findIndex((line) => figureReferenceMatchesProblem(line.text, problem));
  if (anchorIndex < 0) return null;
  let startIndex = anchorIndex;
  for (let steps = 0; startIndex > 0 && steps < 4; steps += 1) {
    const previous = lines[startIndex - 1]!.text.trim();
    if (isProblemStartLine(previous) || /[.!?]["')\]]?$/u.test(previous)) break;
    startIndex -= 1;
  }
  return lines[startIndex]!;
}

function figureReferenceMatchesProblem(text: string, problem: string): boolean {
  const expected = normalizeProblemNumber(problem);
  const labels = text.matchAll(/\b(?:figure|fig\.?)\s*[A-Z]?(\d+(?:\.\d+)*)\b/giu);
  for (const match of labels) {
    const components = match[1]!.split(".");
    if (normalizeProblemNumber(components.at(-1)!) === expected) return true;
  }
  return false;
}

function isCorruptOcrProblemToken(token: string): boolean {
  const normalized = token.trim();
  return /[\[\](){}]/u.test(normalized) ||
    (/^[A-Z0-9|.,:]{1,4}$/u.test(normalized) && /[A-Z|]/u.test(normalized));
}

function hasExplicitOcrProblemDelimiter(text: string): boolean {
  return /^\s*[[(]?\s*[0-9A-Z|]{1,4}\s*[\])}.:]/u.test(text);
}

export function buildOcrReadingOrderText(
  regions: PdfOcrPage["regions"],
  imageWidth: number,
): string {
  const repaired = repairOcrProblemNumberSequence(regions, imageWidth);
  return [...repaired]
    .sort((left, right) => {
      const leftColumn = ocrReadingColumn(left, imageWidth);
      const rightColumn = ocrReadingColumn(right, imageWidth);
      if (leftColumn !== rightColumn) return leftColumn - rightColumn;
      const topDelta = left.top - right.top;
      // Tesseract occasionally gives a tall new-problem line the same top as the
      // short final line of the prior problem. Preserve the continuation first.
      if (Math.abs(topDelta) <= 3) {
        const leftMarker = isLikelyOcrProblemMarker(left.text);
        const rightMarker = isLikelyOcrProblemMarker(right.text);
        if (leftMarker !== rightMarker) return leftMarker ? 1 : -1;
      }
      return topDelta || left.left - right.left;
    })
    .map((region) => region.text.trim())
    .filter(Boolean)
    .join("\n");
}

function isLikelyOcrProblemMarker(text: string): boolean {
  const token = text.match(/^\s*(\S{1,6})\s+\S/u)?.[1];
  return hasExplicitOcrProblemDelimiter(text) || Boolean(token && isCorruptOcrProblemToken(token));
}

function repairOcrProblemNumberSequence(
  regions: PdfOcrPage["regions"],
  imageWidth: number,
): PdfOcrPage["regions"] {
  const output = regions.map((region) => ({ ...region }));
  for (const column of [1, 2]) {
    const columnRegions = output
      .filter((region) => ocrReadingColumn(region, imageWidth) === column)
      .sort((left, right) => left.top - right.top || left.left - right.left);
    const known = columnRegions
      .map((region, index) => ({ index, region, number: parseOcrLeadingNumber(region.text) }))
      .filter((entry): entry is { index: number; region: PdfOcrPage["regions"][number]; number: number } =>
        entry.number !== null);
    if (known.length < 2) continue;
    const tolerance = Math.max(18, imageWidth * 0.015);
    for (let index = 0; index < known.length - 1; index += 1) {
      const current = known[index]!;
      const next = known[index + 1]!;
      const missing = next.number - current.number - 1;
      if (missing < 1 || missing > 4) continue;
      const alignedLeft = (current.region.left + next.region.left) / 2;
      const candidates = columnRegions.slice(current.index + 1, next.index).filter((region) =>
        parseOcrLeadingNumber(region.text) === null &&
        Math.abs(region.left - alignedLeft) <= tolerance &&
        region.text.trim().length >= 12);
      if (candidates.length !== missing) continue;
      candidates.forEach((region, offset) => {
        region.text = `${current.number + offset + 1}. ${region.text.trim()}`;
      });
    }
  }
  return output;
}

function ocrReadingColumn(region: PdfOcrPage["regions"][number], imageWidth: number): number {
  if (region.width >= imageWidth * 0.9) return 0;
  return region.left + region.width / 2 < imageWidth / 2 ? 1 : 2;
}

function parseOcrLeadingNumber(text: string): number | null {
  const match = text.match(/^\s*[[(]?\s*([0-9A-Z|]{1,3})\s*[\])}.,:]?\s+/u);
  if (!match) return null;
  const token = match[1]!.toLocaleUpperCase();
  if (/^\d{1,3}$/u.test(token)) return Number.parseInt(token, 10);
  const lookalikes: Record<string, string> = {
    I: "1", L: "1", "|": "1", Z: "2", A: "4", S: "5", G: "6", B: "8", R: "8", O: "0", Q: "0",
  };
  const normalized = [...token].map((character) => /\d/u.test(character) ? character : lookalikes[character]).join("");
  return /^\d{1,3}$/u.test(normalized) ? Number.parseInt(normalized, 10) : null;
}


function ocrNumberCouldMatch(value: string, expected: string): boolean {
  if (!/^\d{1,4}[a-z]?$/u.test(expected)) return false;
  const expectedDigits = expected.replace(/[a-z]$/u, "");
  const normalizedValue = value.toLocaleUpperCase().replace(/[^0-9A-Z|]/gu, "");
  if (normalizedValue.length !== expectedDigits.length) return false;
  const lookalikes: Record<string, string> = {
    "0": "0OQ",
    "1": "1IL|",
    "2": "2Z",
    "3": "3",
    "4": "4A",
    "5": "5S",
    "6": "6G",
    "7": "7Z",
    "8": "8B",
    "9": "9GQ",
  };
  return [...expectedDigits].every((digit, index) => lookalikes[digit]?.includes(normalizedValue[index]!) ?? false);
}

function detectHeadings(text: string): string[] {
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 3 && line.length <= 100)
    .filter((line) => /^(?:chapter|section|unit|lesson|worksheet|practice|review|problems?|exercises?)\b/i.test(line) || /^[A-Z\d][A-Z\d &'():,-]{5,}$/.test(line))
    .slice(0, 12);
}

function classifyPageStructure(text: string, problemCount: number): PdfPageIndex["structure"] {
  if (problemCount >= 2 || /\b(?:name|date)\s*[:_]_{2,}|\bshow (?:all )?work\b/i.test(text)) return "worksheet";
  if (/\b(?:chapter|section|example|exercise)\b/i.test(text) && text.length > 1200) return "textbook";
  if (/\b(?:instructions?|directions?|submit|due|materials?)\b/i.test(text)) return "instructions";
  return "unknown";
}

export function selectContactSheetPages(index: PdfDocumentIndex, maximum: number): number[] {
  if (index.likelyRelevantPages.length > 0 && index.likelyRelevantPages.length <= maximum) {
    return index.likelyRelevantPages;
  }
  if (index.pageCount <= maximum) {
    return Array.from({ length: index.pageCount }, (_value, page) => page + 1);
  }
  const pages = new Set<number>([1, index.pageCount]);
  for (let indexPosition = 0; indexPosition < maximum - 2; indexPosition += 1) {
    pages.add(Math.round(1 + ((index.pageCount - 1) * (indexPosition + 1)) / (maximum - 1)));
  }
  return [...pages].sort((left, right) => left - right).slice(0, maximum);
}

export function parsePdfBboxLayout(xml: string): { width: number; height: number; lines: PdfLayoutLine[] } {
  const $ = cheerio.load(xml, { xmlMode: true });
  const page = $("page").first();
  const lines = $("line").map((_index, element) => {
    const words = $(element).find("word");
    const text = words.map((_wordIndex, word) => $(word).text()).get().join(" ").trim();
    const boxes = words.map((_wordIndex, word) => ({
      xMin: Number($(word).attr("xMin")),
      yMin: Number($(word).attr("yMin")),
      xMax: Number($(word).attr("xMax")),
      yMax: Number($(word).attr("yMax")),
    })).get().filter((box) => Object.values(box).every(Number.isFinite));
    if (!text || boxes.length === 0) return null;
    return {
      text,
      xMin: Math.min(...boxes.map((box) => box.xMin)),
      yMin: Math.min(...boxes.map((box) => box.yMin)),
      xMax: Math.max(...boxes.map((box) => box.xMax)),
      yMax: Math.max(...boxes.map((box) => box.yMax)),
    };
  }).get().filter((line): line is PdfLayoutLine => line !== null);
  return {
    width: Number(page.attr("width")) || 612,
    height: Number(page.attr("height")) || 792,
    lines,
  };
}

export function isVisualCropQuery(query: string, kind?: PdfVisualKind): boolean {
  return Boolean(kind) || /\b(?:figure|fig\.?|diagram|graph|chart|plot|spectrum|spectra|table|map|illustration|photo|circuit|free[- ]body|shown|depicted|pictured)\b/iu.test(query);
}

function skippedTextCrop(region: { page: number; query: string }): PdfSemanticCrop {
  return {
    page: region.page,
    query: region.query,
    status: "skipped_text_only",
    path: null,
    rect: null,
    basis: null,
    anchor: null,
    note: null,
    error: "Skipped because the request does not identify a required visual. Return the problem as Markdown without an image.",
  };
}

type PixelRect = { left: number; top: number; width: number; height: number };
type VisualLine = PixelRect & { text: string };
type InkComponent = PixelRect & { pixels: number };
type VisualPage = { width: number; height: number; components: InkComponent[] };

// Connected ink preserves the whole graphic, including thin ropes, axes and arrowheads.
// Row projections and OCR boxes cannot provide those bounds: a graphic can cross a
// page midpoint, extend above its label, or share rows with an unrelated illustration.
async function analyzeVisualPage(imagePath: string): Promise<VisualPage> {
  const { data: source, info } = await sharp(imagePath).flatten({ background: "white" })
    .greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  // Bridge single-pixel scan gaps without merging nearby figures or text lines.
  const data = new Uint8Array(width * height).fill(255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (source[y * width + x]! >= 210) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height) data[(y + dy) * width + x + dx] = 0;
      }
    }
  }
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const components: InkComponent[] = [];
  const minimumInk = Math.max(18, Math.round(width * height * 0.00001));
  for (let pixel = 0; pixel < data.length; pixel++) {
    if (visited[pixel] || data[pixel]! >= 210) continue;
    let head = 0;
    let tail = 1;
    queue[0] = pixel;
    visited[pixel] = 1;
    let left = width, top = height, right = 0, bottom = 0;
    while (head < tail) {
      const current = queue[head++]!;
      const x = current % width;
      const y = Math.floor(current / width);
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
          const next = ny * width + nx;
          if (!visited[next] && data[next]! < 210) {
            visited[next] = 1;
            queue[tail++] = next;
          }
        }
      }
    }
    if (tail >= minimumInk) components.push({ left, top, width: right - left + 1, height: bottom - top + 1, pixels: tail });
  }
  return { width, height, components };
}

function rectGap(a: PixelRect, b: PixelRect) {
  return {
    x: Math.max(0, a.left - b.left - b.width, b.left - a.left - a.width),
    y: Math.max(0, a.top - b.top - b.height, b.top - a.top - a.height),
  };
}

function unionRects(rects: PixelRect[]): PixelRect {
  const left = Math.min(...rects.map(rect => rect.left));
  const top = Math.min(...rects.map(rect => rect.top));
  return { left, top,
    width: Math.max(...rects.map(rect => rect.left + rect.width)) - left,
    height: Math.max(...rects.map(rect => rect.top + rect.height)) - top };
}

function figureIdentifier(text: string): string | null {
  return text.match(/\b(?:figure|fig\.?)\s*([a-z]?\d+(?:[.,−–-]\d+)*)\b/iu)?.[1]
    ?.toLowerCase().replace(/[−–]/gu, "-").replace(/,/gu, ".") ?? null;
}

// A caption starts its line with the figure label. A wrapped mention such as
// "Figure 5.21.)" at the start of a prompt line is not one.
function isCaption(line: VisualLine): boolean {
  return /^\s*(?:figure|fig\.?)\s*[a-z]?\d+(?:[.,−–-]\d+)*(?![\d.,−–-]*\))(?!\d|[.,−–-]\d)/iu.test(line.text);
}

// "...as shown in / Figure P6.43." wraps a sentence-ending mention onto its own line.
// It starts like a caption, but a real caption's label is followed by a title or nothing.
function isFigureMention(line: VisualLine): boolean {
  return /^\s*(?:figure|fig\.?)\s*[a-z]?\d+(?:[.,−–-]\d+)*(?!\d)\s*[.,;:](?!\d)/iu.test(line.text);
}

function isProse(line: VisualLine): boolean {
  return !isCaption(line) && (line.text.match(/[a-z]{2,}/giu)?.length ?? 0) >= 3;
}

// Characters Tesseract confuses in low-contrast scanned figure labels (P6.20 read as P8.20).
const OCR_CONFUSABLE = ["0odq", "1il|t7", "2z", "38b", "4a", "5s6", "68bg", "9gq"];

function ocrFigureIdentifierMatches(read: string, wanted: string): boolean {
  if (read.length !== wanted.length || read === wanted) return false;
  return [...wanted].every((character, index) => {
    const actual = read[index]!;
    return actual === character || OCR_CONFUSABLE.some(group => group.includes(character) && group.includes(actual));
  });
}

type VisualAnchor = { line: VisualLine; anchor: PdfCropAnchor };

function visualAnchor(lines: VisualLine[], query: string): VisualAnchor | null {
  const figure = figureIdentifier(query);
  if (figure) {
    // A mention in a question is not the figure caption. Also reject P4.1 when
    // P4.19 was requested, instead of letting substring/token scoring choose it.
    const labelled = lines.filter(line => isCaption(line) && figureIdentifier(line.text) === figure);
    const captions = labelled.length > 1 ? labelled.filter(line => !isFigureMention(line)) : labelled;
    if (labelled.length > 0) return captions.length === 1 ? { line: captions[0]!, anchor: "caption" } : null;
    // Otherwise accept one caption whose label differs only by OCR-confusable characters.
    const corrected = lines.filter(line => {
      const read = isCaption(line) && !isFigureMention(line) ? figureIdentifier(line.text) : null;
      return read !== null && ocrFigureIdentifierMatches(read, figure);
    });
    return corrected.length === 1 ? { line: corrected[0]!, anchor: "ocr-corrected-caption" } : null;
  }
  const number = problemNumberFromQuery(query);
  if (number) {
    const matches = problemStartLines(lines, number, /^\s*\d+[.)]\s*[a-z]/iu.test(query));
    return matches.length === 1 ? { line: matches[0]!, anchor: "problem-number" } : null;
  }
  // OCR often drops a decimal point or inserts spaces within a short unit label.
  const compact = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/gu, "");
  const exact = lines.filter(line => compact(line.text) === compact(query));
  if (exact.length > 0) return exact.length === 1 ? { line: exact[0]!, anchor: "label" } : null;
  const index = bestSemanticMatchIndex(lines.map(line => line.text), query);
  return index < 0 ? null : { line: lines[index]!, anchor: "label" };
}

function problemStartLines(lines: VisualLine[], number: string, requireLetters = false): VisualLine[] {
  return lines.filter(line => {
    if (requireLetters && !/[a-z]/iu.test(line.text)) return false;
    const start = line.text.replace(/^[^\p{L}\p{N}]+/u, "")
      .match(/^([\dIl]{1,4})(?:\s*[.)](?!\d)\s*|\s+|(?=m))/u)?.[1];
    return start?.replace(/[Il]/gu, "1") === number;
  });
}

// The printed start of a numbered problem. Handwritten answers such as "12) 120 m/s"
// also start with the number, so prefer the one line that reads like a printed prompt.
function problemAnchorLine(lines: VisualLine[], number: string): VisualLine | null {
  const matches = problemStartLines(lines, number);
  if (matches.length === 1) return matches[0]!;
  const prompts = matches.filter(isProse);
  return prompts.length === 1 ? prompts[0]! : null;
}

// Top of the next printed problem in the same column, which bounds this problem's region.
function nextProblemTop(page: VisualPage, lines: VisualLine[], anchor: VisualLine): number {
  const columnTolerance = page.width * 0.08;
  const tops = lines.filter(line => line.top > anchor.top + anchor.height &&
    Math.abs(line.left - anchor.left) <= columnTolerance && isProse(line) &&
    /^[^\p{L}\p{N}]*\d{1,4}\s*[.)](?!\d)/u.test(line.text)).map(line => line.top);
  return Math.min(page.height, ...tops);
}

function problemVisualRect(page: VisualPage, lines: VisualLine[], number: string, padding = 18): SemanticVisualMatch | null {
  const anchor = problemAnchorLine(lines, number);
  if (!anchor) return null;
  const rect = visualRectAtAnchor(page, lines, anchor, padding, nextProblemTop(page, lines, anchor));
  return rect ? { rect, anchor: "problem-number", anchorText: anchor.text } : null;
}

// A detection hint, not a crop: is there a sizeable drawing between this problem's start
// and the next problem in its column? Stricter sizes keep handwriting from counting.
function figureNearProblem(page: VisualPage, lines: VisualLine[], problemNumber: string): { caption: string | null } | null {
  const number = normalizeProblemNumber(problemNumber);
  if (!/^\d{1,4}[a-z]?$/u.test(number)) return null;
  const anchor = problemAnchorLine(lines, number);
  if (!anchor) return null;
  const bottom = Math.min(nextProblemTop(page, lines, anchor), anchor.top + page.height * 0.4);
  const [columnLeft, columnRight] = columnSpan(page, lines, anchor);
  const drawing = page.components.find(component => component.top > anchor.top + anchor.height &&
    component.top < bottom &&
    component.width >= page.width * 0.06 && component.height >= page.height * 0.04 &&
    component.width * component.height < page.width * page.height * 0.5 &&
    component.left < columnRight && component.left + component.width > columnLeft);
  if (!drawing) return null;
  const caption = lines.find(line => isCaption(line) && !isFigureMention(line) &&
    line.top >= anchor.top && line.top < bottom + page.height * 0.05 &&
    line.left < columnRight && line.left + line.width > columnLeft);
  return { caption: caption?.text.trim() ?? null };
}

// Horizontal extent of the anchor's column. OCR sometimes merges a line across both
// columns of a two-column page; clamp it to the anchor's half so the other column's
// drawings do not count.
function columnSpan(page: VisualPage, lines: VisualLine[], anchor: VisualLine): [number, number] {
  let left = anchor.left - page.width * 0.05;
  let right = anchor.left + anchor.width + page.width * 0.05;
  const prose = lines.filter(isProse);
  const leftColumn = prose.filter(line => line.left < page.width * 0.25 && line.width < page.width * 0.55).length;
  const rightColumn = prose.filter(line => line.left > page.width * 0.42 && line.left < page.width * 0.62).length;
  if (leftColumn >= 3 && rightColumn >= 3) {
    const middle = page.width / 2;
    if (anchor.left < middle - page.width * 0.1) right = Math.min(right, middle + page.width * 0.03);
    else left = Math.max(left, middle - page.width * 0.03);
  }
  return [left, right];
}

function visualRectAtAnchor(
  page: VisualPage,
  lines: VisualLine[],
  anchor: VisualLine,
  padding: number,
  // Graphics starting at or below this line belong to a later problem.
  limitTop = page.height,
): PixelRect | null {
  const { width, height, components } = page;
  const prose = lines.filter(isProse);
  const inside = (inner: PixelRect, outer: PixelRect) => inner.left >= outer.left - 2 && inner.top >= outer.top - 2 &&
    inner.left + inner.width <= outer.left + outer.width + 2 && inner.top + inner.height <= outer.top + outer.height + 2;
  const graphics = components.filter(c => c.width >= width * 0.025 && c.height >= height * 0.022 &&
    c.width * c.height < width * height * 0.6 && c.top < limitTop &&
    !prose.some(line => inside(c, line)));
  const caption = isCaption(anchor);
  const prompt = isProse(anchor) || Boolean(problemNumberFromQuery(anchor.text));
  const scored = graphics.map(graphic => {
    if (caption && graphic.top >= anchor.top - 3 && graphic.height < anchor.height * 2) return null;
    const gap = rectGap(graphic, anchor);
    // Captions normally follow their figure; prompts precede it. Labels inside
    // a figure can extend in every direction. Never constrain a figure to half a page.
    if (caption && graphic.top > anchor.top + anchor.height) return null;
    if (prompt && graphic.top + graphic.height < anchor.top + anchor.height) return null;
    if (gap.y > height * 0.16 || gap.x > width * 0.16) return null;
    const cx = Math.abs(graphic.left + graphic.width / 2 - anchor.left - anchor.width / 2);
    return { graphic, score: gap.y + gap.x * 1.5 + cx * 0.12 };
  }).filter((entry): entry is { graphic: InkComponent; score: number } => entry !== null)
    .sort((a, b) => a.score - b.score);
  if (!scored.length) return null;
  // An equidistant label between independent graphics is not a reliable selection.
  if (scored[1] && Math.abs(scored[1].score - scored[0]!.score) < width * 0.005 &&
      rectGap(scored[0]!.graphic, scored[1].graphic).x > width * 0.045) return null;
  const seed = scored[0]!.graphic;
  const selected: PixelRect[] = [seed];
  for (const graphic of graphics) {
    if (graphic === seed) continue;
    const gap = rectGap(seed, graphic);
    const overlap = Math.min(seed.top + seed.height, graphic.top + graphic.height) - Math.max(seed.top, graphic.top);
    // Adjacent panels (e.g. the nitrogen and oxygen spectra) form one visual.
    if (gap.x < width * 0.045 && overlap > Math.min(seed.height, graphic.height) * 0.7 &&
        Math.min(seed.height, graphic.height) > Math.max(seed.height, graphic.height) * 0.55) selected.push(graphic);
  }
  const body = unionRects(selected);
  // Recover disconnected tick labels, units, arrow labels, and caption text. Do not
  // recursively grow through adjacent paragraphs or other large illustrations.
  const nearby = Math.max(8, width * 0.035);
  const labels = lines.filter(line => !isProse(line) && !problemNumberFromQuery(line.text) &&
    line.width * line.height >= width * height * 0.000025 &&
    (!caption || line.top + line.height <= anchor.top + anchor.height + 3) &&
    rectGap(body, line).x <= nearby && rectGap(body, line).y <= nearby);
  if (caption) labels.push(anchor);
  if (prompt && !isProse(anchor)) {
    labels.push(anchor, ...lines.filter(line => !isProse(line) && line.top >= anchor.top &&
      line.top < anchor.top + anchor.height * 2.5 && rectGap(anchor, line).x === 0));
  }
  const accessories = components.filter(c => !graphics.includes(c) &&
    (!caption || c.top + c.height <= anchor.top + anchor.height + 3) &&
    !prose.some(line => inside(c, line)) &&
    (inside(c, body) || labels.some(line => inside(c, line)) ||
      (rectGap(body, c).x <= nearby && rectGap(body, c).y <= nearby)));
  const bounds = unionRects([...selected, ...accessories, ...labels]);
  // Clip padding to adjacent text without clipping the actual graphic.
  let topPadding = padding, bottomPadding = caption ? Math.min(padding, anchor.height * 0.4) : padding;
  let leftPadding = padding, rightPadding = padding;
  for (const line of lines) {
    if (!isProse(line) && !problemNumberFromQuery(line.text)) continue;
    if (rectGap(bounds, line).x > 0) continue;
    if (line.top >= bounds.top + bounds.height) bottomPadding = Math.min(bottomPadding, Math.max(0, line.top - bounds.top - bounds.height - 2));
    if (line.top + line.height <= bounds.top) topPadding = Math.min(topPadding, Math.max(0, bounds.top - line.top - line.height - 2));
  }
  for (const graphic of graphics) {
    if (selected.includes(graphic) || rectGap(bounds, graphic).y > 0) continue;
    if (graphic.left + graphic.width <= bounds.left) leftPadding = Math.min(leftPadding, Math.max(0, bounds.left - graphic.left - graphic.width - 2));
    if (graphic.left >= bounds.left + bounds.width) rightPadding = Math.min(rightPadding, Math.max(0, graphic.left - bounds.left - bounds.width - 2));
  }
  return clampPixelRect({ left: bounds.left - leftPadding, top: bounds.top - topPadding,
    width: bounds.width + leftPadding + rightPadding, height: bounds.height + topPadding + bottomPadding }, width, height);
}

type SemanticVisualMatch = { rect: PixelRect; anchor: PdfCropAnchor; anchorText: string };

function semanticVisualRect(page: VisualPage, lines: VisualLine[], query: string, padding = 18): SemanticVisualMatch | null {
  const found = visualAnchor(lines, query);
  const rect = found ? visualRectAtAnchor(page, lines, found.line, padding) : null;
  return found && rect ? { rect, anchor: found.anchor, anchorText: found.line.text } : null;
}

function cropAnchorNote(
  match: SemanticVisualMatch,
  region: { query: string; problemNumber?: string },
  fellBackToProblem: boolean,
): string | null {
  if (match.anchor === "ocr-corrected-caption") {
    return `Located at the scanned caption read as "${match.anchorText.trim()}", an OCR misreading of ${region.query}. Confirm the image shows the requested figure before attaching it.`;
  }
  if (fellBackToProblem) {
    return `${region.query} was not readable on this page, so this is the drawing inside problem ${region.problemNumber}'s region. Confirm the image shows the required visual before attaching it.`;
  }
  return null;
}

export async function semanticVisualRectFromImage(imagePath: string, lines: VisualLine[], query: string, padding = 18): Promise<PixelRect | null> {
  return semanticVisualRect(await analyzeVisualPage(imagePath), lines, query, padding)?.rect ?? null;
}

// Test hooks for the detection-only and problem-number paths.
export async function problemVisualRectFromImage(imagePath: string, lines: VisualLine[], problemNumber: string, padding = 18): Promise<PixelRect | null> {
  return problemVisualRect(await analyzeVisualPage(imagePath), lines, problemNumber, padding)?.rect ?? null;
}

export async function figureNearProblemFromImage(imagePath: string, lines: VisualLine[], problemNumber: string): Promise<{ caption: string | null } | null> {
  return figureNearProblem(await analyzeVisualPage(imagePath), lines, problemNumber);
}

function scaleAndClampRect(
  rect: { left: number; top: number; width: number; height: number },
  pageWidth: number,
  pageHeight: number,
  imageWidth: number,
  imageHeight: number,
  padding: number,
) {
  const scaleX = imageWidth / pageWidth;
  const scaleY = imageHeight / pageHeight;
  return clampPixelRect({
    left: Math.floor(rect.left * scaleX) - padding,
    top: Math.floor(rect.top * scaleY) - padding,
    width: Math.ceil(rect.width * scaleX) + padding * 2,
    height: Math.ceil(rect.height * scaleY) + padding * 2,
  }, imageWidth, imageHeight);
}

function clampPixelRect(
  rect: { left: number; top: number; width: number; height: number },
  imageWidth: number,
  imageHeight: number,
) {
  const left = Math.max(0, Math.min(imageWidth - 1, Math.round(rect.left)));
  const top = Math.max(0, Math.min(imageHeight - 1, Math.round(rect.top)));
  const right = Math.max(left + 1, Math.min(imageWidth, Math.round(rect.left + rect.width)));
  const bottom = Math.max(top + 1, Math.min(imageHeight, Math.round(rect.top + rect.height)));
  return { left, top, width: right - left, height: bottom - top };
}

function bestSemanticMatchIndex(texts: string[], query: string): number {
  let bestIndex = -1;
  let bestScore = 0;
  for (const [index, text] of texts.entries()) {
    const score = semanticMatchScore(text, query);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }
  return bestScore >= 0.58 ? bestIndex : -1;
}

function semanticMatchScore(text: string, query: string): number {
  const requestedProblem = problemNumberFromQuery(query);
  const lineProblem = detectProblemStarts(`${text}\n`)[0]?.number;
  if (requestedProblem && lineProblem && normalizeProblemNumber(lineProblem) === requestedProblem) return 1;

  const normalizedText = normalizeSearchText(text);
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedText || !normalizedQuery) return 0;
  if (normalizedText === normalizedQuery) {
    const letters = text.replace(/[^A-Za-z]+/gu, "");
    return letters.length > 0 && letters === letters.toLocaleUpperCase() ? 1.05 : 1;
  }
  if (
    normalizedText.length >= 4 && normalizedQuery.length >= 4 &&
    (normalizedText.includes(normalizedQuery) || normalizedQuery.includes(normalizedText))
  ) return 0.92;

  const queryTokens = semanticTokens(normalizedQuery);
  const textTokens = new Set(semanticTokens(normalizedText));
  if (queryTokens.length === 0 || textTokens.size === 0) return 0;
  const matched = queryTokens.filter((token) => textTokens.has(token)).length;
  const coverage = matched / queryTokens.length;
  const evidence = matched / Math.min(5, queryTokens.length);
  return coverage * 0.7 + evidence * 0.3;
}

function problemNumberFromQuery(query: string): string | null {
  const explicit = query.match(/\b(?:problem|question|exercise)\s*#?\s*(\d{1,4}[a-z]?)\b/iu)?.[1];
  // "12.0 m" and "65.0°" are labels, not problems 12 and 65.
  const leading = query.match(/^\s*(\d{1,4}[a-z]?)(?:\s*[.)\]:-](?!\d)|\s*$)/iu)?.[1];
  return explicit || leading ? normalizeProblemNumber(explicit ?? leading!) : null;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function semanticTokens(value: string): string[] {
  const ignored = new Set([
    "a", "an", "and", "complete", "for", "including", "of", "on", "page", "part", "parts",
    "problem", "question", "the", "through", "to", "with",
  ]);
  return [...new Set(value.split(" ").filter((token) => token.length > 1 && !ignored.has(token)))];
}

function isProblemStartLine(text: string): boolean {
  return detectProblemStarts(`${text}\n`).length > 0;
}

function normalizeProblemNumber(value: string): string {
  return value.toLocaleLowerCase().replace(/\b(?:problem|question|exercise)\b/g, "").replace(/[^a-z0-9]+/g, "");
}

function dedupeProblemMatches(matches: PdfProblemMatch[]): PdfProblemMatch[] {
  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = `${normalizeProblemNumber(match.problemNumber)}:${match.page}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function classifyPdfPageTextLayer(extractedCharacters: number): PdfInspection["textLayer"] {
  if (extractedCharacters >= 40) return "usable";
  if (extractedCharacters >= 8) return "sparse";
  return "none";
}

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function safeName(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "resource";
}

function safeExtension(value: string): string {
  const extension = extname(value).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ".bin";
}

function assertPdf(path: string) {
  if (extname(path).toLowerCase() !== ".pdf") throw new Error("This operation requires a PDF file.");
}

export function parsePdfPageCount(pdfInfo: string): number {
  const match = pdfInfo.match(/^Pages:\s+(\d+)\s*$/im);
  const pageCount = match ? Number.parseInt(match[1], 10) : 0;
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error("Could not determine the PDF page count.");
  }
  return pageCount;
}

export function classifyPdfTextLayer(extractedCharacters: number): PdfInspection["textLayer"] {
  if (extractedCharacters >= 80) return "usable";
  if (extractedCharacters >= 10) return "sparse";
  return "none";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
