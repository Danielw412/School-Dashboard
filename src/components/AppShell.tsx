import { Activity, CloudOff, LayoutList, LoaderCircle, Menu, Settings, X, type LucideIcon } from "lucide-react";
import { useState, type PropsWithChildren } from "react";
import { NavLink } from "react-router-dom";

import { AgentStatusContext, selectedAgentTarget } from "../agent-status";
import { schoolApi } from "../api";
import { usePolling } from "../hooks/usePolling";
import { providerLabel } from "../models";
import { AgentControls, AgentProviderIcon, type AgentSelectionChange, AgentTargetIcon } from "./AgentControls";

const navItems = [
  { to: "/", label: "My work", icon: LayoutList },
  { to: "/runs", label: "Agent runs", icon: Activity },
  { to: "/settings", label: "Settings", icon: Settings },
];

const logoSrc = "/school-dashboard-logo.png";

export function AppShell({ children }: PropsWithChildren) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const activeWork = usePolling(schoolApi.activeWork, 2_500);
  const hasActiveWork = Boolean(activeWork.data?.runs.length || activeWork.data?.workflows.length);
  const agents = activeWork.data?.agents ?? null;
  const selectedTarget = selectedAgentTarget(agents);
  const provider = agents?.provider ?? "codex";
  const hasChoices = (agents?.targets?.length ?? 0) > 1 || (agents?.providers?.length ?? 0) > 1;
  // When the selected agent cannot run where it is selected, offer the other machine for the
  // same agent, or else the other agent on the same machine, if either can take runs right now.
  const fallbackTarget = agents && !agents.available
    ? agents.targets?.find((target) => target.id !== agents.mode && target.available) ?? null
    : null;
  const fallbackProvider = agents && !agents.available && !fallbackTarget
    ? agents.providers?.find((option) => option.id !== provider && option.available) ?? null
    : null;
  const changeAgents = async (change: AgentSelectionChange) => {
    const status = await schoolApi.updateAgentSelection(change);
    activeWork.setData((current) => current ? { ...current, agents: status } : current);
  };
  return (
    <AgentStatusContext.Provider value={agents}>
      <div className="app-shell">
        <aside className={`sidebar ${mobileOpen ? "is-open" : ""}`}>
          <div className="brand">
            <span className="brand-mark"><img className="school-logo" src={logoSrc} alt="" /></span>
            <strong>School Dashboard</strong>
          </div>
          {mobileOpen ? <button className="mobile-close icon-button" aria-label="Close navigation" onClick={() => setMobileOpen(false)}>
            <X size={20} />
          </button> : null}
          <nav aria-label="Primary navigation">
            {navItems.map(({ to, label, icon: Icon }) => (
              <NavLink key={to} to={to} end={to === "/"} onClick={() => setMobileOpen(false)}>
                <NavigationIcon icon={Icon} loading={to === "/" && hasActiveWork} />
                <span>{label}</span>
              </NavLink>
            ))}
          </nav>
          <AgentControls agents={agents} onChange={changeAgents} />
        </aside>
        {mobileOpen ? <button className="scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} /> : null}
        <main className="main-stage">
          <header className="mobile-header">
            <button className="icon-button" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Menu size={21} /></button>
            <div className="mobile-brand">
              <span className="mobile-brand-mark"><img className="school-logo" src={logoSrc} alt="" /></span>
              <span>School Dashboard</span>
            </div>
            <div className="mobile-header-actions">
              {hasActiveWork ? <LoaderCircle className="spin" size={17} /> : null}
              {agents && hasChoices ? (
                <button
                  className={`agent-target-chip ${agents.available ? "" : "warn"}`}
                  aria-label={`${providerLabel(provider)} runs new agent runs${selectedTarget ? ` on the ${selectedTarget.label.toLowerCase()}` : ""}. Change agent settings`}
                  onClick={() => setMobileOpen(true)}
                >
                  <AgentProviderIcon provider={provider} size={13} />
                  {providerLabel(provider)}{selectedTarget && (agents.targets?.length ?? 0) > 1 ? ` · ${selectedTarget.label}` : ""}
                </button>
              ) : null}
            </div>
          </header>
          {agents && !agents.available ? (
            <div className="notice amber agents-offline-banner" role="status">
              <CloudOff size={17} />
              <div><strong>Agents unavailable</strong><p>{agents.message} Tasks, past results, and settings still work.</p></div>
              {fallbackTarget ? (
                <button className="secondary-button" onClick={() => void changeAgents({ target: fallbackTarget.id }).catch(() => undefined)}>
                  <AgentTargetIcon target={fallbackTarget.id} />
                  Run on the {fallbackTarget.label.toLowerCase()} instead
                </button>
              ) : fallbackProvider ? (
                <button className="secondary-button" onClick={() => void changeAgents({ provider: fallbackProvider.id }).catch(() => undefined)}>
                  <AgentProviderIcon provider={fallbackProvider.id} />
                  Use {fallbackProvider.label} instead
                </button>
              ) : null}
            </div>
          ) : null}
          {children}
        </main>
        <nav className="mobile-nav" aria-label="Mobile navigation">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === "/"}>
              <NavigationIcon icon={Icon} loading={to === "/" && hasActiveWork} size={19} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </AgentStatusContext.Provider>
  );
}

function NavigationIcon({ icon: Icon, loading, size = 18 }: { icon: LucideIcon; loading: boolean; size?: number }) {
  return loading
    ? <LoaderCircle className="spin" size={size} strokeWidth={1.8} />
    : <Icon size={size} strokeWidth={1.8} />;
}
