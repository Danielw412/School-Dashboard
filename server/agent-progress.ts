import type { ActivityEvent } from "./activity.js";
import type { AgentRun } from "./agent-runner.js";

export type AgentProgress = {
  runId: string;
  status: AgentRun["status"];
  startedAt: string;
  completedAt: string | null;
  serverNow: string;
  elapsedMs: number;
  current: string;
  entries: Array<{
    id: string;
    timestamp: string;
    status: ActivityEvent["status"];
    message: string;
  }>;
};

export function buildAgentProgress(
  run: AgentRun,
  activity: ActivityEvent[],
  now = new Date(),
): AgentProgress {
  const relevant = activity.filter((event) => {
    const eventRunId = typeof event.metadata?.runId === "string" ? event.metadata.runId : null;
    const workspace = typeof event.metadata?.workspace === "string" ? event.metadata.workspace : null;
    return eventRunId === run.id || Boolean(run.workspaceId && workspace === run.workspaceId);
  });
  const entries = collapseStartedEvents(relevant)
    .slice(0, 10)
    .map((event) => ({
      id: event.id,
      timestamp: event.timestamp,
      status: event.status,
      message: progressMessage(event),
    }));
  const end = run.completedAt ? Date.parse(run.completedAt) : now.getTime();
  const start = Date.parse(run.startedAt);
  return {
    runId: run.id,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    serverNow: now.toISOString(),
    elapsedMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0,
    current: entries[0]?.message ?? (run.status === "queued" ? "Waiting to start Luna" : "Starting Luna"),
    entries,
  };
}

function collapseStartedEvents(events: ActivityEvent[]): ActivityEvent[] {
  const terminalActions = new Set<string>();
  return events.filter((event) => {
    const key = `${event.category}:${event.action}`;
    if (event.status === "started" && terminalActions.has(key)) return false;
    if (event.status === "completed" || event.status === "failed") terminalActions.add(key);
    return true;
  });
}

function progressMessage(event: ActivityEvent): string {
  const labels: Record<string, string> = {
    directions: "Synthesizing concise directions",
    problemExtraction: "Extracting assigned problems",
    answerKey: "Building the answer key",
    studyGuide: "Building the study guide",
    "canvas_tool.context": "Reading assignment context",
    "canvas_tool.recover-context": "Recovering the originating Canvas context",
    "canvas_tool.assignment": "Reading the Canvas assignment",
    "canvas_tool.submission-requirements": "Checking submission requirements",
    "canvas_tool.course": "Reading course information",
    "canvas_tool.search": "Searching the Canvas course",
    "canvas_tool.pages": "Looking through Canvas pages",
    "canvas_tool.files": "Looking through Canvas files",
    "canvas_tool.modules": "Inspecting course modules",
    "canvas_tool.module-items": "Inspecting module items",
    "canvas_tool.module-neighborhood": "Checking nearby module material",
    "canvas_tool.page": "Reading a Canvas page",
    "canvas_tool.follow": "Following a linked Canvas resource",
    "canvas_tool.announcements": "Checking course announcements",
    "canvas_tool.discussion": "Reading a Canvas discussion",
    "canvas_tool.quiz": "Inspecting quiz details",
    "canvas_tool.quiz-questions": "Checking available quiz questions",
    "canvas_tool.file": "Inspecting a Canvas file",
    "canvas_tool.download": "Downloading an assignment resource",
    "canvas_tool.pdf-inspect": "Inspecting PDF structure and text layer",
    "canvas_tool.pdf-index": "Indexing PDF pages and problem structure",
    "canvas_tool.pdf-text": "Reading PDF text",
    "canvas_tool.pdf-render": "Rendering PDF pages",
    "canvas_tool.pdf-contact-sheet": "Building a PDF overview",
    "canvas_tool.pdf-ocr": "Reading scanned PDF pages with OCR",
    "canvas_tool.pdf-detect-problems": "Locating requested PDF problems",
    "canvas_tool.pdf-semantic-crop": "Cropping complete problem regions",
    "canvas_tool.image-crop": "Cropping a problem visual",
    "canvas_tool.batch": "Retrieving independent resources together",
    command_execution: "Running a scoped assignment tool",
    reasoning: "Reasoning about inspected evidence",
    agent_message: "Preparing the structured result",
  };
  let label = labels[event.action];
  if (!label && event.category === "cache") {
    label = event.action === "hit"
      ? `Using cached resource: ${event.summary}`
      : `Caching resource: ${event.summary}`;
  }
  if (!label && event.category === "resource" && event.action === "render_pdf_page") {
    label = `Rendered ${event.summary}`;
  }
  label ??= event.action.replaceAll("_", " ").replaceAll(".", " · ");
  if (event.status === "failed") return `${label} failed`;
  if (event.status === "completed") return `${label} complete`;
  return label;
}
