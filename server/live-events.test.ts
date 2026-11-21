import { get, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LiveEvents } from "./live-events.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("LiveEvents", () => {
  it("streams batched change notices to connected dashboards", async () => {
    const live = new LiveEvents({ batchMs: 20 });
    const { stream, received } = await connect(live);
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    await vi.waitFor(() => expect(live.clientCount).toBe(1));

    live.publish("progress", "run-1");
    live.publish("runs", "run-2");
    live.publish("workflows");

    await vi.waitFor(() => expect(received()).toContain("event: change"));
    const frames = received().split("\n\n").filter((frame) => frame.startsWith("event: change"));
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0].split("data: ")[1])).toEqual({
      topics: ["progress", "runs", "workflows"],
      runIds: ["run-1", "run-2"],
    });
  });

  it("forgets dashboards that disconnect and sends nothing when none are open", async () => {
    const live = new LiveEvents({ batchMs: 5 });
    const { stream } = await connect(live);
    await vi.waitFor(() => expect(live.clientCount).toBe(1));
    stream.destroy();
    await vi.waitFor(() => expect(live.clientCount).toBe(0));
    live.publish("runs", "run-1");
    // Nothing is queued while no dashboard listens.
    expect((live as unknown as { batchTimer: unknown }).batchTimer).toBeNull();
  });
});

async function connect(live: LiveEvents): Promise<{ stream: IncomingMessage; received: () => string }> {
  const app = express();
  app.get("/api/events", live.stream);
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  cleanups.push(() => {
    live.close();
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  const stream: IncomingMessage = await new Promise((resolve, reject) => {
    get(`http://127.0.0.1:${port}/api/events`, resolve).on("error", reject);
  });
  let text = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    text += chunk;
  });
  stream.on("error", () => undefined);
  return { stream, received: () => text };
}
