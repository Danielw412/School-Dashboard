import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  Database,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import { schoolApi } from "../api";
import { ErrorNotice } from "../components/Status";
import { relativeTime } from "../format";
import { usePolling } from "../hooks/usePolling";
import type { AppSettings, Diagnostics, ModelName, ReasoningEffort } from "../types";

const models: ModelName[] = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"];
const reasoning: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export function SettingsDiagnosticsPage() {
  const [tab, setTab] = useState<"settings" | "diagnostics">("settings");
  const settingsState = usePolling(schoolApi.settings);
  const diagnosticsState = usePolling(schoolApi.diagnostics, tab === "diagnostics" ? 5000 : 0);
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
    setSaving(true); setError(null);
    try {
      const result = await schoolApi.saveSettings(currentSettings);
      setDraft(result.settings);
      setMessage(result.restartRequired ? "Saved locally. Restart the server to apply connection URL changes." : "Settings saved locally.");
    } catch (nextError) { setError(nextError); }
    finally { setSaving(false); }
  };

  return <section className="page-content settings-page">
    <div className="eyebrow"><ShieldCheck size={14} />Local configuration · secrets hidden</div>
    <div className="page-heading-row"><div><h1>Settings & diagnostics</h1><p>Control each agent workflow and inspect exactly what ran.</p></div>{tab === "settings" && <button className="primary-button" disabled={!draft || saving} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}Save settings</button>}</div>
    <div className="settings-tabs"><button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}><Settings2 size={16} />Configuration</button><button className={tab === "diagnostics" ? "active" : ""} onClick={() => setTab("diagnostics")}><Activity size={16} />Agent diagnostics</button></div>
    {Boolean(error) && <ErrorNotice error={error} />}
    {message && <div className="notice success"><Check size={18} /><div><strong>Saved</strong><p>{message}</p></div></div>}
    {tab === "settings" && currentSettings && <SettingsForm settings={currentSettings} update={update} onDefaults={async () => { const next = await schoolApi.restoreDefaults(); setDraft(next); setMessage("Defaults restored and saved locally."); }} />}
    {tab === "diagnostics" && (diagnosticsState.error ? <ErrorNotice error={diagnosticsState.error} /> : diagnosticsState.data ? <DiagnosticsPanel diagnostics={diagnosticsState.data} refresh={() => void diagnosticsState.refresh()} /> : <div className="text-skeleton"><span /><span /><span /></div>)}
  </section>;
}

function SettingsForm({ settings, update, onDefaults }: { settings: AppSettings; update: (updater: (value: AppSettings) => void) => void; onDefaults: () => Promise<void> }) {
  return <div className="settings-layout">
    <SettingsSection icon={Sparkles} title="Models & reasoning" detail="GPT-5.6 Luna is the default; override individual workflows when depth matters.">
      <div className="field-grid"><SelectField label="Default model" value={settings.defaultModel} values={models} onChange={(value) => update((next) => { next.defaultModel = value as ModelName; })} /><SelectField label="Default reasoning" value={settings.reasoningEffort} values={reasoning} onChange={(value) => update((next) => { next.reasoningEffort = value as ReasoningEffort; })} /></div>
      <div className="feature-model-grid">{Object.entries(settings.featureModels).map(([feature, value]) => <SelectField key={feature} label={humanFeature(feature)} value={value} values={models} onChange={(nextValue) => update((next) => { next.featureModels[feature as keyof AppSettings["featureModels"]] = nextValue as ModelName; })} />)}</div>
      <p className="setting-note">“None” is accepted in settings; the current Codex SDK uses minimal as its effective floor and reports that mapping in each run.</p>
    </SettingsSection>

    <SettingsSection icon={Database} title="Connections" detail="Connection URLs are safe to display. Credentials remain only in .env and are never returned by this API.">
      <label>Canvas Task Sync API<input value={settings.connections.taskSyncApiBase} onChange={(event) => update((next) => { next.connections.taskSyncApiBase = event.target.value; })} /></label>
      <label>Canvas base URL<input value={settings.connections.canvasBaseUrl} onChange={(event) => update((next) => { next.connections.canvasBaseUrl = event.target.value; })} /></label>
      <div className="notice neutral"><ShieldCheck size={17} /><div><strong>Credentials protected</strong><p>Canvas tokens are loaded server-side from .env and never sent to the browser or Codex logs.</p></div></div>
    </SettingsSection>

    <SettingsSection icon={HardDrive} title="Temporary files & cache" detail="Large Canvas files are cached briefly; every agent gets an isolated temporary assignment workspace.">
      <div className="field-grid three"><NumberField label="Cache TTL (minutes)" value={settings.cache.ttlMinutes} onChange={(value) => update((next) => { next.cache.ttlMinutes = value; })} /><NumberField label="Cache limit (MB)" value={settings.cache.maxMegabytes} onChange={(value) => update((next) => { next.cache.maxMegabytes = value; })} /><NumberField label="Workspace retention (hours)" value={settings.cache.workspaceRetentionHours} onChange={(value) => update((next) => { next.cache.workspaceRetentionHours = value; })} /></div>
    </SettingsSection>

    <SettingsSection icon={Sparkles} title="Agent prompts" detail="These local prompts are prepended to strict workflow instructions and structured output schemas.">
      {(Object.entries(settings.prompts) as Array<[keyof AppSettings["prompts"], string]>).map(([key, value]) => <label className="prompt-field" key={key}><span>{humanFeature(key)}</span><textarea rows={5} value={value} onChange={(event) => update((next) => { next.prompts[key] = event.target.value; })} /></label>)}
    </SettingsSection>

    <SettingsSection icon={AlertTriangle} title="Test Question Predictor" detail="The adapter is optional and reports unavailable when its local integration command is not configured.">
      <label className="check-field"><input type="checkbox" checked={settings.testQuestionPredictor.enabled} onChange={(event) => update((next) => { next.testQuestionPredictor.enabled = event.target.checked; })} /><span><strong>Enable by default</strong><small>You can still override this for each study-guide run.</small></span></label>
    </SettingsSection>
    <button className="text-button danger-text" onClick={() => void onDefaults()}><RefreshCw size={15} />Restore defaults</button>
  </div>;
}

