import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  CalendarBlankIcon,
  CaretDownIcon,
  CaretRightIcon,
  ChalkboardTeacherIcon,
  CheckCircleIcon,
  CheckIcon,
  CircleNotchIcon,
  DotsThreeIcon,
  ImageBrokenIcon,
  LinkSimpleIcon,
  LockSimpleIcon,
  PaperPlaneTiltIcon,
  PencilSimpleIcon,
  ScanIcon,
  SparkleIcon,
  StopIcon,
  TargetIcon,
  UploadSimpleIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { useAgentAvailability, useSelectedAgentProvider } from "../agent-status";
import { schoolApi } from "../api";
import { RunProgressPanel } from "../components/AgentProgress";
import { Markdown } from "../components/Markdown";
import { ProblemVisual } from "../components/ProblemVisual";
import { SourcePageViewer, type SourcePageRequest } from "../components/SourcePageViewer";
import { RunStatusBadge } from "../components/Status";
import { TaskEditor } from "../components/TaskEditor";
import {
  Button,
  EmptyState,
  ErrorNotice,
  Field,
  LinkButton,
  Menu,
  type MenuEntry,
  Modal,
  Notice,
} from "../components/ui";
import {
  type Feature,
  featureLabel,
  features,
  isActiveRun,
  isWorkspaceTab,
  tabForFeature,
  type WorkflowFeature,
  workflows,
  type WorkspaceTab,
} from "../features";
import { classMarkText, classTone, formatDue, formatRelative, formatTokens, isPastDue, latestCompletedRun, latestRun } from "../format";
import { usePolling } from "../hooks/usePolling";
import { useSelectableModels } from "../hooks/useSelectableModels";
import { type AgentProvider, effortLabel, effortLevels, modelLabel, providerLabel } from "../models";
import { useTaskSyncUrl } from "../shell-context";
import { taskSyncPages } from "../task-sync-links";
import { useToast } from "../toast";
import type {
  ActiveWork,
  AgentRun,
  AnswerKey,
  AssignmentContext,
  AssignmentDirections,
  MissingVisual,
  ProblemExtraction,
  ReasoningEffort,
  SourcePageRef,
  StudyGuide,
  TrackedTask,
} from "../types";

type Provenance = Array<{ sourceName: string; sourceUrl: string | null; page: number | null; evidence: string }>;

