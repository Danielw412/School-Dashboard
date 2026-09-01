import { AlertCircle, CheckCircle2, CircleOff, LoaderCircle } from "lucide-react";

export function RunStatus({ status }: { status: "queued" | "running" | "completed" | "failed" | "cancelled" }) {
  const Icon = status === "completed" ? CheckCircle2 : status === "failed" ? AlertCircle : status === "cancelled" ? CircleOff : LoaderCircle;
  return <span className={`run-status ${status}`}><Icon size={14} className={status === "running" ? "spin" : ""} />{status}</span>;
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><div className="empty-glyph">◎</div><h3>{title}</h3><p>{detail}</p></div>;
}

export function ErrorNotice({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  return <div className="notice error"><AlertCircle size={18} /><div><strong>Couldn’t load this view</strong><p>{message}</p></div></div>;
}
