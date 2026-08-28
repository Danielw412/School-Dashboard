import { describe, expect, it } from "vitest";

import { safeChild } from "./workspace.js";

describe("safeChild", () => {
  it("keeps assignment resources inside the workspace", () => {
    expect(safeChild("C:\\tmp\\assignment", "resources\\worksheet.pdf")).toBe("C:\\tmp\\assignment\\resources\\worksheet.pdf");
  });

  it("blocks path traversal", () => {
    expect(() => safeChild("C:\\tmp\\assignment", "..\\secret.env")).toThrow(/escaped/);
  });
});
