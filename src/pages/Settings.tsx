import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  CheckCircleIcon,
  CheckIcon,
  DatabaseIcon,
  FloppyDiskIcon,
  PlugsConnectedIcon,
  PulseIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SparkleIcon,
  TrashIcon,
  type Icon,
} from "@phosphor-icons/react";
import { useContext, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { AgentStatusContext } from "../agent-status";
import { schoolApi } from "../api";
import { AgentProviderIcon } from "../components/AgentControls";
import {
  Button,
  Disclosure,
  ErrorNotice,
  Field,
  LinkButton,
  Modal,
  Notice,
  PageHeader,
  Segmented,
  StatusIcon,
  type StatusState,
  Switch,
} from "../components/ui";
import { formatBytes } from "../format";
import { usePolling } from "../hooks/usePolling";
import { useSelectableModels } from "../hooks/useSelectableModels";
import { type AgentProvider, effortLabel, effortLevels, modelLabel, providerLabel } from "../models";
import { useShell } from "../shell-context";
import { taskSyncBaseUrl, taskSyncPages } from "../task-sync-links";
import { useToast } from "../toast";
import type { AgentExecutionStatus, AppSettings, ConnectionTestResult, Diagnostics, ReasoningEffort } from "../types";

type Section = "agents" | "connections" | "storage" | "advanced";

const SECTIONS: Array<{ id: Section; label: string; icon: Icon }> = [
  { id: "agents", label: "Agents", icon: SparkleIcon },
  { id: "connections", label: "Connections", icon: PlugsConnectedIcon },
  { id: "storage", label: "Storage", icon: DatabaseIcon },
  { id: "advanced", label: "Advanced", icon: SlidersHorizontalIcon },
];

type Update = (updater: (value: AppSettings) => void) => void;

const codexEfforts: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

const featureModelFields: Array<{ key: keyof AppSettings["featureModels"]; label: string }> = [
  { key: "assignmentNavigation", label: "Directions" },
  { key: "problemExtraction", label: "Assigned problems" },
  { key: "answerKey", label: "Answer key" },
  { key: "studyGuide", label: "Study guide" },
];

const promptFields: Array<{ key: keyof AppSettings["prompts"]; label: string }> = featureModelFields;

const limits = {
  ttlMinutes: { min: 1, max: 1440 },
  maxMegabytes: { min: 64, max: 8192 },
  workspaceRetentionHours: { min: 1, max: 168 },
} satisfies Record<keyof AppSettings["cache"], { min: number; max: number }>;

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const section: Section = SECTIONS.find((item) => item.id === searchParams.get("section"))?.id ?? "agents";
  const settingsState = usePolling(schoolApi.settings);
  const diagnosticsState = usePolling(schoolApi.diagnostics);
  const shellAgents = useContext(AgentStatusContext);
  const { health, reloadSettings } = useShell();
  const toast = useToast();
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [agentsOverride, setAgentsOverride] = useState<AgentExecutionStatus | null>(null);
  const agents = agentsOverride ?? shellAgents ?? diagnosticsState.data?.agents ?? null;

  const saved = settingsState.data;
  const current = draft ?? saved;
  const dirty = Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved));
  const errors = current ? validate(current) : {};
  const invalid = Object.keys(errors).length > 0;

  const go = (id: Section) => setSearchParams({ section: id }, { replace: true });

  const update: Update = (updater) => {
    setDraft((value) => {
      const base = value ?? settingsState.data;
      if (!base) return value;
      const next = structuredClone(base);
      updater(next);
      return next;
    });
  };

  const save = async () => {
    if (!current) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await schoolApi.saveSettings(current);
      settingsState.setData(result.settings);
      setDraft(null);
      reloadSettings();
      toast(result.restartRequired ? "Saved. Restart the server to use the new addresses." : "Settings saved.", result.restartRequired ? "warning" : "success");
    } catch (error) {
      setSaveError(error);
    } finally {
      setSaving(false);
    }
  };

  const changeAgents = async (change: { provider?: AgentProvider; target?: AgentExecutionStatus["mode"] }) => {
    try {
      setAgentsOverride(await schoolApi.updateAgentSelection(change));
      toast(change.provider ? `New runs use ${providerLabel(change.provider)}.` : "New runs go to the other machine.", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : "The agent could not be changed.", "error");
    }
  };

  const connections = diagnosticsState.data?.connections;
  const canvasOk = health?.canvas.connected ?? connections?.canvas.connected;
  const taskSyncOk = health?.taskSync.connected ?? connections?.taskSync.connected;
  const sectionState: Partial<Record<Section, StatusState>> = {
    agents: agents ? agents.available ? "ok" : "warning" : undefined,
    connections: canvasOk === undefined || taskSyncOk === undefined ? undefined : canvasOk && taskSyncOk ? "ok" : "warning",
  };
  const setupSteps = canvasOk === undefined || taskSyncOk === undefined || !agents ? [] : [
    { done: canvasOk, title: "Connect Canvas", target: "connections" as Section },
    { done: taskSyncOk, title: "Reach Canvas Task Sync", target: "connections" as Section },
    { done: agents.available, title: "Sign in to an agent on the machine that runs it", target: "agents" as Section },
  ];
  const setupDone = setupSteps.filter((step) => step.done).length;

  return (
    <div className="page--settings">
      <PageHeader title="Settings" description="Agents, connections, and the files this dashboard keeps." />

      {setupSteps.length && setupDone < setupSteps.length ? (
        <section className="surface surface--padded setup-card" aria-labelledby="setup-heading">
          <div className="section-head"><h2 id="setup-heading">Finish setting up</h2><p>{setupDone} of {setupSteps.length} done</p></div>
          <div className="setup-steps">
            {setupSteps.map((step, index) => <div className={`setup-step${step.done ? " is-done" : ""}`} key={step.title}>
              <span className="setup-step__num" aria-hidden>{step.done ? <CheckIcon size={13} weight="bold" /> : index + 1}</span>
              <span className="setup-step__title">{step.done ? <span className="sr-only">Done: </span> : null}{step.title}</span>
              {step.done ? <span className="subtle">Done</span> : <Button variant="secondary" size="sm" onClick={() => go(step.target)}>Fix</Button>}
            </div>)}
          </div>
        </section>
      ) : null}

      <div className="settings-layout">
        <nav className="subnav" aria-label="Settings sections">
          {SECTIONS.map(({ id, label, icon: SectionIcon }) => <button
            type="button"
            key={id}
            className={`subnav__item${section === id ? " is-active" : ""}`}
            aria-current={section === id ? "page" : undefined}
            onClick={() => go(id)}
          >
            <SectionIcon size={18} aria-hidden />{label}
            {sectionState[id] ? <StatusIcon state={sectionState[id]!} size={15} /> : null}
          </button>)}
          <div className="subnav__sep" />
          <Link className="subnav__item" to="/diagnostics"><PulseIcon size={18} aria-hidden />Diagnostics</Link>
        </nav>

        <div className="settings-pane">
          {settingsState.error ? <ErrorNotice error={settingsState.error} title="Settings could not load" /> : null}
          {saveError ? <ErrorNotice error={saveError} title="Settings weren't saved" /> : null}
          {current ? <>
            {section === "agents" ? <AgentsSection settings={current} update={update} agents={agents} diagnostics={diagnosticsState.data} onAgents={changeAgents} /> : null}
            {section === "connections" ? <ConnectionsSection settings={current} update={update} diagnostics={diagnosticsState.data} errors={errors} /> : null}
            {section === "storage" ? <StorageSection settings={current} update={update} diagnostics={diagnosticsState.data} errors={errors} onCleared={() => void diagnosticsState.refresh().catch(() => undefined)} /> : null}
            {section === "advanced" ? <AdvancedSection
              settings={current}
              update={update}
              onReset={(next) => {
                settingsState.setData(next);
                setDraft(null);
                reloadSettings();
              }}
            /> : null}
          </> : settingsState.loading ? <div className="page-loader" role="status" aria-label="Loading settings"><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div> : null}

          {dirty ? (
            <div className="save-bar is-dirty">
              <span className="save-bar__status" role="status">{invalid ? "Fix the highlighted fields to save" : "Unsaved changes"}</span>
              <div className="save-bar__actions">
                <Button variant="ghost" disabled={saving} onClick={() => { setDraft(null); setSaveError(null); }}>Discard</Button>
                <Button icon={FloppyDiskIcon} loading={saving} disabled={invalid} onClick={() => void save()}>Save changes</Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PaneHead({ title, children }: { title: string; children: ReactNode }) {
  return <div className="settings-pane__head"><h2>{title}</h2><p>{children}</p></div>;
}

function Setting({ title, description, children, full }: { title: ReactNode; description?: ReactNode; children?: ReactNode; full?: ReactNode }) {
  return <div className="setting">
    <div className="setting__text">
      <span className="setting__title">{title}</span>
      {description ? <span className="setting__desc">{description}</span> : null}
    </div>
    {children ? <div className="setting__control">{children}</div> : null}
    {full ? <div className="setting__full">{full}</div> : null}
  </div>;
}

function SelectControl({ label, value, options, onChange }: { label: string; value: string; options: Array<{ id: string; label: string }>; onChange: (value: string) => void }) {
  // Keep a saved value visible even before the detected model list has loaded.
  const choices = options.some((option) => option.id === value) ? options : [...options, { id: value, label: modelLabel(value) }];
  return <select className="control" aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
    {choices.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
  </select>;
}

const providerBlurbs: Record<AgentProvider, string> = {
  codex: "Uses the ChatGPT sign-in of the machine that runs it.",
  claude: "Uses the Claude Code sign-in of the machine that runs it.",
};

function AgentsSection({ settings, update, agents, diagnostics, onAgents }: {
  settings: AppSettings;
  update: Update;
  agents: AgentExecutionStatus | null;
  diagnostics: Diagnostics | null;
  onAgents: (change: { provider?: AgentProvider; target?: AgentExecutionStatus["mode"] }) => Promise<void>;
}) {
  const { selectable: codexModels, claude: claudeModels, models: detected, refresh } = useSelectableModels();
  const [checking, setChecking] = useState(false);
  const [changing, setChanging] = useState(false);
  const selected: AgentProvider = agents?.provider ?? "codex";
  const other: AgentProvider = selected === "codex" ? "claude" : "codex";
  const providers = agents?.providers ?? [];
  const targets = agents?.targets ?? [];

  const checkAgain = async () => {
    setChecking(true);
    try {
      await schoolApi.refreshAgentModels();
      // The agent machine answers asynchronously; its Codex app-server takes a few seconds.
      await new Promise((resolve) => window.setTimeout(resolve, 4_000));
      await refresh();
    } catch {
      // The status keeps showing the last known detection result.
    } finally {
      setChecking(false);
    }
  };

  const change = async (next: { provider?: AgentProvider; target?: AgentExecutionStatus["mode"] }) => {
    setChanging(true);
    await onAgents(next);
    setChanging(false);
  };

  const panels: Record<AgentProvider, ReactNode> = {
    codex: <>
      <Setting title="Model" description="Used for every feature unless you choose per feature below.">
        <SelectControl label="Codex model" value={settings.defaultModel} options={codexModels} onChange={(value) => update((next) => { next.defaultModel = value; })} />
      </Setting>
      <Setting title="Reasoning" description="Used when the top bar's effort is Default. Assigned problems use Extra high.">
        <select className="control" aria-label="Codex reasoning" value={settings.reasoningEffort} onChange={(event) => update((next) => { next.reasoningEffort = event.target.value as ReasoningEffort; })}>
          {codexEfforts.map((item) => <option key={item} value={item}>{effortLabel(item)}</option>)}
        </select>
      </Setting>
      <div className="setting setting--stack">
        <Disclosure title="Model per feature" hint="Optional">
          <div className="form-grid">
            {featureModelFields.map(({ key, label }) => (
              <Field key={key} label={label}>
                <SelectControl label={`${label} model`} value={settings.featureModels[key]} options={codexModels} onChange={(value) => update((next) => { next.featureModels[key] = value; })} />
              </Field>
            ))}
          </div>
        </Disclosure>
        <p className="fine-print">{detected?.detail ?? "Checking the agent machine's Codex model list."}</p>
      </div>
    </>,
    claude: <>
      <Setting title="Model">
        <SelectControl label="Claude model" value={settings.claude.model} options={claudeModels} onChange={(value) => update((next) => { next.claude.model = value; })} />
      </Setting>
      <Setting title="Effort" description="Used when the top bar's effort is Default. Assigned problems use Extra high.">
        <select className="control" aria-label="Claude effort" value={settings.claude.reasoningEffort} onChange={(event) => update((next) => { next.claude.reasoningEffort = event.target.value as ReasoningEffort; })}>
          {effortLevels.map((item) => <option key={item} value={item}>{effortLabel(item)}</option>)}
        </select>
      </Setting>
      <Setting title="Sign-in" description={detected?.claude?.detail ?? "Checking the agent machine's Claude Code sign-in."} />
    </>,
  };

  return <>
    <PaneHead title="Agents">Codex or Claude works on your assignments. Changes apply to new runs; runs already going keep their settings.</PaneHead>

    {providers.length > 1 ? (
      <div className="choice-grid" role="radiogroup" aria-label="Agent for new runs">
        {providers.map((item) => {
          const isSelected = item.id === selected;
          return <button
            type="button"
            role="radio"
            aria-checked={isSelected}
            className={`choice${isSelected ? " is-selected" : ""}`}
            key={item.id}
            disabled={changing}
            onClick={() => { if (!isSelected) void change({ provider: item.id }); }}
          >
            <span className="choice__title"><span><AgentProviderIcon provider={item.id} size={17} />{item.label}</span>{isSelected ? <CheckCircleIcon className="tone-info" size={18} weight="fill" aria-hidden /> : null}</span>
            <span className="choice__desc">{providerBlurbs[item.id]}</span>
            <span className="choice__status" title={item.message}><StatusIcon state={item.available ? "ok" : "warning"} size={14} />{item.available ? "Ready" : "Not available here"}</span>
          </button>;
        })}
      </div>
    ) : null}

    {targets.length > 1 && agents ? (
      <div className="surface">
        <Setting title="Run agents on" description={targets.find((target) => target.id === agents.mode)?.message ?? agents.message}>
          <Segmented
            label="Run agents on"
            value={agents.mode}
            onChange={(value) => { if (value !== agents.mode) void change({ target: value }); }}
            options={targets.map((target) => ({ value: target.id, label: `${target.label}${target.available ? "" : " (offline)"}` }))}
          />
        </Setting>
      </div>
    ) : null}

    <div className="surface">
      <div className="surface-title">
        <h3><AgentProviderIcon provider={selected} size={17} />{providerLabel(selected)}</h3>
        <Button variant="ghost" size="sm" icon={ArrowClockwiseIcon} loading={checking} onClick={() => void checkAgain()}>Check models</Button>
      </div>
      {panels[selected]}
    </div>

    <Disclosure title={`${providerLabel(other)} settings`} hint={`Used when ${providerLabel(other)} runs`}>
      <div className="surface">{panels[other]}</div>
    </Disclosure>

    <div className="surface">
      <Setting
        title={<>Test Question Predictor <span className={`badge ${diagnostics?.predictor.configured ? "badge--success" : ""}`.trim()}>{diagnostics?.predictor.configured ? "Set up" : "Optional"}</span></>}
        description={`Use it by default for new study guides. ${diagnostics?.predictor.message ?? ""}`.trim()}
      >
        <Switch label="Use the Test Question Predictor by default" checked={settings.testQuestionPredictor.enabled} onChange={(value) => update((next) => { next.testQuestionPredictor.enabled = value; })} />
      </Setting>
    </div>
  </>;
}

function ConnectionsSection({ settings, update, diagnostics, errors }: {
  settings: AppSettings;
  update: Update;
  diagnostics: Diagnostics | null;
  errors: Record<string, string>;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const [testError, setTestError] = useState<unknown>(null);
  const connections = diagnostics?.connections;
  const tunnel = connections?.taskSyncTunnel ?? null;
  const automaticLink = taskSyncBaseUrl({ ...settings.connections, taskSyncDashboardUrl: "" });
  const taskSyncUrl = taskSyncBaseUrl(settings.connections);

  const test = async () => {
    setTesting(true);
    setTestError(null);
    try {
      setResult(await schoolApi.testConnections());
    } catch (error) {
      setTestError(error);
    } finally {
      setTesting(false);
    }
  };

  const badge = (ok: boolean | undefined) => ok === undefined
    ? <span className="badge">Checking</span>
    : <span className={`badge ${ok ? "badge--success" : "badge--warning"}`}>{ok ? "Connected" : "Unavailable"}</span>;

  return <>
    <PaneHead title="Connections">Where the dashboard reads your classes and assignments. Canvas credentials stay in the server's .env file.</PaneHead>

    <div className="surface">
      <Setting
        title={<>Canvas {badge(connections?.canvas.connected)}</>}
        description={connections ? connections.canvas.error || (connections.canvas.name ? `Signed in as ${connections.canvas.name}.` : "Credential accepted.") : "Checking."}
      />
      <Setting
        title={<>Canvas Task Sync {badge(connections?.taskSync.connected)}</>}
        description={connections ? connections.taskSync.error || (tunnel ? `Reached at ${tunnel.target} over SSH.` : `Reached at ${connections.taskSyncApiBase}.`) : "Checking."}
      >
        {taskSyncUrl ? <LinkButton size="sm" href={taskSyncPages.home(taskSyncUrl)} icon={ArrowSquareOutIcon}>Open Task Sync</LinkButton> : null}
      </Setting>
      <Setting title="Connection test" description="Checks every service the agents need, with response times.">
        <Button variant="secondary" icon={PlugsConnectedIcon} loading={testing} onClick={() => void test()}>{testing ? "Testing" : "Test connections"}</Button>
      </Setting>
      {testError ? <div className="setting setting--stack"><ErrorNotice error={testError} title="The test could not run" /></div> : null}
      {result ? result.checks.map((check) => (
        <div className="row check-row" key={check.id}>
          <StatusIcon state={check.status === "passed" ? "ok" : check.status === "warning" ? "warning" : "error"} />
          <span className="check-row__name"><span className="row-title">{check.label}</span>{check.optional ? <span className="badge badge--outline">Optional</span> : null}</span>
          <span className="check-row__summary">{check.detail}</span>
          <span className="subtle num">{check.latencyMs} ms</span>
        </div>
      )) : null}
    </div>

    <Disclosure title="Addresses" hint="Rarely changed">
      <div className="surface surface--padded form-stack">
        <Field label="Canvas address" help="Your school's Canvas, such as https://school.instructure.com." error={errors.canvasBaseUrl}>
          <input className="control" value={settings.connections.canvasBaseUrl} aria-invalid={Boolean(errors.canvasBaseUrl)} onChange={(event) => update((next) => { next.connections.canvasBaseUrl = event.target.value; })} />
        </Field>
        <Field
          label="Task Sync API"
          error={errors.taskSyncApiBase}
          help={tunnel ? `Not used: Task Sync runs on ${tunnel.target} and is reached over SSH. Remove TASK_SYNC_SSH_TARGET from .env to use this address.` : "Where the server reads tasks from Canvas Task Sync."}
        >
          <input className="control" value={settings.connections.taskSyncApiBase} disabled={Boolean(tunnel)} aria-invalid={Boolean(errors.taskSyncApiBase)} onChange={(event) => update((next) => { next.connections.taskSyncApiBase = event.target.value; })} />
        </Field>
        <Field
          label={<>Task Sync link <small>Optional</small></>}
          error={errors.taskSyncDashboardUrl}
          help={`Where links to Task Sync open in your browser. Leave empty to use ${automaticLink ?? "the API's address"}.`}
        >
          <input className="control" value={settings.connections.taskSyncDashboardUrl} placeholder={automaticLink ?? "http://127.0.0.1:8890"} aria-invalid={Boolean(errors.taskSyncDashboardUrl)} onChange={(event) => update((next) => { next.connections.taskSyncDashboardUrl = event.target.value.trim(); })} />
        </Field>
        <p className="fine-print"><ShieldCheckIcon size={14} aria-hidden />Changing the Canvas address or the Task Sync API needs a server restart. The Task Sync link applies right away.</p>
      </div>
    </Disclosure>
  </>;
}

function StorageSection({ settings, update, diagnostics, errors, onCleared }: {
  settings: AppSettings;
  update: Update;
  diagnostics: Diagnostics | null;
  errors: Record<string, string>;
  onCleared: () => void;
}) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const cache = diagnostics?.cache;

  const clear = async () => {
    setClearing(true);
    try {
      await schoolApi.clearCache();
      toast("Cache cleared.", "success");
      setConfirming(false);
      onCleared();
    } catch (error) {
      toast(error instanceof Error ? error.message : "The cache could not be cleared.", "error");
    } finally {
      setClearing(false);
    }
  };

  const number = (key: keyof AppSettings["cache"], unit: string, label: string) => <div className="unit-input">
    <input
      className="control"
      type="number"
      inputMode="numeric"
      aria-label={label}
      aria-invalid={Boolean(errors[key])}
      min={limits[key].min}
      max={limits[key].max}
      value={Number.isFinite(settings.cache[key]) ? settings.cache[key] : ""}
      onChange={(event) => update((next) => { next.cache[key] = event.target.value === "" ? Number.NaN : Number(event.target.value); })}
    />
    <span>{unit}</span>
  </div>;

  return <>
    <PaneHead title="Storage">Canvas files the agents download, and the temporary workspace each run gets.</PaneHead>
    <div className="surface">
      <Setting
        title="Canvas file cache"
        description={cache ? `${cache.files} ${cache.files === 1 ? "file" : "files"}, ${formatBytes(cache.bytes)}. Reused ${cache.hits} times, downloaded ${cache.misses}.` : "Checking."}
      >
        <Button variant="danger" icon={TrashIcon} disabled={!cache?.files} onClick={() => setConfirming(true)}>Clear cache</Button>
      </Setting>
      <Setting title="Keep cached files for" description={errors.ttlMinutes ?? "Between 1 minute and 1 day."}>{number("ttlMinutes", "minutes", "Keep cached files for")}</Setting>
      <Setting title="Cache size limit" description={errors.maxMegabytes ?? "Between 64 MB and 8 GB. The oldest files go first."}>{number("maxMegabytes", "MB", "Cache size limit")}</Setting>
      <Setting title="Keep run workspaces for" description={errors.workspaceRetentionHours ?? "Between 1 hour and 7 days. Saved results and images are kept either way."}>{number("workspaceRetentionHours", "hours", "Keep run workspaces for")}</Setting>
    </div>
    {confirming ? <Modal
      title="Clear the file cache?"
      onClose={() => setConfirming(false)}
      footer={<><Button variant="secondary" onClick={() => setConfirming(false)}>Cancel</Button><Button variant="danger-solid" icon={TrashIcon} loading={clearing} onClick={() => void clear()}>Clear cache</Button></>}
    ><p>Downloaded Canvas files are deleted. The next runs download what they need again. Results you already have are kept.</p></Modal> : null}
  </>;
}

function AdvancedSection({ settings, update, onReset }: { settings: AppSettings; update: Update; onReset: (next: AppSettings) => void }) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);

  const reset = async () => {
    setResetting(true);
    try {
      const next = await schoolApi.restoreDefaults();
      onReset(next);
      toast("Settings restored to their defaults.", "success");
      setConfirming(false);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Settings could not be reset.", "error");
    } finally {
      setResetting(false);
    }
  };

  return <>
    <PaneHead title="Advanced">The base prompt each feature starts from. Class instructions are added on top of these.</PaneHead>
    <Notice tone="info" title="Changing how one class is handled?" actions={<Link className="btn btn--secondary btn--sm" to="/classes">Open Classes</Link>}>
      <p>Class instructions only affect that class, and they're easier to undo.</p>
    </Notice>
    <div className="surface">
      {promptFields.map(({ key, label }) => (
        <div className="setting setting--stack" key={key}>
          <Disclosure title={`${label} prompt`} hint={`${settings.prompts[key].length.toLocaleString()} characters`}>
            <Field label={`${label} prompt`} className="prompt-field" error={settings.prompts[key].trim().length < 20 ? "A prompt needs at least 20 characters." : undefined}>
              <textarea className="control" rows={9} value={settings.prompts[key]} onChange={(event) => update((next) => { next.prompts[key] = event.target.value; })} />
            </Field>
          </Disclosure>
        </div>
      ))}
    </div>
    <div className="surface">
      <Setting title="Reset all settings" description="Restores models, prompts, addresses, and storage limits to their defaults. Class instructions and the top bar's agent choice are kept.">
        <Button variant="danger" onClick={() => setConfirming(true)}>Reset settings</Button>
      </Setting>
    </div>
    {confirming ? <Modal
      title="Reset all settings?"
      onClose={() => setConfirming(false)}
      footer={<><Button variant="secondary" onClick={() => setConfirming(false)}>Cancel</Button><Button variant="danger-solid" loading={resetting} onClick={() => void reset()}>Reset settings</Button></>}
    ><p>Every setting on this page goes back to its default, including the base prompts. This can't be undone.</p></Modal> : null}
  </>;
}

function validate(settings: AppSettings): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [key, range] of Object.entries(limits) as Array<[keyof AppSettings["cache"], { min: number; max: number }]>) {
    const value = settings.cache[key];
    if (!Number.isInteger(value) || value < range.min || value > range.max) errors[key] = `Enter a whole number from ${range.min} to ${range.max.toLocaleString()}.`;
  }
  if (!isWebAddress(settings.connections.taskSyncApiBase)) errors.taskSyncApiBase = "Enter a full address starting with http:// or https://.";
  if (settings.connections.taskSyncDashboardUrl && !isWebAddress(settings.connections.taskSyncDashboardUrl)) errors.taskSyncDashboardUrl = "Enter a full address starting with http:// or https://, or leave it empty.";
  for (const { key } of promptFields) if (settings.prompts[key].trim().length < 20) errors[`prompt.${key}`] = "Too short";
  return errors;
}

function isWebAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
