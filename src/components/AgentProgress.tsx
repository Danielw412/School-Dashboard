import { CaretRightIcon, CheckIcon, CircleNotchIcon, WarningCircleIcon, WrenchIcon, XCircleIcon } from "@phosphor-icons/react";

import { schoolApi } from "../api";
import { formatElapsed, formatTime } from "../format";
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

// What the agent is doing now, with its activity log. A finished run's log folds away behind one
// line so the result stays the focus.
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
  const entries = progress?.entries ?? [];
  const timeline = entries.length ? (
    <ol className="progress-timeline">
      {entries.map((entry) => {
        const Icon = entry.status === "failed" ? XCircleIcon
          : entry.status === "warning" ? WarningCircleIcon
            : entry.status === "started" ? CircleNotchIcon
              : entry.tool ? WrenchIcon : CheckIcon;
        return (
          <li className={entry.status} key={entry.id}>
            <span className="progress-entry-icon">
              <Icon className={entry.status === "started" ? "spin" : undefined} size={14} weight="bold" aria-hidden />
            </span>
            <span>{entry.message}</span>
            <time>{formatTime(entry.timestamp)}</time>
          </li>
        );
      })}
    </ol>
  ) : null;
  return (
    <section className={`progress-panel ${compact ? "compact" : ""}`} aria-live={active ? "polite" : "off"}>
      <div className="progress-current">
        <span className={`progress-spinner ${active ? "active" : ""}`}>
          {active ? <CircleNotchIcon className="spin" size={16} weight="bold" aria-hidden /> : <CheckIcon size={15} weight="bold" aria-hidden />}
        </span>
        <div>
          <strong>{progress?.current ?? fallbackCurrent ?? (loading ? "Loading agent activity" : "Run activity")}</strong>
          {progress ? <span>{formatElapsed(progress.elapsedMs)}</span> : null}
        </div>
      </div>
      {active || !timeline ? timeline : (
        <details className="reveal">
          <summary><CaretRightIcon size={13} weight="bold" aria-hidden />Activity log ({entries.length})</summary>
          {timeline}
        </details>
      )}
    </section>
  );
}
