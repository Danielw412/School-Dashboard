# School Dashboard

School Dashboard is a separate, local-first companion to
[`Danielw412/Canvas-Task-Sync`](https://github.com/Danielw412/Canvas-Task-Sync). Task Sync remains the
system that discovers and reconciles schoolwork; this app reads its tracked-task API, navigates
Canvas coursework, and runs structured Codex workflows.

## What is included

- Incomplete work grouped by due date or class, backed by `GET /api/v1/tasks?completed=false`.
- Canvas directions, same-origin links, assignment metadata, external-assignment disclosure, and
  submission requirements.
- Exact problem extraction with Markdown/LaTeX, page-level provenance, Poppler PDF rendering, and
  optional image crops for diagrams or figures.
- Answer keys that accept only a completed problem-extraction result as their problem source.
- Focused study guides with teacher-stated scope separated from agent-inferred topics.
- GPT-5.6 Luna as the default Codex SDK model, plus Terra/Sol and per-feature reasoning controls.
- A Test Question Predictor adapter that reports `unavailable` unless a real local command is
  configured.
- Explicitly confirmed Canvas text, URL, and file submissions.
- Local settings, cache controls, recent runs, tool activity, Canvas requests, downloads, usage, raw
  structured output, and redacted errors.

## Setup

Requirements: Node.js 18+, the updated Canvas Task Sync server, and Poppler (`pdftotext` and
`pdftoppm`) for PDF workflows.

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Keep these values only in `.env`:

```dotenv
CANVAS_API_TOKEN=...
CANVAS_BASE_URL=https://school.instructure.com
TASK_SYNC_API_BASE=http://127.0.0.1:8790/api/v1
```

Start or restart Canvas Task Sync before the dashboard:

```powershell
Set-Location ..\Canvas-Task-Sync
.venv\Scripts\canvas-task-sync.exe web --no-open
```

Then open `http://127.0.0.1:5174`. `npm run build && npm start` serves the production bundle from
`http://127.0.0.1:8780`.

## Canvas agent scripts

This project deliberately uses scripts instead of an MCP server. Each agent run gets an isolated
temporary workspace containing `canvas-tool.mjs`, `CANVAS_TOOLS.md`, the tracked task, and its
deterministically resolved assignment context. Supported actions include:

```text
context / assignment / submission-requirements
search / modules / module-items / page / follow
file / download / pdf-text / pdf-render / image-crop
upload / submit (only with a separate explicit-confirmation capability)
```

The script calls a loopback-only internal endpoint with a short-lived scoped capability. The actual
Canvas token stays in the dashboard process and is redacted from persistent activity. Normal Codex
analysis runs receive read-only capabilities; submissions are performed only by the confirmation
dialog in the UI.

Downloaded files use a short-term cache under `.school-dashboard/cache`, then are copied into the
temporary assignment workspace. The workspace path lives under the operating system temporary
directory and is pruned according to local settings.

## Test Question Predictor

Set `TEST_QUESTION_PREDICTOR_COMMAND` in `.env` to a trusted local program that reads one JSON payload
from stdin and writes JSON to stdout. If the variable is absent, requested predictor runs are marked
unavailable and no historical questions are invented.

## Verification

```powershell
npm test
npm run build
npm run lint
```

Read-only live Canvas verification is safe. Submission tests are intentionally not run against a
real course.
