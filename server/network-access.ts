import { BlockList, isIP } from "node:net";

import type { NextFunction, Request, Response } from "express";

// The dashboard can hold a Canvas token and submit coursework, so when it listens beyond loopback
// it only answers loopback and Tailscale peers. Host and Origin checks keep a web page the student
// happens to visit from reaching it through DNS rebinding or cross-site form posts.

const NAMED_NETWORKS: Record<string, Array<[string, number, "ipv4" | "ipv6"]>> = {
  loopback: [["127.0.0.0", 8, "ipv4"], ["::1", 128, "ipv6"]],
  // Tailscale assigns tailnet addresses from the CGNAT range and its own IPv6 ULA prefix.
  tailscale: [["100.64.0.0", 10, "ipv4"], ["fd7a:115c:a1e0::", 48, "ipv6"]],
};

export function buildAllowList(networks: string[]): BlockList {
  const list = new BlockList();
  for (const entry of networks) {
    const named = NAMED_NETWORKS[entry.toLowerCase()];
    if (named) {
      for (const [address, prefix, family] of named) list.addSubnet(address, prefix, family);
      continue;
    }
    const [address, prefixText] = entry.split("/");
    const family = isIP(address);
    if (!family) throw new Error(`SCHOOL_DASHBOARD_ALLOWED_NETWORKS has an invalid entry: ${entry}`);
    const prefix = prefixText === undefined ? (family === 4 ? 32 : 128) : Number.parseInt(prefixText, 10);
    list.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
  }
  return list;
}

export function isAllowedAddress(address: string | undefined, allowList: BlockList): boolean {
  if (!address) return false;
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu)?.[1];
  const normalized = mapped ?? address;
  const family = isIP(normalized);
  if (!family) return false;
  return allowList.check(normalized, family === 4 ? "ipv4" : "ipv6");
}

export function hostnameFromHostHeader(host: string | undefined): string | null {
  if (!host) return null;
  const bracketed = host.match(/^\[([^\]]+)\](?::\d+)?$/u);
  if (bracketed) return bracketed[1].toLowerCase();
  const withoutPort = host.replace(/:\d+$/u, "");
  return withoutPort ? withoutPort.toLowerCase() : null;
}

export function isAllowedHost(host: string | undefined, extraHosts: string[] = []): boolean {
  const hostname = hostnameFromHostHeader(host);
  if (!hostname) return false;
  if (isIP(hostname)) return true;
  if (hostname === "localhost" || hostname.endsWith(".ts.net")) return true;
  // MagicDNS short names such as "latitude7370"; a public attacker domain always has a dot.
  if (/^[a-z0-9-]+$/u.test(hostname)) return true;
  return extraHosts.some((allowed) => allowed.toLowerCase() === hostname);
}

export function networkAccessMiddleware(options: { networks: string[]; allowedHosts: string[] }) {
  const allowList = buildAllowList(options.networks);
  return (request: Request, response: Response, next: NextFunction) => {
    if (!isAllowedAddress(request.socket.remoteAddress, allowList)) {
      return response.status(403).json({ error: "School Dashboard only accepts loopback and Tailscale connections." });
    }
    if (!isAllowedHost(request.headers.host, options.allowedHosts)) {
      return response.status(421).json({ error: "Unrecognized Host header. Add it to SCHOOL_DASHBOARD_ALLOWED_HOSTS if it is yours." });
    }
    const origin = request.headers.origin;
    if (origin && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        originHost = null;
      }
      if (originHost !== request.headers.host?.toLowerCase()) {
        return response.status(403).json({ error: "Cross-origin requests are not accepted." });
      }
    }
    next();
  };
}
