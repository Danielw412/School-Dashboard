import type { AppSettings } from "./types";

// Links into Canvas Task Sync's own control center. School Dashboard only opens these pages in
// the browser; Task Sync needs nothing from this app, and every link disappears when no address
// can be worked out.

// The saved address, or else the origin of the Task Sync API, which serves its control center.
export function taskSyncBaseUrl(connections: AppSettings["connections"] | null | undefined): string | null {
  if (!connections) return null;
  const candidate = connections.taskSyncDashboardUrl?.trim()
    || connections.taskSyncApiBase.replace(/\/api\/v1\/?$/u, "");
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

export const taskSyncPages = {
  home: (base: string) => `${base}/`,
  tasks: (base: string) => `${base}/tasks`,
  course: (base: string, courseId: string) => `${base}/courses?course=${encodeURIComponent(courseId)}`,
  google: (base: string) => `${base}/settings?section=google`,
};
