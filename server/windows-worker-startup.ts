import process from "node:process";

import { redirectOutputToLog } from "./startup-log.js";

redirectOutputToLog("Starting School Dashboard laptop agent worker.");

try {
  await import("./agent-worker.js");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
