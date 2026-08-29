#!/usr/bin/env node

import { readFile } from "node:fs/promises";

// This client is copied into each temporary assignment workspace. The dashboard server grants it
// a short-lived, assignment-scoped capability; the Canvas bearer token never enters the workspace.
const token = process.env.SCHOOL_DASHBOARD_TOOL_TOKEN;
const endpoint = process.env.SCHOOL_DASHBOARD_TOOL_URL ??
  "http://127.0.0.1:8780/api/internal/canvas-tools";
const action = process.argv[2];

if (!token) throw new Error("SCHOOL_DASHBOARD_TOOL_TOKEN is unavailable outside a scoped agent run.");
if (!action) {
  throw new Error(
    "Usage: canvas-tool.ps1 -Action <action> [-Query <text>] [-Url <url>] or node canvas-tool.mjs <action> --input-file <json-path>.",
  );
}

const input = await parseInput(process.argv.slice(3));
const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-school-tool-token": token,
  },
  body: JSON.stringify({ action, input }),
});
const text = await response.text();
if (!response.ok) throw new Error(text);
process.stdout.write(`${text}\n`);

async function parseInput(args) {
  if (args.length === 0) return {};
  if (args.length === 1 && args[0] === "--input-env") return inputFromEnvironment();
  // Preserve the original JSON argument for compatibility, but make the Windows-safe named/file
  // forms the documented path so PowerShell never has to preserve a JSON object through quoting.
  if (args.length === 1 && /^[\[{]/u.test(args[0].trim())) {
    try {
      return requireObject(JSON.parse(args[0]));
    } catch (error) {
      throw new Error(`Legacy JSON input could not be parsed. Use canvas-tool.ps1 named parameters or --input-file. ${error.message}`);
    }
  }
  let input = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--input-file") {
      const path = requireOptionValue(args, ++index, option);
      input = { ...input, ...requireObject(JSON.parse(await readFile(path, "utf8"))) };
      continue;
    }
    if (option === "--input-stdin") {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      input = { ...input, ...requireObject(JSON.parse(Buffer.concat(chunks).toString("utf8"))) };
      continue;
    }
    if (!option.startsWith("--")) {
      throw new Error(`Unexpected argument ${option}. Use named options such as --query, --url, or --input-file.`);
    }
    const name = option.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    const rawValue = requireOptionValue(args, ++index, option);
    const value = parseOptionValue(name, rawValue);
    if (input[name] === undefined) input[name] = value;
    else input[name] = [...(Array.isArray(input[name]) ? input[name] : [input[name]]), value];
  }
  return input;
}

async function inputFromEnvironment() {
  const names = (process.env.SCHOOL_DASHBOARD_TOOL_INPUT_NAMES ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  const input = {};
  for (const name of names) {
    const environmentName = `SCHOOL_DASHBOARD_TOOL_INPUT_${name.replace(/([a-z])([A-Z])/gu, "$1_$2").toUpperCase()}`;
    const rawValue = process.env[environmentName];
    if (rawValue === undefined) throw new Error(`Windows helper input ${name} is missing.`);
    if (name === "InputFile") {
      Object.assign(input, requireObject(JSON.parse(await readFile(rawValue, "utf8"))));
      continue;
    }
    const inputName = name[0].toLowerCase() + name.slice(1);
    input[inputName] = parseOptionValue(inputName, rawValue);
  }
  return input;
}

function requireOptionValue(args, index, option) {
  const value = args[index];
  if (value === undefined) throw new Error(`${option} requires a value.`);
  return value;
}

function requireObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Canvas tool input must be a JSON object.");
  }
  return value;
}

function parseOptionValue(name, value) {
  if (name === "pages" || name === "problemNumbers") {
    return value.split(",").map((part) => part.trim()).filter(Boolean).map((part) =>
      name === "pages" && /^\d+$/u.test(part) ? Number(part) : part);
  }
  if (["page", "fileId", "moduleId", "topicId", "quizId", "dpi"].includes(name) && /^\d+$/u.test(value)) {
    return Number(value);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}
