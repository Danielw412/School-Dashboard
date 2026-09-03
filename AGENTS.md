# AGENTS.md

## Mental model

School Dashboard is a local React + Express app layered on top of **Canvas Task Sync**. Task Sync remains the source of tracked schoolwork; this repo adds the student UI, direct Canvas access, temporary assignment workspaces, and structured Luna/Codex workflows.

Main flow:

`React UI -> /api -> TaskSyncClient / CanvasClient -> AgentRunner -> assignment workspace -> CanvasToolSessions (MCP) -> WorkspaceManager -> validated structured output -> UI`

Agent features are `directions`, `problemExtraction`, `answerKey`, and `studyGuide`. Answer keys are special: they may only consume a completed problem-extraction run for the same assignment.

Class directions are feature-scoped. When a relevant agent feature is added, add its own class-direction field through persistence, API/types, UI, and prompt selection instead of reusing another feature's directions.

## Where to look

- `src/App.tsx` — frontend routes.
- `src/pages/` — main screens: task list, assignment workspace, run history, settings/diagnostics.
- `src/api.ts` — frontend API boundary. `src/types.ts` mirrors data returned by the server.
- `src/components/` — shared shell/status/Markdown UI. `src/styles.css` contains most styling.
- `server/index.ts` — application composition and HTTP routes. Start here for request flow.
- `server/task-sync.ts` — typed client for Canvas Task Sync's canonical `/api/v1/tasks` and browser-resource APIs. Do not duplicate Task Sync's discovery/reconciliation/completion logic or Chrome capture broker here; `completed=false` intentionally includes only tasks whose live Google status is `needsAction`.
- `server/canvas-client.ts` — Canvas API access, assignment resolution, course search, source-context recovery, HTML normalization, downloads/submissions.
- `server/agent-runner.ts` — Luna/Codex run lifecycle, feature schemas/prompts, model settings, workspace setup, structured-output validation.
- `server/tool-sessions.ts` — assignment-scoped MCP capability exposed to Luna. Defines tool policy, caching/retry limits, Canvas retrieval tools, and the PDF/image tool surface.
- `server/workspace.ts` — temporary workspaces, Canvas file cache, Poppler PDF inspection/text/rendering, OCR, problem detection, and cropping.
- `server/settings.ts` / `server/env.ts` — local configuration, models/prompts, paths, and environment variables.
- `server/activity.ts` / `server/agent-progress.ts` — redacted activity logging and user-facing run progress.
- `server/predictor.ts` — optional external Test Question Predictor adapter.
- `scripts/` — Windows startup helpers plus the legacy Canvas-tool compatibility CLI. Luna's normal retrieval path is MCP, not the script endpoint.
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
- Persistent runtime data lives in `.school-dashboard/`; temporary run workspaces live under the OS temp directory. Neither is source code.
- When changing API shapes, update server validation/types and the corresponding frontend types/consumers together. If the Canvas Task Sync `/api/v1/tasks` or browser-resource contract changes, update both repositories.

## Run and verify

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Development UI: `http://127.0.0.1:5174`. Production server defaults to `http://127.0.0.1:8780` after `npm run build && npm start`.

Before finishing a code change, run the relevant tests and normally all three checks:

```powershell
npm test
npm run build
npm run lint
```

PDF workflows also require Poppler (`pdfinfo`, `pdftotext`, `pdftoppm`), and normal operation expects the Canvas Task Sync server to be running.
