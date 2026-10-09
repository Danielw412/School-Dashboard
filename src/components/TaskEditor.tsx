import { useState } from "react";

import { schoolApi } from "../api";
import type { ManualTaskInput, TaskCourse, TrackedTask } from "../types";
import { Button, Disclosure, ErrorNotice, Field, Segmented, Sheet } from "./ui";

const TASK_ACTIONS: ManualTaskInput["action_kind"][] = [
  "complete", "practice", "bring", "present", "submit", "read", "study", "write", "other",
];

// Creates or edits a task in Google Tasks through Canvas Task Sync. Matches Task Sync's own task
// editor so a task looks the same from either app.
export function TaskEditor({ task, courses, defaultCourseId, onClose, onSaved }: {
  task: TrackedTask | null;
  courses: TaskCourse[];
  defaultCourseId?: string | null;
  onClose: () => void;
  onSaved: (saved: TrackedTask, created: boolean) => Promise<void> | void;
}) {
  const initialCourse = courses.some((course) => course.id === defaultCourseId) ? defaultCourseId! : courses[0]?.id ?? "";
  const [form, setForm] = useState<ManualTaskInput>(() => taskForm(task, initialCourse));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const update = <K extends keyof ManualTaskInput>(key: K, value: ManualTaskInput[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = task ? await schoolApi.updateTask(task.logical_id, form) : await schoolApi.createTask(form);
      await onSaved(saved, !task);
    } catch (saveError) {
      setError(saveError);
      setSaving(false);
    }
  };

  const hasLinks = Boolean(form.source_url || form.assignment_url);
  const close = () => { if (!saving) onClose(); };

  return <Sheet
    title={task ? "Edit task" : "New task"}
    description={task ? `${task.course.name}, in ${task.google_task.tasklist_title ?? "Google Tasks"}` : "Saved straight to Google Tasks."}
    onClose={close}
    footer={<>
      <span className="sheet__footer-spacer" />
      <Button variant="ghost" disabled={saving} onClick={close}>Cancel</Button>
      <Button loading={saving} disabled={!form.title.trim() || !form.course_id} onClick={() => void save()}>{task ? "Save changes" : "Create task"}</Button>
    </>}
  >
    {error ? <ErrorNotice error={error} title="The task wasn't saved" /> : null}
    <Field label="Task name"><input className="control" value={form.title} onChange={(event) => update("title", event.target.value)} /></Field>
    <div className="form-grid">
      <Field label="Class" help={task ? "Fixed after creation, along with its task list." : undefined}>
        <select className="control" value={form.course_id} disabled={Boolean(task)} onChange={(event) => update("course_id", event.target.value)}>
          {courses.map((course) => <option key={course.id} value={course.id}>{course.settings.name}</option>)}
        </select>
      </Field>
      <Field label="Due date"><input className="control" type="date" value={form.due_date ?? ""} onChange={(event) => update("due_date", event.target.value || null)} /></Field>
    </div>
    <div className="field">
      <span className="field__label">Status</span>
      <Segmented
        label="Task status"
        value={form.completed ? "completed" : "open"}
        onChange={(value) => update("completed", value === "completed")}
        options={[{ value: "open", label: "Open" }, { value: "completed", label: "Completed" }]}
      />
    </div>
    <Field label="Description / notes"><textarea className="control" rows={5} value={form.details} onChange={(event) => update("details", event.target.value)} /></Field>
    <div className="form-grid form-grid--3">
      <Field label="Type">
        <select className="control" value={form.task_type} onChange={(event) => update("task_type", event.target.value as ManualTaskInput["task_type"])}>
          <option value="assignment">Assignment</option><option value="quiz">Quiz</option><option value="test">Test</option>
        </select>
      </Field>
      <Field label="Classification">
        <select className="control" value={form.classification} onChange={(event) => update("classification", event.target.value as ManualTaskInput["classification"])}>
          <option value="homework">Homework</option><option value="classwork">Classwork</option>
        </select>
      </Field>
      <Field label="Action">
        <select className="control" value={form.action_kind} onChange={(event) => update("action_kind", event.target.value as ManualTaskInput["action_kind"])}>
          {TASK_ACTIONS.map((action) => <option key={action} value={action}>{action[0]!.toUpperCase()}{action.slice(1)}</option>)}
        </select>
      </Field>
    </div>
    <Disclosure title="Links" hint="A Canvas assignment link lets agents work on a task you add" defaultOpen={hasLinks || !task}>
      <div className="form-stack">
        <Field label="Canvas assignment URL"><input className="control" type="url" placeholder="https://" value={form.assignment_url ?? ""} onChange={(event) => update("assignment_url", event.target.value || null)} /></Field>
        <Field label="Source URL"><input className="control" type="url" placeholder="https://" value={form.source_url ?? ""} onChange={(event) => update("source_url", event.target.value || null)} /></Field>
      </div>
    </Disclosure>
  </Sheet>;
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
