import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Cpu,
  Database,
  HardDrive,
  LoaderCircle,
  PlugZap,
  RefreshCw,
  Save,
  Settings2,
  Trash2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { schoolApi } from "../api";
import { ErrorNotice } from "../components/Status";
import { relativeTime } from "../format";
import { usePolling } from "../hooks/usePolling";
import type { AppSettings, ConnectionTestResult, Diagnostics, ModelName, ReasoningEffort } from "../types";

const models: ModelName[] = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"];
const reasoning: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export function SettingsDiagnosticsPage() {
  const [tab, setTab] = useState<"settings" | "diagnostics">("settings");
  const settingsState = usePolling(schoolApi.settings);
  const diagnosticsState = usePolling(schoolApi.diagnostics, tab === "diagnostics" ? 5_000 : 0);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const currentSettings = draft ?? settingsState.data;

  const update = (updater: (value: AppSettings) => void) => {
    setDraft((current) => {
      current ??= settingsState.data;
      if (!current) return current;
      const next = structuredClone(current);
      updater(next);
      return next;
    });
    setMessage(null);
  };

  const save = async () => {
    if (!currentSettings) return;
    setSaving(true);
    setError(null);
    try {
      const result = await schoolApi.saveSettings(currentSettings);
      setDraft(result.settings);
      setMessage(result.restartRequired ? "Saved. Restart the server to apply connection URL changes." : "Settings saved.");
    } catch (nextError) {
      setError(nextError);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="page-content settings-page">
      <div className="page-heading-row">
        <h1>Settings</h1>
        {tab === "settings" ? <button className="primary-button" disabled={!draft || saving} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}Save</button> : null}
      </div>
      <div className="settings-tabs">
        <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}><Settings2 size={16} />Configuration</button>
        <button className={tab === "diagnostics" ? "active" : ""} onClick={() => setTab("diagnostics")}><Activity size={16} />Connections & diagnostics</button>
      </div>
      {error ? <ErrorNotice error={error} /> : null}
      {message ? <div className="notice success"><Check size={18} /><div><strong>Saved</strong><p>{message}</p></div></div> : null}
      {tab === "settings" && currentSettings ? <SettingsForm settings={currentSettings} update={update} onDefaults={async () => { const next = await schoolApi.restoreDefaults(); setDraft(next); setMessage("Defaults restored."); }} /> : null}
      {tab === "diagnostics" ? <ConnectionTestPanel /> : null}
      {tab === "diagnostics" ? (diagnosticsState.error ? <ErrorNotice error={diagnosticsState.error} /> : diagnosticsState.data ? <DiagnosticsPanel diagnostics={diagnosticsState.data} refresh={() => void diagnosticsState.refresh()} /> : <div className="text-skeleton"><span /><span /><span /></div>) : null}
    </section>
  );
}

function SettingsForm({ settings, update, onDefaults }: { settings: AppSettings; update: (updater: (value: AppSettings) => void) => void; onDefaults: () => Promise<void> }) {
  return (
    <div className="settings-layout">
      <SettingsSection icon={Cpu} title="Models & reasoning">
        <div className="field-grid"><SelectField label="Default model" value={settings.defaultModel} values={models} onChange={(value) => update((next) => { next.defaultModel = value as ModelName; })} /><SelectField label="Default reasoning" value={settings.reasoningEffort} values={reasoning} onChange={(value) => update((next) => { next.reasoningEffort = value as ReasoningEffort; })} /></div>
        <div className="feature-model-grid">{Object.entries(settings.featureModels).map(([feature, value]) => <SelectField key={feature} label={humanFeature(feature)} value={value} values={models} onChange={(nextValue) => update((next) => { next.featureModels[feature as keyof AppSettings["featureModels"]] = nextValue as ModelName; })} />)}</div>
      </SettingsSection>

      <SettingsSection icon={Database} title="Connections">
        <label>Canvas Task Sync API<input value={settings.connections.taskSyncApiBase} onChange={(event) => update((next) => { next.connections.taskSyncApiBase = event.target.value; })} /></label>
        <label>Canvas base URL<input value={settings.connections.canvasBaseUrl} onChange={(event) => update((next) => { next.connections.canvasBaseUrl = event.target.value; })} /></label>
      </SettingsSection>

      <SettingsSection icon={HardDrive} title="Temporary files & cache">
        <div className="field-grid three"><NumberField label="Cache TTL (minutes)" value={settings.cache.ttlMinutes} onChange={(value) => update((next) => { next.cache.ttlMinutes = value; })} /><NumberField label="Cache limit (MB)" value={settings.cache.maxMegabytes} onChange={(value) => update((next) => { next.cache.maxMegabytes = value; })} /><NumberField label="Workspace retention (hours)" value={settings.cache.workspaceRetentionHours} onChange={(value) => update((next) => { next.cache.workspaceRetentionHours = value; })} /></div>
      </SettingsSection>

      <SettingsSection icon={Settings2} title="Agent prompts">
        {(Object.entries(settings.prompts) as Array<[keyof AppSettings["prompts"], string]>).map(([key, value]) => <label className="prompt-field" key={key}><span>{humanFeature(key)}</span><textarea rows={5} value={value} onChange={(event) => update((next) => { next.prompts[key] = event.target.value; })} /></label>)}
      </SettingsSection>

      <SettingsSection icon={AlertTriangle} title="Test Question Predictor">
        <label className="check-field"><input type="checkbox" checked={settings.testQuestionPredictor.enabled} onChange={(event) => update((next) => { next.testQuestionPredictor.enabled = event.target.checked; })} /><span><strong>Enable by default</strong></span></label>
      </SettingsSection>
      <button className="text-button danger-text" onClick={() => void onDefaults()}><RefreshCw size={15} />Restore defaults</button>
    </div>
  );
}

