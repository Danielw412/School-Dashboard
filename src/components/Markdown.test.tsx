import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Markdown } from "./Markdown";
import { normalizeMathDelimiters } from "./markdown-math";

describe("Markdown math", () => {
  it("normalizes Luna-style LaTeX delimiters without changing code", () => {
    expect(normalizeMathDelimiters("Speed \\(v=t^2\\).\n\n\\[a=b\\]\n\n`\\(literal\\)`"))
      .toBe("Speed $v=t^2$.\n\n$$\na=b\n$$\n\n`\\(literal\\)`");
  });

  it("renders normalized inline and display math with KaTeX", () => {
    const { container } = render(<Markdown>{"Speed \\(v=t^2\\).\n\n\\[a=b\\]"}</Markdown>);
    expect(container.querySelectorAll(".katex")).toHaveLength(2);
    expect(container.querySelector(".katex-display")).toBeInTheDocument();
  });
});
