import {
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  CaretRightIcon,
  CircleNotchIcon,
  ListChecksIcon,
  ListIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  SquaresFourIcon,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";

import { type ActiveAssignment, activeAssignments } from "../active-work";
import { useSelectedAgentProvider } from "../agent-status";
import { schoolApi } from "../api";
import { RunMenu } from "../components/RunMenu";
import { TaskEditor } from "../components/TaskEditor";
import {
  Button,
  EmptyState,
  ErrorNotice,
  IconButton,
  LinkButton,
  Notice,
  PageHeader,
  Segmented,
  SkeletonRows,
} from "../components/ui";
import { WorkingNow } from "../components/WorkingNow";
import { featureLabel, tabForFeature } from "../features";
import {
  classMarkText,
  classTone,
  compareByDueDate,
  type DueBucket,
  dueBucket,
  dueBucketLabel,
  dueBucketOrder,
  formatDueShort,
  parseDueDate,
} from "../format";
import { usePolling } from "../hooks/usePolling";
import { assistantName } from "../models";
import { useTaskSyncUrl } from "../shell-context";
import { taskSyncPages } from "../task-sync-links";
import { useToast } from "../toast";
import type { TrackedTask } from "../types";

type Status = "open" | "completed";
type GroupBy = "date" | "class";
type View = "list" | "tiles";

const GROUP_KEY = "school-dashboard:group-by";
const VIEW_KEY = "school-dashboard:view";

// Layout choices are a per-browser convenience; without storage they last for the visit.
function readChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    return allowed.includes(value as T) ? value as T : fallback;
  } catch {
    return fallback;
  }
}

function saveChoice(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* the choice lasts for this visit */ }
}

