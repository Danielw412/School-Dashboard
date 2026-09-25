import { Asterisk, Laptop, LoaderCircle, Server, SquareTerminal, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { type AgentProvider, effortLabel, effortLevels, type EffortChoice, providerLabel } from "../models";
import type { AgentExecutionStatus, AgentExecutionTarget } from "../types";

const targetIcons: Record<AgentExecutionTarget, LucideIcon> = { local: Server, worker: Laptop };
const providerIcons: Record<AgentProvider, LucideIcon> = { codex: SquareTerminal, claude: Asterisk };

export function AgentTargetIcon({ target, size = 14 }: { target: AgentExecutionTarget; size?: number }) {
  const Icon = targetIcons[target];
  return <Icon size={size} strokeWidth={1.9} />;
}

export function AgentProviderIcon({ provider, size = 14 }: { provider: AgentProvider; size?: number }) {
  const Icon = providerIcons[provider];
  return <Icon size={size} strokeWidth={1.9} />;
}

export type AgentSelectionChange = { target?: AgentExecutionTarget; provider?: AgentProvider; effort?: EffortChoice };

const effortChoices: EffortChoice[] = ["default", ...effortLevels];

// The sidebar's agent controls: which agent runs new runs (Codex or Claude), where it runs (the
// dashboard server or the laptop, when both exist), and a quick effort level for that agent. Runs
// already underway keep what they started with.
export function AgentControls({ agents, onChange }: {
  agents: AgentExecutionStatus | null;
  onChange: (change: AgentSelectionChange) => Promise<void>;
}) {
  const [pending, setPending] = useState<AgentSelectionChange | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!agents) return null;
  const providers = agents.providers ?? [];
  const targets = agents.targets ?? [];
  if (providers.length < 2 && targets.length < 2) return null;
  const provider = pending?.provider ?? agents.provider ?? "codex";
  const targetId = pending?.target ?? agents.mode;
  const effort = pending?.effort ?? agents.effort?.[provider] ?? "default";
  const selectedTarget = targets.find((target) => target.id === targetId) ?? targets[0] ?? null;

  const change = async (next: AgentSelectionChange) => {
    if (pending) return;
    setPending(next);
    setError(null);
    try {
      await onChange(next);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not change the agent settings.");
    } finally {
      setPending(null);
    }
  };

  const available = selectedTarget?.available ?? agents.available;
  const busy = selectedTarget ?? agents;
  const state = available
    ? busy.activeJobs || busy.queuedJobs
      ? `${busy.activeJobs} running${busy.queuedJobs ? ` · ${busy.queuedJobs} waiting` : ""}`
      : "ready"
    : selectedTarget?.id === "worker" && (!agents.worker || agents.worker.disconnectedAt) ? "offline" : "unavailable";
  const where = selectedTarget?.host ?? selectedTarget?.label ?? null;
  const detail = `${providerLabel(provider)}${where ? ` on ${where}` : ""} · ${state}`;
  return (
    <section className="agent-target" aria-label="Agent settings">
      {providers.length > 1 ? (
        <SegmentedChoice
          title="Agent"
          id="agent-provider-title"
          options={providers.map((option) => ({
            id: option.id,
            label: option.label,
            available: option.available,
            message: option.message,
            icon: <AgentProviderIcon provider={option.id} />,
          }))}
          selected={provider}
          pending={pending?.provider ?? null}
          disabled={Boolean(pending)}
          onSelect={(id) => void (id !== agents.provider && change({ provider: id }))}
        />
      ) : null}
      {targets.length > 1 ? (
        <SegmentedChoice
          title="Run agents on"
          id="agent-target-title"
          options={targets.map((option) => ({
            id: option.id,
            label: option.label,
            available: option.available,
            message: option.message,
            icon: <AgentTargetIcon target={option.id} />,
          }))}
          selected={targetId}
          pending={pending?.target ?? null}
          disabled={Boolean(pending)}
          onSelect={(id) => void (id !== agents.mode && change({ target: id }))}
        />
      ) : null}
      {agents.effort ? (
        <label className="agent-effort" title="Default uses the effort set in Settings, with Extra high for assigned problems. Any other level applies to every new run.">
          <span>Effort</span>
          <select
            aria-label={`${providerLabel(provider)} effort`}
            value={effort}
            disabled={Boolean(pending)}
            onChange={(event) => void change({ provider, effort: event.target.value as EffortChoice })}
          >
            {effortChoices.map((choice) => <option key={choice} value={choice}>{effortLabel(choice)}</option>)}
          </select>
        </label>
      ) : null}
      <p className={`agent-target-detail ${error ? "error" : ""}`} role={error ? "alert" : undefined} title={error ? undefined : selectedTarget?.message ?? agents.message}>
        {error ?? detail}
      </p>
    </section>
  );
}

function SegmentedChoice<Id extends string>({ title, id, options, selected, pending, disabled, onSelect }: {
  title: string;
  id: string;
  options: Array<{ id: Id; label: string; available: boolean; message: string; icon: ReactNode }>;
  selected: Id;
  pending: Id | null;
  disabled: boolean;
  onSelect: (id: Id) => void;
}) {
  return (
    <div className="agent-choice">
      <span className="agent-target-title" id={id}>{title}</span>
      <div className="agent-target-options" role="group" aria-labelledby={id}>
        {options.map((option) => {
          const active = option.id === selected;
          return (
            <button
              key={option.id}
              type="button"
              className={active ? "active" : ""}
              aria-pressed={active}
              aria-label={`${option.label}${option.available ? "" : " (unavailable)"}`}
              title={option.message}
              disabled={disabled}
              onClick={() => onSelect(option.id)}
            >
              {pending === option.id ? <LoaderCircle className="spin" size={14} /> : option.icon}
              <span>{option.label}</span>
              <span className={`agent-target-dot ${option.available ? "ok" : "warn"}`} aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
