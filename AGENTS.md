# AGENTS.md

## Mental model

School Dashboard is a local React + Express app layered on top of **Canvas Task Sync**. Task Sync remains the source of tracked schoolwork; this repo adds the student UI, direct Canvas access, temporary assignment workspaces, and structured Luna/Codex workflows.

Main flow:

`React UI -> /api -> TaskSyncClient / CanvasClient -> AgentRunner -> assignment workspace -> AgentExecutor (Codex turn) -> CanvasToolSessions (MCP) -> WorkspaceManager -> validated structured output -> UI`

The dashboard normally runs on a Linux server (`SCHOOL_DASHBOARD_AGENT_EXECUTION=worker`), and each Codex turn runs wherever the student's **Run agents on** switch points: on the Windows laptop, or on the server itself. `AgentExecutionRouter` picks the executor when a run starts (the choice persists in `AgentTargetStore`), and the run stays there even if the switch changes. For the laptop, `WorkerHub` queues the prepared turn and sends it over the laptop's outbound WebSocket to the agent worker, which runs it with the laptop's own `~/.codex` in a local copy of the run's seed files, calls the server's MCP endpoint over Tailscale, and streams compact events and the result back. For the server, `LocalCodexExecutor` runs the same turn in-process with the server's own `~/.codex`, in the server workspace, against the same MCP endpoint over loopback. Single-machine setups have only the local target.

Agent features are `directions`, `problemExtraction`, `answerKey`, and `studyGuide`. Answer keys are special: they may only consume a completed problem-extraction run for the same assignment.

Class directions are feature-scoped. When a relevant agent feature is added, add its own class-direction field through persistence, API/types, UI, and prompt selection instead of reusing another feature's directions.

## Where to look

