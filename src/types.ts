export type TrackedTask = {
  logical_id: string;
  course: {
    id: string;
    name: string;
    prefix: string;
    canvas_course_id?: string | null;
    canvas_base_url?: string | null;
    canvas_url?: string | null;
  };
  title: string;
  display_title: string;
  details: string;
  due_date: string | null;
  completed: boolean | null;
  completion_status: string;
  classification?: string | null;
  task_type?: string | null;
  action_kind?: string | null;
  due_basis?: string | null;
  due_uncertain: boolean;
  due_uncertain_reason?: string | null;
  source_date?: string | null;
  historical: boolean;
  manually_managed?: boolean;
  google_task: {
    task_id?: string | null;
    tasklist_id?: string | null;
    tasklist_title?: string | null;
    status: string;
    completed_at?: string | null;
    deleted: boolean;
    hidden: boolean;
  };
  source: {
    key: string;
    type: string;
    url?: string | null;
    anchor: string;
    text: string;
    assignment_url?: string | null;
  };
  canvas: {
    course_id?: string | null;
    assignment_id?: string | null;
    course_url?: string | null;
    assignment_url?: string | null;
  };
};

export type TaskCourse = {
  id: string;
  settings: { name: string; prefix: string };
};

export type CourseDirections = {
  courseId: string;
  directions: {
    directions: string;
    problemExtraction: string;
    answerKey: string;
    studyGuide: string;
  };
  updatedAt: string | null;
};

export type ManualTaskInput = {
  course_id: string;
  title: string;
  details: string;
  due_date: string | null;
  completed: boolean;
  classification: "homework" | "classwork";
  task_type: "assignment" | "quiz" | "test";
  action_kind: "practice" | "complete" | "bring" | "present" | "submit" | "read" | "study" | "write" | "other";
  source_url: string | null;
  assignment_url: string | null;
};

export type AssignmentContext = {
  assignment: null | {
    id: number;
    course_id?: number;
    name: string;
    due_at?: string | null;
    html_url: string;
    points_possible?: number | null;
    submission_types: string[];
    allowed_extensions: string[];
    allowed_attempts?: number | null;
    locked_for_user: boolean;
    lock_explanation?: string | null;
  };
  directionsHtml: string;
  directionsMarkdown: string;
  links: Array<{ text: string; url: string; sameCanvasOrigin: boolean }>;
  submissionRequirements: {
    supported: boolean;
    submissionTypes: string[];
    allowedExtensions: string[];
    pointsPossible: number | null;
    allowedAttempts: number | null;
    locked: boolean;
    lockExplanation: string | null;
  };
  externalAssignment: { isExternal: boolean; url: string | null };
  resolution: { method: string; confidence: number };
};

export type AgentRun = {
  id: string;
  feature: "directions" | "problemExtraction" | "answerKey" | "studyGuide";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  logicalId: string;
  taskTitle: string;
  courseName: string;
  model: ModelName;
  reasoningEffort: ReasoningEffort;
  effectiveReasoningEffort: string;
  prompt: string;
  courseDirections?: {
    courseId: string;
    feature: AgentRun["feature"];
    directions: string;
    updatedAt: string | null;
  };
  startedAt: string;
  completedAt: string | null;
  threadId: string | null;
  workspaceId: string | null;
  usage: null | {
    input_tokens: number;
    cached_input_tokens: number;
    cache_write_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
  };
  events: unknown[];
  rawStructuredOutput: string | null;
  output: unknown;
  error: string | null;
  predictor: null | { requested: boolean; status: string; message: string; output: unknown };
};

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
    status: "started" | "completed" | "warning" | "failed";
    message: string;
    category: string;
    action: string;
    tool: string | null;
  }>;
};

export type AgentWorkflow = {
  id: string;
  logicalId: string;
  taskTitle: string;
  courseName: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  steps: Array<{
    feature: Exclude<AgentRun["feature"], "studyGuide">;
    status: "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped";
    runId: string | null;
  }>;
  currentStep: number | null;
  currentRunId: string | null;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
};

export type ActiveWork = {
  workflows: AgentWorkflow[];
  runs: Array<{ run: AgentRun; progress: AgentProgress }>;
};

export type ConnectionTestResult = {
  testedAt: string;
  status: "ready" | "degraded";
  checks: Array<{
    id: string;
    label: string;
    status: "passed" | "warning" | "failed";
    detail: string;
    latencyMs: number;
    optional?: boolean;
  }>;
};

