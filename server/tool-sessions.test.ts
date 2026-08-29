import { describe, expect, it } from "vitest";

import { parsePdfRenderPages } from "./tool-sessions.js";

describe("PDF render page selection", () => {
  it("preserves single-page rendering", () => {
    expect(parsePdfRenderPages({ page: 7 })).toEqual([7]);
  });

  it("accepts a deduplicated page list and an inclusive range", () => {
    expect(parsePdfRenderPages({ pages: [4, 2, 4, 9] })).toEqual([4, 2, 9]);
    expect(parsePdfRenderPages({ range: { start: 3, end: 6 } })).toEqual([3, 4, 5, 6]);
  });

  it("requires exactly one bounded selection", () => {
    expect(() => parsePdfRenderPages({})).toThrow(/exactly one/);
    expect(() => parsePdfRenderPages({ page: 1, pages: [2] })).toThrow(/exactly one/);
    expect(() => parsePdfRenderPages({ range: { start: 1, end: 41 } })).toThrow(/at most 40/);
  });
});
