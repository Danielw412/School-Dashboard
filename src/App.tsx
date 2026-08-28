import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { AppShell } from "./components/AppShell";
import { MyWork } from "./pages/MyWork";

const AgentRunsPage = lazy(() => import("./pages/AgentRuns").then((module) => ({ default: module.AgentRunsPage })));
const AssignmentWorkspace = lazy(() => import("./pages/AssignmentWorkspace").then((module) => ({ default: module.AssignmentWorkspace })));
const SettingsDiagnosticsPage = lazy(() => import("./pages/SettingsDiagnostics").then((module) => ({ default: module.SettingsDiagnosticsPage })));

export default function App() {
  return <BrowserRouter><AppShell><Suspense fallback={<div className="route-loading"><span /></div>}><Routes><Route path="/" element={<MyWork />} /><Route path="/assignment/:logicalId" element={<AssignmentWorkspace />} /><Route path="/runs" element={<AgentRunsPage />} /><Route path="/settings" element={<SettingsDiagnosticsPage />} /></Routes></Suspense></AppShell></BrowserRouter>;
}
