import {
  ArrowLeft,
  ArrowUpRight,
  BookOpenCheck,
  Check,
  ChevronDown,
  CircleAlert,
  FileQuestion,
  FileText,
  NotebookTabs,
  LoaderCircle,
  Send,
  X,
} from "lucide-react";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { schoolApi } from "../api";
import { RunProgressPanel } from "../components/AgentProgress";
import { Markdown } from "../components/Markdown";
import { ProblemVisual } from "../components/ProblemVisual";
import { EmptyState, ErrorNotice, RunStatus } from "../components/Status";
import { classTone, formatDue, latestRun } from "../format";
import { usePolling } from "../hooks/usePolling";
import type {
  AgentRun,
  AnswerKey,
  AssignmentDirections,
  ModelName,
  ProblemExtraction,
  ReasoningEffort,
  StudyGuide,
} from "../types";

type Tab = "directions" | "problems" | "answers" | "study";

export function AssignmentWorkspace() {
  const { logicalId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (searchParams.get("tab") as Tab | null) ?? "directions";
  const taskState = usePolling(() => schoolApi.task(logicalId));
  const contextState = usePolling(() => schoolApi.context(logicalId));
  const runsState = usePolling(schoolApi.runs, 2500);
  const [starting, setStarting] = useState<AgentRun["feature"] | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [studyModel, setStudyModel] = useState<ModelName>("gpt-5.6-luna");
  const [reasoning, setReasoning] = useState<ReasoningEffort>("high");
  const [predictor, setPredictor] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const task = taskState.data;
  const context = contextState.data;
  const runs = runsState.data ?? [];
  const extractionRun = latestRun(runs, logicalId, "problemExtraction");
  const directionsRun = latestRun(runs, logicalId, "directions");
  const answerRun = latestRun(runs, logicalId, "answerKey");
  const studyRun = latestRun(runs, logicalId, "studyGuide");
  const activeRun = [directionsRun, extractionRun, answerRun, studyRun].find(isActiveRun);

  const switchTab = (next: Tab) => {
    const params = new URLSearchParams(searchParams);
    params.set("tab", next);
    setSearchParams(params);
  };

  const start = async (feature: AgentRun["feature"]) => {
    setStarting(feature);
    setActionError(null);
    try {
      await schoolApi.startRun({
        feature,
        logicalId,
        model: feature === "studyGuide" ? studyModel : undefined,
        reasoningEffort: feature === "studyGuide" ? reasoning : undefined,
        useTestQuestionPredictor: feature === "studyGuide" ? predictor : undefined,
        extractionRunId: feature === "answerKey" ? extractionRun?.id : undefined,
      });
      await runsState.refresh();
      switchTab(
        feature === "directions"
          ? "directions"
          : feature === "problemExtraction"
            ? "problems"
            : feature === "answerKey"
              ? "answers"
              : "study",
      );
    } catch (error) {
      setActionError(error);
    } finally {
      setStarting(null);
    }
  };

  const cancelActive = async () => {
    if (!activeRun) return;
    setCancelling(true);
    setActionError(null);
    try {
      await schoolApi.cancelRun(activeRun.id);
      await runsState.refresh();
    } catch (error) {
      setActionError(error);
    } finally {
      setCancelling(false);
    }
  };

  if (taskState.error) return <div className="standalone-page"><ErrorNotice error={taskState.error} /></div>;
  if (!task || !context) return <WorkspaceSkeleton />;

  const canvasUrl = context.assignment?.html_url ?? task.canvas.assignment_url;
  return (
    <div className="workspace-page">
      <header className="workspace-header">
        <Link to={`/?task=${encodeURIComponent(logicalId)}`} className="back-link"><ArrowLeft size={17} />My work</Link>
        <div className="workspace-title-row">
          <span className={`course-mark tone-${classTone(task.course.id)}`}>{task.course.prefix.slice(0, 3).toUpperCase()}</span>
          <div>
            <p>{task.course.name}<span>Due {formatDue(task.due_date)}</span></p>
            <h1>{task.display_title}</h1>
          </div>
        </div>
        <div className="workspace-actions">
          {activeRun ? (
            <button className="danger-button" disabled={cancelling} onClick={() => void cancelActive()}>
              {cancelling ? <LoaderCircle className="spin" size={16} /> : <X size={16} />}Cancel Luna
            </button>
          ) : null}
          {canvasUrl && <a className="secondary-button" href={canvasUrl} target="_blank" rel="noreferrer">Canvas<ArrowUpRight size={15} /></a>}
          {context.externalAssignment.url && <a className="secondary-button" href={context.externalAssignment.url} target="_blank" rel="noreferrer">Open assignment<ArrowUpRight size={15} /></a>}
          {context.submissionRequirements.supported && !context.submissionRequirements.locked && (
            <button className="primary-button" onClick={() => setSubmitOpen(true)}><Send size={16} />Submit</button>
          )}
        </div>
      </header>

      <nav className="workspace-tabs" aria-label="Assignment workspace">
        <TabButton active={tab === "directions"} onClick={() => switchTab("directions")} icon={FileText}>Directions</TabButton>
        <TabButton active={tab === "problems"} onClick={() => switchTab("problems")} icon={FileQuestion}>Assigned problems</TabButton>
        <TabButton active={tab === "answers"} onClick={() => switchTab("answers")} icon={BookOpenCheck}>Answer key</TabButton>
        <TabButton active={tab === "study"} onClick={() => switchTab("study")} icon={NotebookTabs}>Study guide</TabButton>
      </nav>

      <div className="workspace-body">
        {Boolean(actionError) && <ErrorNotice error={actionError} />}
        {tab === "directions" && (
          <DirectionsPanel
            run={directionsRun}
            onRun={() => void start("directions")}
            starting={starting === "directions"}
          />
        )}
        {tab === "problems" && (
          <ProblemsPanel
            run={extractionRun}
            answerRun={answerRun}
            onRun={() => void start("problemExtraction")}
            starting={starting === "problemExtraction"}
          />
        )}
        {tab === "answers" && (
          <AnswerKeyPanel
            run={answerRun}
            extractionRun={extractionRun}
            onRun={() => void start("answerKey")}
            starting={starting === "answerKey"}
          />
        )}
        {tab === "study" && (
          <StudyGuidePanel
            run={studyRun}
            model={studyModel}
            setModel={setStudyModel}
            reasoning={reasoning}
            setReasoning={setReasoning}
            predictor={predictor}
            setPredictor={setPredictor}
            onRun={() => void start("studyGuide")}
            starting={starting === "studyGuide"}
          />
        )}
      </div>
      {submitOpen && <SubmissionDialog logicalId={logicalId} title={task.display_title} types={context.submissionRequirements.submissionTypes} extensions={context.submissionRequirements.allowedExtensions} onClose={() => setSubmitOpen(false)} />}
    </div>
  );
}

function TabButton({ active, onClick, icon: Icon, children }: { active: boolean; onClick: () => void; icon: typeof FileText; children: string }) {
  return <button className={active ? "active" : ""} onClick={onClick}><Icon size={17} />{children}</button>;
}

function DirectionsPanel({ run, onRun, starting }: { run?: AgentRun; onRun: () => void; starting: boolean }) {
  const output = run?.output as AssignmentDirections | null;
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
  return (
    <div>
      <FeatureHeader title="Directions">
        <button className="primary-button" onClick={onRun} disabled={starting || isActiveRun(run)}>
          {starting || isActiveRun(run) ? <LoaderCircle className="spin" size={17} /> : <FileText size={17} />}
          {run ? "Get directions again" : "Get directions"}
        </button>
      </FeatureHeader>
      {run && <RunBanner run={run} />}
      {!run && <EmptyState title="Directions are ready to investigate" detail="Choose Get Directions and Luna will inspect the assignment, submission requirements, module neighborhood, and relevant linked Canvas resources." />}
      {run?.status === "failed" && <ErrorNotice error={new Error(run.error || "Directions run failed")} />}
      {output && (
        <div className="content-layout directions-output">
          <article className="paper-panel">
            <div className="paper-heading"><span>{output.assignmentTitle || "Assignment directions"}</span><small>Luna synthesis</small></div>
            <Markdown>{output.overviewMarkdown}</Markdown>
            {output.assignedWork.length === 0 && instructionList}
            {output.assignedWork.length > 0 && (
              <section className="assigned-work">
                <h2>What to complete</h2>
                {output.assignedWork.map((group) => (
                  <div key={group.label}><strong>{group.label}</strong><ul>{group.items.map((item) => <li key={item}>{item}</li>)}</ul></div>
                ))}
              </section>
            )}
            {output.assignedWork.length > 0 && instructionList && <details className="compact-details"><summary>View step-by-step notes</summary>{instructionList}</details>}
            {output.notices.map((notice, index) => <div className={`notice ${notice.level === "warning" ? "amber" : "blue"}`} key={index}><CircleAlert size={17} /><Markdown>{notice.markdown}</Markdown></div>)}
          </article>
          <aside className="context-rail">
            <h3>Submission</h3>
            <Markdown>{firstSentence(output.submission.methodMarkdown)}</Markdown>
            {output.submission.deliverables.length > 0 && <><h3 className="rail-subheading">Turn in</h3><ul className="compact-list">{output.submission.deliverables.slice(0, 3).map((item) => <li key={item}>{item}</li>)}</ul></>}
            {output.submission.deliverables.length > 3 && <details className="compact-details rail-details"><summary>More submission details</summary><ul className="compact-list">{output.submission.deliverables.slice(3).map((item) => <li key={item}>{item}</li>)}</ul></details>}
            <dl>
              {output.submission.dueMarkdown && <div><dt>Due</dt><dd>{simpleDue(output.submission.dueMarkdown)}</dd></div>}
            </dl>
            {hasSources && <details className="source-summary">
              <summary>View sources</summary>
              <div className="source-drawer">
                {output.resources.length > 0 && <ul className="resource-links">{output.resources.map((resource, index) => <li key={`${resource.title}-${index}`}>{resource.url ? <a href={resource.url} target="_blank" rel="noreferrer">{resource.title}<ArrowUpRight size={13} /></a> : <strong>{resource.title}</strong>}<span>{resource.kind} · {resource.description}</span></li>)}</ul>}
                {output.instructions.map((instruction, index) => instruction.provenance.length > 0 && <div className="source-group" key={`instruction-${index}`}><strong>{instruction.heading}</strong><Provenance items={instruction.provenance} /></div>)}
                {output.assignedWork.map((group, index) => group.provenance.length > 0 && <div className="source-group" key={`work-${index}`}><strong>{group.label}</strong><Provenance items={group.provenance} /></div>)}
                {output.sourcesInspected.map((source, index) => <p key={`${source.name}-${index}`}><strong>{source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.name}</a> : source.name}</strong><span>{source.relevance}</span></p>)}
              </div>
            </details>}
          </aside>
        </div>
      )}
    </div>
  );
}

