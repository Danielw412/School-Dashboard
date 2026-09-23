import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { collectSourcePages } from "./source-pages.js";
import type { AssignmentWorkspace } from "./workspace.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspaceWith(pdfs: string[]): Promise<AssignmentWorkspace> {
  const path = await mkdtemp(join(tmpdir(), "school-source-pages-"));
  directories.push(path);
  const workspace = { id: "run", path, resourcesPath: join(path, "resources"), rendersPath: join(path, "renders") };
  await mkdir(workspace.resourcesPath);
  await Promise.all(pdfs.map((name) => writeFile(join(workspace.resourcesPath, name), "%PDF")));
  return workspace;
}

function fakeWorkspaces(pageCounts: Record<string, number>) {
  return {
    indexPdf: vi.fn(async (path: string) => ({ pageCount: pageCounts[path.split(/[\\/]/u).at(-1)!] ?? 1 })),
    renderSourcePages: vi.fn(async (path: string, pages: number[], workspace: AssignmentWorkspace) =>
      pages.map((page) => ({ page, path: join(workspace.path, "source-pages", `${path.split(/[\\/]/u).at(-1)}-${page}.jpg`) }))),
  } as never;
}

const cite = (sourceName: string, sourceUrl: string | null, page: number | null) =>
  ({ provenance: [{ sourceName, sourceUrl, page }], visual: null });

describe("collectSourcePages", () => {
  it("matches citations to downloaded PDFs by Canvas file ID, then by name", async () => {
    const workspace = await workspaceWith(["2110126-Unit-2-Circular-motion-packet.pdf", "2110077-Unit-2-Packet-1.pdf"]);
    const workspaces = fakeWorkspaces({ "2110126-Unit-2-Circular-motion-packet.pdf": 7, "2110077-Unit-2-Packet-1.pdf": 9 });

    const { documents, problemPages } = await collectSourcePages(workspaces, workspace, [
      cite("Circular packet", "https://canvas.example/courses/1/files/2110126/download", 2),
      cite("Unit 2 Packet 1.pdf", null, 5),
      cite("Directions page", null, null),
    ]);

    expect(documents.map((document) => [document.id, document.name, document.pages.length])).toEqual([
      ["document-2110077", "Unit 2 Packet 1.pdf", 9],
      ["document-2110126", "Circular packet", 7],
    ]);
    expect(problemPages).toEqual([
      [{ documentId: "document-2110126", page: 2 }],
      [{ documentId: "document-2110077", page: 5 }],
      [],
    ]);
  });

  it("keeps only cited pages and their neighbors from a long document", async () => {
    const workspace = await workspaceWith(["55-Chapter-5.pdf"]);
    const workspaces = fakeWorkspaces({ "55-Chapter-5.pdf": 60 });

    const { documents } = await collectSourcePages(workspaces, workspace, [
      cite("Chapter 5", null, 12),
      { provenance: [], visual: { path: "renders/55-Chapter-5-page-40-170dpi-crop-1.png", page: 40 } },
    ]);

    expect(documents[0]!.pages.map((page) => page.page)).toEqual([11, 12, 13, 39, 40, 41]);
  });

  it("returns nothing when the run downloaded no PDF", async () => {
    const workspace = await workspaceWith([]);
    const result = await collectSourcePages(fakeWorkspaces({}), workspace, [cite("Canvas page", null, 1)]);

    expect(result).toEqual({ documents: [], problemPages: [[]] });
  });
});
