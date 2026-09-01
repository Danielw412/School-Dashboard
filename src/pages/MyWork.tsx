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
  TrackedTask,
} from "../types";

type GroupMode = "due" | "class" | "upcoming";
type FilterMode = "all" | "overdue" | "week";
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
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [groupMode, setGroupMode] = useState<GroupMode>("class");
  const [filter, setFilter] = useState<FilterMode>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("tiles");
  const selectedId = searchParams.get("task");
  const unfinishedTasks = useMemo(
    () => (tasksState.data ?? []).filter((task) => task.completed === false),
    [tasksState.data],
  );
  const selectedTask = unfinishedTasks.find((task) => task.logical_id === selectedId) ?? null;

  const filtered = useMemo(() => {
    const now = new Date();
    const week = new Date(now);
    week.setDate(now.getDate() + 7);
    return unfinishedTasks.filter((task) => {
      if (query && !`${task.display_title} ${task.course.name}`.toLowerCase().includes(query.toLowerCase())) return false;
      const due = task.due_date ? parseDueDate(task.due_date) : null;
      if (filter === "overdue" && (!task.due_date || !isPastDue(task.due_date, now))) return false;
      if (filter === "week" && (!due || (task.due_date && isPastDue(task.due_date, now)) || due > week)) return false;
      return true;
    });
  }, [unfinishedTasks, query, filter]);

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
          <button className="secondary-button compact-button" onClick={() => void tasksState.refresh()}>
            <RefreshCw size={15} />Refresh
          </button>
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
          {(["all", "overdue", "week"] as FilterMode[]).map((item) => (
            <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>
              {item === "all" ? "All unfinished" : item === "overdue" ? "Overdue" : "Next 7 days"}
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
          onClose={() => setSelected(null)}
        />
      ) : null}
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
  onClose,
}: {
  task: TrackedTask;
  active: ActiveAssignment | null;
  refreshActive: () => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [result, setResult] = useState<{ logicalId: string; context: AssignmentContext | null; error: unknown }>({ logicalId: "", context: null, error: null });
  const [starting, setStarting] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [workflowError, setWorkflowError] = useState<unknown>(null);
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
