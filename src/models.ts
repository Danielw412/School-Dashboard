// Which agent runs a turn: Codex (@openai/codex-sdk) or Claude (@anthropic-ai/claude-agent-sdk).
export const agentProviders = ["codex", "claude"] as const;
export type AgentProvider = typeof agentProviders[number];

export function providerLabel(provider: AgentProvider): string {
  return provider === "claude" ? "Claude" : "Codex";
}

// How the dashboard refers to the assistant doing a run: Luna for Codex runs, Claude for Claude.
export function assistantName(provider: AgentProvider | undefined): string {
  return provider === "claude" ? "Claude" : "Luna";
}

// Effort levels both agents accept. "default" in the quick switch keeps the configured behavior
// (the Settings default, and xhigh for problem extraction).
export const effortLevels = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = typeof effortLevels[number];
export type EffortChoice = "default" | EffortLevel;

export function effortLabel(effort: string): string {
  if (effort === "default") return "Default";
  if (effort === "xhigh") return "Extra high";
  return `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`;
}

// API IDs (also passed unchanged by @openai/codex-sdk to Codex --model).
export const modelNames = ["gpt-6-luna", "gpt-6-sol", "gpt-5.6-sol"] as const;
export type ModelName = typeof modelNames[number];

// Used until the student picks a model from the list Claude Code reports.
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5";

// Keep historical IDs intact for display; they are not selectable for new runs.
export function modelLabel(model: string): string {
  const claude = model.match(/^claude-([a-z]+)-(\d+(?:-\d{1,2})*?)(?:-\d{8})?$/u);
  if (claude) return `Claude ${claude[1]!.charAt(0).toUpperCase()}${claude[1]!.slice(1)} ${claude[2]!.replaceAll("-", ".")}`;
  return model.replace(/^gpt-([\d.]+)-(.+)$/u, (_match, version: string, name: string) =>
    `GPT-${version} ${name.split("-").map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" ")}`);
}

export function migrateSavedModel(model: unknown): unknown {
  if (model === "gpt-5.6-luna" || model === "gpt-5.6-terra") return "gpt-6-luna";
  return model;
}

export const LUNA_RESERVE_LABEL = "Luna Reserve";

// Luna Reserve has no published identifier. It becomes selectable only when the laptop's Codex
// app-server lists a model whose ID or display name names it (for example "gpt-6-luna-reserve");
// that listed ID is what runs use. Other "reserve" models are not assumed to be Luna Reserve.
export function findLunaReserveModel(
  models: ReadonlyArray<{ id: string; displayName: string }>,
): string | null {
  const pattern = /luna[\s._-]*reserve|reserve[\s._-]*luna/iu;
  return models.find((model) => pattern.test(model.id) || pattern.test(model.displayName))?.id ?? null;
}