function ProblemsPanel({ run, answerRun, onRun, starting }: { run?: AgentRun; answerRun?: AgentRun; onRun: () => void; starting: boolean }) {
  const output = run?.output as ProblemExtraction | null;
  const answerBanks = output?.answerBanks ?? [];
  const answers = answerRun?.status === "completed"
    ? (answerRun.output as AnswerKey | null)?.answers ?? []
    : [];
  return (
    <div>
      <FeatureHeader title="Assigned problems">
        <button className="primary-button" onClick={onRun} disabled={starting || isActiveRun(run)}>{starting || isActiveRun(run) ? <LoaderCircle className="spin" size={17} /> : <FileQuestion size={17} />}{run ? "Extract again" : "Get assigned problems"}</button>
      </FeatureHeader>
      {run && <RunBanner run={run} />}
      {!run && <EmptyState title="No problems extracted yet" detail="Start an extraction to locate exact questions in directions, linked files, pages, and PDFs." />}
      {run?.status === "failed" && <ErrorNotice error={new Error(run.error || "Extraction failed")} />}
      {output && <div className="problem-stack">
        <p className="feature-summary">{output.summary}</p>
        {output.problems.map((problem, index) => {
          const occurrence = output.problems
            .slice(0, index + 1)
            .filter((item) => item.number === problem.number).length - 1;
          const answer = answers.filter((item) => item.problemNumber === problem.number)[occurrence]
            ?? (answers[index]?.problemNumber === problem.number ? answers[index] : undefined);
          const banks = answerBanks.filter((bank) => {
            const firstLinkedIndex = output.problems.findIndex((item) => item.answerBankId === bank.id);
            return firstLinkedIndex === index;
          });
          return <Fragment key={`${problem.number}-${index}`}>
            {banks.map((bank) => <AnswerBankCard key={bank.id} bank={bank} />)}
            <article className="problem-panel">
              <div className="problem-number"><span>Problem</span>{problem.number}<small className={`confidence ${problem.confidence}`}>{problem.confidence}</small></div>
              <Markdown className="problem-markdown">{problem.markdown}</Markdown>
              {problem.table && <ProblemTable table={problem.table} />}
              {problem.visual && <ProblemVisual visual={problem.visual} workspaceId={run?.workspaceId ?? null} />}
              {answer && <details className="inline-answer">
                <summary>Show answer <ChevronDown size={15} /></summary>
                <div className="inline-answer-body">
                  <Markdown>{answer.finalAnswerMarkdown}</Markdown>
                  <details className="inline-solution"><summary>Show full solution <ChevronDown size={14} /></summary><Markdown>{answer.solutionMarkdown}</Markdown></details>
                </div>
              </details>}
              <SourceDisclosure items={problem.provenance} />
            </article>
          </Fragment>;
        })}
        {output.unresolved.length > 0 && <div className="unresolved-block"><h3>Could not verify</h3>{output.unresolved.map((item) => <div key={item.reference}><strong>{item.reference}</strong><p>{item.reason}</p><span>Searched: {item.searched.join(", ")}</span></div>)}</div>}
      </div>}
    </div>
  );
}

