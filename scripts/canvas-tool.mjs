#!/usr/bin/env node

// This client is copied into each temporary assignment workspace. The dashboard server grants it
// a short-lived, assignment-scoped capability; the Canvas bearer token never enters the workspace.
const token = process.env.SCHOOL_DASHBOARD_TOOL_TOKEN;
const endpoint = process.env.SCHOOL_DASHBOARD_TOOL_URL ??
  "http://127.0.0.1:8780/api/internal/canvas-tools";
const action = process.argv[2];

if (!token) throw new Error("SCHOOL_DASHBOARD_TOOL_TOKEN is unavailable outside a scoped agent run.");
if (!action) throw new Error("Usage: node canvas-tool.mjs <action> ['{\"key\":\"value\"}']");

const input = process.argv[3] ? JSON.parse(process.argv[3]) : {};
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
