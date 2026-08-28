import { Activity, BookOpen, LayoutList, Menu, Settings, X } from "lucide-react";
import { useState, type PropsWithChildren } from "react";
import { NavLink } from "react-router-dom";

const navItems = [
  { to: "/", label: "My work", icon: LayoutList },
  { to: "/runs", label: "Agent runs", icon: Activity },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function AppShell({ children }: PropsWithChildren) {
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? "is-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark"><BookOpen size={19} strokeWidth={1.8} /></div>
          <div><strong>School</strong><span>Dashboard</span></div>
        </div>
        <button className="mobile-close icon-button" aria-label="Close navigation" onClick={() => setMobileOpen(false)}>
          <X size={20} />
        </button>
        <nav aria-label="Primary navigation">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === "/"} onClick={() => setMobileOpen(false)}>
              <Icon size={18} strokeWidth={1.7} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="status-dot" />
          <div><strong>Local workspace</strong><span>Secrets stay on this device</span></div>
        </div>
      </aside>
      {mobileOpen && <button className="scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
      <main className="main-stage">
        <header className="mobile-header">
          <button className="icon-button" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Menu size={21} /></button>
          <span>School Dashboard</span>
          <span className="status-dot" />
        </header>
        {children}
      </main>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {navItems.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} end={to === "/"}>
            <Icon size={19} strokeWidth={1.7} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
