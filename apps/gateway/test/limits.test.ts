import { describe, expect, it } from "vitest";
import { clientAddress, isTrustedProxy, RateLimiter } from "../src/limits.ts";

describe("RateLimiter", () => {
  it("allows max calls per window, then says how long to wait, then resets", () => {
    const r = new RateLimiter(3, 60_000);
    const t = 1_000_000;
    expect([r.take("a", t), r.take("a", t), r.take("a", t)].every((x) => x.ok)).toBe(true);
    expect(r.take("a", t + 10_000)).toEqual({ ok: false, retryAfterSeconds: 50 });
    expect(r.take("b", t + 10_000).ok).toBe(true);
    expect(r.take("a", t + 60_000).ok).toBe(true);
  });
});

describe("the caller's address", () => {
  const trusted = ["10.0.0.0/8", "192.0.2.7"];

  it("matches trusted proxies by address and IPv4 range", () => {
    expect(isTrustedProxy("10.1.2.3", trusted)).toBe(true);
    expect(isTrustedProxy("::ffff:10.1.2.3", trusted)).toBe(true);
    expect(isTrustedProxy("192.0.2.7", trusted)).toBe(true);
    expect(isTrustedProxy("11.0.0.1", trusted)).toBe(false);
  });

  it("ignores X-Forwarded-For from anyone but a trusted proxy", () => {
    expect(clientAddress("203.0.113.5", "198.51.100.1", trusted)).toBe("203.0.113.5");
  });

  it("behind a trusted proxy, takes the rightmost address that isn't a proxy", () => {
    // the client tried to claim 198.51.100.1; the proxy appended what it saw
    expect(clientAddress("10.0.0.2", "198.51.100.1, 203.0.113.5", trusted)).toBe("203.0.113.5");
    expect(clientAddress("10.0.0.2", "203.0.113.5, 10.9.9.9", trusted)).toBe("203.0.113.5");
    expect(clientAddress(undefined, "203.0.113.5", trusted)).toBe("unknown");
  });
});
