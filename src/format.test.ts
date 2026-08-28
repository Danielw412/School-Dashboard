import { describe, expect, it } from "vitest";

import { formatDue, isPastDue, parseDueDate } from "./format";

describe("date-only due dates", () => {
  it("keeps a Canvas Task Sync calendar date in the local calendar day", () => {
    const parsed = parseDueDate("2026-08-24");

    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(7);
    expect(parsed.getDate()).toBe(24);
    expect(formatDue("2026-08-24")).toMatch(/Mon, Aug 24/i);
    expect(formatDue("2026-08-24")).not.toMatch(/\d:\d/);
  });

  it("treats a date-only task as due through the end of that local day", () => {
    expect(isPastDue("2026-08-24", new Date(2026, 7, 24, 20, 0))).toBe(false);
    expect(isPastDue("2026-08-24", new Date(2026, 7, 25, 0, 0))).toBe(true);
  });
});
