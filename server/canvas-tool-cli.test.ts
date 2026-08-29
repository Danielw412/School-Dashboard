import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { APP_ROOT } from "./env.js";

const execFileAsync = promisify(execFile);

describe.skipIf(process.platform !== "win32")("Canvas helper PowerShell invocation", () => {
  it.each([
    "revision instructions",
    "chapter 4, problems 1-9 (odd only); bring notes!",
    'Teacher said "use the revised draft" and don\'t omit citations.',
    "https://canvas.example.edu/courses/42/pages/week-3?module_item_id=91&view=full#revision",
    `A deliberately long focused search: ${"vectors, diagrams, and written justification; ".repeat(24)}final copy`,
  ])("preserves one named query without JSON quoting: %s", async (query) => {
    let observed: unknown = null;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      observed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Canvas helper test server did not bind.");
    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        `${APP_ROOT}\\scripts\\canvas-tool.ps1`,
        "-Action",
        "search",
        "-Query",
        query,
      ], {
        env: {
          ...process.env,
          SCHOOL_DASHBOARD_TOOL_TOKEN: "test-capability",
          SCHOOL_DASHBOARD_TOOL_URL: `http://127.0.0.1:${address.port}/canvas-tools`,
        },
        timeout: 20_000,
      });
      expect(JSON.parse(stdout)).toEqual({ ok: true });
      expect(observed).toEqual({ action: "search", input: { query } });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