function AnswerBankCard({ bank }: { bank: NonNullable<ProblemExtraction["answerBanks"]>[number] }) {
  return <aside className="answer-bank" aria-label={`${bank.title} for problems ${bank.problemNumbers.join(", ")}`}>
    <header><span>Answer bank</span><strong>{bank.title}</strong><small>Problems {bank.problemNumbers.join("–")}</small></header>
    <Markdown className="problem-markdown">{bank.markdown}</Markdown>
    <SourceDisclosure items={bank.provenance} />
  </aside>;
}

function ProblemTable({ table }: { table: NonNullable<NonNullable<ProblemExtraction["problems"]>[number]["table"]> }) {
  return <div className="problem-table-wrap">
    <table className="problem-table">
      {table.caption && <caption>{table.caption}</caption>}
      <thead><tr>{table.columns.map((column, index) => <th key={`${column}-${index}`} scope="col"><Markdown>{column}</Markdown></th>)}</tr></thead>
      <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}><Markdown>{cell}</Markdown></td>)}</tr>)}</tbody>
    </table>
  </div>;
}

function AnswerKeyPanel({ run, extractionRun, onRun, starting }: { run?: AgentRun; extractionRun?: AgentRun; onRun: () => void; starting: boolean }) {
  const output = run?.output as AnswerKey | null;
  const ready = extractionRun?.status === "completed";
  return <div>
    <FeatureHeader title="Answer key">
      <button className="primary-button" disabled={!ready || starting || isActiveRun(run)} onClick={onRun}>{starting || isActiveRun(run) ? <LoaderCircle className="spin" size={17} /> : <BookOpenCheck size={17} />}{run ? "Generate again" : "Generate answer key"}</button>
    </FeatureHeader>
    {!ready && <div className="notice amber"><FileQuestion size={17} /><div><strong>Extract the assigned problems first</strong><p>The answer key never solves guessed problem descriptions.</p></div></div>}
    {run && <RunBanner run={run} />}
    {run?.status === "failed" && <ErrorNotice error={new Error(run.error || "Answer-key run failed")} />}
    {output && <div className="answer-stack"><p className="feature-summary">{output.summary}</p>{output.answers.map((answer, index) => <article className="answer-panel" key={`${answer.problemNumber}-${index}`}><div className="answer-heading"><span>Problem {answer.problemNumber}</span></div><div className="final-answer"><span>Final answer</span><Markdown>{answer.finalAnswerMarkdown}</Markdown></div><details><summary>Show full solution <ChevronDown size={16} /></summary><Markdown>{answer.solutionMarkdown}</Markdown></details></article>)}</div>}
  </div>;
}

