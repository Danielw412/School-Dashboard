// API IDs (also passed unchanged by @openai/codex-sdk to Codex --model).
export const modelNames = ["gpt-6-luna", "gpt-6-sol", "gpt-5.6-sol"] as const;
export type ModelName = typeof modelNames[number];

// Keep historical IDs intact for display; they are not selectable for new runs.
export function modelLabel(model: string): string {
  return model.replace(/^gpt-([\d.]+)-(.+)$/u, (_match, version: string, name: string) =>
    `GPT-${version} ${name.charAt(0).toUpperCase()}${name.slice(1)}`);
}

export function migrateSavedModel(model: unknown): unknown {
  if (model === "gpt-5.6-luna" || model === "gpt-5.6-terra") return "gpt-6-luna";
  return model;
}
