import { Router } from "express";
import { z } from "zod";

import type { WorkspaceManager } from "./workspace.js";

export function workspaceFilesRouter(workspaces: WorkspaceManager): Router {
  const router = Router();
  router.get("/:workspaceId/*path", async (request, response) => {
    const workspaceId = z.string().regex(/^[a-zA-Z0-9._-]+$/).parse(request.params.workspaceId);
    const rawPath = request.params.path;
    const requestedPath = Array.isArray(rawPath) ? rawPath.join("/") : String(rawPath ?? "");
    try {
      const filePath = await workspaces.resolveWorkspaceAsset(workspaceId, requestedPath);
      // The resolved, confined asset lives under .school-dashboard. Express
      // otherwise rejects it because an ancestor directory starts with a dot.
      response.sendFile(filePath, { dotfiles: "allow" });
    } catch {
      response.status(404).json({ error: "Workspace file not found." });
    }
  });
  return router;
}
