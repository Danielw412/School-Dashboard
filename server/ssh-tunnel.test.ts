import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SshTunnel } from "./ssh-tunnel.js";

class FakeSsh extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => {
    this.emit("close", null);
    return true;
  });
}

function fakeSpawn() {
  const children: FakeSsh[] = [];
  const spawn = vi.fn<(command: string, args: string[]) => ChildProcessWithoutNullStreams>(() => {
    const child = new FakeSsh();
    children.push(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  return { spawn, children };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("SshTunnel", () => {
  afterEach(() => vi.useRealTimers());

  it("forwards the backend's own loopback port so Task Sync sees its expected Host", () => {
    const { spawn } = fakeSpawn();
    const tunnel = new SshTunnel("daniel@100.87.157.44", 8790, spawn);

    tunnel.start();

    expect(tunnel.apiBase).toBe("http://127.0.0.1:8790/api/v1");
    const [command, args] = spawn.mock.calls[0]!;
    expect(command).toBe("ssh");
    expect(args).toEqual(expect.arrayContaining(["BatchMode=yes", "ExitOnForwardFailure=yes"]));
    expect(args[args.indexOf("-L") + 1]).toBe("127.0.0.1:8790:127.0.0.1:8790");
    expect(args.at(-2)).toBe("daniel@100.87.157.44");
    expect(tunnel.status()).toEqual({ target: "daniel@100.87.157.44", port: 8790, state: "connecting" });
    tunnel.stop();
  });

  it("opens on the readiness marker and reconnects with the ssh error after the tunnel drops", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { spawn, children } = fakeSpawn();
    const tunnel = new SshTunnel("daniel@100.87.157.44", 8790, spawn);
    tunnel.start();

    children[0]!.stdout.write("school-dashboard-");
    children[0]!.stdout.write("tunnel-ready\n");
    await flush();
    expect(tunnel.status().state).toBe("open");

    children[0]!.stderr.write("Warning: Permanently added '100.87.157.44' (ED25519) to the list of known hosts.\n");
    children[0]!.stderr.write("Timeout, server 100.87.157.44 not responding.\n");
    await flush();
    children[0]!.emit("close", 255);
    expect(tunnel.status()).toMatchObject({
      state: "reconnecting",
      error: "Timeout, server 100.87.157.44 not responding.",
    });
    expect(tunnel.unreachableMessage()).toContain("tunnel reconnecting: Timeout, server 100.87.157.44 not responding.");

    vi.advanceTimersByTime(2_000);
    expect(spawn).toHaveBeenCalledTimes(2);
    children[1]!.stdout.write("school-dashboard-tunnel-ready\n");
    await flush();
    expect(tunnel.status()).toEqual({ target: "daniel@100.87.157.44", port: 8790, state: "open" });
    expect(tunnel.unreachableMessage()).toContain("systemctl --user status canvas-task-sync");
    tunnel.stop();
  });

  it("backs off between failed attempts and stops retrying once stopped", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { spawn, children } = fakeSpawn();
    const tunnel = new SshTunnel("daniel@100.87.157.44", 8790, spawn);
    tunnel.start();

    children[0]!.emit("close", 255);
    vi.advanceTimersByTime(2_000);
    expect(spawn).toHaveBeenCalledTimes(2);
    children[1]!.emit("close", 255);
    vi.advanceTimersByTime(2_000);
    expect(spawn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2_000);
    expect(spawn).toHaveBeenCalledTimes(3);

    tunnel.stop();
    expect(children[2]!.kill).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_000);
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(tunnel.status().state).toBe("stopped");
  });

  it("reports a missing ssh client once", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { spawn, children } = fakeSpawn();
    const tunnel = new SshTunnel("daniel@100.87.157.44", 8790, spawn);
    tunnel.start();

    children[0]!.emit("error", Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" }));
    children[0]!.emit("close", -2);

    expect(tunnel.status()).toMatchObject({ state: "reconnecting", error: "ssh was not found on PATH." });
    vi.advanceTimersByTime(2_000);
    expect(spawn).toHaveBeenCalledTimes(2);
    tunnel.stop();
  });
});