function ConnectionTestPanel() {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const run = async () => {
    setTesting(true);
    setError(null);
    try {
      setResult(await schoolApi.testConnections());
    } catch (nextError) {
      setError(nextError);
    } finally {
      setTesting(false);
    }
  };
  return (
    <section className="connection-test-panel">
      <header>
        <div><h2>Connection test</h2>{result ? <span>{result.status === "ready" ? "All required services are ready" : "Some required services need attention"}</span> : null}</div>
        <button className="primary-button" disabled={testing} onClick={() => void run()}>{testing ? <LoaderCircle className="spin" size={16} /> : <PlugZap size={16} />}{testing ? "Testing" : "Test all connections"}</button>
      </header>
      {error ? <ErrorNotice error={error} /> : null}
      {result ? <div className="connection-checks">{result.checks.map((check) => <ConnectionCheck key={check.id} check={check} />)}</div> : null}
    </section>
  );
}

function ConnectionCheck({ check }: { check: ConnectionTestResult["checks"][number] }) {
  const Icon = check.status === "passed" ? CheckCircle2 : check.status === "warning" ? CircleAlert : XCircle;
  return <article className={`connection-check ${check.status}`}><Icon size={19} /><div><strong>{check.label}{check.optional ? <small>Optional</small> : null}</strong><p>{check.detail}</p></div><time>{check.latencyMs} ms</time></article>;
}

function DiagnosticsPanel({ diagnostics, refresh }: { diagnostics: Diagnostics; refresh: () => void }) {
  const [clearing, setClearing] = useState(false);
  return (
    <div className="diagnostics-layout">
      <div className="diagnostics-actions"><span>Updated {relativeTime(diagnostics.generatedAt)}</span><button className="secondary-button" onClick={refresh}><RefreshCw size={15} />Refresh</button></div>
      <div className="diagnostic-cards">
        <DiagnosticCard label="Current model" value={diagnostics.currentModel} detail={`${diagnostics.reasoningEffort} reasoning`} ok />
        <DiagnosticCard label="Canvas" value={diagnostics.connections.canvas.connected ? diagnostics.connections.canvas.name || "Connected" : "Unavailable"} detail={diagnostics.connections.canvas.error || "Credential accepted"} ok={diagnostics.connections.canvas.connected} />
        <DiagnosticCard label="Task Sync" value={diagnostics.connections.taskSync.connected ? "Connected" : "Unavailable"} detail={diagnostics.connections.taskSync.error || diagnostics.connections.taskSyncApiBase} ok={diagnostics.connections.taskSync.connected} />
        <DiagnosticCard label="Predictor" value={diagnostics.predictor.configured ? "Configured" : "Optional"} detail={diagnostics.predictor.message} ok={diagnostics.predictor.configured} />
      </div>
      <section className="diagnostic-section"><header><div><h2>Resource cache</h2><p>{diagnostics.cache.files} files, {formatBytes(diagnostics.cache.bytes)}, {diagnostics.cache.hits} hits, {diagnostics.cache.misses} misses</p></div><button className="secondary-button danger-text" disabled={clearing} onClick={async () => { setClearing(true); await schoolApi.clearCache(); setClearing(false); refresh(); }}><Trash2 size={15} />Clear cache</button></header></section>
      <section className="diagnostic-section"><header><div><h2>Recent runs</h2></div></header><div className="diagnostic-table"><div className="table-head"><span>Workflow</span><span>Model</span><span>Status</span><span>Usage</span><span>When</span></div>{diagnostics.recentRuns.map((run) => <details key={run.id}><summary><span><strong>{humanFeature(run.feature)}</strong><small>{run.taskTitle}</small></span><span>{run.model.replace("gpt-5.6-", "")}</span><span className={`mini-status ${run.status}`}>{run.status}</span><span>{run.usage ? `${(run.usage.input_tokens + run.usage.output_tokens).toLocaleString()} tok` : "Unavailable"}</span><span>{relativeTime(run.startedAt)}<ChevronDown size={14} /></span></summary><div className="diagnostic-detail"><div><strong>Prompt</strong><pre>{run.prompt}</pre></div><div><strong>Structured output</strong><pre>{run.rawStructuredOutput || run.error || "No output yet."}</pre></div><div><strong>Agent and tool events</strong><pre>{JSON.stringify(run.events, null, 2)}</pre></div></div></details>)}</div></section>
      <section className="diagnostic-section"><header><div><h2>Canvas and tool activity</h2></div></header><div className="activity-list">{diagnostics.activity.map((event) => <div key={event.id}><span className={`activity-dot ${event.status}`} /><span><strong>{event.action}</strong><small>{event.category}</small></span><p>{event.summary}</p><time>{relativeTime(event.timestamp)}</time></div>)}</div></section>
    </div>
  );
}

function SettingsSection({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: React.ReactNode }) {
  return <section className="settings-section"><header><span><Icon size={18} /></span><h2>{title}</h2></header><div className="settings-section-body">{children}</div></section>;
}

function SelectField({ label, value, values, onChange }: { label: string; value: string; values: string[]; onChange: (value: string) => void }) {
  return <label>{label}<select value={value} onChange={(event) => onChange(event.target.value)}>{values.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>;
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label>{label}<input type="number" min={1} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function DiagnosticCard({ label, value, detail, ok }: { label: string; value: string; detail: string; ok: boolean }) {
  return <div className="diagnostic-card"><div><span className={`connection-dot ${ok ? "ok" : "warn"}`} />{label}</div><strong>{value}</strong><p>{detail}</p></div>;
}

function humanFeature(value: string) {
  if (value === "assignmentNavigation") return "Directions";
  if (value === "problemExtraction") return "Assigned problems";
  return value.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase());
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