export type ModelName = "gpt-5.6-luna" | "gpt-5.6-terra" | "gpt-5.6-sol";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type AppSettings = {
  version: 1;
  defaultModel: ModelName;
  featureModels: {
    problemExtraction: ModelName;
    answerKey: ModelName;
    studyGuide: ModelName;
    assignmentNavigation: ModelName;
  };
  reasoningEffort: ReasoningEffort;
  prompts: {
    problemExtraction: string;
    answerKey: string;
    studyGuide: string;
    assignmentNavigation: string;
  };
  testQuestionPredictor: { enabled: boolean };
  connections: { taskSyncApiBase: string; canvasBaseUrl: string };
  cache: { ttlMinutes: number; maxMegabytes: number; workspaceRetentionHours: number };
};

export type Diagnostics = {
  generatedAt: string;
  currentModel: string;
  currentPrompts: AppSettings["prompts"];
  featureModels: AppSettings["featureModels"];
  reasoningEffort: string;
  connections: {
    taskSync: { connected: boolean; error?: string };
    canvas: { connected: boolean; name?: string; error?: string };
    canvasCredentialConfigured: boolean;
    taskSyncApiBase: string;
    canvasBaseUrl: string;
  };
  predictor: { configured: boolean; message: string };
  cache: { files: number; bytes: number; hits: number; misses: number };
  recentRuns: AgentRun[];
  activity: Array<{
    id: string;
    timestamp: string;
    category: string;
    action: string;
    status: string;
    summary: string;
    metadata?: Record<string, unknown>;
  }>;
};

export type ProblemExtraction = {
  assignmentTitle: string;
  summary: string;
  answerBanks?: Array<{
    id: string;
    title: string;
    markdown: string;
    problemNumbers: string[];
    provenance: Array<{ sourceName: string; sourceUrl: string | null; page: number | null; evidence: string }>;
  }>;
  problems: Array<{
    number: string;
    markdown: string;
    answerBankId?: string | null;
    table?: null | { caption: string | null; columns: string[]; rows: string[][] };
    provenance: Array<{ sourceName: string; sourceUrl: string | null; page: number | null; evidence: string }>;
    visual: null | { path: string; page: number; caption: string; kind?: "figure" | "diagram" | "graph" | "chart" | "table" | "spectrum" | "map" | "image" };
    confidence: "high" | "medium" | "low";
  }>;
  unresolved: Array<{ reference: string; reason: string; searched: string[] }>;
  sourcesInspected: Array<{ name: string; type: string; url: string | null; pages: number[] }>;
};

export type AssignmentDirections = {
  assignmentTitle: string;
  overviewMarkdown: string;
  instructions: Array<{
    heading: string;
    markdown: string;
    provenance: Array<{ sourceName: string; sourceUrl: string | null; page: number | null; evidence: string }>;
  }>;
  assignedWork: Array<{
    label: string;
    items: string[];
    provenance: Array<{ sourceName: string; sourceUrl: string | null; page: number | null; evidence: string }>;
  }>;
  submission: {
    methodMarkdown: string;
    deliverables: string[];
    dueMarkdown: string | null;
  };
  resources: Array<{
    title: string;
    url: string | null;
    kind: "canvas" | "file" | "page" | "external";
    description: string;
  }>;
  notices: Array<{ level: "info" | "warning"; markdown: string }>;
  sourcesInspected: Array<{ name: string; type: string; url: string | null; relevance: string }>;
};

export type AnswerKey = {
  assignmentTitle: string;
  summary: string;
  answers: Array<{
    problemNumber: string;
    finalAnswerMarkdown: string;
    solutionMarkdown: string;
  }>;
  warnings: string[];
};

export type StudyGuide = {
  assessmentTitle: string;
  overview: string;
  teacherStatedScope: Array<{ topic: string; evidence: string; provenance: { sourceName: string; sourceUrl: string | null; page: number | null; evidence: string } }>;
  agentInferredTopics: Array<{ topic: string; rationale: string; provenance: unknown[] }>;
  sections: Array<{ heading: string; explanationMarkdown: string; keyIdeas: string[] }>;
  practiceQuestions: Array<{ questionMarkdown: string; answerMarkdown: string; basis: string; provenance: unknown[] }>;
  sourcesInspected: Array<{ name: string; type: string; url: string | null; relevance: string }>;
  predictor: { requested: boolean; status: "disabled" | "unavailable" | "available"; message: string };
};
