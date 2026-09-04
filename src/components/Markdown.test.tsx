import { render } from "@testing-library/react";
import katex from "katex";
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

  it("braces vector and unit-vector accents so arrows stay attached", () => {
    expect(normalizeMathDelimiters("\\(\\vec R=3\\hat\\imath+4\\hat\\jmath\\)"))
      .toBe("$\\vec{R}=3\\hat{\\imath}+4\\hat{\\jmath}$");
  });

  it("uses the same KaTeX structure as the package that supplies the stylesheet", () => {
    const { container } = render(<Markdown>{"\\(\\vec{r}\\)"}</Markdown>);
    const expected = document.createElement("div");
    expected.innerHTML = katex.renderToString("\\vec{r}");

    const renderedClasses = [...container.querySelectorAll(".katex-html span")]
      .map((element) => element.className)
      .filter(Boolean);
    const stylesheetClasses = [...expected.querySelectorAll(".katex-html span")]
      .map((element) => element.className)
      .filter(Boolean);

    expect(renderedClasses).toEqual(stylesheetClasses);
  });

  it("converts accidental solution HTML wrappers into Markdown", () => {
    const normalized = normalizeMathDelimiters(
      "<details><summary>Solution</summary><h3>Components</h3><p>Resolve the vector.</p></details>",
    );

    expect(normalized).toContain("### Components");
    expect(normalized).toContain("Resolve the vector.");
    expect(normalized).not.toMatch(/<\/?(?:details|summary|h3|p)/i);
  });
});
