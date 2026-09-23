import { Laptop, LoaderCircle, Server, type LucideIcon } from "lucide-react";
import { useState } from "react";

import type { AgentExecutionStatus, AgentExecutionTarget } from "../types";

const targetIcons: Record<AgentExecutionTarget, LucideIcon> = { local: Server, worker: Laptop };

export function AgentTargetIcon({ target, size = 14 }: { target: AgentExecutionTarget; size?: number }) {
  const Icon = targetIcons[target];
  return <Icon size={size} strokeWidth={1.9} />;
}

// Chooses where new agent runs execute: Codex on the dashboard server or on the laptop worker.
// Runs already underway finish where they started. Hidden when only one target exists.
export function AgentTargetSwitch({ agents, onSelect }: {
  agents: AgentExecutionStatus | null;
  onSelect: (target: AgentExecutionTarget) => Promise<void>;
}) {
  const [pending, setPending] = useState<AgentExecutionTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const targets = agents?.targets ?? [];
  if (!agents || targets.length < 2) return null;
  const selectedId = pending ?? agents.mode;
  const selected = targets.find((target) => target.id === selectedId) ?? targets[0]!;

  const choose = async (target: AgentExecutionTarget) => {
    if (pending || target === agents.mode) return;
    setPending(target);
    setError(null);
    try {
      await onSelect(target);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not switch where agents run.");
    } finally {
      setPending(null);
    }
  };

  const state = selected.available
    ? selected.activeJobs || selected.queuedJobs
      ? `${selected.activeJobs} running${selected.queuedJobs ? ` · ${selected.queuedJobs} waiting` : ""}`
      : "ready"
    : selected.id === "worker" ? "offline" : "unavailable";
  return (
    <section className="agent-target" aria-labelledby="agent-target-title">
      <span className="agent-target-title" id="agent-target-title">Run agents on</span>
      <div className="agent-target-options" role="group" aria-labelledby="agent-target-title">
        {targets.map((target) => {
          const active = target.id === selectedId;
          return (
            <button
              key={target.id}
              type="button"
              className={active ? "active" : ""}
              aria-pressed={active}
              aria-label={`${target.label}${target.available ? "" : " (unavailable)"}`}
              title={target.message}
              disabled={Boolean(pending)}
              onClick={() => void choose(target.id)}
            >
              {pending === target.id ? <LoaderCircle className="spin" size={14} /> : <AgentTargetIcon target={target.id} />}
              <span>{target.label}</span>
              <span className={`agent-target-dot ${target.available ? "ok" : "warn"}`} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <p className={`agent-target-detail ${error ? "error" : ""}`} role={error ? "alert" : undefined} title={error ? undefined : selected.message}>
        {error ?? `${selected.host ?? selected.label} · ${state}`}
      </p>
    </section>
  );
}