export function AssignmentWorkspace() {
  const { logicalId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: WorkspaceTab = isWorkspaceTab(tabParam) ? tabParam : "directions";
  const taskState = usePolling(() => schoolApi.task(logicalId));
  const contextState = usePolling(() => schoolApi.context(logicalId));
  const runsState = usePolling(schoolApi.runs, 2500);
  const activeState = usePolling(schoolApi.activeWork, 2500);
  const agents = useAgentAvailability();
  const provider = useSelectedAgentProvider();
  const toast = useToast();
  const taskSyncUrl = useTaskSyncUrl();
  const navigate = useNavigate();
  const [starting, setStarting] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  // "" and "default" use the configured model and the quick (or Settings) effort.
  const [studyModel, setStudyModel] = useState("");
  const [reasoning, setReasoning] = useState<ReasoningEffort | "default">("default");
  const [predictor, setPredictor] = useState(false);

  const task = taskState.data;
  const context = contextState.data;
  const runs = useMemo(() => runsState.data ?? [], [runsState.data]);
  const latest = useMemo(() => ({
    directions: latestRun(runs, logicalId, "directions"),
    problemExtraction: latestRun(runs, logicalId, "problemExtraction"),
    answerKey: latestRun(runs, logicalId, "answerKey"),
    studyGuide: latestRun(runs, logicalId, "studyGuide"),
  }), [runs, logicalId]);
  // The newest finished result of each feature: a later failed or cancelled run doesn't hide it.
  const results = useMemo(() => ({
    directions: latestCompletedRun(runs, logicalId, "directions"),
    problemExtraction: latestCompletedRun(runs, logicalId, "problemExtraction"),
    answerKey: latestCompletedRun(runs, logicalId, "answerKey"),
    studyGuide: latestCompletedRun(runs, logicalId, "studyGuide"),
  }), [runs, logicalId]);
  const workflow = activeState.data?.workflows.find((item) => item.logicalId === logicalId) ?? null;
  const activeRun = Object.values(latest).find((run) => isActiveRun(run)) ?? null;
  const busy = Boolean(workflow || activeRun || starting);
  const assistant = providerLabel(activeRun?.provider ?? provider);

  const switchTab = (next: WorkspaceTab) => {
    const params = new URLSearchParams(searchParams);
    params.set("tab", next);
    setSearchParams(params, { replace: true });
  };

  const refreshWork = async () => {
    await Promise.all([runsState.refresh(), activeState.refresh()].map((request) => request.catch(() => undefined)));
  };

  const start = async (feature: Feature) => {
    setStarting(feature);
    setActionError(null);
    try {
      await schoolApi.startRun({
        feature,
        logicalId,
        model: feature === "studyGuide" ? studyModel || undefined : undefined,
        reasoningEffort: feature === "studyGuide" && reasoning !== "default" ? reasoning : undefined,
        useTestQuestionPredictor: feature === "studyGuide" ? predictor : undefined,
        extractionRunId: feature === "answerKey" ? results.problemExtraction?.id : undefined,
      });
      await refreshWork();
      switchTab(tabForFeature(feature));
      toast(`${providerLabel(provider)} started on ${featureLabel(feature).toLowerCase()}.`, "info");
    } catch (error) {
      setActionError(error);
    } finally {
      setStarting(null);
    }
  };

  const startWorkflow = async (id: string, steps: WorkflowFeature[]) => {
    setStarting(`workflow:${id}`);
    setActionError(null);
    try {
      await schoolApi.startWorkflow({ logicalId, steps });
      await refreshWork();
      switchTab(tabForFeature(steps[0]!));
      toast(`${providerLabel(provider)} started: ${steps.map((step) => featureLabel(step).toLowerCase()).join(", then ")}.`, "info");
    } catch (error) {
      setActionError(error);
    } finally {
      setStarting(null);
    }
  };

  const cancelActive = async () => {
    setCancelling(true);
    setActionError(null);
    try {
      if (workflow) await schoolApi.cancelWorkflow(workflow.id);
      else if (activeRun) await schoolApi.cancelRun(activeRun.id);
      await refreshWork();
      toast(`${assistant} stopped.`, "info");
    } catch (error) {
      setActionError(error);
    } finally {
      setCancelling(false);
    }
  };

  if (taskState.error) {
    return <div>
      <Link to="/" className="back-link"><ArrowLeftIcon size={14} aria-hidden />Assignments</Link>
      <ErrorNotice error={taskState.error} title="This assignment could not load" />
    </div>;
  }
  if (!task) return <WorkspaceSkeleton />;
  // Canvas details arrive after the task; the page works without them meanwhile.
  const contextLoading = !context && !contextState.error;

  const canvasUrl = context?.assignment?.html_url ?? task.canvas.assignment_url ?? task.source.assignment_url ?? null;
  const externalUrl = context?.externalAssignment.url ?? null;
  const requirements = context?.submissionRequirements;
  const needsLink = Boolean(task.manually_managed && !canvasUrl && !contextLoading);
  const workflowDone = (["directions", "problemExtraction", "answerKey"] as const).every((feature) => results[feature] && !isActiveRun(latest[feature]));

  const menuItems: MenuEntry[] = [
    { label: "Edit task", icon: PencilSimpleIcon, onSelect: () => setEditing(true) },
    ...(externalUrl ? [{ label: "Open assignment link", icon: LinkSimpleIcon, onSelect: () => window.open(externalUrl, "_blank", "noopener,noreferrer") }] : []),
    "separator",
    { label: "Class instructions", icon: ChalkboardTeacherIcon, onSelect: () => navigate(`/classes?class=${encodeURIComponent(task.course.id)}`) },
    ...(taskSyncUrl ? [{ label: "Class in Task Sync", icon: ArrowSquareOutIcon, onSelect: () => window.open(taskSyncPages.course(taskSyncUrl, task.course.id), "_blank", "noopener,noreferrer") }] : []),
  ];

  return (
    <div className="page--assignment">
      <Link to="/" className="back-link"><ArrowLeftIcon size={14} aria-hidden />Assignments</Link>
      <header className="assignment-head">
        <div className="assignment-head__text">
          <div className="assignment-head__class">
            <span className={`class-mark class-tone-${classTone(task.course.id)}`} aria-hidden>{classMarkText(task.course.prefix, task.course.name)}</span>
            <span>{task.course.name}</span>
          </div>
          <h1>{task.display_title}</h1>
          <AssignmentMeta task={task} requirements={requirements} />
        </div>
        <div className="assignment-head__actions">
          {canvasUrl ? <LinkButton href={canvasUrl} icon={ArrowSquareOutIcon}>Open in Canvas</LinkButton> : null}
          {requirements?.supported && !requirements.locked ? <Button variant="secondary" icon={PaperPlaneTiltIcon} onClick={() => setSubmitOpen(true)}>Submit</Button> : null}
          <Menu label="More actions" trigger={<DotsThreeIcon size={20} weight="bold" aria-hidden />} triggerClassName="btn btn--ghost btn--icon" items={menuItems} />
        </div>
      </header>

      {contextState.error ? <div className="shell-notices"><Notice tone="warning" title="Canvas details could not load">{contextState.error instanceof Error ? contextState.error.message : "Try again in a moment."}</Notice></div> : null}
      {needsLink ? (
        <div className="shell-notices">
          <Notice tone="info" title="This task has no Canvas assignment link" actions={<Button variant="secondary" size="sm" icon={PencilSimpleIcon} onClick={() => setEditing(true)}>Edit task</Button>}>
            <p>Add one so {providerLabel(provider)} can read the assignment.</p>
          </Notice>
        </div>
      ) : null}
      {actionError ? <div className="shell-notices"><ErrorNotice error={actionError} title="That didn't start" /></div> : null}

      <AgentBar
        activeWork={activeState.data}
        workflow={workflow}
        activeRun={activeRun}
        workflowDone={workflowDone}
        assistant={assistant}
        available={agents.available}
        reason={agents.reason}
        starting={starting}
        cancelling={cancelling}
        tab={tab}
        onStart={(id, steps) => void startWorkflow(id, steps)}
        onCancel={() => void cancelActive()}
      />

      <div className="tabs" role="tablist" aria-label="Assignment results">
        {features.map((feature) => {
          const run = latest[feature.id];
          const selected = tab === feature.tab;
          return (
            <button
              key={feature.id}
              type="button"
              role="tab"
              id={`tab-${feature.tab}`}
              aria-selected={selected}
              aria-controls={`panel-${feature.tab}`}
              className="tab"
              onClick={() => switchTab(feature.tab)}
            >
              {feature.label}
              <TabState run={run} hasResult={Boolean(results[feature.id])} />
            </button>
          );
        })}
      </div>

      <section role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "directions" ? (
          <DirectionsPanel run={latest.directions} result={results.directions} onRun={() => void start("directions")} starting={starting === "directions"} disabled={busy} />
        ) : null}
        {tab === "problems" ? (
          <ProblemsPanel run={latest.problemExtraction} result={results.problemExtraction} answerResult={results.answerKey} onRun={() => void start("problemExtraction")} starting={starting === "problemExtraction"} disabled={busy} />
        ) : null}
        {tab === "answers" ? (
          <AnswerKeyPanel run={latest.answerKey} result={results.answerKey} extractionReady={Boolean(results.problemExtraction)} onRun={() => void start("answerKey")} starting={starting === "answerKey"} disabled={busy} onShowProblems={() => switchTab("problems")} />
        ) : null}
        {tab === "study" ? (
          <StudyGuidePanel
            run={latest.studyGuide}
            result={results.studyGuide}
            model={studyModel}
            setModel={setStudyModel}
            reasoning={reasoning}
            setReasoning={setReasoning}
            predictor={predictor}
            setPredictor={setPredictor}
            onRun={() => void start("studyGuide")}
            starting={starting === "studyGuide"}
            disabled={busy}
          />
        ) : null}
      </section>

      {submitOpen && requirements ? <SubmissionDialog logicalId={logicalId} title={task.display_title} types={requirements.submissionTypes} extensions={requirements.allowedExtensions} onClose={() => setSubmitOpen(false)} /> : null}
      {editing ? <TaskEditor
        task={task}
        courses={[{ id: task.course.id, settings: { name: task.course.name, prefix: task.course.prefix } }]}
        onClose={() => setEditing(false)}
        onSaved={async (saved) => {
          setEditing(false);
          taskState.setData(saved);
          toast("Task updated in Google Tasks.", "success");
          await Promise.all([taskState.refresh(), contextState.refresh()].map((request) => request.catch(() => undefined)));
        }}
      /> : null}
    </div>
  );
}

