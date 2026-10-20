import { isIP } from "node:net";

/**
 * Fixed-window counters (S7, ASVS V2.4.1). In memory, per gateway process:
 * enough to stop one client flooding the gateway or its audit trail. A fleet
 * of gateways needs a shared limit in front (e.g. at the ingress).
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    readonly max: number,
    readonly windowMs = 60_000,
  ) {}

  /** Counts one call; says how long to wait when over the limit. */
  take(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterSeconds: number } {
    if (this.windows.size > 50_000) this.sweep(now);
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      return { ok: true };
    }
    w.count++;
    if (w.count <= this.max) return { ok: true };
    return { ok: false, retryAfterSeconds: Math.ceil((w.start + this.windowMs - now) / 1000) };
  }

  private sweep(now: number): void {
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
  }
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255))
    return null;
  return (
    ((parts[0] ?? 0) << 24) | ((parts[1] ?? 0) << 16) | ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)
  );
}

/** True when `ip` is one of the trusted proxies: exact addresses, or IPv4 CIDR ranges. */
export function isTrustedProxy(ip: string, trusted: readonly string[]): boolean {
  const bare = ip.replace(/^::ffff:/, "");
  for (const t of trusted) {
    const [net, bits] = t.split("/");
    if (!net) continue;
    if (bits === undefined) {
      if (bare === net || ip === net) return true;
      continue;
    }
    const a = ipv4ToInt(bare);
    const b = ipv4ToInt(net);
    const n = Number(bits);
    if (a === null || b === null || !(n >= 0 && n <= 32)) continue;
    const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
    if ((a & mask) >>> 0 === (b & mask) >>> 0) return true;
  }
  return false;
}

/**
 * The caller's address: the socket's, unless the socket is a trusted proxy;
 * then the rightmost `X-Forwarded-For` entry that isn't one. A client can't
 * pick its own address by sending the header.
 */
export function clientAddress(
  socket: string | undefined,
  forwardedFor: string | undefined,
  trusted: readonly string[],
): string {
  if (!socket) return "unknown";
  if (!forwardedFor || !isTrustedProxy(socket, trusted)) return socket;
  const hops = forwardedFor
    .split(",")
    .map((h) => h.trim())
    .filter((h) => isIP(h.replace(/^::ffff:/, "")));
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i] as string;
    if (!isTrustedProxy(hop, trusted)) return hop;
  }
  return socket;
}
