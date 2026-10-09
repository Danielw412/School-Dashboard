import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "./components/AppShell";
import { PageLoader } from "./components/ui";
import { AssignmentsPage } from "./pages/Assignments";

const AssignmentWorkspace = lazy(() => import("./pages/AssignmentWorkspace").then((module) => ({ default: module.AssignmentWorkspace })));
const RunsPage = lazy(() => import("./pages/Runs").then((module) => ({ default: module.RunsPage })));
const ClassesPage = lazy(() => import("./pages/Classes").then((module) => ({ default: module.ClassesPage })));
const SettingsPage = lazy(() => import("./pages/Settings").then((module) => ({ default: module.SettingsPage })));
const DiagnosticsPage = lazy(() => import("./pages/Diagnostics").then((module) => ({ default: module.DiagnosticsPage })));

export default function App() {
  return <BrowserRouter>
    <AppShell>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/" element={<AssignmentsPage />} />
          <Route path="/assignment/:logicalId" element={<AssignmentWorkspace />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/classes" element={<ClassesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/diagnostics" element={<DiagnosticsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </AppShell>
  </BrowserRouter>;
}
