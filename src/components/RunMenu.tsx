import { CaretDownIcon, CircleNotchIcon, ExamIcon, SparkleIcon, StopIcon } from "@phosphor-icons/react";
import { useState } from "react";

import type { ActiveAssignment } from "../active-work";
import { useAgentAvailability, useSelectedAgentProvider } from "../agent-status";
import { schoolApi } from "../api";
import { type WorkflowFeature, workflows } from "../features";
import { assistantName } from "../models";
import { useToast } from "../toast";
import { Button, Menu } from "./ui";

// Starts agent work on an assignment from a list, without opening it: the whole workflow, part of
// it, or a study guide. While the agent is working, it becomes the way to stop it.
export function RunMenu({ logicalId, title, active, onChanged, placement = "down" }: {
  logicalId: string;
  title: string;
  active: ActiveAssignment | null;
  onChanged: () => void;
  placement?: "down" | "up";
}) {
  const agents = useAgentAvailability();
  const provider = useSelectedAgentProvider();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const assistant = assistantName(active?.run?.provider ?? provider);

  const act = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await work();
      toast(done, "info");
      onChanged();
    } catch (error) {
      toast(error instanceof Error ? error.message : "That didn't start.", "error");
    } finally {
      setBusy(false);
    }
  };

  if (active) {
    return <Button
      variant="ghost"
      size="sm"
      icon={StopIcon}
      loading={busy}
      aria-label={`Cancel ${assistant} on ${title}`}
      title={`Stop ${assistant}`}
      onClick={() => void act(
        () => active.workflow ? schoolApi.cancelWorkflow(active.workflow.id) : active.run ? schoolApi.cancelRun(active.run.id) : Promise.resolve(),
        `${assistant} stopped on ${title}.`,
      )}
    >Cancel</Button>;
  }

  const startWorkflow = (steps: WorkflowFeature[]) => void act(
    () => schoolApi.startWorkflow({ logicalId, steps }),
    `${assistant} started on ${title}.`,
  );

  return <Menu
    label={`Run ${assistant} on ${title}`}
    placement={placement}
    disabled={busy || !agents.available}
    triggerClassName="btn btn--secondary btn--sm"
    trigger={<>
      {busy ? <CircleNotchIcon className="spin" size={15} aria-hidden /> : <SparkleIcon size={15} aria-hidden />}
      Run
      <CaretDownIcon size={12} weight="bold" aria-hidden />
    </>}
    items={[
      ...workflows.map((workflow) => ({ label: workflow.label, icon: workflow.icon, onSelect: () => startWorkflow(workflow.steps) })),
      "separator" as const,
      {
        label: "Study guide",
        icon: ExamIcon,
        onSelect: () => void act(() => schoolApi.startRun({ feature: "studyGuide", logicalId }), `${assistant} started a study guide for ${title}.`),
      },
    ]}
  />;
}
