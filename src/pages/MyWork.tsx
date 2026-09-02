import {
  ArrowDownWideNarrow,
  ArrowUpRight,
  CalendarDays,
  ChevronRight,
  FileQuestion,
  FileText,
  Grid2X2,
  GraduationCap,
  List,
  ListChecks,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { schoolApi } from "../api";
import { ProgressTimeline } from "../components/AgentProgress";
import { EmptyState, ErrorNotice } from "../components/Status";
import { classTone, dueBucket, formatDue, isPastDue, parseDueDate } from "../format";
import { usePolling } from "../hooks/usePolling";
import type {
  ActiveWork,
  AgentProgress,
  AgentRun,
  AgentWorkflow,
  AssignmentContext,
  ManualTaskInput,
  TaskCourse,
  TrackedTask,
} from "../types";

type GroupMode = "due" | "class" | "upcoming";
type FilterMode = "all" | "overdue" | "week" | "completed";
type ViewMode = "tiles" | "list";
type WorkflowFeature = Exclude<AgentRun["feature"], "studyGuide">;

type ActiveAssignment = {
  workflow: AgentWorkflow | null;
  run: AgentRun | null;
  progress: AgentProgress | null;
  current: string;
};

export function MyWork() {
  const tasksState = usePolling(schoolApi.tasks);
  const activeState = usePolling(schoolApi.activeWork, 2_500);
  const coursesState = usePolling(schoolApi.taskCourses);
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [groupMode, setGroupMode] = useState<GroupMode>("class");
  const [filter, setFilter] = useState<FilterMode>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("tiles");
  const [editorTask, setEditorTask] = useState<TrackedTask | "new" | null>(null);
  const selectedId = searchParams.get("task");
  const unfinishedTasks = useMemo(
    () => (tasksState.data ?? []).filter((task) => task.completed === false),
    [tasksState.data],
  );
  const allTasks = useMemo(() => tasksState.data ?? [], [tasksState.data]);
  const selectedTask = allTasks.find((task) => task.logical_id === selectedId) ?? null;

  const filtered = useMemo(() => {
    const now = new Date();
    const week = new Date(now);
    week.setDate(now.getDate() + 7);
    const candidates = filter === "completed"
      ? allTasks.filter((task) => task.completed === true)
      : unfinishedTasks;
    return candidates.filter((task) => {
      if (query && !`${task.display_title} ${task.course.name}`.toLowerCase().includes(query.toLowerCase())) return false;
      const due = task.due_date ? parseDueDate(task.due_date) : null;
      if (filter === "overdue" && (!task.due_date || !isPastDue(task.due_date, now))) return false;
      if (filter === "week" && (!due || (task.due_date && isPastDue(task.due_date, now)) || due > week)) return false;
      return true;
    });
  }, [allTasks, unfinishedTasks, query, filter]);

  const groups = useMemo(() => {
    if (groupMode === "upcoming") {
      return [["", [...filtered].sort(compareByDueDate)] as [string, TrackedTask[]]];
    }
    const output = new Map<string, TrackedTask[]>();
    for (const task of filtered) {
      const key = groupMode === "due" ? dueBucket(task) : task.course.name;
      output.set(key, [...(output.get(key) ?? []), task]);
    }
    return [...output.entries()];
  }, [filtered, groupMode]);

  const setSelected = (task: TrackedTask | null) => {
    const next = new URLSearchParams(searchParams);
    if (task) next.set("task", task.logical_id);
    else next.delete("task");
    setSearchParams(next);
  };

  return (
    <div className={`page-grid ${selectedTask ? "has-inspector" : ""}`}>
      <section className="page-content work-page">
        <div className="page-heading-row work-heading">
          <h1>My work</h1>
          <div className="work-heading-actions">
            <button className="secondary-button compact-button" onClick={() => void tasksState.refresh()}><RefreshCw size={15} />Refresh</button>
            <button className="primary-button compact-button" disabled={!coursesState.data?.length} onClick={() => setEditorTask("new")}><Plus size={15} />New task</button>
          </div>
        </div>

        <div className="work-toolbar">
          <label className="search-field">
            <Search size={17} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search assignments" />
          </label>
          <div className="toolbar-controls">
            <div className="segmented" aria-label="Group assignments">
              <button aria-pressed={groupMode === "class"} className={groupMode === "class" ? "active" : ""} onClick={() => setGroupMode("class")}><GraduationCap size={15} />Class</button>
              <button aria-pressed={groupMode === "due"} className={groupMode === "due" ? "active" : ""} onClick={() => setGroupMode("due")}><CalendarDays size={15} />Due date</button>
              <button aria-pressed={groupMode === "upcoming"} className={groupMode === "upcoming" ? "active" : ""} onClick={() => setGroupMode("upcoming")}><ArrowDownWideNarrow size={15} />Due soonest</button>
            </div>
            <div className="segmented view-toggle" aria-label="Assignment view">
              <button className={viewMode === "tiles" ? "active" : ""} onClick={() => setViewMode("tiles")} aria-label="Tiles view"><Grid2X2 size={15} />Tiles</button>
              <button className={viewMode === "list" ? "active" : ""} onClick={() => setViewMode("list")} aria-label="List view"><List size={16} />List</button>
            </div>
          </div>
        </div>

        <div className="filter-row" aria-label="Filter assignments">
          {(["all", "overdue", "week", "completed"] as FilterMode[]).map((item) => (
            <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>
              {item === "all" ? "All unfinished" : item === "overdue" ? "Overdue" : item === "week" ? "Next 7 days" : "Completed"}
            </button>
          ))}
        </div>

        {tasksState.error ? <ErrorNotice error={tasksState.error} /> : null}
        {tasksState.loading ? <AssignmentSkeleton viewMode={viewMode} /> : null}
        {!tasksState.loading && !tasksState.error && groups.length === 0 ? (
          <EmptyState title="Nothing here" detail="No unfinished assignments match these filters." />
        ) : null}
        <div className={`assignment-groups ${groupMode === "upcoming" ? "is-ungrouped" : ""}`}>
          {groups.map(([group, items]) => (
            <section className="assignment-group" key={group || "upcoming"}>
              {group ? <header><h2>{group}</h2><span>{items.length}</span></header> : null}
              <div className={`assignment-collection ${viewMode}`}>
                {items.map((task) => (
                  <AssignmentItem
                    key={task.logical_id}
                    task={task}
                    viewMode={viewMode}
                    selected={task.logical_id === selectedId}
                    active={activeForTask(task.logical_id, activeState.data)}
                    onSelect={() => setSelected(task)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </section>
      {selectedTask ? (
        <AssignmentInspector
          task={selectedTask}
          active={activeForTask(selectedTask.logical_id, activeState.data)}
          refreshActive={() => void activeState.refresh()}
          onEdit={() => setEditorTask(selectedTask)}
          onClose={() => setSelected(null)}
        />
      ) : null}
      {editorTask ? <TaskEditor
        task={editorTask === "new" ? null : editorTask}
        courses={coursesState.data ?? []}
        onClose={() => setEditorTask(null)}
        onSaved={async () => {
          setEditorTask(null);
          setSelected(null);
          await tasksState.refresh();
        }}
      /> : null}
    </div>
  );
}

function AssignmentItem({
  task,
  viewMode,
  selected,
  active,
  onSelect,
}: {
  task: TrackedTask;
  viewMode: ViewMode;
  selected: boolean;
  active: ActiveAssignment | null;
  onSelect: () => void;
}) {
  const overdue = task.due_date ? isPastDue(task.due_date) : false;
  return (
    <button className={`assignment-item ${viewMode === "tiles" ? "assignment-tile" : "assignment-row"} ${selected ? "selected" : ""} ${active ? "is-running" : ""}`} onClick={onSelect}>
      <span className={`course-mark tone-${classTone(task.course.id)}`}>
        {active ? <LoaderCircle className="spin" size={18} /> : task.course.prefix.slice(0, 3).toUpperCase()}
      </span>
      <span className="assignment-main">
        <span className="course-name">{task.course.name}</span>
        <strong>{task.display_title}</strong>
        <span className="assignment-meta">
          {task.task_type ? <span>{task.task_type.replaceAll("_", " ")}</span> : null}
          {task.due_uncertain ? <span className="uncertain">Due date inferred</span> : null}
        </span>
      </span>
      <span className={`due-cell ${overdue ? "overdue" : ""}`}>
        <CalendarDays size={14} />
        <strong>{formatDue(task.due_date)}</strong>
      </span>
      {active ? <span className="assignment-running"><LoaderCircle className="spin" size={13} />{active.current}</span> : null}
      <ChevronRight className="row-chevron" size={18} />
    </button>
  );
}

function AssignmentInspector({
  task,
  active,
  refreshActive,
  onEdit,
  onClose,
}: {
  task: TrackedTask;
  active: ActiveAssignment | null;
  refreshActive: () => void;
  onEdit: () => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [result, setResult] = useState<{ logicalId: string; context: AssignmentContext | null; error: unknown }>({ logicalId: "", context: null, error: null });
  const [starting, setStarting] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [workflowError, setWorkflowError] = useState<unknown>(null);
  const isManualTask = Boolean(task.manually_managed);
  useEffect(() => {
    let current = true;
    void schoolApi.context(task.logical_id)
      .then((context) => { if (current) setResult({ logicalId: task.logical_id, context, error: null }); })
      .catch((error: unknown) => { if (current) setResult({ logicalId: task.logical_id, context: null, error }); });
    return () => { current = false; };
  }, [task.logical_id]);
  const context = result.logicalId === task.logical_id ? result.context : null;
  const contextError = result.logicalId === task.logical_id ? result.error : null;
  const canvasUrl = context?.assignment?.html_url ?? task.canvas.assignment_url ?? task.source.assignment_url;
  const externalUrl = context?.externalAssignment.url;

  const startWorkflow = async (label: string, steps: WorkflowFeature[]) => {
    setStarting(label);
    setWorkflowError(null);
    try {
      await schoolApi.startWorkflow({ logicalId: task.logical_id, steps });
      refreshActive();
    } catch (error) {
      setWorkflowError(error);
    } finally {
      setStarting(null);
    }
  };

  const cancelActive = async () => {
    if (!active) return;
    setCancelling(true);
    setWorkflowError(null);
    try {
      if (active.workflow) await schoolApi.cancelWorkflow(active.workflow.id);
      else if (active.run) await schoolApi.cancelRun(active.run.id);
      refreshActive();
    } catch (error) {
      setWorkflowError(error);
    } finally {
      setCancelling(false);
    }
  };

  const workflowActions: Array<{ label: string; steps: WorkflowFeature[]; icon: typeof FileText; primary?: boolean }> = [
    { label: "Get directions", steps: ["directions"], icon: FileText },
    { label: "Directions + problems", steps: ["directions", "problemExtraction"], icon: ListChecks },
    { label: "Full workflow", steps: ["directions", "problemExtraction", "answerKey"], icon: Workflow, primary: true },
    { label: "Problems + answer key", steps: ["problemExtraction", "answerKey"], icon: FileQuestion },
  ];

  return (
    <aside className="assignment-inspector" aria-label="Assignment details">
      <div className="inspector-top">
        <span className={`course-mark tone-${classTone(task.course.id)}`}>{task.course.prefix.slice(0, 3).toUpperCase()}</span>
        <button className="icon-button" aria-label="Close assignment details" onClick={onClose}><X size={18} /></button>
      </div>
      <p className="inspector-course">{task.course.name}</p>
      <h2>{task.display_title}</h2>
      <div className="inspector-due"><CalendarDays size={16} /><span><small>Due</small>{formatDue(task.due_date, true)}</span></div>

      {workflowError ? <ErrorNotice error={workflowError} /> : null}
      {contextError ? <ErrorNotice error={contextError} /> : null}

      {isManualTask ? <div className="requirements-block manual-task-note"><strong>Manual task</strong><p>Add a Canvas assignment URL to enable Luna assignment workflows.</p></div> : null}

      <section className="workflow-picker">
        <h3>Choose a workflow</h3>
        <div className="workflow-actions">
          {workflowActions.map(({ label, steps, icon: Icon, primary }) => (
            <button
              className={primary ? "workflow-action primary" : "workflow-action"}
              disabled={Boolean(active || starting)}
              key={label}
              onClick={() => void startWorkflow(label, steps)}
            >
              {starting === label ? <LoaderCircle className="spin" size={18} /> : <Icon size={18} />}
              <span>{label}</span>
              <ChevronRight size={17} />
            </button>
          ))}
        </div>
      </section>

      {active ? (
        <div className="inspector-progress">
          <ProgressTimeline progress={active.progress} active compact fallbackCurrent={active.current} />
          {active.workflow ? <WorkflowSequence workflow={active.workflow} /> : null}
          <button className="danger-button compact-button cancel-run-button" disabled={cancelling} onClick={() => void cancelActive()}>
            {cancelling ? <LoaderCircle className="spin" size={15} /> : <X size={15} />}Cancel Luna
          </button>
        </div>
      ) : null}

      <div className="inspector-actions">
        <button className="secondary-button" onClick={onEdit}><Pencil size={16} />Edit task</button>
        <button className="secondary-button" onClick={() => navigate(`/assignment/${encodeURIComponent(task.logical_id)}`)}>
          <ArrowUpRight size={16} />Open workspace
        </button>
        {canvasUrl ? <a className="text-link" href={canvasUrl} target="_blank" rel="noreferrer">Open Canvas<ArrowUpRight size={14} /></a> : null}
        {externalUrl ? <a className="text-link" href={externalUrl} target="_blank" rel="noreferrer">Open assignment<ArrowUpRight size={14} /></a> : null}
      </div>
      {context ? (
        <div className="requirements-block">
          <strong>Submission</strong>
          <p>{humanSubmissionTypes(context.submissionRequirements.submissionTypes)}</p>
          {context.submissionRequirements.allowedExtensions.length > 0 ? <span>Allowed: {context.submissionRequirements.allowedExtensions.join(", ")}</span> : null}
          {context.submissionRequirements.locked ? <span className="danger-text">{context.submissionRequirements.lockExplanation || "Canvas reports this assignment is locked."}</span> : null}
        </div>
      ) : null}
    </aside>
  );
}

const TASK_ACTIONS: ManualTaskInput["action_kind"][] = [
  "complete", "practice", "bring", "present", "submit", "read", "study", "write", "other",
];

function TaskEditor({ task, courses, onClose, onSaved }: {
  task: TrackedTask | null;
  courses: TaskCourse[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState<ManualTaskInput>(() => taskForm(task, courses[0]?.id ?? ""));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const update = <K extends keyof ManualTaskInput>(key: K, value: ManualTaskInput[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (task) await schoolApi.updateTask(task.logical_id, form);
      else await schoolApi.createTask(form);
      await onSaved();
    } catch (saveError) {
      setError(saveError);
    } finally {
      setSaving(false);
    }
  };

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <section className="dialog task-dialog" role="dialog" aria-modal="true" aria-labelledby="task-dialog-title">
      <button className="icon-button dialog-close" aria-label="Close task editor" disabled={saving} onClick={onClose}><X size={18} /></button>
      <h2 id="task-dialog-title">{task ? "Edit task" : "New task"}</h2>
      <p>Changes are saved directly to Google Tasks.</p>
      {error ? <ErrorNotice error={error} /> : null}
      <label>Task name<input autoFocus value={form.title} onChange={(event) => update("title", event.target.value)} /></label>
      <div className="field-grid">
        <label>Course<select value={form.course_id} disabled={Boolean(task)} onChange={(event) => update("course_id", event.target.value)}>{courses.map((course) => <option key={course.id} value={course.id}>{course.settings.name}</option>)}</select>{task ? <small>Course and Google task list stay fixed after creation.</small> : null}</label>
        <label>Due date<input type="date" value={form.due_date ?? ""} onChange={(event) => update("due_date", event.target.value || null)} /></label>
        <label>Task type<select value={form.task_type} onChange={(event) => update("task_type", event.target.value as ManualTaskInput["task_type"])}><option value="assignment">Assignment</option><option value="quiz">Quiz</option><option value="test">Test</option></select></label>
        <label>Classification<select value={form.classification} onChange={(event) => update("classification", event.target.value as ManualTaskInput["classification"])}><option value="homework">Homework</option><option value="classwork">Classwork</option></select></label>
        <label>Action<select value={form.action_kind} onChange={(event) => update("action_kind", event.target.value as ManualTaskInput["action_kind"])}>{TASK_ACTIONS.map((action) => <option key={action} value={action}>{action[0].toUpperCase() + action.slice(1)}</option>)}</select></label>
        <label>Status<select value={form.completed ? "completed" : "open"} onChange={(event) => update("completed", event.target.value === "completed")}><option value="open">Open</option><option value="completed">Completed</option></select></label>
      </div>
      <label>Description / notes<textarea rows={5} value={form.details} onChange={(event) => update("details", event.target.value)} /></label>
      <label>Source URL (optional)<input type="url" value={form.source_url ?? ""} onChange={(event) => update("source_url", event.target.value || null)} /></label>
      <label>Canvas assignment URL (optional)<input type="url" value={form.assignment_url ?? ""} onChange={(event) => update("assignment_url", event.target.value || null)} /></label>
      <div className="dialog-actions">
        <button className="secondary-button" disabled={saving} onClick={onClose}>Cancel</button>
        <button className="primary-button" disabled={saving || !form.title.trim() || !form.course_id} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={15} /> : null}{task ? "Save changes" : "Create task"}</button>
      </div>
    </section>
  </div>;
}

function taskForm(task: TrackedTask | null, courseId: string): ManualTaskInput {
  return {
    course_id: task?.course.id ?? courseId,
    title: task?.display_title ?? "",
    details: task?.details ?? "",
    due_date: task?.due_date?.slice(0, 10) ?? null,
    completed: task?.completed === true,
    classification: task?.classification === "classwork" ? "classwork" : "homework",
    task_type: task?.task_type === "quiz" || task?.task_type === "test" ? task.task_type : "assignment",
    action_kind: TASK_ACTIONS.includes(task?.action_kind as ManualTaskInput["action_kind"])
      ? task!.action_kind as ManualTaskInput["action_kind"]
      : "complete",
    source_url: task?.source.url ?? null,
    assignment_url: task?.canvas.assignment_url ?? task?.source.assignment_url ?? null,
  };
}

function WorkflowSequence({ workflow }: { workflow: AgentWorkflow }) {
  return (
    <ol className="workflow-sequence">
      {workflow.steps.map((step, index) => (
        <li className={step.status} key={`${step.feature}-${index}`}>
          <span>{step.status === "running" ? <LoaderCircle className="spin" size={13} /> : index + 1}</span>
          {workflowStepLabel(step.feature)}
        </li>
      ))}
    </ol>
  );
}

function workflowStepLabel(feature: WorkflowFeature): string {
  if (feature === "directions") return "Directions";
  if (feature === "problemExtraction") return "Assigned problems";
  return "Answer key";
}

function activeForTask(logicalId: string, activeWork: ActiveWork | null): ActiveAssignment | null {
  if (!activeWork) return null;
  const workflow = activeWork.workflows.find((item) => item.logicalId === logicalId) ?? null;
  const runWithProgress = workflow?.currentRunId
    ? activeWork.runs.find((item) => item.run.id === workflow.currentRunId)
    : activeWork.runs.find((item) => item.run.logicalId === logicalId);
  if (!workflow && !runWithProgress) return null;
  const currentStep = workflow && workflow.currentStep !== null ? workflow.steps[workflow.currentStep] : null;
  return {
    workflow,
    run: runWithProgress?.run ?? null,
    progress: runWithProgress?.progress ?? null,
    current: runWithProgress?.progress.current ?? (currentStep ? workflowStepLabel(currentStep.feature) : "Starting workflow"),
  };
}

function humanSubmissionTypes(types: string[]): string {
  if (types.length === 0 || types.includes("none")) return "No online submission is listed in Canvas.";
  return types.map((type) => type.replace(/^online_/, "").replaceAll("_", " ")).join(", ");
}

function compareByDueDate(left: TrackedTask, right: TrackedTask): number {
  if (!left.due_date && !right.due_date) return left.display_title.localeCompare(right.display_title);
  if (!left.due_date) return 1;
  if (!right.due_date) return -1;
  const difference = parseDueDate(left.due_date).getTime() - parseDueDate(right.due_date).getTime();
  return difference || left.display_title.localeCompare(right.display_title);
}

function AssignmentSkeleton({ viewMode }: { viewMode: ViewMode }) {
  return <div className={`assignment-skeletons ${viewMode}`}>{[1, 2, 3, 4].map((item) => <div className="assignment-skeleton" key={item}><span /><i /><i /><b /></div>)}</div>;
}
