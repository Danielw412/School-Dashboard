import { ExamIcon, FileTextIcon, KeyIcon, ListNumbersIcon, SparkleIcon, type Icon } from "@phosphor-icons/react";

import type { AgentRun } from "./types";

export type Feature = AgentRun["feature"];
export type WorkflowFeature = Exclude<Feature, "studyGuide">;
export type WorkspaceTab = "directions" | "problems" | "answers" | "study";

export const features: Array<{ id: Feature; tab: WorkspaceTab; label: string; icon: Icon }> = [
  { id: "directions", tab: "directions", label: "Directions", icon: FileTextIcon },
  { id: "problemExtraction", tab: "problems", label: "Assigned problems", icon: ListNumbersIcon },
  { id: "answerKey", tab: "answers", label: "Answer key", icon: KeyIcon },
  { id: "studyGuide", tab: "study", label: "Study guide", icon: ExamIcon },
];

export function featureLabel(feature: Feature): string {
  return features.find((item) => item.id === feature)?.label ?? feature;
}

export function featureForTab(tab: WorkspaceTab): Feature {
  return features.find((item) => item.tab === tab)!.id;
}

export function tabForFeature(feature: Feature): WorkspaceTab {
  return features.find((item) => item.id === feature)?.tab ?? "directions";
}

export function isWorkspaceTab(value: string | null): value is WorkspaceTab {
  return features.some((item) => item.tab === value);
}

// The workflows an assignment can run in one go, in the order they run.
export const workflows: Array<{ id: string; label: string; detail: string; icon: Icon; steps: WorkflowFeature[] }> = [
  { id: "full", label: "Run all three", detail: "Directions, then the assigned problems, then an answer key", icon: SparkleIcon, steps: ["directions", "problemExtraction", "answerKey"] },
  { id: "directions", label: "Directions only", detail: "Read the assignment and what to turn in", icon: FileTextIcon, steps: ["directions"] },
  { id: "directions-problems", label: "Directions and problems", detail: "Stop before the answer key", icon: ListNumbersIcon, steps: ["directions", "problemExtraction"] },
  { id: "problems-answers", label: "Problems and answer key", detail: "Skip the directions", icon: KeyIcon, steps: ["problemExtraction", "answerKey"] },
];

export function isActiveRun(run: Pick<AgentRun, "status"> | null | undefined): boolean {
  return run?.status === "queued" || run?.status === "running";
}
