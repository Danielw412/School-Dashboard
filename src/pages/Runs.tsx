import { ArrowRightIcon, CaretRightIcon, ClockCounterClockwiseIcon, MagnifyingGlassIcon, StopIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { schoolApi } from "../api";
import { RunProgressPanel } from "../components/AgentProgress";
import { RunStatusBadge } from "../components/Status";
import { Button, Disclosure, EmptyState, ErrorNotice, PageHeader, Sheet, SkeletonRows } from "../components/ui";
import { type Feature, featureLabel, features, isActiveRun, tabForFeature } from "../features";
import { formatDateTime, formatDayHeading, formatTime, formatTokens, runDuration } from "../format";
import { usePolling } from "../hooks/usePolling";
import { effortLabel, modelLabel, providerLabel } from "../models";
import { useToast } from "../toast";
import type { AgentRun } from "../types";

export function RunsPage() {
  const { data, error, loading, refresh } = usePolling(schoolApi.runs, 3_000);
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [feature, setFeature] = useState<Feature | "">("");
  const [status, setStatus] = useState<AgentRun["status"] | "">("");
  const selectedId = searchParams.get("run");
  const selected = data?.find((run) => run.id === selectedId) ?? null;

  const groups = useMemo(() => {
    const term = query.trim().toLowerCase();
    const byDay = new Map<string, AgentRun[]>();
    for (const run of data ?? []) {
      if (feature && run.feature !== feature) continue;
      if (status && run.status !== status) continue;
      if (term && !`${run.taskTitle} ${run.courseName} ${featureLabel(run.feature)} ${run.model} ${run.error ?? ""}`.toLowerCase().includes(term)) continue;
      const heading = formatDayHeading(run.startedAt);
      byDay.set(heading, [...(byDay.get(heading) ?? []), run]);
    }
    return [...byDay.entries()];
  }, [data, query, feature, status]);

  const select = (run: AgentRun | null) => {
    const next = new URLSearchParams(searchParams);
    if (run) next.set("run", run.id);
    else next.delete("run");
    setSearchParams(next, { replace: true });
  };

  const filtering = Boolean(query.trim() || feature || status);
  const clearFilters = () => { setQuery(""); setFeature(""); setStatus(""); };

  return (
    <div className="page--runs">
      <PageHeader title="Runs" description="Every agent run on your assignments, newest first." />
      <div className="toolbar">
        <label className="search">
          <MagnifyingGlassIcon size={16} aria-hidden />
          <input className="control" aria-label="Search runs" placeholder="Search runs" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <select className="control" aria-label="Feature filter" value={feature} onChange={(event) => setFeature(event.target.value as Feature | "")}>
          <option value="">Every feature</option>
          {features.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
        <select className="control" aria-label="Status filter" value={status} onChange={(event) => setStatus(event.target.value as AgentRun["status"] | "")}>
          <option value="">Any status</option>
          <option value="running">Running</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        {filtering ? <Button variant="ghost" size="sm" onClick={clearFilters}>Clear filters</Button> : null}
      </div>

      {error ? <ErrorNotice error={error} title="Runs could not load" />
        : loading && !data ? <SkeletonRows rows={5} label="Loading runs" />
          : groups.length ? groups.map(([heading, items]) => (
            <section className="group" key={heading} aria-label={heading}>
              <h2 className="group-label">{heading}<span>{items.length}</span></h2>
              <div className="surface">
                {items.map((run) => (
                  <button type="button" className="row row--interactive run-row" key={run.id} onClick={() => select(run)}>
                    <span className="run-row__time">{formatTime(run.startedAt)}</span>
                    <span className="run-row__task">
                      <span className="row-title truncate">{run.taskTitle}</span>
                      <span className="row-meta truncate">{featureLabel(run.feature)} · {run.courseName}</span>
                    </span>
                    <span className="run-row__agent truncate">{modelLabel(run.model)}</span>
                    <RunStatusBadge status={run.status} />
                    <span className="run-row__duration">{runDuration(run)}</span>
                    <CaretRightIcon className="row-chevron" size={15} aria-hidden />
                  </button>
                ))}
              </div>
            </section>
          )) : (
            <div className="surface">{filtering
              ? <EmptyState icon={MagnifyingGlassIcon} title="No runs match these filters" body="Try another feature or status, or clear the filters." action={<Button variant="secondary" onClick={clearFilters}>Clear filters</Button>} />
              : <EmptyState icon={ClockCounterClockwiseIcon} title="No runs yet" body="Runs appear here after an agent works on an assignment." action={<Link className="btn btn--primary" to="/">Go to assignments</Link>} />}
            </div>
          )}

      {selected ? <RunSheet run={selected} onClose={() => select(null)} onChanged={() => void refresh().catch(() => undefined)} /> : null}
    </div>
  );
}

function RunSheet({ run, onClose, onChanged }: { run: AgentRun; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [cancelling, setCancelling] = useState(false);
  const active = isActiveRun(run);
  const effort = run.effectiveReasoningEffort || run.reasoningEffort;

  const cancel = async () => {
    setCancelling(true);
    try {
      await schoolApi.cancelRun(run.id);
      toast("Run cancelled.", "info");
      onChanged();
    } catch (error) {
      toast(error instanceof Error ? error.message : "The run could not be cancelled.", "error");
    } finally {
      setCancelling(false);
    }
  };

  return <Sheet
    title={run.taskTitle}
    badge={<RunStatusBadge status={run.status} />}
    description={`${featureLabel(run.feature)} · ${run.courseName}`}
    onClose={onClose}
    wide
    footer={<>
      {active ? <Button variant="danger" icon={StopIcon} loading={cancelling} onClick={() => void cancel()}>Cancel run</Button> : null}
      <span className="sheet__footer-spacer" />
      <Link className="btn btn--primary" to={`/assignment/${encodeURIComponent(run.logicalId)}?tab=${tabForFeature(run.feature)}`}>
        Open assignment<ArrowRightIcon size={15} aria-hidden />
      </Link>
    </>}
  >
    <div className="surface"><RunProgressPanel run={run} /></div>
    {run.error ? <ErrorNotice error={new Error(run.error)} title="What went wrong" /> : null}
    <dl className="kv">
      <dt>Agent</dt><dd>{providerLabel(run.provider ?? "codex")}</dd>
      <dt>Model</dt><dd>{modelLabel(run.model)} <span className="subtle mono">{run.model}</span></dd>
      <dt>{run.provider === "claude" ? "Effort" : "Reasoning"}</dt><dd>{effortLabel(effort)}</dd>
      <dt>Ran on</dt><dd>{run.execution ? run.execution.host ? `${run.execution.label} (${run.execution.host})` : run.execution.label : "Not recorded"}</dd>
      <dt>Started</dt><dd>{formatDateTime(run.startedAt)}</dd>
      <dt>Duration</dt><dd>{runDuration(run)}</dd>
      <dt>Tokens</dt><dd>{formatTokens(run.usage) ?? "Not reported"}</dd>
      <dt>{run.provider === "claude" ? "Session" : "Thread"}</dt><dd className="mono">{run.threadId ?? "Not started"}</dd>
    </dl>
    <div>
      {run.courseDirections?.directions ? <Disclosure title="Class instructions used" hint="From the Classes page">
        <pre className="code-block">{run.courseDirections.directions}</pre>
      </Disclosure> : null}
      <Disclosure title="Prompt"><pre className="code-block">{run.prompt}</pre></Disclosure>
      <Disclosure title="Structured output"><pre className="code-block">{run.rawStructuredOutput ?? "No output yet."}</pre></Disclosure>
      <Disclosure title="Run events" hint={`${run.events.length}`}><pre className="code-block">{JSON.stringify(run.events, null, 2)}</pre></Disclosure>
    </div>
  </Sheet>;
}
