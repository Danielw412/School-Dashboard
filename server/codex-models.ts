import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type { CodexModelInfo } from "./worker-protocol.js";

const require = createRequire(import.meta.url);

const TARGET_TRIPLES: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};

// The same bundled binary @openai/codex-sdk launches for every run.
export function resolveCodexBinary(): string {
  const key = `${process.platform}-${process.arch}`;
  const triple = TARGET_TRIPLES[key];
  if (!triple) throw new Error(`Codex does not ship a binary for ${key}.`);
  const codexRequire = createRequire(require.resolve("@openai/codex/package.json"));
  const vendorRoot = join(dirname(codexRequire.resolve(`@openai/codex-${key}/package.json`)), "vendor", triple);
  const binary = process.platform === "win32" ? "codex.exe" : "codex";
  for (const candidate of [join(vendorRoot, "bin", binary), join(vendorRoot, "codex", binary)]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`The bundled Codex binary for ${triple} is missing. Run npm install.`);
}

export function codexCliVersion(): string | null {
  try {
    const manifest = JSON.parse(readFileSync(require.resolve("@openai/codex/package.json"), "utf8"));
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

type RpcModel = {
  id?: unknown;
  model?: unknown;
  displayName?: unknown;
  hidden?: unknown;
  isDefault?: unknown;
  supportedReasoningEfforts?: unknown;
  defaultReasoningEffort?: unknown;
};

export function normalizeRpcModels(data: unknown): CodexModelInfo[] {
  if (!Array.isArray(data)) throw new Error("Codex model/list returned an unexpected response.");
  return data.flatMap((raw: RpcModel) => {
    const id = typeof raw.model === "string" ? raw.model : typeof raw.id === "string" ? raw.id : null;
    if (!id) return [];
    const efforts = Array.isArray(raw.supportedReasoningEfforts)
      ? raw.supportedReasoningEfforts.flatMap((effort: unknown) => {
          if (typeof effort === "string") return [effort];
          const value = (effort as { reasoningEffort?: unknown } | null)?.reasoningEffort;
          return typeof value === "string" ? [value] : [];
        })
      : [];
    return [{
      id,
      displayName: typeof raw.displayName === "string" ? raw.displayName : id,
      hidden: raw.hidden === true,
      isDefault: raw.isDefault === true,
      reasoningEfforts: efforts,
      defaultReasoningEffort: typeof raw.defaultReasoningEffort === "string" ? raw.defaultReasoningEffort : null,
    }];
  });
}

// Asks the local Codex app-server which models this installation and account can use, including
// hidden ones, over its JSON-RPC stdio protocol. Only the model catalog is requested.
export async function listCodexModels(options: { binary?: string; timeoutMs?: number } = {}): Promise<CodexModelInfo[]> {
  const binary = options.binary ?? resolveCodexBinary();
  const child = spawn(binary, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-2000);
  });
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    return await new Promise<CodexModelInfo[]>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Codex app-server did not list models within ${options.timeoutMs ?? 30_000} ms.`)),
        options.timeoutMs ?? 30_000,
      );
      let buffer = "";
      const models: unknown[] = [];
      const requestPage = (cursor: string | null) => send({
        id: 1,
        method: "model/list",
        params: { includeHidden: true, ...(cursor ? { cursor } : {}) },
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Codex app-server exited (${code}) before listing models. ${stderr.trim()}`.trim()));
      });
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let message: { id?: unknown; error?: { message?: string }; result?: { data?: unknown; nextCursor?: unknown } };
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.id === 0) {
            if (message.error) {
              clearTimeout(timer);
              reject(new Error(`Codex app-server rejected initialize: ${message.error.message ?? "unknown error"}`));
              return;
            }
            send({ method: "initialized" });
            requestPage(null);
          } else if (message.id === 1) {
            if (message.error) {
              clearTimeout(timer);
              reject(new Error(`Codex model/list failed: ${message.error.message ?? "unknown error"}`));
              return;
            }
            if (Array.isArray(message.result?.data)) models.push(...message.result.data);
            const nextCursor = message.result?.nextCursor;
            if (typeof nextCursor === "string" && nextCursor) {
              requestPage(nextCursor);
            } else {
              clearTimeout(timer);
              try {
                resolve(normalizeRpcModels(models));
              } catch (error) {
                reject(error);
              }
            }
          }
        }
      });
      send({
        id: 0,
        method: "initialize",
        params: { clientInfo: { name: "school_dashboard", title: "School Dashboard", version: "1.0.0" } },
      });
    });
  } finally {
    child.kill();
  }
}
