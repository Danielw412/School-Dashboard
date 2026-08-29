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
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import * as cheerio from "cheerio";
import sharp from "sharp";
import { createWorker } from "tesseract.js";
import englishOcrData from "@tesseract.js-data/eng";

import type { ActivityStore } from "./activity.js";
import type { CanvasClient, CanvasFile } from "./canvas-client.js";
import { CACHE_DIR, TEMP_WORKSPACE_ROOT } from "./env.js";
import type { AppSettings } from "./settings.js";

const execFileAsync = promisify(execFile);

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
  regions: Array<{ text: string; left: number; top: number; width: number; height: number }>;
};

export type PdfProblemMatch = {
  problemNumber: string;
  page: number;
  text: string;
  representation: "text" | "ocr";
  confidence: "high" | "medium" | "low";
};

export class WorkspaceManager {
  private hits = 0;
  private misses = 0;
  private readonly operationCache = new Map<string, Promise<unknown>>();

  constructor(private readonly activity: ActivityStore) {}

  async create(logicalId: string): Promise<AssignmentWorkspace> {
    await mkdir(TEMP_WORKSPACE_ROOT, { recursive: true });
    const id = `${safeName(logicalId).slice(0, 48)}-${randomUUID().slice(0, 8)}`;
    const path = join(TEMP_WORKSPACE_ROOT, id);
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
    const sourceRoot = safeChild(TEMP_WORKSPACE_ROOT, sourceWorkspaceId);
    const source = safeChild(sourceRoot, sourceRelativePath);
    const destination = safeChild(
      destinationWorkspace.resourcesPath,
      safeName(destinationName),
    );
    await copyFile(source, destination);
    return relative(destinationWorkspace.path, destination).replaceAll("\\", "/");
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
      const renders = await this.renderPdfPages(pdfPath, missing, workspace, 4, 220);
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
            const promise = worker.recognize(
              current.path,
              { rotateAuto: true },
              { text: true, blocks: true },
            ).then(({ data }) => ({
              page: current.page,
              text: data.text,
              confidence: data.confidence,
              regions: (data.blocks ?? []).map((block) => ({
                text: block.text,
                left: block.bbox.x0,
                top: block.bbox.y0,
                width: Math.max(1, block.bbox.x1 - block.bbox.x0),
                height: Math.max(1, block.bbox.y1 - block.bbox.y0),
              })),
            })).catch((error) => {
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
  ): Promise<{ matches: PdfProblemMatch[]; searchedPages: number[]; usedOcr: boolean }> {
    const index = await this.indexPdf(pdfPath, requestedProblems);
    const pages = selectedPages?.length
      ? [...new Set(selectedPages)]
      : Array.from({ length: index.pageCount }, (_value, page) => page + 1);
    const textPages = await this.extractPdfTextPages(pdfPath, pages);
    const textMatches = detectProblemMatches(
      textPages.map((entry) => ({ ...entry, representation: "text" as const, confidence: 100 })),
      requestedProblems,
    );
    const found = new Set(textMatches.map((match) => normalizeProblemNumber(match.problemNumber)));
    const requested = requestedProblems.map(normalizeProblemNumber).filter(Boolean);
    const needOcr = requested.length === 0 || requested.some((problem) => !found.has(problem));
    const ocrPages = needOcr
      ? pages.filter((page) => index.pages[page - 1]?.strategy !== "text").slice(0, 40)
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
    );
    return {
      matches: dedupeProblemMatches([...textMatches, ...ocrMatches]),
      searchedPages: pages,
      usedOcr: ocr.length > 0,
    };
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
    regions: Array<{ page: number; query: string; padding?: number }>,
    workspace: AssignmentWorkspace,
  ): Promise<Array<{ page: number; query: string; path: string; rect: { left: number; top: number; width: number; height: number }; basis: "text-layout" | "ocr-layout" }>> {
    if (regions.length === 0) throw new Error("Choose at least one semantic PDF region.");
    if (regions.length > 20) throw new Error("One semantic crop batch may contain at most 20 regions.");
    const pages = [...new Set(regions.map((region) => region.page))];
    const renders = await this.renderPdfPages(pdfPath, pages, workspace, 4, 170);
    const renderByPage = new Map(renders.map((render) => [render.page, render.path]));
    const layoutEntries = await Promise.all(pages.map(async (page) => [page, await this.extractPdfLayout(pdfPath, page)] as const));
    const layouts = new Map(layoutEntries);
    const results = [];
    for (const region of regions) {
      const renderPath = renderByPage.get(region.page)!;
      const metadata = await sharp(renderPath).metadata();
      const width = metadata.width ?? 1;
      const height = metadata.height ?? 1;
      const layout = layouts.get(region.page)!;
      let rect = semanticRectFromLines(layout.lines, region.query, layout.width, layout.height, width, height, region.padding);
      let basis: "text-layout" | "ocr-layout" = "text-layout";
      if (!rect) {
        const [ocr] = await this.ocrPdfPages(pdfPath, [region.page], workspace);
        rect = semanticRectFromRegions(ocr.regions, region.query, width, height, region.padding);
        basis = "ocr-layout";
      }
      if (!rect) throw new Error(`Could not locate a complete region for ${region.query} on page ${region.page}.`);
      results.push({
        page: region.page,
        query: region.query,
        rect,
        basis,
        path: await this.cropImage(relative(workspace.path, renderPath), rect, workspace),
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
      for (const entry of await readdir(TEMP_WORKSPACE_ROOT, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const path = join(TEMP_WORKSPACE_ROOT, entry.name);
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
): PdfProblemMatch[] {
  const wanted = new Set(requestedProblems.map(normalizeProblemNumber).filter(Boolean));
  const matches: PdfProblemMatch[] = [];
  for (const page of pages) {
    const starts = detectProblemStarts(page.text);
    for (let index = 0; index < starts.length; index += 1) {
      const start = starts[index];
      const normalized = normalizeProblemNumber(start.number);
      if (wanted.size > 0 && !wanted.has(normalized)) continue;
      const end = starts[index + 1]?.offset ?? page.text.length;
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

function detectProblemStarts(text: string): Array<{ number: string; offset: number }> {
  const starts: Array<{ number: string; offset: number }> = [];
  const pattern = /^(?:\s*(?:problem|question|exercise|review|example)\s*)?(\d{1,4}[a-z]?)(?:\s*[.)\]:-]|\s{2,})\s*\S/imug;
  for (const match of text.matchAll(pattern)) {
    starts.push({ number: match[1]!, offset: match.index ?? 0 });
  }
  return starts;
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

export function semanticRectFromLines(
  lines: PdfLayoutLine[],
  query: string,
  pageWidth: number,
  pageHeight: number,
  imageWidth: number,
  imageHeight: number,
  requestedPadding = 18,
): { left: number; top: number; width: number; height: number } | null {
  const startIndex = lines.findIndex((line) => lineMatchesProblemQuery(line.text, query));
  if (startIndex < 0) return null;
  const start = lines[startIndex]!;
  const leftColumn = start.xMin < pageWidth / 2;
  let endY = pageHeight;
  for (const line of lines.slice(startIndex + 1)) {
    const sameColumn = (line.xMin < pageWidth / 2) === leftColumn;
    if (sameColumn && isProblemStartLine(line.text)) {
      endY = line.yMin;
      break;
    }
  }
  const relevant = lines.filter((line) =>
    line.yMin >= start.yMin && line.yMin < endY &&
    (pageWidth < 500 || (line.xMin < pageWidth / 2) === leftColumn),
  );
  const xMin = pageWidth < 500 ? 0 : Math.max(0, Math.min(...relevant.map((line) => line.xMin)) - 18);
  const xMax = pageWidth < 500 ? pageWidth : Math.min(pageWidth, Math.max(...relevant.map((line) => line.xMax)) + 54);
  const yMin = Math.max(0, start.yMin - 18);
  const yMax = Math.min(pageHeight, Math.max(endY - 6, ...relevant.map((line) => line.yMax + 30)));
  return scaleAndClampRect({ left: xMin, top: yMin, width: xMax - xMin, height: yMax - yMin }, pageWidth, pageHeight, imageWidth, imageHeight, requestedPadding);
}

function semanticRectFromRegions(
  regions: PdfOcrPage["regions"],
  query: string,
  imageWidth: number,
  imageHeight: number,
  padding = 18,
): { left: number; top: number; width: number; height: number } | null {
  const startIndex = regions.findIndex((region) => lineMatchesProblemQuery(region.text, query));
  if (startIndex < 0) return null;
  const start = regions[startIndex]!;
  const next = regions.slice(startIndex + 1).find((region) => isProblemStartLine(region.text));
  const bottom = next?.top ?? Math.min(imageHeight, start.top + Math.max(start.height * 4, 400));
  const selected = regions.filter((region) => region.top >= start.top && region.top < bottom);
  const left = Math.max(0, Math.min(...selected.map((region) => region.left)) - padding);
  const right = Math.min(imageWidth, Math.max(...selected.map((region) => region.left + region.width)) + padding);
  const top = Math.max(0, start.top - padding);
  const finalBottom = Math.min(imageHeight, Math.max(bottom, ...selected.map((region) => region.top + region.height)) + padding);
  return clampPixelRect({ left, top, width: right - left, height: finalBottom - top }, imageWidth, imageHeight);
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

function lineMatchesProblemQuery(text: string, query: string): boolean {
  const normalizedQuery = normalizeProblemNumber(query);
  const lineProblem = detectProblemStarts(`${text}\n`)[0]?.number;
  return Boolean(lineProblem && normalizeProblemNumber(lineProblem) === normalizedQuery) ||
    text.toLocaleLowerCase().includes(query.toLocaleLowerCase());
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

export function safeChild(root: string, value: string): string {
  const destination = resolve(root, value);
  const normalizedRoot = `${resolve(root)}${sep}`;
  if (destination !== resolve(root) && !destination.startsWith(normalizedRoot)) {
    throw new Error("Workspace path escaped its assignment directory.");
  }
  return destination;
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