export function AssignmentsPage() {
  const tasksState = usePolling(schoolApi.tasks);
  const activeState = usePolling(schoolApi.activeWork, 2_500);
  const coursesState = usePolling(schoolApi.taskCourses);
  const [searchParams] = useSearchParams();
  const toast = useToast();
  const taskSyncUrl = useTaskSyncUrl();
  const provider = useSelectedAgentProvider();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("open");
  const [classFilter, setClassFilter] = useState(searchParams.get("class") ?? "");
  const [groupBy, setGroupBy] = useState<GroupBy>(() => readChoice(GROUP_KEY, ["date", "class"], "date"));
  const [view, setView] = useState<View>(() => readChoice(VIEW_KEY, ["list", "tiles"], "list"));
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const allTasks = useMemo(() => tasksState.data ?? [], [tasksState.data]);
  const taskIndex = useMemo(() => new Map(allTasks.map((task) => [task.logical_id, task])), [allTasks]);
  const active = useMemo(() => activeAssignments(activeState.data), [activeState.data]);
  const completionUnavailable = allTasks.some((task) => task.completion_status === "unavailable");
  const openTasks = useMemo(() => allTasks.filter((task) => task.completed === false), [allTasks]);
  const classes = useMemo(() => {
    const known = new Map<string, string>();
    for (const course of coursesState.data ?? []) known.set(course.id, course.settings.name);
    for (const task of allTasks) if (!known.has(task.course.id)) known.set(task.course.id, task.course.name);
    return [...known.entries()].map(([id, name]) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name));
  }, [allTasks, coursesState.data]);

  const scoped = useMemo(() => allTasks.filter((task) => !classFilter || task.course.id === classFilter), [allTasks, classFilter]);
  const counts = {
    open: scoped.filter((task) => task.completed === false).length,
    completed: scoped.filter((task) => task.completed === true).length,
  };

  const groups = useMemo(() => {
    const term = query.trim().toLowerCase();
    const visible = scoped.filter((task) => {
      if (status === "open" ? task.completed !== false : task.completed !== true) return false;
      return !term || `${task.display_title} ${task.course.name} ${task.details}`.toLowerCase().includes(term);
    });
    if (groupBy === "class") {
      const byClass = new Map<string, TrackedTask[]>();
      for (const task of [...visible].sort(compareByDueDate)) byClass.set(task.course.name, [...(byClass.get(task.course.name) ?? []), task]);
      return [...byClass.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([label, items]) => ({ key: label, label, items, danger: false }));
    }
    const now = new Date();
    const buckets = new Map<DueBucket, TrackedTask[]>();
    for (const task of visible) {
      const bucket = dueBucket(task, now);
      buckets.set(bucket, [...(buckets.get(bucket) ?? []), task]);
    }
    return dueBucketOrder
      .filter((bucket) => buckets.has(bucket))
      .map((bucket) => {
        const items = [...buckets.get(bucket)!].sort(compareByDueDate);
        // Completed work reads newest first within "Earlier".
        if (status === "completed" && bucket === "overdue") items.reverse();
        return { key: bucket, label: dueBucketLabel(bucket, status === "completed"), items, danger: bucket === "overdue" && status === "open" };
      });
  }, [scoped, status, query, groupBy]);

  // Links from before assignments had their own page (`/?task=…`) open the assignment.
  const legacyTask = searchParams.get("task");
  if (legacyTask) return <Navigate to={`/assignment/${encodeURIComponent(legacyTask)}`} replace />;

  const refresh = async () => {
    setRefreshing(true);
    try {
      await tasksState.refresh();
    } catch {
      // The error notice shows what failed.
    } finally {
      setRefreshing(false);
    }
  };

  const refreshActive = () => void activeState.refresh().catch(() => undefined);
  const filtering = Boolean(query.trim() || classFilter);
  const clearFilters = () => { setQuery(""); setClassFilter(""); };
  const loading = tasksState.loading && !tasksState.data;
  const assistant = assistantName(provider);

  return (
    <div className="page--assignments">
      <PageHeader
        title={headline(openTasks, loading || completionUnavailable || Boolean(tasksState.error))}
        description={loading ? "Loading your classes." : tasksState.error ? "Your assignments come from Canvas Task Sync." : summary(openTasks, active.size, assistant)}
        actions={<>
          <IconButton label="Refresh assignments" icon={ArrowsClockwiseIcon} variant="ghost" disabled={refreshing} onClick={() => void refresh()} />
          <Button variant="secondary" icon={PlusIcon} disabled={!coursesState.data?.length} onClick={() => setCreating(true)}>New task</Button>
        </>}
      />

      {completionUnavailable && !tasksState.error ? (
        <div className="shell-notices">
          <Notice
            tone="warning"
            role="alert"
            title="Google Tasks completion status is unavailable"
            actions={<>
              {taskSyncUrl ? <LinkButton size="sm" href={taskSyncPages.google(taskSyncUrl)} icon={ArrowSquareOutIcon}>Open Task Sync</LinkButton> : null}
              <Button variant="secondary" size="sm" loading={refreshing} onClick={() => void refresh()}>Check again</Button>
            </>}
          >
            <p>Some assignments are hidden until Canvas Task Sync can read their status from Google. Check its Google connection, reconnect if needed, then check again.</p>
          </Notice>
        </div>
      ) : null}

      <WorkingNow items={[...active.values()]} tasks={taskIndex} onChanged={refreshActive} />

      <section className={active.size ? "section" : undefined} aria-label="Assignments">
        <div className="toolbar">
          <label className="search">
            <MagnifyingGlassIcon size={16} aria-hidden />
            <input className="control" aria-label="Search assignments" placeholder="Search assignments" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <select className="control" aria-label="Class filter" value={classFilter} onChange={(event) => setClassFilter(event.target.value)}>
            <option value="">All classes</option>
            {classes.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}
          </select>
          <div className="toolbar__end">
            <Segmented
              label="Layout"
              mode="buttons"
              value={view}
              onChange={(value) => { setView(value); saveChoice(VIEW_KEY, value); }}
              options={[
                { value: "list", label: <ListIcon size={16} aria-hidden />, ariaLabel: "List" },
                { value: "tiles", label: <SquaresFourIcon size={16} aria-hidden />, ariaLabel: "Tiles" },
              ]}
            />
            <Segmented
              label="Group assignments"
              mode="buttons"
              value={groupBy}
              onChange={(value) => { setGroupBy(value); saveChoice(GROUP_KEY, value); }}
              options={[{ value: "date", label: "By date" }, { value: "class", label: "By class" }]}
            />
            <Segmented
              label="Assignment status"
              value={status}
              onChange={setStatus}
              options={[
                { value: "open", label: "Open", count: counts.open },
                { value: "completed", label: "Done", count: counts.completed },
              ]}
            />
          </div>
        </div>

        {tasksState.error ? <ErrorNotice error={tasksState.error} title="Assignments could not load" /> : null}
        {loading ? <SkeletonRows rows={5} label="Loading assignments" /> : null}

        {!loading && !tasksState.error && groups.length === 0 && !completionUnavailable ? (
          <div className="surface">
            {allTasks.length === 0 ? (
              <EmptyState
                icon={ListChecksIcon}
                title="No assignments yet"
                body="Sync your classes in Canvas Task Sync to bring in their work, or add a task yourself."
                action={<>
                  {taskSyncUrl ? <LinkButton href={taskSyncPages.home(taskSyncUrl)} icon={ArrowSquareOutIcon}>Open Task Sync</LinkButton> : null}
                  <Button variant={taskSyncUrl ? "secondary" : "primary"} icon={PlusIcon} disabled={!coursesState.data?.length} onClick={() => setCreating(true)}>New task</Button>
                </>}
              />
            ) : filtering ? (
              <EmptyState
                icon={MagnifyingGlassIcon}
                title="No matching assignments"
                body="Try another class or search, or clear the filters."
                action={<Button variant="secondary" onClick={clearFilters}>Clear filters</Button>}
              />
            ) : status === "open" ? (
              <EmptyState icon={CheckCircleIcon} title="You're all caught up" body="Nothing is open right now. New work appears here after Canvas Task Sync syncs your classes." />
            ) : (
              <EmptyState icon={ListChecksIcon} title="Nothing completed yet" body="Assignments you check off in Google Tasks show up here." />
            )}
          </div>
        ) : null}

        {groups.map((group) => (
          <section className="group" key={group.key} aria-label={group.label}>
            <h2 className={`group-label${group.danger ? " group-label--danger" : ""}`}>{group.label}<span>{group.items.length}</span></h2>
            {view === "tiles" ? (
              <div className="assignment-tiles">
                {group.items.map((task) => <AssignmentTile key={task.logical_id} task={task} showClass={groupBy === "date"} active={active.get(task.logical_id) ?? null} onChanged={refreshActive} />)}
              </div>
            ) : (
              <div className="surface">
                {group.items.map((task) => <AssignmentRow key={task.logical_id} task={task} showClass={groupBy === "date"} active={active.get(task.logical_id) ?? null} onChanged={refreshActive} />)}
              </div>
            )}
          </section>
        ))}
      </section>

      {!loading && taskSyncUrl && allTasks.length > 0 ? (
        <p className="footnote">
          <ArrowsClockwiseIcon size={15} aria-hidden />
          <span>Assignments come from Canvas Task Sync. <a href={taskSyncPages.home(taskSyncUrl)} target="_blank" rel="noreferrer">Open Task Sync</a> to sync a class or change what it tracks.</span>
        </p>
      ) : null}

      {creating ? <TaskEditor
        task={null}
        courses={coursesState.data ?? []}
        defaultCourseId={classFilter}
        onClose={() => setCreating(false)}
        onSaved={async () => {
          setCreating(false);
          toast("Task created in Google Tasks.", "success");
          await tasksState.refresh().catch(() => undefined);
        }}
      /> : null}
    </div>
  );
}

