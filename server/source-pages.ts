import { readdir } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";

import { z } from "zod";

import type { AssignmentWorkspace, WorkspaceManager } from "./workspace.js";

// Full source pages saved with a problem extraction. The student opens them when a crop is
// missing or wrong, and the answer-key run reads them to recover what a crop left out.
export const sourcePageRefSchema = z.object({
  documentId: z.string(),
  page: z.number().int().positive(),
});

export const sourceDocumentSchema = z.object({
  id: z.string(),
  name: z.string(),
  pageCount: z.number().int().positive(),
  pages: z.array(z.object({ page: z.number().int().positive(), path: z.string() })),
});

export type SourcePageRef = z.infer<typeof sourcePageRefSchema>;
export type SourceDocument = z.infer<typeof sourceDocumentSchema>;

type ProblemSources = {
  provenance: Array<{ sourceName: string; sourceUrl: string | null; page: number | null }>;
  visual: { path: string; page: number } | null;
};

// A short worksheet packet is kept whole; for longer files only the cited pages and their
// neighbors are kept, so a textbook chapter does not become dozens of page images.
const WHOLE_DOCUMENT_PAGES = 20;
const MAX_DOCUMENT_PAGES = 30;

type WorkspacePdf = { path: string; fileId: string | null; stem: string; normalizedName: string };

export async function collectSourcePages(
  workspaces: Pick<WorkspaceManager, "indexPdf" | "renderSourcePages">,
  workspace: AssignmentWorkspace,
  problems: ProblemSources[],
): Promise<{ documents: SourceDocument[]; problemPages: SourcePageRef[][] }> {
  const pdfs = await workspacePdfs(workspace);
  const names = new Map<WorkspacePdf, string>();
  const references = problems.map((problem) => {
    const pages: Array<{ pdf: WorkspacePdf; page: number }> = [];
    for (const item of problem.provenance) {
      const pdf = item.page ? matchPdf(pdfs, item.sourceName, item.sourceUrl) : null;
      if (!pdf || !item.page) continue;
      pages.push({ pdf, page: item.page });
      if (!names.has(pdf) && item.sourceName.trim()) names.set(pdf, item.sourceName.trim());
    }
    if (problem.visual) {
      // Renders and crops are named after the PDF they came from.
      const visualName = basename(problem.visual.path);
      const pdf = pdfs.find((candidate) => visualName.startsWith(`${candidate.stem}-page-`)) ??
        (pdfs.length === 1 ? pdfs[0] : undefined);
      if (pdf) pages.unshift({ pdf, page: problem.visual.page });
    }
    return pages;
  });

  const documents: SourceDocument[] = [];
  const documentIds = new Map<WorkspacePdf, string>();
  for (const [index, pdf] of pdfs.entries()) {
    const cited = references.flat().filter((reference) => reference.pdf === pdf).map((reference) => reference.page);
    if (cited.length === 0) continue;
    const { pageCount } = await workspaces.indexPdf(pdf.path);
    const wanted = pageCount <= WHOLE_DOCUMENT_PAGES
      ? Array.from({ length: pageCount }, (_value, page) => page + 1)
      : [...new Set(cited.flatMap((page) => [page - 1, page, page + 1]))]
        .filter((page) => page >= 1 && page <= pageCount)
        .sort((left, right) => left - right)
        .slice(0, MAX_DOCUMENT_PAGES);
    if (wanted.length === 0) continue;
    const renders = await workspaces.renderSourcePages(pdf.path, wanted, workspace);
    const id = `document-${pdf.fileId ?? index + 1}`;
    documentIds.set(pdf, id);
    documents.push({
      id,
      name: names.get(pdf) ?? displayName(pdf.path),
      pageCount,
      pages: renders.map((render) => ({
        page: render.page,
        path: relative(workspace.path, render.path).replaceAll("\\", "/"),
      })),
    });
  }

  const problemPages = references.map((pages) => {
    const seen = new Set<string>();
    return pages.flatMap(({ pdf, page }) => {
      const documentId = documentIds.get(pdf);
      const document = documents.find((item) => item.id === documentId);
      const key = `${documentId}:${page}`;
      if (!documentId || !document?.pages.some((item) => item.page === page) || seen.has(key)) return [];
      seen.add(key);
      return [{ documentId, page }];
    });
  });
  return { documents, problemPages };
}

async function workspacePdfs(workspace: AssignmentWorkspace): Promise<WorkspacePdf[]> {
  let entries: string[];
  try {
    entries = await readdir(workspace.resourcesPath);
  } catch {
    return [];
  }
  return entries
    .filter((name) => extname(name).toLowerCase() === ".pdf")
    .sort()
    .map((name) => {
      const stem = basename(name, extname(name));
      // Canvas downloads are saved as "<file id>-<display name>".
      const fileId = stem.match(/^(\d+)-/u)?.[1] ?? null;
      return {
        path: join(workspace.resourcesPath, name),
        fileId,
        stem,
        normalizedName: normalizeName(fileId ? stem.slice(fileId.length + 1) : stem),
      };
    });
}

function matchPdf(pdfs: WorkspacePdf[], sourceName: string, sourceUrl: string | null): WorkspacePdf | null {
  const fileId = sourceUrl?.match(/\/files\/(\d+)/u)?.[1];
  const byId = fileId ? pdfs.find((pdf) => pdf.fileId === fileId) : undefined;
  if (byId) return byId;
  const name = normalizeName(sourceName);
  const byName = name.length >= 4
    ? pdfs.filter((pdf) => pdf.normalizedName.length >= 4 &&
      (pdf.normalizedName.includes(name) || name.includes(pdf.normalizedName)))
    : [];
  if (byName.length === 1) return byName[0]!;
  return pdfs.length === 1 ? pdfs[0]! : null;
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/\.pdf$/u, "").replace(/[^a-z0-9]+/gu, "");
}

function displayName(path: string): string {
  const stem = basename(path, extname(path)).replace(/^\d+-/u, "");
  return `${stem.replaceAll("-", " ")}.pdf`;
}
