import { spawn } from "node:child_process";

import { env } from "./env.js";

export type PredictorResult =
  | { requested: false; status: "disabled"; message: string; output: null }
  | { requested: true; status: "unavailable"; message: string; output: null }
  | { requested: true; status: "available"; message: string; output: unknown };

export async function runTestQuestionPredictor(
  requested: boolean,
  context: unknown,
): Promise<PredictorResult> {
  if (!requested) {
    return { requested: false, status: "disabled", message: "Test Question Predictor was not requested.", output: null };
  }
  if (!env.predictorCommand.trim()) {
    return {
      requested: true,
      status: "unavailable",
      message: "Test Question Predictor is not configured in this runtime.",
      output: null,
    };
  }
  try {
    const output = await runCommand(env.predictorCommand, JSON.stringify(context));
    return {
      requested: true,
      status: "available",
      message: "Test Question Predictor output was incorporated as a separate evidence source.",
      output: parseMaybeJson(output),
    };
  } catch (error) {
    return {
      requested: true,
      status: "unavailable",
      message: `Test Question Predictor could not run: ${error instanceof Error ? error.message : "unknown error"}`,
      output: null,
    };
  }
}

function runCommand(command: string, stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: sanitizedEnvironment(),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("predictor timed out after 60 seconds"));
    }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(Buffer.concat(stderr).toString("utf8").slice(0, 500) || `exit ${code}`));
    });
    child.stdin.end(stdin);
  });
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/(CANVAS|GOOGLE|GEMINI|TOKEN|SECRET|PASSWORD|COOKIE|API_KEY)/i.test(key)),
  );
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value.trim();
  }
}
