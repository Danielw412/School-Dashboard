// API IDs (also passed unchanged by @openai/codex-sdk to Codex --model).
export const modelNames = ["gpt-6-luna", "gpt-6-sol", "gpt-5.6-sol"] as const;
export type ModelName = typeof modelNames[number];

// Keep historical IDs intact for display; they are not selectable for new runs.
export function modelLabel(model: string): string {
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
