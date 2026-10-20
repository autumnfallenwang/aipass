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

export { clientAddress, isTrustedProxy } from "@aipass/shared";