function AssignmentMeta({ task, requirements }: { task: TrackedTask; requirements?: AssignmentContext["submissionRequirements"] }) {
  const overdue = task.completed === false && task.due_date ? isPastDue(task.due_date) : false;
  const submission = requirements ? submissionSummary(requirements) : null;
  return <div className="assignment-head__meta">
    <span className={overdue ? "is-overdue" : undefined}>
      <CalendarBlankIcon size={15} aria-hidden />
      {task.due_date ? `${overdue ? "Was due" : "Due"} ${formatDue(task.due_date, true)}` : "No due date"}
      {task.due_uncertain ? <span className="tone-warning" title={task.due_uncertain_reason ?? undefined}>(estimated)</span> : null}
    </span>
    {submission ? <span><UploadSimpleIcon size={15} aria-hidden />{submission}</span> : null}
    {requirements?.pointsPossible ? <span><TargetIcon size={15} aria-hidden />{requirements.pointsPossible} points</span> : null}
    {requirements?.locked ? <span className="is-locked" title={requirements.lockExplanation ?? undefined}><LockSimpleIcon size={15} aria-hidden />Locked in Canvas</span> : null}
    {task.completed ? <span className="tone-success"><CheckCircleIcon size={15} weight="fill" aria-hidden />Done</span> : null}
  </div>;
}

function TabState({ run, hasResult }: { run?: AgentRun; hasResult: boolean }) {
  if (!run) return null;
  if (isActiveRun(run)) return <span className="tab__state"><CircleNotchIcon className="spin tone-info" size={14} weight="bold" aria-label="Running" /></span>;
  if (run.status === "failed") return <span className="tab__state"><WarningCircleIcon className={hasResult ? "tone-warning" : "tone-danger"} size={15} weight="fill" aria-label="Last run failed" /></span>;
  if (hasResult) return <span className="tab__state"><CheckCircleIcon className="tone-success" size={15} weight="fill" aria-label="Ready" /></span>;
  return null;
}

