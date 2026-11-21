import type { Request, Response } from "express";

// What the browser should reload. `runs`: a run's record changed (so run lists and active work).
// `progress`: only a run's progress changed. `workflows`: an assignment workflow changed. `agents`:
// where or how agents can run changed.
export type LiveTopic = "runs" | "progress" | "workflows" | "agents";

export type LiveChange = { topics: LiveTopic[]; runIds: string[] };

// Pushes "something changed" notices to open dashboards over server-sent events, so pages reload
// data when it changes instead of polling for it. Notices carry no data (pages fetch it through the
// normal API) and are batched: changes within `batchMs` go out as one notice.
export class LiveEvents {
  private readonly clients = new Set<Response>();
  private readonly pendingTopics = new Set<LiveTopic>();
  private readonly pendingRunIds = new Set<string>();
  private batchTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: { batchMs?: number; heartbeatMs?: number } = {}) {}

  publish(topic: LiveTopic, runId?: string): void {
    if (this.clients.size === 0) return;
    this.pendingTopics.add(topic);
    if (runId) this.pendingRunIds.add(runId);
    if (this.batchTimer) return;
    this.batchTimer = setTimeout(() => this.send(), this.options.batchMs ?? 200);
    this.batchTimer.unref?.();
  }

  // GET handler for the event stream.
  stream = (request: Request, response: Response): void => {
    response.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    // How long the browser waits before reconnecting after the stream drops.
    response.write("retry: 3000\n\n");
    this.clients.add(response);
    this.startHeartbeat();
    request.on("close", () => {
      this.clients.delete(response);
      if (this.clients.size === 0) this.stopHeartbeat();
    });
  };

  get clientCount(): number {
    return this.clients.size;
  }

  close(): void {
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = null;
    this.stopHeartbeat();
    for (const client of this.clients) client.end();
    this.clients.clear();
  }

  private send(): void {
    this.batchTimer = null;
    const change: LiveChange = { topics: [...this.pendingTopics], runIds: [...this.pendingRunIds] };
    this.pendingTopics.clear();
    this.pendingRunIds.clear();
    if (change.topics.length === 0) return;
    this.write(`event: change\ndata: ${JSON.stringify(change)}\n\n`);
  }

  private write(frame: string): void {
    for (const client of this.clients) {
      try {
        client.write(frame);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  // A comment line now and then keeps idle connections from being closed along the way.
  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.write(": keep-alive\n\n"), this.options.heartbeatMs ?? 25_000);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}
