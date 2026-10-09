import {
  ArrowUpRightIcon,
  ChalkboardTeacherIcon,
  CheckCircleIcon,
  ClockCounterClockwiseIcon,
  CloudSlashIcon,
  GearSixIcon,
  ListChecksIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useCallback, useMemo, type PropsWithChildren } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";

import { AgentStatusContext } from "../agent-status";
import { schoolApi } from "../api";
import { usePolling } from "../hooks/usePolling";
import { ShellContext } from "../shell-context";
import { taskSyncBaseUrl } from "../task-sync-links";
import { AgentProviderIcon, AgentSwitcher, type AgentSelectionChange, AgentTargetIcon, TargetSwitch } from "./AgentControls";
import { ToastProvider } from "./Toasts";
import { Button, Notice } from "./ui";

const navigation = [
  { to: "/", label: "Assignments", icon: ListChecksIcon, match: (path: string) => path === "/" || path.startsWith("/assignment/") },
  { to: "/runs", label: "Runs", icon: ClockCounterClockwiseIcon, match: (path: string) => path.startsWith("/runs") },
  { to: "/classes", label: "Classes", icon: ChalkboardTeacherIcon, match: (path: string) => path.startsWith("/classes") },
];

const logoSrc = "/school-dashboard-logo.png";
const HEALTH_INTERVAL_MS = 120_000;

export function AppShell({ children }: PropsWithChildren) {
  const location = useLocation();
  const activeWork = usePolling(schoolApi.activeWork, 2_500);
  const health = usePolling(schoolApi.health, HEALTH_INTERVAL_MS);
  const settingsState = usePolling(schoolApi.settings);
  const settings = settingsState.data;
  const agents = activeWork.data?.agents ?? null;
  const provider = agents?.provider ?? "codex";
  const working = Boolean(activeWork.data?.runs.length || activeWork.data?.workflows.length);

  const refreshSettings = settingsState.refresh;
  const reloadSettings = useCallback(() => void refreshSettings().catch(() => undefined), [refreshSettings]);
  const taskSyncUrl = taskSyncBaseUrl(settings?.connections);
  const shell = useMemo(
    () => ({ settings, health: health.data, taskSyncUrl, reloadSettings }),
    [settings, health.data, taskSyncUrl, reloadSettings],
  );

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

  const connected = health.data ? health.data.taskSync.connected && health.data.canvas.connected : null;

  return (
    <ShellContext.Provider value={shell}>
      <AgentStatusContext.Provider value={agents}>
        <ToastProvider>
          <div className="shell">
            <a className="skip-link" href="#main">Skip to content</a>
            <header className="topbar">
              <div className="topbar__inner">
                <Link to="/" className="brand" aria-label="School Dashboard assignments">
                  <img src={logoSrc} alt="" />
                  <span>School Dashboard</span>
                </Link>
                <nav className="nav" aria-label="Primary navigation">
                  {navigation.map(({ to, label, match }) => (
                    <NavLink key={to} to={to} className={`nav__link${match(location.pathname) ? " is-active" : ""}`} aria-current={match(location.pathname) ? "page" : undefined}>
                      {label}
                    </NavLink>
                  ))}
                  {taskSyncUrl ? <>
                    <span className="nav__sep" aria-hidden />
                    <a className="nav__link nav__link--external" href={taskSyncUrl} target="_blank" rel="noreferrer" title="Open Canvas Task Sync in a new tab">
                      Task Sync<ArrowUpRightIcon size={13} weight="bold" aria-hidden />
                    </a>
                  </> : null}
                </nav>
                <div className="topbar__end">
                  {connected === true ? (
                    <Link to="/diagnostics" className="health-link" title="Canvas and Canvas Task Sync are connected. Open diagnostics.">
                      <CheckCircleIcon className="tone-success" size={17} weight="fill" aria-hidden /><span className="health-link__text">All systems ready</span>
                    </Link>
                  ) : connected === false ? (
                    <Link to="/settings?section=connections" className="health-link health-link--warning" title="A connection needs attention. Open connection settings.">
                      <WarningCircleIcon size={17} weight="fill" aria-hidden /><span className="health-link__text">Check connections</span>
                    </Link>
                  ) : null}
                  <TargetSwitch agents={agents} onChange={changeAgents} />
                  <AgentSwitcher
                    agents={agents}
                    onChange={changeAgents}
                    defaultEffort={settings ? { codex: settings.reasoningEffort, claude: settings.claude.reasoningEffort } : undefined}
                  />
                  <NavLink to="/settings" className={({ isActive }) => `nav__link settings-link${isActive ? " is-active" : ""}`} aria-label="Settings" title="Settings">
                    <GearSixIcon size={19} aria-hidden /><span>Settings</span>
                  </NavLink>
                </div>
              </div>
            </header>

            <main className="page-shell" id="main" key={location.pathname}>
              {agents && !agents.available ? (
                <div className="shell-notices">
                  <Notice
                    tone="warning"
                    role="status"
                    icon={CloudSlashIcon}
                    title="Agents unavailable"
                    actions={fallbackTarget ? (
                      <Button variant="secondary" size="sm" onClick={() => void changeAgents({ target: fallbackTarget.id }).catch(() => undefined)}>
                        <AgentTargetIcon target={fallbackTarget.id} />
                        Run on the {fallbackTarget.label.toLowerCase()} instead
                      </Button>
                    ) : fallbackProvider ? (
                      <Button variant="secondary" size="sm" onClick={() => void changeAgents({ provider: fallbackProvider.id }).catch(() => undefined)}>
                        <AgentProviderIcon provider={fallbackProvider.id} />
                        Use {fallbackProvider.label} instead
                      </Button>
                    ) : null}
                  >
                    <p>{agents.message} Assignments, past results, and settings still work.</p>
                  </Notice>
                </div>
              ) : null}
              {children}
            </main>

            <nav className="mobile-nav" aria-label="Mobile navigation">
              {navigation.map(({ to, label, icon: Icon, match }) => (
                <NavLink key={to} to={to} className={`mobile-nav__item${match(location.pathname) ? " is-active" : ""}`}>
                  <Icon size={22} weight={match(location.pathname) ? "fill" : "regular"} aria-hidden />
                  <span>{label}{to === "/" && working ? <span className="sr-only"> (agents working)</span> : null}</span>
                </NavLink>
              ))}
              <NavLink to="/settings" className={({ isActive }) => `mobile-nav__item${isActive || location.pathname === "/diagnostics" ? " is-active" : ""}`}>
                <GearSixIcon size={22} aria-hidden /><span>Settings</span>
              </NavLink>
            </nav>
          </div>
        </ToastProvider>
      </AgentStatusContext.Provider>
    </ShellContext.Provider>
  );
}
