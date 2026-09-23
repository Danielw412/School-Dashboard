import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

// Windowless scheduled-task launches have no console; send stdout/stderr to --log-path instead.
export function redirectOutputToLog(startupMessage: string): void {
  const flagIndex = process.argv.indexOf("--log-path");
  const logPath = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
  if (!logPath) {
    throw new Error("The Windows startup entry point requires --log-path.");
  }
  mkdirSync(dirname(logPath), { recursive: true });

  const logStream = createWriteStream(logPath, { flags: "a", encoding: "utf8" });
  const writeLog = logStream.write.bind(logStream) as typeof process.stdout.write;
  process.stdout.write = writeLog;
  process.stderr.write = writeLog;

  process.stdout.write(`[${new Date().toISOString()}] ${startupMessage}\n`);
}
