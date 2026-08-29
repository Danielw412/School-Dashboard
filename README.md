# School Dashboard

School Dashboard is a separate, local-first companion to
[`Danielw412/Canvas-Task-Sync`](https://github.com/Danielw412/Canvas-Task-Sync). Task Sync remains the
system that discovers and reconciles schoolwork; this app reads its tracked-task API, navigates
Canvas coursework, and runs structured Codex workflows.

## What is included

- Incomplete work grouped by due date or class, backed by `GET /api/v1/tasks?completed=false` and
  shown only when Google Tasks explicitly reports `needsAction`.
- A **Get Directions** workflow where Luna inspects the assignment, submission requirements,
  module neighborhood, and relevant Canvas resources, then produces a concise structured summary.
- Exact problem extraction with Markdown/LaTeX, page-level provenance, PDF text-layer inspection,
  batched Poppler rendering, and optional image crops for diagrams or figures.
- Answer keys that accept only a completed problem-extraction result as their problem source.
- Focused study guides with teacher-stated scope separated from agent-inferred topics.
- GPT-5.6 Luna as the default Codex SDK model, with xhigh reasoning by default for exact problem
  extraction, plus Terra/Sol and configurable reasoning controls.
- A Test Question Predictor adapter that reports `unavailable` unless a real local command is
  configured.
- Explicitly confirmed Canvas text, URL, and file submissions.
- Live per-run elapsed time and safe action summaries, plus local settings, cache controls, recent
  runs, Canvas requests, downloads, usage, raw structured output, and redacted errors. Private model
  reasoning text is neither requested nor persisted.

## Setup

Requirements: Node.js 18+, the updated Canvas Task Sync server, and Poppler (`pdfinfo`, `pdftotext`,
and `pdftoppm`) for PDF workflows.

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

To start the production dashboard automatically when you sign in to Windows, build it once and run
the installer from this project directory:

```powershell
npm run build
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-startup.ps1
```

The installer registers a hidden per-user scheduled task, starts it immediately, and creates a
`Homework Dashboard.url` desktop shortcut. The server stays on the loopback interface and writes
startup diagnostics to `.school-dashboard\web-startup.log`. To remove the scheduled task and
shortcut later:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\remove-windows-startup.ps1
```

## Structured Canvas and document tools

Each Luna run receives a short-lived, bearer-authenticated Streamable HTTP MCP connection to the
dashboard's assignment-scoped read-only tools. Canvas operations are structured calls, so Windows
shell quoting, JSON escaping, and PowerShell language mode are not part of the retrieval path.
The legacy loopback script endpoint remains available for compatibility, but Luna does not use it.
On Windows, that compatibility helper is invoked through `canvas-tool.ps1` with named parameters;
it builds the JSON request internally, so arguments containing spaces, quotes, punctuation, URLs,
or long search phrases never pass through PowerShell as JSON.
Supported operations include:

```text
recover Canvas context / follow direct Canvas link / focused search
page / file / module retrieval / cached download / batched Canvas reads
PDF index / batch text / local OCR / contact sheet / problem detection
batch render / batch crop / semantic PDF crop
```

When an already-known Canvas link points to an authenticated Google Doc or another course resource
that the Canvas API cannot read, Luna can ask the paired Canvas Task Sync Chrome extension for a
bounded readable capture. It cannot use the extension for browsing or discovery. Recent captures,
successful session reads, and structured authentication/access failures are reused within the run.
If the preloaded task and context already answer Directions, all further retrieval tools are hidden.

The actual Canvas token stays in the dashboard process and is redacted from persistent activity.
Codex runs in a read-only workspace and receives only the short-lived Canvas capability; submissions
are performed only by the confirmation dialog in the UI.

Downloaded files use a short-term cache under `.school-dashboard/cache`, then are copied into the
temporary assignment workspace. The workspace path lives under the operating system temporary
directory and is pruned according to local settings.

The initial PDF index records per-page text quality, structure, likely relevant pages, detected
problem numbers, and the cheapest reliable representation. Text, OCR, renders, contact sheets, and
crops are cached within the run. English OCR data is bundled locally, and multi-page rendering,
OCR, and cropping use bounded batching.

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
