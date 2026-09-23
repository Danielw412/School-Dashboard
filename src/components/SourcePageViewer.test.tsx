import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { SourceDocument } from "../types";
import { SourcePageViewer } from "./SourcePageViewer";

const packet: SourceDocument = {
  id: "document-2110126",
  name: "Circular motion packet.pdf",
  pageCount: 7,
  pages: [1, 2, 3].map((page) => ({ page, path: `source-pages/packet page-${page}.jpg` })),
};

function renderViewer(page = 2) {
  const onNavigate = vi.fn();
  const onClose = vi.fn();
  render(<SourcePageViewer
    documents={[packet]}
    workspaceId="extraction-1"
    request={{ documentId: packet.id, page, label: "Problem 19" }}
    onNavigate={onNavigate}
    onClose={onClose}
  />);
  return { onNavigate, onClose };
}

describe("SourcePageViewer", () => {
  it("shows the requested page in a non-modal window and pages through the document", async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderViewer();

    const dialog = screen.getByRole("dialog", { name: "Problem 19" });
    expect(dialog).toHaveAttribute("aria-modal", "false");
    expect(screen.getByText("Page 2 of 7 · Circular motion packet.pdf")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Circular motion packet.pdf page 2" }))
      .toHaveAttribute("src", "/workspace-files/extraction-1/source-pages/packet%20page-2.jpg");

    await user.click(screen.getByRole("button", { name: "Next page" }));
    await user.click(screen.getByRole("button", { name: "Previous page" }));
    expect(onNavigate.mock.calls).toEqual([[3], [1]]);
  });

  it("zooms with the toolbar, the wheel, and the keyboard, and fits the width again", async () => {
    const user = userEvent.setup();
    const { onClose } = renderViewer();
    const image = screen.getByRole("img");
    fireEvent.load(image);

    const fitButton = screen.getByRole("button", { name: "Fit page width" });
    expect(fitButton).toHaveTextContent("100%");
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(fitButton).toHaveTextContent("125%");

    fireEvent.wheel(image.parentElement!, { deltaY: -200, clientX: 10, clientY: 10 });
    expect(Number.parseInt(fitButton.textContent ?? "", 10)).toBeGreaterThan(125);

    await user.click(fitButton);
    expect(fitButton).toHaveTextContent("100%");

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "-" });
    expect(fitButton).toHaveTextContent("80%");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("explains a page image that is no longer available", () => {
    renderViewer();
    fireEvent.error(screen.getByRole("img"));

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Extract the problems again");
  });
});