// One place to start the agent on the whole assignment, or to watch and stop what it is doing.
function AgentBar({ activeWork, workflow, activeRun, workflowDone, assistant, available, reason, starting, cancelling, tab, onStart, onCancel }: {
  activeWork: ActiveWork | null;
  workflow: ActiveWork["workflows"][number] | null;
  activeRun: AgentRun | null;
  workflowDone: boolean;
  assistant: string;
  available: boolean;
  reason: string | null;
  starting: string | null;
  cancelling: boolean;
  tab: WorkspaceTab;
  onStart: (id: string, steps: WorkflowFeature[]) => void;
  onCancel: () => void;
}) {
  if (workflow || activeRun) {
    const runId = workflow?.currentRunId ?? activeRun?.id ?? null;
    const progress = activeWork?.runs.find((item) => item.run.id === runId)?.progress ?? null;
    const step = workflow && workflow.currentStep !== null ? workflow.steps[workflow.currentStep] : null;
    const feature = step?.feature ?? activeRun?.feature ?? null;
    const doing = feature ? featureLabel(feature) : "this assignment";
    // The open tab already shows this run's live activity; say something new here instead.
    const watching = feature !== null && tabForFeature(feature) === tab;
    return <section className="surface agent-bar agent-bar--active" aria-label={`${assistant} is working`}>
      <header>
        <span className="agent-bar__icon"><CircleNotchIcon className="spin" size={18} weight="bold" aria-hidden /></span>
        <div className="agent-bar__text">
          <strong>{assistant} is working on {doing.toLowerCase()}</strong>
          <span>{watching ? "It keeps going if you leave this page." : progress?.current ?? "Starting up"}</span>
        </div>
        <div className="agent-bar__actions">
          <Button variant="secondary" size="sm" icon={StopIcon} loading={cancelling} onClick={onCancel}>Cancel {assistant}</Button>
        </div>
      </header>
      {workflow ? (
        <div className="progress-panel">
          <ol className="steps-inline" aria-label="Workflow steps">
            {workflow.steps.map((item, index) => (
              <li className={item.status} key={`${item.feature}-${index}`}>
                {item.status === "completed" ? <CheckIcon size={13} weight="bold" aria-hidden /> : item.status === "running" ? <CircleNotchIcon className="spin" size={13} weight="bold" aria-hidden /> : null}
                {featureLabel(item.feature)}
                {item.status === "completed" ? <span className="sr-only"> (done)</span> : item.status === "running" ? <span className="sr-only"> (running)</span> : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>;
  }
  if (workflowDone) return null;
  const full = workflows[0]!;
  const others = workflows.slice(1);
  return <section className="surface agent-bar" aria-label="Agent workflow">
    <span className="agent-bar__icon"><SparkleIcon size={18} aria-hidden /></span>
    <div className="agent-bar__text">
      <strong>Let {assistant} work through this assignment</strong>
      <span>{available ? "Reads the directions, finds the assigned problems, then writes an answer key." : "Agents are offline right now."}</span>
    </div>
    <div className="agent-bar__actions btn-split">
      <Button
        icon={SparkleIcon}
        loading={starting === `workflow:${full.id}`}
        disabled={Boolean(starting) || !available}
        title={reason ?? full.detail}
        onClick={() => onStart(full.id, full.steps)}
      >{full.label}</Button>
      <Menu
        label="Run part of the workflow"
        trigger={<CaretDownIcon size={14} weight="bold" aria-hidden />}
        triggerClassName="btn btn--primary"
        disabled={Boolean(starting) || !available}
        items={others.map((item) => ({ label: item.label, icon: item.icon, onSelect: () => onStart(item.id, item.steps) }))}
      />
    </div>
  </section>;
}

function PanelHead({ title, run, action }: { title: string; run?: AgentRun; action?: ReactNode }) {
  return <div className="panel-head">
    <div className="panel-head__text">
      <h2>{title}</h2>
      {run ? <RunLine run={run} /> : null}
    </div>
    {action ? <div className="panel-head__actions">{action}</div> : null}
  </div>;
}

function RunLine({ run }: { run: AgentRun }) {
  const effort = run.effectiveReasoningEffort || run.reasoningEffort;
  const when = run.completedAt ? formatRelative(run.completedAt) : `started ${formatRelative(run.startedAt)}`;
  return <p className="run-line" title={formatTokens(run.usage) ?? undefined}>
    {run.status !== "completed" ? <RunStatusBadge status={run.status} /> : null}
    <span>{modelLabel(run.model)}, {effortLabel(effort).toLowerCase()} {run.provider === "claude" ? "effort" : "reasoning"}, {when}</span>
  </p>;
}

const ERROR_PREVIEW = 180;

// A run's state above its result: live progress, or why the latest run stopped. An earlier result
// stays below either way.
function RunState({ run, hasResult, label, onRetry, disabled }: { run?: AgentRun; hasResult: boolean; label: string; onRetry: () => void; disabled: boolean }) {
  if (!run) return null;
  if (isActiveRun(run)) return <div className="surface run-progress"><RunProgressPanel run={run} /></div>;
  if (run.status === "failed") {
    const message = run.error || "The run failed.";
    const preview = message.length > ERROR_PREVIEW ? `${message.slice(0, ERROR_PREVIEW).trimEnd()}...` : message;
    return <div className="run-progress">
      <Notice
        tone={hasResult ? "warning" : "danger"}
        title={hasResult ? "The latest run didn't finish. This is the previous result." : `${label} didn't finish`}
        actions={<Button variant="secondary" size="sm" icon={ArrowClockwiseIcon} disabled={disabled} onClick={onRetry}>Try again</Button>}
      >
        <p>{preview}</p>
        {preview !== message ? <details className="reveal"><summary><CaretRightIcon size={13} weight="bold" aria-hidden />Full error</summary><pre className="code-block reveal__body">{message}</pre></details> : null}
      </Notice>
    </div>;
  }
  if (run.status === "cancelled" && !hasResult) return <div className="run-progress"><Notice tone="info" title={`${label} was cancelled`}>Run it again when you're ready.</Notice></div>;
  return null;
}

function RunButton({ run, label, again = "Run again", icon, starting, disabled, onRun }: {
  run?: AgentRun;
  label: string;
  again?: string;
  icon?: typeof SparkleIcon;
  starting: boolean;
  disabled: boolean;
  onRun: () => void;
}) {
  const agents = useAgentAvailability();
  const active = isActiveRun(run);
  return <Button
    variant={run ? "secondary" : "primary"}
    icon={run ? ArrowClockwiseIcon : icon}
    loading={starting || active}
    disabled={disabled || !agents.available}
    title={agents.reason ?? undefined}
    onClick={onRun}
  >{run ? again : label}</Button>;
}

function DirectionsPanel({ run, result, onRun, starting, disabled }: { run?: AgentRun; result?: AgentRun; onRun: () => void; starting: boolean; disabled: boolean }) {
  const provider = useSelectedAgentProvider();
  const output = result ? result.output as AssignmentDirections | null : null;
  const assistant = providerLabel(result?.provider ?? run?.provider ?? provider);
  const hasSources = Boolean(output && (
    output.resources.length ||
    output.sourcesInspected.length ||
    output.instructions.some((item) => item.provenance.length) ||
    output.assignedWork.some((item) => item.provenance.length)
  ));
  const instructionList = output && output.instructions.length > 0
    ? <ol className="direction-list">{output.instructions.map((instruction, index) => (
        <li key={`${instruction.heading}-${index}`}>
          <div><strong>{instruction.heading}</strong><Markdown>{instruction.markdown}</Markdown></div>
        </li>
      ))}</ol>
    : null;
  const button = <RunButton run={run} label="Get directions" icon={SparkleIcon} again="Get directions again" starting={starting} disabled={disabled} onRun={onRun} />;
  return (
    <div>
      <PanelHead title="Directions" run={result ?? run} action={run ? button : null} />
      <RunState run={run} hasResult={Boolean(result)} label="Directions" onRetry={onRun} disabled={disabled} />
      {!run ? <div className="surface">
        <EmptyState
          icon={SparkleIcon}
          title="Get the directions"
          body={`${assistant} reads the assignment, what to turn in, the module around it, and any linked Canvas files, then explains it plainly.`}
          action={button}
        />
      </div> : null}
      {output ? (
        <div className="reading-grid">
          <article className="surface paper">
            <div className="paper__title"><h3>{output.assignmentTitle || "Assignment directions"}</h3><small>Summary by {assistant}</small></div>
            <Markdown>{output.overviewMarkdown}</Markdown>
            {output.assignedWork.length === 0 ? instructionList : null}
            {output.assignedWork.length > 0 ? (
              <section className="assigned-work">
                <h3>What to complete</h3>
                {output.assignedWork.map((group) => (
                  <div key={group.label}><strong>{group.label}</strong><ul>{group.items.map((item) => <li key={item}>{item}</li>)}</ul></div>
                ))}
              </section>
            ) : null}
            {output.assignedWork.length > 0 && instructionList ? (
              <details className="reveal"><summary><CaretRightIcon size={13} weight="bold" aria-hidden />Step-by-step notes</summary>{instructionList}</details>
            ) : null}
            {output.notices.map((notice, index) => (
              <Notice key={index} tone={notice.level === "warning" ? "warning" : "info"}><Markdown>{notice.markdown}</Markdown></Notice>
            ))}
          </article>
          <aside className="rail" aria-label="Submission">
            <section className="rail__section">
              <h3>How to submit</h3>
              <Markdown>{firstSentence(output.submission.methodMarkdown)}</Markdown>
            </section>
            {output.submission.deliverables.length > 0 ? (
              <section className="rail__section">
                <h3>Turn in</h3>
                <ul>{output.submission.deliverables.slice(0, 3).map((item) => <li key={item}>{item}</li>)}</ul>
                {output.submission.deliverables.length > 3 ? (
                  <details className="reveal">
                    <summary><CaretRightIcon size={13} weight="bold" aria-hidden />{output.submission.deliverables.length - 3} more</summary>
                    <ul>{output.submission.deliverables.slice(3).map((item) => <li key={item}>{item}</li>)}</ul>
                  </details>
                ) : null}
              </section>
            ) : null}
            {output.submission.dueMarkdown ? (
              <section className="rail__section"><h3>Due</h3><p className="rail__due">{simpleDue(output.submission.dueMarkdown)}</p></section>
            ) : null}
            {hasSources ? (
              <details className="reveal">
                <summary><CaretRightIcon size={13} weight="bold" aria-hidden />View sources</summary>
                <div className="reveal__body provenance">
                  {output.resources.length > 0 ? <ul className="source-list">{output.resources.map((resource, index) => (
                    <li key={`${resource.title}-${index}`}>
                      {resource.url ? <a href={resource.url} target="_blank" rel="noreferrer">{resource.title}<ArrowSquareOutIcon size={12} aria-hidden /></a> : <strong>{resource.title}</strong>}
                      <span>{resource.description}</span>
                    </li>
                  ))}</ul> : null}
                  {output.instructions.map((instruction, index) => instruction.provenance.length > 0 ? <div className="detail-section" key={`instruction-${index}`}><h3>{instruction.heading}</h3><ProvenanceList items={instruction.provenance} /></div> : null)}
                  {output.assignedWork.map((group, index) => group.provenance.length > 0 ? <div className="detail-section" key={`work-${index}`}><h3>{group.label}</h3><ProvenanceList items={group.provenance} /></div> : null)}
                  {output.sourcesInspected.length > 0 ? <ul className="source-list">{output.sourcesInspected.map((source, index) => (
                    <li key={`${source.name}-${index}`}>
                      {source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.name}</a> : <strong>{source.name}</strong>}
                      <span>{source.relevance}</span>
                    </li>
                  ))}</ul> : null}
                </div>
              </details>
            ) : null}
          </aside>
        </div>
      ) : null}
    </div>
  );
}

function ProblemsPanel({ run, result, answerResult, onRun, starting, disabled }: { run?: AgentRun; result?: AgentRun; answerResult?: AgentRun; onRun: () => void; starting: boolean; disabled: boolean }) {
  const provider = useSelectedAgentProvider();
  const output = result ? result.output as ProblemExtraction | null : null;
  const answerBanks = output?.answerBanks ?? [];
  const answers = (answerResult?.output as AnswerKey | null | undefined)?.answers ?? [];
  const [pageRequest, setPageRequest] = useState<SourcePageRequest | null>(null);
  const openPage = (label: string) => (ref: SourcePageRef) => setPageRequest({ ...ref, label });
  const button = <RunButton run={run} label="Find the assigned problems" icon={SparkleIcon} again="Extract again" starting={starting} disabled={disabled} onRun={onRun} />;
  return (
    <div>
      <PanelHead title="Assigned problems" run={result ?? run} action={run ? button : null} />
      <RunState run={run} hasResult={Boolean(result)} label="Problem extraction" onRetry={onRun} disabled={disabled} />
      {!run ? <div className="surface">
        <EmptyState
          icon={SparkleIcon}
          title="Find the assigned problems"
          body={`${providerLabel(provider)} locates the exact questions in the directions, linked files, pages, and PDFs, with the figures they need.`}
          action={button}
        />
      </div> : null}
      {output ? <>
        <p className="summary-line">{output.summary}</p>
        <div className="problem-stack">
          {output.problems.map((problem, index) => {
            const occurrence = output.problems
              .slice(0, index + 1)
              .filter((item) => item.number === problem.number).length - 1;
            const answer = answers.filter((item) => item.problemNumber === problem.number)[occurrence]
              ?? (answers[index]?.problemNumber === problem.number ? answers[index] : undefined);
            const banks = answerBanks.filter((bank) => output.problems.findIndex((item) => item.answerBankId === bank.id) === index);
            const sourcePages = problem.sourcePages ?? [];
            const visualPage = sourcePages.find((item) => item.page === problem.visual?.page) ?? sourcePages[0];
            const showPage = openPage(`Problem ${problem.number}`);
            return <Fragment key={`${problem.number}-${index}`}>
              {banks.map((bank) => <AnswerBank key={bank.id} bank={bank} />)}
              <article className="surface problem">
                <div className="problem__head">
                  <span className="problem__number">Problem {problem.number}</span>
                  {problem.confidence !== "high" ? <span className={`badge ${problem.confidence === "low" ? "badge--danger" : "badge--warning"}`}>{problem.confidence === "low" ? "Low" : "Medium"} confidence</span> : null}
                  <span className="problem__head-end">
                    {(problem.visual || problem.missingVisual) && visualPage
                      ? <Button variant="secondary" size="sm" icon={ScanIcon} onClick={() => showPage(visualPage)} title="Open the whole source page beside this problem">View page {visualPage.page}</Button>
                      : null}
                  </span>
                </div>
                <Markdown className="problem-markdown">{problem.markdown}</Markdown>
                {problem.table ? <ProblemTable table={problem.table} /> : null}
                {problem.visual ? <ProblemVisual visual={problem.visual} workspaceId={result?.workspaceId ?? null} /> : null}
                {problem.missingVisual ? <MissingVisualNotice missing={problem.missingVisual} /> : null}
                {answer ? <details className="inline-answer">
                  <summary>Show answer <CaretDownIcon size={15} aria-hidden /></summary>
                  <div className="inline-answer__body">
                    <Markdown>{answer.finalAnswerMarkdown}</Markdown>
                    <details className="reveal"><summary><CaretRightIcon size={13} weight="bold" aria-hidden />Full solution</summary><div className="reveal__body"><Markdown>{answer.solutionMarkdown}</Markdown></div></details>
                  </div>
                </details> : null}
                <SourceDisclosure items={problem.provenance} pages={sourcePages} onOpenPage={showPage} />
              </article>
            </Fragment>;
          })}
          {output.unresolved.length > 0 ? <section className="unresolved">
            <h3><WarningIcon size={16} weight="fill" aria-hidden />Could not verify</h3>
            {output.unresolved.map((item) => <div key={item.reference}>
              <strong>{item.reference}</strong>
              <p>{item.reason}</p>
              {item.searched.length > 0 ? <span>Searched: {item.searched.join(", ")}</span> : null}
            </div>)}
          </section> : null}
        </div>
      </> : null}
      {pageRequest && output ? <SourcePageViewer
        documents={output.sourceDocuments ?? []}
        workspaceId={result?.workspaceId ?? null}
        request={pageRequest}
        onNavigate={(page) => setPageRequest({ ...pageRequest, page })}
        onClose={() => setPageRequest(null)}
      /> : null}
    </div>
  );
}

function MissingVisualNotice({ missing }: { missing: MissingVisual }) {
  const heading = missing.status === "not_in_source"
    ? `${missing.reference} isn't included in the assignment files`
    : `${missing.reference} couldn't be attached`;
  return <Notice tone={missing.status === "not_in_source" ? "info" : "warning"} icon={ImageBrokenIcon} title={heading} role="note">
    <p>{missing.detail}</p>
  </Notice>;
}

function AnswerBank({ bank }: { bank: NonNullable<ProblemExtraction["answerBanks"]>[number] }) {
  return <aside className="answer-bank" aria-label={`${bank.title} for problems ${bank.problemNumbers.join(", ")}`}>
    <header>
      <span className="badge badge--accent">Answer bank</span>
      <strong>{bank.title}</strong>
      <small>Problems {bank.problemNumbers.join(", ")}</small>
    </header>
    <Markdown className="problem-markdown">{bank.markdown}</Markdown>
    <SourceDisclosure items={bank.provenance} />
  </aside>;
}

function ProblemTable({ table }: { table: NonNullable<ProblemExtraction["problems"][number]["table"]> }) {
  return <div className="problem-table-wrap">
    <table className="problem-table">
      {table.caption ? <caption>{table.caption}</caption> : null}
      <thead><tr>{table.columns.map((column, index) => <th key={`${column}-${index}`} scope="col"><Markdown>{column}</Markdown></th>)}</tr></thead>
      <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}><Markdown>{cell}</Markdown></td>)}</tr>)}</tbody>
    </table>
  </div>;
}

