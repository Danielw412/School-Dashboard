import { CanvasToolSessions } from "./tool-sessions.js";

const MAX_BROWSER_CONTENT_CHARS = 60_000;
const MAX_CONTEXT_MARKDOWN_CHARS = 40_000;
const MAX_TASK_TEXT_CHARS = 8_000;

export class CompactingCanvasToolSessions extends CanvasToolSessions {
  override async execute(
    token: string | undefined,
    rawAction: unknown,
    rawInput: unknown,
  ): Promise<unknown> {
    const result = await super.execute(token, rawAction, rawInput);
    return compactAgentToolResult(typeof rawAction === "string" ? rawAction : "", result);
  }
}

export function compactAgentToolResult(action: string, value: unknown): unknown {
  if (action === "preloaded-context") return compactPreloadedContext(value);
  if (action === "browser-resource") return compactBrowserResource(value);
  return value;
}

function compactPreloadedContext(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  return {
    task: compactTask(record.task),
    assignmentContext: compactAssignmentContext(record.assignmentContext),
    preflight: compactPreflight(record.preflight),
  };
}

function compactTask(value: unknown): unknown {
  const task = asRecord(value);
  if (!task) return value;
  return compactDefined({
    logical_id: task.logical_id,
    course: compactCourse(task.course),
    title: task.title,
    display_title: task.display_title,
    details: truncateString(task.details, MAX_TASK_TEXT_CHARS),
    due_date: task.due_date,
    classification: task.classification,
    task_type: task.task_type,
    action_kind: task.action_kind,
    due_basis: task.due_basis,
    due_uncertain: task.due_uncertain,
    due_uncertain_reason: task.due_uncertain_reason,
    source_date: task.source_date,
    source: compactTaskSource(task.source),
    canvas: compactCanvasIdentity(task.canvas),
  });
}

function compactCourse(value: unknown): unknown {
  const course = asRecord(value);
  if (!course) return value;
  return compactDefined({
    id: course.id,
    name: course.name,
    prefix: course.prefix,
    canvas_course_id: course.canvas_course_id,
    canvas_url: course.canvas_url,
  });
}

function compactTaskSource(value: unknown): unknown {
  const source = asRecord(value);
  if (!source) return value;
  return compactDefined({
    key: source.key,
    type: source.type,
    url: source.url,
    anchor: source.anchor,
    text: truncateString(source.text, MAX_TASK_TEXT_CHARS),
    assignment_url: source.assignment_url,
  });
}

function compactCanvasIdentity(value: unknown): unknown {
  const canvas = asRecord(value);
  if (!canvas) return value;
  return compactDefined({
    course_id: canvas.course_id,
    assignment_id: canvas.assignment_id,
    course_url: canvas.course_url,
    assignment_url: canvas.assignment_url,
  });
}

function compactAssignmentContext(value: unknown): unknown {
  const context = asRecord(value);
  if (!context) return value;
  return compactDefined({
    assignment: compactAssignment(context.assignment),
    moduleItem: compactModuleItem(context.moduleItem),
    directionsMarkdown: truncateString(context.directionsMarkdown, MAX_CONTEXT_MARKDOWN_CHARS),
    links: compactLinks(context.links),
    submissionRequirements: context.submissionRequirements,
    externalAssignment: context.externalAssignment,
    sourceContext: compactSourceContext(context.sourceContext),
    resolution: context.resolution,
  });
}

function compactModuleItem(value: unknown): unknown {
  if (value === null) return null;
  const item = asRecord(value);
  if (!item) return value;
  return compactDefined({
    id: item.id,
    module_id: item.module_id,
    position: item.position,
    title: item.title,
    type: item.type,
    content_id: item.content_id,
    page_url: item.page_url,
    external_url: item.external_url,
    html_url: item.html_url,
    url: item.url,
  });
}

