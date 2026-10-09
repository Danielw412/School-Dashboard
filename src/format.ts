import type { AgentRun, TrackedTask } from "./types";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function formatDue(value: string | null, long = false): string {
  if (!value) return "No due date";
  const date = parseDueDate(value);
  if (Number.isNaN(date.getTime())) return value;
  const dateOnly = DATE_ONLY.test(value);
  return new Intl.DateTimeFormat(undefined, long
    ? { weekday: "long", month: "long", day: "numeric", ...(dateOnly ? {} : { hour: "numeric", minute: "2-digit" }) }
    : { weekday: "short", month: "short", day: "numeric", ...(dateOnly ? {} : { hour: "numeric", minute: "2-digit" }) }
  ).format(date);
}

export function parseDueDate(value: string): Date {
  if (!DATE_ONLY.test(value)) return new Date(value);
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year!, month! - 1, day!);
}

export function isPastDue(value: string, now = new Date()): boolean {
  const due = parseDueDate(value);
  if (DATE_ONLY.test(value)) due.setHours(23, 59, 59, 999);
  return due < now;
}

// Whole calendar days from today to the date (negative in the past).
export function dayDifference(date: Date, now = new Date()): number {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((target.getTime() - start.getTime()) / 86_400_000);
}

export function formatTime(value: string | Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(typeof value === "string" ? new Date(value) : value);
}

// "Today", "Tomorrow, 3:00 PM", "Fri, Oct 10": short enough for a list row.
export function formatDueShort(value: string | null, now = new Date()): string {
  if (!value) return "No due date";
  const date = parseDueDate(value);
  if (Number.isNaN(date.getTime())) return value;
  const days = dayDifference(date, now);
  const time = DATE_ONLY.test(value) ? "" : `, ${formatTime(date)}`;
  if (days === 0) return `Today${time}`;
  if (days === 1) return `Tomorrow${time}`;
  if (days === -1) return `Yesterday${time}`;
  const sameYear = date.getFullYear() === now.getFullYear();
  const day = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(date);
  return `${day}${time}`;
}

export type DueBucket = "overdue" | "today" | "tomorrow" | "week" | "later" | "none";
export const dueBucketOrder: DueBucket[] = ["overdue", "today", "tomorrow", "week", "later", "none"];

export function dueBucket(task: TrackedTask, now = new Date()): DueBucket {
  if (!task.due_date) return "none";
  if (isPastDue(task.due_date, now)) return "overdue";
  const days = dayDifference(parseDueDate(task.due_date), now);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  if (days <= 7) return "week";
  return "later";
}

export function dueBucketLabel(bucket: DueBucket, completed = false): string {
  if (bucket === "overdue") return completed ? "Earlier" : "Overdue";
  return { today: "Today", tomorrow: "Tomorrow", week: "Next 7 days", later: "Later", none: "No due date" }[bucket];
}

export function isAssessment(task: TrackedTask): boolean {
  return /\b(test|quiz|exam|midterm|final|assessment)\b/i.test(`${task.display_title} ${task.task_type ?? ""}`);
}

export function classTone(value: string): number {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return Math.abs(hash) % 6;
}

export function classMarkText(prefix: string, name = ""): string {
  const source = prefix.trim() || name.trim();
  return source.slice(0, 3).toUpperCase() || "?";
}

export function formatRelative(value?: string | null, now = new Date()): string {
  if (!value) return "never";
  const seconds = Math.round((now.getTime() - new Date(value).getTime()) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3_600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 6 * 3_600) return `${Math.round(seconds / 3_600)} hr ago`;
  const days = dayDifference(new Date(value), now);
  if (days === 0) return `today at ${formatTime(value)}`;
  if (days === -1) return `yesterday at ${formatTime(value)}`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value));
}

export function formatDayHeading(value: string, now = new Date()): string {
  const days = dayDifference(new Date(value), now);
  if (days === 0) return "Today";
  if (days === -1) return "Yesterday";
  const sameYear = new Date(value).getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(new Date(value));
}

export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  if (minutes) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function runDuration(run: Pick<AgentRun, "startedAt" | "completedAt">, now = Date.now()): string {
  const end = run.completedAt ? new Date(run.completedAt).getTime() : now;
  return formatElapsed(end - new Date(run.startedAt).getTime());
}

export function formatTokens(usage: AgentRun["usage"]): string | null {
  if (!usage) return null;
  return `${(usage.input_tokens + usage.output_tokens).toLocaleString()} tokens`;
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function latestRun(runs: AgentRun[], logicalId: string, feature: AgentRun["feature"]) {
  return runs.find((run) => run.logicalId === logicalId && run.feature === feature);
}

export function latestCompletedRun(runs: AgentRun[], logicalId: string, feature: AgentRun["feature"]) {
  return runs.find((run) => run.logicalId === logicalId && run.feature === feature && run.status === "completed");
}

export function compareByDueDate(left: TrackedTask, right: TrackedTask): number {
  if (!left.due_date && !right.due_date) return left.display_title.localeCompare(right.display_title);
  if (!left.due_date) return 1;
  if (!right.due_date) return -1;
  const difference = parseDueDate(left.due_date).getTime() - parseDueDate(right.due_date).getTime();
  return difference || left.display_title.localeCompare(right.display_title);
}

export function sentenceCase(value: string): string {
  const text = value.replaceAll("_", " ").trim();
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
}
