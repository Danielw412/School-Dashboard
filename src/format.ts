import type { AgentRun, TrackedTask } from "./types";

export function formatDue(value: string | null, long = false): string {
  if (!value) return "No due date";
  const date = parseDueDate(value);
  if (Number.isNaN(date.getTime())) return value;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  return new Intl.DateTimeFormat(undefined, long
    ? { weekday: "long", month: "long", day: "numeric", ...(dateOnly ? {} : { hour: "numeric", minute: "2-digit" }) }
    : { weekday: "short", month: "short", day: "numeric", ...(dateOnly ? {} : { hour: "numeric", minute: "2-digit" }) }
  ).format(date);
}

export function parseDueDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(value);
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year!, month! - 1, day!);
}

export function isPastDue(value: string, now = new Date()): boolean {
  const due = parseDueDate(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) due.setHours(23, 59, 59, 999);
  return due < now;
}

export function dueBucket(task: TrackedTask): string {
  if (!task.due_date) return "Later / no due date";
  const due = parseDueDate(task.due_date);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const next = new Date(tomorrow);
  next.setDate(tomorrow.getDate() + 1);
  if (isPastDue(task.due_date, now)) return "Overdue";
  if (due < tomorrow) return "Today";
  if (due < next) return "Tomorrow";
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(due);
}

export function isAssessment(task: TrackedTask): boolean {
  return /\b(test|quiz|exam|midterm|final|assessment)\b/i.test(`${task.display_title} ${task.task_type ?? ""}`);
}

export function classTone(value: string): number {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return Math.abs(hash) % 6;
}

export function relativeTime(value: string): string {
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  if (Math.abs(minutes) < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function latestRun(runs: AgentRun[], logicalId: string, feature: AgentRun["feature"]) {
  return runs.find((run) => run.logicalId === logicalId && run.feature === feature);
}
