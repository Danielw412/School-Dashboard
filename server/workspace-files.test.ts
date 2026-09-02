import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";
import sharp from "sharp";
import request from "supertest";
import { expect, it, vi } from "vitest";

import type { ActivityStore } from "./activity.js";
import { WorkspaceManager } from "./workspace.js";
import { workspaceFilesRouter } from "./workspace-files.js";

it("serves preserved PNGs from the hidden data directory after temporary files expire", async () => {
  const root = await mkdtemp(join(tmpdir(), "school-assets-http-"));
  try {
    const manager = new WorkspaceManager(
      { record: vi.fn() } as unknown as ActivityStore,
      join(root, "temporary"),
      join(root, ".school-dashboard", "workspace-assets"),
    );
    const workspace = await manager.create("extraction");
    const image = await sharp({ create: { width: 10, height: 10, channels: 3, background: "white" } }).png().toBuffer();
    await writeFile(join(workspace.rendersPath, "figure #3.png"), image);
    const app = express().use("/workspace-files", workspaceFilesRouter(manager));
    const url = `/workspace-files/${workspace.id}/renders/figure%20%233.png`;
    expect((await request(app).get(url).expect(200).expect("Content-Type", /image\/png/)).body).toEqual(image);

    await manager.preserveWorkspaceAssets(workspace.id, ["renders/figure #3.png"]);
    const old = new Date(Date.now() - 48 * 3_600_000);
    await utimes(workspace.path, old, old);
    expect(await manager.pruneWorkspaces(24)).toBe(1);
    expect((await request(app).get(url).expect(200).expect("Content-Type", /image\/png/)).body).toEqual(image);
    await request(app).get(`/workspace-files/${workspace.id}/renders/missing.png`).expect(404);
    await request(app).get(`/workspace-files/${workspace.id}/..%2F..%2Fsecret.env`).expect(404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