type ItemProps = { task: TrackedTask; showClass: boolean; active: ActiveAssignment | null; onChanged: () => void };

function assignmentHref(task: TrackedTask, active: ActiveAssignment | null) {
  const path = `/assignment/${encodeURIComponent(task.logical_id)}`;
  return active?.feature ? `${path}?tab=${tabForFeature(active.feature)}` : path;
}

function Meta({ task, showClass }: { task: TrackedTask; showClass: boolean }) {
  const kind = task.task_type === "quiz" ? "Quiz" : task.task_type === "test" ? "Test" : null;
  if (!showClass && !kind && !task.due_uncertain && !task.manually_managed) return null;
  return <span className="assignment-row__meta">
    {showClass ? <span>{task.course.name}</span> : null}
    {kind ? <span className="badge badge--accent">{kind}</span> : null}
    {task.manually_managed ? <span className="badge badge--outline">Manual</span> : null}
    {task.due_uncertain ? <span className="tone-warning" title={task.due_uncertain_reason ?? undefined}>Date estimated</span> : null}
  </span>;
}

function Due({ task }: { task: TrackedTask }) {
  const overdue = task.completed === false && dueBucket(task) === "overdue";
  return <span className={`assignment-row__due${overdue ? " is-overdue" : ""}`}>
    {task.due_date ? <time dateTime={parseDueDate(task.due_date).toISOString()}>{formatDueShort(task.due_date)}</time> : "No due date"}
  </span>;
}

