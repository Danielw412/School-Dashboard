import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { buildAllowList, isAllowedAddress, isAllowedHost, networkAccessMiddleware } from "./network-access.js";

describe("dashboard network access", () => {
  it("admits loopback and Tailscale peers only", () => {
    const allow = buildAllowList(["loopback", "tailscale"]);
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "100.87.157.44", "100.104.178.54", "fd7a:115c:a1e0::462c:9d2d"]) {
      expect(isAllowedAddress(address, allow)).toBe(true);
    }
    for (const address of ["192.168.1.186", "10.0.0.4", "8.8.8.8", "100.128.0.1", "::ffff:192.168.1.5", undefined, "not-an-ip"]) {
      expect(isAllowedAddress(address, allow)).toBe(false);
    }
    expect(isAllowedAddress("192.168.1.186", buildAllowList(["192.168.1.0/24"]))).toBe(true);
    expect(() => buildAllowList(["lan"])).toThrow(/invalid entry/u);
  });

  it("accepts tailnet and loopback Host names but not rebinding domains", () => {
    for (const host of ["127.0.0.1:8892", "localhost:5174", "latitude7370:8892", "latitude7370.tail789481.ts.net", "[fd7a:115c:a1e0::1]:8892", "100.87.157.44:8892"]) {
      expect(isAllowedHost(host)).toBe(true);
    }
    expect(isAllowedHost("evil.example.com:8892")).toBe(false);
    expect(isAllowedHost("dashboard.home.arpa", ["dashboard.home.arpa"])).toBe(true);
    expect(isAllowedHost(undefined)).toBe(false);
  });

  it("rejects cross-origin writes while allowing same-origin writes and reads", async () => {
    const app = express();
    app.use(networkAccessMiddleware({ networks: ["loopback"], allowedHosts: [] }));
    app.all("/api/thing", (_request, response) => {
      response.json({ ok: true });
    });

    await request(app).get("/api/thing").set("Origin", "https://evil.example.com").expect(200);
    await request(app).post("/api/thing").set("Host", "latitude7370:8892").set("Origin", "https://evil.example.com").expect(403);
    await request(app).post("/api/thing").set("Host", "latitude7370:8892").set("Origin", "http://latitude7370:8892").expect(200);
    await request(app).post("/api/thing").set("Host", "latitude7370:8892").expect(200);
    await request(app).get("/api/thing").set("Host", "attacker.example.net").expect(421);
  });

  it("refuses requests from outside the allowed networks", async () => {
    const app = express();
    app.use(networkAccessMiddleware({ networks: ["tailscale"], allowedHosts: [] }));
    app.get("/api/thing", (_request, response) => {
      response.json({ ok: true });
    });
    const response = await request(app).get("/api/thing").expect(403);
    expect(response.body.error).toMatch(/loopback and Tailscale/u);
  });
});
