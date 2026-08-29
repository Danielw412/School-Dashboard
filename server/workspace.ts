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
import { basename, extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import sharp from "sharp";

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

export class WorkspaceManager {
  private hits = 0;
  private misses = 0;

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
    const args = ["-layout"];
    if (page) args.push("-f", String(page), "-l", String(page));
    args.push(pdfPath, "-");
    try {
      const { stdout } = await execFileAsync("pdftotext", args, {
        encoding: "utf8",
        maxBuffer: 24 * 1024 * 1024,
        timeout: 60_000,
      });
      return stdout;
    } catch (error) {
      throw new Error(`PDF text extraction requires Poppler's pdftotext: ${errorMessage(error)}`);
    }
  }

  async inspectPdf(pdfPath: string): Promise<PdfInspection> {
    assertPdf(pdfPath);
    let pageCount: number;
    try {
      const { stdout } = await execFileAsync("pdfinfo", [pdfPath], {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        timeout: 30_000,
      });
      pageCount = parsePdfPageCount(stdout);
    } catch (error) {
      throw new Error(`PDF inspection requires Poppler's pdfinfo: ${errorMessage(error)}`);
    }

    const sampleEnd = Math.min(pageCount, 3);
    let sampleText: string;
    try {
      const { stdout } = await execFileAsync(
        "pdftotext",
        ["-f", "1", "-l", String(sampleEnd), pdfPath, "-"],
        {
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
          timeout: 30_000,
        },
      );
      sampleText = stdout;
    } catch (error) {
      throw new Error(`PDF inspection requires Poppler's pdftotext: ${errorMessage(error)}`);
    }

    const extractedCharacters = sampleText.replace(/\s+/g, "").length;
    const textLayer = classifyPdfTextLayer(extractedCharacters);
    const hasUsableTextLayer = textLayer === "usable";
    return {
      pageCount,
      textLayer,
      hasUsableTextLayer,
      primarilyScanned: !hasUsableTextLayer,
      recommendation: hasUsableTextLayer ? "text" : "vision",
      sampledPages: { start: 1, end: sampleEnd },
      extractedCharacters,
    };
  }

  async renderPdfPage(
    pdfPath: string,
    page: number,
    workspace: AssignmentWorkspace,
  ): Promise<string> {
    assertPdf(pdfPath);
    if (!Number.isInteger(page) || page < 1) throw new Error("PDF page must be at least 1.");
    const stem = safeName(basename(pdfPath, extname(pdfPath)));
    const outputStem = join(workspace.rendersPath, `${stem}-page-${page}`);
    try {
      await execFileAsync(
        "pdftoppm",
        ["-f", String(page), "-l", String(page), "-singlefile", "-png", "-r", "170", pdfPath, outputStem],
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
      metadata: { workspace: workspace.id, output: basename(destination) },
    });
    return destination;
  }

  async renderPdfPages(
    pdfPath: string,
    pages: number[],
    workspace: AssignmentWorkspace,
    concurrency = 4,
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
            path: await this.renderPdfPage(pdfPath, page, workspace),
          };
        }
      },
    );
    await Promise.all(workers);
    return results;
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
    const output = join(
      workspace.rendersPath,
      `${basename(source, extname(source))}-crop-${randomUUID().slice(0, 6)}.png`,
    );
    await sharp(source).extract(rect).png().toFile(output);
    return output;
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
