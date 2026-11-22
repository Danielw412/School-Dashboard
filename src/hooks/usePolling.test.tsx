import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LiveChange } from "../types";
import { usePolling } from "./usePolling";

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  private readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }

  emit(type: string, data = "") {
    if (type === "open") this.readyState = FakeEventSource.OPEN;
    for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data }));
  }
}

function latestSource(): FakeEventSource {
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error("No live connection was opened.");
  return source;
}

const change = (value: LiveChange) => JSON.stringify(value);

describe("usePolling with live updates", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reloads on matching change notices instead of polling while connected", async () => {
    const loader = vi.fn(async () => "data");
    const { unmount } = renderHook(() => usePolling(loader, 20, { live: (item) => item.topics.includes("runs") }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    const source = latestSource();
    expect(source.url).toBe("/api/events");

    act(() => source.emit("open"));
    // Opening resyncs once, then polling stops.
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(loader).toHaveBeenCalledTimes(2);

    act(() => source.emit("change", change({ topics: ["progress"], runIds: ["run-1"] })));
    expect(loader).toHaveBeenCalledTimes(2);
    act(() => source.emit("change", change({ topics: ["runs"], runIds: ["run-1"] })));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(3));

    unmount();
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
  });

  it("polls as before while the live connection is down", async () => {
    const loader = vi.fn(async () => "data");
    const { unmount } = renderHook(() => usePolling(loader, 20, { live: () => true }));
    const source = latestSource();
    act(() => source.emit("open"));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));

    act(() => {
      source.readyState = FakeEventSource.CLOSED;
      source.emit("error");
    });
    const before = loader.mock.calls.length;
    await waitFor(() => expect(loader.mock.calls.length).toBeGreaterThan(before + 2));
    unmount();
  });

  it("shares one connection between hooks and loads nothing when disabled", async () => {
    const first = vi.fn(async () => 1);
    const disabled = vi.fn(async () => 2);
    const { unmount } = renderHook(() => {
      usePolling(first, 0, { live: () => true });
      usePolling(first, 0, { live: () => true });
      return usePolling(disabled, 20, { live: () => true, enabled: false });
    });
    await waitFor(() => expect(first).toHaveBeenCalledTimes(2));
    expect(FakeEventSource.instances).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(disabled).not.toHaveBeenCalled();
    unmount();
  });
});

describe("usePolling with a cache key", () => {
  beforeEach(() => window.localStorage.clear());

  it("starts from the saved copy and replaces it with the fresh load", async () => {
    let resolve: (value: string[]) => void = () => undefined;
    const loader = vi.fn(() => new Promise<string[]>((done) => { resolve = done; }));
    const first = renderHook(() => usePolling(loader, 0, { cacheKey: "items" }));
    expect(first.result.current.data).toBeNull();
    await act(async () => resolve(["fresh"]));
    expect(first.result.current.data).toEqual(["fresh"]);
    first.unmount();

    const second = renderHook(() => usePolling(loader, 0, { cacheKey: "items" }));
    expect(second.result.current.data).toEqual(["fresh"]);
    expect(second.result.current.loading).toBe(true);
    await act(async () => resolve(["newer"]));
    expect(second.result.current.data).toEqual(["newer"]);
    expect(second.result.current.loading).toBe(false);
  });
});
