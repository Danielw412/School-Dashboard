import {
  ArrowUpRight,
  BookOpenText,
  CalendarDays,
  ChevronRight,
  Clock3,
  FileQuestion,
  GraduationCap,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { schoolApi } from "../api";
import { EmptyState, ErrorNotice } from "../components/Status";
import { classTone, dueBucket, formatDue, isAssessment, isPastDue, parseDueDate } from "../format";
import { usePolling } from "../hooks/usePolling";
import type { AssignmentContext, TrackedTask } from "../types";

type GroupMode = "due" | "class";
type FilterMode = "all" | "overdue" | "week";

export function MyWork() {
  const { data: tasks, error, loading, refresh } = usePolling(schoolApi.tasks);
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [groupMode, setGroupMode] = useState<GroupMode>("due");
  const [filter, setFilter] = useState<FilterMode>("all");
  const selectedId = searchParams.get("task");
  const unfinishedTasks = useMemo(
    () => (tasks ?? []).filter((task) => task.completed === false),
    [tasks],
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
        <div className="eyebrow"><span className="live-dot" />Live from Canvas Task Sync</div>
        <div className="page-heading-row">
          <div>
            <h1>My work</h1>
            <p>Unfinished assignments, organized for the next decision.</p>
          </div>
          <button className="secondary-button" onClick={() => void refresh()}><Clock3 size={16} />Refresh</button>
        </div>

        <div className="work-toolbar">
          <label className="search-field">
            <Search size={17} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search assignments or classes" />
          </label>
          <div className="segmented" aria-label="Group assignments">
            <button className={groupMode === "due" ? "active" : ""} onClick={() => setGroupMode("due")}><CalendarDays size={15} />Due date</button>
            <button className={groupMode === "class" ? "active" : ""} onClick={() => setGroupMode("class")}><GraduationCap size={15} />Class</button>
          </div>
        </div>

        <div className="filter-row">
          <SlidersHorizontal size={15} />
          {(["all", "overdue", "week"] as FilterMode[]).map((item) => (
            <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>
              {item === "all" ? "All unfinished" : item === "overdue" ? "Overdue" : "Next 7 days"}
            </button>
          ))}
        </div>

        {Boolean(error) && <ErrorNotice error={error} />}
        {loading && <AssignmentSkeleton />}
        {!loading && !error && groups.length === 0 && (
          <EmptyState title="Nothing here" detail="No unfinished assignments match these filters." />
        )}
        <div className="assignment-groups">
          {groups.map(([group, items]) => (
            <section className="assignment-group" key={group}>
              <header><h2>{group}</h2><span>{items.length} {items.length === 1 ? "item" : "items"}</span></header>
              <div className="assignment-list">
                {items.map((task) => (
                  <AssignmentRow key={task.logical_id} task={task} selected={task.logical_id === selectedId} onSelect={() => setSelected(task)} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </section>
      {selectedTask && <AssignmentInspector task={selectedTask} onClose={() => setSelected(null)} />}
    </div>
  );
}

function AssignmentRow({ task, selected, onSelect }: { task: TrackedTask; selected: boolean; onSelect: () => void }) {
  const overdue = task.due_date ? isPastDue(task.due_date) : false;
  return (
    <button className={`assignment-row ${selected ? "selected" : ""}`} onClick={onSelect}>
      <span className={`course-mark tone-${classTone(task.course.id)}`}>{task.course.prefix.slice(0, 3).toUpperCase()}</span>
      <span className="assignment-main">
        <span className="course-name">{task.course.name}</span>
        <strong>{task.display_title}</strong>
        <span className="assignment-meta">
          {task.task_type && <span>{task.task_type.replaceAll("_", " ")}</span>}
          {task.due_uncertain && <span className="uncertain">Due date inferred</span>}
        </span>
      </span>
      <span className={`due-cell ${overdue ? "overdue" : ""}`}>
        <span>{overdue ? "Overdue" : "Due"}</span>
        <strong>{formatDue(task.due_date)}</strong>
      </span>
      {isAssessment(task) ? <Sparkles className="row-kind" size={18} /> : <BookOpenText className="row-kind" size={18} />}
      <ChevronRight className="row-chevron" size={18} />
    </button>
  );
}

function AssignmentInspector({ task, onClose }: { task: TrackedTask; onClose: () => void }) {
  const navigate = useNavigate();
  const [result, setResult] = useState<{ logicalId: string; context: AssignmentContext | null; error: unknown }>({ logicalId: "", context: null, error: null });
  useEffect(() => {
    let active = true;
    void schoolApi.context(task.logical_id)
      .then((context) => { if (active) setResult({ logicalId: task.logical_id, context, error: null }); })
      .catch((error: unknown) => { if (active) setResult({ logicalId: task.logical_id, context: null, error }); });
    return () => { active = false; };
  }, [task.logical_id]);
  const context = result.logicalId === task.logical_id ? result.context : null;
  const error = result.logicalId === task.logical_id ? result.error : null;
  const canvasUrl = context?.assignment?.html_url ?? task.canvas.assignment_url ?? task.source.assignment_url;
  const externalUrl = context?.externalAssignment.url;
  return (
    <aside className="assignment-inspector" aria-label="Assignment details">
      <div className="inspector-top">
        <span className={`course-mark tone-${classTone(task.course.id)}`}>{task.course.prefix.slice(0, 3).toUpperCase()}</span>
        <button className="icon-button" aria-label="Close assignment details" onClick={onClose}><X size={18} /></button>
      </div>
      <p className="inspector-course">{task.course.name}</p>
      <h2>{task.display_title}</h2>
      <div className="inspector-due"><CalendarDays size={16} /><span><small>Due</small>{formatDue(task.due_date, true)}</span></div>
      <div className="inspector-section">
        <div className="section-kicker">Directions</div>
        {error ? <ErrorNotice error={error} /> : context ? (
          <p className="muted">Open the assignment workspace and choose Get Directions for a Luna-generated, source-grounded summary.</p>
        ) : <div className="text-skeleton"><span /><span /><span /></div>}
      </div>
      {context?.externalAssignment.isExternal && (
        <div className="notice amber"><ArrowUpRight size={18} /><div><strong>External assignment</strong><p>Canvas can show the link and requirements, but cannot read the external platform automatically.</p></div></div>
      )}
      <div className="inspector-actions">
        <button className="primary-button" onClick={() => navigate(`/assignment/${encodeURIComponent(task.logical_id)}`)}>
          <FileQuestion size={17} />Open workspace
        </button>
        {canvasUrl && <a className="secondary-button" href={canvasUrl} target="_blank" rel="noreferrer">Open Canvas<ArrowUpRight size={15} /></a>}
        {externalUrl && <a className="secondary-button" href={externalUrl} target="_blank" rel="noreferrer">Open assignment<ArrowUpRight size={15} /></a>}
      </div>
      {context && (
        <div className="requirements-block">
          <div className="section-kicker">Submission</div>
          <p>{humanSubmissionTypes(context.submissionRequirements.submissionTypes)}</p>
          {context.submissionRequirements.allowedExtensions.length > 0 && <span>Allowed: {context.submissionRequirements.allowedExtensions.join(", ")}</span>}
          {context.submissionRequirements.locked && <span className="danger-text">Locked: {context.submissionRequirements.lockExplanation || "Canvas reports this assignment is locked."}</span>}
        </div>
      )}
    </aside>
  );
}

function humanSubmissionTypes(types: string[]): string {
  if (types.length === 0 || types.includes("none")) return "No online submission is listed in Canvas.";
  return types.map((type) => type.replace(/^online_/, "").replaceAll("_", " ")).join(" · ");
}

function AssignmentSkeleton() {
  return <div className="assignment-groups skeleton-group"><div className="skeleton-heading" />{[1, 2, 3, 4].map((item) => <div className="row-skeleton" key={item}><span /><div><i /><i /></div><b /></div>)}</div>;
}
