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
- GPT-6 Luna as the default Codex SDK model, with xhigh reasoning by default for exact problem
  extraction, plus GPT-6 Sol, GPT-5.6 Sol, and configurable reasoning controls. Saved GPT-5.6
  Luna/Terra preferences migrate to GPT-6 Luna; historical runs retain their original model IDs.
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
TASK_SYNC_API_BASE=http://127.0.0.1:8890/api/v1
```

Start or restart Canvas Task Sync before the dashboard:

```powershell
Set-Location ..\Canvas-Task-Sync
.venv\Scripts\canvas-task-sync.exe web --no-open
```

### Canvas Task Sync on a server

When Task Sync's authoritative backend runs on a server (its split deployment, bound to
`127.0.0.1:8790` there), point the dashboard at it by SSH target instead of URL:

```dotenv
TASK_SYNC_SSH_TARGET=daniel@100.87.157.44
TASK_SYNC_REMOTE_PORT=8790
```

The dashboard server then keeps its own `ssh -L 127.0.0.1:8790:127.0.0.1:8790` tunnel open,
reconnecting with backoff when the laptop sleeps or changes networks, and ignores
`TASK_SYNC_API_BASE` and the saved connection URL. It does not need Task Sync's laptop dashboards
to be running. The local port matches the backend's port on purpose: Task Sync accepts only its own
loopback `Host`, and Node's `fetch` cannot rewrite that header, so port `8790` must be free on this
machine. Remove `TASK_SYNC_SSH_TARGET` to go back to a local Task Sync.

The tunnel runs non-interactively (`BatchMode`), so key-based SSH login must already work. Run
`ssh daniel@100.87.157.44` once by hand to accept the host key. Tunnel state and SSH errors appear
under **Settings -> Connections & diagnostics**.

Linked-resource reads through the Chrome extension still travel through Task Sync: the extension
must stay paired with Task Sync's laptop dashboards (`scripts\start-remote-dashboards.ps1` or its
startup task), and those need to point at the same server.

Then open `http://127.0.0.1:5174`. `npm run build && npm start` serves the production bundle from
`http://127.0.0.1:8892`.

## Server + laptop deployment

The dashboard can run permanently on a Linux server while every Codex run still happens on the
Windows laptop:

```text
browser (any tailnet device) ──HTTP──► Linux server: UI, API, run history, job queue,
                                        Canvas + Task Sync access, PDF/OCR tools, MCP endpoint
                                              ▲                        ▲
                         outbound WebSocket   │                        │ per-run MCP calls
                         (jobs down, events   │                        │ (short-lived token)
                          and results up)     │                        │
                                        Windows laptop: agent worker ──► Codex (laptop ~/.codex)
```

- **Server** (`SCHOOL_DASHBOARD_AGENT_EXECUTION=worker`): prepares each run exactly as before
  (Canvas context, preflight, workspace seed files, short-lived tool capability), queues it, and
  sends it to the laptop worker. It never launches Codex. Run history, class directions, settings,
  and saved problem visuals live in the server's `.school-dashboard/`.
- **Laptop worker** (`npm run worker`): keeps one outbound WebSocket to
  `/api/agent-worker/connect`, copies the run's seed files into a local workspace under
  `%TEMP%\school-dashboard-worker-workspaces\<workspace id>`, and runs Codex there with the
  laptop's own `~/.codex` (auth, sessions, config). Codex calls the server's assignment-scoped MCP
  tools over the tailnet; tool payloads such as page images stay on the laptop, and only compact
  events plus the final structured result go back. The laptop needs no Canvas token.
- Each run records the Codex `threadId` from the laptop and the `workspaceId` shared by the server
  workspace and the laptop copy. Cancelling in the dashboard cancels that exact Codex job.
- **Disconnects:** jobs keep running through short drops; the worker buffers events and re-sends
  the final result until the server acknowledges it. The server waits two minutes for the worker
  to reconnect before failing an in-flight run, and tells a reconnecting worker to stop runs the
  server no longer tracks (for example after a server restart). While the laptop is offline the
  dashboard stays up, shows **Agents unavailable**, disables agent actions, and returns HTTP 503
  for new runs.
- **Network:** the server listens on `0.0.0.0` but only answers loopback and Tailscale peers
  (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`); LAN and public clients get 403. It also rejects
  unknown `Host` headers (DNS rebinding) and cross-origin writes. The worker authenticates with
  `SCHOOL_DASHBOARD_WORKER_TOKEN`, and Tailscale encrypts the connection. No port is opened
  publicly; `https://`/`wss://` URLs work too if you put the server behind `tailscale serve`.

First deployment from the laptop (SSH key login to the server must already work, as it does for
the Task Sync tunnel):

```powershell
npm install
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-server.ps1 -MigrateData
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-worker.ps1
```

`deploy-server.ps1` uploads the working tree to `~/projects/School-Dashboard` on the server
(default target: `TASK_SYNC_SSH_TARGET`; override with `-Server user@host`), creates the server
`.env` once from this laptop's Canvas settings with a fresh worker token, and runs
`scripts/linux/install-server.sh`. That script installs a checksum-verified user-local Node.js
when the system one is too old, runs `npm ci` and `npm run build`, and installs the systemd user
service `school-dashboard.service` (from `deploy/linux/school-dashboard.service`), which starts at
boot when lingering is enabled (`sudo loginctl enable-linger $USER`). `-MigrateData` copies run
history, activity, class directions, settings, and saved visuals once; it refuses to overwrite
existing server history without `-Force`. Rerun `deploy-server.ps1` (without `-MigrateData`) to
ship updates; it keeps the server `.env`.

`install-windows-worker.ps1` registers the hidden **Homework Dashboard Agent Worker** task (starts
at sign-in, restarts on failure), replaces the old all-in-one **Homework Dashboard Web** task
(pass `-KeepLocalDashboard` to keep it), points the desktop shortcut at the server, and waits until
the server reports the worker connected. `-Uninstall` removes the worker task.

Useful commands:

```bash
systemctl --user status school-dashboard      # on the server
journalctl --user -u school-dashboard -f
```

The worker logs to `.school-dashboard\agent-worker.log` on the laptop. **Settings -> Connections &
diagnostics** shows the worker, its Codex version, and running/queued jobs.

### Models and Luna Reserve

The machine that runs Codex (the laptop worker, or this process in local mode) reports its Codex
app-server `model/list`, including hidden models, when it connects and every 30 minutes;
**Settings -> Check again** asks for a fresh list. A model whose ID or display name names Luna
Reserve (for example `gpt-6-luna-reserve`) becomes selectable under exactly the ID Codex reports.
Nothing else is assumed to be Luna Reserve. Settings shows why it is unavailable otherwise.

## Single-machine mode

Leave `SCHOOL_DASHBOARD_AGENT_EXECUTION` and `SCHOOL_DASHBOARD_HOST` unset to run everything on the
laptop as before (loopback only, Codex in-process).

To start the production dashboard automatically when you sign in to Windows, build it once and run
the installer from this project directory:

```powershell
npm run build
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-startup.ps1
```

The installer registers a hidden per-user scheduled task, starts it immediately, and creates a
`Homework Dashboard.url` desktop shortcut. The server runs windowlessly on the loopback interface
and writes startup diagnostics to `.school-dashboard\web-startup.log`. To remove the scheduled
task and shortcut later:

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