function WorkingBadge({ active }: { active: ActiveAssignment }) {
  const label = active.feature ? featureLabel(active.feature) : "Working";
  return <span className="badge badge--info working-badge" title={active.current}>
    <CircleNotchIcon className="spin" size={12} weight="bold" aria-hidden /><span>{label}</span>
  </span>;
}

function AssignmentRow({ task, showClass, active, onChanged }: ItemProps) {
  return (
    <div className={`row row--interactive assignment-row${task.completed ? " is-done" : ""}`}>
      <span className={`class-mark class-tone-${classTone(task.course.id)}`} aria-hidden>{classMarkText(task.course.prefix, task.course.name)}</span>
      <span className="assignment-row__main">
        <Link className="row-title stretched-link" to={assignmentHref(task, active)}>{task.completed ? <span className="sr-only">Completed: </span> : null}{task.display_title}</Link>
        <Meta task={task} showClass={showClass} />
      </span>
      <span className="assignment-row__end">
        {active ? <WorkingBadge active={active} /> : null}
        <Due task={task} />
      </span>
      <span className={`row-actions${active ? " is-shown" : ""}`}>
        <RunMenu logicalId={task.logical_id} title={task.display_title} active={active} onChanged={onChanged} />
      </span>
      <CaretRightIcon className="row-chevron" size={15} aria-hidden />
    </div>
  );
}

function AssignmentTile({ task, showClass, active, onChanged }: ItemProps) {
  return (
    <article className={`assignment-tile${task.completed ? " is-done" : ""}${active ? " is-working" : ""}`}>
      <span className="assignment-tile__class">
        <span className={`class-mark class-tone-${classTone(task.course.id)}`} aria-hidden>{classMarkText(task.course.prefix, task.course.name)}</span>
        {showClass ? <span className="truncate">{task.course.name}</span> : null}
      </span>
      <Link className="assignment-tile__title stretched-link" to={assignmentHref(task, active)}>{task.completed ? <span className="sr-only">Completed: </span> : null}{task.display_title}</Link>
      <Meta task={task} showClass={false} />
      {active ? <span className="assignment-tile__progress" title={active.current}>
        <CircleNotchIcon className="spin tone-info" size={13} weight="bold" aria-hidden />
        <span className="truncate">{active.feature ? `${featureLabel(active.feature)}: ` : ""}{active.current}</span>
      </span> : null}
      <span className="assignment-tile__foot">
        <Due task={task} />
        <span className="row-actions is-shown">
          <RunMenu logicalId={task.logical_id} title={task.display_title} active={active} onChanged={onChanged} placement="up" />
        </span>
      </span>
    </article>
  );
}

function headline(open: TrackedTask[], neutral: boolean): string {
  if (neutral) return "Assignments";
  const now = new Date();
  const buckets = open.map((task) => dueBucket(task, now));
  const overdue = buckets.filter((bucket) => bucket === "overdue").length;
  const today = buckets.filter((bucket) => bucket === "today").length;
  const week = buckets.filter((bucket) => bucket === "today" || bucket === "tomorrow" || bucket === "week").length;
  if (overdue) return overdue === 1 ? "1 assignment is overdue" : `${overdue} assignments are overdue`;
  if (today) return `${today} due today`;
  if (week) return `${week} due in the next week`;
  if (open.length) return "Nothing due this week";
  return "You're all caught up";
}

function summary(open: TrackedTask[], working: number, assistant: string): string {
  const classes = new Set(open.map((task) => task.course.id)).size;
  const today = open.filter((task) => dueBucket(task) === "today").length;
  const overdue = open.some((task) => dueBucket(task) === "overdue");
  const parts = [open.length
    ? `${open.length} open across ${classes} ${classes === 1 ? "class" : "classes"}`
    : "Nothing open"];
  if (overdue && today) parts.push(`${today} due today`);
  if (working) parts.push(`${assistant} is working on ${working === 1 ? "one assignment" : `${working} assignments`}`);
  return `${parts.join(". ")}.`;
}