function AnswerKeyPanel({ run, result, extractionReady: ready, onRun, starting, disabled, onShowProblems }: {
  run?: AgentRun;
  result?: AgentRun;
  extractionReady: boolean;
  onRun: () => void;
  starting: boolean;
  disabled: boolean;
  onShowProblems: () => void;
}) {
  const provider = useSelectedAgentProvider();
  const output = result ? result.output as AnswerKey | null : null;
  const button = <RunButton run={run} label="Write the answer key" icon={SparkleIcon} again="Generate again" starting={starting} disabled={disabled || !ready} onRun={onRun} />;
  return <div>
    <PanelHead title="Answer key" run={result ?? run} action={run ? button : null} />
    {!ready ? <div className="run-progress">
      <Notice tone="warning" title="Find the assigned problems first" actions={<Button variant="secondary" size="sm" onClick={onShowProblems}>Go to assigned problems</Button>}>
        <p>The answer key only solves problems that were extracted from the assignment, never guessed ones.</p>
      </Notice>
    </div> : null}
    <RunState run={run} hasResult={Boolean(result)} label="Answer key" onRetry={onRun} disabled={disabled || !ready} />
    {!run && ready ? <div className="surface">
      <EmptyState
        icon={SparkleIcon}
        title="Write the answer key"
        body={`${providerLabel(provider)} solves each extracted problem, final answer first, with a worked solution underneath.`}
        action={button}
      />
    </div> : null}
    {output ? <>
      <p className="summary-line">{output.summary}</p>
      <div className="answer-stack">
        {output.answers.map((answer, index) => <article className="surface answer" key={`${answer.problemNumber}-${index}`}>
          <div className="answer__head"><span className="problem__number">Problem {answer.problemNumber}</span></div>
          <div className="final-answer"><span>Final answer</span><Markdown>{answer.finalAnswerMarkdown}</Markdown></div>
          <details className="reveal"><summary><CaretRightIcon size={13} weight="bold" aria-hidden />Show full solution</summary><div className="reveal__body"><Markdown>{answer.solutionMarkdown}</Markdown></div></details>
        </article>)}
      </div>
    </> : null}
  </div>;
}