function DiagnosticsPanel({ diagnostics, refresh }: { diagnostics: Diagnostics; refresh: () => void }) {
  const [clearing, setClearing] = useState(false);
  return <div className="diagnostics-layout">
    <div className="diagnostics-actions"><span>Updated {relativeTime(diagnostics.generatedAt)}</span><button className="secondary-button" onClick={refresh}><RefreshCw size={15} />Refresh</button></div>
    <div className="diagnostic-cards">
      <DiagnosticCard label="Current model" value={diagnostics.currentModel} detail={`${diagnostics.reasoningEffort} reasoning`} ok />
      <DiagnosticCard label="Canvas" value={diagnostics.connections.canvas.connected ? diagnostics.connections.canvas.name || "Connected" : "Unavailable"} detail={diagnostics.connections.canvas.error || "Credential configured server-side"} ok={diagnostics.connections.canvas.connected} />
      <DiagnosticCard label="Task Sync" value={diagnostics.connections.taskSync.connected ? "Connected" : "Unavailable"} detail={diagnostics.connections.taskSync.error || diagnostics.connections.taskSyncApiBase} ok={diagnostics.connections.taskSync.connected} />
      <DiagnosticCard label="Predictor" value={diagnostics.predictor.configured ? "Configured" : "Unavailable"} detail={diagnostics.predictor.message} ok={diagnostics.predictor.configured} />
    </div>
    <section className="diagnostic-section"><header><div><h2>Resource cache</h2><p>{diagnostics.cache.files} files · {formatBytes(diagnostics.cache.bytes)} · {diagnostics.cache.hits} hits / {diagnostics.cache.misses} misses</p></div><button className="secondary-button danger-text" disabled={clearing} onClick={async () => { setClearing(true); await schoolApi.clearCache(); setClearing(false); refresh(); }}><Trash2 size={15} />Clear cache</button></header></section>
    <section className="diagnostic-section"><header><div><h2>Recent Codex runs</h2><p>Models, prompts, usage, tool events, errors, and raw output remain inspectable.</p></div></header><div className="diagnostic-table"><div className="table-head"><span>Workflow</span><span>Model</span><span>Status</span><span>Usage</span><span>When</span></div>{diagnostics.recentRuns.map((run) => <details key={run.id}><summary><span><strong>{humanFeature(run.feature)}</strong><small>{run.taskTitle}</small></span><span>{run.model.replace("gpt-5.6-", "")}</span><span className={`mini-status ${run.status}`}>{run.status}</span><span>{run.usage ? `${(run.usage.input_tokens + run.usage.output_tokens).toLocaleString()} tok` : "—"}</span><span>{relativeTime(run.startedAt)}<ChevronDown size={14} /></span></summary><div className="diagnostic-detail"><div><strong>Prompt</strong><pre>{run.prompt}</pre></div><div><strong>Raw structured output</strong><pre>{run.rawStructuredOutput || run.error || "No output yet."}</pre></div><div><strong>Agent/tool events</strong><pre>{JSON.stringify(run.events, null, 2)}</pre></div></div></details>)}</div></section>
    <section className="diagnostic-section"><header><div><h2>Canvas & tool activity</h2><p>Secrets are redacted before events are persisted.</p></div></header><div className="activity-list">{diagnostics.activity.map((event) => <div key={event.id}><span className={`activity-dot ${event.status}`} /><span><strong>{event.action}</strong><small>{event.category}</small></span><p>{event.summary}</p><time>{relativeTime(event.timestamp)}</time></div>)}</div></section>
  </div>;
}

function SettingsSection({ icon: Icon, title, detail, children }: { icon: typeof Sparkles; title: string; detail: string; children: React.ReactNode }) {
  return <section className="settings-section"><header><span><Icon size={18} /></span><div><h2>{title}</h2><p>{detail}</p></div></header><div className="settings-section-body">{children}</div></section>;
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
  if (value === "assignmentNavigation") return "Directions / assignment navigation";
  return value.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase());
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
