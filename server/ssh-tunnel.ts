import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const READY_MARKER = "school-dashboard-tunnel-ready";
const MIN_RETRY_MS = 2_000;
const MAX_RETRY_MS = 30_000;

export type SshTunnelStatus = {
  target: string;
  port: number;
  state: "connecting" | "open" | "reconnecting" | "stopped";
  error?: string;
};

type SpawnTunnel = (command: string, args: string[]) => ChildProcessWithoutNullStreams;

const spawnHidden: SpawnTunnel = (command, args) =>
  spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

/**
 * Keeps an `ssh -L` forward open to a Canvas Task Sync backend running on another machine.
 *
 * The local port is the backend's own port: Task Sync accepts only its loopback `Host`
 * (`127.0.0.1:<port>`), and Node's fetch cannot override `Host`. The remote command reports
 * readiness once the forward is bound, then blocks on stdin, so if this process dies without
 * stopping the tunnel, stdin closes and ssh exits instead of holding the port.
 */
export class SshTunnel {
  private child: ChildProcessWithoutNullStreams | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryMs = MIN_RETRY_MS;
  private state: SshTunnelStatus["state"] = "stopped";
  private lastError: string | undefined;

  constructor(
    readonly target: string,
    readonly port: number,
    private readonly spawnTunnel: SpawnTunnel = spawnHidden,
  ) {}

  get apiBase(): string {
    return `http://127.0.0.1:${this.port}/api/v1`;
  }

  start(): void {
    if (this.state !== "stopped") return;
    this.state = "connecting";
    this.open();
  }

  stop(): void {
    this.state = "stopped";
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const child = this.child;
    this.child = null;
    child?.kill();
  }

  status(): SshTunnelStatus {
    return {
      target: this.target,
      port: this.port,
      state: this.state,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  unreachableMessage(): string {
    const route = `Could not reach Canvas Task Sync through the SSH tunnel to ${this.target}`;
    if (this.state === "open") {
      return `${route}. The tunnel is open, so check the backend on the server with `
        + "`systemctl --user status canvas-task-sync`.";
    }
    return `${route} (tunnel ${this.state}${this.lastError ? `: ${this.lastError}` : ""}).`;
  }

  private open(): void {
    const forward = `127.0.0.1:${this.port}:127.0.0.1:${this.port}`;
    const child = this.spawnTunnel("ssh", [
      "-T",
      "-o", "BatchMode=yes",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-L", forward,
      this.target,
      `echo ${READY_MARKER}; exec cat >/dev/null`,
    ]);
    this.child = child;
    let stdout = "";
    let stderrLines: string[] = [];
    let ended = false;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.child !== child || this.state === "open") return;
      stdout = (stdout + chunk).slice(-200);
      if (!stdout.includes(READY_MARKER)) return;
      this.state = "open";
      this.lastError = undefined;
      this.retryMs = MIN_RETRY_MS;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const lines = chunk.split(/\r?\n/u).map((line) => line.trim())
        .filter((line) => line && !line.startsWith("Warning: Permanently added"));
      stderrLines = [...stderrLines, ...lines].slice(-3);
    });
    // The pipe may already be gone when ssh exits; the close handler reports that instead.
    child.stdin.on("error", () => undefined);

    const onEnded = (reason: string) => {
      if (ended) return;
      ended = true;
      if (this.child !== child) return;
      this.child = null;
      if (this.state === "stopped") return;
      this.lastError = stderrLines.length > 0 ? stderrLines.join("; ") : reason;
      this.state = "reconnecting";
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.open();
      }, this.retryMs);
      this.retryTimer.unref();
      this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    };
    child.on("error", (error: NodeJS.ErrnoException) => {
      onEnded(error.code === "ENOENT" ? "ssh was not found on PATH." : error.message);
    });
    child.on("close", (code) => onEnded(`ssh exited with code ${code ?? "unknown"}.`));
  }
}
