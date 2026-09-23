import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentAvailability } from "../agent-status";
import type { AgentExecutionStatus } from "../types";
import { AppShell } from "./AppShell";

const laptopOffline = "Agents are unavailable: the laptop agent worker (DESKTOP-TQMTS8O) is offline.";

function serverAndLaptop(mode: "local" | "worker", laptopAvailable: boolean): AgentExecutionStatus {
  const targets: NonNullable<AgentExecutionStatus["targets"]> = [
    { id: "local", label: "Server", host: "latitude7370", available: true, message: "Codex runs on the dashboard server (latitude7370).", activeJobs: 0, queuedJobs: 0 },
    {
      id: "worker",
      label: "Laptop",
      host: "DESKTOP-TQMTS8O",
      available: laptopAvailable,
      message: laptopAvailable ? "Agents run on DESKTOP-TQMTS8O through the laptop agent worker." : laptopOffline,
      activeJobs: 0,
      queuedJobs: 0,
    },
  ];
  const selected = targets.find((target) => target.id === mode)!;
  return { mode, available: selected.available, message: selected.message, worker: null, activeJobs: 0, queuedJobs: 0, targets };
}

vi.mock("../api", () => ({
  schoolApi: { activeWork: vi.fn(), setAgentTarget: vi.fn() },
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

  it("switches new agent runs between the server and the laptop", async () => {
    const { schoolApi } = await import("../api");
    vi.mocked(schoolApi.activeWork).mockResolvedValue({ workflows: [], runs: [], agents: serverAndLaptop("worker", true) });
    vi.mocked(schoolApi.setAgentTarget).mockResolvedValue(serverAndLaptop("local", true));
    render(<MemoryRouter><AppShell><AvailabilityProbe /></AppShell></MemoryRouter>);

    const group = await screen.findByRole("group", { name: "Run agents on" });
    expect(within(group).getByRole("button", { name: "Laptop" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("DESKTOP-TQMTS8O · ready")).toBeInTheDocument();

    await userEvent.click(within(group).getByRole("button", { name: "Server" }));
    expect(schoolApi.setAgentTarget).toHaveBeenCalledWith("local");
    expect(await within(group).findByRole("button", { name: "Server" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("latitude7370 · ready")).toBeInTheDocument();
  });

  it("offers the server when the selected laptop is offline", async () => {
    const { schoolApi } = await import("../api");
    vi.mocked(schoolApi.activeWork).mockResolvedValue({ workflows: [], runs: [], agents: serverAndLaptop("worker", false) });
    vi.mocked(schoolApi.setAgentTarget).mockResolvedValue(serverAndLaptop("local", false));
    render(<MemoryRouter><AppShell><AvailabilityProbe /></AppShell></MemoryRouter>);

    expect(await screen.findByRole("status")).toHaveTextContent(laptopOffline);
    expect(screen.getByRole("button", { name: "Laptop (unavailable)" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: /Run on the server instead/u }));

    expect(schoolApi.setAgentTarget).toHaveBeenCalledWith("local");
    expect(await screen.findByText("agents ready")).toBeInTheDocument();
    expect(screen.queryByText("Agents unavailable")).not.toBeInTheDocument();
  });

  it("hides the switch when agents can only run on this computer", async () => {
    const { schoolApi } = await import("../api");
    vi.mocked(schoolApi.activeWork).mockResolvedValue({
      workflows: [],
      runs: [],
      agents: {
        mode: "local",
        available: true,
        message: "Codex runs on this machine (DESKTOP-TQMTS8O).",
        worker: null,
        activeJobs: 0,
        queuedJobs: 0,
        targets: [{ id: "local", label: "This computer", host: "DESKTOP-TQMTS8O", available: true, message: "", activeJobs: 0, queuedJobs: 0 }],
      },
    });
    render(<MemoryRouter><AppShell><AvailabilityProbe /></AppShell></MemoryRouter>);

    expect(await screen.findByText("agents ready")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Run agents on" })).not.toBeInTheDocument();
  });
});