function StudyGuidePanel({ run, model, setModel, reasoning, setReasoning, predictor, setPredictor, onRun, starting }: { run?: AgentRun; model: ModelName; setModel: (value: ModelName) => void; reasoning: ReasoningEffort; setReasoning: (value: ReasoningEffort) => void; predictor: boolean; setPredictor: (value: boolean) => void; onRun: () => void; starting: boolean }) {
  const output = run?.output as StudyGuide | null;
  return <div>
    <FeatureHeader title="Study guide" />
    <div className="generator-config">
      <label>Model<select value={model} onChange={(event) => setModel(event.target.value as ModelName)}>{(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"] as ModelName[]).map((item) => <option value={item} key={item}>{item.split("-").at(-1)}</option>)}</select></label>
      <label>Reasoning<select value={reasoning} onChange={(event) => setReasoning(event.target.value as ReasoningEffort)}>{["minimal", "low", "medium", "high", "xhigh", "max"].map((item) => <option key={item}>{item}</option>)}</select></label>
      <label className="check-field predictor-toggle"><input type="checkbox" checked={predictor} onChange={(event) => setPredictor(event.target.checked)} /><span><strong>Use Test Question Predictor</strong></span></label>
      <button className="primary-button" onClick={onRun} disabled={starting || isActiveRun(run)}>{starting || isActiveRun(run) ? <LoaderCircle className="spin" size={17} /> : <NotebookTabs size={17} />}{run ? "Generate again" : "Generate study guide"}</button>
    </div>
    {run && <RunBanner run={run} />}
    {!run && <EmptyState title="No study guide yet" detail="Choose a model and reasoning level, then generate a focused guide from the assessment and nearby course evidence." />}
    {run?.status === "failed" && <ErrorNotice error={new Error(run.error || "Study-guide run failed")} />}
    {output && <div className="study-output"><nav className="study-toc" aria-label="Study guide sections"><a href="#study-scope">Scope</a><a href="#study-concepts">Key concepts</a><a href="#study-practice">Practice questions</a></nav><div className="study-reading"><p className="feature-summary">{output.overview}</p>{output.predictor.status !== "disabled" ? <div className={`predictor-banner ${output.predictor.status}`}><strong>Test Question Predictor: {output.predictor.status}</strong><span>{output.predictor.message}</span></div> : null}<div id="study-scope"><EvidenceList title="Teacher-stated scope" items={output.teacherStatedScope.map((item) => ({ title: item.topic, detail: item.evidence }))} tone="teacher" /><EvidenceList title="Agent-inferred topics" items={output.agentInferredTopics.map((item) => ({ title: item.topic, detail: item.rationale }))} tone="inferred" /></div><section id="study-concepts" className="study-concepts">{output.sections.map((section) => <article className="study-section" key={section.heading}><h2>{section.heading}</h2><Markdown>{section.explanationMarkdown}</Markdown><ul>{section.keyIdeas.map((idea) => <li key={idea}>{idea}</li>)}</ul></article>)}</section><section id="study-practice" className="practice-section"><h2>Practice questions</h2>{output.practiceQuestions.map((question, index) => <details key={index}><summary><span>{index + 1}</span><Markdown>{question.questionMarkdown}</Markdown><ChevronDown size={16} /></summary><div className="practice-answer"><small>Answer</small><Markdown>{question.answerMarkdown}</Markdown><p>{question.basis}</p></div></details>)}</section></div></div>}
  </div>;
}

function FeatureHeader({ title, children }: { title: string; children?: ReactNode }) {
  return <header className="feature-header"><h2>{title}</h2>{children}</header>;
}

function RunBanner({ run }: { run: AgentRun }) {
  return <div className="run-card">
    <div className="run-banner">
      <RunStatus status={run.status} />
      <span>{run.model.replace("gpt-5.6-", "GPT-5.6 ")}, {run.reasoningEffort} reasoning</span>
      <small>{run.usage ? `${(run.usage.input_tokens + run.usage.output_tokens).toLocaleString()} tokens` : ""}</small>
    </div>
    <RunProgressPanel run={run} />
  </div>;
}

function Provenance({ items }: { items: Array<{ sourceName: string; sourceUrl: string | null; page: number | null; evidence: string }> }) {
  return <div className="provenance"><span>Source</span>{items.map((item, index) => <span key={`${item.sourceName}-${index}`}>{item.sourceUrl ? <a href={item.sourceUrl} target="_blank" rel="noreferrer">{item.sourceName}</a> : item.sourceName}{item.page ? ` · p. ${item.page}` : ""}<small>{item.evidence}</small></span>)}</div>;
}

function SourceDisclosure({ items }: { items: Array<{ sourceName: string; sourceUrl: string | null; page: number | null; evidence: string }> }) {
  if (!items.length) return null;
  return <details className="source-disclosure"><summary>View sources</summary><Provenance items={items} /></details>;
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

function EvidenceList({ title, items, tone }: { title: string; items: Array<{ title: string; detail: string }>; tone: string }) {
  return <section className={`evidence-list ${tone}`}><h2>{title}</h2>{items.length ? items.map((item) => <div key={item.title}><strong>{item.title}</strong><p>{item.detail}</p></div>) : <p className="muted">No topics were placed in this category.</p>}</section>;
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
    setStatus("submitting"); setError(null);
    try {
      const body = new FormData();
      body.set("type", type); body.set("confirmation", confirmation);
      if (type === "online_text_entry") body.set("text", text);
      if (type === "online_url") body.set("url", url);
      if (type === "online_upload" && file) body.set("file", file);
      const response = await fetch(`/api/tasks/${encodeURIComponent(logicalId)}/submit`, { method: "POST", body });
      if (!response.ok) throw new Error((await response.json() as { error?: string }).error || "Submission failed");
      setStatus("done");
    } catch (nextError) { setError(nextError); setStatus("idle"); }
  };
  return <div className="dialog-backdrop" role="presentation"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="submit-title"><button className="icon-button dialog-close" onClick={onClose}><X size={19} /></button>{status === "done" ? <div className="submission-success"><div><Check size={24} /></div><h2>Submitted to Canvas</h2><p>{title}</p><button className="primary-button" onClick={onClose}>Done</button></div> : <><div className="section-kicker">Canvas submission</div><h2 id="submit-title">Submit {title}</h2><p className="muted">This sends work to Canvas. Review the requirements before confirming.</p>{error && <ErrorNotice error={error} />}<label>Submission type<select value={type} onChange={(event) => setType(event.target.value)}>{supported.map((item) => <option value={item} key={item}>{item.replace(/^online_/, "").replaceAll("_", " ")}</option>)}</select></label>{type === "online_text_entry" && <label>Response<textarea rows={8} value={text} onChange={(event) => setText(event.target.value)} /></label>}{type === "online_url" && <label>URL<input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" /></label>}{type === "online_upload" && <label>File<input type="file" accept={extensions.length ? extensions.map((item) => `.${item}`).join(",") : undefined} onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><small>{extensions.length ? `Allowed: ${extensions.join(", ")}` : "Canvas did not restrict extensions."}</small></label>}<label>Type <strong>SUBMIT</strong> to confirm<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label><div className="dialog-actions"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="danger-button" disabled={confirmation !== "SUBMIT" || status === "submitting"} onClick={() => void submit()}>{status === "submitting" ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}Submit to Canvas</button></div></>}</section></div>;
}

function WorkspaceSkeleton() {
  return <div className="workspace-page"><header className="workspace-header"><div className="skeleton-heading wide" /></header><div className="workspace-tabs"><span /><span /><span /></div><div className="workspace-body"><div className="paper-panel"><div className="text-skeleton"><span /><span /><span /><span /></div></div></div></div>;
}

function isActiveRun(run: AgentRun | undefined): run is AgentRun {
  return run?.status === "queued" || run?.status === "running";
}
