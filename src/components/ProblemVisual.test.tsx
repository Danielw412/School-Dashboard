import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProblemVisual } from "./ProblemVisual";

const visual = { path: "renders/Figure #3.png", page: 33, caption: "Figure 3.34" };

describe("ProblemVisual", () => {
  it("encodes filenames and replaces a broken image with recovery instructions", () => {
    const { rerender } = render(<ProblemVisual visual={visual} workspaceId="extraction-1" />);
    const image = screen.getByRole("img", { name: visual.caption });
    expect(image).toHaveAttribute("src", "/workspace-files/extraction-1/renders/Figure%20%233.png");

    fireEvent.error(image);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/View sources.*Extract again/);
    expect(screen.getByText("Figure 3.34 · page 33")).toBeInTheDocument();

    rerender(<ProblemVisual visual={visual} workspaceId="extraction-2" />);
    expect(screen.getByRole("img")).toHaveAttribute("src", "/workspace-files/extraction-2/renders/Figure%20%233.png");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("explains a missing workspace instead of silently omitting the figure", () => {
    render(<ProblemVisual visual={visual} workspaceId={null} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("This figure is unavailable.");
  });
});
