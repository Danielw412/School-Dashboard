import { CircleNotchIcon } from "@phosphor-icons/react";

import type { AgentRun } from "../types";

const labels: Record<AgentRun["status"], string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const tones: Record<AgentRun["status"], string> = {
  queued: "",
  running: "badge--info",
  completed: "badge--success",
  failed: "badge--danger",
  cancelled: "",
};

export function RunStatusBadge({ status }: { status: AgentRun["status"] }) {
  return <span className={`badge ${tones[status]}`.trim()}>
    {status === "running" ? <CircleNotchIcon className="spin" size={12} weight="bold" aria-hidden /> : null}
    {labels[status]}
  </span>;
}
