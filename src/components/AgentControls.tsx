import {
  AsteriskIcon,
  CaretDownIcon,
  CircleNotchIcon,
  HardDrivesIcon,
  LaptopIcon,
  TerminalWindowIcon,
  WarningCircleIcon,
  type Icon,
} from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { hasAgentChoices } from "../agent-status";
import { type AgentProvider, effortLabel, effortLevels, type EffortChoice, providerLabel } from "../models";
import type { AgentExecutionStatus, AgentExecutionTarget } from "../types";
import { useToast } from "../toast";
import { StatusIcon } from "./ui";

const targetIcons: Record<AgentExecutionTarget, Icon> = { local: HardDrivesIcon, worker: LaptopIcon };
const providerIcons: Record<AgentProvider, Icon> = { codex: TerminalWindowIcon, claude: AsteriskIcon };

export function AgentTargetIcon({ target, size = 15 }: { target: AgentExecutionTarget; size?: number }) {
  const IconComponent = targetIcons[target];
  return <IconComponent size={size} aria-hidden />;
}

export function AgentProviderIcon({ provider, size = 15 }: { provider: AgentProvider; size?: number }) {
  const IconComponent = providerIcons[provider];
  return <IconComponent size={size} weight={provider === "claude" ? "bold" : "regular"} aria-hidden />;
}

export type AgentSelectionChange = { target?: AgentExecutionTarget; provider?: AgentProvider; effort?: EffortChoice };

const effortChoices: EffortChoice[] = ["default", ...effortLevels];

// Where new runs go when the dashboard has both a server and a laptop worker: one click in the top
// bar, because it's the switch to reach for when the laptop goes offline. Runs already underway
// stay where they started.
export function TargetSwitch({ agents, onChange }: {
  agents: AgentExecutionStatus | null;
  onChange: (change: AgentSelectionChange) => Promise<void>;
}) {
  const [pending, setPending] = useState<AgentExecutionTarget | null>(null);
  const toast = useToast();
  const targets = agents?.targets ?? [];
  if (!agents || targets.length < 2) return null;
  const selected = pending ?? agents.mode;

  const choose = async (target: AgentExecutionTarget) => {
    if (pending || target === agents.mode) return;
    setPending(target);
    try {
      await onChange({ target });
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not change where agents run.", "error");
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="target-switch" role="group" aria-label="Run agents on">
      {targets.map((target) => (
        <button
          key={target.id}
          type="button"
          className="target-switch__option"
          aria-pressed={target.id === selected}
          aria-label={`${target.label}${target.available ? "" : " (unavailable)"}`}
          title={`${target.message}${target.activeJobs || target.queuedJobs ? ` ${target.activeJobs} running, ${target.queuedJobs} waiting.` : ""}`}
          disabled={Boolean(pending)}
          onClick={() => void choose(target.id)}
        >
          {pending === target.id ? <CircleNotchIcon className="spin" size={15} aria-hidden /> : <AgentTargetIcon target={target.id} />}
          <span className="target-switch__label">{target.label}</span>
          {target.available ? null : <WarningCircleIcon className="tone-warning" size={14} weight="fill" aria-hidden />}
        </button>
      ))}
    </div>
  );
}

// The top bar's agent switch: which agent runs new runs (Codex or Claude) and a quick effort level
// for that agent. Runs already underway keep what they started with.
export function AgentSwitcher({ agents, onChange, defaultEffort }: {
  agents: AgentExecutionStatus | null;
  onChange: (change: AgentSelectionChange) => Promise<void>;
  // The Settings effort each agent uses when the quick effort is "default".
  defaultEffort?: Partial<Record<AgentProvider, string>>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<AgentSelectionChange | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  if (!agents || !hasAgentChoices(agents)) return null;
  const providers = agents.providers ?? [];
  const targets = agents.targets ?? [];
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
      ? `${busy.activeJobs} running${busy.queuedJobs ? `, ${busy.queuedJobs} waiting` : ""}`
      : "ready"
    : selectedTarget?.id === "worker" && (!agents.worker || agents.worker.disconnectedAt) ? "offline" : "unavailable";
  const where = selectedTarget?.host ?? selectedTarget?.label ?? null;
  const detail = `${providerLabel(provider)}${where ? ` on ${where}` : ""} · ${state}`;
  const fallbackEffort = defaultEffort?.[provider];

  return (
    <div
      className="popover-root"
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={`agent-switch${agents.available ? "" : " agent-switch--warning"}`}
        aria-label="Agent settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={agents.available ? `${providerLabel(provider)} runs new agent runs${where ? ` on ${where}` : ""}` : agents.message}
        onClick={() => setOpen((value) => !value)}
      >
        {agents.available ? <AgentProviderIcon provider={provider} /> : <WarningCircleIcon size={15} weight="fill" aria-hidden />}
        <span>{providerLabel(provider)}</span>
        <CaretDownIcon className="agent-switch__caret" size={12} weight="bold" aria-hidden />
      </button>
      {open ? (
        <div className="popover" id={panelId} role="dialog" aria-label="Agent settings">
          {providers.length > 1 ? (
            <ChoiceGroup
              title="Agent"
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
          {agents.effort ? (
            <div className="agent-panel__group">
              <div className="agent-panel__row">
                <label className="agent-panel__label" htmlFor={`${panelId}-effort`}>Effort</label>
                <select
                  id={`${panelId}-effort`}
                  className="control control--sm"
                  aria-label={`${providerLabel(provider)} effort`}
                  value={effort}
                  disabled={Boolean(pending)}
                  onChange={(event) => void change({ provider, effort: event.target.value as EffortChoice })}
                >
                  {effortChoices.map((choice) => <option key={choice} value={choice}>
                    {choice === "default" && fallbackEffort ? `Default (${effortLabel(fallbackEffort)})` : effortLabel(choice)}
                  </option>)}
                </select>
              </div>
              <small className="field__help">Default follows Settings, with Extra high for assigned problems.</small>
            </div>
          ) : null}
          <p className={`agent-panel__status${error ? " is-error" : ""}`} role={error ? "alert" : undefined} title={error ? undefined : selectedTarget?.message ?? agents.message}>
            {error ? <WarningCircleIcon size={15} weight="fill" aria-hidden /> : <StatusIcon state={available ? busy.activeJobs ? "running" : "ok" : "warning"} size={15} />}
            <span>{error ?? detail}</span>
          </p>
          <div className="agent-panel__foot">
            <Link className="text-link" to="/settings?section=agents" onClick={() => setOpen(false)}>Models and defaults</Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ChoiceGroup<Id extends string>({ title, options, selected, pending, disabled, onSelect }: {
  title: string;
  options: Array<{ id: Id; label: string; available: boolean; message: string; icon: ReactNode }>;
  selected: Id;
  pending: Id | null;
  disabled: boolean;
  onSelect: (id: Id) => void;
}) {
  const titleId = useId();
  return (
    <div className="agent-panel__group">
      <span className="agent-panel__label" id={titleId}>{title}</span>
      <div className="agent-panel__options" role="group" aria-labelledby={titleId}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className="agent-panel__option"
            aria-pressed={option.id === selected}
            aria-label={`${option.label}${option.available ? "" : " (unavailable)"}`}
            title={option.message}
            disabled={disabled}
            onClick={() => onSelect(option.id)}
          >
            {pending === option.id ? <CircleNotchIcon className="spin" size={15} aria-hidden /> : option.icon}
            <span>{option.label}</span>
            {option.available ? null : <WarningCircleIcon className="tone-warning" size={14} weight="fill" aria-hidden />}
          </button>
        ))}
      </div>
    </div>
  );
}