- `src/App.tsx` — frontend routes.
- `src/pages/` — main screens: task list, assignment workspace, run history, settings/diagnostics.
- `src/api.ts` — frontend API boundary. `src/types.ts` mirrors data returned by the server.
- `src/components/` — shared shell/status/Markdown UI. `src/styles.css` contains most styling.
- `server/index.ts` — application composition and HTTP routes. Start here for request flow.
- `server/task-sync.ts` — typed client for Canvas Task Sync's canonical `/api/v1/tasks` and browser-resource APIs. Do not duplicate Task Sync's discovery/reconciliation/completion logic or Chrome capture broker here; `completed=false` intentionally includes only tasks whose live Google status is `needsAction`.
- `server/ssh-tunnel.ts` — supervised SSH tunnel used when `TASK_SYNC_SSH_TARGET` points at a Task Sync backend on a server. The local port must equal the backend port because Task Sync only accepts its own loopback `Host`.
- `server/canvas-client.ts` — Canvas API access, assignment resolution, course search, source-context recovery, HTML normalization, downloads/submissions.
- `server/agent-runner.ts` — Luna/Codex run lifecycle, feature schemas/prompts, model settings, workspace setup, structured-output validation. It hands the Codex turn to an `AgentExecutor`.
- `server/agent-execution.ts` / `server/codex-execution.ts` — executor interface and status, the in-process `LocalCodexExecutor` (concurrency limit, sign-in check), and the one Codex SDK invocation (`runCodexTurn`: read-only sandbox, feature flags, MCP overrides from the machine's `codex mcp list`, secret-free env) shared by server-side runs and the laptop worker.
- `server/agent-routing.ts` / `src/components/AgentTargetSwitch.tsx` — the server/laptop target switch: persisted selection, per-run routing, combined status, and the sidebar control (`GET`/`PUT /api/agent-execution`).
- `server/worker-hub.ts` (server) / `server/worker-client.ts` + `server/agent-worker.ts` (laptop) / `server/worker-protocol.ts` — laptop agent worker: WebSocket endpoint and auth, job queue and concurrency, reconnect grace and re-attachment, seed-file mirroring, event compaction, buffered results. Both sides validate every frame with the shared zod protocol.
- `server/model-catalog.ts` / `server/codex-models.ts` — the Codex app-server `model/list` reported by each machine that can run Codex, persisted on the server per target; the selected target's list decides which model IDs are selectable (built-ins plus a detected Luna Reserve).
- `server/network-access.ts` — loopback/Tailscale-only access, Host and cross-origin checks for the network-facing server.
- `server/tool-sessions.ts` — assignment-scoped MCP capability exposed to Luna. Defines tool policy, caching/retry limits, Canvas retrieval tools, and the PDF/image tool surface.
- `server/workspace.ts` — temporary workspaces, Canvas file cache, Poppler PDF inspection/text/rendering, OCR, problem detection, and cropping.
- `server/settings.ts` / `server/env.ts` — local configuration, models/prompts, paths, and environment variables.
- `server/activity.ts` / `server/agent-progress.ts` — redacted activity logging and user-facing run progress.
- `server/predictor.ts` — optional external Test Question Predictor adapter.
- `scripts/` — `deploy-server.ps1` (laptop -> server deploy), `linux/install-server.sh` + `deploy/linux/school-dashboard.service` (server systemd user service), `install-windows-worker.ps1` (laptop worker scheduled task), single-machine Windows startup helpers, and the legacy Canvas-tool compatibility CLI. Luna's normal retrieval path is MCP, not the script endpoint.
- `design/concepts/` — UI reference images, not runtime code.

Tests are generally colocated with the implementation as `*.test.ts` / `*.test.tsx`.

## Important boundaries

- Keep Canvas credentials in `.env`; never expose them to the browser, Luna workspace, persisted logs, or output.
- Luna runs are intentionally **read-only**, sandboxed to one temporary assignment workspace, and given only the short-lived `school_dashboard` MCP capability. Do not bypass this with shell, direct Canvas HTTP, browser tools, or extra MCP servers.
- `CanvasToolSessions` is the policy layer; `CanvasClient` performs Canvas operations; `WorkspaceManager` performs local document/image work. Add behavior at the correct layer rather than duplicating it elsewhere.
- Canvas Task Sync owns tracked-task identity/completion and the in-memory Chrome capture queue. Dashboard may request one already-known linked resource through Task Sync, but must not turn that bridge into browsing/discovery or persist captured browser content.
- Reuse preloaded context, direct identifiers/URLs, caches, and batched operations before adding broader searches or repeated retrieval.
- Keep PDF processing centralized in `WorkspaceManager`. The intended order is roughly: index -> cached text/contact sheet/problem detection -> targeted render/OCR -> semantic crop.
- Submissions are user-confirmed HTTP actions in `server/index.ts`; agent runs should not gain mutation access.
- The laptop worker never receives Canvas credentials: a job carries only the prompt, output schema, the run's seed files, and its short-lived MCP token. Server-side runs get the same treatment: Codex sees only the workspace and the MCP capability, never the dashboard's secrets. Keep Canvas/PDF/OCR work on the server behind MCP, keep Codex-specific behavior in `runCodexTurn` so both targets behave identically, and bump `WORKER_PROTOCOL_VERSION` for incompatible frame changes (server and laptop are updated separately).
- Server-side runs use the server's own Codex sign-in. Never copy the laptop's `~/.codex` or Codex sessions to the server, and do not expose the dashboard or worker endpoint beyond loopback and the tailnet.
- Persistent runtime data lives in `.school-dashboard/`; temporary run workspaces live under the OS temp directory. Neither is source code.
- When changing API shapes, update server validation/types and the corresponding frontend types/consumers together. If the Canvas Task Sync `/api/v1/tasks` or browser-resource contract changes, update both repositories.

## Run and verify

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Development UI: `http://127.0.0.1:5174`. Production server defaults to `http://127.0.0.1:8892` after `npm run build && npm start`. The deployed dashboard is `http://latitude7370:8892` (Tailscale); `npm run worker` runs the laptop agent worker in a terminal, and `scripts/deploy-server.ps1` ships changes to the server (see README, "Server + laptop deployment").

Before finishing a code change, run the relevant tests and normally all three checks:

```powershell
npm test
npm run build
npm run lint
```

PDF workflows also require Poppler (`pdfinfo`, `pdftotext`, `pdftoppm`), and normal operation expects the Canvas Task Sync server to be running.
