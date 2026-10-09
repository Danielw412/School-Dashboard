import { ArrowClockwiseIcon, ArrowSquareOutIcon, ClockCounterClockwiseIcon, PlugsConnectedIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { schoolApi } from "../api";
import { Button, EmptyState, ErrorNotice, LinkButton, PageHeader, SkeletonRows, StatusIcon, type StatusState } from "../components/ui";
import { formatRelative } from "../format";
import { usePolling } from "../hooks/usePolling";
import { effortLabel, modelLabel, providerLabel } from "../models";
import { useTaskSyncUrl } from "../shell-context";
import { taskSyncPages } from "../task-sync-links";
import type { ConnectionTestResult, Diagnostics } from "../types";

const ACTIVITY_PAGE = 25;

export function DiagnosticsPage() {
  const { data, error, refresh } = usePolling(schoolApi.diagnostics, 5_000);
  const taskSyncUrl = useTaskSyncUrl();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const [testError, setTestError] = useState<unknown>(null);
  const [showAll, setShowAll] = useState(false);

  const test = async () => {
    setTesting(true);
    setTestError(null);
    try {
      setResult(await schoolApi.testConnections());
    } catch (nextError) {
      setTestError(nextError);
    } finally {
      setTesting(false);
    }
  };

  const activity = data?.activity ?? [];

  return (
    <div className="page--diagnostics">
      <PageHeader
        title="Diagnostics"
        description={data ? `Live status of the agents and connections. Updated ${formatRelative(data.generatedAt)}.` : "Live status of the agents and connections."}
        actions={<>
          <Button variant="ghost" icon={ArrowClockwiseIcon} onClick={() => void refresh().catch(() => undefined)}>Refresh</Button>
          <Button icon={PlugsConnectedIcon} loading={testing} onClick={() => void test()}>Test connections</Button>
        </>}
      />
      {error ? <ErrorNotice error={error} title="Diagnostics could not load" /> : null}

      <section className="section" aria-labelledby="agents-heading">
        <div className="section-head"><h2 id="agents-heading">Agents</h2><p>Where new runs can go right now.</p></div>
        {data ? <div className="surface">
          <AgentRows diagnostics={data} />
          <div className="row check-row">
            <StatusIcon state="ok" />
            <span className="row-title">Default model</span>
            <span className="check-row__summary">{modelLabel(data.currentModel)}, {effortLabel(data.reasoningEffort).toLowerCase()} effort, with {providerLabel(data.currentProvider ?? "codex")}</span>
            <span />
          </div>
        </div> : <SkeletonRows rows={2} label="Loading agents" />}
      </section>

      <section className="section" aria-labelledby="connections-heading">
        <div className="section-head">
          <h2 id="connections-heading">Connections</h2>
          <p>{result ? `Tested ${formatRelative(result.testedAt)}.` : "From the server's last look. Test them for a live check."}</p>
        </div>
        {testError ? <ErrorNotice error={testError} title="The test could not run" /> : null}
        {result ? <div className="surface">
          {result.checks.map((check) => <div className="row check-row" key={check.id}>
            <StatusIcon state={check.status === "passed" ? "ok" : check.status === "warning" ? "warning" : "error"} />
            <span className="check-row__name"><span className="row-title">{check.label}</span>{check.optional ? <span className="badge badge--outline">Optional</span> : null}</span>
            <span className="check-row__summary">{check.detail}</span>
            <span className="subtle num">{check.latencyMs} ms</span>
          </div>)}
        </div> : data ? <div className="surface">
          <div className="row check-row">
            <StatusIcon state={data.connections.canvas.connected ? "ok" : "error"} />
            <span className="row-title">Canvas</span>
            <span className="check-row__summary">{data.connections.canvas.error || data.connections.canvas.name || "Credential accepted"}</span>
            <span />
          </div>
          <div className="row check-row">
            <StatusIcon state={data.connections.taskSync.connected ? "ok" : "error"} />
            <span className="row-title">Canvas Task Sync</span>
            <span className="check-row__summary">{data.connections.taskSync.error || (data.connections.taskSyncTunnel ? `${data.connections.taskSyncTunnel.target} over SSH` : data.connections.taskSyncApiBase)}</span>
            {taskSyncUrl ? <LinkButton variant="ghost" size="sm" href={taskSyncPages.home(taskSyncUrl)} icon={ArrowSquareOutIcon}>Open</LinkButton> : <span />}
          </div>
          <div className="row check-row">
            <StatusIcon state={data.predictor.configured ? "ok" : "waiting"} />
            <span className="check-row__name"><span className="row-title">Test Question Predictor</span><span className="badge badge--outline">Optional</span></span>
            <span className="check-row__summary">{data.predictor.message}</span>
            <span />
          </div>
        </div> : <SkeletonRows rows={3} label="Loading connections" />}
      </section>

      <section className="section" aria-labelledby="activity-heading">
        <div className="section-head"><h2 id="activity-heading">Activity</h2><p>Canvas reads, tool calls, and settings changes, newest first.</p></div>
        {data ? activity.length ? <div className="surface">
          {(showAll ? activity : activity.slice(0, ACTIVITY_PAGE)).map((event) => <div className="row event-line" key={event.id}>
            <StatusIcon state={activityState(event.status)} size={16} />
            <span className="event-line__text"><span className="row-title truncate">{event.action}</span><small>{event.category}</small></span>
            <span className="row-meta truncate" title={event.summary}>{event.summary}</span>
            <time dateTime={event.timestamp}>{formatRelative(event.timestamp)}</time>
          </div>)}
        </div> : <div className="surface"><EmptyState title="No activity yet" body="Canvas reads and agent tool calls show up here." /></div> : <SkeletonRows rows={4} label="Loading activity" />}
        {activity.length > ACTIVITY_PAGE && !showAll ? <p className="footnote"><button type="button" className="text-link" onClick={() => setShowAll(true)}>Show all {activity.length}</button></p> : null}
        <p className="footnote"><ClockCounterClockwiseIcon size={15} aria-hidden /><span>Each agent run, with its prompt and output, is on the <Link to="/runs">Runs</Link> page.</span></p>
      </section>
    </div>
  );
}

function AgentRows({ diagnostics }: { diagnostics: Diagnostics }) {
  const agents = diagnostics.agents;
  if (!agents) return null;
  const targets = agents.targets ?? [];
  const agent = providerLabel(agents.provider ?? "codex");
  const versions = [
    `Codex ${agents.worker?.codexVersion ?? "unknown"}`,
    ...(agents.worker?.claude?.version ? [`Claude Code ${agents.worker.claude.version}`] : []),
  ].join(", ");
  if (targets.length < 2) {
    return <div className="row check-row">
      <StatusIcon state={agents.available ? "ok" : "warning"} />
      <span className="row-title">{agent} on {agents.mode === "local" ? "this machine" : agents.worker?.name ?? "the laptop"}</span>
      <span className="check-row__summary">{agents.available && agents.mode === "worker" ? `${versions}. ${agents.activeJobs} running, ${agents.queuedJobs} queued.` : agents.message}</span>
      <span />
    </div>;
  }
  // Server + laptop deployment: one row per place agents can run, marking where new runs go.
  return <>{targets.map((target) => <div className="row check-row" key={target.id}>
    <StatusIcon state={target.available ? "ok" : "warning"} />
    <span className="check-row__name">
      <span className="row-title">{target.label}</span>
      {target.id === agents.mode ? <span className="badge badge--info">New runs go here</span> : null}
    </span>
    <span className="check-row__summary">{target.available
      ? `${target.host ? `${target.host}. ` : ""}${target.id === "worker" ? `${versions}. ` : ""}${target.activeJobs} running, ${target.queuedJobs} queued.`
      : target.message}</span>
    <span />
  </div>)}</>;
}

function activityState(status: string): StatusState {
  if (status === "completed") return "ok";
  if (status === "failed") return "error";
  if (status === "warning") return "warning";
  return "waiting";
}
