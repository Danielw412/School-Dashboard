import { Activity, LayoutList, LoaderCircle, Menu, Settings, X, type LucideIcon } from "lucide-react";
import { useState, type PropsWithChildren } from "react";
import { NavLink } from "react-router-dom";

import { schoolApi } from "../api";
import { usePolling } from "../hooks/usePolling";

const navItems = [
  { to: "/", label: "My work", icon: LayoutList },
  { to: "/runs", label: "Agent runs", icon: Activity },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function AppShell({ children }: PropsWithChildren) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const activeWork = usePolling(schoolApi.activeWork, 2_500);
  const hasActiveWork = Boolean(activeWork.data?.runs.length || activeWork.data?.workflows.length);
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? "is-open" : ""}`}>
        <div className="brand">
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
      </aside>
      {mobileOpen ? <button className="scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} /> : null}
      <main className="main-stage">
        <header className="mobile-header">
          <button className="icon-button" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Menu size={21} /></button>
          <span>School Dashboard</span>
          {hasActiveWork ? <LoaderCircle className="spin" size={17} /> : <span />}
        </header>
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
  );
}

function NavigationIcon({ icon: Icon, loading, size = 18 }: { icon: LucideIcon; loading: boolean; size?: number }) {
  return loading
    ? <LoaderCircle className="spin" size={size} strokeWidth={1.8} />
    : <Icon size={size} strokeWidth={1.8} />;
}
