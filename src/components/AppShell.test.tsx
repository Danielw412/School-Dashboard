import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentAvailability } from "../agent-status";
import { AppShell } from "./AppShell";

vi.mock("../api", () => ({
  schoolApi: { activeWork: vi.fn() },
}));

function AvailabilityProbe() {
  const agents = useAgentAvailability();
  return <p>{agents.available ? "agents ready" : `agents blocked: ${agents.reason}`}</p>;
}

describe("AppShell agent availability", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps the dashboard usable and says clearly when the laptop agent worker is offline", async () => {
    const { schoolApi } = await import("../api");
    const message = "Agents are unavailable: the laptop agent worker (DESKTOP-TQMTS8O) is offline.";
    vi.mocked(schoolApi.activeWork).mockResolvedValue({
      workflows: [],
      runs: [],
      agents: { mode: "worker", available: false, message, worker: null, activeJobs: 0, queuedJobs: 0 },
    });
    render(<MemoryRouter><AppShell><AvailabilityProbe /></AppShell></MemoryRouter>);

    expect(await screen.findByRole("status")).toHaveTextContent("Agents unavailable");
    expect(screen.getByRole("status")).toHaveTextContent(message);
    expect(screen.getByText(`agents blocked: ${message}`)).toBeInTheDocument();
  });

  it("shows no banner while the worker is connected", async () => {
    const { schoolApi } = await import("../api");
    vi.mocked(schoolApi.activeWork).mockResolvedValue({
      workflows: [],
      runs: [],
      agents: { mode: "worker", available: true, message: "Agents run on DESKTOP-TQMTS8O.", worker: null, activeJobs: 0, queuedJobs: 0 },
    });
    render(<MemoryRouter><AppShell><AvailabilityProbe /></AppShell></MemoryRouter>);

    expect(await screen.findByText("agents ready")).toBeInTheDocument();
    expect(screen.queryByText("Agents unavailable")).not.toBeInTheDocument();
  });
});
