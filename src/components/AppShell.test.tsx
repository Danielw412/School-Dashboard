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
  schoolApi: { activeWork: vi.fn(), updateAgentSelection: vi.fn() },
}));

function withAgents(status: AgentExecutionStatus, provider: "codex" | "claude", claudeAvailable = true): AgentExecutionStatus {
  const claudeMessage = claudeAvailable
    ? "Claude runs on the dashboard server (latitude7370)."
    : "Claude is not signed in on the dashboard server (latitude7370). Run \"claude auth login\" there as the dashboard's user.";
  const available = provider === "claude" ? claudeAvailable : status.available;
  return {
    ...status,
    provider,
    available,
    message: provider === "claude" ? claudeMessage : status.message,
    providers: [
      { id: "codex", label: "Codex", available: true, message: "Codex runs on the dashboard server (latitude7370)." },
      { id: "claude", label: "Claude", available: claudeAvailable, message: claudeMessage },
    ],
    effort: { codex: "default", claude: provider === "claude" ? "max" : "default" },
    targets: status.targets?.map((target) => target.id === "local" && provider === "claude"
      ? { ...target, available: claudeAvailable, message: claudeMessage }
      : target),
  };
}

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
    vi.mocked(schoolApi.updateAgentSelection).mockResolvedValue(serverAndLaptop("local", true));
    render(<MemoryRouter><AppShell><AvailabilityProbe /></AppShell></MemoryRouter>);

    const group = await screen.findByRole("group", { name: "Run agents on" });
    expect(within(group).getByRole("button", { name: "Laptop" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Codex on DESKTOP-TQMTS8O · ready")).toBeInTheDocument();

    await userEvent.click(within(group).getByRole("button", { name: "Server" }));
    expect(schoolApi.updateAgentSelection).toHaveBeenCalledWith({ target: "local" });
    expect(await within(group).findByRole("button", { name: "Server" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Codex on latitude7370 · ready")).toBeInTheDocument();
  });

  it("offers the server when the selected laptop is offline", async () => {
    const { schoolApi } = await import("../api");
    vi.mocked(schoolApi.activeWork).mockResolvedValue({ workflows: [], runs: [], agents: serverAndLaptop("worker", false) });
    vi.mocked(schoolApi.updateAgentSelection).mockResolvedValue(serverAndLaptop("local", false));
    render(<MemoryRouter><AppShell><AvailabilityProbe /></AppShell></MemoryRouter>);

    expect(await screen.findByRole("status")).toHaveTextContent(laptopOffline);
    expect(screen.getByRole("button", { name: "Laptop (unavailable)" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: /Run on the server instead/u }));

    expect(schoolApi.updateAgentSelection).toHaveBeenCalledWith({ target: "local" });
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

  it("switches new runs between Codex and Claude and sets the selected agent's effort", async () => {
    const { schoolApi } = await import("../api");
    const server = serverAndLaptop("local", true);
    vi.mocked(schoolApi.activeWork).mockResolvedValue({ workflows: [], runs: [], agents: withAgents(server, "codex") });
    vi.mocked(schoolApi.updateAgentSelection).mockResolvedValueOnce(withAgents(server, "claude"));
    render(<MemoryRouter><AppShell><AvailabilityProbe /></AppShell></MemoryRouter>);

    const agentGroup = await screen.findByRole("group", { name: "Agent" });
    expect(within(agentGroup).getByRole("button", { name: "Codex" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("combobox", { name: "Codex effort" })).toHaveValue("default");

    await userEvent.click(within(agentGroup).getByRole("button", { name: "Claude" }));
    expect(schoolApi.updateAgentSelection).toHaveBeenCalledWith({ provider: "claude" });
    expect(await within(agentGroup).findByRole("button", { name: "Claude" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Claude on latitude7370 · ready")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Claude effort" })).toHaveValue("max");

    vi.mocked(schoolApi.updateAgentSelection).mockResolvedValueOnce({ ...withAgents(server, "claude"), effort: { codex: "default", claude: "low" } });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Claude effort" }), "low");
    expect(schoolApi.updateAgentSelection).toHaveBeenLastCalledWith({ provider: "claude", effort: "low" });
    expect(await screen.findByRole("combobox", { name: "Claude effort" })).toHaveValue("low");
  });

  it("offers Codex when Claude cannot run on the selected machine", async () => {
    const { schoolApi } = await import("../api");
    const server = serverAndLaptop("local", false);
    vi.mocked(schoolApi.activeWork).mockResolvedValue({ workflows: [], runs: [], agents: withAgents(server, "claude", false) });
    vi.mocked(schoolApi.updateAgentSelection).mockResolvedValue(withAgents(server, "codex", false));
    render(<MemoryRouter><AppShell><AvailabilityProbe /></AppShell></MemoryRouter>);

    expect(await screen.findByRole("status")).toHaveTextContent(/Claude is not signed in on the dashboard server/u);
    expect(screen.getByRole("button", { name: "Claude (unavailable)" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: /Use Codex instead/u }));

    expect(schoolApi.updateAgentSelection).toHaveBeenCalledWith({ provider: "codex" });
    expect(await screen.findByText("agents ready")).toBeInTheDocument();
  });
});
