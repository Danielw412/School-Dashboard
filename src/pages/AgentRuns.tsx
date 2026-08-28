import { Activity, ChevronRight, Clock3, Cpu, TerminalSquare, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { RunStatus, EmptyState, ErrorNotice } from "../components/Status";
import { relativeTime } from "../format";
import { usePolling } from "../hooks/usePolling";
import { schoolApi } from "../api";
import type { AgentRun } from "../types";

export function AgentRunsPage() {
  const { data, error, loading } = usePolling(schoolApi.runs, 3000);
  const [selected, setSelected] = useState<AgentRun | null>(null);
  return <div className={`page-grid ${selected ? "has-inspector" : ""}`}>
    <section className="page-content runs-page">
      <div className="eyebrow"><Activity size={14} />Codex SDK activity</div>
      <div className="page-heading-row"><div><h1>Agent runs</h1><p>Structured workflows for extraction, solving, and study-guide generation.</p></div></div>
      {Boolean(error) && <ErrorNotice error={error} />}
      {loading && <div className="text-skeleton"><span /><span /><span /></div>}
      {!loading && !data?.length && <EmptyState title="No agent runs yet" detail="Start one from an assignment workspace." />}
      <div className="runs-list">
        {data?.map((run) => <button className="run-row" key={run.id} onClick={() => setSelected(run)}>
          <span className="run-icon"><Cpu size={18} /></span>
          <span className="run-main"><strong>{featureName(run.feature)}</strong><span>{run.taskTitle}</span><small>{run.courseName}</small></span>
          <span className="run-model">{run.model.replace("gpt-5.6-", "")}<small>{run.reasoningEffort}</small></span>
          <RunStatus status={run.status} />
          <span className="run-time"><Clock3 size={14} />{relativeTime(run.startedAt)}</span>
          <ChevronRight size={17} />
        </button>)}
      </div>
    </section>
    {selected && <aside className="assignment-inspector run-inspector"><div className="inspector-top"><span className="run-icon"><TerminalSquare size={18} /></span><button className="icon-button" onClick={() => setSelected(null)}><X size={18} /></button></div><p className="inspector-course">{featureName(selected.feature)}</p><h2>{selected.taskTitle}</h2><RunStatus status={selected.status} /><dl className="diagnostic-dl"><div><dt>Model</dt><dd>{selected.model}</dd></div><div><dt>Reasoning</dt><dd>{selected.reasoningEffort}</dd></div><div><dt>Thread</dt><dd>{selected.threadId ?? "Not started"}</dd></div><div><dt>Workspace</dt><dd>{selected.workspaceId ?? "Preparing"}</dd></div><div><dt>Tokens</dt><dd>{selected.usage ? (selected.usage.input_tokens + selected.usage.output_tokens).toLocaleString() : "Unavailable"}</dd></div></dl>{selected.error && <ErrorNotice error={new Error(selected.error)} />}<Link className="primary-button" to={`/assignment/${encodeURIComponent(selected.logicalId)}?tab=${tabForFeature(selected.feature)}`}>Open result</Link><details className="raw-output"><summary>Raw structured output</summary><pre>{selected.rawStructuredOutput ?? "No output yet."}</pre></details><details className="raw-output"><summary>Agent events</summary><pre>{JSON.stringify(selected.events, null, 2)}</pre></details></aside>}
  </div>;
}

function featureName(feature: AgentRun["feature"]) {
  if (feature === "directions") return "Assignment directions";
  if (feature === "problemExtraction") return "Problem extraction";
  if (feature === "answerKey") return "Answer key";
  return "Study guide";
}

function tabForFeature(feature: AgentRun["feature"]) {
  if (feature === "directions") return "directions";
  if (feature === "problemExtraction") return "problems";
  if (feature === "answerKey") return "answers";
  return "study";
}
