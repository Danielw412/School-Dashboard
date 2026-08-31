import { AlertCircle, Check, LoaderCircle, Wrench } from "lucide-react";

import { schoolApi } from "../api";
import { usePolling } from "../hooks/usePolling";
import type { AgentProgress, AgentRun } from "../types";

export function RunProgressPanel({ run, compact = false }: { run: AgentRun; compact?: boolean }) {
  const active = run.status === "queued" || run.status === "running";
  const progress = usePolling(() => schoolApi.runProgress(run.id), active ? 1_500 : 0);
  return (
    <ProgressTimeline
      progress={progress.data}
      active={active}
      loading={progress.loading}
      compact={compact}
    />
  );
}

export function ProgressTimeline({
  progress,
  active,
  loading = false,
  compact = false,
  fallbackCurrent,
}: {
  progress: AgentProgress | null;
  active: boolean;
  loading?: boolean;
  compact?: boolean;
  fallbackCurrent?: string;
}) {
  const entries = progress?.entries.slice(0, compact ? 3 : 7) ?? [];
  return (
    <section className={`progress-panel ${compact ? "compact" : ""}`} aria-live={active ? "polite" : "off"}>
      <div className="progress-current">
        <span className={`progress-spinner ${active ? "active" : ""}`}>
          {active ? <LoaderCircle className="spin" size={18} /> : <Check size={18} />}
        </span>
        <div>
          <strong>{progress?.current ?? fallbackCurrent ?? (loading ? "Loading agent activity" : "Run activity")}</strong>
          {progress ? <span>{formatElapsed(progress.elapsedMs)}</span> : null}
        </div>
      </div>
      {entries.length ? (
        <ol className="progress-timeline">
          {entries.map((entry) => {
            const Icon = entry.status === "failed" ? AlertCircle : entry.status === "started" ? LoaderCircle : entry.tool ? Wrench : Check;
            return (
              <li className={entry.status} key={entry.id}>
                <Icon className={entry.status === "started" ? "spin" : ""} size={14} />
                <span>{entry.message}</span>
                <time>{formatTime(entry.timestamp)}</time>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  if (minutes) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