function StudyGuidePanel({ run, result, model, setModel, reasoning, setReasoning, predictor, setPredictor, onRun, starting, disabled }: {
  run?: AgentRun;
  result?: AgentRun;
  model: string;
  setModel: (value: string) => void;
  reasoning: ReasoningEffort | "default";
  setReasoning: (value: ReasoningEffort | "default") => void;
  predictor: boolean;
  setPredictor: (value: boolean) => void;
  onRun: () => void;
  starting: boolean;
  disabled: boolean;
}) {
  const provider: AgentProvider = useSelectedAgentProvider();
  const { selectable: codexModels, claude: claudeModels } = useSelectableModels();
  // The lists follow the agent selected in the top bar; a choice made for the other agent falls
  // back to the configured model.
  const selectable = provider === "claude" ? claudeModels : codexModels;
  const modelValue = selectable.some((item) => item.id === model) ? model : "";
  const efforts: string[] = provider === "claude" ? [...effortLevels] : ["minimal", ...effortLevels];
  const reasoningValue = efforts.includes(reasoning) ? reasoning : "default";
  const output = result ? result.output as StudyGuide | null : null;
  return <div>
    <PanelHead title="Study guide" run={result ?? run} />
    <div className="surface study-config">
      <Field label={`${providerLabel(provider)} model`}>
        <select className="control" value={modelValue} onChange={(event) => setModel(event.target.value)}>
          <option value="">Settings default</option>
          {selectable.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
        </select>
      </Field>
      <Field label={provider === "claude" ? "Effort" : "Reasoning"}>
        <select className="control" value={reasoningValue} onChange={(event) => setReasoning(event.target.value as ReasoningEffort | "default")}>
          <option value="default">{effortLabel("default")}</option>
          {efforts.map((item) => <option key={item} value={item}>{effortLabel(item)}</option>)}
        </select>
      </Field>
      <label className="check">
        <input type="checkbox" checked={predictor} onChange={(event) => setPredictor(event.target.checked)} />
        <span className="check__text"><strong>Use Test Question Predictor</strong><small>Adds likely questions when it's set up</small></span>
      </label>
      <RunButton run={run} label="Generate study guide" icon={SparkleIcon} again="Generate again" starting={starting} disabled={disabled} onRun={onRun} />
    </div>
    <RunState run={run} hasResult={Boolean(result)} label="Study guide" onRetry={onRun} disabled={disabled} />
    {!run ? <div className="surface">
      <EmptyState icon={SparkleIcon} title="No study guide yet" body="Builds a focused guide from the assessment, nearby modules, and review material, with practice questions grounded in what it read." />
    </div> : null}
    {output ? <div className="study-output">
      <nav className="study-toc" aria-label="Study guide sections">
        <a href="#study-scope">Scope</a>
        <a href="#study-concepts">Key concepts</a>
        <a href="#study-practice">Practice questions</a>
      </nav>
      <div className="study-reading">
        <p className="summary-line">{output.overview}</p>
        {output.predictor.status !== "disabled" ? (
          <Notice tone={output.predictor.status === "available" ? "info" : "warning"} title={`Test Question Predictor ${output.predictor.status === "available" ? "used" : "unavailable"}`}>
            <p>{output.predictor.message}</p>
          </Notice>
        ) : null}
        <section id="study-scope" className="evidence-grid">
          <EvidenceList title="What the teacher said" items={output.teacherStatedScope.map((item) => ({ title: item.topic, detail: item.evidence }))} />
          <EvidenceList title="Also likely, by inference" items={output.agentInferredTopics.map((item) => ({ title: item.topic, detail: item.rationale }))} />
        </section>
        <section id="study-concepts" className="study-reading">
          {output.sections.map((section) => <article className="surface study-section" key={section.heading}>
            <h3>{section.heading}</h3>
            <Markdown>{section.explanationMarkdown}</Markdown>
            {section.keyIdeas.length ? <ul>{section.keyIdeas.map((idea) => <li key={idea}>{idea}</li>)}</ul> : null}
          </article>)}
        </section>
        <section id="study-practice" className="practice">
          <h3>Practice questions</h3>
          <div className="surface">
            {output.practiceQuestions.map((question, index) => <details className="practice__item" key={index}>
              <summary>
                <span className="practice__num">{index + 1}</span>
                <Markdown>{question.questionMarkdown}</Markdown>
                <CaretDownIcon size={16} aria-hidden />
              </summary>
              <div className="practice__answer">
                <small>Answer</small>
                <Markdown>{question.answerMarkdown}</Markdown>
                <p>{question.basis}</p>
              </div>
            </details>)}
          </div>
        </section>
      </div>
    </div> : null}
  </div>;
}

function EvidenceList({ title, items }: { title: string; items: Array<{ title: string; detail: string }> }) {
  return <section className="surface evidence">
    <h3>{title}</h3>
    {items.length ? items.map((item) => <div key={item.title}><strong>{item.title}</strong><p>{item.detail}</p></div>) : <p className="muted">Nothing in this group.</p>}
  </section>;
}

function ProvenanceList({ items }: { items: Provenance }) {
  return <div className="provenance">
    {items.map((item, index) => <div className="provenance__item" key={`${item.sourceName}-${index}`}>
      {item.sourceUrl ? <a href={item.sourceUrl} target="_blank" rel="noreferrer">{item.sourceName}</a> : <strong>{item.sourceName}</strong>}
      <small>{item.page ? `Page ${item.page}. ` : ""}{item.evidence}</small>
    </div>)}
  </div>;
}

function SourceDisclosure({ items, pages = [], onOpenPage }: { items: Provenance; pages?: SourcePageRef[]; onOpenPage?: (page: SourcePageRef) => void }) {
  if (!items.length) return null;
  return <details className="reveal">
    <summary><CaretRightIcon size={13} weight="bold" aria-hidden />View sources</summary>
    <div className="reveal__body">
      <ProvenanceList items={items} />
      {onOpenPage && pages.length > 0 ? <div className="page-chips">
        <span>Source pages</span>
        {pages.map((page) => <Button key={`${page.documentId}-${page.page}`} variant="secondary" size="sm" icon={ScanIcon} onClick={() => onOpenPage(page)}>Page {page.page}</Button>)}
      </div> : null}
    </div>
  </details>;
}

function firstSentence(markdown: string): string {
  const normalized = markdown.trim();
  const match = normalized.match(/^([\s\S]*?[.!?])(?:\s|$)/);
  return (match?.[1] ?? normalized).trim();
}

function simpleDue(markdown: string): string {
  return markdown
    .replace(/^due\s+/i, "")
    .replace(/,?\s+(?:according to|based on)\b[\s\S]*$/i, "")
    .trim();
}

const submissionNames: Record<string, string> = {
  online_upload: "file upload",
  online_text_entry: "text entry",
  online_url: "website link",
  media_recording: "media recording",
  on_paper: "on paper",
  external_tool: "external tool",
  discussion_topic: "discussion post",
  online_quiz: "Canvas quiz",
  student_annotation: "annotation",
};

function submissionName(type: string): string {
  return submissionNames[type] ?? type.replace(/^online_/, "").replaceAll("_", " ");
}

function submissionSummary(requirements: AssignmentContext["submissionRequirements"]): string | null {
  const types = requirements.submissionTypes;
  if (types.length === 0 || types.includes("none")) return null;
  const kinds = types.map(submissionName).join(" or ");
  const extensions = requirements.allowedExtensions.length ? ` (${requirements.allowedExtensions.map((item) => item.toUpperCase()).join(", ")})` : "";
  return `${kinds.charAt(0).toUpperCase()}${kinds.slice(1)}${extensions}`;
}

function SubmissionDialog({ logicalId, title, types, extensions, onClose }: { logicalId: string; title: string; types: string[]; extensions: string[]; onClose: () => void }) {
  const supported = useMemo(() => types.filter((item) => ["online_text_entry", "online_url", "online_upload"].includes(item)), [types]);
  const [type, setType] = useState(supported[0] ?? "online_text_entry");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "done">("idle");
  const [error, setError] = useState<unknown>(null);
  const submit = async () => {
    setStatus("submitting");
    setError(null);
    try {
      const body = new FormData();
      body.set("type", type);
      body.set("confirmation", confirmation);
      if (type === "online_text_entry") body.set("text", text);
      if (type === "online_url") body.set("url", url);
      if (type === "online_upload" && file) body.set("file", file);
      const response = await fetch(`/api/tasks/${encodeURIComponent(logicalId)}/submit`, { method: "POST", body });
      if (!response.ok) throw new Error((await response.json() as { error?: string }).error || "Submission failed");
      setStatus("done");
    } catch (nextError) {
      setError(nextError);
      setStatus("idle");
    }
  };
  if (status === "done") {
    return <Modal title="Submitted to Canvas" onClose={onClose} footer={<Button onClick={onClose}>Done</Button>}>
      <Notice tone="success" title={title}>Canvas has your submission.</Notice>
    </Modal>;
  }
  const label = (item: string) => {
    const name = submissionName(item);
    return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
  };
  return <Modal
    title="Submit to Canvas"
    wide
    onClose={onClose}
    footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button variant="danger-solid" icon={PaperPlaneTiltIcon} loading={status === "submitting"} disabled={confirmation !== "SUBMIT"} onClick={() => void submit()}>Submit to Canvas</Button>
    </>}
  >
    <p>This turns in <strong>{title}</strong> on Canvas. Check the requirements first; a submission can't be taken back here.</p>
    {error ? <ErrorNotice error={error} title="Canvas didn't accept it" /> : null}
    {supported.length > 1 ? <Field label="Submission type">
      <select className="control" value={type} onChange={(event) => setType(event.target.value)}>
        {supported.map((item) => <option value={item} key={item}>{label(item)}</option>)}
      </select>
    </Field> : null}
    {type === "online_text_entry" ? <Field label="Response"><textarea className="control" rows={8} value={text} onChange={(event) => setText(event.target.value)} /></Field> : null}
    {type === "online_url" ? <Field label="URL"><input className="control" type="url" value={url} placeholder="https://" onChange={(event) => setUrl(event.target.value)} /></Field> : null}
    {type === "online_upload" ? <Field label="File" help={extensions.length ? `Allowed: ${extensions.join(", ")}` : "Canvas doesn't restrict the file type."}>
      <input className="control" type="file" accept={extensions.length ? extensions.map((item) => `.${item}`).join(",") : undefined} onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
    </Field> : null}
    <Field label={<>Type <strong>SUBMIT</strong> to confirm</>}>
      <input className="control" value={confirmation} autoComplete="off" onChange={(event) => setConfirmation(event.target.value)} />
    </Field>
  </Modal>;
}

function WorkspaceSkeleton() {
  return <div className="page--assignment">
    <Link to="/" className="back-link"><ArrowLeftIcon size={14} aria-hidden />Assignments</Link>
    <div className="page-loader" role="status" aria-label="Loading assignment">
      <span className="skeleton" /><span className="skeleton" /><span className="skeleton" />
    </div>
  </div>;
}
