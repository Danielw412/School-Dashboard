import { describe, expect, it } from "vitest";

import { sanitizeForLog } from "./activity.js";

describe("activity redaction", () => {
  it("removes URL capabilities without hiding token-usage diagnostics", () => {
    const value = sanitizeForLog({
      sourceUrl: "https://canvas.test/courses/9/files/7?verifier=secret&wrap=1",
      input_tokens: 1234,
      access_token: "secret-token",
    });

    expect(value).toEqual({
      sourceUrl: "https://canvas.test/courses/9/files/7?wrap=1",
      input_tokens: 1234,
      access_token: "[redacted]",
    });
  });
});