function compactAssignment(value: unknown): unknown {
  if (value === null) return null;
  const assignment = asRecord(value);
  if (!assignment) return value;
  const externalTool = asRecord(assignment.external_tool_tag_attributes);
  return compactDefined({
    id: assignment.id,
    course_id: assignment.course_id,
    name: assignment.name,
    due_at: assignment.due_at,
    html_url: assignment.html_url,
    points_possible: assignment.points_possible,
    submission_types: assignment.submission_types,
    allowed_extensions: assignment.allowed_extensions,
    allowed_attempts: assignment.allowed_attempts,
    locked_for_user: assignment.locked_for_user,
    lock_explanation: assignment.lock_explanation,
    workflow_state: assignment.workflow_state,
    external_tool_tag_attributes: externalTool
      ? compactDefined({ url: externalTool.url, new_tab: externalTool.new_tab })
      : assignment.external_tool_tag_attributes,
  });
}

function compactSourceContext(value: unknown): unknown {
  if (value === null) return null;
  const source = asRecord(value);
  if (!source) return value;
  return compactDefined({
    kind: source.kind,
    title: source.title,
    url: source.url,
    matchedBy: source.matchedBy,
    contextMarkdown: truncateString(source.contextMarkdown, MAX_CONTEXT_MARKDOWN_CHARS),
    cells: compactCells(source.cells),
    links: compactLinks(source.links),
    resource: compactResourceIdentity(source.resource),
  });
}

function compactCells(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.slice(0, 30).map((item) => truncateString(item, 4_000));
}

function compactLinks(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.slice(0, 50).map((item) => {
    const link = asRecord(item);
    if (!link) return item;
    return compactDefined({
      text: truncateString(link.text, 500),
      url: link.url,
      sameCanvasOrigin: link.sameCanvasOrigin,
    });
  });
}

function compactResourceIdentity(value: unknown): unknown {
  const resource = asRecord(value);
  if (!resource) return value;
  const keys = [
    "id",
    "page_id",
    "url",
    "title",
    "html_url",
    "display_name",
    "filename",
    "content_type",
    "updated_at",
    "created_at",
    "published",
    "hide_from_students",
    "front_page",
    "locked_for_user",
    "todo_date",
    "publish_at",
    "type",
    "module_id",
    "content_id",
    "page_url",
    "external_url",
  ] as const;
  return compactDefined(Object.fromEntries(keys.map((key) => [key, resource[key]])));
}

function compactPreflight(value: unknown): unknown {
  const preflight = asRecord(value);
  if (!preflight) return value;
  const compact = { ...preflight };
  delete compact.recoveredSourceContext;
  return compact;
}

function compactBrowserResource(value: unknown): unknown {
  const resource = asRecord(value);
  if (!resource || resource.ok !== true) return value;
  const rawContent = typeof resource.content === "string" ? resource.content : "";
  const content = rawContent.slice(0, MAX_BROWSER_CONTENT_CHARS);
  const compact: Record<string, unknown> = compactDefined({
    ok: true,
    sourceType: resource.sourceType,
    url: resource.url,
    resourceId: resource.resourceId,
    title: resource.title,
    capturedAt: resource.capturedAt,
    captureStatus: resource.captureStatus,
    content,
    contentTruncated:
      resource.contentTruncated === true || rawContent.length > MAX_BROWSER_CONTENT_CHARS,
    links: compactLinks(resource.links),
    warnings: Array.isArray(resource.warnings) ? resource.warnings.slice(0, 20) : resource.warnings,
    source: resource.source,
  });

  if (!content.trim()) {
    const structuredItems = compactStructuredItems(resource.items);
    if (structuredItems.length > 0) compact.structuredItems = structuredItems;
  }
  return compact;
}

function compactStructuredItems(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((item) => {
    const record = asRecord(item);
    if (!record || record.structuredData == null) return [];
    return [compactDefined({
      id: record.id,
      kind: record.kind,
      order: record.order,
      structuredData: record.structuredData,
    })];
  });
}

function truncateString(value: unknown, maxChars: number): unknown {
  if (typeof value !== "string" || value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function compactDefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}
