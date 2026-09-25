import { schoolApi } from "../api";
import { DEFAULT_CLAUDE_MODEL, modelLabel, modelNames } from "../models";
import { usePolling } from "./usePolling";

const builtIn = modelNames.map((id) => ({ id, label: modelLabel(id) }));
const claudeDefault = [{ id: DEFAULT_CLAUDE_MODEL, label: modelLabel(DEFAULT_CLAUDE_MODEL) }];

// Built-in Codex models plus any Luna Reserve ID the agent machine's Codex reports, and the Claude
// models its Claude Code lists.
export function useSelectableModels() {
  const state = usePolling(schoolApi.agentModels);
  return {
    selectable: state.data?.selectable ?? builtIn,
    claude: state.data?.claude?.selectable ?? claudeDefault,
    models: state.data,
    refresh: state.refresh,
  };
}
