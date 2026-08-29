import { describe, expect, it } from "vitest";

import { classifyPdfTextLayer, parsePdfPageCount, safeChild } from "./workspace.js";

describe("safeChild", () => {
  it("keeps assignment resources inside the workspace", () => {
    expect(safeChild("C:\\tmp\\assignment", "resources\\worksheet.pdf")).toBe("C:\\tmp\\assignment\\resources\\worksheet.pdf");
  });

  it("blocks path traversal", () => {
    expect(() => safeChild("C:\\tmp\\assignment", "..\\secret.env")).toThrow(/escaped/);
  });
});

describe("PDF inspection helpers", () => {
  it("reads the page count reported by pdfinfo", () => {
    expect(parsePdfPageCount("Title: Worksheet\nPages:          12\nEncrypted: no\n")).toBe(12);
    expect(() => parsePdfPageCount("Title: Not a PDF report")).toThrow(/page count/);
  });

  it("classifies text-layer samples conservatively", () => {
    expect(classifyPdfTextLayer(150)).toBe("usable");
    expect(classifyPdfTextLayer(24)).toBe("sparse");
    expect(classifyPdfTextLayer(0)).toBe("none");
  });
});
