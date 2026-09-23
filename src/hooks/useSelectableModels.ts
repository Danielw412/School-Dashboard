import { schoolApi } from "../api";
import { modelLabel, modelNames } from "../models";
import { usePolling } from "./usePolling";

const builtIn = modelNames.map((id) => ({ id, label: modelLabel(id) }));

// Built-in models plus any Luna Reserve ID the agent machine's Codex reports.
export function useSelectableModels() {
  const state = usePolling(schoolApi.agentModels);
  return {
    selectable: state.data?.selectable ?? builtIn,
    models: state.data,
    refresh: state.refresh,
  };
}
