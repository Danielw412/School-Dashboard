import {
  ArrowLeft,
  ArrowUpRight,
  BookOpenCheck,
  BrainCircuit,
  Check,
  ChevronDown,
  FileQuestion,
  FileText,
  LoaderCircle,
  LockKeyhole,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { schoolApi } from "../api";
import { Markdown } from "../components/Markdown";
import { EmptyState, ErrorNotice, RunStatus } from "../components/Status";
import { classTone, formatDue, latestRun } from "../format";
import { usePolling } from "../hooks/usePolling";
import type {
  AgentRun,
  AnswerKey,
  AssignmentContext,
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
  const [actionError, setActionError] = useState<unknown>(null);
  const [studyModel, setStudyModel] = useState<ModelName>("gpt-5.6-luna");
  const [reasoning, setReasoning] = useState<ReasoningEffort>("high");
  const [predictor, setPredictor] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const task = taskState.data;
  const context = contextState.data;
  const runs = runsState.data ?? [];
  const extractionRun = latestRun(runs, logicalId, "problemExtraction");
  const answerRun = latestRun(runs, logicalId, "answerKey");
  const studyRun = latestRun(runs, logicalId, "studyGuide");

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
      switchTab(feature === "problemExtraction" ? "problems" : feature === "answerKey" ? "answers" : "study");
    } catch (error) {
      setActionError(error);
    } finally {
      setStarting(null);
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
            <p>{task.course.name} <span>·</span> {formatDue(task.due_date)}</p>
            <h1>{task.display_title}</h1>
          </div>
        </div>
        <div className="workspace-actions">
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
        <TabButton active={tab === "study"} onClick={() => switchTab("study")} icon={BrainCircuit}>Study guide</TabButton>
      </nav>

      <div className="workspace-body">
        {Boolean(actionError) && <ErrorNotice error={actionError} />}
        {tab === "directions" && (
          <DirectionsPanel taskDetails={task.details} context={context} />
        )}
        {tab === "problems" && (
          <ProblemsPanel run={extractionRun} onRun={() => void start("problemExtraction")} starting={starting === "problemExtraction"} />
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

function DirectionsPanel({ taskDetails, context: typed }: { taskDetails: string; context: AssignmentContext }) {
  return (
    <div className="content-layout">
      <article className="paper-panel">
        <div className="paper-heading"><span>Assignment directions</span>{typed.resolution.method !== "not_found" && <small>{Math.round(typed.resolution.confidence * 100)}% match</small>}</div>
        {typed.directionsMarkdown ? <Markdown>{typed.directionsMarkdown}</Markdown> : taskDetails ? <Markdown>{taskDetails}</Markdown> : <EmptyState title="No directions found" detail="Canvas Task Sync tracked this item, but Canvas did not expose assignment directions." />}
      </article>
      <aside className="context-rail">
        <h3>Submission requirements</h3>
        <dl>
          <div><dt>Types</dt><dd>{typed.submissionRequirements.submissionTypes.map((item) => item.replaceAll("_", " ")).join(", ") || "None listed"}</dd></div>
          <div><dt>Points</dt><dd>{typed.submissionRequirements.pointsPossible ?? "—"}</dd></div>
          <div><dt>Attempts</dt><dd>{typed.submissionRequirements.allowedAttempts ?? "Canvas default"}</dd></div>
          <div><dt>Extensions</dt><dd>{typed.submissionRequirements.allowedExtensions.join(", ") || "Any"}</dd></div>
        </dl>
        {typed.externalAssignment.isExternal && <div className="notice amber"><ArrowUpRight size={17} /><div><strong>External work</strong><p>Only Canvas directions and requirements are available here.</p></div></div>}
        {typed.submissionRequirements.locked && <div className="notice error"><LockKeyhole size={17} /><div><strong>Locked</strong><p>{typed.submissionRequirements.lockExplanation || "Canvas reports this assignment is locked."}</p></div></div>}
        {typed.links.length > 0 && <><h3>Directions links</h3><ul className="resource-links">{typed.links.map((link) => <li key={link.url}><a href={link.url} target="_blank" rel="noreferrer">{link.text}<ArrowUpRight size={13} /></a><span>{link.sameCanvasOrigin ? "Canvas" : "External"}</span></li>)}</ul></>}
      </aside>
    </div>
  );
}

function ProblemsPanel({ run, onRun, starting }: { run?: AgentRun; onRun: () => void; starting: boolean }) {
  const output = run?.output as ProblemExtraction | null;
  return (
    <div>
      <FeatureHeader eyebrow="Exact source extraction" title="Assigned problems" detail="Codex follows the assignment’s Canvas resources, preserves numbering, and refuses to invent missing questions.">
        <button className="primary-button" onClick={onRun} disabled={starting || run?.status === "running"}>{starting || run?.status === "running" ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}{run ? "Extract again" : "Get assigned problems"}</button>
      </FeatureHeader>
      {run && <RunBanner run={run} />}
      {!run && <EmptyState title="No problems extracted yet" detail="Start an extraction to locate exact questions in directions, linked files, pages, and PDFs." />}
      {run?.status === "failed" && <ErrorNotice error={new Error(run.error || "Extraction failed")} />}
      {output && <div className="problem-stack">
        <p className="feature-summary">{output.summary}</p>
        {output.problems.map((problem, index) => (
          <article className="problem-panel" key={`${problem.number}-${index}`}>
            <div className="problem-number"><span>Problem</span>{problem.number}<small className={`confidence ${problem.confidence}`}>{problem.confidence}</small></div>
            <Markdown>{problem.markdown}</Markdown>
            {problem.visual && run?.workspaceId && <figure><img src={`/workspace-files/${encodeURIComponent(run.workspaceId)}/${problem.visual.path}`} alt={problem.visual.caption} /><figcaption>{problem.visual.caption} · page {problem.visual.page}</figcaption></figure>}
            <Provenance items={problem.provenance} />
          </article>
        ))}
        {output.unresolved.length > 0 && <div className="unresolved-block"><h3>Could not verify</h3>{output.unresolved.map((item) => <div key={item.reference}><strong>{item.reference}</strong><p>{item.reason}</p><span>Searched: {item.searched.join(", ")}</span></div>)}</div>}
      </div>}
    </div>
  );
}

function AnswerKeyPanel({ run, extractionRun, onRun, starting }: { run?: AgentRun; extractionRun?: AgentRun; onRun: () => void; starting: boolean }) {
  const output = run?.output as AnswerKey | null;
  const ready = extractionRun?.status === "completed";
  return <div>
    <FeatureHeader eyebrow="Grounded solutions" title="Answer key" detail="Every solution starts from the extracted problem text, with a concise final answer and an expandable derivation.">
      <button className="primary-button" disabled={!ready || starting || run?.status === "running"} onClick={onRun}>{starting || run?.status === "running" ? <LoaderCircle className="spin" size={17} /> : <BookOpenCheck size={17} />}{run ? "Generate again" : "Generate answer key"}</button>
    </FeatureHeader>
    {!ready && <div className="notice amber"><FileQuestion size={17} /><div><strong>Extract the assigned problems first</strong><p>The answer key never solves guessed problem descriptions.</p></div></div>}
    {run && <RunBanner run={run} />}
    {run?.status === "failed" && <ErrorNotice error={new Error(run.error || "Answer-key run failed")} />}
    {output && <div className="answer-stack"><p className="feature-summary">{output.summary}</p>{output.answers.map((answer) => <article className="answer-panel" key={answer.problemNumber}><div className="answer-heading"><span>Problem {answer.problemNumber}</span><Check size={18} /></div><div className="final-answer"><span>Final answer</span><Markdown>{answer.finalAnswerMarkdown}</Markdown></div><details><summary>Show full solution <ChevronDown size={16} /></summary><Markdown>{answer.solutionMarkdown}</Markdown>{answer.checks.length > 0 && <ul className="checks">{answer.checks.map((check) => <li key={check}><Check size={14} />{check}</li>)}</ul>}</details><Provenance items={answer.provenance} /></article>)}</div>}
  </div>;
}

function StudyGuidePanel({ run, model, setModel, reasoning, setReasoning, predictor, setPredictor, onRun, starting }: { run?: AgentRun; model: ModelName; setModel: (value: ModelName) => void; reasoning: ReasoningEffort; setReasoning: (value: ReasoningEffort) => void; predictor: boolean; setPredictor: (value: boolean) => void; onRun: () => void; starting: boolean }) {
  const output = run?.output as StudyGuide | null;
  return <div>
    <FeatureHeader eyebrow="Focused assessment research" title="Study guide" detail="Investigate the test description and nearby course evidence without blindly ingesting the entire class." />
    <div className="generator-config">
      <div><label>Model</label><div className="model-options">{(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"] as ModelName[]).map((item) => <button className={model === item ? "active" : ""} key={item} onClick={() => setModel(item)}><span>{item.split("-").at(-1)}</span><small>{item === "gpt-5.6-luna" ? "Default · fast" : item === "gpt-5.6-terra" ? "Balanced" : "Deepest"}</small></button>)}</div></div>
      <label>Reasoning effort<select value={reasoning} onChange={(event) => setReasoning(event.target.value as ReasoningEffort)}>{["minimal", "low", "medium", "high", "xhigh", "max"].map((item) => <option key={item}>{item}</option>)}</select></label>
      <label className="check-field"><input type="checkbox" checked={predictor} onChange={(event) => setPredictor(event.target.checked)} /><span><strong>Use Test Question Predictor</strong><small>If unavailable, the run will say so instead of fabricating results.</small></span></label>
      <button className="primary-button" onClick={onRun} disabled={starting || run?.status === "running"}>{starting || run?.status === "running" ? <LoaderCircle className="spin" size={17} /> : <BrainCircuit size={17} />}{run ? "Generate again" : "Generate study guide"}</button>
    </div>
    {run && <RunBanner run={run} />}
    {run?.status === "failed" && <ErrorNotice error={new Error(run.error || "Study-guide run failed")} />}
    {output && <div className="study-output"><div className={`predictor-banner ${output.predictor.status}`}><strong>Test Question Predictor: {output.predictor.status}</strong><span>{output.predictor.message}</span></div><p className="feature-summary">{output.overview}</p><EvidenceList title="Teacher-stated scope" items={output.teacherStatedScope.map((item) => ({ title: item.topic, detail: item.evidence }))} tone="teacher" /><EvidenceList title="Agent-inferred topics" items={output.agentInferredTopics.map((item) => ({ title: item.topic, detail: item.rationale }))} tone="inferred" />{output.sections.map((section) => <article className="study-section" key={section.heading}><h2>{section.heading}</h2><Markdown>{section.explanationMarkdown}</Markdown><ul>{section.keyIdeas.map((idea) => <li key={idea}>{idea}</li>)}</ul></article>)}<section className="practice-section"><h2>Practice questions</h2>{output.practiceQuestions.map((question, index) => <details key={index}><summary><span>{index + 1}</span><Markdown>{question.questionMarkdown}</Markdown><ChevronDown size={16} /></summary><div className="practice-answer"><small>Answer</small><Markdown>{question.answerMarkdown}</Markdown><p>{question.basis}</p></div></details>)}</section></div>}
  </div>;
}

function FeatureHeader({ eyebrow, title, detail, children }: { eyebrow: string; title: string; detail: string; children?: ReactNode }) {
  return <header className="feature-header"><div><span>{eyebrow}</span><h2>{title}</h2><p>{detail}</p></div>{children}</header>;
}

function RunBanner({ run }: { run: AgentRun }) {
  return <div className="run-banner"><RunStatus status={run.status} /><span>{run.model.replace("gpt-5.6-", "GPT-5.6 ")} · {run.reasoningEffort} reasoning</span>{run.usage && <small>{(run.usage.input_tokens + run.usage.output_tokens).toLocaleString()} tokens</small>}</div>;
}

function Provenance({ items }: { items: Array<{ sourceName: string; sourceUrl: string | null; page: number | null; evidence: string }> }) {
  return <div className="provenance"><span>Source</span>{items.map((item, index) => <span key={`${item.sourceName}-${index}`}>{item.sourceUrl ? <a href={item.sourceUrl} target="_blank" rel="noreferrer">{item.sourceName}</a> : item.sourceName}{item.page ? ` · p. ${item.page}` : ""}<small>{item.evidence}</small></span>)}</div>;
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
